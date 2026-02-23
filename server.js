'use strict';
require('dotenv').config();
const express = require('express');
const path    = require('path');
const db      = require('./database');
const { hashPassword, verifyPassword, generateToken, generateTempPassword, verifyGoogleToken } = require('./auth');
const { sendInviteEmail } = require('./email');

const app             = express();
const PORT            = process.env.PORT || 3000;
const APP_URL         = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Genre extraction ──────────────────────────────────────────────────────────
const GENRE_EXCLUDE = /^(accessible|protected|in library|large type|daisy|nook|overdrive|ebook|kindle|ipad|epub)/i;
function extractGenre(subjects) {
  if (!subjects?.length) return null;
  const cleaned = subjects
    .filter(s => typeof s === 'string' && s.length < 40 && !GENRE_EXCLUDE.test(s))
    .slice(0, 3);
  return cleaned.length ? cleaned.join(', ') : null;
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

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const user = await db.getUserByEmail(email);
    if (!user || !user.password_hash || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
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

app.post('/api/auth/logout', requireAuth, async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '').trim();
  if (token) await db.deleteSession(token);
  res.json({ ok: true });
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
  try {
    await db.deleteBookclub(parseInt(req.params.clubId));
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ── Members ───────────────────────────────────────────────────────────────────
app.get('/api/bookclubs/:clubId/members', requireClubAccess, async (req, res) => {
  try {
    res.json(await db.getBookclubMembers(parseInt(req.params.clubId)));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/bookclubs/:clubId/members', requireClubAdmin, async (req, res) => {
  const { user_id } = req.body;
  try {
    const user = await db.getUser(parseInt(user_id));
    if (!user) return res.status(404).json({ error: 'User not found' });
    await db.addUserToBookclub(user.id, parseInt(req.params.clubId));
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
    await db.setClubRole(parseInt(req.params.uid), parseInt(req.params.clubId), role);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ── Users ─────────────────────────────────────────────────────────────────────
app.get('/api/users', requireSuperAdmin, async (req, res) => {
  try {
    res.json((await db.getAllUsers()).map(({ password_hash, ...u }) => u));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/users', requireAuth, async (req, res) => {
  const { name, bookclub_ids = [] } = req.body;
  const email = req.body.email?.trim() || null;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });

  // Superadmin can create without email; club admins must provide email (for invite)
  if (req.user.role !== 'superadmin') {
    if (!email) return res.status(400).json({ error: 'Email required' });
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
    const tempPwd = email ? generateTempPassword() : null;
    const user    = await db.createUser(name, email, tempPwd ? hashPassword(tempPwd) : null);

    for (const cid of bookclub_ids) {
      const club = await db.getBookclub(parseInt(cid));
      if (!club) continue;
      await db.addUserToBookclub(user.id, club.id);
      if (email && tempPwd) {
        try {
          await sendInviteEmail({ to: email, name: user.name, bookclubName: club.name, loginUrl: APP_URL, tempPassword: tempPwd });
        } catch (err) { console.error('Email error:', err.message); }
      }
    }

    const { password_hash, ...safe } = user;
    res.status(201).json({ ...safe, ...(tempPwd && { temp_password: tempPwd }) });
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

// ── Book Search ───────────────────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) return res.json([]);
  try {
    const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=12&fields=key,title,author_name,cover_i,number_of_pages_median,subject`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = await r.json();
    res.json((data.docs || []).map(b => ({
      title:           b.title || 'Unknown',
      author:          b.author_name?.[0] || 'Unknown',
      cover_url:       b.cover_i ? `https://covers.openlibrary.org/b/id/${b.cover_i}-M.jpg` : null,
      open_library_id: b.key || null,
      page_count:      b.number_of_pages_median || null,
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
  const { title, author, genre, cover_url, open_library_id, page_count, description,
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
      title, author, genre, cover_url, open_library_id, page_count, description,
      submitted_at:     submitted_at || null,
      selected:         selected     || false,
      selected_at:      selected_at  || null,
      added_by_name:    isPrivileged ? (added_by_name || req.user.name) : req.user.name,
      added_by_user_id: isPrivileged ? (added_by_user_id || req.user.id) : req.user.id,
    });
    res.status(201).json(book);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.patch('/api/bookclubs/:clubId/books/:id', requireClubAdmin, async (req, res) => {
  const allowed = ['title','author','genre','page_count','description','submitted_at',
                   'selected','selected_at','added_by_name','added_by_user_id','active_for_voting'];
  const fields = {};
  for (const k of allowed) { if (req.body[k] !== undefined) fields[k] = req.body[k]; }
  try {
    const updated = await db.updateBook(parseInt(req.params.id), fields);
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

app.delete('/api/bookclubs/:clubId/books/:id', requireClubAdmin, async (req, res) => {
  try {
    await db.deleteBook(parseInt(req.params.id));
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
  try {
    if (await db.getOpenSession(clubId)) return res.status(409).json({ error: 'Session already open' });
    res.status(201).json(await db.insertSession(clubId));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.patch('/api/bookclubs/:clubId/voting/session/:sid/close', requireClubAdmin, async (req, res) => {
  try {
    const s = await db.closeSession(parseInt(req.params.sid));
    if (!s) return res.status(404).json({ error: 'Not found' });
    res.json(s);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/bookclubs/:clubId/voting/vote', requireClubAccess, async (req, res) => {
  const clubId = parseInt(req.params.clubId);
  const { book_ids } = req.body;
  if (!Array.isArray(book_ids) || book_ids.length !== 2 || book_ids[0] === book_ids[1]) {
    return res.status(400).json({ error: 'Select exactly 2 different books' });
  }
  try {
    const session = await db.getLatestSession(clubId);
    if (!session || session.is_closed) return res.status(400).json({ error: 'No open voting session' });
    if (await db.hasVoted(session.id, req.user.id)) return res.status(409).json({ error: 'Already voted' });
    for (const id of book_ids) {
      const b = await db.getBook(id);
      if (!b || !b.active_for_voting || b.bookclub_id !== clubId) {
        return res.status(400).json({ error: 'Invalid book selection' });
      }
    }
    await db.insertVote({
      session_id: session.id, voter_user_id: req.user.id,
      voter_name: req.user.name, book_id_1: book_ids[0], book_id_2: book_ids[1],
    });
    res.status(201).json({ message: 'Vote submitted!' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/bookclubs/:clubId/voting/results/:sid', requireClubAccess, async (req, res) => {
  try {
    const session = await db.getVotingSession(parseInt(req.params.sid));
    if (!session) return res.status(404).json({ error: 'Not found' });
    const clubRole    = await db.getClubRole(req.user.id, parseInt(req.params.clubId));
    const isPrivileged = req.user.role === 'superadmin' || clubRole === 'admin';
    if (!session.is_closed && !isPrivileged) {
      return res.status(403).json({ error: 'Results hidden until voting closes' });
    }
    res.json(await db.getResults(session.id, parseInt(req.params.clubId)));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/bookclubs/:clubId/voting/check-voted', requireClubAccess, async (req, res) => {
  try {
    const session = await db.getLatestSession(parseInt(req.params.clubId));
    res.json({ has_voted: session ? await db.hasVoted(session.id, req.user.id) : false });
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
