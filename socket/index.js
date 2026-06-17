//socket.js

const pgPool = require("../routes/PostgreSQLPool");
// const { sendPushNotification } = require('../routes/clientproject');
const clientProject = require('../routes/clientproject');
const { sendPushNotification } = clientProject;
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

socket.on("joinEmployeeRoom", () => {
  socket.join("employees");
  console.log(`✅ Employee ${socket.id} joined global "employees" room for live project updates`);
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
  const { projectId, type, msgData, timestamp, mention, tempId, replyTo } = data;
  try {
    const projectIdNum = Number(projectId);
    if (isNaN(projectIdNum)) return;

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

    let chatJson;
try {
  chatJson = JSON.stringify({
    type,
    data: msgData,
    caption: data.caption || null,
    timestamp,
    seen_by: [],
    mention: mention || null,
    replyTo: replyTo || null
  });
  if (typeof chatJson !== 'string') {
    throw new Error('Invalid JSON');
  }
} catch (strErr) {
  console.error('Socket JSON failed:', strErr);
  return;  // Skip invalid msg
}

    const field = type === "audio" ? "clientaudios" : "clientchats";
    const query = `
      UPDATE projectschema.clientproject
      SET ${field} = array_append(${field}, $1)
      WHERE project_id = $2
      RETURNING ${field}
    `;
    const result = await pgPool.query(query, [chatJson, projectIdNum]);

    if (result.rowCount > 0) {
      const newIndex = result.rows[0][field].length - 1;
     const msg = {
  id: newIndex,
  type,
  data: msgData,
  caption: data.caption || null,
  timestamp,
  seen_by: [],
  mention: mention || null,
  replyTo: replyTo || null,
  tempId,
};
      // Updated: Include projectId in payload
      io.to(`project_${projectId}`).emit("newMessage", {
        projectId,
        fromRole: "client",
        msg,
      });

      // NEW: Trigger push for head (if unread)
      const projectQuery = await pgPool.query('SELECT headid FROM projectschema.clientproject WHERE project_id = $1', [projectIdNum]);
      const headId = projectQuery.rows[0]?.headid;
      if (headId && !msg.seen_by.includes('head')) {  // Only if unread
        console.log(`🔍 Socket msg trigger for head ${headId}: Type="${type}", Unread=true`);
        const title = type === 'text' ? 'New Client Message' : 'New Client File';
        const body = type === 'text' ? (typeof msgData === 'string' ? msgData.slice(0, 50) + '...' : (msgData.name || 'File')) : `File: ${msgData.name}`;
        console.log(`🚀 About to send push: Title="${title}", Body="${body}", Project=${projectId}`);  // NEW LOG
        await sendPushNotification(headId.toString(), 'head', title, body, projectIdNum);
      } else {
        console.log(`⏭️ Skipped push for head ${headId}: Already seen`);
      }
    }
  } catch (e) {
    console.error("Socket Error:", e);
  }
});

socket.on("sendHeadMessage", async (data) => {
  const { projectId, type, msgData, timestamp, mention, tempId, headId, replyTo } = data;  // ADD headId destructuring
  try {
    const projectIdNum = Number(projectId);
    if (isNaN(projectIdNum)) return;

    const projectCheck = await pgPool.query(
      "SELECT project_id FROM projectschema.clientproject WHERE project_id = $1",
      [projectIdNum]
    );
    if (projectCheck.rows.length === 0) return;

    if (mention) {
      // Head mention validation if needed
    }

    // Validate headId (optional: check if exists in head table)
    const headCheck = await pgPool.query(
      'SELECT "headId" FROM "Entities".head WHERE "headId" = $1',
      [headId]
    );
    if (headCheck.rows.length === 0) {
      console.warn(`Invalid headId: ${headId}`);
      return socket.emit('error', { message: 'Invalid headId' });
    }

    const field = type === "audio" ? "headaudios" : "headchats";
    const chatJson = JSON.stringify({
      type,
      data: msgData,
      caption: data.caption || null,
      timestamp: timestamp || new Date().toISOString(),
      seen_by: [],
      mention: mention || null,
      replyTo: replyTo || null
    });

    const query = `
      UPDATE projectschema.clientproject
      SET ${field} = array_append(COALESCE(${field}, ARRAY[]::text[]), $1),
          headid = COALESCE(headid, $3)  -- ADD THIS: Set headid if null
      WHERE project_id = $2
      RETURNING ${field}
    `;
    const result = await pgPool.query(query, [chatJson, projectIdNum, headId]);  // Pass headId as $3

    if (result.rowCount > 0) {
      const newIndex = result.rows[0][field].length - 1;
      const msg = {
  id: newIndex,
  type,
  data: msgData,
  caption: data.caption || null,
  timestamp: timestamp || new Date().toISOString(),
  seen_by: [],
  mention: mention || null,
  replyTo: replyTo || null,
  tempId,
};
      const room = `project_${projectId}`;
      console.log(`📡 Head emit 'newMessage' to room ${room}`);
      io.to(room).emit("newMessage", {
        projectId,
        fromRole: "head",
        msg,
      });

      // Trigger push to client (remains the same)
      const projectQuery = await pgPool.query('SELECT clientid FROM projectschema.clientproject WHERE project_id = $1', [projectIdNum]);
      const clientId = projectQuery.rows[0]?.clientid;
      if (clientId && !msg.seen_by.includes('client')) {
        const title = type === 'text' ? 'New Message from Head' : 'New File from Head';
        const body = type === 'text' ? (typeof msgData === 'string' ? msgData.slice(0, 50) + '...' : (msgData.name || 'File')) : `File: ${msgData.name || 'Unknown'}`;
        console.log(`🚀 Head push to client ${clientId}: ${title}`);
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

    const projectCheck = await pgPool.query(
      "SELECT project_id FROM projectschema.clientproject WHERE project_id = $1",
      [projectIdNum]
    );
    if (projectCheck.rows.length === 0) return;

    const teamLeaderCheck = await pgPool.query(
      'SELECT "employeeId" FROM "Entities".employees WHERE "employeeId" = $1 AND role = $2',
      [teamleaderid, 'Team Leader']
    );
    if (teamLeaderCheck.rows.length === 0) return;

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

    const chatJson = JSON.stringify({
      type,
      data: msgData,
      caption: data.caption || null,
      timestamp,
      seen_by: [],
      mention: mention || null,
      replyTo: replyTo || null
    });

    const field = type === "audio" ? "tlaudios" : "tlchats";
    const query = `
      UPDATE projectschema.clientproject
      SET ${field} = array_append(${field}, $1),
          teamleaderid = $3
      WHERE project_id = $2
      RETURNING ${field}
    `;
    const result = await pgPool.query(query, [chatJson, projectIdNum, teamleaderid]);

    if (result.rowCount > 0) {
      const newIndex = result.rows[0][field].length - 1;
      const msg = {
        id: newIndex,
        type,
        data: msgData,
        caption: data.caption || null,
        timestamp,
        seen_by: [],
        mention: mention || null,
        replyTo: replyTo || null,
        tempId,
      };
      io.to(`project_${projectId}`).emit("newMessage", {
        projectId,
        fromRole: "tl",
        msg,
      });

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
  const { projectId, type, msgData, timestamp, senderId, tempId, replyTo } = data;
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
    const senderName = senderResult.rows[0]?.senderName || "Team Leader";
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
  const { projectId, type, msgData, timestamp, senderId, tempId, replyTo } = data;

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
    const senderName = senderResult.rows[0]?.senderName || "Employee";
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

    // Emit to correct room (fix to underscore)
    const room = `project_${projectId}`;
    console.log(`📡 Emitting 'newMessage' to room ${room} (excluding sender)`);
    socket.to(room).emit('newMessage', { projectId, fromRole, msg: msgObj });

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

socket.on("editClientMessage", async (data) => {
  const { projectId, index, newText, timestamp } = data;
  const projectIdNum = Number(projectId);
  if (isNaN(projectIdNum) || index === undefined || index === null) return;

  try {
    const result = await pgPool.query(
      `SELECT clientchats FROM projectschema.clientproject WHERE project_id = $1`,
      [projectIdNum]
    );
    if (result.rows.length === 0) return;

    const messages = result.rows[0].clientchats || [];
    if (index >= messages.length) return;

    let msgObj;
    try {
      msgObj = JSON.parse(messages[index]);
    } catch (e) {
      console.error("Edit: JSON parse error at index", index, e);
      return;
    }

    // ✅ FIX: was msgObj.message — DB stores text in `data` field
    msgObj.data = newText;
    msgObj.edited = true;
    msgObj.editedAt = timestamp;

    messages[index] = JSON.stringify(msgObj);

    await pgPool.query(
      `UPDATE projectschema.clientproject SET clientchats = $1 WHERE project_id = $2`,
      [messages, projectIdNum]
    );

    io.to(`project_${projectId}`).emit("clientMessageEdited", {
      projectId,
      index,
      updatedMsg: {
        timestamp: msgObj.timestamp,
        data: msgObj.data,
        edited: true,
        editedAt: msgObj.editedAt,
        seen_by: msgObj.seen_by,
        type: msgObj.type,
        replyTo: msgObj.replyTo || null,
        mention: msgObj.mention || null,
      },
    });
  } catch (e) {
    console.error("editClientMessage error:", e);
  }
});

socket.on("deleteClientMessage", async (data) => {
  const { projectId, index, timestamp } = data;
  const projectIdNum = Number(projectId);
  if (isNaN(projectIdNum) || index === undefined || index === null) return;

  try {
    const result = await pgPool.query(
      `SELECT clientchats, clientaudios FROM projectschema.clientproject WHERE project_id = $1`,
      [projectIdNum]
    );
    if (result.rows.length === 0) return;

    let field = "clientchats";
    let messages = result.rows[0].clientchats || [];

    if (index >= messages.length) {
      field = "clientaudios";
      messages = result.rows[0].clientaudios || [];
    }

    if (index >= messages.length) {
      console.error("deleteClientMessage: index out of bounds", index);
      return;
    }

    let msgObj;
    try {
      msgObj = JSON.parse(messages[index]);
    } catch (e) {
      console.error("Delete: JSON parse error at index", index, e);
      return;
    }

    // ✅ FIX: was msgObj.message/msgObj.file — DB field is `data`
    msgObj.isDeleted = true;
    msgObj.deletedAt = timestamp;
    msgObj.data = null;

    messages[index] = JSON.stringify(msgObj);

    await pgPool.query(
      `UPDATE projectschema.clientproject SET ${field} = $1 WHERE project_id = $2`,
      [messages, projectIdNum]
    );

    io.to(`project_${projectId}`).emit("clientMessageDeleted", {
      projectId,
      index,
      updatedMsg: {
        timestamp: msgObj.timestamp,
        isDeleted: true,
        deletedAt: msgObj.deletedAt,
        type: msgObj.type,
        seen_by: msgObj.seen_by,
      },
    });
  } catch (e) {
    console.error("deleteClientMessage error:", e);
  }
});


    // ─── TL MESSAGE EDIT / DELETE ─────────────────────────────────────────────
    socket.on("editTLMessage", async (data) => {
      const { projectId, index, newData, editedAt } = data;
      const projectIdNum = Number(projectId);
      if (isNaN(projectIdNum) || index === undefined || index === null) return;
      try {
        const result = await pgPool.query(
          `SELECT tlchats FROM projectschema.clientproject WHERE project_id = $1`,
          [projectIdNum]
        );
        if (result.rows.length === 0) return;
        const messages = result.rows[0].tlchats || [];
        if (index >= messages.length) return;
        let msgObj;
        try { msgObj = JSON.parse(messages[index]); } catch (e) { console.error("editTLMessage: JSON parse error at index", index, e); return; }
        msgObj.data = newData;
        msgObj.edited = true;
        msgObj.editedAt = editedAt;
        messages[index] = JSON.stringify(msgObj);
        await pgPool.query(
          `UPDATE projectschema.clientproject SET tlchats = $1 WHERE project_id = $2`,
          [messages, projectIdNum]
        );
        io.to(`project_${projectId}`).emit("tlMessageEdited", {
          projectId, index,
          newData: msgObj.data,
          editedAt: msgObj.editedAt,
        });
      } catch (e) { console.error("editTLMessage error:", e); }
    });

    socket.on("deleteTLMessage", async (data) => {
      const { projectId, index, timestamp } = data;
      const projectIdNum = Number(projectId);
      if (isNaN(projectIdNum) || index === undefined || index === null) return;
      try {
        const result = await pgPool.query(
          `SELECT tlchats, tlaudios FROM projectschema.clientproject WHERE project_id = $1`,
          [projectIdNum]
        );
        if (result.rows.length === 0) return;
        let field = "tlchats";
        let messages = result.rows[0].tlchats || [];
        if (index >= messages.length) { field = "tlaudios"; messages = result.rows[0].tlaudios || []; }
        if (index >= messages.length) { console.error("deleteTLMessage: index out of bounds", index); return; }
        let msgObj;
        try { msgObj = JSON.parse(messages[index]); } catch (e) { console.error("deleteTLMessage: JSON parse error", e); return; }
        msgObj.isDeleted = true;
        msgObj.deletedAt = timestamp;
        msgObj.data = null;
        messages[index] = JSON.stringify(msgObj);
        await pgPool.query(
          `UPDATE projectschema.clientproject SET ${field} = $1 WHERE project_id = $2`,
          [messages, projectIdNum]
        );
        io.to(`project_${projectId}`).emit("tlMessageDeleted", {
          projectId, index,
          deletedAt: msgObj.deletedAt,
        });
      } catch (e) { console.error("deleteTLMessage error:", e); }
    });

    // ─── HEAD MESSAGE EDIT / DELETE ───────────────────────────────────────────
    socket.on("editHeadMessage", async (data) => {
      const { projectId, index, newData, editedAt } = data;
      const projectIdNum = Number(projectId);
      if (isNaN(projectIdNum) || index === undefined || index === null) return;
      try {
        const result = await pgPool.query(
          `SELECT headchats FROM projectschema.clientproject WHERE project_id = $1`,
          [projectIdNum]
        );
        if (result.rows.length === 0) return;
        const messages = result.rows[0].headchats || [];
        if (index >= messages.length) return;
        let msgObj;
        try { msgObj = JSON.parse(messages[index]); } catch (e) { console.error("editHeadMessage: JSON parse error at index", index, e); return; }
        msgObj.data = newData;
        msgObj.edited = true;
        msgObj.editedAt = editedAt;
        messages[index] = JSON.stringify(msgObj);
        await pgPool.query(
          `UPDATE projectschema.clientproject SET headchats = $1 WHERE project_id = $2`,
          [messages, projectIdNum]
        );
        io.to(`project_${projectId}`).emit("headMessageEdited", {
          projectId, index,
          newData: msgObj.data,
          editedAt: msgObj.editedAt,
        });
      } catch (e) { console.error("editHeadMessage error:", e); }
    });

    socket.on("deleteHeadMessage", async (data) => {
      const { projectId, index, timestamp } = data;
      const projectIdNum = Number(projectId);
      if (isNaN(projectIdNum) || index === undefined || index === null) return;
      try {
        const result = await pgPool.query(
          `SELECT headchats, headaudios FROM projectschema.clientproject WHERE project_id = $1`,
          [projectIdNum]
        );
        if (result.rows.length === 0) return;
        let field = "headchats";
        let messages = result.rows[0].headchats || [];
        if (index >= messages.length) { field = "headaudios"; messages = result.rows[0].headaudios || []; }
        if (index >= messages.length) { console.error("deleteHeadMessage: index out of bounds", index); return; }
        let msgObj;
        try { msgObj = JSON.parse(messages[index]); } catch (e) { console.error("deleteHeadMessage: JSON parse error", e); return; }
        msgObj.isDeleted = true;
        msgObj.deletedAt = timestamp;
        msgObj.data = null;
        messages[index] = JSON.stringify(msgObj);
        await pgPool.query(
          `UPDATE projectschema.clientproject SET ${field} = $1 WHERE project_id = $2`,
          [messages, projectIdNum]
        );
        io.to(`project_${projectId}`).emit("headMessageDeleted", {
          projectId, index,
          deletedAt: msgObj.deletedAt,
        });
      } catch (e) { console.error("deleteHeadMessage error:", e); }
    });

    socket.on("disconnect", () => {
      console.log("User disconnected:", socket.id);
    });
  });
};