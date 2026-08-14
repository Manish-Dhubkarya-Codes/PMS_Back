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

module.exports = { 
  initializeDatabase1, 
  initializeDatabase2, 
  initializeClientRequestsDB,
  initializeAdminDB  // ← Keep this
};