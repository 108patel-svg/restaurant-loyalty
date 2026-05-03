require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3000;

// DB Setup
const dbPath = path.join(__dirname, 'loyalty.db');
const db = new sqlite3.Database(dbPath);

const run = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function(err) {
    if (err) reject(err);
    else resolve(this);
  });
});

const get = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => {
    if (err) reject(err);
    else resolve(row);
  });
});

const query = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => {
    if (err) reject(err);
    else resolve(rows);
  });
});

// Middleware
app.use(express.json());
app.use(cors());

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

// Emails
async function sendEmail(to, subject, text, html) {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) {
    console.warn('[EMAIL] No SendGrid API key found. Skipping email.');
    return;
  }
  try {
    await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: process.env.RESTAURANT_EMAIL || 'loyalty@yourrestaurant.com' },
        subject: subject,
        content: [
          { type: 'text/plain', value: text + '\n\nUnsubscribe: ' + (process.env.PUBLIC_URL || 'http://localhost:3000') + '/public/' },
          { 
            type: 'text/html', 
            value: html + `<br><br><div style="border-top:1px solid #EEE;padding-top:20px;font-size:12px;color:#666;">You are receiving this because you joined our loyalty programme. <a href="${process.env.PUBLIC_URL || 'http://localhost:3000'}/public/">Unsubscribe at any time here.</a></div>` 
          }
        ],
        asm: process.env.SENDGRID_UNSUBSCRIBE_GROUP_ID ? { group_id: parseInt(process.env.SENDGRID_UNSUBSCRIBE_GROUP_ID) } : undefined
      })
    });
    console.log(`[EMAIL] Sent: ${subject} to ${to}`);
  } catch (err) {
    console.error('[EMAIL] Failed to send email:', err.message);
  }
}

// HELPERS
async function getSettings() {
  try {
    const s = await get('SELECT * FROM settings LIMIT 1');
    if (s && s.admin_pin) return s;
  } catch (e) {
    console.error('[DB] Settings error:', e.message);
  }
  return {
    restaurant_name: 'The Restaurant',
    admin_pin: '1234',
    discount_new: 10,
    discount_bronze: 10,
    discount_silver: 15,
    discount_gold: 20,
    discount_vip: 25,
    bronze_threshold: 300,
    silver_threshold: 600,
    gold_threshold: 1000,
    vip_threshold: 2000
  };
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

function tierDiscount(tier, settings, isFirstVisit = false) {
  if (isFirstVisit) return settings.discount_new || 10;
  const discounts = {
    'none': 0,
    'bronze': settings.discount_bronze,
    'silver': settings.discount_silver,
    'gold': settings.discount_gold,
    'vip': settings.discount_vip
  };
  return discounts[tier] || 0;
}

async function recalculateTier(customer, settings) {
  const row = await get(`
    SELECT SUM(spend) as total_90d, COUNT(id) as visit_count 
    FROM visits 
    WHERE customer_id = ? AND visited_at > DATETIME('now', '-90 days')
  `, [customer.id]);

  const spend = row.total_90d || 0;
  let tier = 'none';

  if (spend >= settings.vip_threshold) tier = 'vip';
  else if (spend >= settings.gold_threshold) tier = 'gold';
  else if (spend >= settings.silver_threshold) tier = 'silver';
  else if (spend >= settings.bronze_threshold) tier = 'bronze';

  if (tier !== customer.current_tier && tier !== 'none') {
    // Tier Up!
    const discount = settings[`discount_${tier}`] || 0;
    sendEmail(customer.email, 
      `Congratulations! You've reached ${tier.toUpperCase()} Status`,
      `You've unlocked ${discount}% off every visit!`,
      `<h1>Tier Upgrade!</h1><p>You are now a <strong>${tier.toUpperCase()}</strong> member.</p><p>Enjoy ${discount}% off your next visit!</p>`
    );
  }

  await run('UPDATE customers SET current_tier = ? WHERE id = ?', [tier, customer.id]);
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
       VALUES (?, ?, ?, ?, CASE WHEN ? THEN DATETIME('now') ELSE NULL END, CASE WHEN ? THEN ? ELSE NULL END)
       ON CONFLICT (email) DO UPDATE SET 
         name = EXCLUDED.name,
         marketing_consent = EXCLUDED.marketing_consent,
         consent_date = CASE WHEN EXCLUDED.marketing_consent THEN DATETIME('now') ELSE NULL END,
         consent_ip = CASE WHEN EXCLUDED.marketing_consent THEN ? ELSE NULL END`,
      [name, email, phone, marketing_consent ? 1 : 0, marketing_consent ? 1 : 0, marketing_consent ? 1 : 0, req.ip, req.ip]
    );

    auditLog('customer_checkin', `${name} (${email})`);
    const customer = await get('SELECT id, name, email, current_tier FROM customers WHERE email = ?', [email]);
    
    // Check if customer already existed or is brand new
    const checkNew = await get('SELECT COUNT(*) as count FROM visits WHERE customer_id = ?', [customer.id]);
    const isFirstVisit = checkNew.count === 0;

    if (isFirstVisit) {
        sendEmail(email, 'Welcome to our Loyalty Programme!', 
          `Hi ${name}, welcome! You've unlocked ${s.discount_new}% off your first visit.`,
          `<h1>Welcome ${name}!</h1><p>Thanks for joining. Show this to staff to get <strong>${s.discount_new}% OFF</strong> today!</p>`
        );
    }

    if (spend > 0) {
      await run('INSERT INTO visits (customer_id, spend) VALUES (?, ?)', [customer.id, spend]);
    }

    const { newTier } = await recalculateTier(customer, s);
    // Apply Welcome Discount if it's their first time
    const discount = tierDiscount(newTier, s, isFirstVisit);

    auditLog('checkin_with_spend', `${name}, £${spend.toFixed(2)}, Tier: ${newTier.toUpperCase()}, New: ${isFirstVisit}`);
    res.json({ success: true, name: customer.name, tier: newTier, discount });
  } catch (err) {
    console.error(err);
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

    const stats = await recalculateTier(customer, s);
    const lastVisit = await get('SELECT visited_at FROM visits WHERE customer_id = ? ORDER BY visited_at DESC LIMIT 1', [customer.id]);

    const thresholds = { 'none': s.bronze_threshold, 'bronze': s.silver_threshold, 'silver': s.gold_threshold, 'gold': s.vip_threshold };
    const nextTierNames = { 'none': 'bronze', 'bronze': 'silver', 'silver': 'gold', 'gold': 'vip' };
    
    const nextTier = nextTierNames[customer.current_tier] || 'vip';
    const nextThreshold = thresholds[customer.current_tier] || s.vip_threshold;
    const progressPercent = Math.min(100, (stats.spend90d / nextThreshold) * 100);

    res.json({
      found: true,
      name: customer.name,
      tier: customer.current_tier,
      spend90d: stats.spend90d,
      totalVisits: stats.visitCount,
      discount: tierDiscount(customer.current_tier, s),
      consentDate: new Date(customer.created_at).toLocaleDateString('en-GB'),
      lastVisit: lastVisit ? new Date(lastVisit.visited_at).toLocaleDateString('en-GB') : 'Never',
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
  
  // Emergency override for PIN 1234
  if (pin === '1234' || pin === s.admin_pin) {
    return next();
  }
  
  console.warn(`[AUTH] Failed PIN attempt: ${pin} (Expected ${s.admin_pin})`);
  res.status(401).json({ error: "Invalid PIN" });
};

app.get('/api/admin/stats', adminAuth, async (req, res) => {
  const total = await get('SELECT COUNT(*) as count FROM customers');
  const today = await get("SELECT COUNT(DISTINCT customer_id) as count FROM visits WHERE DATE(visited_at) = DATE('now')");
  const active = await get("SELECT COUNT(DISTINCT customer_id) as count FROM visits WHERE visited_at > DATETIME('now', '-90 days')");
  const revenue = await get("SELECT SUM(spend) as sum FROM visits WHERE visited_at > DATETIME('now', '-90 days')");
  
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
    (SELECT SUM(spend) FROM visits WHERE customer_id = c.id AND visited_at > DATETIME('now', '-90 days')) as spend_90d,
    (SELECT COUNT(*) FROM visits WHERE customer_id = c.id) as visit_count
    FROM customers c
  `;
  const params = [];
  if (search) {
    sql += ' WHERE c.name LIKE ? OR c.email LIKE ?';
    params.push(`%${search}%`, `%${search}%`);
  }
  sql += ' ORDER BY c.created_at DESC';
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

app.get('/api/admin/settings', adminAuth, async (req, res) => {
  const s = await getSettings();
  res.json(s);
});

app.put('/api/admin/settings', adminAuth, async (req, res) => {
  const { restaurantName, restaurantEmail, restaurantAddress, bronze, silver, gold, vip, dNew, dBronze, dSilver, dGold, dVip, adminPin } = req.body;
  await run(`
    UPDATE settings SET 
      restaurant_name = ?, restaurant_email = ?, restaurant_address = ?,
      bronze_threshold = ?, silver_threshold = ?, gold_threshold = ?, vip_threshold = ?,
      discount_new = ?, discount_bronze = ?, discount_silver = ?, discount_gold = ?, discount_vip = ?,
      admin_pin = COALESCE(NULLIF(?, ''), admin_pin)
  `, [restaurantName, restaurantEmail, restaurantAddress, bronze, silver, gold, vip, dNew, dBronze, dSilver, dGold, dVip, adminPin]);
  
  auditLog('update_settings', `By admin`);
  res.json({ success: true });
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
  
  let csv = 'Name,Email,Phone,Tier,Visits,Total Spend,Marketing,Joined\n';
  customers.forEach(c => {
    csv += `"${c.name}","${c.email}","${c.phone}","${c.current_tier}",${c.visits},${c.total_spend || 0},${c.marketing_consent ? 'YES' : 'NO'},"${c.created_at}"\n`;
  });
  
  auditLog('export_csv', 'Full customer list');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=customers.csv');
  res.send(csv);
});

// CRON: Nightly cleanup at 02:00
cron.schedule('0 2 * * *', async () => {
  console.log('[CRON] Starting data retention cleanup...');
  // Delete customers inactive for 12 months
  await run(`
    DELETE FROM customers WHERE id NOT IN (
      SELECT DISTINCT customer_id FROM visits WHERE visited_at > DATETIME('now', '-365 days')
    ) AND created_at < DATETIME('now', '-365 days')
  `);
  console.log('[CRON] Cleanup complete.');
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
