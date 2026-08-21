var express = require('express');
var router = express.Router();
var pgPool = require("./PostgreSQLPool");
var upload = require("./multer");
const bcrypt = require('bcrypt');
const { verifyToken, setAuthCookies, clearAuthCookies, loginTokenResponse, handleTokenRefresh } = require('../middleware/auth');
require('dotenv').config(); // Load environment variables
const jwt = require("jsonwebtoken");
const JWT_ACCESS_TOKEN = process.env.JWT_ACCESS_TOKEN;
const JWT_REFRESH_TOKEN = process.env.JWT_REFRESH_TOKEN || "supersecret";
// SendGrid setup
const nodemailer = require('nodemailer');


// Create transporter
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});
const pendingClients = new Map();

const pendingPasswordResets = new Map();

// Updated sendProfessionalOTPEmail to support Password Reset emails
const sendProfessionalOTPEmail = async (email, otp, userType = "User", purpose = "registration") => {
  const action = purpose === "password_reset" ? "password reset" : "registration";
  const subjectAction = purpose === "password_reset" ? "Password Reset" : "Registration";

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 30px; border: 1px solid #e0e0e0; border-radius: 12px; background: #f9f9f9;">
      <h2 style="color: #1a73e8; text-align: center;">CogniCode Project Management</h2>
      <h3 style="color: #333; text-align: center;">Your ${subjectAction} OTP</h3>
      <p style="font-size: 16px; color: #555;">Hello,</p>
      <p style="font-size: 16px; color: #555;">Your one-time password for ${userType} ${action} is:</p>
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
    subject: `Your ${userType} ${subjectAction} OTP - CogniCode`,
    html
  });
};


router.post('/save_security_key', verifyToken, async function (req, res) {
  const { key_id, name, email, mobile } = req.body;

  try {
    if (!key_id || !name || !email || !mobile) {
      console.log("hhhh", req.body);
      return res.status(400).json({ status: false, message: "key_id, name, email, and mobile are required." });
    }
    const query = `
      INSERT INTO "Entities"."ClientSecureKey" ("key_id", "name", "email", "mobile")
      VALUES ($1, $2, $3, $4);
    `;
    const values = [key_id, name, email, mobile];

    pgPool.query(query, values, function (error, result) {
      if (error) {
        console.error("Database Error:", error);
        return res.status(400).json({ status: false, message: "Database Error: " + error.message });
      } else {
        return res.status(200).json({ status: true, message: "Security key saved successfully!", data: result.rows[0] });
      }
    });
  } catch (e) {
    console.error("Server Error:", e);
    return res.status(500).json({ status: false, message: "Server Error: " + e.message });
  }
});

router.post('/edit_client', verifyToken, async function (req, res) {
  const { key_id, name, email, mobile } = req.body;

  try {
    if (!key_id || !name || !email || !mobile) {
      return res.status(400).json({ status: false, message: "key_id, name, email, and mobile are required." });
    }
    const query = `
      UPDATE "Entities"."ClientSecureKey"
      SET name = $2, email = $3, mobile = $4
      WHERE key_id = $1
      RETURNING key_id, name, email, mobile;
    `;
    const values = [key_id, name, email, mobile];

    const result = await pgPool.query(query, values);
    if (result.rowCount === 0) {
      return res.status(404).json({ status: false, message: "Client not found." });
    }
    return res.status(200).json({
      status: true,
      message: "Client updated successfully!",
      data: result.rows[0]
    });
  } catch (error) {
    console.error("Database Error:", error);
    return res.status(500).json({
      status: false,
      message: "Server Error: " + error.message
    });
  }
});

router.get('/fetch_all_clients', verifyToken, async function (req, res) {
  try {
    let result;
    try {
      result = await pgPool.query(`
        SELECT key_id, name, email, mobile, created_at
        FROM "Entities"."ClientSecureKey"
        ORDER BY created_at DESC NULLS LAST, key_id DESC
      `);
    } catch {
      result = await pgPool.query(`
        SELECT key_id, name, email, mobile
        FROM "Entities"."ClientSecureKey"
        ORDER BY key_id DESC
      `);
    }
    return res.status(200).json({
      status: true,
      data: result.rows,
      message: "Clients fetched successfully!"
    });
  } catch (error) {
    console.error("Database Error:", error);
    return res.status(500).json({
      status: false,
      message: "Server Error: " + error.message
    });
  }
});

router.post('/delete_client', verifyToken, async function (req, res) {
  const { key_id } = req.body;

  try {
    if (!key_id) {
      return res.status(400).json({ status: false, message: "key_id is required." });
    }
    const query = `
      DELETE FROM "Entities"."ClientSecureKey"
      WHERE key_id = $1
      RETURNING key_id;
    `;
    const values = [key_id];

    const result = await pgPool.query(query, values);
    if (result.rowCount === 0) {
      console.log("Client not found for key_id:", key_id);
      return res.status(404).json({ status: false, message: "Client not found." });
    }
    return res.status(200).json({
      status: true,
      message: "Client deleted successfully!",
      data: { key_id }
    });
  } catch (error) {
    console.error("Database Error:", error);
    return res.status(500).json({
      status: false,
      message: "Server Error: " + error.message
    });
  }
});

router.post('/register_client', upload.single("clientPic"), async function (req, res) {
  console.log("✅ NEW DIRECT CLIENT REGISTRATION ROUTE IS RUNNING");   // ← This must appear in server console

  console.log("RECEIVED CLIENT REGISTRATION DATA:", req.body);

  try {
    const {
      clientName,
      clientMail: email,
      mobile,
      requirement,
      password,
      department,
      degree,
      role,
      clientSecurityKey
    } = req.body;

    const filename = req.file?.filename || null;

    if (!email || !password || !clientName || !clientSecurityKey?.trim()) {
      return res.status(400).json({ status: false, message: "Required fields are missing." });
    }

    // 1. Check if email already exists
    const emailCheckResult = await pgPool.query(
      `SELECT "clientMail" FROM "Entities".clients WHERE "clientMail" = $1`,
      [email]
    );
    if (emailCheckResult.rows.length > 0) {
      return res.status(400).json({ status: false, message: "Email is already registered." });
    }

    // 2. Validate security key
    const keyResult = await pgPool.query(`
      SELECT key_id FROM "Entities"."ClientSecureKey"
      WHERE key_id = $1 AND email = $2
    `, [clientSecurityKey.trim(), email]);

    if (keyResult.rows.length === 0) {
      return res.status(400).json({ status: false, message: "Invalid Security Key or Email for Client." });
    }

    // 3. Check if key already used
    const keyUsedResult = await pgPool.query(
      `SELECT "clientSecurityKey" FROM "Entities".clients WHERE "clientSecurityKey" = $1`,
      [clientSecurityKey.trim()]
    );
    if (keyUsedResult.rows.length > 0) {
      return res.status(400).json({ status: false, message: "Security Key has already been used." });
    }

    // 4. Hash password and register directly
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    const insertQuery = `
      INSERT INTO "Entities".clients
      ("clientName", "clientMail", "mobile", "requirement", "password", "department", 
       "degree", "clientPic", "role", "clientSecurityKey") 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `;

    await pgPool.query(insertQuery, [
      clientName,
      email,
      mobile,
      requirement,
      hashedPassword,
      department,
      degree,
      filename,
      role,
      clientSecurityKey.trim()
    ]);

    console.log(`🎉 Client registered successfully: ${email}`);

    return res.status(200).json({ 
      status: true, 
      message: "Client registered successfully!" 
    });

  } catch (e) {
    console.error("Server Error in Client Registration:", e);
    return res.status(500).json({ 
      status: false, 
      message: `Server Error: ${e.message}` 
    });
  }
});

router.post('/upload_client_image', verifyToken, upload.single("pic"), async function (req, res) {
  try {
    const clientId = req.body.clientId;
    const filename = req.file?.filename;

    if (!clientId || !filename) {
      return res.status(400).json({ status: false, message: "Client ID and image file are required." });
    }

    const query = `
      UPDATE "Entities".clients
      SET "clientPic" = $1
      WHERE "clientId" = $2
    `;
    const values = [filename, clientId];

    pgPool.query(query, values, function (error, result) {
      if (error) {
        console.error("Database Error:", error);
        return res.status(500).json({ status: false, message: "Database error while updating client image." });
      } else if (result.rowCount === 0) {
        return res.status(404).json({ status: false, message: "Client not found." });
      } else {
        return res.status(200).json({ status: true, message: "Client image updated successfully!", filename });
      }
    });
  } catch (e) {
    console.error("Server Error:", e);
    return res.status(500).json({ status: false, message: "Server error while uploading client image." });
  }
});

router.post('/verify_client_otp', async function (req, res) {
  const { email, otp } = req.body;

  console.log(`🔍 VERIFY CLIENT OTP - Email: ${email}, OTP: ${otp}`);

  if (!email || !otp) {
    return res.status(400).json({ 
      status: false, 
      message: "Email and OTP are required." 
    });
  }

  const pending = pendingClients.get(email);

  if (!pending) {
    console.log(`❌ No pending registration found for ${email}`);
    return res.status(400).json({ 
      status: false, 
      message: "No pending registration found. Please register again." 
    });
  }

  // Check OTP expiry (10 minutes = 600000 ms)
  if (Date.now() - pending.timestamp > 600000) {
    pendingClients.delete(email);
    console.log(`⏰ OTP expired for ${email}`);
    return res.status(400).json({ 
      status: false, 
      message: "OTP has expired. Please request a new OTP." 
    });
  }

  // Check if OTP is correct
  if (pending.otp !== otp) {
    console.log(`❌ Invalid OTP for ${email}`);
    return res.status(400).json({ 
      status: false, 
      message: "Invalid OTP. Please try again." 
    });
  }

  console.log(`✅ OTP verified successfully for ${email}`);

  try {
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(pending.data.password, saltRounds);

    const query = `
      INSERT INTO "Entities".clients
      ("clientName", "clientMail", "mobile", "requirement", "password", "department", 
       "degree", "clientPic", "role", "clientSecurityKey") 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `;

    const values = [
      pending.data.clientName,
      pending.data.clientMail,
      pending.data.mobile,
      pending.data.requirement,
      hashedPassword,
      pending.data.department,
      pending.data.degree,
      pending.filename,
      pending.data.role,
      pending.data.clientSecurityKey
    ];

    await pgPool.query(query, values);

    // Remove from pending after successful registration
    pendingClients.delete(email);

    console.log(`🎉 Client registration completed for ${email}`);

    return res.status(200).json({ 
      status: true, 
      message: "Client registered successfully!" 
    });

  } catch (error) {
    console.error("Database Error during Client verification:", error);
    return res.status(500).json({ 
      status: false, 
      message: "Database Error. Please contact the admin." 
    });
  }
});

router.post('/verify_client', verifyToken, async function (req, res) {
  const { clientId } = req.body;
  
  console.log("Verify request:", { clientId });
  
  if (!clientId) {
    return res.status(400).json({
      status: false,
      message: "clientId is required."
    });
  }

  try {
    // Query to check if clientId exists
    const query = `
      SELECT "clientId" 
      FROM "Entities".clients 
      WHERE "clientId" = $1
    `;
    const values = [parseInt(clientId)];
    const result = await pgPool.query(query, values);
    
    console.log("Query result:", result.rows);
    
    if (result.rows.length > 0) {
      // Match found
      return res.status(200).json({
        status: true,
        message: "Client verified successfully.",
        data: result.rows[0]
      });
    } else {
      // No match
      return res.status(404).json({
        status: false,
        message: "Client ID does not exist."
      });
    }
  } catch (e) {
    console.error("Server Error in verify client:", e);
    return res.status(500).json({
      status: false,
      message: "Server Error: " + e.message
    });
  }
});

router.post('/check_login_client', async function (req, res) {
  console.log("LOGIN DATA RECEIVED:", req.body);

  try {
    const { role, password, name, clientSecurityKey } = req.body;

    if (!role || !password || !name || !clientSecurityKey) {
      return res.status(400).json({ status: false, message: "Role, Name/Email, Password, and Client Security Key are required." });
    }

    const query = `
      SELECT * FROM "Entities".clients
      WHERE role = $1
      AND ("clientName" = $2 OR "clientMail" = $2)
      AND "clientSecurityKey" = $3
    `;

    const values = [role, name, clientSecurityKey];

    pgPool.query(query, values, async function (error, result) {
      if (error) {
        console.error("Database Error:", error);
        return res.status(400).json({ status: false, message: "Database Error, Please contact the admin." });
      } else if (result.rows.length === 0) {
        return res.status(401).json({ status: false, message: "Invalid credentials or security key." });
      } else {
        const user = result.rows[0];
        const passwordMatch = await bcrypt.compare(password, user.password);
        if (!passwordMatch) {
          return res.status(401).json({ status: false, message: "Invalid password." });
        }
        // Generate short-lived JWT access token
        const accessToken = jwt.sign(
          {
            userId: user.clientId,
            role: user.role,
            name: user.clientName,
          },
          JWT_ACCESS_TOKEN,
          { expiresIn: "15m" }
        );
        const refreshToken = jwt.sign(
          { userId: user.clientId, role: user.role, name: user.clientName },
          JWT_REFRESH_TOKEN,
          { expiresIn: "7d" }
        );
        setAuthCookies(res, accessToken, refreshToken);

        return res.status(200).json({
          status: true,
          message: "Login successful!",
          data: user,
          ...loginTokenResponse(accessToken, refreshToken),
        });
      }
    });

  } catch (e) {
    console.error("Server Error:", e);
    return res.status(500).json({ status: false, message: "Server Error...!" });
  }
});

router.post('/refresh', handleTokenRefresh);

// New logout endpoint to clear cookies
router.post('/logout', (req, res) => {
  clearAuthCookies(res);
  return res.status(200).json({ status: true, message: 'Logged out successfully' });
});

router.post('/request_password_reset', async function (req, res) {
  const { email, role } = req.body;

  if (!email || !role) {
    return res.status(400).json({ status: false, message: "Email and role are required." });
  }

  try {
    const query = `
      SELECT "clientId", "clientMail" 
      FROM "Entities".clients 
      WHERE "clientMail" = $1
    `;
    const result = await pgPool.query(query, [email]);

    if (result.rows.length === 0) {
      return res.status(404).json({ status: false, message: "No account found with this email." });
    }

    const pending = pendingPasswordResets.get(email);
    if (pending && Date.now() - pending.timestamp < 60000) {
      return res.status(429).json({ status: false, message: "Please wait 1 minute before requesting again." });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    pendingPasswordResets.set(email, {
      otp,
      timestamp: Date.now(),
      role,
      verified: false
    });

    await sendProfessionalOTPEmail(email, otp, `Client Password Reset`, "password_reset");

    return res.status(200).json({
      status: true,
      message: "OTP sent to your email.",
      sentTo: email
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ status: false, message: "Server error." });
  }
});

router.post('/verify_reset_otp', async function (req, res) {
  const { email, otp, role } = req.body;
  const pending = pendingPasswordResets.get(email);

  if (!pending || pending.role !== role || pending.otp !== otp || Date.now() - pending.timestamp > 600000) {
    return res.status(400).json({ status: false, message: "Invalid or expired OTP." });
  }

  pending.verified = true;
  pendingPasswordResets.set(email, pending);

  return res.status(200).json({ status: true, message: "OTP verified successfully." });
});

router.post('/reset_password', async function (req, res) {
  const { email, newPassword, role } = req.body;
  const pending = pendingPasswordResets.get(email);

  if (!pending || !pending.verified || pending.role !== role) {
    return res.status(400).json({ status: false, message: "Session expired. Please restart forgot password process." });
  }

  try {
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

    const result = await pgPool.query(
      `UPDATE "Entities".clients SET password = $1 WHERE ("clientMail" = $2 OR "clientName" = $2)`,
      [hashedPassword, email]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ status: false, message: "Client not found." });
    }

    pendingPasswordResets.delete(email);

    return res.status(200).json({ status: true, message: "Password reset successfully!" });
  } catch (e) {
    console.error("Client Reset Password Error:", e);
    return res.status(500).json({ status: false, message: "Failed to reset password." });
  }
});

module.exports = router;
