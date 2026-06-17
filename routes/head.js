var express = require("express");
var router = express.Router();
var initializeDatabase1 = require("./init").initializeDatabase1;
var pgPool = require("./PostgreSQLPool");
var upload = require("./multer");
// Add these imports for JWT
const jwt = require("jsonwebtoken");
require("dotenv").config(); // Load .env vars (JWT_ACCESS_TOKEN)
const nodemailer = require('nodemailer');

const JWT_ACCESS_TOKEN = process.env.JWT_ACCESS_TOKEN;
const JWT_REFRESH_TOKEN = process.env.JWT_REFRESH_TOKEN;
const otpStore = new Map();

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: process.env.SMTP_SECURE === 'true',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});
initializeDatabase1();

const generateSecurityKey = () => Math.random().toString(36).substring(2, 10).toUpperCase();


// Professional OTP Email (same design for all users)
const sendProfessionalOTPEmail = async (email, otp, userType = "User") => {
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 30px; border: 1px solid #e0e0e0; border-radius: 12px; background: #f9f9f9;">
      <h2 style="color: #1a73e8; text-align: center;">CogniCode Project Management</h2>
      <h3 style="color: #333; text-align: center;">Your Registration OTP</h3>
      <p style="font-size: 16px; color: #555;">Hello,</p>
      <p style="font-size: 16px; color: #555;">Your one-time password for ${userType} registration is:</p>
      <div style="text-align: center; margin: 30px 0;">
        <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #1a73e8; background: #fff; padding: 15px 30px; border-radius: 8px; border: 2px solid #1a73e8;">${otp}</span>
      </div>
      <p style="color: #d32f2f; text-align: center; font-weight: bold;">This OTP is valid for 10 minutes.</p>
      <p style="font-size: 14px; color: #777; text-align: center;">If you did not request this, please ignore this email.</p>
      <hr style="border: 0; border-top: 1px solid #eee; margin: 30px 0;">
      <p style="text-align: center; font-size: 12px; color: #999;">© 2026 CogniCode • All Rights Reserved</p>
    </div>
  `;

  await transporter.sendMail({
    from: process.env.SENDER_EMAIL,
    to: email,
    subject: `Your ${userType} Registration OTP - CogniCode`,
    html
  });
};

const sendConfirmationEmail = async (email, name, securityKey) => {
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 30px; border: 1px solid #e0e0e0; border-radius: 12px; background: #f9f9f9;">
      <h2 style="color: #34a853; text-align: center;">✅ Registration Completed!</h2>
      <h3 style="color: #333; text-align: center;">Welcome to CogniCode, ${name}!</h3>
      <p style="font-size: 16px; color: #555;">Your Head account has been successfully registered.</p>
      <table style="width:100%; border-collapse:collapse; margin:20px 0; background:white; border-radius:8px; overflow:hidden;">
        <tr><td style="padding:15px; font-weight:bold; background:#f1f3f5;">Security Key</td><td style="padding:15px; font-size:18px; font-weight:bold; color:#1a73e8;">${securityKey}</td></tr>
      </table>
      <p style="color: #d32f2f; text-align:center; font-weight:bold;">Keep this Security Key safe — you will need it to login.</p>
      <p style="text-align:center; margin:30px 0;">
        <a href="${process.env.FRONTEND_URL || 'http://187.77.184.39:5173/'}" 
           style="background:#34a853; color:white; padding:14px 32px; text-decoration:none; border-radius:8px; font-weight:bold;">Go to Login</a>
      </p>
      <hr style="border:0; border-top:1px solid #eee; margin:30px 0;">
      <p style="text-align:center; font-size:12px; color:#999;">CogniCode Project Management</p>
    </div>
  `;

  await transporter.sendMail({
    from: process.env.SENDER_EMAIL,
    to: email,
    subject: "🎉 Head Registration Successful - CogniCode",
    html
  });
};

router.post("/register_head", upload.single("headPic"), async (req, res) => {
  console.log("🔥 REGISTER HEAD - Full request body received:", JSON.stringify(req.body, null, 2));
  console.log("📸 File received:", req.file ? req.file.filename : "No photo uploaded");

  const { name, email, mobile, password } = req.body;
  const photoFilename = req.file ? req.file.filename : null;

  // Rate limit: 1 minute (60 seconds)
  const pending = otpStore.get(email);
  if (pending && Date.now() - pending.timestamp < 60000) {
    console.log(`Rate limit triggered for Head ${email}. Please wait 1 minute before resending OTP.`);
    return res.status(429).json({ 
      status: false, 
      message: "Please wait 1 minute before resending OTP." 
    });
  }

  if (!name || !email || !password) {
    console.log("❌ 400 Error: Missing required fields");
    return res.status(400).json({ 
      status: false, 
      message: "Name, Email and Password are required." 
    });
  }

  if (email !== process.env.HEAD_MAIL) {
    console.log("❌ 400 Error: Email mismatch");
    return res.status(400).json({ 
      status: false, 
      message: `Invalid or unauthorized email. Must use: ${process.env.HEAD_MAIL}` 
    });
  }

  // Check if already registered
  const existing = await pgPool.query('SELECT password FROM "Entities".head WHERE "headMail" = $1', [email]);
  if (existing.rows[0]?.password) {
    console.log("❌ 400 Error: Head already registered");
    return res.status(400).json({ 
      status: false, 
      message: "Head account already registered." 
    });
  }

  console.log("✅ All validation passed. Generating OTP...");

  const otp = Math.floor(100000 + Math.random() * 900000).toString();

  otpStore.set(email, {
    otp,
    expiry: Date.now() + 10 * 60 * 1000,
    tempData: { name, mobile, password, photoFilename }
  });

  try {
    await sendProfessionalOTPEmail(email, otp, "Head");
    console.log("✅ OTP email sent successfully to:", email);
    res.json({ status: true, message: "OTP sent to your email." });
  } catch (e) {
    console.error("❌ Failed to send OTP email:", e);
    res.status(500).json({ status: false, message: "Failed to send OTP." });
  }
});

router.post("/verify_head_otp", async (req, res) => {
  const { email, otp } = req.body;
  const record = otpStore.get(email);

  if (!record || record.otp !== otp || Date.now() > record.expiry) {
    return res.status(400).json({ status: false, message: "Invalid or expired OTP." });
  }

  const { name, mobile, password, photoFilename } = record.tempData;
  const securityKey = generateSecurityKey();

  try {
    await pgPool.query(`
      UPDATE "Entities".head 
      SET "headName" = $1, 
          "headMobile" = $2, 
          "password" = $3, 
          "headSecurityKey" = $4,
          "headPic" = $5
      WHERE "headMail" = $6
    `, [name, mobile, password, securityKey, photoFilename, email]);

    otpStore.delete(email);

    await sendConfirmationEmail(email, name, securityKey);

    res.json({ status: true, message: "Registration completed! Security key sent to your email." });
  } catch (e) {
    console.error("Error in verify_head_otp:", e);
    res.status(500).json({ status: false, message: "Registration failed." });
  }
});

router.post("/check_login_head", function (req, res) {
  console.log("🔥 HEAD LOGIN RECEIVED:", req.body);

  try {
    const { name, password, securityKey } = req.body;

    // Updated validation - only 3 fields required
    if (!name || !password || !securityKey) {
      console.log("❌ Missing required fields for Head login");
      return res.status(400).json({
        status: false,
        message: "Name/Email, Security Key, and Password are required.",
      });
    }

    // Updated query: 'name' field can be either headName OR headMail
    const query = `
      SELECT * FROM "Entities".head
      WHERE ("headName" = $1 OR "headMail" = $1)
        AND "password" = $2
        AND "headSecurityKey" = $3
    `;

    const values = [name, password, securityKey];

    pgPool.query(query, values, function (error, result) {
      if (error) {
        console.error("Database Error:", error);
        return res.status(400).json({
          status: false,
          message: "Database Error, Please contact the admin.",
        });
      } else if (result.rows.length === 0) {
        console.log("❌ Invalid credentials for Head login");
        return res.status(401).json({
          status: false,
          message: "Invalid Name/Email, Security Key or Password.",
        });
      } else {
        const userData = result.rows[0];

        // Generate JWT tokens
        const accessToken = jwt.sign(
          {
            userId: userData.headId,
            role: "Head",
            name: userData.headName,
          },
          JWT_ACCESS_TOKEN,
          { expiresIn: "15m" }
        );

        const refreshToken = jwt.sign(
          { userId: userData.headId, role: "Head", name: userData.headName },
          JWT_REFRESH_TOKEN,
          { expiresIn: "7d" }
        );

        // Set cookies
      res.cookie("accessToken", accessToken, {
  httpOnly: true,
  secure: true,
  sameSite: "none",
  path: "/",
});

res.cookie("refreshToken", refreshToken, {
  httpOnly: true,
  secure: true,
  sameSite: "none",
  path: "/",
});

        const decodedAccess = jwt.decode(accessToken);
        const accessExp = decodedAccess.exp * 1000;
        const decodedRefresh = jwt.decode(refreshToken);
        const refreshExp = decodedRefresh.exp * 1000;

        console.log("✅ Head login successful for:", userData.headName);

        return res.status(200).json({
          status: true,
          message: "Login successful!",
          data: userData,
          accessExp,
          refreshExp,
        });
      }
    });
  } catch (e) {
    console.error("Server Error in Head Login:", e);
    return res.status(500).json({ status: false, message: "Server Error...!" });
  }
});
// Import auth middleware for protected routes
const { verifyToken } = require("../middleware/auth"); // Adjust path if needed

router.post("/upload_head_image", verifyToken, upload.single("pic"), function (req, res) {
  try {
    // Middleware has verified token from cookie and attached req.user
    console.log("Authenticated user from token:", req.user); // For debugging
    const headId = req.body.headId; // Or enforce req.user.userId for security
    const filename = req.file?.filename;

    if (!headId || !filename) {
      console.error("Missing headId or file:", req.body, req.file);
      return res
        .status(400)
        .json({
          status: false,
          message: "Head ID and image file are required.",
        });
    }

    const query = `
      UPDATE "Entities".head
      SET "headPic" = $1
      WHERE "headId" = $2
    `;
    const values = [filename, headId];

    pgPool.query(query, values, function (error, result) {
      if (error) {
        console.error("Database Error:", error);
        return res
          .status(500)
          .json({
            status: false,
            message: "Database error while updating head image.",
          });
      } else if (result.rowCount === 0) {
        return res
          .status(404)
          .json({ status: false, message: "Head not found." });
      } else {
        return res
          .status(200)
          .json({
            status: true,
            message: "Head image updated successfully!",
            filename,
          });
      }
    });
  } catch (e) {
    console.error("Server Error:", e);
    return res
      .status(500)
      .json({
        status: false,
        message: "Server error while uploading head image.",
      });
  }
});

router.post('/refresh', (req, res) => {
  const refreshToken = req.cookies.refreshToken;
  console.log('Refresh request - Refresh token:', refreshToken ? 'Found' : 'Not found');  // DEBUG

  if (!refreshToken) {
    console.log('No refresh token in cookies');
    return res.status(401).json({ status: false, message: 'No refresh token' });
  }

  try {
    const decoded = jwt.verify(refreshToken, JWT_REFRESH_TOKEN);
    console.log('Refresh token decoded:', decoded.userId);  // DEBUG

    const newAccessToken = jwt.sign(
      { userId: decoded.userId, role: decoded.role, name: decoded.name },
      JWT_ACCESS_TOKEN,
      { expiresIn: '15m' } // Adjusted
    );

    // Rotate refresh token: Generate new one
    const newRefreshToken = jwt.sign(
      { userId: decoded.userId, role: decoded.role, name: decoded.name },
      JWT_REFRESH_TOKEN,
      { expiresIn: '7d' } // Adjusted
    );

  res.cookie("accessToken", newAccessToken, {
  httpOnly: true,
  secure: true,
  sameSite: "none",
  path: "/",
  maxAge: 15 * 60 * 1000,
});

res.cookie("refreshToken", newRefreshToken, {
  httpOnly: true,
  secure: true,
  sameSite: "none",
  path: "/",
  maxAge: 7 * 24 * 60 * 60 * 1000,
});

    // Decode exps to send in response
    const decodedAccess = jwt.decode(newAccessToken);
    const accessExp = decodedAccess.exp * 1000;
    const decodedRefresh = jwt.decode(newRefreshToken);
    const refreshExp = decodedRefresh.exp * 1000;

    console.log('New access token and refresh token set');
    return res.status(200).json({ 
      status: true, 
      message: 'Token refreshed',
      accessExp,
      refreshExp,
    });
  } catch (err) {
    console.error('Refresh token verification failed:', err.message);
    res.clearCookie('accessToken');
    res.clearCookie('refreshToken');
    return res.status(403).json({ status: false, message: 'Invalid refresh token' });
  }
});

// New logout endpoint to clear cookies (access token expires only on logout)
router.post('/logout', (req, res) => {
  res.clearCookie('accessToken');
  res.clearCookie('refreshToken');
  return res.status(200).json({ status: true, message: 'Logged out successfully' });
});

router.get("/fetch_head_data", function (req, res) {
  const query = `
    SELECT "headId", "headName", "headPic" 
    FROM "Entities".head 
    LIMIT 1
  `;

  pgPool.query(query, [], function (error, result) {
    if (error) {
      console.error("Database Error:", error);
      return res
        .status(500)
        .json({
          status: false,
          message: "Database Error, Please contact the admin.",
        });
    } else if (result.rows.length === 0) {
      return res
        .status(404)
        .json({
          status: false,
          message: "No head found.",
        });
    } else {
      return res.status(200).json({
        status: true,
        data: result.rows[0]
      });
    }
  });
});

module.exports = router;