const jwt = require('jsonwebtoken');

const handleJwtError = (err, req, res, next) => {
  if (err.name === 'JsonWebTokenError') {
    return res.status(403).json({ status: false, message: 'Invalid token.' });
  } else if (err.name === 'TokenExpiredError') {
    return res.status(403).json({ status: false, message: 'Token expired. Please log in again.' });
  }
  next(err);
};

function verifyToken(req, res, next) {
  // Check header first (Bearer token)
  let token = req.headers.authorization?.split(' ')[1];  // Bearer <token>
  console.log('Header token:', token ? 'Found' : 'Not found');  // DEBUG

  // Fallback to cookie if no header
  if (!token) {
    token = req.cookies.accessToken;
    console.log('Cookie token:', token ? 'Found' : 'Not found');  // DEBUG
  }

  if (!token) {
    console.log('No token found in header or cookie');  // DEBUG
    return res.status(401).json({ message: 'No token' });
  }

  jwt.verify(token, process.env.JWT_ACCESS_TOKEN, (err, decoded) => {
    if (err) {
      console.log('Token verification failed:', err.message);  // DEBUG
      return res.status(401).json({ message: 'Token expired or invalid' });
    }
    req.user = decoded;
    console.log('Token verified for user:', decoded.userId);  // DEBUG
    next();
  });
}

module.exports = { verifyToken, handleJwtError };
