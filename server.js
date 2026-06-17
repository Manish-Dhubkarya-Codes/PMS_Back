const express = require('express');
const http = require('http');
const cors = require("cors");
const { Server } = require('socket.io');
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
   cors: {
    origin: "http://187.77.184.39:5173",
    methods: ["GET", "POST"],
    credentials: true
  }
});
// just for production (e.g., your frontend URL)
//     methods: ['GET', 'POST'],
//   },
// });

// Middleware (e.g., body-parser, if not already set)
app.use(express.json());

// Mount your router (assuming it's exported as module.exports = router;)
const projectRouter = require('./your-router-file'); // Replace with your router path
app.use('/clientproject', projectRouter); // Adjust base path as needed

// Socket.io connection handler
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Join project room (client sends projectId on connect)
  socket.on('joinProject', (projectId) => {
    const room = `project_${projectId}`;
    socket.join(room);
    console.log(`User ${socket.id} joined room: ${room}`);
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
