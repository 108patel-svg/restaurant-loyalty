require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const sgMail = require('@sendgrid/mail');
const path = require('path');
const jwt = require('jsonwebtoken');
const cron = require('node-cron');
const { PKPass } = require('passkit-generator');

const app = express();
app.use(cors());
app.use(express.json());

// Serve static frontend
app.use(express.static(path.join(__dirname, '../frontend')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

// Helpers
async function getSettings() {
  const rs = await pool.query('SELECT * FROM settings WHERE id = 1');
  return rs.rows[0];
}

function getTier(spend90d, s) {
  if (spend90d >= s.vip_threshold) return 'vip';
  if (spend90d >= s.gold_threshold) return 'gold';
  if (spend90d >= s.silver_threshold) return 'silver';
  if (spend90d >= s.bronze_threshold) return 'bronze';
  return 'none';
}

function tierOrder(tier) {
  const o = { 'none': 0, 'bronze': 1, 'silver': 2, 'gold': 3, 'vip': 4 };
  return o[tier] || 0;
}

function tierLabel(tier) {
  const l = { 'none': 'No tier', 'bronze': 'Bronze', 'silver': 'Silver', 'gold': 'Gold', 'vip': 'VIP' };
  return l[tier] || 'Unknown';
}

function tierDiscount(tier, s, isNew) {
  if (isNew) return Number(s.discount_new);
  if (tier === 'vip') return Number(s.discount_vip);
  if (tier === 'gold') return Number(s.discount_gold);
  if (tier === 'silver') return Number(s.discount_silver);
  if (tier === 'bronze') return Number(s.discount_bronze);
  return 0;
}

// Admin Auth Middleware
function checkAdmin(req, res, next) {
  const pin = req.headers['x-admin-pin'];
  if (pin !== (process.env.ADMIN_PIN || '1234')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Send email
async function sendTierUpEmail(email, name, tier, discount, resName) {
  if (!process.env.SENDGRID_API_KEY || !process.env.FROM_EMAIL) return;
  try {
    const msg = {
      to: email,
      from: process.env.FROM_EMAIL,
      subject: `You've reached ${tierLabel(tier)} status at ${resName}!`,
      html: `
        <div style="background-color:#F7F3EE; padding:40px; font-family:sans-serif; color:#1A1410;">
          <h2 style="color:#C4531A;">Congratulations ${name}!</h2>
          <p>You have unlocked <strong>${tierLabel(tier)}</strong> status.</p>
          <p>Enjoy your new discount of <strong>${discount}%</strong>.</p>
          <p>Simply show the check-in screen to your server during your next visit.</p>
          <hr style="border-top:1px solid rgba(26,20,16,0.12);" />
          <footer style="font-size:12px; color:#6B6259;">${resName}</footer>
        </div>
      `,
    };
    await sgMail.send(msg);
  } catch (err) {
    console.error('Email error:', err);
  }
}

app.post('/api/visit', async (req, res) => {
  const { name, email, spend } = req.body;
  if (!name || !email || spend === undefined || spend < 0) {
    return res.status(400).json({ error: 'Invalid fields' });
  }

  try {
    const s = await getSettings();

    // Check if new & Upsert customer
    const custRes = await pool.query(
      `INSERT INTO customers (name, email) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, current_tier, created_at`,
      [name, email.toLowerCase()]
    );
    const customer = custRes.rows[0];
    const customerId = customer.id;
    const prevTier = customer.current_tier;

    // Is new customer
    const visitsCheck = await pool.query('SELECT COUNT(*) FROM visits WHERE customer_id = $1', [customerId]);
    const isNew = parseInt(visitsCheck.rows[0].count) === 0;

    // Insert visit
    await pool.query('INSERT INTO visits (customer_id, spend) VALUES ($1, $2)', [customerId, spend]);

    // Recalculate 90-day
    const sRes = await pool.query(
      `SELECT SUM(spend) as total FROM visits
       WHERE customer_id = $1 AND visited_at >= NOW() - INTERVAL '90 days'`,
      [customerId]
    );
    const spend90d = parseFloat(sRes.rows[0].total) || 0;

    const newTier = getTier(spend90d, s);
    const tierUp = tierOrder(newTier) > tierOrder(prevTier);

    if (newTier !== prevTier) {
      await pool.query('UPDATE customers SET current_tier = $1 WHERE id = $2', [newTier, customerId]);
    }

    const discount = tierDiscount(newTier, s, isNew);

    if (tierUp && !isNew) {
      sendTierUpEmail(email, name, newTier, discount, s.restaurant_name);
    } else if (isNew) {
      sendTierUpEmail(email, name, 'none (Welcome!)', discount, s.restaurant_name);
    }

    const totalVisits = await pool.query('SELECT COUNT(*) as c FROM visits WHERE customer_id = $1', [customerId]);

    let nextTier = 'none';
    let nextThreshold = 0;
    if (newTier === 'none') { nextTier = 'bronze'; nextThreshold = Number(s.bronze_threshold); }
    else if (newTier === 'bronze') { nextTier = 'silver'; nextThreshold = Number(s.silver_threshold); }
    else if (newTier === 'silver') { nextTier = 'gold'; nextThreshold = Number(s.gold_threshold); }
    else if (newTier === 'gold') { nextTier = 'vip'; nextThreshold = Number(s.vip_threshold); }

    res.json({
      success: true, isNew, tierUp, prevTier, tier: newTier,
      spend90d, discount, nextTier, nextThreshold,
      totalVisits: parseInt(totalVisits.rows[0].c),
      firstVisit: customer.created_at
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/stats', checkAdmin, async (req, res) => {
  try {
    const cRes = await pool.query('SELECT COUNT(*) FROM customers');
    const todayRes = await pool.query(`SELECT COUNT(DISTINCT customer_id) FROM visits WHERE visited_at >= CURRENT_DATE`);
    const actRes = await pool.query(`SELECT COUNT(DISTINCT customer_id) FROM visits WHERE visited_at >= NOW() - INTERVAL '90 days'`);
    const revRes = await pool.query(`SELECT SUM(spend) FROM visits WHERE visited_at >= NOW() - INTERVAL '90 days'`);

    const tierCounts = await pool.query('SELECT current_tier, COUNT(*) FROM customers GROUP BY current_tier');
    let t = { none: 0, bronze: 0, silver: 0, gold: 0, vip: 0 };
    tierCounts.rows.forEach(r => t[r.current_tier] = parseInt(r.count));

    const recent = await pool.query(`
      SELECT c.name, v.visited_at, c.current_tier, v.spend
      FROM visits v JOIN customers c ON v.customer_id = c.id
      ORDER BY v.visited_at DESC LIMIT 20
    `);

    res.json({
      totalCustomers: parseInt(cRes.rows[0].count),
      visitedToday: parseInt(todayRes.rows[0].count),
      active90d: parseInt(actRes.rows[0].count),
      revenue90d: parseFloat(revRes.rows[0].sum) || 0,
      tierCounts: t,
      recentVisits: recent.rows.map(r => ({
        customerName: r.name,
        date: new Intl.DateTimeFormat('en-GB').format(r.visited_at),
        tier: r.current_tier,
        spend: parseFloat(r.spend)
      }))
    });
  } catch (err) {
    res.status(500).json({ error: 'Stats error' });
  }
});

app.get('/api/admin/customers', checkAdmin, async (req, res) => {
  try {
    const s = req.query.search || '';
    const q = `
      SELECT c.*, 
        COUNT(v.id) as visit_count,
        COALESCE(SUM(CASE WHEN v.visited_at >= NOW() - INTERVAL '90 days' THEN v.spend ELSE 0 END), 0) as spend_90d,
        MAX(v.visited_at) as last_visit
      FROM customers c
      LEFT JOIN visits v ON c.id = v.customer_id
      WHERE c.name ILIKE $1 OR c.email ILIKE $1
      GROUP BY c.id
      ORDER BY last_visit DESC NULLS LAST
    `;
    const rs = await pool.query(q, [`%${s}%`]);
    res.json(rs.rows.map(r => ({ ...r, spend_90d: parseFloat(r.spend_90d) })));
  } catch (err) {
    res.status(500).json({ error: 'Customers error' });
  }
});

app.get('/api/admin/settings', checkAdmin, async (req, res) => {
  res.json(await getSettings());
});

app.put('/api/admin/settings', checkAdmin, async (req, res) => {
  const b = req.body;
  try {
    await pool.query(`
      UPDATE settings SET
        restaurant_name=$1, bronze_threshold=$2, silver_threshold=$3, gold_threshold=$4, vip_threshold=$5,
        discount_new=$6, discount_bronze=$7, discount_silver=$8, discount_gold=$9, discount_vip=$10
      WHERE id = 1
    `, [
      b.restaurantName, b.bronze, b.silver, b.gold, b.vip,
      b.dNew, b.dBronze, b.dSilver, b.dGold, b.dVip
    ]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Settings error' });
  }
});

app.get('/api/admin/export', checkAdmin, async (req, res) => {
  try {
    const q = `
      SELECT c.*, COUNT(v.id) as visit_count,
        COALESCE(SUM(CASE WHEN v.visited_at >= NOW() - INTERVAL '90 days' THEN v.spend ELSE 0 END), 0) as spend_90d
      FROM customers c LEFT JOIN visits v ON c.id = v.customer_id
      GROUP BY c.id ORDER BY c.created_at DESC
    `;
    const rs = await pool.query(q);

    let csv = "Name,Email,Tier,Visits,90-Day Spend (£),Member Since\n";
    rs.rows.forEach(c => {
      const dStr = new Intl.DateTimeFormat('en-GB').format(c.created_at);
      const name = `"${c.name.replace(/"/g, '""')}"`;
      csv += `${name},${c.email},${tierLabel(c.current_tier)},${c.visit_count},${parseFloat(c.spend_90d).toFixed(2)},${dStr}\n`;
    });

    res.header('Content-Type', 'text/csv');
    res.attachment('customers_export.csv');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: 'Export error' });
  }
});

// ====== Phase 2 Features ======

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key-123';

app.post('/api/magic-link', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const custRes = await pool.query('SELECT name FROM customers WHERE email = $1', [email.toLowerCase()]);
    if (custRes.rows.length === 0) return res.status(404).json({ error: 'Email not found' });
    const name = custRes.rows[0].name;

    const token = jwt.sign({ email: email.toLowerCase() }, JWT_SECRET, { expiresIn: '1h' });
    const s = await getSettings();
    `https://restaurant-loyalty-trqr.onrender.com/wallet.html?token=${token}`;

    if (process.env.SENDGRID_API_KEY && process.env.FROM_EMAIL) {
      await sgMail.send({
        to: email, from: process.env.FROM_EMAIL,
        subject: `Your Secure Login Link - ${s.restaurant_name}`,
        text: `Click here to open your wallet: ${link}`,
        html: `<p>Hi ${name},</p><p><a href="${link}">Click here to view your digital loyalty card</a></p>`,
      });
    } else {
      console.log(`[STUB EMAIL] To: ${email} | Subject: Magic Link | Link: ${link}`);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/status', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Missing token' });
  const token = authHeader.split(' ')[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const q = `
      SELECT c.*, COALESCE(SUM(CASE WHEN v.visited_at >= NOW() - INTERVAL '90 days' THEN v.spend ELSE 0 END), 0) as spend_90d
      FROM customers c LEFT JOIN visits v ON c.id = v.customer_id
      WHERE c.email = $1 GROUP BY c.id
    `;
    const rs = await pool.query(q, [payload.email]);
    if (rs.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    const s = await getSettings();
    const user = rs.rows[0];
    const discount = tierDiscount(user.current_tier, s, false);

    res.json({ name: user.name, tier: user.current_tier, spend90d: parseFloat(user.spend_90d), discount });
  } catch (err) { res.status(401).json({ error: 'Invalid or expired token' }); }
});

app.get('/api/wallet/apple', async (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(401).send('Missing token');
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const rs = await pool.query('SELECT name, current_tier FROM customers WHERE email = $1', [payload.email]);
    if (rs.rows.length === 0) return res.status(404).send('Not found');
    const user = rs.rows[0];
    const s = await getSettings();
    const discount = tierDiscount(user.current_tier, s, false);

    try {
      const pass = new PKPass({
        "passTypeIdentifier": "pass.com.example.restaurant",
        "teamIdentifier": "TEAMID123",
        "organizationName": s.restaurant_name,
        "description": "Loyalty Pass"
      }, { signerCert: Buffer.from([]), signerKey: Buffer.from([]), wwdr: Buffer.from([]) });

      pass.primaryFields.push({ key: "name", label: "Name", value: user.name });
      pass.secondaryFields.push({ key: "tier", label: "Tier", value: tierLabel(user.current_tier).toUpperCase() });
      pass.backFields.push({ key: "discount", label: "Discount", value: `${discount}% OFF` });

      const buffer = await pass.getAsBuffer();
      res.type('application/vnd.apple.pkpass');
      res.send(buffer);
    } catch (certErr) {
      res.type('text/plain');
      res.send(`Mock Apple Wallet Pass created for ${user.name} - Tier: ${tierLabel(user.current_tier)}. (Requires valid Apple Certificates attached to passkit-generator to serve binary real pass).`);
    }
  } catch (err) { res.status(401).send('Invalid token'); }
});

cron.schedule('0 12 * * *', async () => {
  try {
    const rs = await pool.query(`
        SELECT c.email, c.name, MAX(v.visited_at) as last
        FROM customers c JOIN visits v ON c.id = v.customer_id
        WHERE c.current_tier != 'none'
        GROUP BY c.id HAVING MAX(v.visited_at) < NOW() - INTERVAL '60 days'
      `);
    rs.rows.forEach(r => {
      console.log(`[CRON] Reactivation Email pushed to ${r.email}: "We miss you!"`);
    });
  } catch (e) { }
});

cron.schedule('0 10 1 * *', async () => {
  try {
    const rs = await pool.query(`
        SELECT c.email, c.name, c.current_tier, SUM(v.spend) as s90
        FROM customers c JOIN visits v ON c.id = v.customer_id 
        WHERE v.visited_at >= NOW() - INTERVAL '90 days'
        GROUP BY c.id
      `);
    rs.rows.forEach(r => {
      console.log(`[CRON] Monthly Email pushed to ${r.email}: "Tier: ${r.current_tier}, 90d Spend: £${r.s90}"`);
    });
  } catch (e) { }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
