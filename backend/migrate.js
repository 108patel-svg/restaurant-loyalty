require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

async function migrate() {
    try {
        await pool.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        current_tier TEXT NOT NULL DEFAULT 'none',
        unsubscribed BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

        // For existing databases: add the column if it doesn't exist yet
        await pool.query(`
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS unsubscribed BOOLEAN NOT NULL DEFAULT FALSE;
    `);

        await pool.query(`
      CREATE TABLE IF NOT EXISTS visits (
        id SERIAL PRIMARY KEY,
        customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        spend NUMERIC(10,2) NOT NULL,
        visited_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

        await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_visits_customer_id ON visits(customer_id);
      CREATE INDEX IF NOT EXISTS idx_visits_visited_at ON visits(visited_at);
      CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email);
    `);

        await pool.query(`
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY DEFAULT 1,
        restaurant_name TEXT DEFAULT 'The Restaurant',
        bronze_threshold NUMERIC DEFAULT 300,
        silver_threshold NUMERIC DEFAULT 600,
        gold_threshold NUMERIC DEFAULT 1000,
        vip_threshold NUMERIC DEFAULT 2000,
        discount_new NUMERIC DEFAULT 10,
        discount_bronze NUMERIC DEFAULT 10,
        discount_silver NUMERIC DEFAULT 15,
        discount_gold NUMERIC DEFAULT 20,
        discount_vip NUMERIC DEFAULT 25
      );
    `);

        await pool.query(`
      INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
    `);

        console.log("✓ Tables created");
    } catch (err) {
        console.error("Migration failed:", err);
    } finally {
        pool.end();
    }
}

migrate();
