// init file
const bcrypt = require("bcryptjs");

const pgPool = require("./PostgreSQLPool");
require("dotenv").config();
const initializeDatabase1 = async () => {
  try {
    await pgPool.query(`
      CREATE SCHEMA IF NOT EXISTS "Entities";

      CREATE TABLE IF NOT EXISTS "Entities".head (
        "headId" SERIAL PRIMARY KEY,
        "headName" VARCHAR(100),
        "headMail" VARCHAR(100) NOT NULL UNIQUE,
        "headMobile" VARCHAR(15),
        "headSecurityKey" VARCHAR(10),
        "headPic" TEXT,
        "role" VARCHAR(20) NOT NULL DEFAULT 'Head',
        "password" TEXT
      );

      CREATE TABLE IF NOT EXISTS "Entities"."TeamLeaderSecureKey" (
        "key_id" VARCHAR(100) PRIMARY KEY,
        "name" VARCHAR(100) NOT NULL,
        "email" VARCHAR(150) NOT NULL,
        "mobile" VARCHAR(15) NOT NULL
      );

      CREATE TABLE IF NOT EXISTS "Entities"."ClientSecureKey" (
        "key_id" VARCHAR(100) PRIMARY KEY,
        "name" VARCHAR(100) NOT NULL,
        "email" VARCHAR(150) NOT NULL,
        "mobile" VARCHAR(15)
      );

      ALTER TABLE "Entities"."TeamLeaderSecureKey"
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE "Entities"."ClientSecureKey"
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE IF NOT EXISTS "Entities"."clients" (
  "clientId" SERIAL PRIMARY KEY,
  "clientName" VARCHAR(100) NOT NULL,
  "clientMail" TEXT NOT NULL,
  "mobile" VARCHAR(15) NOT NULL,
  "requirement" TEXT NOT NULL,
  "password" TEXT NOT NULL,
  "department" VARCHAR(100) NOT NULL,
  "degree" VARCHAR(100) NOT NULL,
  "clientPic" TEXT,
  "role" VARCHAR(20) NOT NULL,
  "clientSecurityKey" TEXT NOT NULL DEFAULT 'default_key'::text
);

      CREATE TABLE IF NOT EXISTS "Entities"."employeeRegRequest" (
        id SERIAL PRIMARY KEY,
        "employeeName" VARCHAR(255) NOT NULL,
        "employeeMail" VARCHAR(255) UNIQUE NOT NULL,
        "employmentID" VARCHAR(100) NOT NULL,
        gender VARCHAR(20) NOT NULL,
        "employeeDesignation" VARCHAR(255) NOT NULL,
        password VARCHAR(255) NOT NULL,
        role VARCHAR(50) NOT NULL CHECK (role IN ('Employee', 'Team Leader')),
        "securityKey" VARCHAR(255),
        "employeePic" VARCHAR(255),
        status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_employeeRegRequest_email ON "Entities"."employeeRegRequest" ("employeeMail");
      CREATE INDEX IF NOT EXISTS idx_employeeRegRequest_status ON "Entities"."employeeRegRequest" (status);

      CREATE TABLE IF NOT EXISTS "Entities".employees (
        "employeeId" SERIAL PRIMARY KEY,
        "employeeName" VARCHAR(200) NOT NULL,
        "employeeDesignation" VARCHAR(100) NOT NULL,
        "employeeMail" TEXT NOT NULL,
        "employmentID" VARCHAR(100) NOT NULL,
        "password" TEXT NOT NULL,
        "gender" VARCHAR(50) NOT NULL,
        "employeePic" TEXT,
        "role" VARCHAR(20) DEFAULT 'Employee' NOT NULL,
        "securityKey" VARCHAR(20)
      );

      CREATE TABLE IF NOT EXISTS "Entities"."pushSubscriptions" (
        "id" SERIAL PRIMARY KEY,
        "userId" VARCHAR(255) NOT NULL,
        "userType" VARCHAR(50) NOT NULL DEFAULT 'head',
        "endpoint" TEXT UNIQUE NOT NULL,
        "subscription" TEXT NOT NULL,
        "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_push_userid ON "Entities"."pushSubscriptions" ("userId");
    `);

    // Older DBs created headName as NOT NULL; CREATE TABLE IF NOT EXISTS
    // will not change that. Drop the constraint so seed + OTP registration work.
    await pgPool.query(`
      ALTER TABLE "Entities".head
        ALTER COLUMN "headName" DROP NOT NULL;
    `).catch(() => {});

    const insertQuery = `
      INSERT INTO "Entities".head
      ("headId", "headName", "headMail", "headMobile", "headSecurityKey", "role", "password")
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT ("headId") DO UPDATE SET
        "headName" = COALESCE(NULLIF("Entities".head."headName", ''), EXCLUDED."headName"),
        "headMail" = COALESCE(EXCLUDED."headMail", "Entities".head."headMail"),
        "headMobile" = COALESCE("Entities".head."headMobile", EXCLUDED."headMobile"),
        "headSecurityKey" = COALESCE("Entities".head."headSecurityKey", EXCLUDED."headSecurityKey"),
        "role" = COALESCE(EXCLUDED."role", "Entities".head."role"),
        "password" = COALESCE("Entities".head."password", EXCLUDED."password");
    `;
    const values = [
      process.env.HEAD_ID || 1,
      process.env.HEAD_NAME || "Head",
      process.env.HEAD_MAIL,
      process.env.HEAD_MOBILE || null,
      process.env.HEAD_SECURITY_KEY || null,
      process.env.HEAD_ROLE || "Head",
      process.env.HEAD_PASSWORD || null,
    ];
    await pgPool.query(insertQuery, values);

    console.log("✅ Database 1 (Entities) initialized successfully.");
  } catch (error) {
    console.error("❌ Error initializing Database 1:", error);
  }
};


const initializeDatabase2 = async () => {
  try {
    await pgPool.query(`
      CREATE SCHEMA IF NOT EXISTS projectschema;

      CREATE TABLE IF NOT EXISTS projectschema."clientproject" (
  "project_id" SERIAL PRIMARY KEY,
  "workstream" VARCHAR(100) NOT NULL,
  "title" VARCHAR(255) NOT NULL,
  "deadline" DATE NOT NULL,
  "budget" NUMERIC(15, 2) NOT NULL,
  "description" TEXT[] DEFAULT ARRAY[]::TEXT[] NOT NULL,
  "clientid" INTEGER DEFAULT 3 NOT NULL,
  "clientchats" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "clientaudios" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "headchats" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "headaudios" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "headid" INTEGER,
  "teamleaderid" INTEGER,
  "tlchats" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "tlaudios" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "status" VARCHAR(50) DEFAULT 'Hold' NOT NULL,
  "active_date" TIMESTAMP DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS projectschema."progressTracking" (
      project_id INTEGER PRIMARY KEY REFERENCES projectschema.clientproject(project_id) ON DELETE CASCADE,
      progress JSONB NOT NULL DEFAULT '{"start": "no", "payment": "0%", "work": "0%"}'::jsonb,
      last_payment_update TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_work_update TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

      CREATE TABLE IF NOT EXISTS projectschema."employeeRequests" (
        "request_id" SERIAL PRIMARY KEY,
        "project_id" INTEGER,
        "employeeid" VARCHAR(255),
        "status" VARCHAR(50) DEFAULT 'pending',
        "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS projectschema."projectMonitors" (
        "monitorId" SERIAL PRIMARY KEY,
        "employeeId" INTEGER NOT NULL,
        "projectId" INTEGER NOT NULL,
        "status" VARCHAR(255) NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projectschema."projectTLClientChats" (
        "projectId" INTEGER REFERENCES projectschema.clientproject(project_id) ON DELETE CASCADE,
        "TeamLeaderId" INTEGER REFERENCES "Entities".employees("employeeId"),
        "MonitorId" INTEGER REFERENCES "Entities".employees("employeeId"),
        "TLChats" TEXT[] DEFAULT ARRAY[]::TEXT[],
        "TLAudios" TEXT[] DEFAULT ARRAY[]::TEXT[],
        "MonitorChats" TEXT[] DEFAULT ARRAY[]::TEXT[],
        "MonitorAudios" TEXT[] DEFAULT ARRAY[]::TEXT[],
        PRIMARY KEY ("projectId")
      );
    `);

    console.log("✅ Database 2 (ProjectSchema) initialized successfully.");
  } catch (error) {
    console.error("❌ Error initializing Database 2:", error);
  }
};

// ==================== NEW: Separate Database "Cognicode" ====================
const cognicodePool = require("./CognicodePool");

const initializeClientRequestsDB = async () => {
  try {
    await cognicodePool.query(`
      CREATE TABLE IF NOT EXISTS "clientrequests" (
        "clientId" SERIAL PRIMARY KEY,
        "name" VARCHAR(100) NOT NULL,
        "email" VARCHAR(150) NOT NULL,
        "phone" VARCHAR(20),
        "country" VARCHAR(100),
        "service" VARCHAR(100),
        "subject" TEXT,
        "message" TEXT NOT NULL,
        "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log("✅ Database 'Cognicode' + table 'clientrequests' initialized successfully.");
  } catch (error) {
    console.error("❌ Error initializing Cognicode database:", error);
  }
};

const initializeAdminDB = async () => {
  try {
    // ================= VALIDATE ENV =================
    if (
      !process.env.ADMIN_NAME ||
      !process.env.ADMIN_EMAIL ||
      !process.env.ADMIN_PASSWORD
    ) {
      throw new Error(
        "ADMIN_NAME, ADMIN_EMAIL, ADMIN_PASSWORD must exist in .env"
      );
    }

    // ================= CREATE TABLE =================
    await cognicodePool.query(`
      CREATE TABLE IF NOT EXISTS "admindetails" (
        "adminId" SERIAL PRIMARY KEY,
        "name" VARCHAR(100) NOT NULL,
        "email" VARCHAR(150) UNIQUE NOT NULL,
        "password" TEXT NOT NULL,
        "updated_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // ================= HASH PASSWORD =================
    const hashedPassword = await bcrypt.hash(
      process.env.ADMIN_PASSWORD,
      12
    );

    // ================= INSERT ADMIN =================
    await cognicodePool.query(
      `
      INSERT INTO "admindetails" (
        "name",
        "email",
        "password"
      )
      VALUES ($1, $2, $3)
      ON CONFLICT ("email") DO NOTHING;
      `,
      [
        process.env.ADMIN_NAME,
        process.env.ADMIN_EMAIL,
        hashedPassword
      ]
    );

    console.log("✅ Admin table initialized successfully.");
  } catch (error) {
    console.error("❌ Admin DB initialization failed:", error);
  }
};

let siteUsersInitPromise = null;

const initializeSiteUsersDB = async () => {
  if (siteUsersInitPromise) return siteUsersInitPromise;
  siteUsersInitPromise = (async () => {
  try {
    await cognicodePool.query(`
      CREATE TABLE IF NOT EXISTS "site_users" (
        "userId" SERIAL PRIMARY KEY,
        "username" VARCHAR(30) UNIQUE NOT NULL,
        "displayName" VARCHAR(100),
        "email" VARCHAR(150) UNIQUE,
        "mobile" VARCHAR(20) UNIQUE,
        "channel" VARCHAR(10) NOT NULL,
        "countryCode" VARCHAR(8),
        "isBlocked" BOOLEAN DEFAULT FALSE,
        "blockedAt" TIMESTAMP,
        "blockedReason" TEXT,
        "lastLoginAt" TIMESTAMP,
        "lastSeenAt" TIMESTAMP,
        "loginCount" INTEGER DEFAULT 0,
        "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS "site_user_otps" (
        "id" SERIAL PRIMARY KEY,
        "channel" VARCHAR(10) NOT NULL,
        "destination" VARCHAR(150) NOT NULL,
        "otpHash" TEXT NOT NULL,
        "purpose" VARCHAR(20) NOT NULL,
        "expiresAt" TIMESTAMP NOT NULL,
        "attempts" INTEGER DEFAULT 0,
        "consumed" BOOLEAN DEFAULT FALSE,
        "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS "site_user_sessions" (
        "sessionId" SERIAL PRIMARY KEY,
        "userId" INTEGER REFERENCES "site_users"("userId") ON DELETE CASCADE,
        "token" TEXT UNIQUE NOT NULL,
        "userAgent" TEXT,
        "ip" VARCHAR(64),
        "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        "lastUsedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS "blog_likes" (
        "id" SERIAL PRIMARY KEY,
        "userId" INTEGER REFERENCES "site_users"("userId") ON DELETE CASCADE,
        "postSlug" VARCHAR(200) NOT NULL,
        "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE ("userId", "postSlug")
      );

      CREATE TABLE IF NOT EXISTS "blog_comments" (
        "id" SERIAL PRIMARY KEY,
        "userId" INTEGER REFERENCES "site_users"("userId") ON DELETE CASCADE,
        "postSlug" VARCHAR(200) NOT NULL,
        "body" TEXT NOT NULL,
        "parentId" INTEGER REFERENCES "blog_comments"("id") ON DELETE CASCADE,
        "isPinned" BOOLEAN DEFAULT FALSE,
        "isAdmin" BOOLEAN DEFAULT FALSE,
        "adminId" INTEGER,
        "adminName" VARCHAR(120),
        "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS "blog_shares" (
        "id" SERIAL PRIMARY KEY,
        "userId" INTEGER REFERENCES "site_users"("userId") ON DELETE SET NULL,
        "postSlug" VARCHAR(200) NOT NULL,
        "channel" VARCHAR(40),
        "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS "blog_visits" (
        "id" SERIAL PRIMARY KEY,
        "userId" INTEGER REFERENCES "site_users"("userId") ON DELETE SET NULL,
        "postSlug" VARCHAR(200),
        "path" TEXT,
        "userAgent" TEXT,
        "ip" VARCHAR(64),
        "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_site_users_email ON "site_users" (email);
      CREATE INDEX IF NOT EXISTS idx_site_users_mobile ON "site_users" (mobile);
      CREATE INDEX IF NOT EXISTS idx_site_users_username ON "site_users" (LOWER(username));
      CREATE INDEX IF NOT EXISTS idx_site_users_last_login ON "site_users" ("lastLoginAt" DESC);
      CREATE INDEX IF NOT EXISTS idx_site_otps_dest ON "site_user_otps" (destination, consumed);
      CREATE INDEX IF NOT EXISTS idx_site_sessions_token ON "site_user_sessions" (token);
      CREATE INDEX IF NOT EXISTS idx_blog_likes_slug ON "blog_likes" ("postSlug");
      CREATE INDEX IF NOT EXISTS idx_blog_comments_slug ON "blog_comments" ("postSlug", "created_at" DESC);
      CREATE INDEX IF NOT EXISTS idx_blog_shares_slug ON "blog_shares" ("postSlug");
      CREATE INDEX IF NOT EXISTS idx_blog_visits_slug ON "blog_visits" ("postSlug", "created_at" DESC);
      CREATE INDEX IF NOT EXISTS idx_blog_visits_user ON "blog_visits" ("userId", "created_at" DESC);
    `);

    const commentAlters = [
      `ALTER TABLE "site_users" ADD COLUMN IF NOT EXISTS "countryCode" VARCHAR(8)`,
      `ALTER TABLE "site_users" ADD COLUMN IF NOT EXISTS "passwordHash" TEXT`,
      `ALTER TABLE "blog_comments" ADD COLUMN IF NOT EXISTS "parentId" INTEGER REFERENCES "blog_comments"("id") ON DELETE CASCADE`,
      `ALTER TABLE "blog_comments" ADD COLUMN IF NOT EXISTS "isPinned" BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE "blog_comments" ADD COLUMN IF NOT EXISTS "isAdmin" BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE "blog_comments" ADD COLUMN IF NOT EXISTS "adminId" INTEGER`,
      `ALTER TABLE "blog_comments" ADD COLUMN IF NOT EXISTS "adminName" VARCHAR(120)`,
      `ALTER TABLE "blog_likes" ALTER COLUMN "userId" DROP NOT NULL`,
      `ALTER TABLE "blog_likes" ADD COLUMN IF NOT EXISTS "isAdmin" BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE "blog_likes" ADD COLUMN IF NOT EXISTS "adminId" INTEGER`,
      `ALTER TABLE "blog_shares" ADD COLUMN IF NOT EXISTS "isAdmin" BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE "blog_shares" ADD COLUMN IF NOT EXISTS "adminId" INTEGER`,
      `ALTER TABLE blog_subscribers ADD COLUMN IF NOT EXISTS "userId" INTEGER`,
      `ALTER TABLE blog_subscribers ADD COLUMN IF NOT EXISTS name VARCHAR(120)`,
    ];
    for (const sql of commentAlters) {
      try {
        await cognicodePool.query(sql);
      } catch (err) {
        console.warn("site users alter skipped:", err.message);
      }
    }
    await cognicodePool.query(
      `CREATE INDEX IF NOT EXISTS idx_blog_comments_parent ON "blog_comments" ("parentId")`
    );
    await cognicodePool.query(`
      CREATE TABLE IF NOT EXISTS "blog_saves" (
        "id" SERIAL PRIMARY KEY,
        "userId" INTEGER REFERENCES "site_users"("userId") ON DELETE CASCADE,
        "adminId" INTEGER,
        "postSlug" VARCHAR(200) NOT NULL,
        "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await cognicodePool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_blog_likes_admin ON "blog_likes" ("adminId", "postSlug") WHERE "adminId" IS NOT NULL`
    );
    await cognicodePool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_blog_saves_user ON "blog_saves" ("userId", "postSlug") WHERE "userId" IS NOT NULL`
    );
    await cognicodePool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_blog_saves_admin ON "blog_saves" ("adminId", "postSlug") WHERE "adminId" IS NOT NULL`
    );

    console.log("✅ Site users + blog engagement tables initialized.");
  } catch (error) {
    console.error("❌ Site users DB initialization failed:", error);
    siteUsersInitPromise = null;
  }
  })();
  return siteUsersInitPromise;
};

module.exports = { 
  initializeDatabase1, 
  initializeDatabase2, 
  initializeClientRequestsDB,
  initializeAdminDB,
  initializeSiteUsersDB
};