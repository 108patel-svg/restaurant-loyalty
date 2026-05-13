const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'loyalty.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  // Settings Table
  db.run(`CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    restaurant_name TEXT DEFAULT 'The Restaurant',
    restaurant_email TEXT,
    restaurant_address TEXT,
    restaurant_logo TEXT,
    admin_pin TEXT DEFAULT '1234',

    -- Feature Toggles
    enable_tiers BOOLEAN DEFAULT 1,
    enable_milestones BOOLEAN DEFAULT 1,
    enable_bonus BOOLEAN DEFAULT 1,
    enable_discounts BOOLEAN DEFAULT 1,
    enable_freebies BOOLEAN DEFAULT 1,
    enable_retention BOOLEAN DEFAULT 1,
    enable_frequency BOOLEAN DEFAULT 1,

    -- Thresholds
    bronze_threshold REAL DEFAULT 300,
    silver_threshold REAL DEFAULT 600,
    gold_threshold REAL DEFAULT 1000,
    vip_threshold REAL DEFAULT 2000,

    -- Discounts
    discount_new REAL DEFAULT 10,
    discount_bronze REAL DEFAULT 10,
    discount_silver REAL DEFAULT 15,
    discount_gold REAL DEFAULT 20,
    discount_vip REAL DEFAULT 25,

    -- Freebies
    freebie_bronze TEXT,
    freebie_silver TEXT,
    freebie_gold TEXT,
    freebie_vip TEXT,

    -- Retention Bonus
    retention_days INTEGER DEFAULT 14,
    retention_discount REAL DEFAULT 10,
    retention_freebie TEXT,

    -- Frequency Bonus
    frequency_visits INTEGER DEFAULT 3,
    frequency_days INTEGER DEFAULT 60,
    frequency_discount REAL DEFAULT 10,
    frequency_freebie TEXT,

    -- Milestones
    milestone_visits INTEGER DEFAULT 5,
    milestone_reward TEXT DEFAULT 'Free Coffee',

    -- Email Templates
    email_welcome_subject TEXT DEFAULT 'Welcome to {restaurant} Rewards!',
    email_welcome_body TEXT DEFAULT 'Hello {name}, thanks for joining! Visit us soon to earn rewards.',
    
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

  // Ensure 1 row exists
  db.run(`INSERT OR IGNORE INTO settings (id) VALUES (1)`);

  // Helper to add missing columns (for existing databases)
  const addCol = (col, type, def) => {
    db.run(`ALTER TABLE settings ADD COLUMN ${col} ${type} DEFAULT ${def}`, (err) => {
      if (err && !err.message.includes('duplicate column name')) {
        // Silently ignore if column already exists
      }
    });
  };

  addCol('restaurant_logo', 'TEXT', 'NULL');
  addCol('enable_tiers', 'BOOLEAN', '1');
  addCol('enable_milestones', 'BOOLEAN', '1');
  addCol('enable_bonus', 'BOOLEAN', '1');
  addCol('enable_discounts', 'BOOLEAN', '1');
  addCol('enable_freebies', 'BOOLEAN', '1');
  addCol('enable_retention', 'BOOLEAN', '1');
  addCol('enable_frequency', 'BOOLEAN', '1');
  addCol('freebie_bronze', 'TEXT', 'NULL');
  addCol('freebie_silver', 'TEXT', 'NULL');
  addCol('freebie_gold', 'TEXT', 'NULL');
  addCol('freebie_vip', 'TEXT', 'NULL');
  addCol('retention_freebie', 'TEXT', 'NULL');
  addCol('frequency_freebie', 'TEXT', 'NULL');
  addCol('milestone_visits', 'INTEGER', '5');
  addCol('milestone_reward', 'TEXT', "'Free Coffee'");
  addCol('email_welcome_subject', 'TEXT', "'Welcome to {restaurant} Rewards!'");
  addCol('email_welcome_body', 'TEXT', "'Hello {name}, thanks for joining!'");
  addCol('email_milestone_subject', 'TEXT', "'You earned a milestone reward!'");
  addCol('email_milestone_body', 'TEXT', "'Congrats {name}! You hit {reward}.'");
  addCol('email_bronze_subject', 'TEXT', "'You reached Bronze status!'");
  addCol('email_bronze_body', 'TEXT', "'Nice work {name}, you are now Bronze.'");
  addCol('email_silver_subject', 'TEXT', "'You reached Silver status!'");
  addCol('email_silver_body', 'TEXT', "'Amazing {name}, you are now Silver.'");
  addCol('email_gold_subject', 'TEXT', "'You reached Gold status!'");
  addCol('email_gold_body', 'TEXT', "'Fantastic {name}, you are now Gold.'");
  addCol('email_vip_subject', 'TEXT', "'You reached VIP status!'");
  addCol('email_vip_body', 'TEXT', "'Incredible {name}, you are now VIP!'");
  addCol('email_retention_subject', 'TEXT', "'We miss you!'");
  addCol('email_retention_body', 'TEXT', "'Hi {name}, come back and get {reward}!'");
  addCol('email_frequency_subject', 'TEXT', "'Thanks for being a regular!'");
  addCol('email_frequency_body', 'TEXT', "'Hi {name}, here is a reward for your frequent visits: {reward}!'");

  // Customers Table
  db.run(`CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    phone TEXT,
    current_tier TEXT DEFAULT 'none',
    marketing_consent BOOLEAN DEFAULT 0,
    consent_date DATETIME,
    consent_ip TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Visits Table
  db.run(`CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER,
    spend REAL DEFAULT 0,
    visited_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES customers (id)
  )`);

  // Audit Log Table
  db.run(`CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    details TEXT,
    performed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  console.log('Database migrated successfully.');
});

db.close();
