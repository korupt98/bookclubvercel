'use strict';
require('dotenv').config();
const { Pool } = require('pg');
const fs   = require('fs');
const path = require('path');

const dbUrl = process.env.DATABASE_URL || '';
const needsSSL = dbUrl.length > 0
  && !dbUrl.includes('localhost')
  && !dbUrl.includes('127.0.0.1');
const pool = new Pool({
  connectionString: dbUrl,
  ssl: needsSSL ? { rejectUnauthorized: false } : false,
});

/* ── Bootstrap ──────────────────────────────────────────────────────────────── */
async function init() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);

  const superadminEmail = process.env.SUPERADMIN_EMAIL;
  if (superadminEmail) {
    await pool.query(
      `UPDATE users SET role = 'superadmin' WHERE email = $1`,
      [superadminEmail]
    );
  }
  console.log('Database initialized');
}

/* ── Sessions ───────────────────────────────────────────────────────────────── */
async function getSession(token) {
  const { rows } = await pool.query(
    'SELECT * FROM auth_sessions WHERE token = $1', [token]
  );
  return rows[0] || null;
}

async function createSession(userId, token) {
  const { rows } = await pool.query(
    'INSERT INTO auth_sessions (user_id, token) VALUES ($1, $2) RETURNING *',
    [userId, token]
  );
  return rows[0];
}

async function deleteSession(token) {
  await pool.query('DELETE FROM auth_sessions WHERE token = $1', [token]);
}

/* ── Users ──────────────────────────────────────────────────────────────────── */
async function getUser(id) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

async function getUserByEmail(email) {
  const { rows } = await pool.query(
    'SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]
  );
  return rows[0] || null;
}

async function getUserByGoogleId(googleId) {
  const { rows } = await pool.query(
    'SELECT * FROM users WHERE google_id = $1', [googleId]
  );
  return rows[0] || null;
}

async function getAllUsers() {
  const { rows } = await pool.query('SELECT * FROM users ORDER BY created_at');
  return rows;
}

async function createUser(name, email, passwordHash) {
  const { rows } = await pool.query(
    'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING *',
    [name, email, passwordHash]
  );
  return rows[0];
}

async function createGoogleUser(name, email, googleId) {
  const { rows } = await pool.query(
    'INSERT INTO users (name, email, google_id) VALUES ($1, $2, $3) RETURNING *',
    [name, email, googleId]
  );
  return rows[0];
}

async function setGoogleId(userId, googleId) {
  const { rows } = await pool.query(
    'UPDATE users SET google_id = $1 WHERE id = $2 RETURNING *',
    [googleId, userId]
  );
  return rows[0] || null;
}

async function updateUser(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return getUser(id);
  const setClauses = keys.map((k, i) => `"${k}" = $${i + 2}`).join(', ');
  const values = [id, ...keys.map(k => fields[k])];
  const { rows } = await pool.query(
    `UPDATE users SET ${setClauses} WHERE id = $1 RETURNING *`,
    values
  );
  return rows[0] || null;
}

async function deleteUser(id) {
  await pool.query('DELETE FROM users WHERE id = $1', [id]);
}

/* ── Book Clubs ─────────────────────────────────────────────────────────────── */
async function getAllBookclubs() {
  const { rows } = await pool.query('SELECT * FROM bookclubs ORDER BY created_at');
  return rows;
}

async function getUserBookclubs(userId) {
  const { rows } = await pool.query(
    `SELECT bc.*, bm.club_role
     FROM bookclubs bc
     JOIN bookclub_members bm ON bc.id = bm.bookclub_id
     WHERE bm.user_id = $1
     ORDER BY bc.created_at`,
    [userId]
  );
  return rows;
}

async function getBookclub(id) {
  const { rows } = await pool.query('SELECT * FROM bookclubs WHERE id = $1', [id]);
  return rows[0] || null;
}

async function createBookclub(name, description) {
  const { rows } = await pool.query(
    'INSERT INTO bookclubs (name, description) VALUES ($1, $2) RETURNING *',
    [name, description || null]
  );
  return rows[0];
}

async function updateBookclub(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return getBookclub(id);
  const setClauses = keys.map((k, i) => `"${k}" = $${i + 2}`).join(', ');
  const values = [id, ...keys.map(k => fields[k])];
  const { rows } = await pool.query(
    `UPDATE bookclubs SET ${setClauses} WHERE id = $1 RETURNING *`,
    values
  );
  return rows[0] || null;
}

async function deleteBookclub(id) {
  await pool.query('DELETE FROM bookclubs WHERE id = $1', [id]);
}

async function isUserInBookclub(userId, clubId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM bookclub_members WHERE user_id = $1 AND bookclub_id = $2',
    [userId, clubId]
  );
  return rows.length > 0;
}

async function getBookclubMembers(clubId) {
  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.email, u.role, u.created_at, bm.club_role
     FROM users u
     JOIN bookclub_members bm ON u.id = bm.user_id
     WHERE bm.bookclub_id = $1
     ORDER BY bm.joined_at`,
    [clubId]
  );
  return rows;
}

async function addUserToBookclub(userId, clubId) {
  await pool.query(
    `INSERT INTO bookclub_members (user_id, bookclub_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id, bookclub_id) DO NOTHING`,
    [userId, clubId]
  );
}

async function removeUserFromBookclub(userId, clubId) {
  await pool.query(
    'DELETE FROM bookclub_members WHERE user_id = $1 AND bookclub_id = $2',
    [userId, clubId]
  );
}

async function getClubRole(userId, clubId) {
  const { rows } = await pool.query(
    'SELECT club_role FROM bookclub_members WHERE user_id = $1 AND bookclub_id = $2',
    [userId, clubId]
  );
  return rows[0]?.club_role || null;
}

async function setClubRole(userId, clubId, role) {
  await pool.query(
    'UPDATE bookclub_members SET club_role = $1 WHERE user_id = $2 AND bookclub_id = $3',
    [role, userId, clubId]
  );
}

/* ── Books ──────────────────────────────────────────────────────────────────── */
async function getBooks(clubId) {
  const { rows } = await pool.query(
    'SELECT * FROM books WHERE bookclub_id = $1 ORDER BY added_at DESC',
    [clubId]
  );
  return rows;
}

async function getBook(id) {
  const { rows } = await pool.query('SELECT * FROM books WHERE id = $1', [id]);
  return rows[0] || null;
}

async function bookExistsInClub(clubId, title) {
  const { rows } = await pool.query(
    'SELECT 1 FROM books WHERE bookclub_id = $1 AND LOWER(title) = LOWER($2)',
    [clubId, title]
  );
  return rows.length > 0;
}

async function insertBook(fields) {
  const { rows } = await pool.query(
    `INSERT INTO books
       (bookclub_id, title, author, genre, cover_url, open_library_id,
        page_count, description, submitted_at, selected, selected_at,
        active_for_voting, added_by_name, added_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING *`,
    [
      fields.bookclub_id,
      fields.title,
      fields.author           || null,
      fields.genre            || null,
      fields.cover_url        || null,
      fields.open_library_id  || null,
      fields.page_count       || null,
      fields.description      || null,
      fields.submitted_at     || new Date().toISOString(),
      fields.selected         || false,
      fields.selected_at      || null,
      fields.active_for_voting !== false,
      fields.added_by_name    || null,
      fields.added_by_user_id || null,
    ]
  );
  return rows[0];
}

async function updateBook(id, fields) {
  const allowed = [
    'title','author','genre','page_count','description','submitted_at',
    'selected','selected_at','added_by_name','added_by_user_id','active_for_voting',
  ];
  const filtered = {};
  for (const k of allowed) {
    if (fields[k] !== undefined) filtered[k] = fields[k];
  }
  const keys = Object.keys(filtered);
  if (!keys.length) return getBook(id);
  const setClauses = keys.map((k, i) => `"${k}" = $${i + 2}`).join(', ');
  const values = [id, ...keys.map(k => filtered[k])];
  const { rows } = await pool.query(
    `UPDATE books SET ${setClauses} WHERE id = $1 RETURNING *`,
    values
  );
  return rows[0] || null;
}

async function deleteBook(id) {
  await pool.query('DELETE FROM books WHERE id = $1', [id]);
}

async function getPublicClubsWithBooks() {
  const clubs = await getAllBookclubs();
  const result = [];
  for (const club of clubs) {
    const { rows: books } = await pool.query(
      `SELECT id, title, author, genre, cover_url, page_count, selected, active_for_voting
       FROM books WHERE bookclub_id = $1 ORDER BY added_at DESC`,
      [club.id]
    );
    result.push({ ...club, books });
  }
  return result;
}

/* ── Voting ─────────────────────────────────────────────────────────────────── */
async function getLatestSession(clubId) {
  const { rows } = await pool.query(
    'SELECT * FROM voting_sessions WHERE bookclub_id = $1 ORDER BY created_at DESC LIMIT 1',
    [clubId]
  );
  return rows[0] || null;
}

async function getOpenSession(clubId) {
  const { rows } = await pool.query(
    'SELECT * FROM voting_sessions WHERE bookclub_id = $1 AND is_closed = FALSE LIMIT 1',
    [clubId]
  );
  return rows[0] || null;
}

async function insertSession(clubId) {
  const { rows } = await pool.query(
    'INSERT INTO voting_sessions (bookclub_id) VALUES ($1) RETURNING *',
    [clubId]
  );
  return rows[0];
}

async function closeSession(sid) {
  const { rows } = await pool.query(
    'UPDATE voting_sessions SET is_closed = TRUE, closed_at = NOW() WHERE id = $1 RETURNING *',
    [sid]
  );
  return rows[0] || null;
}

async function getVotingSession(sid) {
  const { rows } = await pool.query(
    'SELECT * FROM voting_sessions WHERE id = $1', [sid]
  );
  return rows[0] || null;
}

async function hasVoted(sessionId, userId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM votes WHERE session_id = $1 AND voter_user_id = $2',
    [sessionId, userId]
  );
  return rows.length > 0;
}

async function insertVote({ session_id, voter_user_id, voter_name, book_id_1, book_id_2 }) {
  const { rows } = await pool.query(
    `INSERT INTO votes (session_id, voter_user_id, voter_name, book_id_1, book_id_2)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [session_id, voter_user_id, voter_name, book_id_1, book_id_2]
  );
  return rows[0];
}

async function getResults(sessionId, clubId = null) {
  const { rows: voteCounts } = await pool.query(
    `SELECT book_id, COUNT(*) AS cnt FROM (
       SELECT book_id_1 AS book_id FROM votes WHERE session_id = $1
       UNION ALL
       SELECT book_id_2 AS book_id FROM votes WHERE session_id = $1
     ) t GROUP BY book_id ORDER BY cnt DESC`,
    [sessionId]
  );
  const { rows: voterRows } = await pool.query(
    'SELECT COUNT(DISTINCT voter_user_id) AS cnt FROM votes WHERE session_id = $1',
    [sessionId]
  );

  const results = [];
  for (const row of voteCounts) {
    const book = await getBook(row.book_id);
    if (book) results.push({ ...book, vote_count: Number(row.cnt) });
  }

  let voter_status = null;
  if (clubId) {
    const members = await getBookclubMembers(clubId);
    const { rows: voted } = await pool.query(
      'SELECT DISTINCT voter_user_id FROM votes WHERE session_id = $1 AND voter_user_id IS NOT NULL',
      [sessionId]
    );
    const votedIds = new Set(voted.map(r => Number(r.voter_user_id)));
    voter_status = members.map(m => ({ id: m.id, name: m.name, voted: votedIds.has(m.id) }));
  }

  return { results, total_voters: Number(voterRows[0]?.cnt || 0), voter_status };
}

async function getAllSessions(clubId) {
  const { rows } = await pool.query(
    `SELECT vs.*, COUNT(DISTINCT v.voter_user_id) AS voter_count
     FROM voting_sessions vs
     LEFT JOIN votes v ON v.session_id = vs.id
     WHERE vs.bookclub_id = $1
     GROUP BY vs.id ORDER BY vs.created_at DESC`,
    [clubId]
  );
  return rows.map(s => ({ ...s, voter_count: Number(s.voter_count) }));
}

async function getSessionVoteDetails(sessionId) {
  const { rows } = await pool.query(
    `SELECT v.voter_name, b1.title AS book1_title, b2.title AS book2_title
     FROM votes v
     JOIN books b1 ON b1.id = v.book_id_1
     JOIN books b2 ON b2.id = v.book_id_2
     WHERE v.session_id = $1 ORDER BY v.voter_name`,
    [sessionId]
  );
  return rows;
}

async function deleteVotingSession(sessionId) {
  await pool.query('DELETE FROM votes WHERE session_id = $1', [sessionId]);
  await pool.query('DELETE FROM voting_sessions WHERE id = $1', [sessionId]);
}

/* ── Analytics ──────────────────────────────────────────────────────────────── */
async function getAnalytics(clubId, from, to) {
  let query = 'SELECT * FROM books WHERE bookclub_id = $1';
  const params = [clubId];
  let idx = 2;

  if (from) {
    query += ` AND COALESCE(submitted_at, added_at) >= $${idx}`;
    params.push(from); idx++;
  }
  if (to) {
    query += ` AND COALESCE(submitted_at, added_at) <= $${idx}`;
    params.push(to + 'T23:59:59.999Z'); idx++;
  }

  const { rows: books } = await pool.query(query, params);
  const members  = await getBookclubMembers(clubId);
  const selected = books.filter(b => b.selected);

  const by_user = members
    .map(u => ({
      name:      u.name,
      submitted: books.filter(b => b.added_by_user_id === u.id).length,
      selected:  selected.filter(b => b.added_by_user_id === u.id).length,
    }))
    .filter(u => u.submitted > 0)
    .sort((a, b) => b.submitted - a.submitted);

  const genreMap = {};
  for (const b of books) {
    if (b.genre) {
      const g = b.genre.split(',')[0].trim();
      if (g) genreMap[g] = (genreMap[g] || 0) + 1;
    }
  }
  const genres = Object.entries(genreMap).sort((a, b) => b[1] - a[1]);

  const by_month = {};
  for (const b of selected) {
    if (b.selected_at) {
      const m = new Date(b.selected_at).toISOString().slice(0, 7);
      by_month[m] = (by_month[m] || 0) + 1;
    }
  }

  const withPages = books.filter(b => b.page_count);
  const avg_page_count = withPages.length
    ? Math.round(withPages.reduce((s, b) => s + Number(b.page_count), 0) / withPages.length)
    : null;

  return {
    total_submitted: books.length,
    total_read:      selected.length,
    total_members:   members.length,
    avg_page_count,
    by_user,
    genres,
    by_month,
  };
}

/* ── Exports ────────────────────────────────────────────────────────────────── */
module.exports = {
  init,
  // sessions
  getSession, createSession, deleteSession,
  // users
  getUser, getUserByEmail, getUserByGoogleId, getAllUsers,
  createUser, createGoogleUser, setGoogleId, updateUser, deleteUser,
  // bookclubs
  getAllBookclubs, getUserBookclubs, getBookclub, createBookclub, updateBookclub, deleteBookclub,
  isUserInBookclub, getBookclubMembers, addUserToBookclub, removeUserFromBookclub,
  getClubRole, setClubRole,
  // books
  getBooks, getBook, bookExistsInClub, insertBook, updateBook, deleteBook,
  getPublicClubsWithBooks,
  // voting
  getLatestSession, getOpenSession, insertSession, closeSession, getVotingSession,
  hasVoted, insertVote, getResults,
  getAllSessions, getSessionVoteDetails, deleteVotingSession,
  // analytics
  getAnalytics,
};
