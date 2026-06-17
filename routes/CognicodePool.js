// CognicodePool.js
const { Pool } = require('pg');
require("dotenv").config();

const cognicodePool = new Pool({
  host: process.env.PG_HOST,
  port: process.env.PG_PORT,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  database: process.env.PG_COGNICODE_DATABASE,   // ← Points to new DB
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

cognicodePool.on('connect', () => {
  console.log('✅ Connected to Cognicode database');
});

cognicodePool.on('error', (err) => {
  console.error('❌ Unexpected error on Cognicode idle client', err);
});

module.exports = cognicodePool;