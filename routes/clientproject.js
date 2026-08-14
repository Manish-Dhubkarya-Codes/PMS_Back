// clientproject.js

var express = require("express");
var router = express.Router();
var pgPool = require("./PostgreSQLPool");
var {initializeDatabase2} = require("./init");
var multer = require("multer");
var path = require("path");

const fs = require("fs");
const fsp = fs.promises;
const crypto = require("crypto");
const os = require("os");

const multipartParser = multer();
const { verifyToken } = require("../middleware/auth");
const jwt = require('jsonwebtoken');

function normalizeUploaderRole(role) {
  if (!role) return 'client';
  const normalized = String(role).trim().toLowerCase();
  if (normalized === 'head') return 'head';
  if (normalized === 'team leader' || normalized === 'teamleader' || normalized === 'tl' || normalized === 'team_leader') return 'tl';
  return 'client';
}

// Optional auth: if token present, decode and attach req.user; otherwise continue
function tryAuth(req, res, next) {
  let token = req.headers.authorization?.split(' ')[1];
  if (!token) token = req.cookies?.accessToken;
  if (!token) return next();
  jwt.verify(token, process.env.JWT_ACCESS_TOKEN, (err, decoded) => {
    if (!err && decoded) req.user = decoded;
    return next();
  });
}

// Final files go here
const FINAL_FILES_DIR = path.join(__dirname, "..", "public", "files");

// Temporary parts live only in the system temp folder (auto-cleaned by OS)
const TMP_ROOT = path.join(os.tmpdir(), "pms_chunks");

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

var upload = require("./multer");
var webpush = require('web-push');
const nodemailer = require('nodemailer');

const UPLOAD_TMP_ROOT = path.join(process.cwd(), "tmp_uploads");

async function ensureDir(dir) {
    await fsp.mkdir(dir, { recursive: true });
}

async function readMeta(uploadId) {
    const raw = await fsp.readFile(
        path.join(UPLOAD_TMP_ROOT, uploadId, "meta.json"),
        "utf8"
    );
    return JSON.parse(raw);
}

async function writeMeta(uploadId, meta) {
    await fsp.writeFile(
        path.join(UPLOAD_TMP_ROOT, uploadId, "meta.json"),
        JSON.stringify(meta)
    );
}

async function receivedChunkIndices(uploadId) {
    const dir = path.join(UPLOAD_TMP_ROOT, uploadId);

    try {
        const files = await fsp.readdir(dir);

        return files
            .filter(f => f.endsWith(".part"))
            .map(f => Number(f.replace(".part", "")))
            .sort((a,b)=>a-b);

    } catch {
        return [];
    }
}

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

// ==================== NEW: Send Client Activation Confirmation Email ====================
const sendClientActivationConfirmation = async (clientMail, clientName, projectTitle, workstream, projectId) => {
  if (!clientMail || !clientMail.includes('@')) return;

  const dashboardUrl = process.env.FRONTEND_URL || 'https://ccitpms.com/';

  const msg = {
    from: process.env.SMTP_USER,
    to: clientMail,
    subject: `🎉 Your Project is Now Active – ${projectTitle} | CogniCode`,
    html: `
      <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 620px; margin: auto; padding: 24px; background: #f8fafc; border-radius: 12px; border: 1px solid #e2e8f0;">
        <div style="text-align: center; margin-bottom: 24px;">
          <div style="display: inline-block; background: linear-gradient(135deg, #10b981, #059669); color: white; padding: 12px 24px; border-radius: 9999px; font-weight: 700; font-size: 15px;">
            ✅ PROJECT ACTIVATED
          </div>
        </div>

        <h2 style="color: #0f172a; text-align: center; margin: 0 0 8px 0; font-size: 26px;">Great news, ${clientName || 'Client'}!</h2>
        <p style="color: #334155; text-align: center; font-size: 16px; margin: 0 0 28px 0;">
          Your project has been successfully activated by our Sales Team.
        </p>

        <div style="background: white; border-radius: 10px; padding: 20px; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1); margin-bottom: 24px;">
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 10px 0; color: #64748b; font-weight: 600; width: 140px;">Project Title</td>
              <td style="padding: 10px 0; color: #0f172a; font-weight: 700;">${projectTitle}</td>
            </tr>
            <tr>
              <td style="padding: 10px 0; color: #64748b; font-weight: 600;">Workstream</td>
              <td style="padding: 10px 0; color: #0f172a;">${workstream || 'N/A'}</td>
            </tr>
            <tr>
              <td style="padding: 10px 0; color: #64748b; font-weight: 600;">Project ID</td>
              <td style="padding: 10px 0; color: #0f172a; font-family: monospace;">#${projectId}</td>
            </tr>
            <tr>
              <td style="padding: 10px 0; color: #64748b; font-weight: 600;">Status</td>
              <td style="padding: 10px 0;">
                <span style="background: #dcfce7; color: #166534; padding: 4px 14px; border-radius: 9999px; font-size: 13px; font-weight: 700;">ACTIVE</span>
              </td>
            </tr>
          </table>
        </div>

        <p style="color: #475569; font-size: 15px; line-height: 1.6;">
          Our team will now begin working on your project. You can track progress, communicate with the team, and view updates directly from your dashboard.
        </p>

        <div style="text-align: center; margin: 32px 0 16px;">
          <a href="${dashboardUrl}" 
             style="background: #1e40af; color: white; padding: 14px 36px; text-decoration: none; border-radius: 8px; font-weight: 700; display: inline-block; box-shadow: 0 10px 15px -3px rgb(30 64 175 / 0.3);">
            Open My Dashboard →
          </a>
        </div>

        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;">

        <p style="color: #64748b; font-size: 12px; text-align: center; margin: 0;">
          This is an automated confirmation from <strong>CogniCode Project Management</strong><br>
          If you have any questions, reply to this email or contact your assigned Team Leader.
        </p>
      </div>
    `
  };

  try {
    await transporter.sendMail(msg);
    console.log(`✅ Client activation confirmation sent to: ${clientMail}`);
  } catch (err) {
    console.error(`❌ Failed to send client activation email:`, err);
  }
};

initializeDatabase2(); // Your existing call (now creates project schema)
let io;


async function getProjectItem(projectId, userType = 'head') {
  try {
    const projQuery = `
      SELECT 
        cp.*, 
        COALESCE(c."clientName", 'Unknown Client') as clientName, 
        COALESCE(c."Profile", '') as clientPic,
        COALESCE(h."headName", 'Head') as headName,
        COALESCE(h."Profile", '') as headPic,
        COALESCE(e."employeeName", 'Team Leader') as teamLeaderName,
        COALESCE(e."employeePic", '') as teamLeaderPic,
        (SELECT COALESCE(json_agg(u), '[]') FROM unnest(COALESCE(cp.clientchats, ARRAY[]::text[])) AS u) AS clientchats_json,
        (SELECT COALESCE(json_agg(u), '[]') FROM unnest(COALESCE(cp.clientaudios, ARRAY[]::text[])) AS u) AS clientaudios_json,
        (SELECT COALESCE(json_agg(u), '[]') FROM unnest(COALESCE(cp.headchats, ARRAY[]::text[])) AS u) AS headchats_json,
        (SELECT COALESCE(json_agg(u), '[]') FROM unnest(COALESCE(cp.headaudios, ARRAY[]::text[])) AS u) AS headaudios_json,
        (SELECT COALESCE(json_agg(u), '[]') FROM unnest(COALESCE(cp.tlchats, ARRAY[]::text[])) AS u) AS tlchats_json,
        (SELECT COALESCE(json_agg(u), '[]') FROM unnest(COALESCE(cp.tlaudios, ARRAY[]::text[])) AS u) AS tlaudios_json
      FROM projectschema."clientproject" cp
      LEFT JOIN "Entities"."clients" c ON cp."clientid" = c."clientId"
      LEFT JOIN "Entities".head h ON cp."headid" = h."headId"
      LEFT JOIN "Entities".employees e ON cp."teamleaderid" = e."employeeId"
      WHERE cp."project_id" = $1
    `;
    const projResult = await pgPool.query(projQuery, [projectId]);
    if (projResult.rows.length === 0) {
      console.warn(`No project found for ID: ${projectId}`);
      return null;
    }

    const proj = projResult.rows[0];
    console.log(`Fetched project ${projectId} for ${userType}: Title="${proj.title}", Client="${proj.clientName}"`);

    const safeParseChats = (jsonArrayStr) => {
      if (!jsonArrayStr || !Array.isArray(jsonArrayStr)) return [];
      return jsonArrayStr.filter(Boolean).map(str => {
        try {
          return JSON.parse(str);
        } catch (parseErr) {
          console.warn(`Skipping invalid chat JSON in project ${projectId}:`, str.substring(0, 50), parseErr.message);
          return null;
        }
      }).filter(Boolean);
    };

    const clientChats = safeParseChats(proj.clientchats_json);
    const clientAudios = safeParseChats(proj.clientaudios_json);
    const headChats = safeParseChats(proj.headchats_json);
    const headAudios = safeParseChats(proj.headaudios_json);
    const tlChats = safeParseChats(proj.tlchats_json);
    const tlAudios = safeParseChats(proj.tlaudios_json);

    if (userType === 'head') {
      // Existing logic for Head
      let unreadFromClient = 0, unreadFromTL = 0;
      let hasMentionFromClient = false, hasMentionFromTL = false;

      [...clientChats, ...clientAudios].forEach((msgObj) => {
        if (!msgObj || typeof msgObj !== 'object') return;
        if (!msgObj.seen_by?.includes('head')) {
          unreadFromClient++;
          if (msgObj.mention?.type === 'head') hasMentionFromClient = true;
        }
      });
      [...tlChats, ...tlAudios].forEach((msgObj) => {
        if (!msgObj || typeof msgObj !== 'object') return;
        if (!msgObj.seen_by?.includes('head')) {
          unreadFromTL++;
          if (msgObj.mention?.type === 'head') hasMentionFromTL = true;
        }
      });

      return {
        title: proj.title || '',
        workstream: proj.workstream || '',
        clientName: proj.clientName,
        project_id: projectId,
        deadline: proj.deadline || '',
        budget: proj.budget || 0,
        description: proj.description || '',
        unreadFromClient,
        unreadFromTL,
        hasMentionFromClient,
        hasMentionFromTL,
        teamLeaderName: proj.teamLeaderName,
        status: proj.status || 'Hold' // Added: Include DB status
      };
    } else if (userType === 'client') {
      // NEW: Logic for Client (unread from Head/TL)
      let unreadFromHead = 0, unreadFromTL = 0;
      let hasMentionFromHead = false, hasMentionFromTL = false;

      [...headChats, ...headAudios].forEach((msgObj) => {
        if (!msgObj || typeof msgObj !== 'object') return;
        if (!msgObj.seen_by?.includes('client')) {
          unreadFromHead++;
          if (msgObj.mention?.type === 'client') hasMentionFromHead = true;
        }
      });
      [...tlChats, ...tlAudios].forEach((msgObj) => {
        if (!msgObj || typeof msgObj !== 'object') return;
        if (!msgObj.seen_by?.includes('client')) {
          unreadFromTL++;
          if (msgObj.mention?.type === 'client') hasMentionFromTL = true;
        }
      });

      // Compute status for ClientProfile (keep computed, add DB status)
      const computedStatus = new Date(proj.deadline) > new Date() ? "On-Going" : "Submitted";

      return {
        Title: proj.title || '',
        Workstream: proj.workstream || '',
        Description: Array.isArray(proj.description) ? proj.description.join('<br/><br/>') : proj.description || '',
        SubmissionDate: proj.deadline || '',
        status: computedStatus, // Keep computed status
        dbStatus: proj.status || 'Hold', // Added: DB status for distinction
        ProjectId: projectId,
        unreadFromHead,
        unreadFromTL,
        hasMentionFromHead,
        hasMentionFromTL,
        headName: proj.headName,
        teamLeaderName: proj.teamLeaderName
      };
    }

    return null;
  } catch (err) {
    console.error(`Error fetching project item for ${projectId} (${userType}):`, err);
    return null;
  }
}

async function sendPushNotification(userId, userType, title, body, projectId, item = null) {
  try {
    console.log(`🔍 Fetching push subs for ${userType} ${userId}`);
    const subsResult = await pgPool.query(`
      SELECT endpoint, subscription FROM "Entities"."pushSubscriptions" 
      WHERE "userId" = $1 AND "userType" = $2
    `, [userId, userType]);
    
    console.log(`🔍 Push subs found for ${userType} ${userId}: ${subsResult.rows.length}`);
    if (subsResult.rows.length === 0) {
      console.warn(`⚠️ No subscriptions for ${userType} ${userId}`);
      return;
    }

    const payload = JSON.stringify({ title, body, projectId, item, route: userType === 'head' ? 'headclientprojectinfo' : 'clientprojectinfo', userType });

    for (const row of subsResult.rows) {
      try {
        const sub = JSON.parse(row.subscription);
        await webpush.sendNotification(sub, payload);
        console.log(`🚀 Sent push to ${userType} ${userId} (endpoint: ${sub.endpoint.substring(0, 50)}...)`);
      } catch (subErr) {
        console.error(`❌ Failed to send to one sub for ${userType} ${userId}:`, subErr);
        if (subErr.statusCode === 410) {  // FIXED: Delete expired sub on 410 Gone
          await pgPool.query('DELETE FROM "Entities"."pushSubscriptions" WHERE endpoint = $1', [row.endpoint]);
          console.log('💾 Deleted expired sub for', userType, userId);
        }
      }
    }
  } catch (err) {
    console.error(`❌ Push send error for ${userType} ${userId}:`, err);
  }
}


// UPDATED: Save Route (POST /clientproject/save-push-subscription)
router.post('/save-push-subscription', async (req, res) => {
  const { userId, userType, subscription: subStr } = req.body;

  
  if (!userId || !userType || !subStr) {
    console.warn('❌ Missing fields in save-push-subscription');
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const subscription = JSON.parse(subStr);
    const endpoint = subscription.endpoint;

    // CHG: Upsert on endpoint (assumes UNIQUE constraint – add if missing)
    const result = await pgPool.query(`
      INSERT INTO "Entities"."pushSubscriptions" ("userId", "userType", "endpoint", "subscription", "updatedAt")
      VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
      ON CONFLICT ("endpoint") DO UPDATE SET
        "userId" = EXCLUDED."userId",
        "userType" = EXCLUDED."userType",
        "subscription" = EXCLUDED."subscription",
        "updatedAt" = CURRENT_TIMESTAMP
      RETURNING *
    `, [userId.toString(), userType, endpoint, subStr]);  // CHG: Schema + camelCase + toString() for VARCHAR

    console.log(`💾 Push sub saved/updated for ${userType} ${userId} (endpoint: ${endpoint.substring(0, 50)}...)`);
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    console.error('❌ Save push sub error:', err);  // NEW: Log full error (e.g., relation not found)
    res.status(500).json({ error: 'Failed to save subscription' });
  }
});

router.attachIo = (_io) => {
  io = _io;
};

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "files/");
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + path.extname(file.originalname));
  },
});

// Submit a request to employeeRequests
router.post("/submit_request", async function (req, res) {
  console.log("RECEIVED REQUEST DATA:", req.body);
  try {
    const { project_id, employeeId, status } = req.body;
    if (!project_id || !employeeId || !status) {
      return res.status(400).json({ status: false, message: "All fields are required." });
    }

    const projectCheck = await pgPool.query(
      "SELECT project_id FROM projectschema.clientproject WHERE project_id = $1",
      [project_id]
    );
    if (projectCheck.rows.length === 0) {
      return res.status(404).json({ status: false, message: "Project not found." });
    }

    const employeeCheck = await pgPool.query(
      'SELECT "employeeId" FROM "Entities".employees WHERE "employeeId" = CAST($1 AS INTEGER)',
      [employeeId]
    );
    if (employeeCheck.rows.length === 0) {
      return res.status(404).json({ status: false, message: "Employee not found." });
    }

    const query = `
      INSERT INTO projectschema."employeeRequests"
      (project_id, employeeId, status)
      VALUES ($1, $2, $3)
      RETURNING request_id, project_id, employeeId, status
    `;
    const values = [project_id, employeeId, status];
    const result = await pgPool.query(query, values);

    const insertedRequestId = result.rows[0].request_id;

    // Fetch the full new request details
    const newRequestQuery = `
      SELECT 
        er.request_id,
        er.project_id::TEXT,
        er.employeeid,
        er.status,
        cp.workstream,
        cp.title,
        cp.deadline::TEXT,
        cp.description,
        c."clientName",
        e."employeeName",
        e."employeeDesignation",
        e."employeePic"
      FROM projectschema."employeeRequests" er
      JOIN projectschema.clientproject cp ON er.project_id = cp.project_id
      JOIN "Entities".clients c ON cp.clientid = c."clientId"
      JOIN "Entities".employees e ON er.employeeId::integer = e."employeeId"
      WHERE er.request_id = $1
      ORDER BY er.created_at DESC
      LIMIT 1;
    `;
    const newRequestResult = await pgPool.query(newRequestQuery, [insertedRequestId]);
    
    if (newRequestResult.rows.length > 0) {
      const newRequestData = newRequestResult.rows[0];
      
      // ==================== LIVE UPDATE FOR ALL EMPLOYEES ====================
// ==================== LIVE UPDATE FOR ALL EMPLOYEES + TL ====================
if (io) {
  const payload = {
    request_id: newRequestData.request_id,
    project_id: String(newRequestData.project_id),
    employeeId: newRequestData.employeeid,                 // camelCase for frontend
    employeeid: newRequestData.employeeid,
    status: newRequestData.status || "pending",
    workstream: newRequestData.workstream,
    title: newRequestData.title,
    deadline: newRequestData.deadline,
    description: newRequestData.description,
    clientName: newRequestData.clientName,
    employeeName: newRequestData.employeeName,
    employeeDesignation: newRequestData.employeeDesignation,
    employeePic: newRequestData.employeePic || null,
    created_at: newRequestData.created_at || new Date().toISOString()
  };

  // Send to Team Leader room AND employees room
  io.to("tl").emit("newEmployeeRequest", payload);
  io.to("employees").emit("newEmployeeRequest", payload);
}
// =====================================================================
      // =====================================================================
    }

    return res.status(200).json({
      status: true,
      message: "Request submitted successfully!",
      data: result.rows[0],
    });
  } catch (e) {
    console.error("Server Error:", e);
    return res.status(500).json({ status: false, message: `Server Error: ${e.message}` });
  }
});

router.get("/employee_requests", async function (req, res) {
  try {
    const query = `
      SELECT 
        er.request_id,
        er.project_id::TEXT,
        er.employeeid,
        er.status,
        cp.workstream,
        cp.title,
        cp.deadline::TEXT,
        cp.description,
        c."clientName",
        e."employeeName",
        e."employeeDesignation",
        e."employeePic"
      FROM projectschema."employeeRequests" er
      JOIN projectschema.clientproject cp ON er.project_id = cp.project_id
      JOIN "Entities".clients c ON cp.clientid = c."clientId"
      JOIN "Entities".employees e ON er.employeeId::integer = e."employeeId"
      ORDER BY er.created_at DESC;
    `;
    const result = await pgPool.query(query);

    return res.status(200).json({
      status: true,
      message: "Employee requests retrieved successfully!",
      data: result.rows,
    });
  } catch (e) {
    console.error("Server Error:", e);
    return res.status(500).json({ status: false, message: `Server Error: ${e.message}` });
  }
});

// Check if a request exists
router.post('/check_request', async (req, res) => {
  const { project_id, employeeId } = req.body;
  console.log('Received body params:', { project_id, employeeId });
  if (!project_id || !employeeId) {
    return res.status(400).json({
      status: false,
      message: 'project_id and employeeId are required',
    });
  }

  try {
    const projectIdNum = Number(project_id);
    const employeeIdNum = Number(employeeId);
    if (isNaN(projectIdNum) || isNaN(employeeIdNum)) {
      return res.status(400).json({
        status: false,
        message: 'project_id and employeeId must be valid numbers',
      });
    }

    const query = `
      SELECT status FROM projectschema."employeeRequests"
      WHERE project_id = $1 AND employeeId = $2
    `;
    const values = [projectIdNum, employeeIdNum];
    const result = await pgPool.query(query, values);

    if (result.rows.length > 0) {
      return res.status(200).json({
        status: true,
        data: {
          exists: true,
          status: result.rows[0].status, // Return the status
        },
      });
    } else {
      return res.status(200).json({
        status: true,
        data: {
          exists: false,
          status: null, // No request exists
        },
      });
    }
  } catch (err) {
    console.error('Error checking request:', err);
    res.status(500).json({
      status: false,
      message: 'Internal server error',
    });
  }
});

router.get("/project_request_status/:employeeId", async function (req, res) {
  const { employeeId } = req.params;
  try {
    const query = `
      SELECT 
        er.request_id,
        er.project_id::TEXT,
        er.employeeid,
        er.status,
        er.created_at::TEXT,
        cp.workstream,
        cp.title,
        cp.deadline::TEXT,
        cp.description,
        c."clientName"
      FROM projectschema."employeeRequests" er
      JOIN projectschema.clientproject cp ON er.project_id = cp.project_id
      JOIN "Entities".clients c ON cp.clientid = c."clientId"
      WHERE er.employeeid = $1
      ORDER BY er.created_at DESC;
    `;
    const result = await pgPool.query(query, [employeeId]);

    return res.status(200).json({
      status: true,
      message: "Employee requests retrieved successfully!",
      data: result.rows,
    });
  } catch (e) {
    console.error("Server Error:", e);
    return res.status(500).json({ status: false, message: `Server Error: ${e.message}` });
  }
});

// Update request status
router.get("/employee_statuses", function (req, res) {
  console.log("RECEIVED EMPLOYEE STATUSES REQUEST:", req.query);
  try {
    const { project_id } = req.query;
    if (!project_id) {
      return res.status(400).json({ status: false, message: "project_id is required." });
    }

    const projectIdNum = Number(project_id);
    if (isNaN(projectIdNum)) {
      return res.status(400).json({ status: false, message: "project_id must be a valid number." });
    }

    const fetchStatusesQuery = `
      SELECT employeeid AS id, status
      FROM projectschema."employeeRequests"
      WHERE project_id = $1;
    `;
    pgPool.query(fetchStatusesQuery, [projectIdNum], function (error, result) {
      if (error) {
        console.error("Database Error:", error);
        return res.status(400).json({ status: false, message: "Database Error, Please contact the admin." });
      }

      return res.status(200).json({
        status: true,
        data: result.rows,
      });
    });
  } catch (e) {
    console.error("Server Error:", e);
    return res.status(500).json({ status: false, message: "Server Error...!" });
  }
});

router.get("/project_employee_requests/:projectId", function (req, res) {
  console.log("RECEIVED PROJECT EMPLOYEE REQUESTS:", req.params);
  try {
    const { projectId } = req.params;
    const projectIdNum = Number(projectId);
    if (isNaN(projectIdNum)) {
      return res.status(400).json({ status: false, message: "project_id must be a valid number." });
    }

    const fetchRequestsQuery = `
      SELECT 
        er.request_id,
        er.employeeid AS id,
        er.status,
        e."employeeName" AS name,
        e."employeePic" AS pic
      FROM projectschema."employeeRequests" er
      JOIN "Entities".employees e ON er.employeeid = e."employeeId"::text
      WHERE er.project_id = $1
      ORDER BY er.created_at DESC;
    `;
    pgPool.query(fetchRequestsQuery, [projectIdNum], function (error, result) {
      if (error) {
        console.error("Database Error:", error);
        return res.status(400).json({ status: false, message: "Database Error, Please contact the admin." });
      }

      return res.status(200).json({
        status: true,
        data: result.rows,
      });
    });
  } catch (e) {
    console.error("Server Error:", e);
    return res.status(500).json({ status: false, message: "Server Error...!" });
  }
});

router.post("/update_request_status", function (req, res) {
  console.log("RECEIVED UPDATE REQUEST DATA:", req.body);
  try {
    const { request_id, project_id, employeeId } = req.body;
    if (!request_id || !project_id || !employeeId) {
      console.log("Request", req.body);
      return res.status(400).json({ status: false, message: "request_id, project_id, and employeeId are required." });
    }

    const requestIdNum = Number(request_id);
    const projectIdNum = Number(project_id);
    const employeeIdStr = String(employeeId);

    if (isNaN(requestIdNum) || isNaN(projectIdNum)) {
      return res.status(400).json({ status: false, message: "request_id and project_id must be valid numbers." });
    }

    const updateAssignQuery = `
      UPDATE projectschema."employeeRequests"
      SET status = 'accepted'
      WHERE request_id = $1 AND employeeid = $2
      RETURNING status;
    `;
    pgPool.query(updateAssignQuery, [requestIdNum, employeeIdStr], async function (error, result) {
      if (error) {
        console.error("Database Error:", error);
        return res.status(400).json({ status: false, message: "Database Error, Please contact the admin." });
      }
      if (result.rowCount === 0) {
        return res.status(404).json({ status: false, message: "No matching request found to assign." });
      }

      // 🔥 OFFICIAL ASSIGNMENT EMAIL TO EMPLOYEE
      const employeeResult = await pgPool.query(
        'SELECT "employeeName", "employeeMail" FROM "Entities".employees WHERE "employeeId" = $1',
        [employeeId]
      );
      if (employeeResult.rows.length > 0) {
        const emp = employeeResult.rows[0];
        
        // Fetch project title
        const projectTitleResult = await pgPool.query(
          'SELECT title FROM projectschema.clientproject WHERE project_id = $1',
          [projectIdNum]
        );
        const projectTitle = projectTitleResult.rows[0]?.title || "Project";

              await sendAssignmentEmail(
          emp.employeeMail,
          emp.employeeName,
          projectTitle,
          "", // workstream not needed here
          project_id
        );
      }

      // 🔥 FIXED: Emit to BOTH TL and ALL Employees (so EmployeeLanding updates live)
      if (io) {
        const updateData = {
          request_id: requestIdNum,
          status: 'accepted',           // ← This must be 'accepted'
          project_id: project_id,
          employeeid: parseInt(employeeId)
        };
        io.to('tl').to('employees').emit('employeeRequestStatusUpdate', updateData);
      }

      return res.status(200).json({
        status: true,
        message: "Request assigned successfully!",
        updatedStatus: result.rows[0].status,
      });
    });
  } catch (e) {
    console.error("Server Error:", e);
    return res.status(500).json({ status: false, message: "Server Error...!" });
  }
});

router.post("/decline_request_status", function (req, res) {
  console.log("RECEIVED DECLINE REQUEST DATA:", req.body);
  try {
    const { request_id, project_id, employeeId } = req.body;
    if (!request_id || !project_id || !employeeId) {
      console.log("Request", req.body);
      return res.status(400).json({ status: false, message: "request_id, project_id, and employeeId are required." });
    }

    const requestIdNum = Number(request_id);
    const projectIdNum = Number(project_id);
    const employeeIdStr = String(employeeId);

    if (isNaN(requestIdNum) || isNaN(projectIdNum)) {
      return res.status(400).json({ status: false, message: "request_id and project_id must be valid numbers." });
    }

    const updateDeclineQuery = `
      UPDATE projectschema."employeeRequests"
      SET status = 'decline'
      WHERE request_id = $1 AND employeeid = $2
      RETURNING status;
    `;
    pgPool.query(updateDeclineQuery, [requestIdNum, employeeIdStr], function (error, result) {
      if (error) {
        console.error("Database Error:", error);
        return res.status(400).json({ status: false, message: "Database Error, Please contact the admin." });
      }
      if (result.rowCount === 0) {
        return res.status(404).json({ status: false, message: "No matching request found to decline." });
      }

      // 🔥 FIXED: Emit to BOTH TL and ALL Employees (so EmployeeLanding updates live)
      if (io) {
        const updateData = {
          request_id: requestIdNum,
          status: 'decline',
          project_id: project_id,
          employeeid: parseInt(employeeId)
        };
        io.to('tl').to('employees').emit('employeeRequestStatusUpdate', updateData);
      }

      return res.status(200).json({
        status: true,
        message: "Request declined successfully!",
        updatedStatus: result.rows[0].status,
      });
    });
  } catch (e) {
    console.error("Server Error:", e);
    return res.status(500).json({ status: false, message: "Server Error...!" });
  }
});

// ------------------------------------------------------------
// /save_project – Notify Creator Client + ALL Heads + TLs
// ------------------------------------------------------------
router.post("/save_project", async function (req, res) {
  console.log("RECEIVED PROJECT DATA:", req.body);
  try {
    const {
      workstream,
      title,
      deadline,
      budget,
      description,
      clientid // Only this is needed
    } = req.body;
    // ---------- VALIDATION ----------
    if (!workstream || !title || !deadline || !budget || !description || !clientid) {
      return res.status(400).json({ status: false, message: "All fields are required." });
    }
    // ---------- INSERT PROJECT ----------
    const insertSQL = `
      INSERT INTO projectschema.clientproject
      (workstream, title, deadline, budget, description, clientid, headid, teamleaderid,
       clientchats, clientaudios, headchats, headaudios, tlchats, tlaudios)
      VALUES ($1, $2, $3, $4, ARRAY[$5], $6, NULL, NULL,
              ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[])
      RETURNING project_id, title, deadline
    `;
    const insertVals = [
      workstream,
      title,
      deadline,
      parseFloat(budget),
      description,
      clientid
    ];
        const { rows } = await pgPool.query(insertSQL, insertVals);
    const projectId = rows[0].project_id;

    // ==================== LIVE UPDATE FOR ALL EMPLOYEES ====================
    if (io) {
      const fullProject = await pgPool.query(`
        SELECT project_id, workstream, title, deadline, budget, description, status, clientid
        FROM projectschema.clientproject 
        WHERE project_id = $1
      `, [projectId]);

      const projectData = fullProject.rows[0];

      io.to("employees").emit("newProjectActivated", {
        project_id: projectData.project_id,
        workstream: projectData.workstream,
        title: projectData.title,
        deadline: projectData.deadline,
        budget: projectData.budget,
        description: projectData.description,
        status: projectData.status || "Active",
        clientName: "New Client"
      });
    }
    // =====================================================================

    const projectTitle = rows[0].title;
    const projectDeadline = rows[0].deadline;
    console.log(`Project created – ID: ${projectId}, Title: "${projectTitle}"`);
    // ---------- FETCH CREATOR CLIENT ----------
    let creatorClient = { clientName: "Unknown Client", clientMail: null };
    try {
      const res = await pgPool.query(
        `SELECT "clientName", "clientMail" FROM "Entities".clients WHERE "clientId" = $1`,
        [clientid]
      );
      creatorClient = res.rows[0] || creatorClient;
      console.log("Creator Client:", creatorClient);
    } catch (err) {
      console.error("Failed to fetch creator client:", err);
    }
    // ---------- FETCH ALL HEADS & TEAM LEADERS ----------
    let allHeads = [], allTeamLeaders = [];
    try {
      // ALL HEADS
      const headRes = await pgPool.query(
        `SELECT "headMail", COALESCE("headName", 'Head') AS "headName"
         FROM "Entities".head WHERE "headMail" IS NOT NULL`
      );
      allHeads = headRes.rows;
      console.log(`Found ${allHeads.length} heads to notify`);
      // ALL TEAM LEADERS
      const tlRes = await pgPool.query(
        `SELECT "employeeMail", COALESCE("employeeName", 'Team Leader') AS "employeeName"
         FROM "Entities".employees
         WHERE role = 'Team Leader' AND "employeeMail" IS NOT NULL`
      );
      allTeamLeaders = tlRes.rows;
      console.log(`Found ${allTeamLeaders.length} team leaders to notify`);
    } catch (err) {
      console.error("Error fetching heads or TLs:", err);
    }
    // ---------- REUSABLE EMAIL TEMPLATE ----------
const sendProjectEmail = async (to, name, role) => {
  if (!to || !to.includes('@')) {
    console.warn(`Skipping invalid email for ${role}: ${to}`);
    return;
  }

  const dashboardUrl = `${process.env.PMS_URL || 'https://ccitpms.com/'}`;

  // Budget row only for Head, NOT for Team Leader
  const budgetRow = role === "Team Leader" 
    ? "" 
    : `<tr><td style="padding:12px; font-weight:bold; background:#f1f3f5;">Budget</td><td style="padding:12px;">₹${parseFloat(budget).toLocaleString()}</td></tr>`;

  const msg = {
    from: process.env.SMTP_USER,
    to,
    subject: `New Project Uploaded: "${projectTitle}"`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 620px; margin: auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px; background:#fafafa;">
        <h2 style="color: #1a73e8; text-align:center;">New Project Created</h2>
        <p>Hello <strong>${name}</strong>,</p>
        <p><strong>${creatorClient.clientName}</strong> has uploaded a new project:</p>
        <table style="width:100%; border-collapse:collapse; margin:20px 0; background:white; border-radius:6px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,0.1);">
          <tr><td style="padding:12px; font-weight:bold; background:#f1f3f5;">Title</td><td style="padding:12px;">${projectTitle}</td></tr>
          <tr><td style="padding:12px; font-weight:bold; background:#f1f3f5;">Workstream</td><td style="padding:12px;">${workstream}</td></tr>
          <tr><td style="padding:12px; font-weight:bold; background:#f1f3f5;">Deadline</td><td style="padding:12px;">${new Date(projectDeadline).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</td></tr>
          ${budgetRow}
          <tr><td style="padding:12px; font-weight:bold; background:#f1f3f5;">Project ID</td><td style="padding:12px;">#${projectId}</td></tr>
        </table>
        <p style="text-align:center; margin:30px 0;">
          <a href="${dashboardUrl}"
             style="background:#1a73e8; color:white; padding:12px 28px; text-decoration:none; border-radius:6px; font-weight:bold; display:inline-block;">
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

  try {
    await transporter.sendMail(msg);
    console.log(`✅ Project email sent to ${role}: ${to}`);
  } catch (err) {
    console.error(`Failed to send email to ${role} ${to}:`, err);
  }
};
    // ---------- SEND EMAILS ----------
    try {
      // 1. CREATOR CLIENT (Confirmation)
      // 1. CREATOR CLIENT (Confirmation)
      if (creatorClient.clientMail) {
        const confirmationMsg = {
          from: process.env.SMTP_USER,
          to: creatorClient.clientMail,
          subject: `Your Project is Live: "${projectTitle}"`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 620px; margin: auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px; background:#fafafa;">
              <h2 style="color: #1a73e8; text-align:center;">Project Successfully Created!</h2>
              <p>Hi <strong>${creatorClient.clientName}</strong>,</p>
              <p>Your project has been uploaded successfully.</p>
              <table style="width:100%; border-collapse:collapse; margin:20px 0; background:white; border-radius:6px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,0.1);">
                <tr><td style="padding:12px; font-weight:bold; background:#f1f3f5;">Title</td><td style="padding:12px;">${projectTitle}</td></tr>
                <tr><td style="padding:12px; font-weight:bold; background:#f1f3f5;">Workstream</td><td style="padding:12px;">${workstream}</td></tr>
                <tr><td style="padding:12px; font-weight:bold; background:#f1f3f5;">Deadline</td><td style="padding:12px;">${new Date(projectDeadline).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</td></tr>
                <tr><td style="padding:12px; font-weight:bold; background:#f1f3f5;">Budget</td><td style="padding:12px;">₹${parseFloat(budget).toLocaleString()}</td></tr>
                <tr><td style="padding:12px; font-weight:bold; background:#f1f3f5;">Project ID</td><td style="padding:12px;">#${projectId}</td></tr>
              </table>
              <p style="text-align:center;">
                <a href="${process.env.PMS_URL || 'https://ccitpms.com/'}"
                   style="background:#34a853; color:white; padding:12px 28px; text-decoration:none; border-radius:6px; font-weight:bold; display:inline-block;">
                  View My Projects
                </a>
              </p>
              <p>*Have been Notified to the CogniCode Team!</p>
              <hr style="border:0; border-top:1px solid #eee; margin:30px 0;">
              <p style="color:#777; font-size:12px; text-align:center;">
                Automated message – <strong>CogniCode Project Management</strong>
              </p>
            </div>
          `
        };
        await transporter.sendMail(confirmationMsg);
        console.log(`Confirmation email sent to Creator Client: ${creatorClient.clientMail}`);
      }
      // 2. ALL HEADS
      for (const head of allHeads) {
        await sendProjectEmail(head.headMail, head.headName, "Head");
      }
      // 3. ALL TEAM LEADERS
      for (const tl of allTeamLeaders) {
        await sendProjectEmail(tl.employeeMail, tl.employeeName, "Team Leader");
      }
    } catch (mailErr) {
      console.error("Email failed (non-critical):", mailErr);
    }
    // ==================== LIVE UPDATE FOR ALL TEAM LEADERS ====================
  // ==================== LIVE UPDATE FOR ALL TLs + HEADS + EMPLOYEES ====================
if (io) {
  const payload = {
    project_id: projectId,
    title: projectTitle,
    workstream,
    clientName: creatorClient.clientName,
    status: "Hold",                 // new projects start as Hold
    deadline: projectDeadline,
    description: description || "",
    budget: budget || 0,
  };

  // Team Leaders (Sales + Technical)
  io.to("tl").emit("newProjectCreated", payload);

  // Heads
  io.to("head").emit("newProjectCreated", payload);

  // Employees (so Active tab can also react if needed)
  io.to("employees").emit("newProjectCreated", payload);

  console.log("📢 Emitted newProjectCreated to TL + Head + Employees rooms");
}
// ====================================================================================
    // ---------- SUCCESS ----------
    return res.status(200).json({
      status: true,
      message: "Project saved and notifications sent!",
      data: { project_id: projectId }
    });
  } catch (e) {
    console.error("Server error in /save_project:", e);
    return res.status(500).json({ status: false, message: "Server Error...!" });
  }
});

router.post("/upload_file_temp", upload.single("file"), function (req, res) {
  console.log("Temp File Upload:", req);
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ status: false, message: "No file uploaded." });
    }
    const fileUrl = `/files/${file.filename}`;
    return res.status(200).json({ status: true, data: { fileUrl } });
  } catch (e) {
    console.error("Temp Upload Error:", e);
    return res.status(500).json({ status: false, message: "File upload failed." });
  }
});

// Update project
router.post("/update_project/:projectId", function (req, res) {
  console.log("UPDATE PROJECT:", req.body);
  const { projectId } = req.params;
  const { description: newDescription } = req.body;
  if (!newDescription || newDescription.trim() === "" || newDescription === "<p><br></p>") {
    console.error("Invalid description:", newDescription);
    return res.status(400).json({ status: false, message: "Valid description is required." });
  }
  try {
    const query = `
      UPDATE projectschema.clientproject
      SET description = array_append(description, $1)
      WHERE project_id = $2
      RETURNING project_id, description
    `;
    pgPool.query(query, [newDescription, projectId], function (error, result) {
      if (error) {
        console.error("Database Error:", error);
        return res
          .status(400)
          .json({ status: false, message: "Database Error, Please contact the admin." });
      } else if (result.rowCount === 0) {
        return res.status(404).json({ status: false, message: "Project not found!!" });
      } else {
        console.log("Updated Description Array:", result.rows[0].description);
        return res.status(200).json({
          status: true,
          message: "Project updated successfully!",
          data: { project_id: result.rows[0].project_id, description: result.rows[0].description },
        });
      }
    });
  } catch (e) {
    console.error("Server Error:", e);
    return res.status(500).json({ status: false, message: "Server Error...!" });
  }
});

router.post("/add_tl_chat/:projectId", async function (req, res) {
  const { projectId } = req.params;
  const { type, data, timestamp, teamleaderid, mention, replyTo } = req.body;

  if (!type || !data || !timestamp || !teamleaderid) {
    return res.status(400).json({ status: false, message: "Missing required fields" });
  }

  const projectIdNum = Number(projectId);
  if (isNaN(projectIdNum)) {
    return res.status(400).json({ status: false, message: "Invalid projectId" });
  }

  try {
    const projectCheck = await pgPool.query("SELECT project_id FROM projectschema.clientproject WHERE project_id = $1", [projectIdNum]);
    if (projectCheck.rows.length === 0) return res.status(404).json({ status: false, message: "Project not found" });

    // Get TL name & pic once
    const tlInfo = await pgPool.query(
      'SELECT "employeeName", "employeePic" FROM "Entities".employees WHERE "employeeId" = $1',
      [teamleaderid]
    );
    const tlName = tlInfo.rows[0]?.employeeName || "Team Leader";
    const tlPic = tlInfo.rows[0]?.employeePic || "";

    const chatJson = JSON.stringify({
      type,
      data,
      timestamp,
      senderId: teamleaderid.toString(),   // ← NEW
      senderName: tlName,                  // ← NEW
      senderPic: tlPic,                    // ← NEW
      seen_by: [],
      replyTo: replyTo || null,
      mention: mention || null
    });

    const column = type === "audio" ? "tlaudios" : "tlchats";

    await pgPool.query(`
      UPDATE projectschema.clientproject
      SET ${column} = ${column} || $1::text
      WHERE project_id = $2
    `, [chatJson, projectIdNum]);

    // Emit to room
    if (io) io.to(`project_${projectIdNum}`).emit("newTLMonitorMessage", {
      fromRole: "tl",
      msg: JSON.parse(chatJson)
    });

    res.status(200).json({ status: true, message: "TL message saved" });
  } catch (e) {
    console.error("add_tl_chat error:", e);
    res.status(500).json({ status: false, message: "Server error" });
  }
});

// Add client audio to project
router.post("/add_audio/:projectId", async function (req, res) {
  const { projectId } = req.params;
  const { type, data, timestamp } = req.body;
  if (!type || !data || !timestamp) {
    return res.status(400).json({ status: false, message: "Type, data, and timestamp are required." });
  }
  const audioJson = JSON.stringify({ type, data, timestamp, seen_by: [] });
  try {
    const query = `
      UPDATE projectschema.clientproject
      SET clientaudios = array_append(clientaudios, $1)
      WHERE project_id = $2
      RETURNING clientaudios
    `;
    const result = await pgPool.query(query, [audioJson, projectId]);
    if (result.rowCount === 0) {
      return res.status(404).json({ status: false, message: "Project not found!!" });
    } else {
      if (io) {
        const newIndex = result.rows[0].clientaudios.length - 1;
        const msg = {
          id: newIndex,
          type,
          data,
          timestamp,
          seen_by: [],
          mention: null,
        };
        io.to(`project_${projectId}`).emit("newMessage", {
          projectId,
          fromRole: "client",
          msg,
        });
        // FIXED: Fetch headid and send push (even closed)
        const projectQuery = await pgPool.query('SELECT headid FROM projectschema.clientproject WHERE project_id = $1', [projectId]);
        const headId = projectQuery.rows[0]?.headid;
        if (headId) {
          console.log('Sending push for headId', headId, 'project', projectId); // Debug
          const title = type === 'text' ? 'New Client Message' : 'New Client File';
          const body = type === 'text'
            ? (data).slice(0, 50) + '...'
            : `File: ${data.name}`;
          await sendPushNotification(headId.toString(), 'head', title, body, projectId);
        }
      }
      return res.status(200).json({
        status: true,
        message: "Audio added successfully!",
        data: { project_id: projectId },
      });
    }
  } catch (e) {
    console.error("Server Error:", e);
    return res.status(500).json({ status: false, message: "Server Error...!" });
  }
});

// Add head chat to project
router.post("/add_head_chat/:projectId", async function (req, res) {
  const { projectId } = req.params;
  const { type, data, timestamp, headid, mention, replyTo } = req.body;

  if (!type || !data || !timestamp) {
    return res
      .status(400)
      .json({ status: false, message: "Type, data, and timestamp are required." });
  }

  if (!headid) {
    return res.status(400).json({ status: false, message: "Head ID is required." });
  }

  const chatJson = JSON.stringify({ 
    type, 
    data, 
    timestamp, 
    seen_by: [],  
    mention: mention || null,
    replyTo: replyTo || null,
  });

  try {
    const query = `
      UPDATE projectschema.clientproject
      SET headchats = array_append(headchats, $1),
          headid = $3
      WHERE project_id = $2
      RETURNING headchats, headid
    `;
    const result = await pgPool.query(query, [chatJson, projectId, headid]);
    if (result.rowCount === 0) {
      return res.status(404).json({ status: false, message: "Project not found!!" });
    } else {
      if (io) {
        const newIndex = result.rows[0].headchats.length - 1;
        const msg = {
          id: newIndex,
          type,
          data,
          timestamp,
          seen_by: [],
          mention: mention || null,
        };
        io.to(`project_${projectId}`).emit("newMessage", {
          projectId,
          fromRole: "head",
          msg,
        });
      }
      return res.status(200).json({
        status: true,
        message: "Head chat added and head ID updated successfully!",
        data: {
          project_id: result.rows[0].project_id,
          headid: result.rows[0].headid,
        },
      });
    }
  } catch (e) {
    console.error("Server Error:", e);
    return res.status(500).json({ status: false, message: "Server Error...!" });
  }
});

router.post("/add_head_audio/:projectId", async function (req, res) {
  const { projectId } = req.params;
  const { type, data, timestamp } = req.body;
  if (!type || !data || !timestamp) {
    return res
      .status(400)
      .json({ status: false, message: "Type, data, and timestamp are required." });
  }
  const audioJson = JSON.stringify({ type, data, timestamp, seen_by: [] });
  try {
    const query = `
      UPDATE projectschema.clientproject
      SET headaudios = array_append(headaudios, $1)
      WHERE project_id = $2
      RETURNING headaudios
    `;
    const result = await pgPool.query(query, [audioJson, projectId]);
    if (result.rowCount === 0) {
      return res.status(404).json({ status: false, message: "Project not found!!" });
    } else {
      if (io) {
        const newIndex = result.rows[0].headaudios.length - 1;
        const msg = {
          id: newIndex,
          type,
          data,
          timestamp,
          seen_by: [],
          mention: null,
        };
        io.to(`project_${projectId}`).emit("newMessage", {
          projectId,
          fromRole: "head",
          msg,
        });
      }
      return res.status(200).json({
        status: true,
        message: "Head audio added successfully!",
        data: { project_id: projectId },
      });
    }
  } catch (e) {
    console.error("Server Error:", e);
    return res.status(500).json({ status: false, message: "Server Error...!" });
  }
});


// Upload file
router.post("/upload_file", (req, res, next) => {
  upload.single("file")(req, res, (err) => {
    if (err) {
      console.error("Multer upload error:", err);
      return res.status(400).json({ status: false, message: err.message || "File upload failed." });
    }
    next();
  });
}, function (req, res) {
  try {
    const file = req.file;
    console.log("File Upload:", {
      hasFile: !!file,
      originalname: file?.originalname,
      filename: file?.filename,
      mimetype: file?.mimetype,
      size: file?.size,
      projectId: req.body?.projectId,
      contentType: req.headers["content-type"],
    });
    if (!file) {
      return res.status(400).json({ status: false, message: "No file uploaded." });
    }
    const fileUrl = `/files/${file.filename}`;
    return res.status(200).json({ status: true, data: { fileUrl } });
  } catch (e) {
    console.error("Upload Error:", e);
    return res.status(500).json({ status: false, message: "File upload failed." });
  }
});

// ===================== 1. INIT =====================
router.post(
  "/upload_init",
  express.json(),
  express.urlencoded({ extended: true }),
  tryAuth,
  multipartParser.none(),
  async (req, res) => {
    try {
      console.log('upload_init content-type:', req.headers['content-type']);
      console.log('upload_init body:', req.body);
      const { fileName, fileType, totalChunks, projectId } = req.body || {};

      if (!fileName || !totalChunks) {
        return res.status(400).json({ status: false, message: "Missing fields" });
      }

    const uploadId = crypto.randomUUID();
    const tmpDir = path.join(TMP_ROOT, uploadId);
    await ensureDir(tmpDir);
    // Derive uploader info: prefer authenticated user, fall back to body fields
    let derivedUploaderRole = null;
    let derivedUploaderId = null;
    if (req.user) {
      derivedUploaderRole = normalizeUploaderRole(req.user.role || null);
      derivedUploaderId = req.user.userId || req.user.userId || null;
    }
    // If auth is absent or cannot determine role, use explicit uploader values from the client
    if (!derivedUploaderRole && req.body && req.body.uploaderRole) {
      derivedUploaderRole = normalizeUploaderRole(req.body.uploaderRole);
    }
    if (!derivedUploaderId && req.body && req.body.uploaderId) {
      derivedUploaderId = req.body.uploaderId;
    }

    console.log('upload_init uploaderRole:', derivedUploaderRole, 'uploaderId:', derivedUploaderId, 'authPresent:', !!req.user);

    await fsp.writeFile(
      path.join(tmpDir, "meta.json"),
      JSON.stringify({
        fileName,
        fileType: fileType || "application/octet-stream",
        totalChunks: Number(totalChunks),
        projectId,
        uploaderRole: derivedUploaderRole || 'client',
        uploaderId: derivedUploaderId || null,
        caption: req.body.caption || null,
        createdAt: Date.now(),
      })
    );

    return res.json({ status: true, uploadId });
  } catch (err) {
    console.error("upload_init error:", err);
    return res.status(500).json({ status: false, message: err.message });
  }
});


// ===================== 2. CHUNK =====================
// Special multer that writes only .part files into system temp
const chunkStorage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      const uploadId = req.body.uploadId;
      const dir = path.join(TMP_ROOT, uploadId);
      await ensureDir(dir);
      cb(null, dir);
    } catch (e) {
      cb(e);
    }
  },
  filename: (req, file, cb) => {
    const index = req.body.chunkIndex;
    cb(null, `${index}.part`);
  },
});

const uploadChunk = multer({ storage: chunkStorage });

router.post("/upload_chunk", uploadChunk.single("chunk"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ status: false, message: "No chunk received" });
    }
    return res.json({ status: true });
  } catch (err) {
    console.error("upload_chunk error:", err);
    return res.status(500).json({ status: false, message: err.message });
  }
});


// ===================== 3. COMPLETE =====================
// Accept JSON (axios default) and multipart form bodies
router.post(
  "/upload_complete",
  express.json(),
  express.urlencoded({ extended: true }),
  multipartParser.none(),
  async (req, res) => {
  console.log("upload_complete body:", req.body);

  try {
    const { uploadId } = req.body || {};
    if (!uploadId) {
      return res.status(400).json({ status: false, message: "uploadId required" });
    }

    const tmpDir = path.join(TMP_ROOT, uploadId);
    const metaPath = path.join(tmpDir, "meta.json");

    if (!fs.existsSync(metaPath)) {
      return res.status(404).json({ status: false, message: "Upload session not found" });
    }

    const meta = JSON.parse(await fsp.readFile(metaPath, "utf8"));
    const total = meta.totalChunks;

    // Check all parts exist
    for (let i = 0; i < total; i++) {
      const part = path.join(tmpDir, `${i}.part`);
      if (!fs.existsSync(part)) {
        return res.status(400).json({
          status: false,
          message: `Missing chunk ${i}`,
        });
      }
    }

    // Final file name
    const ext = path.extname(meta.fileName) || "";
    const safeName = `${crypto.randomUUID()}${ext}`;
    const finalPath = path.join(FINAL_FILES_DIR, safeName);

    await ensureDir(FINAL_FILES_DIR);
    console.log('upload_complete finalPath:', finalPath);

    // Assemble all parts into one file in public/files
    const writeStream = fs.createWriteStream(finalPath);

    for (let i = 0; i < total; i++) {
      const partPath = path.join(tmpDir, `${i}.part`);
      const data = await fsp.readFile(partPath);
      writeStream.write(data);
    }

    await new Promise((resolve, reject) => {
      writeStream.end();
      writeStream.on("finish", resolve);
      writeStream.on("error", reject);
    });

    const fileUrl = `/files/${safeName}`;

    // NOTE: Do NOT persist chat / emit socket here.
    // Chat persistence + realtime broadcast must happen once via socket handlers
    // (sendHeadMessage / sendClientMessage / sendTLMessage) after the client
    // receives this response. Saving here caused duplicate messages and broken
    // image previews (relative URL + second socket event without tempId).

    // Clean up temporary parts
    await fsp.rm(tmpDir, { recursive: true, force: true });

    return res.json({
      status: true,
      fileUrl,
      fileName: meta.fileName,
      fileType: meta.fileType || "application/octet-stream",
      projectId: meta.projectId || null,
      uploaderRole: normalizeUploaderRole(meta.uploaderRole || "client"),
      uploaderId: meta.uploaderId || null,
      caption: meta.caption || null,
    });
  } catch (err) {
    console.error("upload_complete error:", err);
    return res.status(500).json({ status: false, message: err.message });
  }
});


// Optional cancel
router.post("/upload_cancel", async (req, res) => {
  try {
    const { uploadId } = req.body;
    if (uploadId) {
      await fsp.rm(path.join(TMP_ROOT, uploadId), { recursive: true, force: true });
    }
    return res.json({ status: true });
  } catch (err) {
    return res.status(500).json({ status: false, message: err.message });
  }
});

// Get client projects
router.get("/get_client_projects/:clientId", function (req, res) {
  const { clientId } = req.params;
  console.log("Client ID:", clientId);

  if (!clientId || isNaN(clientId)) {
    return res.status(400).json({
      status: false,
      message: "Invalid or missing clientId",
    });
  }

  try {
    const query = `
      SELECT 
        cp.*, 
        c."clientName",
        c."clientPic",
        h."headName" as headname,
        h."headPic",
        e."employeeName" AS "teamleadername",
        e."employeePic" AS "teamleaderpic"
      FROM projectschema.clientproject cp
      LEFT JOIN "Entities".clients c ON cp.clientid = c."clientId"
      LEFT JOIN "Entities".head h ON cp.headid = h."headId"
      LEFT JOIN "Entities".employees e ON cp.teamleaderid = e."employeeId" AND e."role" = 'Team Leader'
      WHERE cp.clientid = $1
      ORDER BY deadline DESC
    `;
    pgPool.query(query, [clientId], async function (error, result) {
      if (error) {
        console.error("Database Error:", error);
        return res.status(400).json({
          status: false,
          message: "Database Error, Please contact the admin.",
        });
      }

      try {
        const projects = result.rows.map((p) => {
          let unread_count = 0;
          let has_unread_mention = false;

          const receivedMessages = [
            ...(p.headchats || []),
            ...(p.headaudios || []),
          ].filter(msg_str => msg_str && msg_str.trim() !== ""); // Filter empty or invalid entries

          receivedMessages.forEach((msg_str) => {
            try {
              const msg = JSON.parse(msg_str);
              if (msg.seen_by.length === 0) {
                unread_count++;
                if (msg.mention && msg.mention.type === "client" && msg.mention.id.toString() === clientId.toString()) {
                  has_unread_mention = true;
                }
              }
            } catch (e) {
              console.error(`Error parsing message for project ${p.project_id}:`, e);
            }
          });

          return {
            ...p,
            unread_count,
            has_unread_mention,
            headname: p.headname || "Head",
          };
        });

        const projectsData = projects;

        // Optional: Emit to client room for real-time sync
        if (io) {
          io.to(`client_${clientId}`).emit('clientProjectsUpdate', { data: projectsData });
        }

        return res.status(200).json({
          status: true,
          message: "Projects retrieved successfully!",
          data: projectsData,
        });
      } catch (e) {
        console.error("Error processing project data:", e);
        return res.status(500).json({
          status: false,
          message: "Error processing project data",
        });
      }
    });
  } catch (e) {
    console.error("Server Error:", e);
    return res.status(500).json({
      status: false,
      message: "Server Error...!",
    });
  }
});

router.get("/show_all_clientsprojects", function (req, res) {
  try {
    const query = `
      SELECT 
        cp.project_id,
        cp.workstream,
        cp.title,
        cp.deadline,
        cp.budget,
        cp.description,
        cp.clientchats,
        cp.clientaudios,
        cp.headchats,
        cp.headaudios,
        cp.tlchats,
        cp.tlaudios,
        cp.status,
        cp.active_date,
        c."clientName",
        c."clientPic"
      FROM projectschema.clientproject cp
      JOIN "Entities".clients c ON cp.clientid = c."clientId"
      ORDER BY cp.deadline ASC
    `;
    pgPool.query(query, [], function (error, result) {
      if (error) {
        console.error("Database Error:", error);
        return res
          .status(400)
          .json({ status: false, message: "Database Error, Please contact the admin." });
      } else {
        return res.status(200).json({
          status: true,
          message: "All client projects retrieved successfully!",
          data: result.rows,
        });
      }
    });
  } catch (e) {
    console.error("Server Error:", e);
    return res.status(500).json({ status: false, message: "Server Error...!" });
  }
});

router.post("/update_project_status/:projectId", async (req, res) => {
  const { projectId } = req.params;
  const { status } = req.body;

  if (!['Active', 'Hold', 'Completed'].includes(status)) {
    return res.status(400).json({ status: false, message: "Invalid status. Must be 'Active', 'Hold', or 'Completed'." });
  }

  try {
    let query = `UPDATE projectschema.clientproject SET status = $1`;
    let values = [status, projectId];

    if (status === 'Active') {
      const activationMsg = JSON.stringify({
        type: 'system',
        data: `✅ Project activated on ${new Date().toLocaleDateString('en-GB')}`,
        timestamp: new Date().toISOString(),
        seen_by: []
      });

      query += `, active_date = NOW(), clientchats = array_append(COALESCE(clientchats, ARRAY[]::text[]), $3)`;
      values = [status, projectId, activationMsg];
    }

    query += ` WHERE project_id = $2 RETURNING status, active_date`;

    const result = await pgPool.query(query, values);

    if (result.rowCount === 0) {
      return res.status(404).json({ status: false, message: "Project not found." });
    }

    if (io) {
      const statusPayload = {
        projectId: String(projectId),
        project_id: String(projectId),
        status,
        active_date: result.rows[0]?.active_date || null,
      };
      // Broadcast to every role room so landing tabs update without a refresh
      io.to("employees").emit("projectStatusUpdated", statusPayload);
      io.to("tl").emit("projectStatusUpdated", statusPayload);
      io.to("head").emit("projectStatusUpdated", statusPayload);
      io.to(`project_${projectId}`).emit("projectStatusUpdated", statusPayload);
      // Legacy alias still used by some landing pages
      io.to("employees").emit("projectStatusUpdate", statusPayload);
      io.to("tl").emit("projectStatusUpdate", statusPayload);
      io.to("head").emit("projectStatusUpdate", statusPayload);
    }

    return res.status(200).json({
      status: true,
      message: "Project status updated successfully!",
      data: result.rows[0]
    });
  } catch (err) {
    console.error("Server Error in update_project_status:", err);
    return res.status(500).json({ status: false, message: "Server Error...!" });
  }
});

// Mark message as seen
// In clientproject.js, update the mark_message_seen endpoint emit to include timestamp
// Mark message as seen
router.post("/mark_message_seen/:projectId", async (req, res) => {
  const { projectId } = req.params;
  const { index, fromClient, type, fromHead, fromTeamLeader, viewer, timestamp } = req.body; // timestamp from frontend
  try {
    let field;
    let fromRole;
    if (fromClient) {
      field = type === "audio" ? "clientaudios" : "clientchats";
      fromRole = "client";
    } else if (fromHead) {
      field = type === "audio" ? "headaudios" : "headchats";
      fromRole = "head";
    } else if (fromTeamLeader) {
      field = type === "audio" ? "tlaudios" : "tlchats";
      fromRole = "tl";
    } else {
      return res.status(400).json({ status: false, message: "Invalid sender type" });
    }
    const result = await pgPool.query(
      `SELECT ${field} FROM projectschema.clientproject WHERE project_id = $1`,
      [projectId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ status: false, message: "Project not found" });
    }
    const messages = result.rows[0][field] || [];
    if (index >= messages.length) {
      return res.status(400).json({ status: false, message: "Invalid message index" });
    }
    let msgObj;
    try {
      msgObj = JSON.parse(messages[index]);
    } catch (parseError) {
      console.error("Error parsing message JSON:", parseError);
      return res.status(500).json({ status: false, message: "Invalid message format" });
    }
    if (!Array.isArray(msgObj.seen_by)) {
      msgObj.seen_by = [];
    }
    if (msgObj.seen_by.includes(viewer)) {
      return res.status(200).json({ status: true, message: "Message already seen by this user" });
    }
    msgObj.seen_by.push(viewer);
    messages[index] = JSON.stringify(msgObj);
    await pgPool.query(
      `UPDATE projectschema.clientproject SET ${field} = $1 WHERE project_id = $2`,
      [messages, projectId]
    );

    // Emit with timestamp for live update
    if (io) {
      io.to(`project_${projectId}`).emit("messageSeen", {
        projectId,
        fromRole,
        index,
        seen_by: msgObj.seen_by,
        type,
        timestamp: timestamp || msgObj.timestamp, // Use provided timestamp or from msgObj
      });
    }
    return res.status(200).json({ status: true, message: "Message marked as seen" });
  } catch (error) {
    console.error("Error marking message as seen:", error);
    return res.status(500).json({ status: false, message: "Internal server error" });
  }
});

// Add team leader chat to project
// router.post("/add_tl_chat/:projectId", async function (req, res) {
//   const { projectId } = req.params;
//   const { type, data, timestamp, teamleaderid, mention } = req.body;
//   // In /add_tl_chat and /add_chat, right after params/body
// console.log(`📨 Msg route hit: Type="${type}", Data="${typeof data === 'object' ? data.name || data.substring(0, 20) : data}", Project=${projectId}, Sender=TL`);  // NEW: Confirm hit

//   if (!type || !data || !timestamp || !teamleaderid) {
//     return res.status(400).json({
//       status: false,
//       message: "Type, data, timestamp, and teamleaderid are required.",
//     });
//   }

//   const projectIdNum = Number(projectId);
//   if (isNaN(projectIdNum)) {
//     return res.status(400).json({ status: false, message: "projectId must be a valid number." });
//   }

//   try {
//     const projectCheck = await pgPool.query(
//       "SELECT project_id FROM projectschema.clientproject WHERE project_id = $1",
//       [projectIdNum]
//     );
//     if (projectCheck.rows.length === 0) {
//       return res.status(404).json({ status: false, message: "Project not found." });
//     }

//     const teamLeaderCheck = await pgPool.query(
//       'SELECT "employeeId" FROM "Entities".employees WHERE "employeeId" = $1 AND role = $2',
//       [teamleaderid, 'Team Leader']
//     );
//     if (teamLeaderCheck.rows.length === 0) {
//       return res.status(404).json({ status: false, message: "Team Leader not found or invalid role." });
//     }

//     if (mention) {
//       if (mention.type === 'client') {
//         const clientCheck = await pgPool.query(
//           'SELECT "clientId" FROM "Entities".clients WHERE "clientId" = $1',
//           [mention.id]
//         );
//         if (clientCheck.rows.length === 0) {
//           return res.status(400).json({ status: false, message: "Invalid client mention." });
//         }
//       } else if (mention.type === 'head') {
//         const headCheck = await pgPool.query(
//           'SELECT "headId" FROM "Entities".head WHERE "headId" = $1',
//           [mention.id]
//         );
//         if (headCheck.rows.length === 0) {
//           return res.status(400).json({ status: false, message: "Invalid head mention." });
//         }
//       }
//     }

//    let chatJson;
// try {
//   chatJson = JSON.stringify({
//     type,
//     data: msgData,  // Ensure msgData is string/object
//     timestamp,
//     seen_by: [],
//     mention: mention || null
//   });
//   if (typeof chatJson !== 'string' || chatJson.length < 10) {  // Basic validation
//     throw new Error('Invalid JSON generated');
//   }
// } catch (strErr) {
//   console.error('JSON stringify failed for msg:', strErr);
//   return res.status(500).json({ status: false, message: 'Invalid message format' });  // Or return in socket
// }

//     const query = `
//       UPDATE projectschema.clientproject
//       SET tlchats = array_append(tlchats, $1),
//           teamleaderid = $3
//       WHERE project_id = $2
//       RETURNING tlchats, teamleaderid
//     `;
//     const result = await pgPool.query(query, [chatJson, projectIdNum, teamleaderid]);

//     if (result.rowCount === 0) {
//       return res.status(404).json({ status: false, message: "Project not found." });
//     }

//     if (io) {
//       const newIndex = result.rows[0].tlchats.length - 1;
//       const msg = {
//         id: newIndex,
//         type,
//         data,
//         timestamp,
//         seen_by: [],
//         mention: mention || null,
//       };
//       io.to(`project_${projectId}`).emit("newMessage", {
//         projectId,
//         fromRole: "tl",
//         msg,
//       });

//       const projectQuery = await pgPool.query(
//   'SELECT headid FROM projectschema.clientproject WHERE project_id = $1',
//   [projectId]
// );
// const headId = projectQuery.rows[0]?.headid;
// if (headId) {
//   console.log(`🔍 Trigger check for head ${headId}: Msg type=${type}, seen_by=${JSON.stringify(mention ? mention : 'no mention')}`);  // NEW: Log trigger
//   const title = type === 'text' ? 'New TL Message' : 'New TL File';
//   const body = type === 'text' ? data.slice(0, 50) + '...' : `File: ${data.name}`;
//   console.log(`🚀 About to send push: Title="${title}", Body="${body}", Project=${projectId}`);  // NEW
//   await sendPushNotification(headId.toString(), 'head', title, body, projectIdNum);
// } else {
//   console.log(`❌ No headId for project ${projectId} – no push`);  // NEW
// }
//     }

//     return res.status(200).json({
//       status: true,
//       message: "Team Leader chat added successfully!",
//       data: {
//         project_id: projectIdNum,
//         teamleaderid: result.rows[0].teamleaderid,
//       },
//     });
//   } catch (e) {
//     console.error("Server Error:", e);
//     return res.status(500).json({ status: false, message: `Server Error: ${e.message}` });
//   }
// });

router.get("/get_project/:projectId", function (req, res) {
  const { projectId } = req.params;
  console.log("Project ID:", projectId);
  try {
    const query = `
      SELECT 
        cp.*, 
        c."clientId" as clientid,
        c."clientName",
        c."clientPic",
        h."headId" as headid,
        h."headPic",
        h."headName",
        e."employeeName" AS "teamLeaderName",
        e."employeePic" AS "teamLeaderPic"
      FROM projectschema.clientproject cp
      LEFT JOIN "Entities".clients c ON cp.clientid = c."clientId"
      LEFT JOIN "Entities".head h ON cp.headid = h."headId"
      LEFT JOIN "Entities".employees e ON cp.teamleaderid = e."employeeId" AND e."role" = 'Team Leader'
      WHERE cp.project_id = $1
    `;
    pgPool.query(query, [projectId], function (error, result) {
      if (error) {
        console.error("Database Error:", error);
        return res
          .status(400)
          .json({ status: false, message: "Database Error, Please contact the admin." });
      } else if (result.rows.length === 0) {
        return res.status(404).json({ status: false, message: "Project not found!!" });
      } else {
        const projectData = result.rows[0];

        // Emit to project room and client room for real-time sync (consistent with mutation handlers)
        if (io) {
          // Broadcast to project room (head, tl, client)
          io.to(`project_${projectId}`).emit('projectUpdate', { 
            projectId: projectId, 
            data: projectData 
          });
          // Also broadcast to client-specific room if applicable
          if (projectData.clientid) {
            io.to(`client_${projectData.clientid}`).emit('projectUpdate', { 
              projectId: projectId, 
              data: projectData 
            });
          }
        }

        return res.status(200).json({
          status: true,
          message: "Project details retrieved successfully!",
          data: projectData,
        });
      }
    });
  } catch (e) {
    console.error("Server Error:", e);
    return res.status(500).json({ status: false, message: "Server Error...!" });
  }
});


router.post("/add_tl_audio/:projectId", async function (req, res) {
  const { projectId } = req.params;
  const { type, data, timestamp, teamleaderid } = req.body;
  if (!type || !data || !timestamp || !teamleaderid) {
    return res.status(400).json({
      status: false,
      message: "Type, data, timestamp, and teamleaderid are required.",
    });
  }
  const projectIdNum = Number(projectId);
  if (isNaN(projectIdNum)) {
    return res.status(400).json({ status: false, message: "projectId must be a valid number." });
  }
  try {
    const projectCheck = await pgPool.query(
      "SELECT project_id FROM projectschema.clientproject WHERE project_id = $1",
      [projectIdNum]
    );
    if (projectCheck.rows.length === 0) {
      return res.status(404).json({ status: false, message: "Project not found." });
    }
    const teamLeaderCheck = await pgPool.query(
      'SELECT "employeeId" FROM "Entities".employees WHERE "employeeId" = $1 AND role = $2',
      [teamleaderid, 'Team Leader']
    );
    if (teamLeaderCheck.rows.length === 0) {
      return res.status(404).json({ status: false, message: "Team Leader not found or invalid role." });
    }
    const audioJson = JSON.stringify({ type, data, timestamp, seen_by: [] });
    const query = `
      UPDATE projectschema.clientproject
      SET tlaudios = array_append(tlaudios, $1),
          teamleaderid = $3
      WHERE project_id = $2
      RETURNING tlaudios, teamleaderid
    `;
    const result = await pgPool.query(query, [audioJson, projectIdNum, teamleaderid]);
    if (result.rowCount === 0) {
      return res.status(404).json({ status: false, message: "Project not found." });
    }
    if (io) {
      const newIndex = result.rows[0].tlaudios.length - 1;
      const msg = {
        id: newIndex,
        type,
        data,
        timestamp,
        seen_by: [],
        mention: null,
      };
      io.to(`project_${projectId}`).emit("newMessage", {
        projectId,
        fromRole: "tl",
        msg,
      });
      // FIXED: Fetch headid and send push (even closed)
      const projectQuery = await pgPool.query('SELECT headid FROM projectschema.clientproject WHERE project_id = $1', [projectIdNum]);
      const headId = projectQuery.rows[0]?.headid;
      if (headId) {
        console.log('Sending push for headId', headId, 'project', projectIdNum); // Debug
        const title = type === 'text' ? 'New TL Message' : 'New TL File';
        const body = type === 'text'
          ? data.slice(0, 50) + '...'
          : `File: ${data.name}`;
        await sendPushNotification(headId.toString(), 'head', title, body, projectIdNum);
      }
    }
    return res.status(200).json({
      status: true,
      message: "Team Leader audio added successfully!",
      data: {
        project_id: projectIdNum,
        teamleaderid: result.rows[0].teamleaderid,
      },
    });
  } catch (e) {
    console.error("Server Error:", e);
    return res.status(500).json({ status: false, message: `Server Error: ${e.message}` });
  }
});

router.post('/assign_project_monitor', async function (req, res) {
  const { employeeId, projectId, status } = req.body;
  if (!employeeId || !projectId || !status) {
    return res.status(400).json({ status: false, message: 'Missing required fields' });
  }
  try {
    await pgPool.query(
      'INSERT INTO projectschema."projectMonitors" ("employeeId", "projectId", "status") VALUES ($1, $2, $3)',
      [employeeId, projectId, status]
    );

    // 🔥 LIVE EMIT → EmployeeProjectInfo will instantly hide chat for other employees
    if (io) {
      io.to(`tl_monitor_${projectId}`).emit("monitorAssigned");
      console.log(`📡 Emitted monitorAssigned for project ${projectId}`);
    }

    res.json({ status: true, message: 'Monitor assigned successfully' });
  } catch (err) {
    console.error('Error assigning monitor:', err);
    res.status(500).json({ status: false, message: 'Failed to assign monitor' });
  }
});

router.post('/remove_project_monitor', async function (req, res) {
  const { employeeId, projectId, status } = req.body;
  if (!employeeId || !projectId || !status) {
    return res.status(400).json({ status: false, message: 'Missing required fields' });
  }
  try {
    const result = await pgPool.query(
      'DELETE FROM projectschema."projectMonitors" WHERE "employeeId" = $1 AND "projectId" = $2 AND "status" = $3 RETURNING *',
      [employeeId, projectId, status]
    );

    if (result.rowCount > 0) {
      // 🔥 LIVE EMIT → EmployeeProjectInfo will instantly hide chat for everyone except new solo/monitor
      if (io) {
        io.to(`tl_monitor_${projectId}`).emit("monitorAssigned");
        console.log(`📡 Emitted monitorAssigned (after removal) for project ${projectId}`);
      }
      res.json({ status: true, message: 'Monitor removed successfully' });
    } else {
      res.status(404).json({ status: false, message: 'Monitor not found' });
    }
  } catch (err) {
    console.error('Error removing monitor:', err);
    res.status(500).json({ status: false, message: 'Failed to remove monitor' });
  }
});

// TL and Project Head Section:-

// Add TL chat to monitor chat table
router.post("/add_tl_chat_to_monitor/:projectId", async function (req, res) {
  const { projectId } = req.params;
  const { type, data, timestamp, teamleaderid } = req.body;

  if (!type || !data || !timestamp || !teamleaderid) {
    return res.status(400).json({ status: false, message: "Type, data, timestamp, and teamleaderid are required." });
  }

  const projectIdNum = Number(projectId);
  if (isNaN(projectIdNum)) {
    return res.status(400).json({ status: false, message: "projectId must be a valid number." });
  }

  try {
    // Check project exists
    const projectCheck = await pgPool.query(
      "SELECT project_id FROM projectschema.clientproject WHERE project_id = $1",
      [projectIdNum]
    );
    if (projectCheck.rows.length === 0) {
      return res.status(404).json({ status: false, message: "Project not found." });
    }

    // Check sender is Team Leader
    const tlCheck = await pgPool.query(
      'SELECT "employeeId" FROM "Entities".employees WHERE "employeeId" = $1 AND role = $2',
      [teamleaderid, 'Team Leader']
    );
    if (tlCheck.rows.length === 0) {
      return res.status(404).json({ status: false, message: "Invalid Team Leader." });
    }

    // Check if row exists for this project, if not create it
    const chatRowCheck = await pgPool.query(
      'SELECT "projectId" FROM projectschema."projectTLClientChats" WHERE "projectId" = $1',
      [projectIdNum]
    );
    if (chatRowCheck.rows.length === 0) {
      await pgPool.query(
        'INSERT INTO projectschema."projectTLClientChats" ("projectId", "TeamLeaderId") VALUES ($1, $2)',
        [projectIdNum, teamleaderid]
      );
    }

    const tlInfo = await pgPool.query(
  'SELECT "employeeName", "employeePic" FROM "Entities".employees WHERE "employeeId" = $1',
  [teamleaderid]
);

const tlName = tlInfo.rows[0]?.employeeName || "Team Leader";
const tlPic = tlInfo.rows[0]?.employeePic || "";

const chatJson = JSON.stringify({
  type,
  data,
  timestamp,
  senderId: teamleaderid.toString(),
  senderName: tlName,
  senderPic: tlPic,
  seen_by: []
});

    const query = `
      UPDATE projectschema."projectTLClientChats"
      SET "TLChats" = array_append("TLChats", $1),
          "TeamLeaderId" = $3
      WHERE "projectId" = $2
      RETURNING "projectId"
    `;
    const result = await pgPool.query(query, [chatJson, projectIdNum, teamleaderid]);

    if (result.rowCount > 0) {
      const fullQuery = `
        SELECT "TLChats" FROM projectschema."projectTLClientChats" WHERE "projectId" = $1
      `;
      const fullResult = await pgPool.query(fullQuery, [projectIdNum]);
      const newIndex = fullResult.rows[0].TLChats.length - 1;
     const msg = {
  id: newIndex,
  type,
  data,
  timestamp,
  seen_by: [],
  senderId: teamleaderid.toString(),
  senderName: tlName,
  senderPic: tlPic,
};
      if (io) {
        io.to(`tl_monitor_${projectId}`).emit("newTLMonitorMessage", { 
          fromRole: "tl",
          msg,
          projectId 
        });
      }
    }

    return res.status(200).json({
      status: true,
      message: "TL chat added successfully!",
      data: { projectId: result.rows[0].projectId },
    });
  } catch (e) {
    console.error("Server Error:", e);
    return res.status(500).json({ status: false, message: `Server Error: ${e.message}` });
  }
});

// ==================== REMOVE EMPLOYEE FROM PROJECT ====================
router.post("/remove_employee_from_project", async (req, res) => {
  const { project_id, employeeId } = req.body;

  if (!project_id || !employeeId) {
    return res.status(400).json({ status: false, message: "project_id and employeeId are required" });
  }

  const projectIdNum = Number(project_id);
  const employeeIdNum = Number(employeeId);

  if (isNaN(projectIdNum) || isNaN(employeeIdNum)) {
    return res.status(400).json({ status: false, message: "Invalid project_id or employeeId" });
  }

  try {
    // Delete the request row → this automatically disables chat
    const result = await pgPool.query(
      `DELETE FROM projectschema."employeeRequests"
       WHERE project_id = $1 AND employeeid = $2
       RETURNING request_id`,
      [projectIdNum, employeeIdNum]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ status: false, message: "Employee is not assigned to this project" });
    }

    // Real-time notify the employee so their chat disables immediately
    if (io) {
      io.to(`employee_${employeeIdNum}`).emit("employeeRemovedFromProject", {
        projectId: projectIdNum,
        employeeId: employeeIdNum,
      });

      // Also notify the TL room (optional)
      io.to("tl").emit("employeeRemovedFromProject", {
        projectId: projectIdNum,
        employeeId: employeeIdNum,
      });
    }

    return res.status(200).json({
      status: true,
      message: "Employee removed from project successfully",
    });
  } catch (err) {
    console.error("remove_employee_from_project error:", err);
    return res.status(500).json({ status: false, message: err.message });
  }
});

// Add TL audio to monitor chat table
router.post("/add_tl_audio_to_monitor/:projectId", async function (req, res) {
  const { projectId } = req.params;
  const { type, data, timestamp, teamleaderid } = req.body;

  if (!type || !data || !timestamp || !teamleaderid) {
    return res.status(400).json({ status: false, message: "Type, data, timestamp, and teamleaderid are required." });
  }

  const projectIdNum = Number(projectId);
  if (isNaN(projectIdNum)) {
    return res.status(400).json({ status: false, message: "projectId must be a valid number." });
  }

  try {
    // Check project & TL (same as before)
    const projectCheck = await pgPool.query("SELECT project_id FROM projectschema.clientproject WHERE project_id = $1", [projectIdNum]);
    if (projectCheck.rows.length === 0) return res.status(404).json({ status: false, message: "Project not found." });

    const tlCheck = await pgPool.query('SELECT "employeeId" FROM "Entities".employees WHERE "employeeId" = $1 AND role = $2', [teamleaderid, 'Team Leader']);
    if (tlCheck.rows.length === 0) return res.status(404).json({ status: false, message: "Invalid Team Leader." });

    // Check if row exists
    const chatRowCheck = await pgPool.query('SELECT "projectId" FROM projectschema."projectTLClientChats" WHERE "projectId" = $1', [projectIdNum]);
    if (chatRowCheck.rows.length === 0) {
      await pgPool.query('INSERT INTO projectschema."projectTLClientChats" ("projectId", "TeamLeaderId") VALUES ($1, $2)', [projectIdNum, teamleaderid]);
    }

    // 🔥 FETCH TL INFO
    const tlInfo = await pgPool.query('SELECT "employeeName", "employeePic" FROM "Entities".employees WHERE "employeeId" = $1', [teamleaderid]);
    const tlName = tlInfo.rows[0]?.employeeName || "Team Leader";
    const tlPic = tlInfo.rows[0]?.employeePic || "";

    // 🔥 CORRECT audioJson WITH sender info
    const audioJson = JSON.stringify({
      type,
      data,
      timestamp,
      seen_by: [],
      senderId: teamleaderid.toString(),
      senderName: tlName,
      senderPic: tlPic
    });

    const query = `
      UPDATE projectschema."projectTLClientChats"
      SET "TLAudios" = array_append("TLAudios", $1),
          "TeamLeaderId" = $3
      WHERE "projectId" = $2
      RETURNING "projectId"
    `;

    const result = await pgPool.query(query, [audioJson, projectIdNum, teamleaderid]);

    if (result.rowCount > 0) {
      const fullQuery = `SELECT "TLAudios" FROM projectschema."projectTLClientChats" WHERE "projectId" = $1`;
      const fullResult = await pgPool.query(fullQuery, [projectIdNum]);
      const newIndex = fullResult.rows[0].TLAudios.length - 1;

      // 🔥 CORRECT msg WITH sender info
      const msg = {
        id: newIndex,
        type,
        data,
        timestamp,
        seen_by: [],
        senderId: teamleaderid.toString(),
        senderName: tlName,
        senderPic: tlPic
      };

      if (io) {
        io.to(`tl_monitor_${projectId}`).emit("newTLMonitorMessage", {
          fromRole: "tl",
          msg,
          projectId
        });
      }

      return res.status(200).json({
        status: true,
        message: "TL audio added successfully!",
        data: { projectId: result.rows[0].projectId },
      });
    }
  } catch (e) {
    console.error("Server Error:", e);
    return res.status(500).json({ status: false, message: `Server Error: ${e.message}` });
  }
});

router.post("/add_monitor_chat/:projectId", async function (req, res) {
  const { projectId } = req.params;
  const { type, data, timestamp, monitorid } = req.body;

  if (!type || !data || !timestamp || !monitorid) {
    return res.status(400).json({ status: false, message: "Type, data, timestamp, and monitorid are required." });
  }

  const projectIdNum = Number(projectId);
  if (isNaN(projectIdNum)) {
    return res.status(400).json({ status: false, message: "projectId must be a valid number." });
  }

  try {
    const projectCheck = await pgPool.query("SELECT project_id FROM projectschema.clientproject WHERE project_id = $1", [projectIdNum]);
    if (projectCheck.rows.length === 0) return res.status(404).json({ status: false, message: "Project not found." });

    const monitorInfo = await pgPool.query('SELECT "employeeName", "employeePic" FROM "Entities".employees WHERE "employeeId" = $1', [monitorid]);
    const monitorName = monitorInfo.rows[0]?.employeeName || "Employee";
    const monitorPic = monitorInfo.rows[0]?.employeePic || "";

    const chatJson = JSON.stringify({
      type,
      data,
      timestamp,
      senderId: monitorid.toString(),
      senderName: monitorName,
      senderPic: monitorPic,
      seen_by: []
    });

    const query = `UPDATE projectschema."projectTLClientChats" SET "MonitorChats" = array_append("MonitorChats", $1), "MonitorId" = $3 WHERE "projectId" = $2 RETURNING "projectId"`;
    const result = await pgPool.query(query, [chatJson, projectIdNum, monitorid]);

    if (result.rowCount > 0) {
      const fullQuery = `SELECT "MonitorChats" FROM projectschema."projectTLClientChats" WHERE "projectId" = $1`;
      const fullResult = await pgPool.query(fullQuery, [projectIdNum]);
      const newIndex = fullResult.rows[0].MonitorChats.length - 1;
      const msg = { id: newIndex, type, data, timestamp, seen_by: [], senderId: monitorid.toString(), senderName: monitorName, senderPic: monitorPic };
      if (io) io.to(`tl_monitor_${projectId}`).emit("newTLMonitorMessage", { fromRole: "monitor", msg, projectId });
    }

    return res.status(200).json({ status: true, message: "Monitor chat added successfully!" });
  } catch (e) {
    console.error("Server Error:", e);
    return res.status(500).json({ status: false, message: `Server Error: ${e.message}` });
  }
});

router.post("/add_monitor_audio/:projectId", async function (req, res) {
  const { projectId } = req.params;
  const { type, data, timestamp, monitorid } = req.body;

  if (!type || !data || !timestamp || !monitorid) {
    return res.status(400).json({ status: false, message: "Type, data, timestamp, and monitorid are required." });
  }

  const projectIdNum = Number(projectId);
  if (isNaN(projectIdNum)) {
    return res.status(400).json({ status: false, message: "projectId must be a valid number." });
  }

  try {
    const projectCheck = await pgPool.query("SELECT project_id FROM projectschema.clientproject WHERE project_id = $1", [projectIdNum]);
    if (projectCheck.rows.length === 0) return res.status(404).json({ status: false, message: "Project not found." });

    const monitorInfo = await pgPool.query('SELECT "employeeName", "employeePic" FROM "Entities".employees WHERE "employeeId" = $1', [monitorid]);
    const monitorName = monitorInfo.rows[0]?.employeeName || "Employee";
    const monitorPic = monitorInfo.rows[0]?.employeePic || "";

    const audioJson = JSON.stringify({
      type,
      data,
      timestamp,
      senderId: monitorid.toString(),
      senderName: monitorName,
      senderPic: monitorPic,
      seen_by: []
    });

    const query = `UPDATE projectschema."projectTLClientChats" SET "MonitorAudios" = array_append("MonitorAudios", $1), "MonitorId" = $3 WHERE "projectId" = $2 RETURNING "projectId"`;
    const result = await pgPool.query(query, [audioJson, projectIdNum, monitorid]);

    if (result.rowCount > 0) {
      const fullQuery = `SELECT "MonitorAudios" FROM projectschema."projectTLClientChats" WHERE "projectId" = $1`;
      const fullResult = await pgPool.query(fullQuery, [projectIdNum]);
      const newIndex = fullResult.rows[0].MonitorAudios.length - 1;
      const msg = { id: newIndex, type, data, timestamp, seen_by: [], senderId: monitorid.toString(), senderName: monitorName, senderPic: monitorPic };
      if (io) io.to(`tl_monitor_${projectId}`).emit("newTLMonitorMessage", { fromRole: "monitor", msg, projectId });
    }

    return res.status(200).json({ status: true, message: "Monitor audio added successfully!" });
  } catch (e) {
    console.error("Server Error:", e);
    return res.status(500).json({ status: false, message: `Server Error: ${e.message}` });
  }
});

router.get("/get_tl_monitor_chats/:projectId", async function (req, res) {
  const { projectId } = req.params;
  const projectIdNum = Number(projectId);
  if (isNaN(projectIdNum)) {
    return res.status(400).json({ status: false, message: "projectId must be a valid number." });
  }

  try {
    const query = `
      SELECT
        pc."TLChats" as tlchats,
        pc."TLAudios" as tlaudios,
        pc."MonitorChats" as monitorchats,
        pc."MonitorAudios" as monitoraudios,
        pc."MonitorId" as monitorid,
        pc."TeamLeaderId" as teamleaderid,
        tl."employeeName" as teamleadername,
        tl."employeePic" as teamleaderpic,
        mon."employeeName" as monitorname,
        mon."employeePic" as monitorpic
      FROM projectschema."projectTLClientChats" pc
      LEFT JOIN "Entities".employees tl ON pc."TeamLeaderId" = tl."employeeId"
      LEFT JOIN "Entities".employees mon ON pc."MonitorId" = mon."employeeId"
      WHERE pc."projectId" = $1
    `;

    const result = await pgPool.query(query, [projectIdNum]);

    let row = result.rows[0] || { tlchats: [], tlaudios: [], monitorchats: [], monitoraudios: [], teamleadername: null, teamleaderpic: null, monitorname: null, monitorpic: null };

    // 🔥 STRONG ENRICHMENT
    const enrich = async (arr) => {
      if (!arr || !Array.isArray(arr)) return [];
      return await Promise.all(arr.map(async (str) => {
        try {
          let msg = JSON.parse(str);
          if (!msg.senderName && msg.senderId) {
            const emp = await pgPool.query(`SELECT "employeeName" as senderName, "employeePic" as senderPic FROM "Entities".employees WHERE "employeeId" = $1`, [msg.senderId]);
            msg.senderName = emp.rows[0]?.senderName || "Employee";
            msg.senderPic = emp.rows[0]?.senderPic || "";
          }
          return JSON.stringify(msg);
        } catch (e) {
          return str;
        }
      }));
    };

    row.monitorchats = await enrich(row.monitorchats);
    row.monitoraudios = await enrich(row.monitoraudios);

    const data = row;

    if (io) io.to(`tl_monitor_${projectIdNum}`).emit("tlMonitorChatsUpdate", { data });

    return res.status(200).json({ status: true, data });
  } catch (e) {
    console.error("Server Error:", e);
    return res.status(500).json({ status: false, message: `Server Error: ${e.message}` });
  }
});

// Mark TL-Monitor message as seen
router.post("/mark_tl_monitor_message_seen/:projectId", async (req, res) => {
  const { projectId } = req.params;
  const { index, fromTL, type, viewer, timestamp } = req.body;  // fromTL: true if from TL, false if from Monitor

  if (
    typeof index !== "number" ||
    index < 0 ||
    typeof fromTL !== "boolean" ||
    !["chat", "audio"].includes(type) ||
    !["tl", "monitor"].includes(viewer)
  ) {
    return res.status(400).json({ status: false, message: "Invalid request parameters" });
  }

  try {
    let field;
    if (fromTL) {
      field = type === "audio" ? "TLAudios" : "TLChats";
    } else {
      field = type === "audio" ? "MonitorAudios" : "MonitorChats";
    }

    const result = await pgPool.query(
      `SELECT "${field}" FROM projectschema."projectTLClientChats" WHERE "projectId" = $1`,
      [projectId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ status: false, message: "Chat not found" });
    }

    const messages = result.rows[0][field] || [];

    if (index >= messages.length) {
      return res.status(400).json({ status: false, message: "Invalid message index" });
    }

    let msgObj;
    try {
      msgObj = JSON.parse(messages[index]);
    } catch (parseError) {
      console.error("Error parsing message JSON:", parseError);
      return res.status(500).json({ status: false, message: "Invalid message format" });
    }

    if (!Array.isArray(msgObj.seen_by)) {
      msgObj.seen_by = [];
    }

    if (msgObj.seen_by.includes(viewer)) {
      return res.status(200).json({ status: true, message: "Message already seen by this user" });
    }

    msgObj.seen_by.push(viewer);
    messages[index] = JSON.stringify(msgObj);

    await pgPool.query(
      `UPDATE projectschema."projectTLClientChats" SET "${field}" = $1 WHERE "projectId" = $2`,
      [messages, projectId]
    );

    // Emit via socket for live update
    if (io) {
      io.to(`tl_monitor_${projectId}`).emit("tlMonitorMessageSeen", {
        fromTL,
        timestamp: msgObj.timestamp || timestamp, // Use parsed or provided timestamp
        seen_by: msgObj.seen_by,
        projectId,
      });
    }

    return res.status(200).json({ status: true, message: "Message marked as seen" });
  } catch (error) {
    console.error("Error marking message as seen:", error);
    return res.status(500).json({ status: false, message: "Internal server error" });
  }
});

// UPDATED: Ab sab assigned employees ko chat milega (flat mode)
router.get("/is_employee_chat_eligible/:projectId/:employeeId", async function (req, res) {
  const { projectId, employeeId } = req.params;
  const projectIdNum = Number(projectId);
  const employeeIdNum = Number(employeeId);

  if (isNaN(projectIdNum) || isNaN(employeeIdNum)) {
    return res.status(400).json({ status: false, showChat: false });
  }

  try {
    const result = await pgPool.query(`
      SELECT COUNT(*) as count 
      FROM projectschema."employeeRequests" 
      WHERE "project_id" = $1 
        AND employeeid::text = $2 
        AND "status" IN ('accepted', 'TLAssign')
    `, [projectIdNum, employeeIdNum]);

    const isAssigned = parseInt(result.rows[0].count) > 0;

    return res.status(200).json({
      status: true,
      showChat: isAssigned
    });
  } catch (e) {
    console.error("Eligibility error:", e);
    return res.status(500).json({ status: false, showChat: false });
  }
});

const defaultProgress = {
  start: 'no',
  payment: '0%',
  work: '0%'
};

router.get('/get_progress/:projectId', async (req, res) => {
  const { projectId } = req.params;
  try {
    let result = await pgPool.query(`
      SELECT progress, last_payment_update, last_work_update 
      FROM projectschema."progressTracking" WHERE project_id = $1
    `, [projectId]);
    if (result.rows.length === 0) {
      await pgPool.query(`
        INSERT INTO projectschema."progressTracking" (project_id, progress) VALUES ($1, $2)
      `, [projectId, defaultProgress]);
      result = await pgPool.query(`
        SELECT progress, last_payment_update, last_work_update 
        FROM projectschema."progressTracking" WHERE project_id = $1
      `, [projectId]);
    }
    res.json({ 
      status: true, 
      progress: result.rows[0].progress,
      last_payment_update: result.rows[0].last_payment_update,  // NEW
      last_work_update: result.rows[0].last_work_update        // NEW
    });
  } catch (e) {
    console.error('Error fetching progress:', e);
    res.status(500).json({ status: false, message: e.message });
  }
});

router.post('/update_progress/:projectId', async (req, res) => {
  const { projectId } = req.params;
  const { type } = req.body; // type: 'payment' or 'work'
  if (!['payment', 'work'].includes(type)) {
    return res.status(400).json({ status: false, message: 'Invalid type' });
  }
  try {
    const result = await pgPool.query(`
      SELECT progress FROM projectschema."progressTracking" WHERE project_id = $1 FOR UPDATE
    `, [projectId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ status: false, message: 'Progress not found' });
    }
    let prog = { ...result.rows[0].progress };
    // REMOVE: Implicit start (assumed started)
    const current_num = parseFloat(prog[type].replace('%', '')) || 0;
    if (current_num >= 100) {
      return res.status(400).json({ status: false, message: 'Your progress is already complete' });
    }
    const new_num = current_num + 20;
    prog[type] = `${new_num}%`;

    // NEW: Update corresponding timestamp
    const timestampField = type === 'payment' ? 'last_payment_update' : 'last_work_update';
    await pgPool.query(`
      UPDATE projectschema."progressTracking" 
      SET progress = $1, ${timestampField} = CURRENT_TIMESTAMP 
      WHERE project_id = $2
    `, [prog, projectId]);

    res.json({ status: true, progress: prog });
  } catch (e) {
    console.error('Error updating progress:', e);
    res.status(500).json({ status: false, message: e.message });
  }
});

// Keep a reference to the Socket.IO server so other helpers can emit if needed.
// Message handlers live in socket/index.js only — do not re-register them here
// or every client event will be handled twice (duplicate chat rows).
module.exports.attachIo = (ioInstance) => {
  io = ioInstance;
};

// ==================== OFFICIAL PROJECT ASSIGNED EMAIL (Exact match to your save_project style) ====================
const sendAssignmentEmail = async (employeeMail, employeeName, projectTitle, workstream, projectId) => {
  if (!employeeMail || !employeeMail.includes('@')) return;

  const dashboardUrl = `${process.env.PMS_URL || 'https://ccitpms.com/'}`;

  const msg = {
    from: process.env.SMTP_USER,
    to: employeeMail,
    subject: `Project Assigned: ${projectTitle} - CogniCode Project Management`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 620px; margin:auto; padding:20px; border:1px solid #e0e0e0; border-radius:8px; background:#fafafa;">
        
        <h2 style="color: #34a853; text-align:center;">Project Assigned to You ✅</h2>
        
        <p>Hello <strong>${employeeName}</strong>,</p>
        <p>You have been assigned the following project by the Team Leader:</p>
        
        <table style="width:100%; border-collapse:collapse; margin:20px 0; background:white; border-radius:6px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,0.1);">
          <tr><td style="padding:12px; font-weight:bold; background:#f1f3f5;">Title</td><td style="padding:12px;">${projectTitle}</td></tr>
          <tr><td style="padding:12px; font-weight:bold; background:#f1f3f5;">Workstream</td><td style="padding:12px;">${workstream || 'N/A'}</td></tr>
          <tr><td style="padding:12px; font-weight:bold; background:#f1f3f5;">Project ID</td><td style="padding:12px;">#${projectId}</td></tr>
        </table>
        
        <p style="text-align:center; margin:30px 0;">
          <a href="${dashboardUrl}"
             style="background:#1a73e8; color:white; padding:12px 28px; text-decoration:none; border-radius:6px; font-weight:bold; display:inline-block;">
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

  try {
    await transporter.sendMail(msg);
    console.log(`✅ Official Assignment email sent to ${employeeMail}`);
  } catch (err) {
    console.error(`Failed to send assignment email to ${employeeMail}:`, err);
  }
};

async function sweepStaleUploads(maxAgeMs = 24 * 60 * 60 * 1000) {

    const sessions = await fsp
        .readdir(UPLOAD_TMP_ROOT)
        .catch(() => []);

    for (const id of sessions) {

        try {

            const meta = await readMeta(id);

            if (
                meta.createdAt &&
                Date.now() - new Date(meta.createdAt).getTime() > maxAgeMs
            ) {

                await fsp.rm(
                    path.join(UPLOAD_TMP_ROOT, id),
                    {
                        recursive: true,
                        force: true
                    }
                );

            }

        } catch {}

    }

}

module.exports = router;
module.exports.sendPushNotification = sendPushNotification;
module.exports.attachIo = module.exports.attachIo;
module.exports.getProjectItem = getProjectItem;