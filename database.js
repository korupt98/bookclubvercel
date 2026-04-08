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

  // Migrate old book_id_1 / book_id_2 votes → vote_entries (idempotent)
  await pool.query(`
    INSERT INTO vote_entries (vote_id, book_id)
    SELECT v.id, unnest(ARRAY[v.book_id_1, v.book_id_2])
    FROM votes v
    WHERE (v.book_id_1 IS NOT NULL OR v.book_id_2 IS NOT NULL)
    ON CONFLICT DO NOTHING
  `);

  // Seed default genres (idempotent)
  const defaultGenres = [
    'Adventure', 'Biography / Memoir', 'Business', "Children's", 'Crime',
    'Fantasy', 'Fiction', 'Graphic Novel', 'Historical Fiction', 'Horror',
    'Humor', 'Literary Fiction', 'Mystery', 'Non-Fiction', 'Philosophy',
    'Poetry', 'Romance', 'Science', 'Science Fiction', 'Self-Help',
    'Short Stories', 'Spirituality', 'Thriller', 'True Crime', 'Young Adult',
  ];
  for (const name of defaultGenres) {
    await pool.query('INSERT INTO genres (name) VALUES ($1) ON CONFLICT DO NOTHING', [name]);
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

async function getUserByEmailOrUsername(identifier) {
  const { rows } = await pool.query(
    `SELECT * FROM users WHERE LOWER(email) = LOWER($1) OR LOWER(username) = LOWER($1) LIMIT 1`,
    [identifier]
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

async function createUser(name, email, passwordHash, username = null) {
  const { rows } = await pool.query(
    'INSERT INTO users (name, email, password_hash, username) VALUES ($1,$2,$3,$4) RETURNING *',
    [name, email, passwordHash, username || null]
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

async function addUserToBookclub(userId, clubId, role = 'member') {
  if (role === 'admin') {
    // Explicitly granting admin — set/override role
    await pool.query(
      `INSERT INTO bookclub_members (user_id, bookclub_id, club_role)
       VALUES ($1, $2, 'admin')
       ON CONFLICT (user_id, bookclub_id) DO UPDATE SET club_role = 'admin'`,
      [userId, clubId]
    );
  } else {
    // Default member insert — never downgrade an existing admin
    await pool.query(
      `INSERT INTO bookclub_members (user_id, bookclub_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, bookclub_id) DO NOTHING`,
      [userId, clubId]
    );
  }
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
  const { rowCount } = await pool.query(
    'UPDATE bookclub_members SET club_role = $1 WHERE user_id = $2 AND bookclub_id = $3',
    [role, userId, clubId]
  );
  return rowCount;
}

/* ── Books ──────────────────────────────────────────────────────────────────── */
async function getBooks(clubId) {
  const { rows } = await pool.query(
    'SELECT * FROM books WHERE bookclub_id = $1 ORDER BY COALESCE(submitted_at, added_at) DESC',
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
        page_count, release_year, description, submitted_at, selected, selected_at,
        active_for_voting, added_by_name, added_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING *`,
    [
      fields.bookclub_id,
      fields.title,
      fields.author           || null,
      fields.genre            || null,
      fields.cover_url        || null,
      fields.open_library_id  || null,
      fields.page_count       || null,
      fields.release_year     || null,
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
    'title','author','genre','page_count','release_year','description','submitted_at',
    'selected','selected_at','discussion_date','added_by_name','added_by_user_id','active_for_voting','archived','cover_url',
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
      `SELECT id, title, author, genre, cover_url, page_count, description, selected, active_for_voting
       FROM books WHERE bookclub_id = $1 AND archived = FALSE ORDER BY COALESCE(submitted_at, added_at) DESC`,
      [club.id]
    );
    const { rows: stats } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE selected AND COALESCE(discussion_date, selected_at::date) <= CURRENT_DATE) AS books_read,
         COALESCE(SUM(page_count) FILTER (WHERE selected AND page_count IS NOT NULL AND COALESCE(discussion_date, selected_at::date) <= CURRENT_DATE), 0) AS pages_read
       FROM books WHERE bookclub_id = $1`,
      [club.id]
    );
    result.push({
      ...club,
      books,
      books_read: Number(stats[0].books_read),
      pages_read: Number(stats[0].pages_read),
    });
  }
  return result;
}

/* ── Voting ─────────────────────────────────────────────────────────────────── */
async function getLatestSession(clubId) {
  const { rows } = await pool.query(
    'SELECT * FROM voting_sessions WHERE bookclub_id = $1 ORDER BY created_at DESC LIMIT 1',
    [clubId]
  );
  if (!rows[0]) return null;
  const session = rows[0];
  session.votes_per_member = Number(session.votes_per_member);
  const [{ rows: sb }, { rows: sv }] = await Promise.all([
    pool.query('SELECT book_id  FROM session_books  WHERE session_id = $1', [session.id]),
    pool.query('SELECT user_id  FROM session_voters WHERE session_id = $1', [session.id]),
  ]);
  session.session_book_ids  = sb.map(r => r.book_id);
  session.session_voter_ids = sv.map(r => r.user_id);
  return session;
}

async function getOpenSession(clubId) {
  const { rows } = await pool.query(
    'SELECT * FROM voting_sessions WHERE bookclub_id = $1 AND is_closed = FALSE LIMIT 1',
    [clubId]
  );
  if (!rows[0]) return null;
  const session = rows[0];
  session.votes_per_member = Number(session.votes_per_member);
  const [{ rows: sb }, { rows: sv }] = await Promise.all([
    pool.query('SELECT book_id  FROM session_books  WHERE session_id = $1', [session.id]),
    pool.query('SELECT user_id  FROM session_voters WHERE session_id = $1', [session.id]),
  ]);
  session.session_book_ids  = sb.map(r => r.book_id);
  session.session_voter_ids = sv.map(r => r.user_id);
  return session;
}

async function insertSession(clubId, votesPerMember, bookIds, voterIds) {
  const { rows } = await pool.query(
    'INSERT INTO voting_sessions (bookclub_id, votes_per_member) VALUES ($1, $2) RETURNING *',
    [clubId, votesPerMember || 2]
  );
  const session = rows[0];
  if (bookIds?.length) {
    await pool.query(
      `INSERT INTO session_books (session_id, book_id)
       SELECT $1, unnest($2::int[])`,
      [session.id, bookIds]
    );
  }
  if (voterIds?.length) {
    await pool.query(
      `INSERT INTO session_voters (session_id, user_id)
       SELECT $1, unnest($2::int[])`,
      [session.id, voterIds]
    );
  }
  session.session_book_ids  = bookIds  || [];
  session.session_voter_ids = voterIds || [];
  session.votes_per_member  = Number(session.votes_per_member);
  return session;
}

async function closeSession(sid) {
  const { rows } = await pool.query(
    'UPDATE voting_sessions SET is_closed = TRUE, closed_at = NOW() WHERE id = $1 RETURNING *',
    [sid]
  );
  return rows[0] || null;
}

async function reopenSession(sid) {
  const { rows } = await pool.query(
    'UPDATE voting_sessions SET is_closed = FALSE, closed_at = NULL, results_visible = FALSE WHERE id = $1 RETURNING *',
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

async function insertVote({ session_id, voter_user_id, voter_name, book_ids }) {
  const { rows } = await pool.query(
    `INSERT INTO votes (session_id, voter_user_id, voter_name) VALUES ($1, $2, $3) RETURNING *`,
    [session_id, voter_user_id, voter_name]
  );
  const vote = rows[0];
  for (const bid of book_ids) {
    await pool.query(
      'INSERT INTO vote_entries (vote_id, book_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [vote.id, bid]
    );
  }
  return vote;
}

async function getMyVote(sessionId, userId) {
  const { rows } = await pool.query(
    `SELECT ve.book_id FROM votes v
     JOIN vote_entries ve ON ve.vote_id = v.id
     WHERE v.session_id = $1 AND v.voter_user_id = $2`,
    [sessionId, userId]
  );
  return rows.map(r => r.book_id);
}

async function deleteOwnVote(sessionId, userId) {
  const { rows } = await pool.query(
    'SELECT id FROM votes WHERE session_id = $1 AND voter_user_id = $2',
    [sessionId, userId]
  );
  if (rows[0]) {
    await pool.query('DELETE FROM votes WHERE id = $1', [rows[0].id]);
  }
}

async function getResults(sessionId, clubId = null) {
  const { rows: voteCounts } = await pool.query(
    `SELECT ve.book_id, COUNT(*) AS cnt
     FROM vote_entries ve
     JOIN votes v ON v.id = ve.vote_id
     WHERE v.session_id = $1
     GROUP BY ve.book_id ORDER BY cnt DESC`,
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
    const [{ rows: voted }, { rows: eligibleRows }] = await Promise.all([
      pool.query('SELECT DISTINCT voter_user_id FROM votes WHERE session_id = $1 AND voter_user_id IS NOT NULL', [sessionId]),
      pool.query('SELECT user_id FROM session_voters WHERE session_id = $1', [sessionId]),
    ]);
    const votedIds    = new Set(voted.map(r => Number(r.voter_user_id)));
    const eligibleIds = new Set(eligibleRows.map(r => Number(r.user_id)));
    // If session has a restricted voter list, only show those members; otherwise show all
    const eligible = eligibleIds.size > 0 ? members.filter(m => eligibleIds.has(m.id)) : members;
    voter_status = eligible.map(m => ({ id: m.id, name: m.name, voted: votedIds.has(m.id) }));
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
  return rows.map(s => ({ ...s, voter_count: Number(s.voter_count), votes_per_member: Number(s.votes_per_member) }));
}

async function getSessionVoteDetails(sessionId) {
  const { rows } = await pool.query(
    `SELECT v.id AS vote_id, v.voter_user_id, v.voter_name, array_agg(b.title ORDER BY ve.id) AS book_titles
     FROM votes v
     JOIN vote_entries ve ON ve.vote_id = v.id
     JOIN books b ON b.id = ve.book_id
     WHERE v.session_id = $1
     GROUP BY v.id, v.voter_user_id, v.voter_name
     ORDER BY v.voter_name`,
    [sessionId]
  );
  return rows;
}

async function deleteVote(voteId) {
  await pool.query('DELETE FROM votes WHERE id = $1', [voteId]);
}

async function toggleResultsVisible(sessionId, visible) {
  const { rows } = await pool.query(
    'UPDATE voting_sessions SET results_visible = $1 WHERE id = $2 RETURNING *',
    [visible, sessionId]
  );
  return rows[0] || null;
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

/* ── Next Meeting ───────────────────────────────────────────────────────────── */
async function getNextMeeting(clubId) {
  const { rows } = await pool.query(
    `SELECT bc.next_meeting_at, bc.next_meeting_location, bc.next_book_id,
            b.title, b.author, b.genre, b.cover_url, b.page_count, b.release_year,
            b.description, b.added_by_name, b.added_by_user_id
     FROM bookclubs bc
     LEFT JOIN books b ON b.id = bc.next_book_id
     WHERE bc.id = $1`,
    [clubId]
  );
  return rows[0] || null;
}

async function setNextMeeting(clubId, bookId, meetingAt, location) {
  const { rows } = await pool.query(
    `UPDATE bookclubs
     SET next_book_id = $2, next_meeting_at = $3, next_meeting_location = $4
     WHERE id = $1 RETURNING *`,
    [clubId, bookId || null, meetingAt || null, location || null]
  );
  return rows[0] || null;
}

/* ── Announcements ──────────────────────────────────────────────────────────── */
async function getAnnouncements(clubId) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS announcements (
      id          SERIAL PRIMARY KEY,
      bookclub_id INT  NOT NULL REFERENCES bookclubs(id) ON DELETE CASCADE,
      content     TEXT NOT NULL,
      created_by  INT  REFERENCES users(id) ON DELETE SET NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(() => {});
  const { rows } = await pool.query(
    `SELECT a.id, a.content, a.created_at, u.name AS author_name
     FROM announcements a
     LEFT JOIN users u ON u.id = a.created_by
     WHERE a.bookclub_id = $1
     ORDER BY a.created_at DESC`,
    [clubId]
  );
  return rows;
}

async function createAnnouncement(clubId, content, userId) {
  const { rows } = await pool.query(
    `INSERT INTO announcements (bookclub_id, content, created_by)
     VALUES ($1, $2, $3) RETURNING *`,
    [clubId, content, userId]
  );
  return rows[0];
}

async function updateAnnouncement(id, clubId, content) {
  const { rows } = await pool.query(
    'UPDATE announcements SET content = $1 WHERE id = $2 AND bookclub_id = $3 RETURNING *',
    [content, id, clubId]
  );
  return rows[0] || null;
}

async function deleteAnnouncement(id, clubId) {
  await pool.query(
    'DELETE FROM announcements WHERE id = $1 AND bookclub_id = $2',
    [id, clubId]
  );
}

/* ── Genres ─────────────────────────────────────────────────────────────────── */
async function getGenres() {
  const { rows } = await pool.query('SELECT * FROM genres ORDER BY name');
  return rows;
}

async function addGenre(name) {
  const { rows } = await pool.query(
    'INSERT INTO genres (name) VALUES ($1) RETURNING *', [name]
  );
  return rows[0];
}

async function updateGenre(id, name) {
  const { rows } = await pool.query(
    'UPDATE genres SET name = $1 WHERE id = $2 RETURNING *', [name, id]
  );
  return rows[0] || null;
}

async function deleteGenre(id) {
  await pool.query('DELETE FROM genres WHERE id = $1', [id]);
}

/* ── Exports ────────────────────────────────────────────────────────────────── */
module.exports = {
  pool,
  init,
  // sessions
  getSession, createSession, deleteSession,
  // users
  getUser, getUserByEmail, getUserByEmailOrUsername, getUserByGoogleId, getAllUsers,
  createUser, createGoogleUser, setGoogleId, updateUser, deleteUser,
  // bookclubs
  getAllBookclubs, getUserBookclubs, getBookclub, createBookclub, updateBookclub, deleteBookclub,
  isUserInBookclub, getBookclubMembers, addUserToBookclub, removeUserFromBookclub,
  getClubRole, setClubRole,
  // books
  getBooks, getBook, bookExistsInClub, insertBook, updateBook, deleteBook,
  getPublicClubsWithBooks,
  // voting
  getLatestSession, getOpenSession, insertSession, closeSession, reopenSession, getVotingSession,
  hasVoted, insertVote, getMyVote, deleteOwnVote, getResults,
  getAllSessions, getSessionVoteDetails, deleteVotingSession, deleteVote, toggleResultsVisible,
  // analytics
  getAnalytics,
  // next meeting
  getNextMeeting, setNextMeeting,
  // announcements
  getAnnouncements, createAnnouncement, updateAnnouncement, deleteAnnouncement,
  // genres
  getGenres, addGenre, updateGenre, deleteGenre,
};
