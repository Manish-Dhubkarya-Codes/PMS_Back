// CognicodePool.js — Cognicode / blog database pool (local + Hostinger)
const { Pool } = require("pg");
require("dotenv").config();

/**
 * SSL rules:
 * - localhost / 127.0.0.1 → never SSL (local Postgres)
 * - PG_SSL=false|disable → never SSL
 * - PG_SSL=true|require → SSL (Hostinger / managed PG)
 * - remote host + production → SSL by default
 */
function resolveSsl() {
  const host = String(process.env.PG_HOST || "localhost").toLowerCase();
  const isLocal =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.endsWith(".local");

  if (isLocal) return false;

  const flag = String(process.env.PG_SSL || "").toLowerCase().trim();
  if (flag === "false" || flag === "0" || flag === "disable" || flag === "off") {
    return false;
  }
  if (flag === "true" || flag === "1" || flag === "require" || flag === "on") {
    return { rejectUnauthorized: false };
  }

  // Remote Hostinger / cloud PG in production
  if (process.env.NODE_ENV === "production") {
    return { rejectUnauthorized: false };
  }

  // Remote host even in non-production: prefer SSL (Hostinger often requires it)
  return { rejectUnauthorized: false };
}

const poolConfig = {
  host: process.env.PG_HOST || "localhost",
  port: Number(process.env.PG_PORT) || 5432,
  user: process.env.PG_USER || "postgres",
  password: process.env.PG_PASSWORD,
  database: process.env.PG_COGNICODE_DATABASE || "Cognicode",
  ssl: resolveSsl(),
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 20000,
};

const cognicodePool = new Pool(poolConfig);

cognicodePool.on("connect", () => {
  console.log(
    `✅ CognicodePool connected → db=${poolConfig.database} host=${poolConfig.host} port=${poolConfig.port} ssl=${Boolean(poolConfig.ssl)}`
  );
});

cognicodePool.on("error", (err) => {
  console.error("❌ CognicodePool idle client error:", err.message);
});

/** One-shot connectivity + version check (used by init / health) */
cognicodePool
  .query("SELECT current_database() AS db, current_user AS usr, version() AS v")
  .then((res) => {
    const row = res.rows[0];
    console.log(
      `✅ CognicodePool ready → database="${row.db}" user="${row.usr}"`
    );
  })
  .catch((err) => {
    console.error(
      "❌ CognicodePool initial query failed:",
      err.message,
      "\n   Check PG_HOST / PG_PORT / PG_USER / PG_PASSWORD / PG_COGNICODE_DATABASE / PG_SSL on the server."
    );
  });

module.exports = cognicodePool;
