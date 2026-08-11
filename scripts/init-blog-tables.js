/**
 * Manually create blog tables on any PostgreSQL (local or Hostinger).
 * Usage on server:
 *   node scripts/init-blog-tables.js
 *
 * Uses the same CognicodePool env vars as the API.
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

async function main() {
  const pool = require("../routes/CognicodePool");
  // Re-run the same init as routes/blog.js
  const blog = require("../routes/blog");
  // blog module auto-inits on require; also call export if present
  if (typeof blog.initializeBlogDB === "function") {
    await blog.initializeBlogDB();
  } else {
    // Wait a moment for auto-init on require
    await new Promise((r) => setTimeout(r, 2000));
  }

  const tables = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name LIKE 'blog_%'
    ORDER BY table_name
  `);
  console.log(
    "Blog tables:",
    tables.rows.map((r) => r.table_name).join(", ") || "(none)"
  );
  await pool.end();
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
