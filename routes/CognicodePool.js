// CognicodePool.js
const { Pool } = require('pg');
require("dotenv").config();

/**
 * SSL only when explicitly enabled AND host is not local.
 * Local Postgres rarely supports SSL; NODE_ENV=production alone must not force SSL.
 */
function resolveSsl() {
  const host = String(process.env.PG_HOST || 'localhost').toLowerCase();
  const isLocal =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.endsWith('.local');

  if (isLocal) return false;

  // Explicit override: PG_SSL=true|false|require
  const flag = String(process.env.PG_SSL || '').toLowerCase();
  if (flag === 'false' || flag === '0' || flag === 'disable') return false;
  if (flag === 'true' || flag === '1' || flag === 'require') {
    return { rejectUnauthorized: false };
  }

  // Remote hosts in production default to SSL
  if (process.env.NODE_ENV === 'production') {
    return { rejectUnauthorized: false };
  }

  return false;
}

const cognicodePool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: Number(process.env.PG_PORT) || 5432,
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD,
  database: process.env.PG_COGNICODE_DATABASE || 'Cognicode',
  ssl: resolveSsl(),
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

cognicodePool.on('connect', () => {
  console.log(
    `✅ Connected to Cognicode database (${process.env.PG_COGNICODE_DATABASE || 'Cognicode'} @ ${process.env.PG_HOST || 'localhost'})`
  );
});

cognicodePool.on('error', (err) => {
  console.error('❌ Unexpected error on Cognicode idle client', err.message);
});

module.exports = cognicodePool;