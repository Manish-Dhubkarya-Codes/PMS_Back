var createError = require('http-errors');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
var http = require('http');
var { Server } = require('socket.io');
const cors = require('cors');

var indexRouter = require('./routes/index');
var usersRouter = require('./routes/users');
var conferencesRouter = require('./routes/conferences');
var publicationsRouter = require('./routes/publications');
var adminRouter = require('./routes/admin');
var clientInquiryRouter = require('./routes/clientInquiry');
var employeesRouter = require('./routes/employees');
var clientsRouter = require('./routes/clients');
var headRouter = require('./routes/head');
var clientProjectRouter = require('./routes/clientproject');
var teamLeaderRouter = require('./routes/teamleader');
var clientRequestsRouter = require('./routes/clientrequests');
var cognicodeAdminRouter = require('./routes/cogniadmin');

const { handleJwtError } = require('./middleware/auth');
const socket = require('./socket/index');

const webpush = require('web-push');

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const MAIL_USER = process.env.SENDER_EMAIL;

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error('❌ Missing VAPID keys in .env');
  process.exit(1);
}

console.log(
  '✅ VAPID Public Key loaded:',
  VAPID_PUBLIC_KEY.substring(0, 20) + '...'
);

var app = express();
var server = http.createServer(app);


// ======================================================
// SIMPLE & STABLE CORS FIX
// ======================================================

app.use((req, res, next) => {

const allowedOrigins = [
  'https://cognicodeedutech.com',
  'https://www.cognicodeedutech.com',
  'https://api.cognicodeedutech.com',
  "https://ccitpms.com",

  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:4000',

  'http://187.77.184.39:5173',
  'http://187.77.184.39:5174',

  'https://cogni-code-project-management.vercel.app',
  'https://cogni-code-website.vercel.app'
];
  const origin = req.headers.origin;

  if (allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }

  res.header(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, Authorization'
  );

  res.header(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, DELETE, OPTIONS'
  );

  res.header('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }

  next();
});


// ======================================================
// SOCKET.IO
// ======================================================

var io = new Server(server, { cors: { origin: [ 'https://cognicodeedutech.com', 'https://www.cognicodeedutech.com', 'https://api.cognicodeedutech.com', 'http://localhost:5173', 'http://localhost:5174', 'http://localhost:4000', "https://ccitpms.com" ], methods: ['GET', 'POST'], credentials: true } });

// ======================================================
// WEB PUSH
// ======================================================

webpush.setVapidDetails(
  `mailto:${MAIL_USER}`,
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);


// ======================================================
// APP CONFIG
// ======================================================

clientProjectRouter.attachIo(io);

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

app.use(logger('dev'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cookieParser());

app.use(express.static(path.join(__dirname, 'public')));


// ======================================================
// HEALTH ROUTE
// ======================================================

app.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'CogniCode API Running'
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'API is healthy'
  });
});


// ======================================================
// VAPID PUBLIC KEY
// ======================================================

app.get('/vapid-public-key', (req, res) => {

  if (!process.env.VAPID_PUBLIC_KEY) {
    return res.status(500).json({
      status: false,
      message: 'VAPID key missing'
    });
  }

  res.status(200).json({
    status: true,
    data: {
      publicKey: process.env.VAPID_PUBLIC_KEY
    }
  });
});


// ======================================================
// ROUTES
// ======================================================

app.use('/', indexRouter);
app.use('/users', usersRouter);
app.use('/conferences', conferencesRouter);
app.use('/publications', publicationsRouter);
app.use('/admin', adminRouter);
app.use('/clientInquiry', clientInquiryRouter);
app.use('/employees', employeesRouter);
app.use('/clients', clientsRouter);
app.use('/head', headRouter);
app.use('/clientproject', clientProjectRouter);
app.use('/teamleader', teamLeaderRouter);
app.use('/clientrequests', clientRequestsRouter);
app.use('/cogniadmin', cognicodeAdminRouter);



// ======================================================
// JWT ERROR HANDLER
// ======================================================

app.use(handleJwtError);


// ======================================================
// 404 HANDLER
// ======================================================

app.use((req, res, next) => {
  next(createError(404));
});


// ======================================================
// GLOBAL ERROR HANDLER
// ======================================================

app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  if (err.status === 404) {
    console.warn('⚠️ Not Found:', req.originalUrl);
    return res.status(404).json({
      success: false,
      message: err.message || 'Not Found'
    });
  }

  console.error('❌ Global Error:', err);

  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal Server Error'
  });
});


// ======================================================
// SOCKET INIT
// ======================================================

socket(io);


// ======================================================
// SERVER START
// ======================================================

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {

  console.log(`🚀 Server running on port ${PORT}`);

  console.log(
    `🔌 Socket.io ready on ws://0.0.0.0:${PORT}`
  );
});

module.exports = app;