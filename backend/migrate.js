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
    admin_pin TEXT DEFAULT '1234',
    bronze_threshold REAL DEFAULT 300,
    silver_threshold REAL DEFAULT 600,
    gold_threshold REAL DEFAULT 1000,
    vip_threshold REAL DEFAULT 2000,
    discount_new REAL DEFAULT 10,
    discount_bronze REAL DEFAULT 10,
    discount_silver REAL DEFAULT 15,
    discount_gold REAL DEFAULT 20,
    discount_vip REAL DEFAULT 25,
    retention_days INTEGER DEFAULT 14,
    retention_discount REAL DEFAULT 10,
    frequency_visits INTEGER DEFAULT 3,
    frequency_days INTEGER DEFAULT 60,
    frequency_discount REAL DEFAULT 10
  )`);

  // Ensure 1 row exists
  db.run(`INSERT OR IGNORE INTO settings (id) VALUES (1)`);

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
