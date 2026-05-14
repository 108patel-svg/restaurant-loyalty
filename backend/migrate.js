const sqlite3 = require('sqlite3').verbose();
const { Pool } = require('pg');
const path = require('path');

const isProd = !!process.env.DATABASE_URL;

async function migrate() {
  if (isProd) {
    console.log('Migrating PostgreSQL database...');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });

    const run = (sql) => pool.query(sql);

    try {
      // Settings Table
      await run(`CREATE TABLE IF NOT EXISTS settings (
        id SERIAL PRIMARY KEY,
        restaurant_name TEXT DEFAULT 'The Restaurant',
        restaurant_email TEXT,
        restaurant_address TEXT,
        restaurant_logo TEXT,
        admin_pin TEXT DEFAULT '1234',
        enable_tiers BOOLEAN DEFAULT true,
        enable_milestones BOOLEAN DEFAULT true,
        enable_bonus BOOLEAN DEFAULT true,
        enable_discounts BOOLEAN DEFAULT true,
        enable_freebies BOOLEAN DEFAULT true,
        enable_retention BOOLEAN DEFAULT true,
        enable_frequency BOOLEAN DEFAULT true,
        bronze_threshold REAL DEFAULT 300,
        silver_threshold REAL DEFAULT 600,
        gold_threshold REAL DEFAULT 1000,
        vip_threshold REAL DEFAULT 2000,
        tier_metric TEXT DEFAULT 'spend',
        enable_points BOOLEAN DEFAULT false,
        points_threshold INTEGER DEFAULT 100,
        points_discount REAL DEFAULT 10,
        points_freebie TEXT,
        discount_new REAL DEFAULT 10,
        discount_bronze REAL DEFAULT 10,
        discount_silver REAL DEFAULT 15,
        discount_gold REAL DEFAULT 20,
        discount_vip REAL DEFAULT 25,
        freebie_bronze TEXT,
        freebie_silver TEXT,
        freebie_gold TEXT,
        freebie_vip TEXT,
        retention_days INTEGER DEFAULT 14,
        retention_discount REAL DEFAULT 10,
        retention_freebie TEXT,
        frequency_visits INTEGER DEFAULT 3,
        frequency_days INTEGER DEFAULT 60,
        frequency_discount REAL DEFAULT 10,
        frequency_freebie TEXT,
        milestone_visits INTEGER DEFAULT 5,
        milestone_reward TEXT DEFAULT 'Free Coffee',
        email_welcome_subject TEXT DEFAULT 'Welcome to {restaurant} Rewards!',
        email_welcome_body TEXT DEFAULT 'Hello {name}, thanks for joining!',
        email_milestone_subject TEXT DEFAULT 'You earned a milestone reward!',
        email_milestone_body TEXT DEFAULT 'Congrats {name}! You hit {reward}.',
        email_bronze_subject TEXT DEFAULT 'You reached Bronze status!',
        email_bronze_body TEXT DEFAULT 'Nice work {name}, you are now Bronze.',
        email_silver_subject TEXT DEFAULT 'You reached Silver status!',
        email_silver_body TEXT DEFAULT 'Amazing {name}, you are now Silver.',
        email_gold_subject TEXT DEFAULT 'You reached Gold status!',
        email_gold_body TEXT DEFAULT 'Fantastic {name}, you are now Gold.',
        email_vip_subject TEXT DEFAULT 'You reached VIP status!',
        email_vip_body TEXT DEFAULT 'Incredible {name}, you are now VIP!',
        email_retention_subject TEXT DEFAULT 'We miss you!',
        email_retention_body TEXT DEFAULT 'Hi {name}, come back and get {reward}!',
        email_frequency_subject TEXT DEFAULT 'Thanks for being a regular!',
        email_frequency_body TEXT DEFAULT 'Hi {name}, here is a reward for your frequent visits: {reward}!'
      )`);

      // Helper to add missing columns (essential for existing databases)
      const cols = [
        ['admin_pin', 'TEXT'], ['restaurant_logo', 'TEXT'], ['restaurant_email', 'TEXT'], ['restaurant_address', 'TEXT'],
        ['enable_tiers', 'BOOLEAN'], ['enable_milestones', 'BOOLEAN'],
        ['enable_bonus', 'BOOLEAN'], ['enable_discounts', 'BOOLEAN'], ['enable_freebies', 'BOOLEAN'],
        ['enable_retention', 'BOOLEAN'], ['enable_frequency', 'BOOLEAN'], 
        ['tier_metric', 'TEXT'], ['enable_points', 'BOOLEAN'], ['points_threshold', 'INTEGER'],
        ['points_discount', 'REAL'], ['points_freebie', 'TEXT'],
        ['bronze_threshold', 'REAL'], ['silver_threshold', 'REAL'], ['gold_threshold', 'REAL'], ['vip_threshold', 'REAL'],
        ['discount_new', 'REAL'], ['discount_bronze', 'REAL'], ['discount_silver', 'REAL'], ['discount_gold', 'REAL'], ['discount_vip', 'REAL'],
        ['freebie_bronze', 'TEXT'], ['freebie_silver', 'TEXT'], ['freebie_gold', 'TEXT'], ['freebie_vip', 'TEXT'],
        ['retention_days', 'INTEGER'], ['retention_discount', 'REAL'], ['retention_freebie', 'TEXT'],
        ['frequency_visits', 'INTEGER'], ['frequency_days', 'INTEGER'], ['frequency_discount', 'REAL'], ['frequency_freebie', 'TEXT'],
        ['milestone_visits', 'INTEGER'], ['milestone_reward', 'TEXT'], 
        ['email_welcome_subject', 'TEXT'], ['email_welcome_body', 'TEXT'],
        ['email_milestone_subject', 'TEXT'], ['email_milestone_body', 'TEXT'], ['email_bronze_subject', 'TEXT'],
        ['email_bronze_body', 'TEXT'], ['email_silver_subject', 'TEXT'], ['email_silver_body', 'TEXT'],
        ['email_gold_subject', 'TEXT'], ['email_gold_body', 'TEXT'], ['email_vip_subject', 'TEXT'],
        ['email_vip_body', 'TEXT'], ['email_retention_subject', 'TEXT'], ['email_retention_body', 'TEXT'],
        ['email_frequency_subject', 'TEXT'], ['email_frequency_body', 'TEXT']
      ];

      for (const [col, type] of cols) {
        try {
          await run(`ALTER TABLE settings ADD COLUMN ${col} ${type}`);
        } catch (e) { 
          // Silently ignore "already exists" errors
        }
      }

      // Customers Table
      await run(`CREATE TABLE IF NOT EXISTS customers (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        phone TEXT,
        current_tier TEXT DEFAULT 'none',
        points_balance REAL DEFAULT 0,
        marketing_consent BOOLEAN DEFAULT false,
        consent_date TIMESTAMPTZ,
        consent_ip TEXT,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )`);

      // Visits Table
      await run(`CREATE TABLE IF NOT EXISTS visits (
        id SERIAL PRIMARY KEY,
        customer_id INTEGER REFERENCES customers(id),
        spend REAL DEFAULT 0,
        visited_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )`);

      // Audit Log Table
      await run(`CREATE TABLE IF NOT EXISTS audit_log (
        id SERIAL PRIMARY KEY,
        action TEXT NOT NULL,
        details TEXT,
        performed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )`);

      // Now it is safe to insert/update row 1
      await run(`INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET admin_pin = '1234'`);

      console.log('PostgreSQL migration complete.');
      await pool.end();
    } catch (err) {
      console.error('PostgreSQL migration failed:', err.message);
      process.exit(1);
    }
  } else {
    console.log('Migrating SQLite database...');
    const dbPath = path.join(__dirname, 'loyalty.db');
    const db = new sqlite3.Database(dbPath);

    db.serialize(() => {
      db.run(`CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        restaurant_name TEXT DEFAULT 'The Restaurant',
        restaurant_email TEXT, restaurant_address TEXT, restaurant_logo TEXT,
        admin_pin TEXT DEFAULT '1234',
        enable_tiers BOOLEAN DEFAULT 1, enable_milestones BOOLEAN DEFAULT 1, enable_bonus BOOLEAN DEFAULT 1,
        enable_discounts BOOLEAN DEFAULT 1, enable_freebies BOOLEAN DEFAULT 1,
        enable_retention BOOLEAN DEFAULT 1, enable_frequency BOOLEAN DEFAULT 1,
        bronze_threshold REAL DEFAULT 300, silver_threshold REAL DEFAULT 600,
        gold_threshold REAL DEFAULT 1000, vip_threshold REAL DEFAULT 2000,
        tier_metric TEXT DEFAULT 'spend',
        enable_points BOOLEAN DEFAULT 0, points_threshold INTEGER DEFAULT 100,
        points_discount REAL DEFAULT 10, points_freebie TEXT,
        discount_new REAL DEFAULT 10, discount_bronze REAL DEFAULT 10,
        discount_silver REAL DEFAULT 15, discount_gold REAL DEFAULT 20, discount_vip REAL DEFAULT 25,
        freebie_bronze TEXT, freebie_silver TEXT, freebie_gold TEXT, freebie_vip TEXT,
        retention_days INTEGER DEFAULT 14, retention_discount REAL DEFAULT 10, retention_freebie TEXT,
        frequency_visits INTEGER DEFAULT 3, frequency_days INTEGER DEFAULT 60,
        frequency_discount REAL DEFAULT 10, frequency_freebie TEXT,
        milestone_visits INTEGER DEFAULT 5, milestone_reward TEXT DEFAULT 'Free Coffee',
        email_welcome_subject TEXT, email_welcome_body TEXT,
        email_milestone_subject TEXT, email_milestone_body TEXT,
        email_bronze_subject TEXT, email_bronze_body TEXT,
        email_silver_subject TEXT, email_silver_body TEXT,
        email_gold_subject TEXT, email_gold_body TEXT,
        email_vip_subject TEXT, email_vip_body TEXT,
        email_retention_subject TEXT, email_retention_body TEXT,
        email_frequency_subject TEXT, email_frequency_body TEXT
      )`);

      db.run(`INSERT OR IGNORE INTO settings (id) VALUES (1)`);
      db.run(`UPDATE settings SET admin_pin = '1234' WHERE id = 1`);

      const addCol = (col, type) => {
        db.run(`ALTER TABLE settings ADD COLUMN ${col} ${type}`, (err) => {});
      };
      // Ensure all possible columns exist
      const cols = ['restaurant_logo', 'enable_tiers', 'enable_milestones', 'enable_bonus', 'enable_discounts', 'enable_freebies', 'enable_retention', 'enable_frequency', 'tier_metric', 'enable_points', 'points_threshold', 'points_discount', 'points_freebie', 'freebie_bronze', 'freebie_silver', 'freebie_gold', 'freebie_vip', 'retention_freebie', 'frequency_freebie', 'milestone_visits', 'milestone_reward', 'email_welcome_subject', 'email_welcome_body', 'email_milestone_subject', 'email_milestone_body', 'email_bronze_subject', 'email_bronze_body', 'email_silver_subject', 'email_silver_body', 'email_gold_subject', 'email_gold_body', 'email_vip_subject', 'email_vip_body', 'email_retention_subject', 'email_retention_body', 'email_frequency_subject', 'email_frequency_body'];
      cols.forEach(c => addCol(c, 'TEXT'));

      db.run(`CREATE TABLE IF NOT EXISTS customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, phone TEXT,
        current_tier TEXT DEFAULT 'none', points_balance REAL DEFAULT 0, marketing_consent BOOLEAN DEFAULT 0,
        consent_date DATETIME, consent_ip TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
      db.run(`CREATE TABLE IF NOT EXISTS visits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER, spend REAL DEFAULT 0, visited_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (customer_id) REFERENCES customers (id)
      )`);
      db.run(`CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, details TEXT, performed_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);

      console.log('SQLite migration complete.');
      db.close();
    });
  }
}

module.exports = migrate;

if (require.main === module) {
  migrate().then(() => {
    console.log('Migration complete');
  }).catch(err => {
    console.error('Migration failed:', err);
  });
}
