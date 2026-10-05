// utils/jwt.js
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/auth');

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

module.exports = { signToken };