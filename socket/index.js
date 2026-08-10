//socket.js

const crypto = require("crypto");
const pgPool = require("../routes/PostgreSQLPool");
// const { sendPushNotification } = require('../routes/clientproject');
const clientProject = require('../routes/clientproject');
const { sendPushNotification } = clientProject;

// In-memory idempotency for chat file/text emits (prevents double-save on double click / reconnect)
// key = `${projectId}:${tempId}` → expires after TTL
const recentTempIds = new Map();
const TEMP_ID_TTL_MS = 5 * 60 * 1000;

function claimTempId(projectId, tempId) {
  if (!tempId) return true; // no tempId → allow (legacy clients)
  const key = `${projectId}:${tempId}`;
  const now = Date.now();
  // purge stale
  for (const [k, t] of recentTempIds) {
    if (now - t > TEMP_ID_TTL_MS) recentTempIds.delete(k);
  }
  if (recentTempIds.has(key)) {
    console.warn("⛔ Duplicate tempId ignored:", key);
    return false;
  }
  recentTempIds.set(key, now);
  return true;
}

function makeMessageId() {
  return crypto.randomUUID();
}

/**
 * Deliver chat without double-bubble on sender:
 *  - Others in project room → "newMessage"
 *  - Sender only → "messageAck" (upgrade tempId / attach server id)
 * Never use io.to(room) for chat files — that re-delivers to the sender.
 */
function emitChatToRoom(socket, projectId, fromRole, msg) {
  const room = `project_${projectId}`;
  socket.to(room).emit("newMessage", { projectId, fromRole, msg });
  socket.emit("messageAck", { projectId, fromRole, msg });
}

module.exports = (io) => {
  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("joinProject", (projectId) => {
      const room = `project_${projectId}`;
      socket.join(room);
      console.log(`User ${socket.id} joined room: ${room}`);
    });

    // New: Join global head room for employee reg updates
    socket.on("joinHeadRoom", () => {
      socket.join("head");
      console.log(`User ${socket.id} joined head room`);
    });
    socket.on("joinClientRoom", (clientId) => {
      const room = `client_${clientId}`;
      socket.join(room);
      console.log(`User ${socket.id} joined client room: ${room}`);
    });
    socket.on("joinTlRoom", () => {
  socket.join("tl");
  console.log(`User ${socket.id} joined TL room`);
});

socket.on("joinEmployeeRoom", (employeeId) => {
  socket.join("employees");

  if (employeeId) {
    const personalRoom = `employee_${employeeId}`;
    socket.join(personalRoom);
    console.log(`✅ Employee joined personal room: ${personalRoom}`);
  }
});

    // Fixed: Join TL Monitor room event name (standardized to camelCase)
socket.on("joinEmployeeChat", (projectId) => {
  const room = `tl_monitor_${projectId}`;
  socket.join(room);
  console.log(`✅ Employee joined shared chat room: ${room}`);
});

socket.on("requestTLMonitorChats", async (projectId) => {
  try {
    const projectIdNum = Number(projectId);
    if (isNaN(projectIdNum)) return;

    const query = `
      SELECT 
        pc."TLChats" as tlchats,
        pc."TLAudios" as tlaudios,
        pc."MonitorChats" as monitorchats,
        pc."MonitorAudios" as monitoraudios,
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

    let chats = result.rows[0] || { tlchats: [], tlaudios: [], monitorchats: [], monitoraudios: [], teamleadername: null, teamleaderpic: null, monitorname: null, monitorpic: null };

    // 🔥 ENRICHMENT FOR MONITOR CHATS (REAL NAME + PIC)
    const enrich = async (arr) => {
      if (!arr || !Array.isArray(arr)) return [];
      return await Promise.all(arr.map(async (str) => {
        try {
          let msg = JSON.parse(str);
          if (!msg.senderName && msg.senderId) {
            const emp = await pgPool.query(
              `SELECT "employeeName" as senderName, "employeePic" as senderPic 
               FROM "Entities".employees WHERE "employeeId" = $1`,
              [msg.senderId]
            );
            msg.senderName = emp.rows[0]?.senderName || "Employee";
            msg.senderPic = emp.rows[0]?.senderPic || "";
          }
          return JSON.stringify(msg);
        } catch (e) {
          return str;
        }
      }));
    };

    chats.monitorchats = await enrich(chats.monitorchats);
    chats.monitoraudios = await enrich(chats.monitoraudios);

    socket.emit("tlMonitorChats", chats);
  } catch (e) {
    console.error("Socket Error:", e);
  }
});

socket.on("sendClientMessage", async (data) => {
  const { projectId, type, msgData, timestamp, mention, tempId, replyTo, caption } = data;
  try {
    const projectIdNum = Number(projectId);
    if (isNaN(projectIdNum)) return;
    if (!claimTempId(projectIdNum, tempId)) return;

    const projectCheck = await pgPool.query(
      "SELECT project_id FROM projectschema.clientproject WHERE project_id = $1",
      [projectIdNum]
    );
    if (projectCheck.rows.length === 0) return;

    if (mention) {
      if (mention.type === "head") {
        const headCheck = await pgPool.query(
          'SELECT "headId" FROM "Entities".head WHERE "headId" = $1',
          [mention.id]
        );
        if (headCheck.rows.length === 0) return;
      } else {
        return;
      }
    }

    // Client messages must land in client* columns (not head*),
    // so Client / Head / TL all reload the same history correctly.
    const storedType = type === "audio" ? "file" : type;
    const field = (type === "audio" || type === "file") ? "clientaudios" : "clientchats";

    // Normalize file payload so clients never receive null MIME types
    let normalizedData = msgData;
    if ((type === "file" || type === "audio") && msgData && typeof msgData === "object") {
      normalizedData = {
        ...msgData,
        name: msgData.name || "File",
        url: msgData.url || "",
        type: msgData.type || (type === "audio" ? "audio/mpeg" : "application/octet-stream"),
      };
    }

    const messageId = makeMessageId();
    const ts = timestamp || new Date().toISOString();
    let chatJson;
    try {
      chatJson = JSON.stringify({
        type: storedType,
        data: normalizedData,
        caption: caption || data.caption || null,
        timestamp: ts,
        seen_by: [],
        mention: mention || null,
        replyTo: replyTo || null,
        fromRole: "client",
        fromClient: true,
        messageId,
        tempId: tempId || null,
      });
    } catch (strErr) {
      console.error("Socket JSON failed:", strErr);
      return;
    }

    const query = `
      UPDATE projectschema.clientproject
      SET ${field} = array_append(COALESCE(${field}, ARRAY[]::text[]), $1)
      WHERE project_id = $2
      RETURNING ${field}
    `;
    const result = await pgPool.query(query, [chatJson, projectIdNum]);

    if (result.rowCount > 0) {
      const newIndex = result.rows[0][field].length - 1;
      const msg = {
        id: newIndex,
        messageId,
        type: storedType,
        data: normalizedData,
        caption: caption || data.caption || null,
        timestamp: ts,
        seen_by: [],
        mention: mention || null,
        replyTo: replyTo || null,
        tempId,
        fromRole: "client",
        fromClient: true,
      };

      emitChatToRoom(socket, projectId, "client", msg);

      const projectQuery = await pgPool.query(
        "SELECT headid FROM projectschema.clientproject WHERE project_id = $1",
        [projectIdNum]
      );
      const headId = projectQuery.rows[0]?.headid;
      if (headId && !msg.seen_by.includes("head")) {
        const title = type === "text" ? "New Client Message" : "New Client File";
        const body =
          type === "text"
            ? typeof normalizedData === "string"
              ? normalizedData.slice(0, 50) + "..."
              : normalizedData?.name || "File"
            : `File: ${normalizedData?.name || "Unknown"}`;
        await sendPushNotification(headId.toString(), "head", title, body, projectIdNum);
      }
    }
  } catch (e) {
    console.error("Socket Error (sendClientMessage):", e);
  }
});

socket.on("sendHeadMessage", async (data) => {
  console.log("HEAD MESSAGE RECEIVED:", data);

  const { projectId, type, msgData, timestamp, mention, tempId, headId, replyTo, caption } = data;

  try {
    const projectIdNum = Number(projectId);
    if (isNaN(projectIdNum)) {
      console.warn("Invalid projectId");
      return;
    }
    if (!claimTempId(projectIdNum, tempId)) return;

    const projectCheck = await pgPool.query(
      "SELECT project_id FROM projectschema.clientproject WHERE project_id = $1",
      [projectIdNum]
    );
    if (projectCheck.rows.length === 0) {
      console.warn("Project not found:", projectIdNum);
      return;
    }

    // Keep legacy layout: audio → headaudios, text+file → headchats
    // (client/tl store files under *audios; head historically uses headchats for files)
    const storedType = type === "audio" ? "file" : type;
    const field = type === "audio" ? "headaudios" : "headchats";

    // Normalize file payload
    let normalizedData = msgData;
    if ((type === "file" || type === "audio") && msgData && typeof msgData === "object") {
      normalizedData = {
        ...msgData,
        name: msgData.name || "File",
        url: msgData.url || "",
        type: msgData.type || (type === "audio" ? "audio/mpeg" : "application/octet-stream"),
      };
    }

    const messageId = makeMessageId();
    const ts = timestamp || new Date().toISOString();
    const chatJson = JSON.stringify({
      type: storedType,
      data: normalizedData,
      caption: caption || data.caption || null,
      timestamp: ts,
      seen_by: [],
      mention: mention || null,
      replyTo: replyTo || null,
      fromRole: "head",
      fromHead: true,
      messageId,
      tempId: tempId || null,
    });

    const query = `
      UPDATE projectschema.clientproject
      SET ${field} = array_append(COALESCE(${field}, ARRAY[]::text[]), $1),
          headid = COALESCE(headid, $3)
      WHERE project_id = $2
      RETURNING ${field}
    `;

    const result = await pgPool.query(query, [chatJson, projectIdNum, headId || null]);

    if (result.rowCount > 0) {
      const newIndex = result.rows[0][field].length - 1;

      const msg = {
        id: newIndex,
        messageId,
        type: storedType,
        data: normalizedData,
        caption: caption || data.caption || null,
        timestamp: ts,
        seen_by: [],
        mention: mention || null,
        replyTo: replyTo || null,
        tempId,
        fromRole: "head",
        fromHead: true,
      };

      console.log("✅ Message saved to", field, "index:", newIndex, "messageId:", messageId);

      emitChatToRoom(socket, projectId, "head", msg);

      // Push notification
      const projectQuery = await pgPool.query(
        'SELECT clientid FROM projectschema.clientproject WHERE project_id = $1',
        [projectIdNum]
      );
      const clientId = projectQuery.rows[0]?.clientid;

      if (clientId) {
        const title = type === 'text' ? 'New Message from Head' : 'New File from Head';
        const body = type === 'text'
          ? (typeof normalizedData === 'string' ? normalizedData.slice(0, 50) + '...' : 'File')
          : `File: ${normalizedData?.name || 'Unknown'}`;

        await sendPushNotification(clientId.toString(), 'client', title, body, projectIdNum);
      }
    }
  } catch (e) {
    console.error("Socket Error (sendHeadMessage):", e);
  }
});

socket.on("sendTLMessage", async (data) => {
  const { projectId, type, msgData, timestamp, teamleaderid, mention, tempId, replyTo } = data;
  try {
    const projectIdNum = Number(projectId);
    if (isNaN(projectIdNum)) return;
    if (!claimTempId(projectIdNum, tempId)) return;

    const projectCheck = await pgPool.query(
      "SELECT project_id, teamleaderid FROM projectschema.clientproject WHERE project_id = $1",
      [projectIdNum]
    );
    if (projectCheck.rows.length === 0) return;

    // Accept TL if they are a Team Leader employee OR assigned as this project's team leader.
    // Silent drops here previously broke TL file chat from the landing page.
    let resolvedTlId = teamleaderid;
    if (resolvedTlId) {
      const teamLeaderCheck = await pgPool.query(
        `SELECT "employeeId" FROM "Entities".employees
         WHERE "employeeId" = $1
           AND (role = 'Team Leader' OR LOWER(COALESCE(role, '')) IN ('team leader', 'teamleader', 'tl'))`,
        [resolvedTlId]
      );
      const isAssignedTl =
        projectCheck.rows[0]?.teamleaderid != null &&
        String(projectCheck.rows[0].teamleaderid) === String(resolvedTlId);
      if (teamLeaderCheck.rows.length === 0 && !isAssignedTl) {
        console.warn("sendTLMessage rejected: not a TL and not project assignee", {
          teamleaderid: resolvedTlId,
          projectId: projectIdNum,
        });
        return;
      }
    } else {
      resolvedTlId = projectCheck.rows[0]?.teamleaderid || null;
      if (!resolvedTlId) {
        console.warn("sendTLMessage rejected: missing teamleaderid", { projectId: projectIdNum });
        return;
      }
    }

    if (mention) {
      if (mention.type === 'client') {
        const clientCheck = await pgPool.query(
          'SELECT "clientId" FROM "Entities".clients WHERE "clientId" = $1',
          [mention.id]
        );
        if (clientCheck.rows.length === 0) return;
      } else if (mention.type === 'head') {
        const headCheck = await pgPool.query(
          'SELECT "headId" FROM "Entities".head WHERE "headId" = $1',
          [mention.id]
        );
        if (headCheck.rows.length === 0) return;
      } else {
        return;
      }
    }

    // Normalize file payload so clients never receive null MIME types
    let normalizedData = msgData;
    if ((type === "file" || type === "audio") && msgData && typeof msgData === "object") {
      normalizedData = {
        ...msgData,
        name: msgData.name || "File",
        url: msgData.url || "",
        type: msgData.type || (type === "audio" ? "audio/mpeg" : "application/octet-stream"),
      };
    }

    const storedType = type === "audio" ? "file" : type;
    const messageId = makeMessageId();
    const ts = timestamp || new Date().toISOString();
    const chatJson = JSON.stringify({
      type: storedType,
      data: normalizedData,
      caption: data.caption || null,
      timestamp: ts,
      seen_by: [],
      mention: mention || null,
      replyTo: replyTo || null,
      fromRole: "tl",
      fromTeamLeader: true,
      messageId,
      tempId: tempId || null,
    });

    const field = (type === "audio" || type === "file") ? "tlaudios" : "tlchats";
    const query = `
      UPDATE projectschema.clientproject
      SET ${field} = array_append(COALESCE(${field}, ARRAY[]::text[]), $1),
          teamleaderid = COALESCE(teamleaderid, $3)
      WHERE project_id = $2
      RETURNING ${field}
    `;
    const result = await pgPool.query(query, [chatJson, projectIdNum, resolvedTlId]);

    if (result.rowCount > 0) {
      const newIndex = result.rows[0][field].length - 1;
      const msg = {
        id: newIndex,
        messageId,
        type: storedType,
        data: normalizedData,
        caption: data.caption || null,
        timestamp: ts,
        seen_by: [],
        mention: mention || null,
        replyTo: replyTo || null,
        tempId,
        fromRole: "tl",
        fromTeamLeader: true,
      };
      emitChatToRoom(socket, projectId, "tl", msg);

      // Existing: Trigger push to client
      const projectQuery = await pgPool.query('SELECT clientid FROM projectschema.clientproject WHERE project_id = $1', [projectIdNum]);
      const clientId = projectQuery.rows[0]?.clientid;
      if (clientId && !msg.seen_by.includes('client')) {
        const title = type === 'text' ? 'New Message from Team Leader' : 'New File from Team Leader';
        const body = type === 'text' ? (typeof msgData === 'string' ? msgData.slice(0, 50) + '...' : (msgData.name || 'File')) : `File: ${msgData.name || 'Unknown'}`;
        await sendPushNotification(clientId.toString(), 'client', title, body, projectIdNum);
      }

      // NEW: Trigger push to Head when TL sends a message
      const headQuery = await pgPool.query('SELECT headid FROM projectschema.clientproject WHERE project_id = $1', [projectIdNum]);
      const headId = headQuery.rows[0]?.headid;
      if (headId && !msg.seen_by.includes('head')) {
        const titleHead = type === 'text' ? 'New Message from Team Leader' : 'New File from Team Leader';
        const bodyHead = type === 'text' ? (typeof msgData === 'string' ? msgData.slice(0, 50) + '...' : (msgData.name || 'File')) : `File: ${msgData.name || 'Unknown'}`;
        await sendPushNotification(headId.toString(), 'head', titleHead, bodyHead, projectIdNum);
      }
    }
  } catch (e) {
    console.error("Socket Error:", e);
  }
});

socket.on("sendTLToMonitorMessage", async (data) => {
  const { projectId, type, msgData, timestamp, senderId, tempId, replyTo, senderName } = data;
  try {
    const projectIdNum = Number(projectId);
    if (isNaN(projectIdNum)) return;

    const projectCheck = await pgPool.query(
      "SELECT project_id FROM projectschema.clientproject WHERE project_id = $1",
      [projectIdNum]
    );
    if (projectCheck.rows.length === 0) return;

    const senderIdNum = Number(senderId);
    const tlCheck = await pgPool.query(
      'SELECT "employeeId" FROM "Entities".employees WHERE "employeeId" = $1 AND role = $2',
      [senderIdNum, 'Team Leader']
    );
    if (tlCheck.rows.length === 0) return;

    // ====================== FETCH REAL SENDER NAME & PIC (THIS WAS MISSING) ======================
    const senderResult = await pgPool.query(
      'SELECT "employeeName" as senderName, "employeePic" as senderPic FROM "Entities".employees WHERE "employeeId" = $1',
      [senderIdNum]
    );
    // const senderName = senderResult.rows[0]?.senderName || "Team Leader";
    const senderPic  = senderResult.rows[0]?.senderPic || "";

    // Check if row exists, create if not
    const chatRowCheck = await pgPool.query(
      'SELECT "projectId" FROM projectschema."projectTLClientChats" WHERE "projectId" = $1',
      [projectIdNum]
    );
    if (chatRowCheck.rows.length === 0) {
      await pgPool.query(
        'INSERT INTO projectschema."projectTLClientChats" ("projectId", "TeamLeaderId") VALUES ($1, $2)',
        [projectIdNum, senderIdNum]
      );
    }

    const chatJson = JSON.stringify({ 
      type, 
      data: msgData, 
      timestamp, 
      seen_by: [],
      replyTo: replyTo || null,
      senderName,     // ← ADDED
      senderPic,      // ← ADDED
      senderId: senderId.toString()  // ← ADDED (for isMe check)
    });

    const field = type === "audio" ? '"TLAudios"' : '"TLChats"';
    const query = `
      UPDATE projectschema."projectTLClientChats"
      SET ${field} = array_append(${field}, $1),
          "TeamLeaderId" = $3
      WHERE "projectId" = $2
      RETURNING ${field} as field_data
    `;
    const result = await pgPool.query(query, [chatJson, projectIdNum, senderIdNum]);

    if (result.rowCount > 0) {
      const newIndex = result.rows[0].field_data.length - 1;
      const msg = {
        id: newIndex,
        type,
        data: msgData,
        timestamp,
        seen_by: [],
        replyTo: replyTo || null,
        senderName,     // ← ADDED (live)
        senderPic,      // ← ADDED (live)
        senderId: senderId.toString(), // ← ADDED
        tempId
      };

      console.log("📤 EMITTING TO ROOM:", `tl_monitor_${projectId}`);
      io.to(`tl_monitor_${projectId}`).emit("newTLMonitorMessage", {
        fromRole: "tl",
        msg,
        projectId,
      });

      // Push notification (unchanged)
      // ... (your existing push code)
    }
  } catch (e) {
    console.error("Socket Error (sendTLToMonitorMessage):", e);
  }
});

// ====================== NEW: UNIFIED EMPLOYEE CHAT (No Monitor Logic) ======================
socket.on("sendEmployeeMessage", async (data) => {
  const { projectId, type, msgData, timestamp, senderId, tempId, replyTo, senderName } = data;
  console.log(`🔔 sendEmployeeMessage received: projectId=${projectId}, senderId=${senderId}, type=${type}, senderName=${senderName}`);

  try {
    const projectIdNum = Number(projectId);
    if (isNaN(projectIdNum)) return;

    const projectCheck = await pgPool.query(
      "SELECT project_id FROM projectschema.clientproject WHERE project_id = $1",
      [projectIdNum]
    );
    if (projectCheck.rows.length === 0) return;

    const senderIdNum = Number(senderId);

    // Simple check: Is this employee assigned to the project?
    const assignedQuery = `
      SELECT DISTINCT employeeid::TEXT as employeeid_str
      FROM projectschema."employeeRequests"
      WHERE "project_id" = $1 AND "status" IN ('accepted', 'TLAssign')
    `;
    const assignedResult = await pgPool.query(assignedQuery, [projectIdNum]);
    const assignedEmployees = assignedResult.rows.map(row => row.employeeid_str);

    if (!assignedEmployees.includes(senderId.toString())) {
      console.log(`❌ Employee ${senderId} not assigned to project ${projectId}`);
      return;
    }

    // Fetch real sender details
    const senderResult = await pgPool.query(
      'SELECT "employeeName" as senderName, "employeePic" as senderPic FROM "Entities".employees WHERE "employeeId" = $1',
      [senderIdNum]
    );
    // const senderName = senderResult.rows[0]?.senderName || "Employee";
    const senderPic  = senderResult.rows[0]?.senderPic || "";

    const chatJson = JSON.stringify({ 
      type, 
      data: msgData, 
      timestamp, 
      seen_by: [],
      replyTo: replyTo || null,
      senderId: senderId.toString(),
      senderName,
      senderPic
    });

    // Ensure chat row exists
    const chatRowCheck = await pgPool.query(
      'SELECT "projectId" FROM projectschema."projectTLClientChats" WHERE "projectId" = $1',
      [projectIdNum]
    );
    if (chatRowCheck.rows.length === 0) {
      await pgPool.query(
        'INSERT INTO projectschema."projectTLClientChats" ("projectId") VALUES ($1)',
        [projectIdNum]
      );
    }

    const field = type === "audio" ? '"MonitorAudios"' : '"MonitorChats"';
    const query = `
      UPDATE projectschema."projectTLClientChats"
      SET ${field} = array_append(${field}, $1)
      WHERE "projectId" = $2
      RETURNING ${field} as field_data
    `;
    const result = await pgPool.query(query, [chatJson, projectIdNum]);

    if (result.rowCount > 0) {
      const newIndex = result.rows[0].field_data.length - 1;
      const msg = {
        id: newIndex,
        type,
        data: msgData,
        timestamp,
        seen_by: [],
        replyTo: replyTo || null,
        senderId: senderId.toString(),
        senderName,
        senderPic,
        tempId
      };

      console.log(`📤 EMPLOYEE MESSAGE SENT → Room: tl_monitor_${projectId}`);

      // Broadcast to ALL in the shared room (Team Leader + All Employees)
      io.to(`tl_monitor_${projectId}`).emit("newTLMonitorMessage", {
        fromRole: "employee",
        msg,
        projectId
      });

      // Push to Team Leader
      try {
        const proj = await pgPool.query(`
          SELECT teamleaderid FROM projectschema.clientproject WHERE project_id = $1
        `, [projectIdNum]);
        if (proj.rows[0]?.teamleaderid) {
          await sendPushNotification(
            proj.rows[0].teamleaderid.toString(),
            'employee',
            type === "audio" ? 'New Employee File' : 'New Employee Message',
            type === "audio" ? 'File attached' : (typeof msgData === 'string' ? msgData.slice(0, 50) + '...' : 'File attached'),
            projectIdNum
          );
        }
      } catch (pushErr) {
        console.error('Push error:', pushErr);
      }
    }
  } catch (e) {
    console.error("Socket Error (sendEmployeeMessage):", e);
  }
});

socket.on("markProjectSeen", async (data) => {
  const { projectId, index, fromRole, type, viewer, timestamp } = data;  // Already includes timestamp

  if (
    typeof index !== "number" ||
    index < 0 ||
    !["client", "head", "tl"].includes(fromRole) ||
    !["chat", "audio"].includes(type) ||
    !["client", "head", "tl"].includes(viewer)
  ) {
    return;
  }

  try {
    let field;
    if (fromRole === "client") {
      field = type === "audio" ? "clientaudios" : "clientchats";
    } else if (fromRole === "head") {
      field = type === "audio" ? "headaudios" : "headchats";
    } else if (fromRole === "tl") {
      field = type === "audio" ? "tlaudios" : "tlchats";
    }

    const result = await pgPool.query(
      `SELECT ${field} FROM projectschema.clientproject WHERE project_id = $1`,
      [projectId]
    );

    if (result.rows.length === 0) return;

    const messages = result.rows[0][field] || [];

    if (index >= messages.length) return;

    let msgObj;
    try {
      msgObj = JSON.parse(messages[index]);
    } catch (parseError) {
      console.error("Error parsing message JSON:", parseError);
      return;
    }

    if (!Array.isArray(msgObj.seen_by)) {
      msgObj.seen_by = [];
    }

    if (msgObj.seen_by.includes(viewer)) {
      return;
    }

    msgObj.seen_by.push(viewer);
    messages[index] = JSON.stringify(msgObj);

    await pgPool.query(
      `UPDATE projectschema.clientproject SET ${field} = $1 WHERE project_id = $2`,
      [messages, projectId]
    );

    // Updated: Include timestamp in emit for frontend matching
    io.to(`project_${projectId}`).emit("messageSeen", {
      projectId,
      fromRole,
      index,
      seen_by: msgObj.seen_by,
      type,
      timestamp,  // Add this line
    });
  } catch (error) {
    console.error("Error marking message as seen:", error);
  }
});

// new

socket.on('sendMessage', async (data) => {
  const { fromRole, msg, projectId, headId } = data;
  try {
    const projectIdNum = Number(projectId);
    if (isNaN(projectIdNum)) return;

    const projResult = await pgPool.query(
      'SELECT * FROM projectschema."clientproject" WHERE project_id = $1',
      [projectIdNum]
    );
    if (projResult.rows.length === 0) {
      console.warn(`❌ Project ${projectId} not found`);
      return socket.emit('error', { message: 'Project not found' });
    }
    const proj = projResult.rows[0];
    console.log(`📋 Project ${projectId}: clientId=${proj.clientid}, headId=${proj.headid}, tlId=${proj.teamleaderid}`);

    const timestamp = msg.timestamp || new Date().toISOString();
    const msgObj = {
      type: msg.type || (msg.file ? 'file' : 'text'),
      data: msg.data || (msg.type === 'file' ? { 
        name: msg.file?.name || 'File',
        url: msg.file?.url || '',
        type: msg.file?.type || ''
      } : ''),
      timestamp,
      seen_by: msg.seen_by || [],
      mention: msg.mention || null,
      replyTo: msg.replyTo || null
    };

    // Save to correct array
    let updateField;
    if (msgObj.type === 'file') {
      if (fromRole === 'client') updateField = 'clientaudios';
      else if (fromRole === 'tl') updateField = 'tlaudios';
      else if (fromRole === 'head') updateField = 'headaudios';
    } else {
      if (fromRole === 'client') updateField = 'clientchats';
      else if (fromRole === 'tl') updateField = 'tlchats';
      else if (fromRole === 'head') updateField = 'headchats';
    }
    if (!updateField) return socket.emit('error', { message: 'Invalid fromRole or type' });

    const jsonStr = JSON.stringify(msgObj);
    await pgPool.query(
      `UPDATE projectschema."clientproject" SET ${updateField} = array_append(COALESCE(${updateField}, ARRAY[]::text[]), $1) WHERE project_id = $2`,
      [jsonStr, projectIdNum]
    );
    console.log(`💾 Saved to ${updateField} for project ${projectId}`);

    // Others get newMessage; sender should use dedicated role emits (sendHeadMessage etc.)
    // Keep exclude-sender for this legacy path.
    const room = `project_${projectId}`;
    console.log(`📡 Emitting 'newMessage' to room ${room} (excluding sender)`);
    socket.to(room).emit('newMessage', { projectId, fromRole, msg: msgObj });
    // Do not also emit to sender — avoids double bubbles if any client still uses sendMessage

    // TRIGGER PUSH
    let recipientId, recipientType, title, body;
    if (fromRole === 'client') {
      recipientId = proj.headid;
      recipientType = 'head';
      title = 'New Client Message';
      body = msgObj.type === 'text' ? msgObj.data.slice(0, 50) + '...' : `${msgObj.data.name} shared a file`;
    } else if (fromRole === 'tl') {
      recipientId = proj.headid;
      recipientType = 'head';
      title = 'New TL Message';
      body = msgObj.type === 'text' ? msgObj.data.slice(0, 50) + '...' : `${msgObj.data.name} shared a file`;
    } else if (fromRole === 'head') {
      // Head → Client or TL, but for simplicity, assuming to client
      recipientId = proj.clientid;
      recipientType = 'client';
      title = 'New Head Message';
      body = msgObj.type === 'text' ? msgObj.data.slice(0, 50) + '...' : `${msgObj.data.name} shared a file`;
    }
    if (recipientId && recipientType) {
      console.log(`🛎️ Triggering push to ${recipientType} ${recipientId} for project ${projectId}`);
      await sendPushNotification(recipientId, recipientType, title, body, projectId);
    } else {
      console.log(`⚠️ No recipient for ${fromRole} in project ${projectId}`);
    }

  } catch (err) {
    console.error('❌ Send message error:', err);
    socket.emit('error', { message: err.message });
  }
});

    socket.on("markTLMonitorSeen", async (data) => {
      const { projectId, index, fromTL, type, viewer, timestamp } = data;
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
        if (result.rows.length === 0) return;
        const messages = result.rows[0][field] || [];
        if (index >= messages.length) return;
        let msgObj;
        try {
          msgObj = JSON.parse(messages[index]);
        } catch (parseError) {
          console.error("Error parsing message JSON:", parseError);
          return;
        }
        if (!Array.isArray(msgObj.seen_by)) {
          msgObj.seen_by = [];
        }
        if (!msgObj.seen_by.includes(viewer)) {
          msgObj.seen_by.push(viewer);
          messages[index] = JSON.stringify(msgObj);
          await pgPool.query(
            `UPDATE projectschema."projectTLClientChats" SET "${field}" = $1 WHERE "projectId" = $2`,
            [messages, projectId]
          );
          io.to(`tl_monitor_${projectId}`).emit("tlMonitorMessageSeen", {
            fromTL,
            timestamp: msgObj.timestamp, // Include timestamp
            seen_by: msgObj.seen_by,
            projectId,  // Include projectId for frontend sync
          });
        }
      } catch (e) {
        console.error("Socket Error:", e);
      }
    });

    // ==================== TL-MONITOR MESSAGE EDIT ====================
socket.on("editTLMonitorMessage", async (data) => {
  const { projectId, index, newData, timestamp, fromTL } = data;
  const projectIdNum = Number(projectId);
  if (isNaN(projectIdNum) || !timestamp || !newData) return;

  try {
    const field = fromTL ? "TLChats" : "MonitorChats";

    const result = await pgPool.query(
      `SELECT "${field}" FROM projectschema."projectTLClientChats" WHERE "projectId" = $1`,
      [projectIdNum]
    );
    if (result.rows.length === 0) return;

    const messages = result.rows[0][field] || [];
    let foundIndex = -1;

    // Prefer timestamp
    const targetTime = new Date(timestamp).getTime();
    for (let i = 0; i < messages.length; i++) {
      try {
        const m = JSON.parse(messages[i]);
        if (Math.abs(new Date(m.timestamp).getTime() - targetTime) < 3000) {
          foundIndex = i;
          break;
        }
      } catch {}
    }

    // Fallback to index
    if (foundIndex === -1 && typeof index === "number" && index >= 0 && index < messages.length) {
      foundIndex = index;
    }

    if (foundIndex === -1) {
      console.log("❌ editTLMonitorMessage: message NOT FOUND", { index, timestamp, fromTL });
      return;
    }

    let msgObj = JSON.parse(messages[foundIndex]);

    // 2-minute rule
    if (Date.now() - new Date(msgObj.timestamp).getTime() > 2 * 60 * 1000) {
      console.log("⏱️ editTLMonitorMessage blocked – time exceeded");
      return;
    }

    if (msgObj.type !== "text") return;

    msgObj.data = newData;
    msgObj.edited = true;
    msgObj.editedAt = new Date().toISOString();

    messages[foundIndex] = JSON.stringify(msgObj);

    await pgPool.query(
      `UPDATE projectschema."projectTLClientChats" SET "${field}" = $1 WHERE "projectId" = $2`,
      [messages, projectIdNum]
    );

    io.to(`tl_monitor_${projectId}`).emit("tlMonitorMessageEdited", {
      projectId,
      index: foundIndex,
      newData: msgObj.data,
      editedAt: msgObj.editedAt,
      timestamp: msgObj.timestamp,
      fromTL,
    });
  } catch (e) {
    console.error("editTLMonitorMessage error:", e);
  }
});

// ==================== TL-MONITOR MESSAGE DELETE ====================
socket.on("deleteTLMonitorMessage", async (data) => {
  const { projectId, index, timestamp, fromTL } = data;
  const projectIdNum = Number(projectId);
  if (isNaN(projectIdNum) || !timestamp) return;

  try {
    // Try both chat and audio arrays
    const fieldsToTry = fromTL 
      ? ["TLChats", "TLAudios"] 
      : ["MonitorChats", "MonitorAudios"];

    let found = false;
    let finalField = "";
    let finalMessages = [];
    let foundIndex = -1;
    let msgObj = null;

    for (const field of fieldsToTry) {
      const result = await pgPool.query(
        `SELECT "${field}" FROM projectschema."projectTLClientChats" WHERE "projectId" = $1`,
        [projectIdNum]
      );
      if (result.rows.length === 0) continue;

      const messages = result.rows[0][field] || [];
      const targetTime = new Date(timestamp).getTime();

      for (let i = 0; i < messages.length; i++) {
        try {
          const m = JSON.parse(messages[i]);
          if (Math.abs(new Date(m.timestamp).getTime() - targetTime) < 3000) {
            foundIndex = i;
            msgObj = m;
            finalField = field;
            finalMessages = messages;
            found = true;
            break;
          }
        } catch {}
      }
      if (found) break;

      // Fallback to index
      if (typeof index === "number" && index >= 0 && index < messages.length) {
        foundIndex = index;
        msgObj = JSON.parse(messages[index]);
        finalField = field;
        finalMessages = messages;
        found = true;
        break;
      }
    }

    if (!found || !msgObj) {
      console.log("❌ deleteTLMonitorMessage: message NOT FOUND", { index, timestamp, fromTL });
      return;
    }

    // 2-minute rule
    if (Date.now() - new Date(msgObj.timestamp).getTime() > 2 * 60 * 1000) {
      console.log("⏱️ deleteTLMonitorMessage blocked – time exceeded");
      return;
    }

    msgObj.isDeleted = true;
    msgObj.deletedAt = new Date().toISOString();
    msgObj.data = null;
    msgObj.caption = null;

    finalMessages[foundIndex] = JSON.stringify(msgObj);

    await pgPool.query(
      `UPDATE projectschema."projectTLClientChats" SET "${finalField}" = $1 WHERE "projectId" = $2`,
      [finalMessages, projectIdNum]
    );

    io.to(`tl_monitor_${projectId}`).emit("tlMonitorMessageDeleted", {
      projectId,
      index: foundIndex,
      timestamp: msgObj.timestamp,
      deletedAt: msgObj.deletedAt,
      fromTL,
    });
  } catch (e) {
    console.error("deleteTLMonitorMessage error:", e);
  }
});

// ==================== CORRECT editClientMessage ====================
socket.on("editClientMessage", async (data) => {
  const { projectId, index, newText, timestamp } = data;

  if (!projectId || (index === undefined && !timestamp) || !newText) {
    console.log("❌ editClientMessage: missing data");
    return;
  }

  const projectIdNum = parseInt(projectId);

  try {
    const result = await pgPool.query(
      `SELECT clientchats FROM projectschema.clientproject WHERE project_id = $1`,
      [projectIdNum]
    );

    if (result.rows.length === 0) return;

    let messages = result.rows[0].clientchats || [];
    let foundIndex = -1;

    // === Hybrid lookup (same as working delete) ===
    if (timestamp) {
      const targetTime = new Date(timestamp).getTime();
      for (let i = 0; i < messages.length; i++) {
        try {
          const m = JSON.parse(messages[i]);
          if (Math.abs(new Date(m.timestamp).getTime() - targetTime) < 3000) {
            foundIndex = i;
            break;
          }
        } catch {}
      }
    }

    if (foundIndex === -1 && index !== undefined) {
      foundIndex = index;
    }

    if (foundIndex === -1 || foundIndex >= messages.length) {
      console.log("❌ editClientMessage: message NOT FOUND", { index, timestamp });
      return;
    }

    let msgObj;
    try {
      msgObj = JSON.parse(messages[foundIndex]);
    } catch (e) {
      console.error("JSON parse error in editClientMessage", e);
      return;
    }

    // 2-minute rule check
    if (Date.now() - new Date(msgObj.timestamp).getTime() > 2 * 60 * 1000) {
      console.log("⏱️ editClientMessage blocked – time exceeded");
      return;
    }

    // === Update the message ===
    msgObj.data = newText;
    msgObj.edited = true;
    msgObj.editedAt = new Date().toISOString();

    messages[foundIndex] = JSON.stringify(msgObj);

    await pgPool.query(
      `UPDATE projectschema.clientproject SET clientchats = $1 WHERE project_id = $2`,
      [messages, projectIdNum]
    );

    console.log("✅ editClientMessage success", { foundIndex, timestamp: msgObj.timestamp });

    // === Emit with consistent payload (same style as delete) ===
    io.to(`project_${projectId}`).emit("clientMessageEdited", {
      projectId,
      index: foundIndex,
      newData: msgObj.data,
      editedAt: msgObj.editedAt,
      timestamp: msgObj.timestamp,
    });

  } catch (e) {
    console.error("editClientMessage error:", e);
  }
});

socket.on("deleteClientMessage", async (data) => {
  const { projectId, index, timestamp } = data; // timestamp = original msg timestamp
  const projectIdNum = Number(projectId);
  if (isNaN(projectIdNum)) return;

  try {
    const result = await pgPool.query(
      `SELECT clientchats, clientaudios FROM projectschema.clientproject WHERE project_id = $1`,
      [projectIdNum]
    );
    if (result.rows.length === 0) return;

    let field = "clientchats";
    let messages = result.rows[0].clientchats || [];
    let foundIndex = -1;

    // 1. Prefer original timestamp
    if (timestamp) {
      const targetTime = new Date(timestamp).getTime();
      for (let i = 0; i < messages.length; i++) {
        try {
          const m = JSON.parse(messages[i]);
          if (Math.abs(new Date(m.timestamp).getTime() - targetTime) < 3000) {
            foundIndex = i;
            break;
          }
        } catch {}
      }
    }

    // 2. Fallback to index
    if (foundIndex === -1 && typeof index === "number" && index >= 0 && index < messages.length) {
      foundIndex = index;
    }

    // 3. Try audios
    if (foundIndex === -1) {
      field = "clientaudios";
      messages = result.rows[0].clientaudios || [];
      if (timestamp) {
        const targetTime = new Date(timestamp).getTime();
        for (let i = 0; i < messages.length; i++) {
          try {
            const m = JSON.parse(messages[i]);
            if (Math.abs(new Date(m.timestamp).getTime() - targetTime) < 3000) {
              foundIndex = i;
              break;
            }
          } catch {}
        }
      }
      if (foundIndex === -1 && typeof index === "number" && index >= 0 && index < messages.length) {
        foundIndex = index;
      }
    }

    if (foundIndex === -1) {
      console.log("❌ deleteClientMessage: message NOT FOUND", { index, timestamp });
      return;
    }

    let msgObj = JSON.parse(messages[foundIndex]);

    // 2-minute rule
    if (Date.now() - new Date(msgObj.timestamp).getTime() > 2 * 60 * 1000) {
      console.log("⏱️ deleteClientMessage blocked – time exceeded");
      return;
    }

    msgObj.isDeleted = true;
    msgObj.deletedAt = new Date().toISOString();
    msgObj.data = null;
    msgObj.caption = null;

    messages[foundIndex] = JSON.stringify(msgObj);

    await pgPool.query(
      `UPDATE projectschema.clientproject SET ${field} = $1 WHERE project_id = $2`,
      [messages, projectIdNum]
    );

    io.to(`project_${projectId}`).emit("clientMessageDeleted", {
      projectId,
      index: foundIndex,
      timestamp: msgObj.timestamp,
      deletedAt: msgObj.deletedAt,
    });
  } catch (e) {
    console.error("deleteClientMessage error:", e);
  }
});


    // ─── TL MESSAGE EDIT / DELETE ─────────────────────────────────────────────
// ===================== TL EDIT =====================
// ===================== IMPROVED TL EDIT =====================
socket.on("editTLMessage", async (data) => {
  const { projectId, index, newData, editedAt, timestamp } = data;
  const projectIdNum = Number(projectId);
  if (isNaN(projectIdNum)) return;

  try {
    const result = await pgPool.query(
      `SELECT tlchats FROM projectschema.clientproject WHERE project_id = $1`,
      [projectIdNum]
    );
    if (result.rows.length === 0) return;

    const messages = result.rows[0].tlchats || [];
    let foundIndex = -1;

    // Prefer timestamp (more reliable)
    if (timestamp) {
      const targetTime = new Date(timestamp).getTime();
      for (let i = 0; i < messages.length; i++) {
        try {
          const m = JSON.parse(messages[i]);
          if (Math.abs(new Date(m.timestamp).getTime() - targetTime) < 3000) {
            foundIndex = i;
            break;
          }
        } catch {}
      }
    }

    // Fallback to index
    if (foundIndex === -1 && typeof index === "number" && index >= 0 && index < messages.length) {
      foundIndex = index;
    }

    if (foundIndex === -1) return;

    let msgObj = JSON.parse(messages[foundIndex]);

    // 2-minute rule
    if (Date.now() - new Date(msgObj.timestamp).getTime() > 2 * 60 * 1000) return;

    msgObj.data = newData;
    msgObj.edited = true;
    msgObj.editedAt = editedAt;

    messages[foundIndex] = JSON.stringify(msgObj);

    await pgPool.query(
      `UPDATE projectschema.clientproject SET tlchats = $1 WHERE project_id = $2`,
      [messages, projectIdNum]
    );

    io.to(`project_${projectId}`).emit("tlMessageEdited", {
      projectId,
      index: foundIndex,
      newData: msgObj.data,
      editedAt: msgObj.editedAt,
      timestamp: msgObj.timestamp,
    });
  } catch (e) {
    console.error("editTLMessage error:", e);
  }
});

// ===================== IMPROVED TL DELETE =====================
socket.on("deleteTLMessage", async (data) => {
  const { projectId, index, timestamp } = data;
  const projectIdNum = Number(projectId);
  if (isNaN(projectIdNum)) return;

  try {
    const result = await pgPool.query(
      `SELECT tlchats FROM projectschema.clientproject WHERE project_id = $1`,
      [projectIdNum]
    );
    if (result.rows.length === 0) return;

    const messages = result.rows[0].tlchats || [];
    let foundIndex = -1;

    // Prefer timestamp
    if (timestamp) {
      const targetTime = new Date(timestamp).getTime();
      for (let i = 0; i < messages.length; i++) {
        try {
          const m = JSON.parse(messages[i]);
          if (Math.abs(new Date(m.timestamp).getTime() - targetTime) < 3000) {
            foundIndex = i;
            break;
          }
        } catch {}
      }
    }

    // Fallback to index
    if (foundIndex === -1 && typeof index === "number" && index >= 0 && index < messages.length) {
      foundIndex = index;
    }

    if (foundIndex === -1) return;

    let msgObj = JSON.parse(messages[foundIndex]);

    if (Date.now() - new Date(msgObj.timestamp).getTime() > 2 * 60 * 1000) return;

    msgObj.isDeleted = true;
    msgObj.deletedAt = new Date().toISOString();
    msgObj.data = null;
    msgObj.caption = null;

    messages[foundIndex] = JSON.stringify(msgObj);

    await pgPool.query(
      `UPDATE projectschema.clientproject SET tlchats = $1 WHERE project_id = $2`,
      [messages, projectIdNum]
    );

    io.to(`project_${projectId}`).emit("tlMessageDeleted", {
      projectId,
      index: foundIndex,
      timestamp: msgObj.timestamp,
      deletedAt: msgObj.deletedAt,
    });
  } catch (e) {
    console.error("deleteTLMessage error:", e);
  }
});

// ─── HEAD MESSAGE EDIT ────────────────────────────────────────────────
socket.on("editHeadMessage", async (data) => {
  const { projectId, newData, editedAt, timestamp } = data;
  const projectIdNum = Number(projectId);
  if (isNaN(projectIdNum) || !timestamp) return;

  try {
    const result = await pgPool.query(
      `SELECT headchats FROM projectschema.clientproject WHERE project_id = $1`,
      [projectIdNum]
    );
    if (result.rows.length === 0) return;

    const messages = result.rows[0].headchats || [];
    const targetTime = new Date(timestamp).getTime();
    let foundIndex = -1;

    for (let i = 0; i < messages.length; i++) {
      try {
        const m = JSON.parse(messages[i]);
        if (new Date(m.timestamp).getTime() === targetTime) {
          foundIndex = i;
          break;
        }
      } catch {}
    }

    if (foundIndex === -1) {
      console.log("editHeadMessage: message not found", timestamp);
      return;
    }

    let msgObj = JSON.parse(messages[foundIndex]);

    // 2-minute rule
    if (Date.now() - new Date(msgObj.timestamp).getTime() > 2 * 60 * 1000) {
      console.log("⏱️ editHeadMessage blocked – time exceeded");
      return;
    }

    if (msgObj.type !== "text") return;

    msgObj.data = newData;
    msgObj.edited = true;
    msgObj.editedAt = editedAt;

    messages[foundIndex] = JSON.stringify(msgObj);

    await pgPool.query(
      `UPDATE projectschema.clientproject SET headchats = $1 WHERE project_id = $2`,
      [messages, projectIdNum]
    );

    io.to(`project_${projectId}`).emit("headMessageEdited", {
      projectId,
      index: foundIndex,
      newData: msgObj.data,
      editedAt: msgObj.editedAt,
      timestamp: msgObj.timestamp,
    });
  } catch (e) {
    console.error("editHeadMessage error:", e);
  }
});

// ─── HEAD MESSAGE DELETE ──────────────────────────────────────────────
socket.on("deleteHeadMessage", async (data) => {
  const { projectId, index, timestamp } = data;
  const projectIdNum = Number(projectId);
  if (isNaN(projectIdNum)) return;

  try {
    const result = await pgPool.query(
      `SELECT headchats, headaudios FROM projectschema.clientproject WHERE project_id = $1`,
      [projectIdNum]
    );
    if (result.rows.length === 0) return;

    let field = "headchats";
    let messages = result.rows[0].headchats || [];
    let foundIndex = -1;

    // ---------- 1. Prefer exact index (most reliable after load / confirmation) ----------
    if (typeof index === "number" && index >= 0 && index < messages.length) {
      foundIndex = index;
    }

    // ---------- 2. Fallback: tolerant timestamp search in headchats ----------
    if (foundIndex === -1 && timestamp) {
      const targetTime = new Date(timestamp).getTime();
      for (let i = 0; i < messages.length; i++) {
        try {
          const m = JSON.parse(messages[i]);
          if (Math.abs(new Date(m.timestamp).getTime() - targetTime) < 3000) { // 3 sec tolerance
            foundIndex = i;
            break;
          }
        } catch {}
      }
    }

    // ---------- 3. Try headaudios ----------
    if (foundIndex === -1) {
      field = "headaudios";
      messages = result.rows[0].headaudios || [];

      if (typeof index === "number" && index >= 0 && index < messages.length) {
        foundIndex = index;
      } else if (timestamp) {
        const targetTime = new Date(timestamp).getTime();
        for (let i = 0; i < messages.length; i++) {
          try {
            const m = JSON.parse(messages[i]);
            if (Math.abs(new Date(m.timestamp).getTime() - targetTime) < 3000) {
              foundIndex = i;
              break;
            }
          } catch {}
        }
      }
    }

    if (foundIndex === -1) {
      console.log("❌ deleteHeadMessage: message NOT FOUND", { index, timestamp });
      return;
    }

    let msgObj;
    try {
      msgObj = JSON.parse(messages[foundIndex]);
    } catch (e) {
      console.error("JSON parse error in deleteHeadMessage", e);
      return;
    }

    // 2-minute rule
    if (Date.now() - new Date(msgObj.timestamp).getTime() > 2 * 60 * 1000) {
      console.log("⏱️ deleteHeadMessage blocked – time exceeded");
      return;
    }

    // Soft delete
    msgObj.isDeleted = true;
    msgObj.deletedAt = new Date().toISOString();
    msgObj.data = null;
    msgObj.caption = null;

    messages[foundIndex] = JSON.stringify(msgObj);

    await pgPool.query(
      `UPDATE projectschema.clientproject SET ${field} = $1 WHERE project_id = $2`,
      [messages, projectIdNum]
    );

    console.log("✅ deleteHeadMessage success", { field, foundIndex, timestamp: msgObj.timestamp });

    io.to(`project_${projectId}`).emit("headMessageDeleted", {
      projectId,
      index: foundIndex,
      timestamp: msgObj.timestamp,
      deletedAt: msgObj.deletedAt,
    });
  } catch (e) {
    console.error("deleteHeadMessage error:", e);
  }
});

    socket.on("disconnect", () => {
      console.log("User disconnected:", socket.id);
    });
  });
};