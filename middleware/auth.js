const jwt = require('jsonwebtoken');

const ACCESS_MAX_AGE_MS = 15 * 60 * 1000;
const REFRESH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function authCookieOptions(maxAgeMs) {
  const options = {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    path: '/',
    partitioned: true,
  };
  if (typeof maxAgeMs === 'number') options.maxAge = maxAgeMs;
  return options;
}

function setAuthCookies(res, accessToken, refreshToken) {
  res.cookie('accessToken', accessToken, authCookieOptions(ACCESS_MAX_AGE_MS));
  res.cookie('refreshToken', refreshToken, authCookieOptions(REFRESH_MAX_AGE_MS));
}

function clearAuthCookies(res) {
  const opts = {
    path: '/',
    sameSite: 'none',
    secure: true,
    partitioned: true,
  };
  res.clearCookie('accessToken', opts);
  res.clearCookie('refreshToken', opts);
}

function readRefreshToken(req) {
  const headerToken = req.headers['x-refresh-token'];
  return (
    req.cookies?.refreshToken ||
    req.body?.refreshToken ||
    (typeof headerToken === 'string' ? headerToken : null) ||
    null
  );
}

function tokenExps(accessToken, refreshToken) {
  const decodedAccess = jwt.decode(accessToken);
  const decodedRefresh = jwt.decode(refreshToken);
  return {
    accessExp: decodedAccess?.exp ? decodedAccess.exp * 1000 : null,
    refreshExp: decodedRefresh?.exp ? decodedRefresh.exp * 1000 : null,
  };
}

function loginTokenResponse(accessToken, refreshToken) {
  return {
    ...tokenExps(accessToken, refreshToken),
    accessToken,
    refreshToken,
  };
}

function handleTokenRefresh(req, res) {
  const refreshToken = readRefreshToken(req);
  console.log('Refresh request - Refresh token:', refreshToken ? 'Found' : 'Not found');

  if (!refreshToken) {
    console.log('No refresh token in cookies or body');
    return res.status(401).json({ status: false, message: 'No refresh token' });
  }

  try {
    const refreshSecret = process.env.JWT_REFRESH_TOKEN || 'supersecret';
    const decoded = jwt.verify(refreshToken, refreshSecret);
    const payload = { userId: decoded.userId, role: decoded.role, name: decoded.name };
    const newAccessToken = jwt.sign(payload, process.env.JWT_ACCESS_TOKEN, { expiresIn: '15m' });
    const newRefreshToken = jwt.sign(payload, refreshSecret, { expiresIn: '7d' });

    setAuthCookies(res, newAccessToken, newRefreshToken);

    return res.status(200).json({
      status: true,
      message: 'Token refreshed',
      ...loginTokenResponse(newAccessToken, newRefreshToken),
    });
  } catch (err) {
    console.error('Refresh token verification failed:', err.message);
    clearAuthCookies(res);
    return res.status(403).json({ status: false, message: 'Invalid refresh token' });
  }
}

const handleJwtError = (err, req, res, next) => {
  if (err.name === 'JsonWebTokenError') {
    return res.status(403).json({ status: false, message: 'Invalid token.' });
  } else if (err.name === 'TokenExpiredError') {
    return res.status(403).json({ status: false, message: 'Token expired. Please log in again.' });
  }
  next(err);
};

function verifyToken(req, res, next) {
  // Check header first (Bearer token) so browsers that block third-party cookies still work
  let token = req.headers.authorization?.split(' ')[1];
  console.log('Header token:', token ? 'Found' : 'Not found');

  if (!token) {
    token = req.cookies.accessToken;
    console.log('Cookie token:', token ? 'Found' : 'Not found');
  }

  if (!token) {
    console.log('No token found in header or cookie');
    return res.status(401).json({ message: 'No token' });
  }

  jwt.verify(token, process.env.JWT_ACCESS_TOKEN, (err, decoded) => {
    if (err) {
      console.log('Token verification failed:', err.message);
      return res.status(401).json({ message: 'Token expired or invalid' });
    }
    req.user = decoded;
    console.log('Token verified for user:', decoded.userId);
    next();
  });
}

module.exports = {
  verifyToken,
  handleJwtError,
  setAuthCookies,
  clearAuthCookies,
  readRefreshToken,
  loginTokenResponse,
  handleTokenRefresh,
};
