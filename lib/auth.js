const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const SALT_ROUNDS = 12;

function hashPassword(plain) {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash || '');
}

// Constant-time compare so a wrong invite-code guess can't be timed to learn
// how many leading characters matched. Length differences are handled by
// padding to a fixed size before comparing.
function checkInviteCode(submitted) {
  const expected = process.env.INVITE_CODE || '';
  if (!expected) return false;
  const a = Buffer.from(String(submitted || ''));
  const b = Buffer.from(expected);
  const len = Math.max(a.length, b.length, 1);
  const aPadded = Buffer.concat([a, Buffer.alloc(len - a.length)]);
  const bPadded = Buffer.concat([b, Buffer.alloc(len - b.length)]);
  return a.length === b.length && crypto.timingSafeEqual(aPadded, bPadded);
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ ok: false, error: 'Not logged in' });
  }
  next();
}

module.exports = { hashPassword, verifyPassword, checkInviteCode, requireAuth };
