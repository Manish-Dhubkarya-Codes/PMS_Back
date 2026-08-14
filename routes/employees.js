var express = require('express');
var router = express.Router();
var pgPool = require("./PostgreSQLPool");
var upload = require("./multer");
const bcrypt = require('bcrypt');
const { verifyToken, setAuthCookies, clearAuthCookies, loginTokenResponse, handleTokenRefresh } = require('../middleware/auth');
const jwt = require("jsonwebtoken");
require('dotenv').config();

const JWT_ACCESS_TOKEN = process.env.JWT_ACCESS_TOKEN;
const JWT_REFRESH_TOKEN = process.env.JWT_REFRESH_TOKEN || "supersecret";
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

// In-memory store for pending registrations (unchanged)
const pendingEmployees = new Map();

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

// Register Employee or Team Leader - Fully Updated with Resend OTP
router.post('/register_employee', upload.single("employeePic"), async function (req, res) {
  console.log("🔥 REGISTER EMPLOYEE RECEIVED:", req.body);

  try {
    const { employeeMail, role, securityKey, employeeName, employmentID, gender, employeeDesignation, password } = req.body;

    if (!employeeMail) {
      return res.status(400).json({ status: false, message: "Email is required." });
    }

    // Check if email already exists
    const emailCheckQuery = `
      SELECT "employeeMail" FROM "Entities".employees WHERE "employeeMail" = $1
      UNION
      SELECT "employeeMail" FROM "Entities"."employeeRegRequest" WHERE "employeeMail" = $1
    `;
    const emailCheckResult = await pgPool.query(emailCheckQuery, [employeeMail]);

    if (emailCheckResult.rows.length > 0) {
      return res.status(400).json({ status: false, message: "Email is already registered or pending approval." });
    }

    // Validate security key for Team Leader
    if (role === "Team Leader") {
      if (!securityKey || securityKey.trim() === "") {
        return res.status(400).json({ status: false, message: "Security Key is required for Team Leader." });
      }

      const trimmedKey = securityKey.trim();
      const keyQuery = `SELECT key_id FROM "Entities"."TeamLeaderSecureKey" WHERE key_id = $1 AND email = $2`;
      const keyResult = await pgPool.query(keyQuery, [trimmedKey, employeeMail]);

      if (keyResult.rows.length === 0) {
        return res.status(400).json({ status: false, message: "Invalid Security Key or Email for Team Leader." });
      }

      // Check if security key already used
      const keyUsedQuery = `
        SELECT "securityKey" FROM "Entities".employees WHERE "securityKey" = $1
        UNION
        SELECT "securityKey" FROM "Entities"."employeeRegRequest" WHERE "securityKey" = $1
      `;
      const keyUsedResult = await pgPool.query(keyUsedQuery, [trimmedKey]);
      if (keyUsedResult.rows.length > 0) {
        return res.status(400).json({ status: false, message: "Security Key has already been used for registration." });
      }
    }

    // ==================== RATE LIMIT: 1 MINUTE ====================
    const pending = pendingEmployees.get(employeeMail);
    if (pending && Date.now() - pending.timestamp < 60000) {
      return res.status(429).json({ 
        status: false, 
        message: "Please wait 1 minute before resending OTP." 
      });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const hashedPassword = await bcrypt.hash(password, 10);

    pendingEmployees.set(employeeMail, {
      data: {
        employeeName,
        employeeMail,
        employmentID,
        gender,
        employeeDesignation,
        password: hashedPassword,
        role,
        securityKey: role === "Team Leader" ? securityKey : null
      },
      filename: req.file?.filename || null,
      otp: otp,
      timestamp: Date.now()
    });

    console.log(`New OTP generated for ${role} ${employeeMail}: ${otp}`);

    // Send Professional Email
    await sendProfessionalOTPEmail(employeeMail, otp, role);

    return res.status(200).json({
      status: true,
      message: `OTP sent to ${employeeMail}.`
    });

  } catch (e) {
    console.error("Server Error in Employee Registration:", e);
    return res.status(500).json({ 
      status: false, 
      message: `Server Error: Failed to send OTP.` 
    });
  }
});

// Verify Employee OTP - Fully Updated
router.post('/verify_employee_otp', async function (req, res) {
  const { email, otp } = req.body;

  console.log(`🔍 VERIFY EMPLOYEE OTP - Email: ${email}, OTP: ${otp}`);

  if (!email || !otp) {
    return res.status(400).json({ status: false, message: "Email and OTP are required." });
  }

  const pending = pendingEmployees.get(email);
  if (!pending) {
    return res.status(400).json({ status: false, message: "No pending registration found." });
  }

  if (Date.now() - pending.timestamp > 600000) {
    pendingEmployees.delete(email);
    return res.status(400).json({ status: false, message: "OTP has expired." });
  }

  if (pending.otp !== otp) {
    return res.status(400).json({ status: false, message: "Invalid OTP." });
  }

  const { data, filename } = pending;

  try {
    const insertQuery = `
      INSERT INTO "Entities"."employeeRegRequest" (
        "employeeName", "employeeMail", "employmentID", "gender", "employeeDesignation",
        "password", "role", "securityKey", "employeePic", "status"
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
      RETURNING id
    `;

    const values = [
      data.employeeName,
      data.employeeMail,
      data.employmentID,
      data.gender,
      data.employeeDesignation,
      data.password,
      data.role,
      data.securityKey,
      filename
    ];

    const result = await pgPool.query(insertQuery, values);

// ✅ ADD: Emit new pending registration to Head & TL live
const io = req.app.get('io');
if (io) {
  io.to('head').to('tl').emit('newEmployeeRegistration', {
    id: result.rows[0].id.toString(),
    employeeName: data.employeeName,
    employeeMail: data.employeeMail,
    employmentID: data.employmentID,
    employeeDesignation: data.employeeDesignation,
    gender: data.gender,
    role: data.role,
    status: 'pending'
  });
}

    pendingEmployees.delete(email);

    return res.status(200).json({
      status: true,
      message: "Registration request submitted successfully. Awaiting admin approval."
    });
  } catch (error) {
    console.error("Database Error:", error);
    return res.status(500).json({ status: false, message: "Database Error, Please contact the admin." });
  }
});

// Fetch All Employee Registration Requests
router.get('/fetch_all_registrations', verifyToken,async function (req, res) {
  try {
    const query = `
      SELECT id, "employeeName", "employeeMail", "employmentID", "employeeDesignation",
             gender, role, "securityKey", "employeePic", status
      FROM "Entities"."employeeRegRequest"
      ORDER BY CASE
        WHEN status = 'pending' THEN 1
        WHEN status = 'accepted' THEN 2
        WHEN status = 'rejected' THEN 3
        ELSE 4
      END
    `;
    const result = await pgPool.query(query);

    return res.status(200).json({
      status: true,
      data: result.rows.map(row => ({
        id: row.id.toString(),
        employeeName: row.employeeName,
        employeeMail: row.employeeMail,
        employmentID: row.employmentID,
        employeeDesignation: row.employeeDesignation,
        gender: row.gender,
        role: row.role,
        securityKey: row.securityKey,
        employeePic: row.employeePic,
        status: row.status
      }))
    });
  } catch (error) {
    console.error("Error fetching all registrations:", error);
    return res.status(500).json({
      status: false,
      message: "Internal server error while fetching all registrations."
    });
  }
});

router.post('/admin/accept_employee_request/:requestId', verifyToken, async function (req, res) {
  const { requestId } = req.params;

  try {
    // Fetch the pending request
    const fetchQuery = `
      SELECT * FROM "Entities"."employeeRegRequest"
      WHERE id = $1 AND status = 'pending'
    `;
    const fetchResult = await pgPool.query(fetchQuery, [requestId]);

    if (fetchResult.rows.length === 0) {
      return res.status(400).json({ status: false, message: "No pending request found." });
    }

    const requestData = fetchResult.rows[0];

    // Insert into employees table
    const insertEmployeeQuery = `
      INSERT INTO "Entities".employees (
        "employeeName", "employeeMail", "employmentID", "gender", "employeeDesignation",
        "password", "role", "securityKey", "employeePic"
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `;
    await pgPool.query(insertEmployeeQuery, [
      requestData.employeeName,
      requestData.employeeMail,
      requestData.employmentID,
      requestData.gender,
      requestData.employeeDesignation,
      requestData.password,
      requestData.role,
      requestData.securityKey,
      requestData.employeePic
    ]);

    // Update request status to 'accepted'
    const updateQuery = `
      UPDATE "Entities"."employeeRegRequest"
      SET status = 'accepted', updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `;
    await pgPool.query(updateQuery, [requestId]);

    const io = req.app.get('io');  // Access io from the app
    if (io) {
      io.to('head').emit('employeeRegUpdate', {
        id: requestId.toString(),
        status: 'accepted'
      });
    }
    // Send approval email via SendGrid
    try {
      const dashboardUrl = `${process.env.FRONTEND_URL || 'http://187.77.184.39:5173/'}`;

const approvalMsg = {
  from: process.env.SENDER_EMAIL,
  to: requestData.employeeMail,
  subject: 'Registration Approved - CogniCode Project Management',
  html: `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin:auto; padding:20px; border:1px solid #e0e0e0; border-radius:8px; background:#fafafa;">
      
      <h2 style="color:#34a853; text-align:center;">Registration Approved ✅</h2>

      <p>Hello <strong>${requestData.employeeName}</strong>,</p>

      <p>Your registration has been successfully approved.</p>
      <p>You can now log in and start working on the platform.</p>

      <div style="text-align:center; margin:30px 0;">
        <a href="${dashboardUrl}"
           style="background:#1a73e8; color:white; padding:12px 28px; text-decoration:none; border-radius:6px; font-weight:bold; display:inline-block;">
          Go to Dashboard
        </a>
      </div>

      <hr style="border:0; border-top:1px solid #eee; margin:30px 0;">

      <p style="color:#777; font-size:12px; text-align:center;">
        Automated message – <strong>CogniCode Project Management</strong>
      </p>

    </div>
  `
};
      await transporter.sendMail(approvalMsg);
      console.log(`Approval email sent to ${requestData.employeeMail}`);
    } catch (mailErr) {
      console.error(`Failed to send approval email to ${requestData.employeeMail}:`, mailErr);
      // Non-blocking: Log but continue
    }

    return res.status(200).json({ status: true, message: "Employee registration approved." });
  } catch (error) {
    console.error("Accept Request Error:", error);
    return res.status(500).json({ status: false, message: "Server error during approval." });
  }
});

router.post('/admin/reject_employee_request/:requestId', verifyToken, async function (req, res) {
  const { requestId } = req.params;

  try {
    // Fetch the pending request
    const fetchQuery = `
      SELECT * FROM "Entities"."employeeRegRequest"
      WHERE id = $1
    `;
    const fetchResult = await pgPool.query(fetchQuery, [requestId]);

    if (fetchResult.rows.length === 0) {
      return res.status(400).json({ status: false, message: "No pending request found." });
    }

    const requestData = fetchResult.rows[0];

    // Update request status to 'rejected'
    const updateQuery = `
      UPDATE "Entities"."employeeRegRequest"
      SET status = 'rejected', updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `;
    await pgPool.query(updateQuery, [requestId]);

    // New: Emit socket update to head room
    const io = req.app.get('io');
    if (io) {
      io.to('head').emit('employeeRegUpdate', {
        id: requestId.toString(),
        status: 'rejected'
      });
    }

    // Send rejection email via SendGrid
   try {
      const rejectionMsg = {
        from: process.env.SENDER_EMAIL,
        to: requestData.employeeMail,
        subject: 'Registration Rejected - CogniCode Project Management',
        text: 'Your registration request was not approved. Please contact the admin for more details.'
      };
      await transporter.sendMail(rejectionMsg);
      console.log(`Rejection email sent to ${requestData.employeeMail}`);
    } catch (mailErr) {
      console.error(`Failed to send rejection email to ${requestData.employeeMail}:`, mailErr);
      // Non-blocking: Log but continue
    }

    return res.status(200).json({ status: true, message: "Employee registration request rejected." });
  } catch (error) {
    console.error("Reject Request Error:", error);
    return res.status(500).json({ status: false, message: "Server error during rejection." });
  }
});

router.post('/check_login_employee', async function (req, res) {
  console.log("LOGIN DATA RECEIVED:", req.body);

  try {
    const { role, name, employmentId, password, securityKey } = req.body;

    if (!role || !name || !employmentId || !password) {
      console.log("Missing required fields:", req.body);
      return res.status(400).json({ status: false, message: "Role, Name/Email, Employment ID, and Password are required." });
    }

    if (role === "Team Leader" && (!securityKey || securityKey.trim() === "")) {
      return res.status(400).json({ status: false, message: "Security Key is required for Team Leader login." });
    }

    const query = `
      SELECT * FROM "Entities".employees
      WHERE role = $1
      AND ("employeeName" = $2 OR "employeeMail" = $2)
      AND "employmentID" = $3
    `;
    const values = [role, name, employmentId];

    console.log("Query Values:", values);

    pgPool.query(query, values, async function (error, result) {
      if (error) {
        console.error("Database Error:", error);
        return res.status(400).json({ status: false, message: "Database Error, Please contact the admin." });
      } else if (result.rows.length === 0) {
        console.log("No matching user found for:", values);
        try {
          const pending = await pgPool.query(
            `SELECT status FROM "Entities"."employeeRegRequest"
             WHERE ("employeeName" = $1 OR "employeeMail" = $1)
               AND "employmentID" = $2
             ORDER BY id DESC
             LIMIT 1`,
            [name, employmentId]
          );
          if (pending.rows.length > 0) {
            const st = String(pending.rows[0].status || "").toLowerCase();
            if (st === "pending") {
              return res.status(200).json({
                status: false,
                message: "Your registration is pending admin approval. You can login after it is accepted.",
              });
            }
            if (st === "rejected") {
              return res.status(200).json({
                status: false,
                message: "Your registration was not approved. Please contact admin.",
              });
            }
          }
        } catch (pendingErr) {
          console.error("Pending registration lookup failed:", pendingErr);
        }
        return res.status(401).json({ status: false, message: "Invalid credentials." });
      } else {
        const user = result.rows[0];
        console.log("Fetched user:", user);
        const passwordMatch = await bcrypt.compare(password, user.password);
        if (!passwordMatch) {
          return res.status(401).json({ status: false, message: "Invalid password." });
        }
        if (role === "Team Leader" && user.securityKey !== securityKey) {
          return res.status(401).json({ status: false, message: "Invalid Security Key." });
        }
        // Generate short-lived JWT access token
        const accessToken = jwt.sign(
          {
            userId: user.employeeId,
            role: user.role,
            name: user.employeeName,
          },
          JWT_ACCESS_TOKEN,
          { expiresIn: "15m" }
        );
        const refreshToken = jwt.sign(
          { userId: user.employeeId, role: user.role, name: user.employeeName },
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

// Upload Employee Image
router.post('/upload_employee_image', upload.single("pic"), async function (req, res) {
  try {
    const employeeId = req.body.employeeId;
    const filename = req.file?.filename;

    if (!employeeId || !filename) {
      return res.status(400).json({ status: false, message: "Employee ID and image file are required." });
    }

    const query = `
      UPDATE "Entities".employees
      SET "employeePic" = $1
      WHERE "employeeId" = $2
    `;
    const values = [filename, employeeId];

    pgPool.query(query, values, function (error, result) {
      if (error) {
        console.error("Database Error:", error);
        return res.status(500).json({ status: false, message: "Database error while updating employee image." });
      } else if (result.rowCount === 0) {
        return res.status(404).json({ status: false, message: "Employee not found." });
      } else {
        return res.status(200).json({ status: true, message: "Employee image updated successfully!", filename });
      }
    });
  } catch (e) {
    console.error("Server Error:", e);
    return res.status(500).json({ status: false, message: "Server error while uploading employee image." });
  }
});

// Fetch All Employees
router.get('/fetch_all_employees', verifyToken,async function (req, res) {
  try {
    const projectId = req.query.project_id;
    let query = `
      SELECT "employeeId", "employeeName", "employeeDesignation", "employeeMail", "employmentID", "employeePic", "role"
      FROM "Entities".employees
      WHERE "role" = $1
    `;
    const values = ['Employee'];

    if (projectId) {
      query += `
        AND "employeeId" NOT IN (
          SELECT CAST("employeeid" AS INTEGER)
          FROM projectschema."employeeRequests"
          WHERE project_id = $2
        )
      `;
      values.push(projectId);
    }

    const result = await pgPool.query(query, values);

    res.json({
      status: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("Error fetching employees:", error);
    res.status(500).json({
      status: false,
      message: "Internal server error",
    });
  }
});
 
router.get('/fetch_employees_list', verifyToken,async function (req, res) {
  try {
    const query = `
      SELECT 
        "employeeId",
        "employeeName",
        "employeeDesignation",
        "employeeMail",
        "employmentID",
        "gender",
        "employeePic",
        "role",
        CASE 
          WHEN "role" = 'Team Leader' THEN "securityKey"
          ELSE NULL
        END AS "securityKey"
      FROM "Entities".employees
      WHERE "role" IN ('Employee', 'Team Leader')
    `;

    const result = await pgPool.query(query);

    res.json({
      status: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("Error fetching employees:", error);
    res.status(500).json({
      status: false,
      message: "Internal server error",
    });
  }
});

router.post('/change_employees_role', verifyToken, async (req, res) => {
  const { employeeId, role, securityKey } = req.body;

  if (!employeeId || !role) {
    return res.status(400).json({ status: false, message: 'employeeId and role are required.' });
  }

  try {
    // Fetch employee details to get email and name
    const fetchQuery = `
      SELECT "employeeName", "employeeMail"
      FROM "Entities".employees
      WHERE "employeeId" = $1
    `;
    const fetchResult = await pgPool.query(fetchQuery, [employeeId]);

    if (fetchResult.rows.length === 0) {
      return res.status(404).json({ status: false, message: 'Employee not found.' });
    }

    const { employeeName, employeeMail } = fetchResult.rows[0];

    // Update employee role
    const updateQuery = `
      UPDATE "Entities".employees 
      SET role = $1, "securityKey" = $2 
      WHERE "employeeId" = $3 
      RETURNING *;
    `;
    const updateResult = await pgPool.query(updateQuery, [role, securityKey || null, employeeId]);

    if (updateResult.rowCount === 0) {
      return res.status(404).json({ status: false, message: 'Employee not found.' });
    }

    // Send email notification via SendGrid
    try {
      const roleMsg = {
        from: process.env.SENDER_EMAIL,
        to: employeeMail,
        subject: 'Role Change Notification - CogniCode Project Management',
        text: `Dear ${employeeName},\n\nYour role has been updated to "${role}" in the CogniCode Project Management system.\n\nPlease log in to review your new responsibilities.\n\nBest regards,\nCogniCode Team`
      };
      await transporter.sendMail(roleMsg);
      console.log(`Role change email sent to ${employeeMail}`);
    } catch (emailError) {
      console.error(`Failed to send email to ${employeeMail}:`, emailError);
      // Note: We don't fail the request due to email error, just log it
    }
    
    res.json({ status: true, data: updateResult.rows[0] });
  } catch (error) {
    console.error('Error updating employee role:', error);
    res.status(500).json({ status: false, message: 'Internal server error.' });
  }
});

router.get('/fetch_employee_by_projectid/:projectId', verifyToken, async (req, res) => {
  const { projectId } = req.params;

  try {
    const query = `
      SELECT 
        er.request_id,
        COALESCE(pm.status, er.status) AS status,
        e."employeeId",
        e."employeeName",
        e."employeeDesignation",
        e."employeeMail",
        e."employmentID",
        e."employeePic",
        e.role
      FROM projectschema."employeeRequests" er
      JOIN "Entities".employees e 
        ON er.employeeid::integer = e."employeeId"
      LEFT JOIN projectschema."projectMonitors" pm
        ON pm."employeeId" = e."employeeId" AND pm."projectId" = er.project_id
      WHERE er.project_id = $1
        AND e.role = 'Employee';
    `;

    const result = await pgPool.query(query, [projectId]);

    res.json({
      status: true,
      data: {
        employees: result.rows
      }
    });
  } catch (error) {
    console.error('Error fetching employees for project:', error);
    res.status(500).json({
      status: false,
      message: 'Failed to fetch employees for project.'
    });
  }
});

router.post('/verify_employee_role', verifyToken,async function (req, res) {
  const { employeeId, role } = req.body;
  
  console.log("Verify request:", { employeeId, role });
  
  if (!employeeId || !role) {
    return res.status(400).json({
      status: false,
      message: "employeeId and role are required."
    });
  }

  try {
    // Query to check if employeeId exists and role matches
    const query = `
      SELECT "employeeId", "role" 
      FROM "Entities".employees 
      WHERE "employeeId" = $1 AND "role" = $2
    `;
    const values = [parseInt(employeeId), role]; // Cast employeeId to int if needed
    const result = await pgPool.query(query, values);
    
    console.log("Query result:", result.rows);
    
    if (result.rows.length > 0) {
      // Match found
      return res.status(200).json({
        status: true,
        message: "Role verified successfully.",
        data: result.rows[0]
      });
    } else {
      // No match
      return res.status(404).json({
        status: false,
        message: "Employee ID or role does not match."
      });
    }
  } catch (e) {
    console.error("Server Error in verify employee role:", e);
    return res.status(500).json({
      status: false,
      message: "Server Error: " + e.message
    });
  }
});

router.post('/send_project_activation_email', async function (req, res) {
  const { projectId, projectTitle, workstream } = req.body;

  try {
    // Get client details
    const clientRes = await pgPool.query(`
      SELECT c."clientMail", c."clientName"
      FROM projectschema.clientproject cp
      JOIN "Entities".clients c ON cp.clientid = c."clientId"
      WHERE cp.project_id = $1
    `, [projectId]);

    const client = clientRes.rows[0];

    // Send confirmation email to CLIENT
    if (client) {
      await sendClientActivationConfirmation(
        client.clientMail,
        client.clientName,
        projectTitle,
        workstream,
        projectId
      );
    }

    // Send to internal team (Head + Technical TLs)
    const headResult = await pgPool.query(`SELECT "headMail" FROM "Entities".head LIMIT 1`);
    const tlResult = await pgPool.query(`
      SELECT "employeeMail" 
      FROM "Entities".employees 
      WHERE "role" = 'Team Leader' 
      AND "employeeDesignation" ILIKE '%Technical%'
    `);

    const recipients = [];
    if (headResult.rows[0]?.headMail) recipients.push(headResult.rows[0].headMail);
    tlResult.rows.forEach(r => recipients.push(r.employeeMail));

    if (recipients.length > 0) {
      const dashboardUrl = process.env.FRONTEND_URL || 'http://187.77.184.39:5173/';

      const mailOptions = {
        from: process.env.SENDER_EMAIL,
        to: recipients,
        subject: `🚀 Project Activated: ${projectTitle} - CogniCode Project Management`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 620px; margin:auto; padding:20px; border:1px solid #e0e0e0; border-radius:8px; background:#fafafa;">
            <h2 style="color: #34a853; text-align:center;">Project is Now Active ✅</h2>
            <p>Hello Team,</p>
            <p>The Sales Team has activated the following project:</p>
            <table style="width:100%; border-collapse:collapse; margin:20px 0; background:white; border-radius:6px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,0.1);">
              <tr><td style="padding:12px; font-weight:bold; background:#f1f3f5;">Title</td><td style="padding:12px;">${projectTitle}</td></tr>
              <tr><td style="padding:12px; font-weight:bold; background:#f1f3f5;">Workstream</td><td style="padding:12px;">${workstream || 'N/A'}</td></tr>
              <tr><td style="padding:12px; font-weight:bold; background:#f1f3f5;">Project ID</td><td style="padding:12px;">#${projectId}</td></tr>
            </table>
            <p style="text-align:center;">
              <a href="${dashboardUrl}" style="background:#1a73e8; color:white; padding:12px 28px; text-decoration:none; border-radius:6px; font-weight:bold; display:inline-block;">
                Go to Dashboard
              </a>
            </p>
            <hr style="border:0; border-top:1px solid #eee; margin:30px 0;">
            <p style="color:#777; font-size:12px; text-align:center;">
              Automated message – <strong>CogniCode Project Management</strong>
            </p>
          </div>
        `
      };

      await transporter.sendMail(mailOptions);
    }

    return res.json({ status: true, message: "Activation email sent to client + team successfully" });
  } catch (err) {
    console.error("Activation Email Error:", err);
    return res.status(500).json({ status: false, message: "Failed to send activation email" });
  }
});


// ==================== SIMPLIFIED FORGOT PASSWORD ====================
router.post('/request_password_reset', async function (req, res) {
  const { email, role } = req.body;

  if (!email || !role) {
    return res.status(400).json({ status: false, message: "Email and role are required." });
  }

  try {
    // Search only by email (safe & simple)
    const query = `
      SELECT "employeeId", "employeeMail", role 
      FROM "Entities".employees 
      WHERE "employeeMail" = $1 AND role = $2
    `;
    const result = await pgPool.query(query, [email, role]);

    if (result.rows.length === 0) {
      return res.status(404).json({ status: false, message: "No account found with this email." });
    }

    // Rate limit
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

    await sendProfessionalOTPEmail(email, otp, `${role} Password Reset`, "password_reset");

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
  return res.status(200).json({ status: true, message: "OTP verified." });
});

router.post('/reset_password', async function (req, res) {
  const { email, newPassword, role } = req.body;
  const pending = pendingPasswordResets.get(email);
  if (!pending || !pending.verified || pending.role !== role) {
    return res.status(400).json({ status: false, message: "Session expired. Please restart forgot password." });
  }
  try {
    const hashed = await bcrypt.hash(newPassword, 10);
    const result = await pgPool.query(
      `UPDATE "Entities".employees SET password = $1 WHERE ("employeeMail" = $2 OR "employeeName" = $2) AND role = $3`,
      [hashed, email, role]
    );
    if (result.rowCount === 0) return res.status(404).json({ status: false, message: "User not found." });
    pendingPasswordResets.delete(email);
    return res.status(200).json({ status: true, message: "Password reset successfully!" });
  } catch (e) {
    return res.status(500).json({ status: false, message: "Failed to reset password." });
  }
});


module.exports = router;