const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
var { initializeAdminDB } = require("./init");
const cognicodePool = require("./CognicodePool");

// In-memory OTP storage
const otpStore = new Map();

// Initialize Admin Table
initializeAdminDB();

// Email Transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// ====================== LOGIN ======================
router.post('/login', async (req, res) => {
  const { identifier, password } = req.body;
  if (!identifier || !password) {
    return res.status(400).json({ success: false, message: "Name/Email and password are required" });
  }

  try {
    const result = await cognicodePool.query(`
      SELECT * FROM "admindetails" 
      WHERE email = $1 OR name = $1
    `, [identifier]);

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    const admin = result.rows[0];
    const isValid = await bcrypt.compare(password, admin.password);

    if (!isValid) {
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    res.json({
      success: true,
      admin: {
        adminId: admin.adminId,
        name: admin.name,
        email: admin.email
      }
    });
  } catch (error) {
    console.error("❌ Admin login error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ====================== SEND OTP ======================
router.post('/send-otp', async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ success: false, message: "Email is required" });
  }

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = Date.now() + 10 * 60 * 1000;

  otpStore.set(email, { otp, expiresAt });

  try {
    await transporter.sendMail({
      from: `"Cognicode EduTech" <${process.env.SMTP_USER}>`,
      to: email,
      subject: "Your OTP for Profile Update",
      html: `<h3>Your OTP is: <strong>${otp}</strong></h3><p>This OTP is valid for 10 minutes.</p>`
    });

    console.log(`✅ OTP sent to ${email}`);
    res.json({ success: true, message: "OTP sent successfully" });
  } catch (error) {
    console.error("❌ Failed to send OTP:", error);
    res.status(500).json({ success: false, message: "Failed to send OTP. Check server logs." });
  }
});

// ====================== VERIFY OTP ======================
router.post('/verify-otp', async (req, res) => {
  const { email, otp } = req.body;

  if (!email || !otp) {
    return res.status(400).json({ success: false, message: "Email and OTP are required" });
  }

  const stored = otpStore.get(email);
  if (!stored) {
    return res.status(400).json({ success: false, message: "No OTP found. Please request a new one." });
  }
  if (Date.now() > stored.expiresAt) {
    otpStore.delete(email);
    return res.status(400).json({ success: false, message: "OTP has expired. Please request a new one." });
  }
  if (stored.otp !== otp) {
    return res.status(400).json({ success: false, message: "Invalid OTP" });
  }

  otpStore.delete(email);
  res.json({ success: true, message: "OTP verified successfully" });
});

// ====================== UPDATE (CHANGED TO POST) ======================
router.post('/update', async (req, res) => {   // ← Changed from .put to .post
  const { name, email: currentEmail, newEmail, newPassword } = req.body;

  if (!currentEmail) {
    return res.status(400).json({ success: false, message: "Current email is required" });
  }

  try {
    let query = 'UPDATE "admindetails" SET ';
    const values = [];
    let paramCount = 1;

    if (name) {
      query += `"name" = $${paramCount++}, `;
      values.push(name.trim());
    }
    if (newEmail) {
      query += `"email" = $${paramCount++}, `;
      values.push(newEmail.trim());
    }
    if (newPassword) {
      const hashedPassword = await bcrypt.hash(newPassword, 12);
      query += `"password" = $${paramCount++}, `;
      values.push(hashedPassword);
    }

    query += `"updated_at" = CURRENT_TIMESTAMP WHERE email = $${paramCount}`;
    values.push(currentEmail);

    const result = await cognicodePool.query(query, values);

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Admin not found" });
    }

    res.json({ success: true, message: "Details updated successfully" });
  } catch (error) {
    console.error("❌ Admin update error:", error);
    res.status(500).json({ success: false, message: "Failed to update" });
  }
});

module.exports = router;