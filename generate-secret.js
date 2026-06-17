const crypto = require('crypto');

// Generate a 64-byte (512-bit) random hex string – strong enough for JWT signing
const secret = crypto.randomBytes(64).toString('hex');

console.log('Your JWT_SECRET:', secret);
console.log('\nCopy this into your .env file as: JWT_SECRET=' + secret);