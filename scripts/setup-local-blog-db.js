/**
 * Ensure local PostgreSQL databases exist and blog schema is ready.
 * Usage: node scripts/setup-local-blog-db.js
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { Pool } = require("pg");

const host = process.env.PG_HOST || "localhost";
const port = Number(process.env.PG_PORT) || 5432;
const user = process.env.PG_USER || "postgres";
const password = process.env.PG_PASSWORD;
const mainDb = process.env.PG_DATABASE || "Project_Management_System_CogniCode";
const cognicodeDb = process.env.PG_COGNICODE_DATABASE || "Cognicode";

function basePool(database) {
  return new Pool({
    host,
    port,
    user,
    password,
    database,
    ssl: false,
    connectionTimeoutMillis: 8000,
  });
}

async function ensureDatabase(adminPool, dbName) {
  const check = await adminPool.query(
    "SELECT 1 FROM pg_database WHERE datname = $1",
    [dbName]
  );
  if (check.rowCount > 0) {
    console.log(`✔ Database already exists: ${dbName}`);
    return;
  }
  // CREATE DATABASE cannot run inside a transaction; identifiers only
  const safe = dbName.replace(/"/g, '""');
  await adminPool.query(`CREATE DATABASE "${safe}"`);
  console.log(`✔ Created database: ${dbName}`);
}

async function ensureBlogSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS blog_categories (
      id SERIAL PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      slug VARCHAR(140) NOT NULL UNIQUE,
      description TEXT,
      service_href VARCHAR(255),
      service_label VARCHAR(160),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS blog_posts (
      id SERIAL PRIMARY KEY,
      slug VARCHAR(220) NOT NULL UNIQUE,
      title VARCHAR(320) NOT NULL,
      excerpt TEXT,
      meta_description TEXT,
      content JSONB DEFAULT '[]'::jsonb,
      key_takeaways JSONB DEFAULT '[]'::jsonb,
      category_slug VARCHAR(140) REFERENCES blog_categories(slug) ON UPDATE CASCADE ON DELETE SET NULL,
      author_name VARCHAR(160),
      author_role VARCHAR(160),
      author_bio TEXT,
      author_initials VARCHAR(8),
      cover_image TEXT,
      cover_video TEXT,
      youtube_url TEXT,
      media_gallery JSONB DEFAULT '[]'::jsonb,
      likes INTEGER DEFAULT 0,
      image_label VARCHAR(120),
      image_gradient VARCHAR(255),
      keywords JSONB DEFAULT '[]'::jsonb,
      read_time VARCHAR(40) DEFAULT '5 min read',
      status VARCHAR(20) NOT NULL DEFAULT 'draft',
      featured BOOLEAN DEFAULT FALSE,
      resource JSONB,
      service_cta JSONB,
      published_at TIMESTAMP,
      created_by INTEGER,
      updated_by INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS blog_media (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) NOT NULL,
      original_name VARCHAR(255),
      mime_type VARCHAR(120),
      media_type VARCHAR(40) NOT NULL DEFAULT 'file',
      size_bytes BIGINT,
      url TEXT NOT NULL,
      alt_text TEXT,
      uploaded_by INTEGER,
      post_id INTEGER REFERENCES blog_posts(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS blog_resources (
      id SERIAL PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      resource_type VARCHAR(40) DEFAULT 'PDF',
      category_slug VARCHAR(140),
      file_url TEXT,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS blog_subscribers (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) NOT NULL UNIQUE,
      source VARCHAR(120),
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS "admindetails" (
      "adminId" SERIAL PRIMARY KEY,
      "name" VARCHAR(100) NOT NULL,
      "email" VARCHAR(150) UNIQUE NOT NULL,
      "password" TEXT NOT NULL,
      "updated_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_blog_posts_status ON blog_posts(status);
    CREATE INDEX IF NOT EXISTS idx_blog_posts_category ON blog_posts(category_slug);
    CREATE INDEX IF NOT EXISTS idx_blog_posts_featured ON blog_posts(featured);
    CREATE INDEX IF NOT EXISTS idx_blog_media_type ON blog_media(media_type);
  `);

  // Seed categories
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM blog_categories`
  );
  if (rows[0].count === 0) {
    const defaults = [
      ["Thesis Writing", "thesis-writing", "Chapter guidance and thesis structure.", "/services/phd-thesis-writing", "Thesis Writing Support"],
      ["Literature Review", "literature-review", "Search strategies and gap identification.", "/services/literature-review", "Literature Review Service"],
      ["Data Analysis", "data-analysis", "SPSS, R, Python for thesis results.", "/services/statistical-analysis-data-analytics", "Data Analysis Support"],
      ["Academic Publishing", "academic-publishing", "Journal selection and peer review.", "/services/publishing", "Publishing Support"],
      ["Research Integrity", "research-integrity", "Originality, citations, ethical AI use.", "/services/plagiarism-removal", "Integrity Support"],
      ["AI/ML", "ai-ml", "Machine learning for academic research.", "/services/ai-ml", "AI/ML Research Support"],
      ["Scholar Success", "scholar-success", "Motivation, viva, and time systems.", "/contact", "Talk to a Mentor"],
    ];
    for (const row of defaults) {
      await pool.query(
        `INSERT INTO blog_categories (name, slug, description, service_href, service_label)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (slug) DO NOTHING`,
        row
      );
    }
    console.log("✔ Seeded blog categories");
  } else {
    console.log(`✔ Blog categories present (${rows[0].count})`);
  }

  // Ensure admin user if env present
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD && process.env.ADMIN_NAME) {
    const bcrypt = require("bcryptjs");
    const hashed = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
    await pool.query(
      `INSERT INTO "admindetails" ("name", "email", "password")
       VALUES ($1, $2, $3)
       ON CONFLICT ("email") DO NOTHING`,
      [process.env.ADMIN_NAME, process.env.ADMIN_EMAIL, hashed]
    );
    console.log("✔ Admin user ensured:", process.env.ADMIN_EMAIL);
  }

  const tables = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name LIKE 'blog_%'
    ORDER BY table_name
  `);
  console.log(
    "✔ Blog tables:",
    tables.rows.map((r) => r.table_name).join(", ")
  );
}

async function main() {
  console.log("=== Local PostgreSQL blog setup ===");
  console.log({ host, port, user, mainDb, cognicodeDb, passwordLen: (password || "").length });

  if (!password && password !== "") {
    console.error("PG_PASSWORD is empty in .env — set it to your local postgres password.");
  }

  const adminPool = basePool("postgres");
  try {
    const ping = await adminPool.query("SELECT current_user, now()");
    console.log("✔ Connected as", ping.rows[0].current_user, "at", ping.rows[0].now);

    await ensureDatabase(adminPool, mainDb);
    await ensureDatabase(adminPool, cognicodeDb);
  } catch (err) {
    console.error("❌ Could not connect to local PostgreSQL:", err.message);
    console.error("Tips:");
    console.error("  1) Service postgresql-x64-17 should be Running");
    console.error("  2) PG_USER / PG_PASSWORD in .env must match local superuser");
    console.error("  3) Try resetting postgres password if needed");
    process.exitCode = 1;
    await adminPool.end().catch(() => {});
    return;
  } finally {
    await adminPool.end().catch(() => {});
  }

  const cognicodePool = basePool(cognicodeDb);
  try {
    await ensureBlogSchema(cognicodePool);
    console.log("=== Blog database ready on local PostgreSQL ===");
  } catch (err) {
    console.error("❌ Blog schema setup failed:", err.message);
    process.exitCode = 1;
  } finally {
    await cognicodePool.end().catch(() => {});
  }
}

main();
