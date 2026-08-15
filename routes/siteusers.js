const express = require("express");
const router = express.Router();
const { initializeSiteUsersDB } = require("./init");
const cognicodePool = require("./CognicodePool");
const {
  publicUser,
  normalizeEmail,
  normalizeCountryCode,
  normalizeMobile,
  maskDestination,
  isValidEmail,
  isValidMobile,
  normalizeUsername,
  isValidUsername,
  requireAdmin,
  requireSiteUser,
  canSendOtp,
  markOtpSent,
  sendOtpEmail,
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
} = require("./site-helpers");
const { emitToSiteUser } = require("./blog-realtime");

initializeSiteUsersDB();

router.get("/", (_req, res) => {
  res.json({
    success: true,
    message: "Site users API",
    endpoints: [
      "POST /site-users/send-otp",
      "POST /site-users/login",
      "POST /site-users/register",
      "GET /site-users/username-available",
    ],
  });
});

router.get("/health", (_req, res) => {
  res.json({ success: true, message: "Site users API" });
});

function allowLocalOtpFallback() {
  if (process.env.OTP_DEV_FALLBACK === "true") return true;
  if (process.env.OTP_DEV_FALLBACK === "false") return false;
  const host = String(process.env.PG_HOST || "localhost").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "";
}

function resolveDestination(channel, raw, countryCode) {
  if (channel === "email") {
    const destination = normalizeEmail(raw);
    if (!isValidEmail(destination)) {
      return { ok: false, message: "Enter a valid email address" };
    }
    return { ok: true, destination, countryCode: null };
  }
  if (channel === "mobile") {
    const cc = normalizeCountryCode(countryCode) || "91";
    const destination = normalizeMobile(raw, cc);
    if (!isValidMobile(destination)) {
      return { ok: false, message: "Enter a valid mobile number for the selected country" };
    }
    return { ok: true, destination, countryCode: cc };
  }
  return { ok: false, message: "Choose email or mobile" };
}

router.post("/send-otp", async (req, res) => {
  const channel = String(req.body.channel || "").trim();
  const purpose = String(req.body.purpose || "login").trim();
  const resolved = resolveDestination(
    channel,
    req.body.destination,
    req.body.countryCode
  );

  if (!resolved.ok) {
    return res.status(400).json({ success: false, message: resolved.message });
  }
  if (purpose !== "register") {
    return res.status(400).json({
      success: false,
      message: "OTP is only used to verify new accounts. Log in with username/email and password.",
    });
  }

  const { destination } = resolved;

  try {
    const existing = await findUserByDestination(channel, destination);

    if (existing?.isBlocked) {
      return res.status(403).json({
        success: false,
        message:
          existing.blockedReason ||
          "This email is locked by CogniCode admin. You cannot register with it.",
        blocked: true,
      });
    }
    if (existing) {
      return res.status(409).json({
        success: false,
        message: "An account already exists. Please log in with your password.",
        needsLogin: true,
      });
    }

    const actualPurpose = "register";
    const cooldown = canSendOtp(destination);
    if (!cooldown.ok) {
      return res.status(429).json({
        success: false,
        message: `Wait ${cooldown.wait}s before requesting another OTP`,
      });
    }

    const otp = await storeOtp({ channel, destination, purpose: actualPurpose });

    if (channel === "email") {
      try {
        await sendOtpEmail(destination, otp, actualPurpose);
      } catch (emailErr) {
        console.error("❌ Email OTP error:", emailErr.message);
        if (allowLocalOtpFallback()) {
          console.log(`📧 Local email OTP for ${destination}: ${otp}`);
          markOtpSent(destination);
          return res.json({
            success: true,
            message: `Could not send email locally. Your test OTP is ${otp}`,
            destinationMasked: maskDestination(channel, destination),
            channel,
            purpose: actualPurpose,
            exists: Boolean(existing),
            isNewUser: !existing,
            devOtp: otp,
          });
        }
        return res.status(500).json({
          success: false,
          message:
            "Could not send the OTP email. Check SMTP_USER / SMTP_PASS, or try again shortly.",
        });
      }
    } else {
      return res.status(400).json({
        success: false,
        message: "Sign in with email. Mobile OTP is not available.",
      });
    }

    markOtpSent(destination);
    return res.json({
      success: true,
      message: `OTP sent to ${maskDestination(channel, destination)}`,
      destinationMasked: maskDestination(channel, destination),
      channel,
      purpose: actualPurpose,
      exists: Boolean(existing),
      isNewUser: !existing,
    });
  } catch (error) {
    console.error("❌ send-otp error:", error);
    return res.status(500).json({ success: false, message: "Failed to send OTP" });
  }
});

router.post("/login", async (req, res) => {
  const identifier = String(req.body.identifier || req.body.destination || "").trim();
  const password = String(req.body.password || "");

  if (!identifier) {
    return res.status(400).json({
      success: false,
      message: "Enter your username or email",
    });
  }
  if (!password) {
    return res.status(400).json({ success: false, message: "Enter your password" });
  }

  try {
    const user = await findUserByIdentifier(identifier);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "No account found. Create one with Sign up.",
        needsRegister: true,
      });
    }
    if (user.isBlocked) {
      return res.status(403).json({
        success: false,
        message:
          user.blockedReason ||
          "This account has been locked by CogniCode admin. You cannot log in.",
        blocked: true,
      });
    }
    if (!user.passwordHash) {
      return res.status(400).json({
        success: false,
        message:
          "This account has no password yet. Sign up again with a new email, or contact support.",
      });
    }
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      return res.status(400).json({ success: false, message: "Incorrect username/email or password" });
    }

    const token = await createSession(user, req);
    return res.json({
      success: true,
      message: `Welcome back, @${user.username}`,
      user: { ...publicUser(user), token },
    });
  } catch (error) {
    console.error("❌ login error:", error);
    return res.status(500).json({ success: false, message: "Login failed" });
  }
});

router.post("/register", async (req, res) => {
  const email = normalizeEmail(req.body.email || req.body.destination);
  const password = String(req.body.password || "");
  const otp = String(req.body.otp || "").trim();
  const username = normalizeUsername(req.body.username);
  const displayName = String(req.body.displayName || username).trim().slice(0, 80);

  if (!isValidEmail(email)) {
    return res.status(400).json({ success: false, message: "Enter a valid email address" });
  }
  if (!/^\d{6}$/.test(otp)) {
    return res.status(400).json({ success: false, message: "Enter the 6-digit email OTP" });
  }
  if (!isValidPassword(password)) {
    return res.status(400).json({
      success: false,
      message: "Password must be at least 8 characters",
    });
  }
  if (!isValidUsername(username)) {
    return res.status(400).json({
      success: false,
      message:
        "Username must be 3–30 characters, letters/numbers/._ only, and cannot start or end with . or _",
    });
  }

  try {
    const checked = await consumeOtp({
      destination: email,
      otp,
      purpose: "register",
    });
    if (!checked.ok) {
      return res.status(400).json({ success: false, message: checked.message });
    }

    const existingDest = await findUserByDestination("email", email);
    if (existingDest?.isBlocked) {
      return res.status(403).json({
        success: false,
        message:
          existingDest.blockedReason ||
          "This email is locked by CogniCode admin. You cannot register again with it.",
        blocked: true,
      });
    }
    if (existingDest) {
      return res.status(409).json({
        success: false,
        message: "An account already exists. Please log in.",
        needsLogin: true,
      });
    }

    const taken = await cognicodePool.query(
      `SELECT 1 FROM "site_users" WHERE LOWER(username) = $1 LIMIT 1`,
      [username]
    );
    if (taken.rows.length) {
      const suggestions = await usernameSuggestions(username);
      return res.status(409).json({
        success: false,
        message: "That username is taken",
        suggestions,
      });
    }

    const passwordHash = await hashPassword(password);
    const inserted = await cognicodePool.query(
      `
        INSERT INTO "site_users"
          (username, "displayName", email, mobile, channel, "countryCode", "passwordHash", "lastLoginAt", "lastSeenAt", "loginCount")
        VALUES ($1, $2, $3, NULL, 'email', NULL, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0)
        RETURNING *
      `,
      [username, displayName || username, email, passwordHash]
    );

    const user = inserted.rows[0];
    const token = await createSession(user, req);
    return res.status(201).json({
      success: true,
      message: `Welcome, @${user.username}`,
      user: { ...publicUser(user), token },
    });
  } catch (error) {
    console.error("❌ register error:", error);
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "Username or contact is already in use",
      });
    }
    return res.status(500).json({ success: false, message: "Could not create account" });
  }
});

router.get("/username-available", async (req, res) => {
  const username = normalizeUsername(req.query.username);
  if (!username) {
    return res.json({ success: true, available: false, message: "Enter a username" });
  }
  if (!isValidUsername(username)) {
    return res.json({
      success: true,
      available: false,
      message: "Use 3–30 letters, numbers, period or underscore",
    });
  }
  try {
    const taken = await cognicodePool.query(
      `SELECT 1 FROM "site_users" WHERE LOWER(username) = $1 LIMIT 1`,
      [username]
    );
    if (taken.rows.length) {
      return res.json({
        success: true,
        available: false,
        message: "Username is taken",
        suggestions: await usernameSuggestions(username),
      });
    }
    return res.json({ success: true, available: true, username });
  } catch (error) {
    console.error("❌ username-available error:", error);
    return res.status(500).json({ success: false, message: "Could not check username" });
  }
});

router.post("/me", async (req, res) => {
  try {
    const auth = await requireSiteUser(req);
    if (!auth.ok) {
      return res.status(auth.status).json({ success: false, message: auth.message });
    }
    return res.json({ success: true, user: publicUser(auth.user) });
  } catch (error) {
    console.error("❌ me error:", error);
    return res.status(500).json({ success: false, message: "Failed to load profile" });
  }
});

router.post("/logout", async (req, res) => {
  try {
    const auth = await requireSiteUser(req, { allowBlocked: true });
    if (auth.ok) {
      const { userId, token } = req.body || {};
      await cognicodePool.query(
        `DELETE FROM "site_user_sessions" WHERE "userId" = $1 AND token = $2`,
        [userId || auth.user.userId, token]
      );
    }
    return res.json({ success: true, message: "Logged out" });
  } catch (error) {
    console.error("❌ logout error:", error);
    return res.json({ success: true, message: "Logged out" });
  }
});

router.post("/admin/init-tables", async (req, res) => {
  try {
    const admin = await requireAdmin(req);
    if (!admin.ok) {
      return res.status(admin.status).json({ success: false, message: admin.message });
    }
    await initializeSiteUsersDB();
    return res.json({
      success: true,
      message: "User and engagement tables are ready",
      tables: [
        "site_users",
        "site_user_otps",
        "site_user_sessions",
        "blog_likes",
        "blog_comments",
        "blog_shares",
        "blog_visits",
      ],
    });
  } catch (error) {
    console.error("❌ init-tables error:", error);
    return res.status(500).json({ success: false, message: "Could not initialize tables" });
  }
});

router.get("/admin/users", async (req, res) => {
  try {
    const admin = await requireAdmin(req);
    if (!admin.ok) {
      return res.status(admin.status).json({ success: false, message: admin.message });
    }

    const q = String(req.query.q || "").trim();
    const status = String(req.query.status || "all");
    const values = [];
    const where = [];

    if (q) {
      values.push(`%${q.toLowerCase()}%`);
      where.push(
        `(LOWER(u.username) LIKE $${values.length} OR LOWER(COALESCE(u.email, '')) LIKE $${values.length} OR COALESCE(u.mobile, '') LIKE $${values.length} OR LOWER(COALESCE(u."displayName", '')) LIKE $${values.length})`
      );
    }
    if (status === "blocked") where.push(`u."isBlocked" = TRUE`);
    if (status === "active") where.push(`u."isBlocked" = FALSE`);
    if (status === "logged-in") where.push(`u."lastLoginAt" IS NOT NULL`);

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const result = await cognicodePool.query(
      `
        SELECT
          u.*,
          COALESCE(l.likes, 0)::int AS "likeCount",
          COALESCE(c.comments, 0)::int AS "commentCount",
          COALESCE(s.shares, 0)::int AS "shareCount",
          COALESCE(v.visits, 0)::int AS "visitCount",
          v."lastVisitAt",
          v."lastVisitedSlug"
        FROM "site_users" u
        LEFT JOIN (
          SELECT "userId", COUNT(*)::int AS likes
          FROM "blog_likes" GROUP BY "userId"
        ) l ON l."userId" = u."userId"
        LEFT JOIN (
          SELECT "userId", COUNT(*)::int AS comments
          FROM "blog_comments" GROUP BY "userId"
        ) c ON c."userId" = u."userId"
        LEFT JOIN (
          SELECT "userId", COUNT(*)::int AS shares
          FROM "blog_shares" GROUP BY "userId"
        ) s ON s."userId" = u."userId"
        LEFT JOIN (
          SELECT
            "userId",
            COUNT(*)::int AS visits,
            MAX("created_at") AS "lastVisitAt",
            (ARRAY_AGG("postSlug" ORDER BY "created_at" DESC))[1] AS "lastVisitedSlug"
          FROM "blog_visits"
          WHERE "userId" IS NOT NULL
          GROUP BY "userId"
        ) v ON v."userId" = u."userId"
        ${whereSql}
        ORDER BY COALESCE(u."lastLoginAt", u."created_at") DESC
        LIMIT 500
      `,
      values
    );

    const summary = await cognicodePool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE "lastLoginAt" IS NOT NULL)::int AS loggedIn,
        COUNT(*) FILTER (WHERE "isBlocked" = TRUE)::int AS blocked,
        COUNT(*) FILTER (WHERE "lastLoginAt" >= NOW() - INTERVAL '1 day')::int AS last24h
      FROM "site_users"
    `);

    return res.json({
      success: true,
      data: result.rows.map((row) => ({
        ...publicUser(row),
        likeCount: row.likeCount,
        commentCount: row.commentCount,
        shareCount: row.shareCount,
        visitCount: row.visitCount,
        lastVisitAt: row.lastVisitAt,
        lastVisitedSlug: row.lastVisitedSlug,
        blockedReason: row.blockedReason || null,
        blockedAt: row.blockedAt || null,
      })),
      summary: summary.rows[0],
    });
  } catch (error) {
    console.error("❌ admin users error:", error);
    return res.status(500).json({ success: false, message: "Could not load users" });
  }
});

router.get("/admin/users/:id", async (req, res) => {
  try {
    const admin = await requireAdmin(req);
    if (!admin.ok) {
      return res.status(admin.status).json({ success: false, message: admin.message });
    }
    const userId = Number(req.params.id);
    const userRes = await cognicodePool.query(
      `SELECT * FROM "site_users" WHERE "userId" = $1`,
      [userId]
    );
    if (!userRes.rows.length) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const [likes, comments, shares, visits] = await Promise.all([
      cognicodePool.query(
        `SELECT "postSlug", "created_at" FROM "blog_likes" WHERE "userId" = $1 ORDER BY "created_at" DESC LIMIT 50`,
        [userId]
      ),
      cognicodePool.query(
        `SELECT id, "postSlug", body, "created_at" FROM "blog_comments" WHERE "userId" = $1 ORDER BY "created_at" DESC LIMIT 50`,
        [userId]
      ),
      cognicodePool.query(
        `SELECT "postSlug", channel, "created_at" FROM "blog_shares" WHERE "userId" = $1 ORDER BY "created_at" DESC LIMIT 50`,
        [userId]
      ),
      cognicodePool.query(
        `SELECT "postSlug", path, ip, "created_at" FROM "blog_visits" WHERE "userId" = $1 ORDER BY "created_at" DESC LIMIT 80`,
        [userId]
      ),
    ]);

    return res.json({
      success: true,
      data: {
        user: publicUser(userRes.rows[0]),
        likes: likes.rows,
        comments: comments.rows,
        shares: shares.rows,
        visits: visits.rows,
      },
    });
  } catch (error) {
    console.error("❌ admin user detail error:", error);
    return res.status(500).json({ success: false, message: "Could not load user activity" });
  }
});

router.post("/admin/users/:id/block", async (req, res) => {
  try {
    const admin = await requireAdmin(req);
    if (!admin.ok) {
      return res.status(admin.status).json({ success: false, message: admin.message });
    }
    const userId = Number(req.params.id);
    const reason = String(req.body.reason || "Blocked by admin").slice(0, 300);
    const result = await cognicodePool.query(
      `
        UPDATE "site_users"
        SET "isBlocked" = TRUE,
            "blockedAt" = CURRENT_TIMESTAMP,
            "blockedReason" = $2,
            "updated_at" = CURRENT_TIMESTAMP
        WHERE "userId" = $1
        RETURNING *
      `,
      [userId, reason]
    );
    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    await cognicodePool.query(`DELETE FROM "site_user_sessions" WHERE "userId" = $1`, [
      userId,
    ]);
    const blockedUser = result.rows[0];
    emitToSiteUser(userId, "site-user:blocked", {
      userId,
      blocked: true,
      message:
        reason ||
        "This account has been locked by CogniCode admin. You cannot log in or register with this email.",
    });
    if (blockedUser.email) {
      sendBlockedEmail(blockedUser.email, {
        username: blockedUser.username,
        reason,
      }).catch((err) => console.warn("Block email skipped:", err.message));
    }
    return res.json({
      success: true,
      message: `@${blockedUser.username} is blocked and cannot log in`,
      user: publicUser(blockedUser),
    });
  } catch (error) {
    console.error("❌ block user error:", error);
    return res.status(500).json({ success: false, message: "Could not block user" });
  }
});

router.post("/admin/users/:id/unblock", async (req, res) => {
  try {
    const admin = await requireAdmin(req);
    if (!admin.ok) {
      return res.status(admin.status).json({ success: false, message: admin.message });
    }
    const userId = Number(req.params.id);
    const result = await cognicodePool.query(
      `
        UPDATE "site_users"
        SET "isBlocked" = FALSE,
            "blockedAt" = NULL,
            "blockedReason" = NULL,
            "updated_at" = CURRENT_TIMESTAMP
        WHERE "userId" = $1
        RETURNING *
      `,
      [userId]
    );
    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    return res.json({
      success: true,
      message: `@${result.rows[0].username} can log in again`,
      user: publicUser(result.rows[0]),
    });
  } catch (error) {
    console.error("❌ unblock user error:", error);
    return res.status(500).json({ success: false, message: "Could not unblock user" });
  }
});

module.exports = router;
