'use strict';
require('dotenv').config();
const express = require('express');
const path    = require('path');
const db      = require('./database');
const pool    = db.pool;
const { hashPassword, verifyPassword, generateToken, generateTempPassword, verifyGoogleToken } = require('./auth');
const { sendInviteEmail } = require('./email');
const multer = require('multer');
const sharp  = require('sharp');
const { randomBytes } = require('crypto');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_, file, cb) =>
    file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Images only')),
});

const app             = express();
const PORT            = process.env.PORT || 3000;
const APP_URL         = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Genre extraction ──────────────────────────────────────────────────────────
const GENRE_EXCLUDE = /^(accessible|protected|in library|large type|daisy|nook|overdrive|ebook|kindle|ipad|epub|audio|illustrated|print)/i;
function extractGenre(subjects) {
  if (!subjects?.length) return null;
  return subjects.find(s => typeof s === 'string' && s.length < 35 && !GENRE_EXCLUDE.test(s)) || null;
}

// ── Auth middleware ───────────────────────────────────────────────────────────
async function getRequestUser(req) {
  const header = req.headers.authorization;
  if (!header) return null;
  const token = header.replace('Bearer ', '').trim();
  const session = await db.getSession(token);
  if (!session) return null;
  return db.getUser(session.user_id);
}

async function requireAuth(req, res, next) {
  const u = await getRequestUser(req);
  if (!u) return res.status(401).json({ error: 'Please log in' });
  req.user = u; next();
}

async function requireSuperAdmin(req, res, next) {
  const u = await getRequestUser(req);
  if (!u || u.role !== 'superadmin') return res.status(403).json({ error: 'Superadmin access required' });
  req.user = u; next();
}

async function requireClubAccess(req, res, next) {
  const u = await getRequestUser(req);
  if (!u) return res.status(401).json({ error: 'Please log in' });
  req.user = u;
  if (u.role === 'superadmin') return next();
  const inClub = await db.isUserInBookclub(u.id, parseInt(req.params.clubId));
  if (!inClub) return res.status(403).json({ error: 'Not a member of this book club' });
  next();
}

async function requireClubAdmin(req, res, next) {
  const u = await getRequestUser(req);
  if (!u) return res.status(401).json({ error: 'Please log in' });
  req.user = u;
  if (u.role === 'superadmin') return next();
  const clubRole = await db.getClubRole(u.id, parseInt(req.params.clubId));
  if (clubRole !== 'admin') return res.status(403).json({ error: 'Club admin access required' });
  next();
}

// ── Config ────────────────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID });
});

// ── Public ────────────────────────────────────────────────────────────────────
app.get('/api/public/clubs', async (req, res) => {
  try {
    res.json(await db.getPublicClubsWithBooks());
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/public/users', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT u.id, u.name FROM users u
       JOIN bookclub_members bm ON u.id = bm.user_id
       WHERE u.role != 'superadmin'
       ORDER BY u.name`
    );
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { identifier, password } = req.body;
  if (!identifier || !password) return res.status(400).json({ error: 'Email/username and password required' });
  try {
    const user = await db.getUserByEmailOrUsername(identifier);
    if (!user || !user.password_hash || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = generateToken();
    await db.createSession(user.id, token);
    await db.updateUser(user.id, { last_login: new Date().toISOString() });
    const clubs = await db.getUserBookclubs(user.id);
    const { password_hash, ...safe } = user;
    res.json({ token, user: { ...safe, bookclubs: clubs } });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/auth/google', async (req, res) => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'Credential required' });
  if (!GOOGLE_CLIENT_ID) return res.status(500).json({ error: 'Google login not configured' });
  try {
    const { googleId, email, name } = await verifyGoogleToken(credential, GOOGLE_CLIENT_ID);

    let user = await db.getUserByGoogleId(googleId);
    if (!user) {
      user = await db.getUserByEmail(email);
      if (user) {
        user = await db.setGoogleId(user.id, googleId);
      } else {
        user = await db.createGoogleUser(name, email, googleId);
      }
    }
    const token = generateToken();
    await db.createSession(user.id, token);
    await db.updateUser(user.id, { last_login: new Date().toISOString() });
    const clubs = await db.getUserBookclubs(user.id);
    const { password_hash, ...safe } = user;
    res.json({ token, user: { ...safe, bookclubs: clubs } });
  } catch (e) {
    console.error('Google auth error:', e);
    res.status(401).json({ error: 'Google authentication failed' });
  }
});

app.post('/api/auth/quick', async (req, res) => {
  const { user_id, club_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  try {
    if (club_id) {
      const inClub = await db.isUserInBookclub(parseInt(user_id), parseInt(club_id));
      if (!inClub) return res.status(403).json({ error: 'Not a member of this club' });
    }
    const user = await db.getUser(parseInt(user_id));
    if (!user) return res.status(404).json({ error: 'User not found' });
    const token = generateToken();
    await db.createSession(user.id, token);
    await db.updateUser(user.id, { last_login: new Date().toISOString() });
    const clubs = await db.getUserBookclubs(user.id);
    const { password_hash, ...safe } = user;
    res.json({ token, user: { ...safe, bookclubs: clubs } });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/auth/logout', requireAuth, async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '').trim();
  if (token) await db.deleteSession(token);
  res.json({ ok: true });
});

app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!new_password || new_password.length < 6)
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  try {
    const user = await db.getUser(req.user.id);
    if (user.password_hash && (!current_password || !verifyPassword(current_password, user.password_hash)))
      return res.status(401).json({ error: 'Current password is incorrect' });
    await db.updateUser(user.id, { password_hash: hashPassword(new_password) });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.patch('/api/auth/me/email', requireAuth, async (req, res) => {
  const { email } = req.body;
  const trimmed = email?.trim() || null;
  try {
    if (trimmed) {
      const existing = await db.getUserByEmail(trimmed);
      if (existing && existing.id !== req.user.id)
        return res.status(409).json({ error: 'That email is already in use' });
    }
    const u = await db.updateUser(req.user.id, { email: trimmed });
    const { password_hash, ...safe } = u;
    res.json(safe);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const clubs = await db.getUserBookclubs(req.user.id);
    const { password_hash, ...safe } = req.user;
    res.json({ ...safe, bookclubs: clubs });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ── Book Clubs ────────────────────────────────────────────────────────────────
app.get('/api/bookclubs', requireAuth, async (req, res) => {
  try {
    res.json(
      req.user.role === 'superadmin'
        ? await db.getAllBookclubs()
        : await db.getUserBookclubs(req.user.id)
    );
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/bookclubs', requireSuperAdmin, async (req, res) => {
  const { name, description } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  try {
    res.status(201).json(await db.createBookclub(name, description));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.patch('/api/bookclubs/:clubId', requireSuperAdmin, async (req, res) => {
  const { name, description } = req.body;
  try {
    const club = await db.updateBookclub(parseInt(req.params.clubId), {
      ...(name        !== undefined && { name }),
      ...(description !== undefined && { description }),
    });
    if (!club) return res.status(404).json({ error: 'Not found' });
    res.json(club);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/bookclubs/:clubId', requireSuperAdmin, async (req, res) => {
  const clubId = parseInt(req.params.clubId);
  try {
    const members = await db.getBookclubMembers(clubId);
    if (members.length > 0)
      return res.status(400).json({ error: `Cannot delete: club has ${members.length} member${members.length !== 1 ? 's' : ''}. Remove all members first.` });
    const books = await db.getBooks(clubId);
    if (books.length > 0)
      return res.status(400).json({ error: `Cannot delete: club has ${books.length} book${books.length !== 1 ? 's' : ''}. Remove all books first.` });
    await db.deleteBookclub(clubId);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ── Members ───────────────────────────────────────────────────────────────────
app.get('/api/bookclubs/:clubId/members/quick', async (req, res) => {
  try {
    const members = await db.getBookclubMembers(parseInt(req.params.clubId));
    res.json(members.map(m => ({ id: m.id, name: m.name })));
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/bookclubs/:clubId/members', requireClubAccess, async (req, res) => {
  try {
    res.json(await db.getBookclubMembers(parseInt(req.params.clubId)));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/bookclubs/:clubId/members', requireClubAdmin, async (req, res) => {
  const { user_id, role = 'member' } = req.body;
  const clubRole = role === 'admin' ? 'admin' : 'member';
  try {
    const user = await db.getUser(parseInt(user_id));
    if (!user) return res.status(404).json({ error: 'User not found' });
    await db.addUserToBookclub(user.id, parseInt(req.params.clubId), clubRole);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/bookclubs/:clubId/members/:uid', requireClubAdmin, async (req, res) => {
  try {
    await db.removeUserFromBookclub(parseInt(req.params.uid), parseInt(req.params.clubId));
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.patch('/api/bookclubs/:clubId/members/:uid/role', requireClubAdmin, async (req, res) => {
  const { role } = req.body;
  if (!['admin', 'member'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  try {
    const count = await db.setClubRole(parseInt(req.params.uid), parseInt(req.params.clubId), role);
    if (!count) return res.status(404).json({ error: 'User is not a member of this club' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.patch('/api/bookclubs/:clubId/members/:uid', requireClubAdmin, async (req, res) => {
  const uid = parseInt(req.params.uid);
  const clubId = parseInt(req.params.clubId);
  const { name, email } = req.body;
  try {
    const target = await db.getUser(uid);
    if (!target) return res.status(404).json({ error: 'User not found' });
    // Club admins cannot edit superadmins
    if (target.role === 'superadmin' && req.user.role !== 'superadmin')
      return res.status(403).json({ error: 'Cannot edit a superadmin' });
    // Confirm target is a member of this club
    const clubRole = await db.getClubRole(uid, clubId);
    if (!clubRole) return res.status(404).json({ error: 'User is not a member of this club' });
    const updates = {};
    if (name?.trim())          updates.name  = name.trim();
    if (email !== undefined)   updates.email = email?.trim() || null;
    const u = await db.updateUser(uid, updates);
    if (!u) return res.status(404).json({ error: 'Not found' });
    const { password_hash, ...safe } = u;
    res.json(safe);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/bookclubs/:clubId/members/:uid/reset-password', requireClubAdmin, async (req, res) => {
  const uid    = parseInt(req.params.uid);
  const clubId = parseInt(req.params.clubId);
  try {
    const target = await db.getUser(uid);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'superadmin' && req.user.role !== 'superadmin')
      return res.status(403).json({ error: 'Cannot reset a superadmin password' });
    const clubRole = await db.getClubRole(uid, clubId);
    if (!clubRole) return res.status(404).json({ error: 'User is not a member of this club' });
    const tempPwd = generateTempPassword();
    await db.updateUser(uid, { password_hash: hashPassword(tempPwd) });
    if (target.email) {
      const clubs = await db.getUserBookclubs(uid);
      try {
        await sendInviteEmail({ to: target.email, name: target.name, bookclubName: clubs[0]?.name || 'Book Club', loginUrl: APP_URL, tempPassword: tempPwd });
      } catch (err) { console.error('Email error:', err.message); }
    }
    res.json({ temp_password: tempPwd });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ── Users ─────────────────────────────────────────────────────────────────────
app.get('/api/users', requireSuperAdmin, async (req, res) => {
  try {
    const [users, allClubsList, { rows: memRows }] = await Promise.all([
      db.getAllUsers(),
      db.getAllBookclubs(),
      pool.query('SELECT user_id, bookclub_id, club_role FROM bookclub_members'),
    ]);
    const memMap = {};
    for (const m of memRows) {
      if (!memMap[m.user_id]) memMap[m.user_id] = [];
      const club = allClubsList.find(c => c.id === m.bookclub_id);
      if (club) memMap[m.user_id].push({ id: club.id, name: club.name, club_role: m.club_role });
    }
    res.json(users.map(({ password_hash, ...u }) => ({ ...u, clubs: memMap[u.id] || [] })));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/users', requireAuth, async (req, res) => {
  const { name, bookclub_ids = [] } = req.body;
  const email    = req.body.email?.trim()    || null;
  const username = req.body.username?.trim() || null;
  const clubRole = req.body.club_role === 'admin' ? 'admin' : 'member';

  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });

  if (username && !/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3–30 characters: letters, numbers, underscores only' });
  }

  // Only superadmin can assign global superadmin role
  const userRole = (req.user.role === 'superadmin' && req.body.role === 'superadmin') ? 'superadmin' : 'member';

  // Club admins: email OR username required; must be admin of at least one club
  if (req.user.role !== 'superadmin') {
    if (!email && !username) return res.status(400).json({ error: 'Email or username required' });
    let isAdminOfAny = false;
    for (const cid of bookclub_ids) {
      const role = await db.getClubRole(req.user.id, parseInt(cid));
      if (role === 'admin') { isAdminOfAny = true; break; }
    }
    if (!isAdminOfAny) return res.status(403).json({ error: 'Club admin access required' });
  }

  try {
    if (email && await db.getUserByEmail(email)) {
      return res.status(409).json({ error: 'Email already registered' });
    }
    if (username) {
      const existing = await db.getUserByEmailOrUsername(username);
      if (existing) return res.status(409).json({ error: 'Username already taken' });
    }

    const tempPwd = generateTempPassword();
    let user = await db.createUser(name, email, hashPassword(tempPwd), username);

    if (userRole === 'superadmin') {
      user = await db.updateUser(user.id, { role: 'superadmin' });
    }

    for (const cid of bookclub_ids) {
      const club = await db.getBookclub(parseInt(cid));
      if (!club) continue;
      await db.addUserToBookclub(user.id, club.id, clubRole);
      if (email) {
        try {
          await sendInviteEmail({ to: email, name: user.name, bookclubName: club.name, loginUrl: APP_URL, tempPassword: tempPwd });
        } catch (err) { console.error('Email error:', err.message); }
      }
    }

    const { password_hash, ...safe } = user;
    res.status(201).json({ ...safe, temp_password: tempPwd });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.patch('/api/users/:id', requireSuperAdmin, async (req, res) => {
  const { name, email } = req.body;
  try {
    const u = await db.updateUser(parseInt(req.params.id), {
      ...(name  && { name }),
      ...(email && { email }),
    });
    if (!u) return res.status(404).json({ error: 'Not found' });
    const { password_hash, ...safe } = u;
    res.json(safe);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.patch('/api/users/:id/role', requireSuperAdmin, async (req, res) => {
  const { role } = req.body;
  if (!['superadmin', 'member'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  try {
    const u = await db.updateUser(parseInt(req.params.id), { role });
    if (!u) return res.status(404).json({ error: 'Not found' });
    const { password_hash, ...safe } = u;
    res.json(safe);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/users/:id/clubs', requireSuperAdmin, async (req, res) => {
  const uid = parseInt(req.params.id);
  const { club_ids } = req.body;
  if (!Array.isArray(club_ids)) return res.status(400).json({ error: 'club_ids must be an array' });
  try {
    const currentMemberships = await db.getUserBookclubs(uid);
    const currentIds = currentMemberships.map(c => c.id);
    const desiredIds = club_ids.map(Number);
    for (const id of currentIds) {
      if (!desiredIds.includes(id)) await db.removeUserFromBookclub(uid, id);
    }
    for (const id of desiredIds) {
      if (!currentIds.includes(id)) await db.addUserToBookclub(uid, id, 'member');
    }
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/users/:id', requireSuperAdmin, async (req, res) => {
  try {
    await db.deleteUser(parseInt(req.params.id));
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/users/:id/reset-password', requireSuperAdmin, async (req, res) => {
  try {
    const user = await db.getUser(parseInt(req.params.id));
    if (!user) return res.status(404).json({ error: 'Not found' });
    const tempPwd = generateTempPassword();
    await db.updateUser(user.id, { password_hash: hashPassword(tempPwd) });
    const clubs = await db.getUserBookclubs(user.id);
    try {
      await sendInviteEmail({ to: user.email, name: user.name, bookclubName: clubs[0]?.name || 'Book Club', loginUrl: APP_URL, tempPassword: tempPwd });
    } catch (err) { console.error('Email error:', err.message); }
    res.json({ temp_password: tempPwd });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ── Genres ────────────────────────────────────────────────────────────────────
app.get('/api/genres', requireAuth, async (req, res) => {
  try { res.json(await db.getGenres()); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/genres', requireSuperAdmin, async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Genre name required' });
  try { res.status(201).json(await db.addGenre(name.trim())); }
  catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Genre already exists' });
    console.error(e); res.status(500).json({ error: 'Server error' });
  }
});

app.patch('/api/genres/:id', requireSuperAdmin, async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Genre name required' });
  try {
    const g = await db.updateGenre(parseInt(req.params.id), name.trim());
    if (!g) return res.status(404).json({ error: 'Genre not found' });
    res.json(g);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Genre already exists' });
    console.error(e); res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/genres/:id', requireSuperAdmin, async (req, res) => {
  try { await db.deleteGenre(parseInt(req.params.id)); res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ── Cover Upload ──────────────────────────────────────────────────────────────
app.post('/api/upload/cover', requireAuth, upload.single('cover'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const key    = `covers/${Date.now()}-${randomBytes(6).toString('hex')}.jpg`;
    const buffer = await sharp(req.file.buffer)
      .resize(200, 300, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
    await r2.send(new PutObjectCommand({
      Bucket:      process.env.R2_BUCKET_NAME,
      Key:         key,
      Body:        buffer,
      ContentType: 'image/jpeg',
    }));
    res.json({ url: `${process.env.R2_PUBLIC_URL}/${key}` });
  } catch (e) { console.error('Cover upload error:', e); res.status(500).json({ error: 'Image processing failed' }); }
});

// ── Book Search ───────────────────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) return res.json([]);
  try {
    const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=12&fields=key,title,author_name,cover_i,number_of_pages_median,subject,first_publish_year`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = await r.json();
    res.json((data.docs || []).map(b => ({
      title:           b.title || 'Unknown',
      author:          b.author_name?.[0] || 'Unknown',
      cover_url:       b.cover_i ? `https://covers.openlibrary.org/b/id/${b.cover_i}-M.jpg` : null,
      open_library_id: b.key || null,
      page_count:      b.number_of_pages_median || null,
      release_year:    b.first_publish_year || null,
      genre:           extractGenre(b.subject),
    })));
  } catch { res.status(500).json({ error: 'Search failed' }); }
});

app.get('/api/book-info', async (req, res) => {
  const { key } = req.query;
  if (!key?.startsWith('/works/')) return res.json({ description: null, genre: null });
  try {
    const r = await fetch(`https://openlibrary.org${key}.json`, { signal: AbortSignal.timeout(6000) });
    const data = await r.json();
    let description = null;
    if (data.description) {
      description = typeof data.description === 'string' ? data.description : data.description.value;
      if (description?.length > 1000) description = description.slice(0, 1000).replace(/\s\S*$/, '') + '…';
    }
    res.json({ description, genre: extractGenre(data.subjects) });
  } catch { res.json({ description: null, genre: null }); }
});

// ── Books ─────────────────────────────────────────────────────────────────────
app.get('/api/bookclubs/:clubId/books', requireClubAccess, async (req, res) => {
  try {
    res.json(await db.getBooks(parseInt(req.params.clubId)));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/bookclubs/:clubId/books', requireClubAccess, async (req, res) => {
  const clubId = parseInt(req.params.clubId);
  const { title, author, genre, cover_url, open_library_id, page_count, release_year, description,
          submitted_at, selected, selected_at, added_by_name, added_by_user_id } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Title required' });
  try {
    if (await db.bookExistsInClub(clubId, title)) {
      return res.status(409).json({ error: 'Book already in this club' });
    }
    const clubRole  = await db.getClubRole(req.user.id, clubId);
    const isPrivileged = req.user.role === 'superadmin' || clubRole === 'admin';
    const book = await db.insertBook({
      bookclub_id:      clubId,
      title, author, genre, cover_url, open_library_id, page_count, release_year, description,
      submitted_at:     submitted_at || null,
      selected:         selected     || false,
      selected_at:      selected_at  || null,
      added_by_name:    isPrivileged ? (added_by_name || req.user.name) : req.user.name,
      added_by_user_id: isPrivileged ? (added_by_user_id || req.user.id) : req.user.id,
    });
    res.status(201).json(book);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.patch('/api/bookclubs/:clubId/books/:id', requireClubAccess, async (req, res) => {
  const clubId = parseInt(req.params.clubId);
  const bookId = parseInt(req.params.id);
  try {
    const book = await db.getBook(bookId);
    if (!book || book.bookclub_id !== clubId) return res.status(404).json({ error: 'Not found' });
    const clubRole     = await db.getClubRole(req.user.id, clubId);
    const isPrivileged = req.user.role === 'superadmin' || clubRole === 'admin';
    const isOwner      = book.added_by_user_id === req.user.id;
    if (!isPrivileged && !isOwner)
      return res.status(403).json({ error: 'You can only edit your own books' });
    const adminFields  = ['title','author','genre','page_count','release_year','description','submitted_at',
                          'selected','selected_at','discussion_date','added_by_name','added_by_user_id','active_for_voting','cover_url'];
    const memberFields = ['title','author','genre','page_count','release_year','description','discussion_date','active_for_voting','cover_url'];
    const allowed = isPrivileged ? adminFields : memberFields;
    const fields = {};
    for (const k of allowed) { if (req.body[k] !== undefined) fields[k] = req.body[k]; }
    const updated = await db.updateBook(bookId, fields);
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(updated);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.patch('/api/bookclubs/:clubId/books/:id/toggle-voting', requireClubAccess, async (req, res) => {
  try {
    const book = await db.getBook(parseInt(req.params.id));
    if (!book || book.bookclub_id !== parseInt(req.params.clubId)) {
      return res.status(404).json({ error: 'Not found' });
    }
    const clubRole    = await db.getClubRole(req.user.id, parseInt(req.params.clubId));
    const isPrivileged = req.user.role === 'superadmin' || clubRole === 'admin';
    if (!isPrivileged && book.added_by_user_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only remove your own books' });
    }
    res.json(await db.updateBook(book.id, { active_for_voting: !book.active_for_voting }));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.patch('/api/bookclubs/:clubId/books/:id/archive', requireClubAccess, async (req, res) => {
  const clubId = parseInt(req.params.clubId);
  const bookId = parseInt(req.params.id);
  const { archived } = req.body;
  try {
    const book = await db.getBook(bookId);
    if (!book || book.bookclub_id !== clubId) return res.status(404).json({ error: 'Not found' });
    if (archived && book.selected)
      return res.status(400).json({ error: 'Cannot archive a book that has been selected' });
    const clubRole     = await db.getClubRole(req.user.id, clubId);
    const isPrivileged = req.user.role === 'superadmin' || clubRole === 'admin';
    if (!isPrivileged && book.added_by_user_id !== req.user.id)
      return res.status(403).json({ error: 'You can only archive your own books' });
    res.json(await db.updateBook(bookId, { archived: !!archived }));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/bookclubs/:clubId/books/:id', requireClubAccess, async (req, res) => {
  const bookId = parseInt(req.params.id);
  const clubId = parseInt(req.params.clubId);
  try {
    const book = await db.getBook(bookId);
    if (!book || book.bookclub_id !== clubId) return res.status(404).json({ error: 'Not found' });
    const clubRole = await db.getClubRole(req.user.id, clubId);
    if (clubRole !== 'admin' && req.user.role !== 'superadmin' && book.added_by_user_id !== req.user.id)
      return res.status(403).json({ error: 'You can only delete your own books' });
    await db.deleteBook(bookId);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ── Voting ────────────────────────────────────────────────────────────────────
app.get('/api/bookclubs/:clubId/voting/session', requireClubAccess, async (req, res) => {
  try {
    res.json(await db.getLatestSession(parseInt(req.params.clubId)));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/bookclubs/:clubId/voting/session', requireClubAdmin, async (req, res) => {
  const clubId = parseInt(req.params.clubId);
  const { votes_per_member = 2, book_ids = [], voter_ids = [] } = req.body;
  if (!Number.isInteger(votes_per_member) || votes_per_member < 1)
    return res.status(400).json({ error: 'votes_per_member must be a positive integer' });
  if (!book_ids.length)
    return res.status(400).json({ error: 'Select at least one book for the ballot' });
  if (book_ids.length < votes_per_member)
    return res.status(400).json({ error: `Need at least ${votes_per_member} books for ${votes_per_member} picks` });
  try {
    if (await db.getOpenSession(clubId)) return res.status(409).json({ error: 'Session already open' });
    for (const id of book_ids) {
      const b = await db.getBook(id);
      if (!b || b.bookclub_id !== clubId) return res.status(400).json({ error: 'Invalid book in ballot' });
    }
    res.status(201).json(await db.insertSession(clubId, votes_per_member, book_ids, voter_ids));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.patch('/api/bookclubs/:clubId/voting/session/:sid/close', requireClubAdmin, async (req, res) => {
  try {
    const s = await db.closeSession(parseInt(req.params.sid));
    if (!s) return res.status(404).json({ error: 'Not found' });
    res.json(s);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.patch('/api/bookclubs/:clubId/voting/session/:sid/reopen', requireClubAdmin, async (req, res) => {
  try {
    const existing = await db.getOpenSession(parseInt(req.params.clubId));
    if (existing && existing.id !== parseInt(req.params.sid))
      return res.status(409).json({ error: 'Another session is already open' });
    const s = await db.reopenSession(parseInt(req.params.sid));
    if (!s) return res.status(404).json({ error: 'Not found' });
    res.json(s);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/bookclubs/:clubId/voting/vote', requireClubAccess, async (req, res) => {
  const clubId = parseInt(req.params.clubId);
  const { book_ids } = req.body;
  try {
    const session = await db.getLatestSession(clubId);
    if (!session || session.is_closed) return res.status(400).json({ error: 'No open voting session' });
    const n = session.votes_per_member || 2;
    if (!Array.isArray(book_ids) || book_ids.length !== n || new Set(book_ids).size !== n)
      return res.status(400).json({ error: `Select exactly ${n} different book${n !== 1 ? 's' : ''}` });
    if (await db.hasVoted(session.id, req.user.id)) return res.status(409).json({ error: 'Already voted' });
    const voterIds = session.session_voter_ids || [];
    if (voterIds.length && !voterIds.includes(req.user.id))
      return res.status(403).json({ error: 'You are not eligible to vote in this session' });
    const ballotIds = session.session_book_ids || [];
    for (const id of book_ids) {
      if (ballotIds.length && !ballotIds.includes(id))
        return res.status(400).json({ error: "Book not in this session's ballot" });
      if (!ballotIds.length) {
        const b = await db.getBook(id);
        if (!b || !b.active_for_voting || b.bookclub_id !== clubId)
          return res.status(400).json({ error: 'Invalid book selection' });
      }
    }
    await db.insertVote({ session_id: session.id, voter_user_id: req.user.id,
      voter_name: req.user.name, book_ids });
    res.status(201).json({ message: 'Vote submitted!' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/bookclubs/:clubId/voting/results/:sid', requireClubAccess, async (req, res) => {
  try {
    const session = await db.getVotingSession(parseInt(req.params.sid));
    if (!session) return res.status(404).json({ error: 'Not found' });
    const clubRole     = await db.getClubRole(req.user.id, parseInt(req.params.clubId));
    const isPrivileged = req.user.role === 'superadmin' || clubRole === 'admin';
    if (!session.is_closed && !isPrivileged && !session.results_visible) {
      return res.status(403).json({ error: 'Results hidden until voting closes' });
    }
    const data = await db.getResults(session.id, parseInt(req.params.clubId));
    // Admins see voter status only while session is open (no vote counts or book rankings)
    if (!session.is_closed && isPrivileged) {
      return res.json({ results: [], total_voters: data.total_voters, voter_status: data.voter_status, results_hidden: true });
    }
    res.json(data);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/bookclubs/:clubId/voting/my-vote', requireClubAccess, async (req, res) => {
  try {
    const session = await db.getLatestSession(parseInt(req.params.clubId));
    if (!session) return res.json({ book_ids: [] });
    const book_ids = await db.getMyVote(session.id, req.user.id);
    res.json({ book_ids });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/bookclubs/:clubId/voting/vote', requireClubAccess, async (req, res) => {
  try {
    const session = await db.getLatestSession(parseInt(req.params.clubId));
    if (!session || session.is_closed) return res.status(400).json({ error: 'No open voting session' });
    await db.deleteOwnVote(session.id, req.user.id);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/bookclubs/:clubId/voting/check-voted', requireClubAccess, async (req, res) => {
  try {
    const session = await db.getLatestSession(parseInt(req.params.clubId));
    if (!session) return res.json({ has_voted: false, is_eligible: true });
    const voterIds = session.session_voter_ids || [];
    const is_eligible = voterIds.length === 0 || voterIds.includes(req.user.id);
    res.json({ has_voted: await db.hasVoted(session.id, req.user.id), is_eligible });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ── Voting History ────────────────────────────────────────────────────────────
// List all sessions (club admin)
app.get('/api/bookclubs/:clubId/voting/sessions', requireClubAdmin, async (req, res) => {
  try { res.json(await db.getAllSessions(parseInt(req.params.clubId))); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// List closed sessions for members
app.get('/api/bookclubs/:clubId/voting/history', requireClubAccess, async (req, res) => {
  try {
    const sessions = await db.getAllSessions(parseInt(req.params.clubId));
    res.json(sessions.filter(s => s.is_closed));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Vote details for one session (club admin) — only after session is closed
app.get('/api/bookclubs/:clubId/voting/sessions/:sid/votes', requireClubAdmin, async (req, res) => {
  try {
    const session = await db.getVotingSession(parseInt(req.params.sid));
    if (!session) return res.status(404).json({ error: 'Not found' });
    if (!session.is_closed) return res.status(403).json({ error: 'Vote details are hidden until the session is closed' });
    res.json(await db.getSessionVoteDetails(parseInt(req.params.sid)));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Delete a session + its votes (club admin)
app.delete('/api/bookclubs/:clubId/voting/sessions/:sid', requireClubAdmin, async (req, res) => {
  try { await db.deleteVotingSession(parseInt(req.params.sid)); res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Remove one member's vote (superadmin only)
app.delete('/api/bookclubs/:clubId/voting/sessions/:sid/votes/:voteId', requireSuperAdmin, async (req, res) => {
  try { await db.deleteVote(parseInt(req.params.voteId)); res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Toggle live results visibility for all members (superadmin only)
app.patch('/api/bookclubs/:clubId/voting/session/:sid/toggle-results', requireSuperAdmin, async (req, res) => {
  try {
    const { visible } = req.body;
    const s = await db.toggleResultsVisible(parseInt(req.params.sid), !!visible);
    if (!s) return res.status(404).json({ error: 'Not found' });
    res.json(s);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ── Next Meeting ──────────────────────────────────────────────────────────────
app.get('/api/bookclubs/:clubId/next-meeting', requireClubAccess, async (req, res) => {
  try {
    res.json(await db.getNextMeeting(parseInt(req.params.clubId)));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.patch('/api/bookclubs/:clubId/next-meeting', requireClubAdmin, async (req, res) => {
  const { book_id, meeting_at, location } = req.body;
  try {
    const club = await db.setNextMeeting(
      parseInt(req.params.clubId),
      book_id ? parseInt(book_id) : null,
      meeting_at || null,
      location   || null
    );
    if (!club) return res.status(404).json({ error: 'Not found' });
    res.json(club);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ── Analytics ─────────────────────────────────────────────────────────────────
app.get('/api/bookclubs/:clubId/analytics', requireClubAccess, async (req, res) => {
  try {
    res.json(await db.getAnalytics(parseInt(req.params.clubId), req.query.from, req.query.to));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ── Start ─────────────────────────────────────────────────────────────────────
db.init().then(() => {
  app.listen(PORT, () => {
    console.log(`\nBook Club — http://localhost:${PORT}`);
    console.log(`APP_URL: ${APP_URL}\n`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
