require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const sgMail = require('@sendgrid/mail');
const path = require('path');
const jwt = require('jsonwebtoken');
const cron = require('node-cron');
const twilio = require('twilio');

// SMS CONFIG
const twilioClient = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN 
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

const app = express();

// TRUST PROXY (Required for rate limiting to work on Render/load balancers)
app.set('trust proxy', 1);

// SECURITY HEADERS
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:"]
    }
  }
}));

// CORS RESTRICTION
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || []
}));
app.use(express.json());

// Serve static frontends
app.use('/tablet', express.static(path.join(__dirname, '../frontend-tablet')));
app.use('/public', express.static(path.join(__dirname, '../frontend-public')));
// Fallback for backward compatibility or default
app.use(express.static(path.join(__dirname, '../frontend-tablet')));

/* 
 * SECURITY NOTE: The DATABASE_URL must point to a private/internal database. 
 * Never expose PostgreSQL port 5432 to the public internet. 
 * Use environment variables only. Never hardcode credentials.
 */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

// reCAPTCHA verification (Node 18+ has native fetch)
async function verifyRecaptcha(token) {
  if (!token) return false;
  try {
    const response = await fetch(
      `https://www.google.com/recaptcha/api/siteverify?secret=${process.env.RECAPTCHA_SECRET_KEY}&response=${token}`,
      { method: 'POST' }
    );
    const data = await response.json();
    return data.success && data.score >= 0.5;
  } catch (err) {
    console.error('reCAPTCHA error:', err);
    return false;
  }
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

async function recalculateTier(customerId, s) {
    const sRes = await pool.query(
      `SELECT SUM(spend) as total FROM visits
       WHERE customer_id = $1 AND visited_at >= NOW() - INTERVAL '90 days'`,
      [customerId]
    );
    const spend90d = parseFloat(sRes.rows[0].total) || 0;
    const newTier = getTier(spend90d, s);
    await pool.query('UPDATE customers SET current_tier = $1 WHERE id = $2', [newTier, customerId]);
    return { spend90d, newTier };
}

// ====== Rate Limiters ======
const visitLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10,
  message: { error: 'Too many requests. Please wait and try again.' }
});

const adminLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30,
  message: { error: 'Too many requests. Please wait and try again.' }
});

// Admin Auth Middleware
function checkAdmin(req, res, next) {
  const pin = req.headers['x-admin-pin'];
  if (pin !== (process.env.ADMIN_PIN || '1234')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ====== Email Templates ======

function emailWrapper(resName, bodyHtml, email) {
  const unsubToken = jwt.sign({ email, action: 'unsubscribe' }, JWT_SECRET, { expiresIn: '30d' });
  const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  const unsubLink = `${baseUrl}/unsubscribe.html?token=${unsubToken}`;
  return `
    <div style="background-color:#F7F3EE; padding:0; font-family:'Helvetica Neue',Helvetica,Arial,sans-serif; color:#1A1410;">
      <div style="max-width:560px; margin:0 auto; padding:48px 32px;">
        <div style="text-align:center; margin-bottom:32px;">
          <h1 style="font-family:Georgia,'Times New Roman',serif; font-size:28px; font-weight:400; color:#1A1410; margin:0;">${resName}</h1>
          <p style="font-size:11px; letter-spacing:0.12em; text-transform:uppercase; color:#6B6259; margin:8px 0 0;">Loyalty Rewards</p>
        </div>
        <div style="background-color:#FFFFFF; border-radius:12px; padding:32px; border:1px solid rgba(26,20,16,0.08); box-shadow:0 2px 12px rgba(0,0,0,0.04);">
          ${bodyHtml}
        </div>
        <div style="text-align:center; margin-top:32px;">
          <p style="font-size:12px; color:#6B6259; margin:0;">Kind regards,</p>
          <p style="font-size:13px; color:#1A1410; font-weight:500; margin:4px 0 0;">The team at ${resName}</p>
          <hr style="border:none; border-top:1px solid rgba(26,20,16,0.08); margin:24px 0 16px;" />
          <p style="font-size:11px; color:#9E9589; margin:0;">You're receiving this because you're a valued member of our loyalty programme.</p>
          <p style="margin:8px 0 0;"><a href="${unsubLink}" style="font-size:11px; color:#9E9589; text-decoration:underline;">Unsubscribe from loyalty emails</a></p>
        </div>
      </div>
    </div>
  `;
}

async function sendEmail(to, subject, bodyHtml, resName) {
  if (!process.env.SENDGRID_API_KEY || !process.env.FROM_EMAIL) {
    console.log(`[STUB EMAIL] To: ${to} | Subject: ${subject}`);
    return;
  }
  // Check if user has unsubscribed
  try {
    const check = await pool.query('SELECT unsubscribed, marketing_consent FROM customers WHERE email = $1', [to.toLowerCase()]);
    if (check.rows.length > 0) {
      if (check.rows[0].unsubscribed || !check.rows[0].marketing_consent) {
        console.log(`[EMAIL SKIPPED] ${to} unsubscribed or no consent.`);
        return;
      }
    }
  } catch (e) { /* proceed if check fails */ }
  try {
    await sgMail.send({ to, from: process.env.FROM_EMAIL, subject, html: emailWrapper(resName, bodyHtml, to) });
  } catch (err) {
    console.error('Email error:', err.message);
  }
}

async function sendWelcomeEmail(email, name, discount, resName) {
  const subject = `Welcome to ${resName} Rewards!`;
  const body = `
    <h2 style="font-family:Georgia,serif; font-size:22px; color:#C4531A; margin:0 0 16px;">Welcome, ${name.split(' ')[0]}!</h2>
    <p style="font-size:15px; line-height:1.6; color:#1A1410;">Thank you so much for dining with us today — we hope you had a wonderful experience.</p>
    <p style="font-size:15px; line-height:1.6; color:#1A1410;">As a warm welcome to our loyalty family, here is your well-deserved reward:</p>
    <div style="background:#FFF8E1; border:2px dashed #FFE082; border-radius:10px; padding:20px; text-align:center; margin:24px 0;">
      <p style="font-size:32px; font-weight:600; color:#C4531A; margin:0;">${discount}% OFF</p>
      <p style="font-size:13px; color:#6B6259; margin:8px 0 0;">Your new customer discount — show this to your server on your next visit</p>
    </div>
    <p style="font-size:15px; line-height:1.6; color:#1A1410;">The more you dine, the more you save. Keep visiting and watch your tier climb from Bronze all the way to VIP!</p>
    <p style="font-size:15px; line-height:1.6; color:#1A1410;">We can't wait to welcome you back soon.</p>
  `;
  await sendEmail(email, subject, body, resName);
}

async function sendTierUpEmail(email, name, tier, discount, resName) {
  const subject = `Congratulations — you've reached ${tierLabel(tier)} status!`;
  const body = `
    <h2 style="font-family:Georgia,serif; font-size:22px; color:#C4531A; margin:0 0 16px;">Brilliant news, ${name.split(' ')[0]}!</h2>
    <p style="font-size:15px; line-height:1.6; color:#1A1410;">We hope you enjoyed your visit today. Your loyalty has truly paid off — you've just unlocked a brand new tier!</p>
    <div style="background:#1A1410; border-radius:10px; padding:24px; text-align:center; margin:24px 0;">
      <p style="font-size:11px; letter-spacing:0.1em; text-transform:uppercase; color:#9E9589; margin:0 0 8px;">Your new status</p>
      <p style="font-size:28px; font-weight:600; color:#C8A84B; margin:0;">${tierLabel(tier).toUpperCase()}</p>
    </div>
    <div style="background:#FFF8E1; border:2px dashed #FFE082; border-radius:10px; padding:20px; text-align:center; margin:0 0 24px;">
      <p style="font-size:32px; font-weight:600; color:#C4531A; margin:0;">${discount}% OFF</p>
      <p style="font-size:13px; color:#6B6259; margin:8px 0 0;">Here is your well-deserved discount — simply show this to your server</p>
    </div>
    <p style="font-size:15px; line-height:1.6; color:#1A1410;">Thank you for being such a loyal guest. We truly appreciate every visit, and we look forward to seeing you again very soon.</p>
  `;
  await sendEmail(email, subject, body, resName);
}

async function sendReactivationEmail(email, name, tier, discount, resName) {
  const subject = `We miss you, ${name.split(' ')[0]}!`;
  const body = `
    <h2 style="font-family:Georgia,serif; font-size:22px; color:#C4531A; margin:0 0 16px;">It's been a while, ${name.split(' ')[0]}!</h2>
    <p style="font-size:15px; line-height:1.6; color:#1A1410;">We've noticed it's been some time since your last visit, and honestly — we miss having you.</p>
    <p style="font-size:15px; line-height:1.6; color:#1A1410;">The good news? You still hold <strong>${tierLabel(tier)}</strong> status with us, and your exclusive discount is waiting:</p>
    <div style="background:#FFF8E1; border:2px dashed #FFE082; border-radius:10px; padding:20px; text-align:center; margin:24px 0;">
      <p style="font-size:32px; font-weight:600; color:#C4531A; margin:0;">${discount}% OFF</p>
      <p style="font-size:13px; color:#6B6259; margin:8px 0 0;">Your ${tierLabel(tier)} reward is still active — don't let it go to waste!</p>
    </div>
    <p style="font-size:15px; line-height:1.6; color:#1A1410;">Pop in any time and simply check in at the door. Your table is always ready.</p>
    <p style="font-size:15px; line-height:1.6; color:#1A1410;">We'd love to welcome you back.</p>
  `;
  await sendEmail(email, subject, body, resName);
}

async function sendMonthlyEmail(email, name, tier, spend90d, discount, resName) {
  const monthName = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' }).format(new Date());
  const subject = `Your ${monthName} Loyalty Update`;
  const body = `
    <h2 style="font-family:Georgia,serif; font-size:22px; color:#C4531A; margin:0 0 16px;">Your monthly update, ${name.split(' ')[0]}</h2>
    <p style="font-size:15px; line-height:1.6; color:#1A1410;">Here's a quick snapshot of where you stand this month. Thank you for continuing to dine with us!</p>
    <div style="display:flex; gap:12px; margin:24px 0;">
      <div style="flex:1; background:#F7F3EE; border-radius:10px; padding:16px; text-align:center;">
        <p style="font-size:11px; text-transform:uppercase; letter-spacing:0.08em; color:#6B6259; margin:0 0 4px;">Current Tier</p>
        <p style="font-size:20px; font-weight:600; color:#1A1410; margin:0;">${tierLabel(tier)}</p>
      </div>
      <div style="flex:1; background:#F7F3EE; border-radius:10px; padding:16px; text-align:center;">
        <p style="font-size:11px; text-transform:uppercase; letter-spacing:0.08em; color:#6B6259; margin:0 0 4px;">90-Day Spend</p>
        <p style="font-size:20px; font-weight:600; color:#1A1410; margin:0;">&pound;${parseFloat(spend90d).toFixed(2)}</p>
      </div>
    </div>
    <div style="background:#FFF8E1; border:2px dashed #FFE082; border-radius:10px; padding:20px; text-align:center; margin:0 0 24px;">
      <p style="font-size:32px; font-weight:600; color:#C4531A; margin:0;">${discount}% OFF</p>
      <p style="font-size:13px; color:#6B6259; margin:8px 0 0;">Your current active discount</p>
    </div>
    <p style="font-size:15px; line-height:1.6; color:#1A1410;">Keep dining with us to maintain or increase your tier. We genuinely appreciate your loyalty and look forward to your next visit!</p>
  `;
  await sendEmail(email, subject, body, resName);
}

app.post('/api/visit', visitLimiter, async (req, res) => {
  let { name, email, spend, marketing_consent } = req.body;
  
  if (typeof name !== 'string' || typeof email !== 'string') {
    return res.status(400).json({ error: 'Invalid fields' });
  }

  name = name.trim();
  email = email.trim().toLowerCase();

  if (!name || !email || name.length > 500 || email.length > 500) {
    return res.status(400).json({ error: 'Invalid fields' });
  }

  spend = parseFloat(spend);
  if (isNaN(spend) || spend < 0 || spend > 99999) {
    return res.status(400).json({ error: 'Invalid fields' });
  }

  marketing_consent = Boolean(marketing_consent);
  const clientIp = req.ip || req.headers['x-forwarded-for'] || null;

  try {
    const s = await getSettings();

    // Check if new & Upsert customer
    const custRes = await pool.query(
      `INSERT INTO customers (name, email, marketing_consent, consent_date, consent_ip) 
       VALUES ($1, $2, $3, CASE WHEN $3 THEN NOW() ELSE NULL END, CASE WHEN $3 THEN $4 ELSE NULL END)
       ON CONFLICT (email) DO UPDATE SET 
         name = EXCLUDED.name,
         marketing_consent = CASE WHEN EXCLUDED.marketing_consent THEN TRUE ELSE customers.marketing_consent END,
         consent_date = CASE WHEN EXCLUDED.marketing_consent AND NOT customers.marketing_consent THEN NOW() ELSE customers.consent_date END,
         consent_ip = CASE WHEN EXCLUDED.marketing_consent AND NOT customers.marketing_consent THEN $4 ELSE customers.consent_ip END
       RETURNING id, current_tier, created_at, marketing_consent`,
      [name, email, marketing_consent, clientIp]
    );
    const customer = custRes.rows[0];
    const customerId = customer.id;
    const prevTier = customer.current_tier;
    const hasMarketingConsent = customer.marketing_consent;

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
      if (hasMarketingConsent) {
        sendTierUpEmail(email, name, newTier, discount, s.restaurant_name);
      }
    } else if (isNew) {
      sendWelcomeEmail(email, name, discount, s.restaurant_name);
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

// ====== SMS Verification ======
const verificationCodes = new Map(); // In production, use Redis

app.post('/api/send-code', visitLimiter, async (req, res) => {
  const { phone, recaptcha_token } = req.body;
  
  if (!await verifyRecaptcha(recaptcha_token)) {
    return res.status(403).json({ error: "Bot verification failed." });
  }

  if (!phone || !phone.match(/^\+?[1-9]\d{1,14}$/)) {
    return res.status(400).json({ error: "Invalid phone number format." });
  }

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  verificationCodes.set(phone, { code, expires: Date.now() + 10 * 60 * 1000 });

  if (twilioClient && process.env.TWILIO_PHONE_NUMBER) {
    try {
      await twilioClient.messages.create({
        body: `Your loyalty verification code is: ${code}`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: phone
      });
      res.json({ success: true, message: "Code sent." });
    } catch (err) {
      console.error('Twilio error:', err);
      res.status(500).json({ error: "Failed to send SMS." });
    }
  } else {
    console.log(`[SMS STUB] Code for ${phone}: ${code}`);
    res.json({ success: true, message: "Code sent (stub)." });
  }
});

app.post('/api/checkin', visitLimiter, async (req, res) => {
  let { name, email, phone, marketing_consent, recaptcha_token } = req.body;

  if (!await verifyRecaptcha(recaptcha_token)) {
    return res.status(403).json({ error: "Bot verification failed." });
  }

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: "A valid email address is required." });
  }

  try {
    const s = await getSettings();
    email = email.trim().toLowerCase();
    name = name.trim();
    phone = phone ? phone.trim() : null;

    // Upsert customer by email
    const custRes = await pool.query(
      `INSERT INTO customers (name, email, phone, marketing_consent, consent_date, consent_ip) 
       VALUES ($1, $2, $3, $4, CASE WHEN $4 THEN NOW() ELSE NULL END, CASE WHEN $4 THEN $5 ELSE NULL END)
       ON CONFLICT (email) DO UPDATE SET 
         name = EXCLUDED.name,
         phone = COALESCE(EXCLUDED.phone, customers.phone),
         marketing_consent = CASE WHEN EXCLUDED.marketing_consent THEN TRUE ELSE customers.marketing_consent END,
         consent_date = CASE WHEN EXCLUDED.marketing_consent AND NOT customers.marketing_consent THEN NOW() ELSE customers.consent_date END,
         consent_ip = CASE WHEN EXCLUDED.marketing_consent AND NOT customers.marketing_consent THEN $5 ELSE customers.consent_ip END
       RETURNING id, name, current_tier, created_at`,
      [name, email, phone, !!marketing_consent, req.ip]
    );
    const customer = custRes.rows[0];

    // Mark as pending
    await pool.query(
      'INSERT INTO pending_checkins (customer_id) VALUES ($1)',
      [customer.id]
    );

    // Calculate status for confirmation screen
    const sRes = await pool.query(
      `SELECT SUM(spend) as total FROM visits
       WHERE customer_id = $1 AND visited_at >= NOW() - INTERVAL '90 days'`,
      [customer.id]
    );
    const spend90d = parseFloat(sRes.rows[0].total) || 0;
    const tier = customer.current_tier;
    const discount = tierDiscount(tier, s, false);

    res.json({
      success: true,
      name: customer.name,
      tier: tier,
      discount: discount,
      spend90d: spend90d
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Check-in failed." });
  }
});

app.get('/api/status', async (req, res) => {
  const { email, recaptcha_token } = req.query;

  if (!await verifyRecaptcha(recaptcha_token)) {
    return res.status(403).json({ error: "Bot verification failed." });
  }

  if (!email) return res.status(400).json({ error: "Email is required." });

  try {
    const s = await getSettings();
    const cRes = await pool.query('SELECT * FROM customers WHERE email = $1', [email.trim().toLowerCase()]);
    if (cRes.rowCount === 0) {
      return res.json({ found: false });
    }
    const c = cRes.rows[0];

    const sRes = await pool.query(
      `SELECT SUM(spend) as total, COUNT(*) as count, MAX(visited_at) as last
       FROM visits WHERE customer_id = $1 AND visited_at >= NOW() - INTERVAL '90 days'`,
      [c.id]
    );
    const spend90d = parseFloat(sRes.rows[0].total) || 0;
    const totalVisits = parseInt(sRes.rows[0].count);
    const lastVisit = sRes.rows[0].last;

    const tier = c.current_tier;
    const discount = tierDiscount(tier, s, false);

    let nextTier = 'none';
    let nextThreshold = 0;
    if (tier === 'none') { nextTier = 'bronze'; nextThreshold = Number(s.bronze_threshold); }
    else if (tier === 'bronze') { nextTier = 'silver'; nextThreshold = Number(s.silver_threshold); }
    else if (tier === 'silver') { nextTier = 'gold'; nextThreshold = Number(s.gold_threshold); }
    else if (tier === 'gold') { nextTier = 'vip'; nextThreshold = Number(s.vip_threshold); }

    let progressPercent = 0;
    if (nextThreshold > 0) {
      let prevThresh = 0;
      if (tier === 'bronze') prevThresh = s.bronze_threshold;
      else if (tier === 'silver') prevThresh = s.silver_threshold;
      else if (tier === 'gold') prevThresh = s.gold_threshold;
      progressPercent = Math.min(100, Math.max(0, ((spend90d - prevThresh) / (nextThreshold - prevThresh)) * 100));
    }

    res.json({
      found: true,
      name: c.name,
      tier: tier,
      spend90d: spend90d,
      discount: discount,
      totalVisits: totalVisits,
      consentDate: c.consent_date ? new Intl.DateTimeFormat('en-GB').format(c.consent_date) : 'N/A',
      lastVisit: lastVisit ? new Intl.DateTimeFormat('en-GB').format(lastVisit) : 'Never',
      nextTier: nextTier,
      nextThreshold: nextThreshold,
      progressPercent: progressPercent
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Status check failed." });
  }
});

app.get('/api/admin/pending-checkins', adminLimiter, checkAdmin, async (req, res) => {
  try {
    const q = `
      SELECT c.name, c.email, c.current_tier as tier, p.checked_in_at, c.id as customer_id
      FROM pending_checkins p
      JOIN customers c ON p.customer_id = c.id
      WHERE p.spend_recorded = FALSE AND p.checked_in_at >= CURRENT_DATE
      ORDER BY p.checked_in_at DESC
    `;
    const rs = await pool.query(q);
    res.json(rs.rows.map(r => ({
      ...r,
      timeAgo: Math.floor((Date.now() - new Date(r.checked_in_at)) / 60000)
    })));
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch pending check-ins." });
  }
});

app.post('/api/admin/record-spend', adminLimiter, checkAdmin, async (req, res) => {
  let { email, spend } = req.body;
  spend = parseFloat(spend);
  if (isNaN(spend) || spend <= 0 || spend > 500) {
    return res.status(400).json({ error: "Invalid spend amount (max £500)." });
  }

  try {
    const cRes = await pool.query('SELECT id, name, current_tier, email FROM customers WHERE email = $1', [email.trim().toLowerCase()]);
    if (cRes.rowCount === 0) return res.status(404).json({ error: "Customer not found." });
    const customer = cRes.rows[0];

    // Insert visit
    await pool.query('INSERT INTO visits (customer_id, spend) VALUES ($1, $2)', [customer.id, spend]);

    // Mark pending as recorded
    await pool.query(`
      UPDATE pending_checkins 
      SET spend_recorded = TRUE, spend_recorded_at = NOW()
      WHERE id = (
        SELECT id FROM pending_checkins 
        WHERE customer_id = $1 AND spend_recorded = FALSE
        ORDER BY checked_in_at DESC
        LIMIT 1
      )
    `, [customer.id]);

    const s = await getSettings();
    const { spend90d, newTier } = await recalculateTier(customer.id, s);
    const tierUp = tierOrder(newTier) > tierOrder(customer.current_tier);

    res.json({
      success: true,
      name: customer.name,
      tier: newTier,
      tierUp: tierUp
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to record spend." });
  }
});

app.get('/api/admin/stats', adminLimiter, checkAdmin, async (req, res) => {
  try {
    const cRes = await pool.query('SELECT COUNT(*) FROM customers');
    const todayRes = await pool.query(`SELECT COUNT(DISTINCT customer_id) FROM visits WHERE visited_at >= CURRENT_DATE`);
    const actRes = await pool.query(`SELECT COUNT(DISTINCT customer_id) FROM visits WHERE visited_at >= NOW() - INTERVAL '90 days'`);
    const revRes = await pool.query(`SELECT SUM(spend) FROM visits WHERE visited_at >= NOW() - INTERVAL '90 days'`);

    const tierCounts = await pool.query('SELECT current_tier, COUNT(*) FROM customers GROUP BY current_tier');
    let t = { none: 0, bronze: 0, silver: 0, gold: 0, vip: 0 };
    tierCounts.rows.forEach(r => t[r.current_tier] = parseInt(r.count));

    const recent = await pool.query(`
      SELECT v.id, c.name, v.visited_at, c.current_tier, v.spend
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
        id: r.id,
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

app.get('/api/admin/customers', adminLimiter, checkAdmin, async (req, res) => {
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

app.get('/api/admin/settings', adminLimiter, checkAdmin, async (req, res) => {
  res.json(await getSettings());
});

app.put('/api/admin/settings', adminLimiter, checkAdmin, async (req, res) => {
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

app.get('/api/admin/export', adminLimiter, checkAdmin, async (req, res) => {
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

app.delete('/api/admin/customers/:email', adminLimiter, checkAdmin, async (req, res) => {
  try {
    const email = req.params.email.toLowerCase();
    await pool.query('DELETE FROM customers WHERE email = $1', [email]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete customer' });
  }
});

app.delete('/api/admin/visits/:id', adminLimiter, checkAdmin, async (req, res) => {
  try {
    const visitId = parseInt(req.params.id);
    const vRes = await pool.query('DELETE FROM visits WHERE id = $1 RETURNING customer_id', [visitId]);
    if (vRes.rowCount > 0) {
      const s = await getSettings();
      await recalculateTier(vRes.rows[0].customer_id, s);
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete visit' });
  }
});

app.put('/api/admin/visits/:id/spend', adminLimiter, checkAdmin, async (req, res) => {
  try {
    const visitId = parseInt(req.params.id);
    const { spend } = req.body;
    if (typeof spend !== 'number') return res.status(400).json({ error: 'Invalid spend' });

    const vRes = await pool.query('UPDATE visits SET spend = $1 WHERE id = $2 RETURNING customer_id', [spend, visitId]);
    if (vRes.rowCount > 0) {
      const s = await getSettings();
      await recalculateTier(vRes.rows[0].customer_id, s);
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update visit' });
  }
});

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key-123';

cron.schedule('0 12 * * *', async () => {
  try {
    const s = await getSettings();
    const rs = await pool.query(`
        SELECT c.email, c.name, c.current_tier, MAX(v.visited_at) as last
        FROM customers c JOIN visits v ON c.id = v.customer_id
        WHERE c.current_tier != 'none' AND c.marketing_consent = TRUE
        GROUP BY c.id, c.email, c.name, c.current_tier
        HAVING MAX(v.visited_at) < NOW() - INTERVAL '60 days'
      `);
    for (const r of rs.rows) {
      const discount = tierDiscount(r.current_tier, s, false);
      await sendReactivationEmail(r.email, r.name, r.current_tier, discount, s.restaurant_name);
    }
    console.log(`[CRON] Sent ${rs.rowCount} reactivation emails.`);
  } catch (e) { console.error('[CRON] Reactivation error:', e.message); }
});

cron.schedule('0 10 1 * *', async () => {
  try {
    const s = await getSettings();
    const rs = await pool.query(`
        SELECT c.email, c.name, c.current_tier,
          COALESCE(SUM(CASE WHEN v.visited_at >= NOW() - INTERVAL '90 days' THEN v.spend ELSE 0 END), 0) as s90
        FROM customers c JOIN visits v ON c.id = v.customer_id
        WHERE v.visited_at >= NOW() - INTERVAL '90 days' AND c.marketing_consent = TRUE
        GROUP BY c.id, c.email, c.name, c.current_tier
      `);
    for (const r of rs.rows) {
      const discount = tierDiscount(r.current_tier, s, false);
      await sendMonthlyEmail(r.email, r.name, r.current_tier, r.s90, discount, s.restaurant_name);
    }
    console.log(`[CRON] Sent ${rs.rowCount} monthly status emails.`);
  } catch (e) { console.error('[CRON] Monthly error:', e.message); }
});

// ====== Data Cleanup: Delete records older than 90 days ======
cron.schedule('0 3 * * *', async () => {
  try {
    // Step 1: Delete visits older than 90 days
    const deleted = await pool.query(
      `DELETE FROM visits WHERE visited_at < NOW() - INTERVAL '90 days' RETURNING id`
    );
    console.log(`[CRON CLEANUP] Deleted ${deleted.rowCount} visits older than 90 days.`);

    // Step 2: Remove customers who now have zero visits remaining
    const orphaned = await pool.query(
      `DELETE FROM customers WHERE id NOT IN (SELECT DISTINCT customer_id FROM visits) RETURNING email`
    );
    console.log(`[CRON CLEANUP] Removed ${orphaned.rowCount} inactive customers with no recent visits.`);
  } catch (e) {
    console.error('[CRON CLEANUP] Error:', e.message);
  }
});

// ====== Unsubscribe Endpoints ======

app.post('/api/unsubscribe', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Missing token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.action !== 'unsubscribe') return res.status(400).json({ error: 'Invalid token' });
    await pool.query('UPDATE customers SET unsubscribed = TRUE WHERE email = $1', [payload.email]);
    res.json({ success: true, email: payload.email });
  } catch (err) {
    res.status(400).json({ error: 'Invalid or expired link' });
  }
});

app.post('/api/resubscribe', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Missing token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.action !== 'unsubscribe') return res.status(400).json({ error: 'Invalid token' });
    await pool.query('UPDATE customers SET unsubscribed = FALSE WHERE email = $1', [payload.email]);
    res.json({ success: true, email: payload.email });
  } catch (err) {
    res.status(400).json({ error: 'Invalid or expired link' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
