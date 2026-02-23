const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, hash] = stored.split(':');
    const attempt = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(attempt), Buffer.from(hash));
  } catch { return false; }
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function generateTempPassword() {
  return crypto.randomBytes(4).toString('hex');
}

async function verifyGoogleToken(credential, clientId) {
  const client = new OAuth2Client(clientId);
  const ticket = await client.verifyIdToken({
    idToken:  credential,
    audience: clientId,
  });
  const payload = ticket.getPayload();
  return {
    googleId: payload.sub,
    email:    payload.email,
    name:     payload.name,
    picture:  payload.picture,
  };
}

module.exports = { hashPassword, verifyPassword, generateToken, generateTempPassword, verifyGoogleToken };
