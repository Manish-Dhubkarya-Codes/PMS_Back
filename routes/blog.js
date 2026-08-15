/**
 * Blog API for CogniCode EduTech website
 * Public: list posts, get post, categories, resources, subscribe
 * Admin only: create/update/delete posts, upload media (images/videos/docs)
 */
const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const cognicodePool = require("./CognicodePool");
const nodemailer = require("nodemailer");
const { optionalSiteUser, optionalAdmin } = require("./site-helpers");

const subscriberMailer = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function notifyBlogSubscribers(post) {
  try {
    const result = await cognicodePool.query(
      `SELECT email FROM blog_subscribers WHERE is_active = TRUE LIMIT 500`
    );
    const emails = result.rows.map((row) => row.email).filter(Boolean);
    if (!emails.length) return;
    const href = `https://cognicodeedutech.com/blog/article/?slug=${encodeURIComponent(post.slug)}`;
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 640px; margin: auto; padding: 24px;">
        <h2 style="color:#78025F; margin-bottom: 8px;">New from CogniCode</h2>
        <h3 style="margin: 0 0 12px;">${post.title}</h3>
        <p style="color:#444; line-height:1.6;">${post.excerpt || "A new research guide is live."}</p>
        <p><a href="${href}" style="background:#78025F;color:#fff;padding:10px 16px;border-radius:999px;text-decoration:none;">Read the post</a></p>
        <p style="color:#888;font-size:12px;margin-top:24px;">You receive this because you followed CogniCode on the blog.</p>
      </div>
    `;
    await subscriberMailer.sendMail({
      from: `"CogniCode EduTech" <${process.env.SENDER_EMAIL || process.env.SMTP_USER}>`,
      bcc: emails.join(","),
      subject: `New CogniCode post: ${post.title}`,
      html,
    });
  } catch (err) {
    console.warn("Subscriber notify skipped:", err.message);
  }
}

// ======================================================
// STORAGE
// ======================================================

const blogUploadDir = path.join(__dirname, "../public/files/blog");
if (!fs.existsSync(blogUploadDir)) {
  fs.mkdirSync(blogUploadDir, { recursive: true });
}

const ALLOWED_MIME = new Set([
  // images
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/svg+xml",
  // video
  "video/mp4",
  "video/webm",
  "video/quicktime",
  // documents / lead magnets
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/zip",
  "text/plain",
]);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, blogUploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase() || "";
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 80 * 1024 * 1024, // 80MB for video assets
    files: 10,
  },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type not allowed: ${file.mimetype}`));
    }
  },
});

// ======================================================
// DB INIT (works on local Postgres + Hostinger managed PG)
// Sequential statements so one failure is easy to diagnose.
// ======================================================

async function runSql(label, sql, params) {
  try {
    await cognicodePool.query(sql, params);
    console.log(`  ✔ ${label}`);
  } catch (err) {
    console.error(`  ✖ ${label}:`, err.message);
    throw err;
  }
}

async function initializeBlogDB() {
  console.log("⏳ Blog DB init starting…");
  try {
    // Prove connection first
    const ping = await cognicodePool.query(
      "SELECT current_database() AS db, current_user AS usr"
    );
    console.log(
      `  → connected as ${ping.rows[0].usr} on database ${ping.rows[0].db}`
    );

    await runSql(
      "blog_categories",
      `CREATE TABLE IF NOT EXISTS blog_categories (
        id SERIAL PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        slug VARCHAR(140) NOT NULL UNIQUE,
        description TEXT,
        service_href VARCHAR(255),
        service_label VARCHAR(160),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`
    );

    await runSql(
      "blog_posts",
      `CREATE TABLE IF NOT EXISTS blog_posts (
        id SERIAL PRIMARY KEY,
        slug VARCHAR(220) NOT NULL UNIQUE,
        title VARCHAR(320) NOT NULL,
        excerpt TEXT,
        meta_description TEXT,
        content JSONB DEFAULT '[]'::jsonb,
        key_takeaways JSONB DEFAULT '[]'::jsonb,
        category_slug VARCHAR(140),
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
      )`
    );

    // Soft FK after both tables exist (avoids order issues on some hosts)
    try {
      await cognicodePool.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'blog_posts_category_slug_fkey'
          ) THEN
            ALTER TABLE blog_posts
              ADD CONSTRAINT blog_posts_category_slug_fkey
              FOREIGN KEY (category_slug)
              REFERENCES blog_categories(slug)
              ON UPDATE CASCADE ON DELETE SET NULL;
          END IF;
        END $$;
      `);
      console.log("  ✔ blog_posts → blog_categories FK");
    } catch (e) {
      console.warn("  ⚠ category FK skipped:", e.message);
    }

    await runSql(
      "blog_media",
      `CREATE TABLE IF NOT EXISTS blog_media (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(255) NOT NULL,
        original_name VARCHAR(255),
        mime_type VARCHAR(120),
        media_type VARCHAR(40) NOT NULL DEFAULT 'file',
        size_bytes BIGINT,
        url TEXT NOT NULL,
        alt_text TEXT,
        uploaded_by INTEGER,
        post_id INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`
    );

    await runSql(
      "blog_resources",
      `CREATE TABLE IF NOT EXISTS blog_resources (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        resource_type VARCHAR(40) DEFAULT 'PDF',
        category_slug VARCHAR(140),
        file_url TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`
    );

    await runSql(
      "blog_subscribers",
      `CREATE TABLE IF NOT EXISTS blog_subscribers (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        source VARCHAR(120),
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`
    );

    // Additive columns for DBs created before social fields existed
    const alters = [
      ["youtube_url", "ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS youtube_url TEXT"],
      ["media_gallery", "ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS media_gallery JSONB DEFAULT '[]'::jsonb"],
      ["likes", "ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS likes INTEGER DEFAULT 0"],
    ];
    for (const [label, sql] of alters) {
      try {
        await cognicodePool.query(sql);
        console.log(`  ✔ alter ${label}`);
      } catch (e) {
        console.warn(`  ⚠ alter ${label}:`, e.message);
      }
    }

    await runSql(
      "indexes",
      `CREATE INDEX IF NOT EXISTS idx_blog_posts_status ON blog_posts(status);
       CREATE INDEX IF NOT EXISTS idx_blog_posts_category ON blog_posts(category_slug);
       CREATE INDEX IF NOT EXISTS idx_blog_posts_featured ON blog_posts(featured);
       CREATE INDEX IF NOT EXISTS idx_blog_media_type ON blog_media(media_type)`
    );

    // Also ensure admindetails exists on Cognicode DB (login for website admin)
    await runSql(
      "admindetails",
      `CREATE TABLE IF NOT EXISTS "admindetails" (
        "adminId" SERIAL PRIMARY KEY,
        "name" VARCHAR(100) NOT NULL,
        "email" VARCHAR(150) UNIQUE NOT NULL,
        "password" TEXT NOT NULL,
        "updated_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`
    );

    const { rows } = await cognicodePool.query(
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
        await cognicodePool.query(
          `INSERT INTO blog_categories (name, slug, description, service_href, service_label)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT (slug) DO NOTHING`,
          row
        );
      }
      console.log("  ✔ seeded blog categories");
    }

    console.log("✅ Blog tables initialized successfully");
    return { success: true };
  } catch (error) {
    console.error("❌ Blog DB init failed:", error.message);
    console.error(
      "   Fix Hostinger env: PG_HOST, PG_PORT, PG_USER, PG_PASSWORD, PG_COGNICODE_DATABASE, PG_SSL=true"
    );
    return { success: false, message: error.message };
  }
}

// Auto-init on boot (with short delay so pool can connect on slow hosts)
setTimeout(() => {
  initializeBlogDB();
}, 500);

// ======================================================
// HELPERS
// ======================================================

function publicFileUrl(filename) {
  return `/files/blog/${filename}`;
}

function detectMediaType(mime = "") {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (
    mime.includes("pdf") ||
    mime.includes("word") ||
    mime.includes("sheet") ||
    mime.includes("excel") ||
    mime.includes("zip") ||
    mime.includes("text")
  ) {
    return "document";
  }
  return "file";
}

function slugify(text = "") {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200);
}

/**
 * Admin-only guard for website cogniadmin users.
 * Accepts adminId + email via headers or body (multipart-friendly).
 */
async function verifyAdmin(req, res, next) {
  try {
    const adminId =
      req.headers["x-admin-id"] ||
      req.body?.adminId ||
      req.query?.adminId;
    const email =
      req.headers["x-admin-email"] ||
      req.body?.email ||
      req.query?.email;

    if (!adminId || !email) {
      return res.status(401).json({
        success: false,
        message: "Admin authentication required",
      });
    }

    const result = await cognicodePool.query(
      `SELECT "adminId", name, email FROM "admindetails"
       WHERE "adminId" = $1 AND email = $2`,
      [Number(adminId), String(email).trim()]
    );

    if (result.rows.length === 0) {
      return res.status(403).json({
        success: false,
        message: "Admin access denied",
      });
    }

    req.admin = result.rows[0];
    next();
  } catch (error) {
    console.error("verifyAdmin error:", error);
    return res.status(500).json({
      success: false,
      message: "Admin verification failed",
    });
  }
}

function mapPostRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt,
    metaDescription: row.meta_description,
    content: row.content,
    keyTakeaways: row.key_takeaways,
    categorySlug: row.category_slug,
    author: {
      name: row.author_name,
      role: row.author_role,
      bio: row.author_bio,
      initials: row.author_initials,
    },
    coverImage: row.cover_image,
    coverVideo: row.cover_video,
    youtubeUrl: row.youtube_url,
    mediaGallery: row.media_gallery || [],
    likes: row.likes || 0,
    imageLabel: row.image_label,
    imageGradient: row.image_gradient,
    keywords: row.keywords,
    readTime: row.read_time,
    status: row.status,
    featured: row.featured,
    resource: row.resource,
    serviceCta: row.service_cta,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ======================================================
// PUBLIC ROUTES
// ======================================================

// Health / module info
router.get("/", (_req, res) => {
  res.json({
    success: true,
    message: "CogniCode Blog API",
    endpoints: {
      public: [
        "GET /blog/posts",
        "GET /blog/posts/:slug",
        "GET /blog/categories",
        "GET /blog/resources",
        "POST /blog/subscribe",
      ],
      admin: [
        "POST /blog/admin/posts",
        "PUT /blog/admin/posts/:id",
        "DELETE /blog/admin/posts/:id",
        "POST /blog/admin/upload",
        "POST /blog/admin/upload-multiple",
        "GET /blog/admin/media",
        "DELETE /blog/admin/media/:id",
        "POST /blog/admin/resources",
      ],
    },
  });
});

// List published posts
router.get("/posts", async (req, res) => {
  try {
    const {
      category,
      search,
      featured,
      page = 1,
      limit = 12,
      status = "published",
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10) || 12));
    const offset = (pageNum - 1) * limitNum;

    const where = [];
    const values = [];
    let i = 1;

    // Public callers only see published unless explicitly admin-checked later
    where.push(`status = $${i++}`);
    values.push(status === "all" ? "published" : status);

    if (category && category !== "all") {
      where.push(`category_slug = $${i++}`);
      values.push(category);
    }
    if (featured === "true" || featured === "1") {
      where.push(`featured = TRUE`);
    }
    if (search && String(search).trim()) {
      where.push(
        `(title ILIKE $${i} OR excerpt ILIKE $${i} OR meta_description ILIKE $${i} OR author_name ILIKE $${i})`
      );
      values.push(`%${String(search).trim()}%`);
      i++;
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const countResult = await cognicodePool.query(
      `SELECT COUNT(*)::int AS total FROM blog_posts ${whereSql}`,
      values
    );

    const listValues = [...values, limitNum, offset];
    const listResult = await cognicodePool.query(
      `SELECT * FROM blog_posts
       ${whereSql}
       ORDER BY COALESCE(published_at, created_at) DESC, id DESC
       LIMIT $${i++} OFFSET $${i++}`,
      listValues
    );

    res.json({
      success: true,
      data: listResult.rows.map(mapPostRow),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: countResult.rows[0].total,
        totalPages: Math.ceil(countResult.rows[0].total / limitNum) || 1,
      },
    });
  } catch (error) {
    console.error("GET /blog/posts error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch posts" });
  }
});

// Single post by slug
router.get("/posts/:slug", async (req, res) => {
  try {
    const result = await cognicodePool.query(
      `SELECT * FROM blog_posts WHERE slug = $1 AND status = 'published' LIMIT 1`,
      [req.params.slug]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Post not found" });
    }
    res.json({ success: true, data: mapPostRow(result.rows[0]) });
  } catch (error) {
    console.error("GET /blog/posts/:slug error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch post" });
  }
});

// Categories
router.get("/categories", async (_req, res) => {
  try {
    const result = await cognicodePool.query(
      `SELECT c.*,
              (SELECT COUNT(*)::int FROM blog_posts p
               WHERE p.category_slug = c.slug AND p.status = 'published') AS post_count
       FROM blog_categories c
       ORDER BY c.name ASC`
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error("GET /blog/categories error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch categories" });
  }
});

// Free resources
router.get("/resources", async (_req, res) => {
  try {
    const result = await cognicodePool.query(
      `SELECT * FROM blog_resources WHERE is_active = TRUE ORDER BY id DESC`
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error("GET /blog/resources error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch resources" });
  }
});

// Newsletter subscribe
router.post("/subscribe", async (req, res) => {
  try {
    const email = String(req.body?.email || "")
      .trim()
      .toLowerCase();
    const source = String(req.body?.source || "blog").slice(0, 120);

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res
        .status(400)
        .json({ success: false, message: "Valid email is required" });
    }

    await cognicodePool.query(
      `INSERT INTO blog_subscribers (email, source)
       VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET is_active = TRUE, source = EXCLUDED.source`,
      [email, source]
    );

    res.json({
      success: true,
      message: "Subscribed successfully",
      following: true,
    });
  } catch (error) {
    console.error("POST /blog/subscribe error:", error);
    res.status(500).json({ success: false, message: "Subscription failed" });
  }
});

router.post("/follow", async (req, res) => {
  try {
    let email = String(req.body?.email || "").trim().toLowerCase();
    let name = String(req.body?.name || "").trim().slice(0, 120);
    const source = String(req.body?.source || "follow").slice(0, 120);
    let userId = null;

    const me = await optionalSiteUser(req);
    const admin = await optionalAdmin(req);
    if (me.user) {
      email = me.user.email || email;
      name = name || me.user.displayName || me.user.username || "";
      userId = me.user.userId;
    } else if (admin.admin) {
      email = admin.admin.email || email;
      name = name || admin.admin.name || "Admin";
    }

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({
        success: false,
        needsEmail: true,
        message: "Enter an email to follow and get updates",
      });
    }

    await cognicodePool.query(
      `INSERT INTO blog_subscribers (email, source, "userId", name, is_active)
       VALUES ($1, $2, $3, $4, TRUE)
       ON CONFLICT (email) DO UPDATE SET
         is_active = TRUE,
         source = EXCLUDED.source,
         "userId" = COALESCE(EXCLUDED."userId", blog_subscribers."userId"),
         name = COALESCE(EXCLUDED.name, blog_subscribers.name)`,
      [email, source, userId, name || null]
    );

    return res.json({
      success: true,
      following: true,
      email,
      message: "You’re following CogniCode. We’ll email future blog and company updates.",
    });
  } catch (error) {
    console.error("POST /blog/follow error:", error);
    return res.status(500).json({ success: false, message: "Could not follow right now" });
  }
});

router.get("/follow/status", async (req, res) => {
  try {
    let email = String(req.query.email || "").trim().toLowerCase();
    const me = await optionalSiteUser(req);
    const admin = await optionalAdmin(req);
    if (me.user?.email) email = me.user.email;
    else if (admin.admin?.email) email = String(admin.admin.email).toLowerCase();
    if (!email) return res.json({ success: true, following: false });
    const found = await cognicodePool.query(
      `SELECT 1 FROM blog_subscribers WHERE email = $1 AND is_active = TRUE LIMIT 1`,
      [email]
    );
    return res.json({ success: true, following: found.rows.length > 0, email });
  } catch (error) {
    return res.json({ success: true, following: false });
  }
});

// ======================================================
// ADMIN ROUTES — posts
// ======================================================

// List all posts (including drafts) for admin
router.get("/admin/posts", verifyAdmin, async (req, res) => {
  try {
    const result = await cognicodePool.query(
      `SELECT * FROM blog_posts ORDER BY updated_at DESC, id DESC`
    );
    res.json({ success: true, data: result.rows.map(mapPostRow) });
  } catch (error) {
    console.error("GET /blog/admin/posts error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch admin posts" });
  }
});

// Create post
router.post("/admin/posts", verifyAdmin, async (req, res) => {
  try {
    const {
      title,
      slug: rawSlug,
      excerpt,
      metaDescription,
      content,
      keyTakeaways,
      categorySlug,
      authorName,
      authorRole,
      authorBio,
      authorInitials,
      coverImage,
      coverVideo,
      youtubeUrl,
      mediaGallery,
      imageLabel,
      imageGradient,
      keywords,
      readTime,
      status = "draft",
      featured = false,
      resource,
      serviceCta,
      publishedAt,
    } = req.body;

    if (!title) {
      return res.status(400).json({ success: false, message: "Title is required" });
    }

    const slug = slugify(rawSlug || title);
    if (!slug) {
      return res.status(400).json({ success: false, message: "Invalid slug" });
    }

    const result = await cognicodePool.query(
      `INSERT INTO blog_posts (
        slug, title, excerpt, meta_description, content, key_takeaways,
        category_slug, author_name, author_role, author_bio, author_initials,
        cover_image, cover_video, youtube_url, media_gallery, image_label, image_gradient, keywords,
        read_time, status, featured, resource, service_cta, published_at,
        created_by, updated_by
      ) VALUES (
        $1,$2,$3,$4,$5::jsonb,$6::jsonb,
        $7,$8,$9,$10,$11,
        $12,$13,$14,$15::jsonb,$16,$17,$18::jsonb,
        $19,$20,$21,$22::jsonb,$23::jsonb,$24,
        $25,$25
      ) RETURNING *`,
      [
        slug,
        title,
        excerpt || null,
        metaDescription || null,
        JSON.stringify(content || []),
        JSON.stringify(keyTakeaways || []),
        categorySlug || null,
        authorName || req.admin.name,
        authorRole || null,
        authorBio || null,
        authorInitials || null,
        coverImage || null,
        coverVideo || null,
        youtubeUrl || null,
        JSON.stringify(mediaGallery || []),
        imageLabel || null,
        imageGradient || null,
        JSON.stringify(keywords || []),
        readTime || "5 min read",
        status === "published" ? "published" : "draft",
        Boolean(featured),
        resource ? JSON.stringify(resource) : null,
        serviceCta ? JSON.stringify(serviceCta) : null,
        status === "published"
          ? publishedAt || new Date().toISOString()
          : publishedAt || null,
        req.admin.adminId,
      ]
    );

    const created = mapPostRow(result.rows[0]);
    if (status === "published") {
      notifyBlogSubscribers({
        title: created.title,
        excerpt: created.excerpt,
        slug: created.slug,
      });
    }

    res.status(201).json({
      success: true,
      message: "Post created",
      data: created,
    });
  } catch (error) {
    console.error("POST /blog/admin/posts error:", error);
    if (error.code === "23505") {
      return res
        .status(409)
        .json({ success: false, message: "Slug already exists" });
    }
    res.status(500).json({ success: false, message: "Failed to create post" });
  }
});

// Update post
router.put("/admin/posts/:id", verifyAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) {
      return res.status(400).json({ success: false, message: "Invalid post id" });
    }

    const existing = await cognicodePool.query(
      `SELECT * FROM blog_posts WHERE id = $1`,
      [id]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Post not found" });
    }

    const current = existing.rows[0];
    const b = req.body;

    const nextStatus = b.status || current.status;
    const nextPublishedAt =
      nextStatus === "published"
        ? b.publishedAt || current.published_at || new Date().toISOString()
        : b.publishedAt ?? current.published_at;

    const result = await cognicodePool.query(
      `UPDATE blog_posts SET
        slug = $1,
        title = $2,
        excerpt = $3,
        meta_description = $4,
        content = $5::jsonb,
        key_takeaways = $6::jsonb,
        category_slug = $7,
        author_name = $8,
        author_role = $9,
        author_bio = $10,
        author_initials = $11,
        cover_image = $12,
        cover_video = $13,
        youtube_url = $14,
        media_gallery = $15::jsonb,
        image_label = $16,
        image_gradient = $17,
        keywords = $18::jsonb,
        read_time = $19,
        status = $20,
        featured = $21,
        resource = $22::jsonb,
        service_cta = $23::jsonb,
        published_at = $24,
        updated_by = $25,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $26
      RETURNING *`,
      [
        b.slug ? slugify(b.slug) : current.slug,
        b.title ?? current.title,
        b.excerpt ?? current.excerpt,
        b.metaDescription ?? current.meta_description,
        JSON.stringify(b.content ?? current.content ?? []),
        JSON.stringify(b.keyTakeaways ?? current.key_takeaways ?? []),
        b.categorySlug ?? current.category_slug,
        b.authorName ?? current.author_name,
        b.authorRole ?? current.author_role,
        b.authorBio ?? current.author_bio,
        b.authorInitials ?? current.author_initials,
        b.coverImage ?? current.cover_image,
        b.coverVideo ?? current.cover_video,
        b.youtubeUrl !== undefined ? b.youtubeUrl : current.youtube_url,
        JSON.stringify(
          b.mediaGallery !== undefined
            ? b.mediaGallery || []
            : current.media_gallery || []
        ),
        b.imageLabel ?? current.image_label,
        b.imageGradient ?? current.image_gradient,
        JSON.stringify(b.keywords ?? current.keywords ?? []),
        b.readTime ?? current.read_time,
        nextStatus,
        b.featured !== undefined ? Boolean(b.featured) : current.featured,
        b.resource !== undefined
          ? b.resource
            ? JSON.stringify(b.resource)
            : null
          : current.resource
            ? JSON.stringify(current.resource)
            : null,
        b.serviceCta !== undefined
          ? b.serviceCta
            ? JSON.stringify(b.serviceCta)
            : null
          : current.service_cta
            ? JSON.stringify(current.service_cta)
            : null,
        nextPublishedAt,
        req.admin.adminId,
        id,
      ]
    );

    res.json({
      success: true,
      message: "Post updated",
      data: mapPostRow(result.rows[0]),
    });
  } catch (error) {
    console.error("PUT /blog/admin/posts/:id error:", error);
    if (error.code === "23505") {
      return res
        .status(409)
        .json({ success: false, message: "Slug already exists" });
    }
    res.status(500).json({ success: false, message: "Failed to update post" });
  }
});

// Delete post
router.delete("/admin/posts/:id", verifyAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const result = await cognicodePool.query(
      `DELETE FROM blog_posts WHERE id = $1 RETURNING id`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Post not found" });
    }
    res.json({ success: true, message: "Post deleted" });
  } catch (error) {
    console.error("DELETE /blog/admin/posts/:id error:", error);
    res.status(500).json({ success: false, message: "Failed to delete post" });
  }
});

// ======================================================
// ADMIN ROUTES — media upload
// ======================================================

/**
 * Single file upload
 * field name: file
 * optional: altText, postId, mediaType override
 * Requires x-admin-id + x-admin-email headers (or form fields)
 */
router.post(
  "/admin/upload",
  (req, res, next) => {
    upload.single("file")(req, res, (err) => {
      if (err) {
        return res.status(400).json({
          success: false,
          message: err.message || "Upload failed",
        });
      }
      next();
    });
  },
  verifyAdmin,
  async (req, res) => {
    try {
      if (!req.file) {
        return res
          .status(400)
          .json({ success: false, message: "No file uploaded" });
      }

      const mediaType =
        req.body.mediaType || detectMediaType(req.file.mimetype);
      const url = publicFileUrl(req.file.filename);
      const postId = req.body.postId ? Number(req.body.postId) : null;

      const result = await cognicodePool.query(
        `INSERT INTO blog_media (
          filename, original_name, mime_type, media_type, size_bytes,
          url, alt_text, uploaded_by, post_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        RETURNING *`,
        [
          req.file.filename,
          req.file.originalname,
          req.file.mimetype,
          mediaType,
          req.file.size,
          url,
          req.body.altText || null,
          req.admin.adminId,
          postId,
        ]
      );

      res.status(201).json({
        success: true,
        message: "File uploaded",
        data: {
          ...result.rows[0],
          absolutePathHint: url,
        },
      });
    } catch (error) {
      console.error("POST /blog/admin/upload error:", error);
      res.status(500).json({ success: false, message: "Upload failed" });
    }
  }
);

/**
 * Multiple files upload
 * field name: files
 */
router.post(
  "/admin/upload-multiple",
  (req, res, next) => {
    upload.array("files", 10)(req, res, (err) => {
      if (err) {
        return res.status(400).json({
          success: false,
          message: err.message || "Upload failed",
        });
      }
      next();
    });
  },
  verifyAdmin,
  async (req, res) => {
    try {
      const files = req.files || [];
      if (!files.length) {
        return res
          .status(400)
          .json({ success: false, message: "No files uploaded" });
      }

      const postId = req.body.postId ? Number(req.body.postId) : null;
      const saved = [];

      for (const file of files) {
        const mediaType = detectMediaType(file.mimetype);
        const url = publicFileUrl(file.filename);
        const result = await cognicodePool.query(
          `INSERT INTO blog_media (
            filename, original_name, mime_type, media_type, size_bytes,
            url, alt_text, uploaded_by, post_id
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          RETURNING *`,
          [
            file.filename,
            file.originalname,
            file.mimetype,
            mediaType,
            file.size,
            url,
            req.body.altText || null,
            req.admin.adminId,
            postId,
          ]
        );
        saved.push(result.rows[0]);
      }

      res.status(201).json({
        success: true,
        message: `${saved.length} file(s) uploaded`,
        data: saved,
      });
    } catch (error) {
      console.error("POST /blog/admin/upload-multiple error:", error);
      res.status(500).json({ success: false, message: "Upload failed" });
    }
  }
);

// List media library
router.get("/admin/media", verifyAdmin, async (req, res) => {
  try {
    const { mediaType, limit = 50 } = req.query;
    const values = [];
    let where = "";
    if (mediaType) {
      values.push(mediaType);
      where = `WHERE media_type = $1`;
    }
    values.push(Math.min(200, Math.max(1, parseInt(limit, 10) || 50)));

    const result = await cognicodePool.query(
      `SELECT * FROM blog_media ${where}
       ORDER BY created_at DESC
       LIMIT $${values.length}`,
      values
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error("GET /blog/admin/media error:", error);
    res.status(500).json({ success: false, message: "Failed to list media" });
  }
});

// Delete media
router.delete("/admin/media/:id", verifyAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = await cognicodePool.query(
      `SELECT * FROM blog_media WHERE id = $1`,
      [id]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Media not found" });
    }

    const file = existing.rows[0];
    const filePath = path.join(blogUploadDir, file.filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    await cognicodePool.query(`DELETE FROM blog_media WHERE id = $1`, [id]);
    res.json({ success: true, message: "Media deleted" });
  } catch (error) {
    console.error("DELETE /blog/admin/media/:id error:", error);
    res.status(500).json({ success: false, message: "Failed to delete media" });
  }
});

// Create / update free resource entry
router.post("/admin/resources", verifyAdmin, async (req, res) => {
  try {
    const { title, description, resourceType, categorySlug, fileUrl, isActive } =
      req.body;
    if (!title) {
      return res.status(400).json({ success: false, message: "Title required" });
    }
    const result = await cognicodePool.query(
      `INSERT INTO blog_resources (
        title, description, resource_type, category_slug, file_url, is_active
      ) VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING *`,
      [
        title,
        description || null,
        resourceType || "PDF",
        categorySlug || null,
        fileUrl || null,
        isActive === false ? false : true,
      ]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error("POST /blog/admin/resources error:", error);
    res.status(500).json({ success: false, message: "Failed to create resource" });
  }
});

// Admin list subscribers
router.get("/admin/subscribers", verifyAdmin, async (_req, res) => {
  try {
    const result = await cognicodePool.query(
      `SELECT id, email, source, is_active, created_at
       FROM blog_subscribers
       ORDER BY created_at DESC`
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error("GET /blog/admin/subscribers error:", error);
    res.status(500).json({ success: false, message: "Failed to list subscribers" });
  }
});

/**
 * Public health — shows whether blog tables exist on this database.
 * GET /blog/health
 */
router.get("/health", async (_req, res) => {
  try {
    const db = await cognicodePool.query(
      "SELECT current_database() AS db, current_user AS usr"
    );
    const tables = await cognicodePool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name LIKE 'blog_%'
      ORDER BY table_name
    `);
    const names = tables.rows.map((r) => r.table_name);
    res.json({
      success: true,
      database: db.rows[0].db,
      user: db.rows[0].usr,
      tables: names,
      ready: names.includes("blog_posts") && names.includes("blog_categories"),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      hint: "Check PG_* env on Hostinger and run POST /blog/admin/init-tables",
    });
  }
});

/**
 * Admin: force re-create blog tables (safe CREATE IF NOT EXISTS).
 * POST /blog/admin/init-tables?adminId=&email=
 */
router.post("/admin/init-tables", verifyAdmin, async (_req, res) => {
  const result = await initializeBlogDB();
  if (!result?.success) {
    return res.status(500).json({
      success: false,
      message: result?.message || "Init failed",
    });
  }
  try {
    const tables = await cognicodePool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name LIKE 'blog_%'
      ORDER BY table_name
    `);
    res.json({
      success: true,
      message: "Blog tables ensured",
      tables: tables.rows.map((r) => r.table_name),
    });
  } catch (e) {
    res.json({ success: true, message: "Init ran", tables: [] });
  }
});

module.exports = router;
module.exports.initializeBlogDB = initializeBlogDB;
