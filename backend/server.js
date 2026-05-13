require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { Pool } = require('pg');
const path = require('path');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const sgMail = require('@sendgrid/mail');
if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// DB Setup
const isProd = !!process.env.DATABASE_URL;
let db;

if (isProd) {
  db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
} else {
  const dbPath = path.join(__dirname, 'loyalty.db');
  db = new sqlite3.Database(dbPath);
}

const run = (sql, params = []) => {
  if (isProd) {
    let i = 1;
    const pSql = sql.replace(/\?/g, () => `$${i++}`);
    return db.query(pSql, params);
  }
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
};

const get = (sql, params = []) => {
  if (isProd) {
    let i = 1;
    const pSql = sql.replace(/\?/g, () => `$${i++}`);
    return db.query(pSql, params).then(res => res.rows[0]);
  }
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

const query = (sql, params = []) => {
  if (isProd) {
    let i = 1;
    const pSql = sql.replace(/\?/g, () => `$${i++}`);
    return db.query(pSql, params).then(res => res.rows);
  }
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

const NOW = isProd ? "CURRENT_TIMESTAMP" : "DATETIME('now')";
const DAYS_90_AGO = isProd ? "CURRENT_TIMESTAMP - INTERVAL '90 days'" : "DATETIME('now', '-90 days')";
const TODAY = isProd ? "CURRENT_DATE" : "DATE('now')";

// Middleware
app.use(express.json());
app.use(cors());
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://www.google.com https://www.gstatic.com; script-src-attr 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; frame-src https://www.google.com"
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

// Serve static files from both sites
// The backend folder is inside the project root, so we go up one level to reach the frontend folders
app.use('/tablet', express.static(path.join(__dirname, '../frontend-tablet')));
app.use('/public', express.static(path.join(__dirname, '../frontend-public')));

// Root redirect
app.get('/', (req, res) => res.redirect('/public'));

// Rate Limiting
const visitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, error: "Too many requests. Please wait 15 minutes." }
});

const statusLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: { found: false, error: "Too many checks. Please try later." }
});

// HELPERS
async function getSettings() {
  try {
    const s = await get('SELECT * FROM settings LIMIT 1');
    if (s) return s;
  } catch (e) {
    console.error('[DB] Settings table error:', e.message);
  }
  // Return hardcoded defaults if DB fails or is empty
  return {
    restaurant_name: 'The Restaurant',
    admin_pin: '1234',
    enable_tiers: 1, enable_milestones: 1, enable_bonus: 1,
    enable_discounts: 1, enable_freebies: 1,
    enable_retention: 1, enable_frequency: 1,
    discount_new: 10, discount_bronze: 10, discount_silver: 15, discount_gold: 20, discount_vip: 25,
    bronze_threshold: 300, silver_threshold: 600, gold_threshold: 1000, vip_threshold: 2000,
    retention_days: 14, retention_discount: 10,
    frequency_visits: 3, frequency_days: 60, frequency_discount: 10,
    milestone_visits: 5, milestone_reward: 'Free Coffee'
  };
}

async function sendEmail(to, subject, body, settings) {
  if (!process.env.SENDGRID_API_KEY) {
    console.log(`[EMAIL-DEBUG] To: ${to}\nSubject: ${subject}\nBody: ${body}\n`);
    return;
  }
  
  // Basic logo embedding if present
  let html = body.replace(/\n/g, '<br>');
  if (settings.restaurant_logo) {
    html = `<div style="text-align:center; margin-bottom:20px;"><img src="${settings.restaurant_logo}" style="max-width:200px;"></div>` + html;
  }

  const msg = {
    to,
    from: settings.restaurant_email || 'noreply@loyalty.com',
    subject,
    text: body,
    html: `<div style="font-family: sans-serif; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">${html}</div>`,
  };
  try {
    await sgMail.send(msg);
  } catch (err) {
    console.error('[EMAIL] SendGrid failed:', err.message);
  }
}

function parseTemplate(template, data) {
  let res = template;
  for (const key in data) {
    res = res.replace(new RegExp(`{${key}}`, 'g'), data[key]);
  }
  return res;
}

async function auditLog(action, details = '') {
  try {
    await run('INSERT INTO audit_log (action, details) VALUES (?, ?)', [action, details]);
  } catch (err) {
    console.error('[AUDIT] Failed to write audit log:', err.message);
  }
}

// reCAPTCHA verification
async function verifyRecaptcha(token) {
  const secret = process.env.RECAPTCHA_SECRET_KEY || '6LeIxAcTAAAAAGG-v3_placeholder';
  if (secret.includes('placeholder')) return true; // Local dev bypass
  
  if (!token) return false;
  try {
    const response = await fetch(
      `https://www.google.com/recaptcha/api/siteverify?secret=${secret}&response=${token}`,
      { method: 'POST' }
    );
    const data = await response.json();
    return data.success && (data.score === undefined || data.score >= 0.5);
  } catch (err) {
    console.error('reCAPTCHA error:', err);
    return true; 
  }
}

async function calculateBestRewards(customer, settings, isFirstVisit = false) {
  const result = { discount: 0, freebie: '', type: 'none' };
  
  if (isFirstVisit && settings.enable_discounts) {
    result.discount = settings.discount_new || 10;
    result.type = 'new_customer';
    return result;
  }
  
  // 1. Tier Rewards
  if (settings.enable_tiers) {
    const tierDiscounts = {
      'none': 0, 'bronze': settings.discount_bronze, 'silver': settings.discount_silver,
      'gold': settings.discount_gold, 'vip': settings.discount_vip
    };
    const tierFreebies = {
      'none': '', 'bronze': settings.freebie_bronze, 'silver': settings.freebie_silver,
      'gold': settings.freebie_gold, 'vip': settings.freebie_vip
    };

    if (settings.enable_discounts) result.discount = tierDiscounts[customer.current_tier] || 0;
    if (settings.enable_freebies) result.freebie = tierFreebies[customer.current_tier] || '';
  }

  // 2. Bonus Rewards
  if (settings.enable_bonus) {
    // Retention
    if (settings.enable_retention) {
      const lastVisit = await get(`SELECT visited_at FROM visits WHERE customer_id = ? ORDER BY visited_at DESC LIMIT 1`, [customer.id]);
      if (lastVisit) {
        const lastVisitTs = lastVisit.visited_at instanceof Date ? lastVisit.visited_at : new Date(lastVisit.visited_at + 'Z');
        const diffDays = (new Date() - lastVisitTs) / (1000 * 60 * 60 * 24);
        if (diffDays <= (settings.retention_days || 14)) {
          if (settings.enable_discounts) result.discount = Math.max(result.discount, settings.retention_discount || 0);
          if (settings.enable_freebies && settings.retention_freebie) result.freebie = result.freebie ? result.freebie + ' + ' + settings.retention_freebie : settings.retention_freebie;
        }
      }
    }

    // Frequency
    if (settings.enable_frequency) {
      const freqCutoff = isProd ? `NOW() - INTERVAL '${settings.frequency_days || 60} days'` : `DATETIME('now', '-${settings.frequency_days || 60} days')`;
      const recentVisits = await get(`SELECT COUNT(*) as count FROM visits WHERE customer_id = ? AND visited_at > ${freqCutoff}`, [customer.id]);
      if (recentVisits && recentVisits.count >= (settings.frequency_visits || 3)) {
        if (settings.enable_discounts) result.discount = Math.max(result.discount, settings.frequency_discount || 0);
        if (settings.enable_freebies && settings.frequency_freebie) result.freebie = result.freebie ? result.freebie + ' + ' + settings.frequency_freebie : settings.frequency_freebie;
      }
    }
  }

  return result;
}

async function recalculateTier(customerId, settings) {
  if (!settings.enable_tiers) return { newTier: 'none', spend90d: 0, visitCount: 0 };
  
  const row = await get(`
    SELECT SUM(spend) as total_90d, COUNT(id) as visit_count 
    FROM visits 
    WHERE customer_id = ? AND visited_at > ${DAYS_90_AGO}
  `, [customerId]);

  if (!row) return { newTier: 'none', spend90d: 0, visitCount: 0 };

  const spend = row.total_90d || 0;
  let tier = 'none';

  if (spend >= (settings.vip_threshold || 2000)) tier = 'vip';
  else if (spend >= (settings.gold_threshold || 1000)) tier = 'gold';
  else if (spend >= (settings.silver_threshold || 600)) tier = 'silver';
  else if (spend >= (settings.bronze_threshold || 300)) tier = 'bronze';

  await run('UPDATE customers SET current_tier = ? WHERE id = ?', [tier, customerId]);
  return { newTier: tier, spend90d: spend, visitCount: row.visit_count };
}

// ENDPOINTS
app.post('/api/checkin-with-spend', visitLimiter, async (req, res) => {
  let { name, email, phone, spend, marketing_consent, recaptcha_token } = req.body;
  spend = parseFloat(spend) || 0;

  if (!await verifyRecaptcha(recaptcha_token)) return res.status(403).json({ error: "Bot verification failed." });
  if (!email || !email.includes('@')) return res.status(400).json({ error: "Email is required." });

  try {
    const s = await getSettings();
    email = email.trim().toLowerCase();
    name = name.trim();

    await run(
      `INSERT INTO customers (name, email, phone, marketing_consent, consent_date, consent_ip) 
       VALUES (?, ?, ?, ?, CASE WHEN ? THEN ${NOW} ELSE NULL END, CASE WHEN ? THEN ? ELSE NULL END)
       ON CONFLICT (email) DO UPDATE SET 
         name = EXCLUDED.name,
         marketing_consent = EXCLUDED.marketing_consent,
         consent_date = CASE WHEN EXCLUDED.marketing_consent THEN COALESCE(customers.consent_date, ${NOW}) ELSE NULL END,
         consent_ip = CASE WHEN EXCLUDED.marketing_consent THEN COALESCE(customers.consent_ip, ?) ELSE NULL END`,
      [name, email, phone, marketing_consent ? 1 : 0, marketing_consent ? 1 : 0, marketing_consent ? 1 : 0, req.ip, req.ip]
    );

    auditLog('customer_checkin', `${name} (${email})`);
    const customer = await get('SELECT id, name, current_tier FROM customers WHERE email = ?', [email]);
    
    // Check if customer already existed or is brand new
    const checkNew = await get('SELECT COUNT(*) as count FROM visits WHERE customer_id = ?', [customer.id]);
    const isFirstVisit = checkNew.count === 0;

    if (spend > 0) {
      await run('INSERT INTO visits (customer_id, spend) VALUES (?, ?)', [customer.id, spend]);
    }

    const { newTier, spend90d, visitCount } = await recalculateTier(customer.id, s);
    
    // Milestone logic
    let milestoneEarned = null;
    if (s.enable_milestones && visitCount > 0 && visitCount % (s.milestone_visits || 5) === 0) {
      milestoneEarned = s.milestone_reward;
    }

    // Calculate best possible rewards
    const rewards = await calculateBestRewards(customer, s, isFirstVisit);

    // EMAILS
    const emailData = {
      name: customer.name,
      restaurant: s.restaurant_name,
      tier: newTier.toUpperCase(),
      reward: milestoneEarned || rewards.freebie || `${rewards.discount}% OFF`,
      spend: spend.toFixed(2)
    };

    if (isFirstVisit) {
      sendEmail(email, parseTemplate(s.email_welcome_subject, emailData), parseTemplate(s.email_welcome_body, emailData), s);
    } else if (milestoneEarned) {
      sendEmail(email, parseTemplate(s.email_milestone_subject, emailData), parseTemplate(s.email_milestone_body, emailData), s);
    } else if (newTier !== customer.current_tier && newTier !== 'none') {
      const sub = s[`email_${newTier}_subject`] || s.email_welcome_subject;
      const body = s[`email_${newTier}_body`] || s.email_welcome_body;
      sendEmail(email, parseTemplate(sub, emailData), parseTemplate(body, emailData), s);
    }

    auditLog('checkin_with_spend', `${name}, £${spend.toFixed(2)}, Tier: ${newTier.toUpperCase()}, Milestone: ${milestoneEarned || 'No'}`);
    res.json({ success: true, name: customer.name, tier: newTier, discount: rewards.discount, freebie: rewards.freebie, milestoneReward: milestoneEarned });
  } catch (err) {
    console.error('[CHECKIN] Error:', err);
    res.status(500).json({ error: "System error." });
  }
});

app.get('/api/status', statusLimiter, async (req, res) => {
  const { email, recaptcha_token } = req.query;
  if (!await verifyRecaptcha(recaptcha_token)) return res.status(403).json({ error: "Bot verification failed." });

  try {
    const s = await getSettings();
    const customer = await get('SELECT * FROM customers WHERE email = ?', [email.toLowerCase().trim()]);
    if (!customer) return res.json({ found: false });

    const stats = await recalculateTier(customer.id, s);
    const lastVisit = await get('SELECT visited_at FROM visits WHERE customer_id = ? ORDER BY visited_at DESC LIMIT 1', [customer.id]);

    const thresholds = { 'none': s.bronze_threshold, 'bronze': s.silver_threshold, 'silver': s.gold_threshold, 'gold': s.vip_threshold };
    const nextTierNames = { 'none': 'bronze', 'bronze': 'silver', 'silver': 'gold', 'gold': 'vip' };
    
    const nextTier = nextTierNames[customer.current_tier] || 'vip';
    const nextThreshold = thresholds[customer.current_tier] || s.vip_threshold;
    const progressPercent = Math.min(100, (stats.spend90d / nextThreshold) * 100);

    const rewards = await calculateBestRewards(customer, s);

    res.json({
      found: true,
      name: customer.name,
      tier: customer.current_tier,
      spend90d: stats.spend90d,
      totalVisits: stats.visitCount,
      discount: rewards.discount,
      freebie: rewards.freebie,
      enable_discounts: s.enable_discounts,
      enable_freebies: s.enable_freebies,
      consentDate: new Date(customer.created_at).toLocaleDateString('en-GB'),
      lastVisit: lastVisit ? new Date(lastVisit.visited_at).toLocaleString('en-GB') : 'Never',
      nextTier,
      nextThreshold,
      progressPercent
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "System error." });
  }
});

// ADMIN
const adminAuth = async (req, res, next) => {
  const pin = req.headers['x-admin-pin'];
  const s = await getSettings();
  if (pin === s.admin_pin) return next();
  res.status(401).json({ error: "Invalid PIN" });
};

app.get('/api/admin/stats', adminAuth, async (req, res) => {
  const total = await get('SELECT COUNT(*) as count FROM customers');
  const today = await get(`SELECT COUNT(DISTINCT customer_id) as count FROM visits WHERE ${isProd ? "visited_at::date = CURRENT_DATE" : "DATE(visited_at) = DATE('now')"}`);
  const active = await get(`SELECT COUNT(DISTINCT customer_id) as count FROM visits WHERE visited_at > ${DAYS_90_AGO}`);
  const revenue = await get(`SELECT SUM(spend) as sum FROM visits WHERE visited_at > ${DAYS_90_AGO}`);
  
  const tiers = await query('SELECT current_tier, COUNT(*) as count FROM customers GROUP BY current_tier');
  const tierCounts = { vip: 0, gold: 0, silver: 0, bronze: 0, none: 0 };
  tiers.forEach(t => tierCounts[t.current_tier] = t.count);

  const recent = await query(`
    SELECT v.id, c.name as customerName, v.visited_at as ts, c.current_tier as tier, v.spend 
    FROM visits v 
    JOIN customers c ON v.customer_id = c.id 
    ORDER BY v.visited_at DESC LIMIT 20
  `);

  res.json({
    totalCustomers: total.count,
    visitedToday: today.count,
    active90d: active.count,
    revenue90d: revenue.sum || 0,
    tierCounts,
    recentVisits: recent.map(r => ({ ...r, date: new Date(r.ts + 'Z').toLocaleString('en-GB') }))
  });
});

app.get('/api/admin/customers', adminAuth, async (req, res) => {
  const { search } = req.query;
  let sql = `
    SELECT c.*, 
    COALESCE(SUM(CASE WHEN v.visited_at > ${DAYS_90_AGO} THEN v.spend ELSE 0 END), 0) as spend_90d,
    COUNT(v.id) as visit_count
    FROM customers c
    LEFT JOIN visits v ON c.id = v.customer_id
  `;
  const params = [];
  if (search) {
    sql += ' WHERE c.name LIKE ? OR c.email LIKE ?';
    params.push(`%${search}%`, `%${search}%`);
  }
  sql += ' GROUP BY c.id ORDER BY c.created_at DESC';
  const customers = await query(sql, params);
  res.json(customers);
});

app.delete('/api/admin/customers/:email', adminAuth, async (req, res) => {
  const { email } = req.params;
  const customer = await get('SELECT id, name FROM customers WHERE email = ?', [email]);
  if (customer) {
    await run('DELETE FROM visits WHERE customer_id = ?', [customer.id]);
    await run('DELETE FROM customers WHERE id = ?', [customer.id]);
    auditLog('delete_customer', `Deleted ${customer.name} (${email})`);
  }
  res.json({ success: true });
});

app.delete('/api/admin/visits/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  console.log(`[ADMIN] Attempting to delete visit ID: ${id}`);
  try {
    const visit = await get('SELECT customer_id FROM visits WHERE id = ?', [id]);
    if (!visit) {
      console.log(`[ADMIN] Visit ${id} not found.`);
      return res.status(404).json({ error: 'Visit not found' });
    }
    
    await run('DELETE FROM visits WHERE id = ?', [id]);
    console.log(`[ADMIN] Visit ${id} deleted from DB.`);
    
    const s = await getSettings();
    await recalculateTier(visit.customer_id, s);
    
    auditLog('delete_visit', `Visit ID: ${id}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[ADMIN] Failed to delete visit:', err.message);
    res.status(500).json({ error: 'Failed to delete visit: ' + err.message });
  }
});

app.put('/api/admin/visits/:id/spend', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { spend } = req.body;
    const visit = await get('SELECT customer_id FROM visits WHERE id = ?', [id]);
    if (visit) {
      await run('UPDATE visits SET spend = ? WHERE id = ?', [spend, id]);
      const s = await getSettings();
      await recalculateTier(visit.customer_id, s);
      auditLog('update_visit_spend', `Visit ID: ${id}, New: £${spend}`);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update visit' });
  }
});

app.get('/api/admin/settings', adminAuth, async (req, res) => {
  const s = await getSettings();
  res.json(s);
});

app.put('/api/admin/settings', adminAuth, async (req, res) => {
  const fields = req.body;
  
  try {
    const s = await getSettings();
    const updates = [];
    const params = [];
    
    // Map of frontend keys to DB columns
    const keyMap = {
      restaurantName: 'restaurant_name', restaurantEmail: 'restaurant_email', 
      restaurantAddress: 'restaurant_address', restaurantLogo: 'restaurant_logo',
      adminPin: 'admin_pin',
      enableTiers: 'enable_tiers', enableMilestones: 'enable_milestones', 
      enableBonus: 'enable_bonus', enableDiscounts: 'enable_discounts', 
      enableFreebies: 'enable_freebies', enableRetention: 'enable_retention', 
      enableFrequency: 'enable_frequency',
      bronze: 'bronze_threshold', silver: 'silver_threshold', 
      gold: 'gold_threshold', vip: 'vip_threshold',
      dNew: 'discount_new', dBronze: 'discount_bronze', 
      dSilver: 'discount_silver', dGold: 'discount_gold', dVip: 'discount_vip',
      fBronze: 'freebie_bronze', fSilver: 'freebie_silver', 
      fGold: 'freebie_gold', fVip: 'freebie_vip',
      retentionDays: 'retention_days', retentionDiscount: 'retention_discount', 
      retentionFreebie: 'retention_freebie',
      frequencyVisits: 'frequency_visits', frequencyDays: 'frequency_days', 
      frequencyDiscount: 'frequency_discount', frequencyFreebie: 'frequency_freebie',
      milestoneVisits: 'milestone_visits', milestoneReward: 'milestone_reward'
    };

    // Add email templates to map
    ['welcome', 'milestone', 'bronze', 'silver', 'gold', 'vip', 'retention', 'frequency'].forEach(type => {
      keyMap[`email_${type}_subject`] = `email_${type}_subject`;
      keyMap[`email_${type}_body`] = `email_${type}_body`;
    });

    for (const [feKey, dbCol] of Object.entries(keyMap)) {
      if (fields[feKey] !== undefined) {
        let val = fields[feKey];
        if (feKey === 'adminPin' && val === '') continue; // Skip empty pin
        updates.push(`${dbCol} = ?`);
        params.push(val);
      }
    }

    if (updates.length > 0) {
      await run(`UPDATE settings SET ${updates.join(', ')} WHERE id = 1`, params);
    }
    
    auditLog('update_settings', `By admin`);
    res.json({ success: true });
  } catch (err) {
    console.error('[ADMIN] Settings update failed:', err.message);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

app.get('/api/admin/audit-log', adminAuth, async (req, res) => {
  const logs = await query('SELECT * FROM audit_log ORDER BY performed_at DESC LIMIT 50');
  res.json(logs);
});

app.get('/api/admin/export', adminAuth, async (req, res) => {
  const customers = await query(`
    SELECT name, email, phone, current_tier, 
    (SELECT COUNT(*) FROM visits WHERE customer_id = c.id) as visits,
    (SELECT SUM(spend) FROM visits WHERE customer_id = c.id) as total_spend,
    marketing_consent, created_at
    FROM customers c
  `);
  
  const esc = (v) => `"${String(v || '').replace(/"/g, '""')}"`;
  let csv = 'Name,Email,Phone,Tier,Visits,Total Spend,Marketing,Joined\n';
  customers.forEach(c => {
    csv += `${esc(c.name)},${esc(c.email)},${esc(c.phone)},${esc(c.current_tier)},${c.visits},${c.total_spend || 0},${c.marketing_consent ? 'YES' : 'NO'},${esc(c.created_at)}\n`;
  });
  
  auditLog('export_csv', 'Full customer list');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=customers.csv');
  res.send(csv);
});

// CRON: Nightly cleanup at 02:00
cron.schedule('0 2 * * *', async () => {
  console.log('[CRON] Starting data retention cleanup...');
  const cutoff = isProd ? "NOW() - INTERVAL '365 days'" : "DATETIME('now', '-365 days')";
  await run(`
    DELETE FROM customers WHERE id NOT IN (
      SELECT DISTINCT customer_id FROM visits WHERE visited_at > ${cutoff}
    ) AND created_at < ${cutoff}
  `);
  console.log('[CRON] Cleanup complete.');
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
