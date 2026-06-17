const express = require('express');
const router = express.Router();
var initializeClientRequestsDB = require("./init").initializeClientRequestsDB;
const cognicodePool = require("./CognicodePool");

// Initialize DB
initializeClientRequestsDB();

// ====================== GET ALL CLIENT REQUESTS ======================
router.get('/get_clientrequests', async (req, res) => {
  try {
    const result = await cognicodePool.query(`
      SELECT * FROM "clientrequests" 
      ORDER BY "created_at" DESC
    `);
    res.json({ success: true, requests: result.rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Failed to fetch requests" });
  }
});

// ====================== POST NEW CLIENT REQUEST ======================
router.post('/clientrequests', async (req, res) => {
  const { name, email, phone, country, service, subject, message } = req.body;

  if (!name || !email || !subject || !message) {
    return res.status(400).json({ 
      success: false, 
      message: "Name, email, subject and message are required." 
    });
  }

  try {
    const insertQuery = `
      INSERT INTO "clientrequests" 
        ("name", "email", "phone", "country", "service", "subject", "message")
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING "clientId";
    `;

    const values = [
      name.trim(),
      email.trim(),
      phone ? phone.trim() : null,
      country ? country.trim() : null,
      service ? service.trim() : null,
      subject.trim(),
      message.trim()
    ];

    const result = await cognicodePool.query(insertQuery, values);
    const clientId = result.rows[0].clientId;

    console.log(`✅ New client request saved - ID: ${clientId}`);

    res.status(201).json({ 
      success: true, 
      message: "Thank you! Your message has been received. We'll get back to you within 24 hours.",
      clientId: clientId
    });

  } catch (error) {
    console.error("❌ Error saving client request:", error);
    res.status(500).json({ 
      success: false, 
      message: "Sorry, we couldn't save your message. Please try again later." 
    });
  }
});

module.exports = router;