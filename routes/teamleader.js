var express = require('express');
var router = express.Router();
var pgPool = require("./PostgreSQLPool");
var upload = require("./multer");
const nodemailer = require('nodemailer');
const bcrypt = require('bcrypt');

require('dotenv').config();

router.post('/save_teamleader_key', async function (req, res) {
  const { key_id, name, email, mobile } = req.body;

  try {
    // Validate input
    if (!key_id || !name || !email || !mobile) {
      console.log("hhhh", req.body);
      return res.status(400).json({ status: false, message: "key_id, name, email, and mobile are required." });
    }
    // Insert data
    const insertQuery = `
      INSERT INTO "Entities"."TeamLeaderSecureKey" ("key_id", "name", "email", "mobile")
      VALUES ($1, $2, $3, $4);
    `;
    const values = [key_id, name, email, mobile];

    pgPool.query(insertQuery, values, function (error, result) {
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

router.get('/fetch_all_teamleaders', async function (req, res) {
  try {
    const query = `
      SELECT key_id, name, email, mobile
      FROM "Entities"."TeamLeaderSecureKey"
    `;
    const result = await pgPool.query(query);
    return res.status(200).json({
      status: true,
      data: result.rows,
      message: "TL fetched successfully!"
    });
  } catch (error) {
    console.error("Database Error:", error);
    return res.status(500).json({
      status: false,
      message: "Server Error: " + error.message
    });
  }
});

router.post('/edit_teamleader', async function (req, res) {
  const { key_id, name, email, mobile } = req.body;

  try {
    if (!key_id || !name || !email || !mobile) {
      return res.status(400).json({ status: false, message: "key_id, name, email, and mobile are required." });
    }
    const query = `
      UPDATE "Entities"."TeamLeaderSecureKey"
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

router.post('/delete_teamleader',async function (req, res) {
  const { key_id } = req.body;

  try {
    if (!key_id) {
      return res.status(400).json({ status: false, message: "key_id is required." });
    }
    const query = `
      DELETE FROM "Entities"."TeamLeaderSecureKey"
      WHERE key_id = $1
      RETURNING key_id;
    `;
    const values = [key_id];

    const result = await pgPool.query(query, values);
    if (result.rowCount === 0) {
      console.log("TL not found for key_id:", key_id);
      return res.status(404).json({ status: false, message: "TL not found." });
    }
    return res.status(200).json({
      status: true,
      message: "TL deleted successfully!",
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

module.exports = router;