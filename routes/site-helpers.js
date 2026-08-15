const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const cognicodePool = require("./CognicodePool");
require("dotenv").config();

const otpSendCooldown = new Map();

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

function publicUser(row) {
  if (!row) return null;
  return {
    userId: row.userId,
    username: row.username,
    displayName: row.displayName || row.username,
    email: row.email || null,
    mobile: row.mobile || null,
    countryCode: row.countryCode || null,
    channel: row.channel,
    isBlocked: Boolean(row.isBlocked),
    lastLoginAt: row.lastLoginAt || null,
    lastSeenAt: row.lastSeenAt || null,
    loginCount: Number(row.loginCount || 0),
    createdAt: row.created_at || row.createdAt || null,
  };
}

function normalizeEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normalizeCountryCode(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeMobile(value, countryCode) {
  let digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  const cc = normalizeCountryCode(countryCode) || "91";

  // Already includes this country code (user pasted +91... / 91...)
  if (digits.startsWith(cc) && digits.length >= cc.length + 6) {
    return digits;
  }
  // National trunk prefix, e.g. 09876... or 07911...
  if (digits.startsWith("0")) {
    digits = digits.replace(/^0+/, "");
  }
  return `${cc}${digits}`;
}

function maskDestination(channel, destination) {
  if (channel === "email") {
    const [name, domain] = String(destination).split("@");
    if (!domain) return destination;
    const keep = name.slice(0, 2);
    return `${keep}${"*".repeat(Math.max(name.length - 2, 2))}@${domain}`;
  }
  const d = String(destination);
  if (d.length < 6) return "******";
  return `+${d.slice(0, Math.min(3, d.length - 4))}******${d.slice(-3)}`;
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isValidMobile(value) {
  return /^\d{8,15}$/.test(value);
}

function normalizeUsername(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._]/g, "")
    .slice(0, 30);
}

function isValidUsername(value) {
  const u = String(value || "");
  if (u.length < 3 || u.length > 30) return false;
  if (!/^[a-z0-9._]+$/.test(u)) return false;
  if (/^[._]/.test(u) || /[._]$/.test(u)) return false;
  if (/[._]{2,}/.test(u)) return false;
  const reserved = [
    "admin",
    "administrator",
    "cognicode",
    "cognicodeedutech",
    "root",
    "support",
    "help",
    "official",
    "moderator",
    "staff",
  ];
  return !reserved.includes(u);
}

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || req.connection?.remoteAddress || "";
}

function authFromReq(req) {
  const body = req.body || {};
  const query = req.query || {};
  return {
    adminId: body.adminId || query.adminId,
    email: body.email || query.email,
    userId: body.userId || query.userId,
    token: body.token || query.token,
  };
}

async function requireAdmin(req) {
  const { adminId, email } = authFromReq(req);
  if (!adminId || !email) {
    return { ok: false, status: 401, message: "Admin login required" };
  }
  const result = await cognicodePool.query(
    `SELECT "adminId", name, email FROM "admindetails" WHERE "adminId" = $1 AND email = $2`,
    [adminId, String(email).trim()]
  );
  if (result.rows.length === 0) {
    return { ok: false, status: 401, message: "Invalid admin session" };
  }
  return { ok: true, admin: result.rows[0] };
}

async function requireSiteUser(req, { allowBlocked = false } = {}) {
  const { userId, token } = authFromReq(req);
  if (!userId || !token) {
    return { ok: false, status: 401, message: "Please log in to continue" };
  }
  const session = await cognicodePool.query(
    `
      SELECT s."sessionId", s."userId", u.*
      FROM "site_user_sessions" s
      JOIN "site_users" u ON u."userId" = s."userId"
      WHERE s."userId" = $1 AND s.token = $2
    `,
    [userId, token]
  );
  if (session.rows.length === 0) {
    const blocked = await cognicodePool.query(
      `SELECT "isBlocked", "blockedReason" FROM "site_users" WHERE "userId" = $1 LIMIT 1`,
      [userId]
    );
    if (blocked.rows[0]?.isBlocked) {
      return {
        ok: false,
        status: 403,
        message:
          blocked.rows[0].blockedReason ||
          "This account has been locked by CogniCode admin.",
        blocked: true,
      };
    }
    return { ok: false, status: 401, message: "Session expired. Please log in again." };
  }
  const user = session.rows[0];
  if (user.isBlocked && !allowBlocked) {
    return {
      ok: false,
      status: 403,
      message: "This account has been blocked. Contact CogniCode support.",
      blocked: true,
    };
  }
  await cognicodePool.query(
    `
      UPDATE "site_user_sessions"
      SET "lastUsedAt" = CURRENT_TIMESTAMP
      WHERE "sessionId" = $1
    `,
    [user.sessionId]
  );
  await cognicodePool.query(
    `
      UPDATE "site_users"
      SET "lastSeenAt" = CURRENT_TIMESTAMP
      WHERE "userId" = $1
    `,
    [user.userId]
  );
  return { ok: true, user };
}

async function optionalSiteUser(req) {
  const { userId, token } = authFromReq(req);
  if (!userId || !token) return { ok: true, user: null };
  const found = await requireSiteUser(req, { allowBlocked: true });
  if (!found.ok || found.user?.isBlocked) return { ok: true, user: null };
  return found;
}

async function optionalAdmin(req) {
  const { adminId, email } = authFromReq(req);
  if (!adminId || !email) return { ok: true, admin: null };
  const found = await requireAdmin(req);
  if (!found.ok) return { ok: true, admin: null };
  return found;
}

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function canSendOtp(destination) {
  const last = otpSendCooldown.get(destination);
  if (last && Date.now() - last < 60 * 1000) {
    const wait = Math.ceil((60 * 1000 - (Date.now() - last)) / 1000);
    return { ok: false, wait };
  }
  return { ok: true };
}

function markOtpSent(destination) {
  otpSendCooldown.set(destination, Date.now());
}

async function sendOtpEmail(email, otp, purpose) {
  const action = purpose === "login" ? "log in" : "create your account";
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 28px; border: 1px solid #eee; border-radius: 16px;">
      <h2 style="color: #1a73e8; text-align: center; margin-bottom: 8px;">CogniCode EduTech</h2>
      <p style="text-align: center; color: #555;">Your one-time password to ${action}</p>
      <div style="text-align: center; margin: 28px 0;">
        <span style="font-size: 32px; letter-spacing: 8px; font-weight: bold; color: #1a73e8;">${otp}</span>
      </div>
      <p style="text-align: center; color: #d32f2f; font-weight: bold;">Valid for 10 minutes.</p>
      <p style="text-align: center; color: #777; font-size: 13px;">If you did not request this, you can ignore this email.</p>
    </div>
  `;
  await transporter.sendMail({
    from: `"CogniCode EduTech" <${process.env.SENDER_EMAIL || process.env.SMTP_USER}>`,
    to: email,
    subject: `Your CogniCode OTP is ${otp}`,
    html,
  });
}

async function sendOtpSms(mobile, otp) {
  const text = `Your CogniCode verification code is ${otp}. Valid for 10 minutes. Do not share this code.`;
  const providers = [];

  if (process.env.FAST2SMS_API_KEY && String(mobile).startsWith("91")) {
    providers.push(async () => {
      const url = new URL("https://www.fast2sms.com/dev/bulkV2");
      url.searchParams.set("authorization", process.env.FAST2SMS_API_KEY);
      url.searchParams.set("route", "otp");
      url.searchParams.set("variables_values", otp);
      url.searchParams.set("flash", "0");
      url.searchParams.set("numbers", mobile.replace(/^91/, "") || mobile);
      const res = await fetch(url.toString(), { method: "GET" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.return === false) {
        throw new Error(data.message || "Fast2SMS rejected the request");
      }
    });
  }

  if (process.env.MSG91_AUTH_KEY) {
    providers.push(async () => {
      const url = new URL("https://control.msg91.com/api/v5/otp");
      url.searchParams.set("otp", otp);
      url.searchParams.set("mobile", mobile);
      url.searchParams.set("authkey", process.env.MSG91_AUTH_KEY);
      if (process.env.MSG91_TEMPLATE_ID) {
        url.searchParams.set("template_id", process.env.MSG91_TEMPLATE_ID);
      }
      const res = await fetch(url.toString(), { method: "GET" });
      if (!res.ok) throw new Error("MSG91 rejected the request");
    });
  }

  if (
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_PHONE
  ) {
    providers.push(async () => {
      const sid = process.env.TWILIO_ACCOUNT_SID;
      const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString(
        "base64"
      );
      const body = new URLSearchParams({
        From: process.env.TWILIO_PHONE,
        To: `+${mobile}`,
        Body: text,
      });
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
        }
      );
      if (!res.ok) {
        const err = await res.text();
        throw new Error(err || "Twilio rejected the request");
      }
    });
  }

  if (!providers.length) {
    const err = new Error(
      "SMS is not configured. Set FAST2SMS_API_KEY, MSG91_AUTH_KEY, or Twilio keys."
    );
    err.code = "SMS_NOT_CONFIGURED";
    throw err;
  }

  let lastError = null;
  for (const send of providers) {
    try {
      await send();
      return;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error("Failed to send SMS OTP");
}

async function storeOtp({ channel, destination, purpose }) {
  const otp = generateOtp();
  const otpHash = await bcrypt.hash(otp, 8);
  await cognicodePool.query(
    `UPDATE "site_user_otps" SET consumed = TRUE WHERE destination = $1 AND consumed = FALSE`,
    [destination]
  );
  await cognicodePool.query(
    `
      INSERT INTO "site_user_otps"
        ("channel", destination, "otpHash", purpose, "expiresAt")
      VALUES ($1, $2, $3, $4, NOW() + INTERVAL '10 minutes')
    `,
    [channel, destination, otpHash, purpose]
  );
  return otp;
}

async function consumeOtp({ destination, otp, purpose }) {
  const result = await cognicodePool.query(
    `
      SELECT * FROM "site_user_otps"
      WHERE destination = $1 AND purpose = $2 AND consumed = FALSE
      ORDER BY "created_at" DESC
      LIMIT 1
    `,
    [destination, purpose]
  );
  if (result.rows.length === 0) {
    return { ok: false, message: "No OTP found. Please request a new one." };
  }
  const row = result.rows[0];
  if (new Date(row.expiresAt).getTime() < Date.now()) {
    await cognicodePool.query(`UPDATE "site_user_otps" SET consumed = TRUE WHERE id = $1`, [
      row.id,
    ]);
    return { ok: false, message: "OTP has expired. Please request a new one." };
  }
  if (Number(row.attempts) >= 5) {
    await cognicodePool.query(`UPDATE "site_user_otps" SET consumed = TRUE WHERE id = $1`, [
      row.id,
    ]);
    return { ok: false, message: "Too many attempts. Request a new OTP." };
  }
  const match = await bcrypt.compare(String(otp), row.otpHash);
  await cognicodePool.query(
    `UPDATE "site_user_otps" SET attempts = attempts + 1 WHERE id = $1`,
    [row.id]
  );
  if (!match) {
    return { ok: false, message: "Invalid OTP" };
  }
  await cognicodePool.query(`UPDATE "site_user_otps" SET consumed = TRUE WHERE id = $1`, [
    row.id,
  ]);
  return { ok: true };
}

async function createSession(user, req) {
  const token = crypto.randomBytes(32).toString("hex");
  await cognicodePool.query(
    `
      INSERT INTO "site_user_sessions" ("userId", token, "userAgent", ip)
      VALUES ($1, $2, $3, $4)
    `,
    [user.userId, token, req.headers["user-agent"] || "", clientIp(req)]
  );
  await cognicodePool.query(
    `
      UPDATE "site_users"
      SET "lastLoginAt" = CURRENT_TIMESTAMP,
          "lastSeenAt" = CURRENT_TIMESTAMP,
          "loginCount" = COALESCE("loginCount", 0) + 1
      WHERE "userId" = $1
    `,
    [user.userId]
  );
  return token;
}

async function findUserByIdentifier(identifier) {
  const raw = String(identifier || "").trim();
  if (!raw) return null;
  if (raw.includes("@")) {
    const result = await cognicodePool.query(
      `SELECT * FROM "site_users" WHERE email = $1 LIMIT 1`,
      [normalizeEmail(raw)]
    );
    return result.rows[0] || null;
  }
  const username = normalizeUsername(raw);
  const result = await cognicodePool.query(
    `SELECT * FROM "site_users" WHERE LOWER(username) = $1 LIMIT 1`,
    [username]
  );
  return result.rows[0] || null;
}

function isValidPassword(value) {
  return String(value || "").length >= 8;
}

async function hashPassword(value) {
  return bcrypt.hash(String(value), 10);
}

async function verifyPassword(value, hash) {
  if (!hash) return false;
  return bcrypt.compare(String(value), hash);
}

async function sendBlockedEmail(email, { username, reason } = {}) {
  if (!email) return;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 28px; border: 1px solid #eee; border-radius: 16px;">
      <h2 style="color: #78025F; text-align: center;">Account locked</h2>
      <p style="color: #444; line-height: 1.6;">
        Hello${username ? ` @${username}` : ""},
      </p>
      <p style="color: #444; line-height: 1.6;">
        Your CogniCode member account has been locked by an administrator.
        You cannot log in or register again with this email until the lock is removed.
      </p>
      <p style="color: #444; line-height: 1.6;">
        <strong>Reason:</strong> ${reason || "Blocked by admin"}
      </p>
      <p style="color: #777; font-size: 13px;">
        If you believe this is a mistake, reply to this email or contact CogniCode support.
      </p>
    </div>
  `;
  await transporter.sendMail({
    from: `"CogniCode EduTech" <${process.env.SENDER_EMAIL || process.env.SMTP_USER}>`,
    to: email,
    subject: "Your CogniCode account has been locked",
    html,
  });
}

async function findUserByDestination(channel, destination) {
  if (channel === "email") {
    const result = await cognicodePool.query(
      `SELECT * FROM "site_users" WHERE email = $1 LIMIT 1`,
      [destination]
    );
    return result.rows[0] || null;
  }
  const result = await cognicodePool.query(
    `SELECT * FROM "site_users" WHERE mobile = $1 LIMIT 1`,
    [destination]
  );
  return result.rows[0] || null;
}

async function usernameSuggestions(base) {
  const clean = normalizeUsername(base) || "scholar";
  const candidates = [
    clean,
    `${clean}${Math.floor(10 + Math.random() * 89)}`,
    `${clean}_${Math.floor(100 + Math.random() * 899)}`,
    `${clean}${new Date().getFullYear()}`,
  ].filter(isValidUsername);
  const available = [];
  for (const name of candidates) {
    const exists = await cognicodePool.query(
      `SELECT 1 FROM "site_users" WHERE LOWER(username) = $1 LIMIT 1`,
      [name]
    );
    if (exists.rows.length === 0) available.push(name);
    if (available.length >= 3) break;
  }
  return available;
}

module.exports = {
  publicUser,
  normalizeEmail,
  normalizeCountryCode,
  normalizeMobile,
  maskDestination,
  isValidEmail,
  isValidMobile,
  normalizeUsername,
  isValidUsername,
  clientIp,
  authFromReq,
  requireAdmin,
  requireSiteUser,
  optionalSiteUser,
  optionalAdmin,
  canSendOtp,
  markOtpSent,
  sendOtpEmail,
  sendOtpSms,
  storeOtp,
  consumeOtp,
  createSession,
  findUserByDestination,
  findUserByIdentifier,
  isValidPassword,
  hashPassword,
  verifyPassword,
  sendBlockedEmail,
  usernameSuggestions,
};
