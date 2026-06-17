// require('dotenv').config();
// const { Pool } = require('pg');

// // Define poolConfig (this was missing – fixes ReferenceError)
// const poolConfig = process.env.NODE_ENV === 'production' || process.env.PG_EXTERNAL_DB
//   ? { connectionString: process.env.PG_EXTERNAL_DB }  // Auto-SSL via ?sslmode=require
//   : {
//       host: process.env.PG_HOST,
//       user: process.env.PG_USER,
//       password: process.env.PG_PASSWORD,
//       database: process.env.PG_DATABASE,
//       port: process.env.PG_PORT,
//       ssl: { rejectUnauthorized: false }  // Secure but allows Render certs
//     };

// const pgPool = new Pool({ 
//   ...poolConfig, 
//   max: 10, 
//   idleTimeoutMillis: 30000, 
//   connectionTimeoutMillis: 10000  // Timeouts to avoid hangs
// });

// pgPool.on('error', (err) => {
//   console.error('Unexpected error on idle client:', err);
// });

// // Startup test with full error logging
// pgPool.query('SELECT NOW()')
//   .then((res) => console.log('✅ PG Pool connected to Render DB:', res.rows[0].now))
//   .catch((err) => {
//     console.error('❌ PG Pool failed - Full Error:', {
//       code: err.code,
//       message: err.message,
//       errno: err.errno,
//       host: process.env.PG_HOST || 'Not set',  // Debug: Shows current host
//       env: process.env.NODE_ENV || 'Not set'
//     });
//   });

// module.exports = pgPool;

require('dotenv').config();
const { Pool } = require('pg');

const pgPool = new Pool({
  host: process.env.PG_HOST,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE,
  port: process.env.PG_PORT,
  ssl: false
});

pgPool.on('error', (err) => {
  console.error('Unexpected error on idle client:', err);
});

pgPool.query('SELECT NOW()')
  .then((res) => console.log('✅ PG Pool connected:', res.rows[0].now))
  .catch((err) => {
    console.error('❌ PG Pool failed:', err.message);
  });

module.exports = pgPool;