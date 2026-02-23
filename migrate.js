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

const SUPERADMIN_EMAIL = (process.env.SUPERADMIN_EMAIL || '').toLowerCase();
const DB_PATH = path.join(__dirname, 'bookclub.json');

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.log('bookclub.json not found — nothing to migrate.');
    process.exit(0);
  }

  // Check if data already exists
  const { rows: existing } = await pool.query('SELECT COUNT(*) AS cnt FROM users').catch(() => ({ rows: [] }));
  if (existing.length && Number(existing[0].cnt) > 0) {
    console.log('Database already has users — skipping migration to avoid duplicates.');
    process.exit(0);
  }

  // Apply schema
  console.log('Applying schema…');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);

  const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  const users          = data.users          || [];
  const bookclubs      = data.bookclubs      || [];
  const user_bookclubs = data.user_bookclubs || [];
  const books          = data.books          || [];
  const voting_sessions= data.voting_sessions|| [];
  const votes          = data.votes          || [];

  // ── Users ──────────────────────────────────────────────────────────────────
  console.log(`Migrating ${users.length} users…`);
  for (const u of users) {
    const role = SUPERADMIN_EMAIL && u.email.toLowerCase() === SUPERADMIN_EMAIL
      ? 'superadmin' : 'member';
    await pool.query(
      `INSERT INTO users (id, name, email, password_hash, role, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [u.id, u.name, u.email, u.password_hash || null, role, u.created_at || new Date().toISOString()]
    );
  }

  // ── Book Clubs ─────────────────────────────────────────────────────────────
  console.log(`Migrating ${bookclubs.length} book clubs…`);
  for (const c of bookclubs) {
    await pool.query(
      `INSERT INTO bookclubs (id, name, description, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [c.id, c.name, c.description || null, c.created_at || new Date().toISOString()]
    );
  }

  // ── Memberships ────────────────────────────────────────────────────────────
  console.log(`Migrating ${user_bookclubs.length} memberships…`);
  for (const m of user_bookclubs) {
    await pool.query(
      `INSERT INTO bookclub_members (user_id, bookclub_id, joined_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, bookclub_id) DO NOTHING`,
      [m.user_id, m.bookclub_id, m.joined_at || new Date().toISOString()]
    );
  }

  // ── Books (skip orphans without bookclub_id) ───────────────────────────────
  const validBooks = books.filter(b => b.bookclub_id != null);
  const skipped    = books.length - validBooks.length;
  console.log(`Migrating ${validBooks.length} books… (${skipped} orphaned skipped)`);
  for (const b of validBooks) {
    await pool.query(
      `INSERT INTO books
         (id, bookclub_id, title, author, genre, cover_url, open_library_id,
          page_count, description, submitted_at, added_at, selected, selected_at,
          active_for_voting, added_by_name, added_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (id) DO NOTHING`,
      [
        b.id, b.bookclub_id, b.title,
        b.author          || null,
        b.genre           || null,
        b.cover_url       || null,
        b.open_library_id || null,
        b.page_count      || null,
        b.description     || null,
        b.submitted_at    || null,
        b.added_at        || new Date().toISOString(),
        !!b.selected,
        b.selected_at     || null,
        b.active_for_voting !== false,
        b.added_by_name    || null,
        b.added_by_user_id || null,
      ]
    );
  }

  // ── Voting Sessions (skip orphans) ─────────────────────────────────────────
  const validSessions = voting_sessions.filter(s => s.bookclub_id != null);
  console.log(`Migrating ${validSessions.length} voting sessions…`);
  for (const s of validSessions) {
    await pool.query(
      `INSERT INTO voting_sessions (id, bookclub_id, is_closed, created_at, closed_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [s.id, s.bookclub_id, !!s.is_closed, s.created_at || new Date().toISOString(), s.closed_at || null]
    );
  }

  // ── Votes ──────────────────────────────────────────────────────────────────
  console.log(`Migrating ${votes.length} votes…`);
  for (const v of votes) {
    await pool.query(
      `INSERT INTO votes (id, session_id, voter_user_id, voter_name, book_id_1, book_id_2, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO NOTHING`,
      [v.id, v.session_id, v.voter_user_id || null, v.voter_name || null,
       v.book_id_1 || null, v.book_id_2 || null, v.created_at || new Date().toISOString()]
    );
  }

  // ── Reset sequences ────────────────────────────────────────────────────────
  console.log('Resetting sequences…');
  const tables = [
    ['users', 'users_id_seq'],
    ['bookclubs', 'bookclubs_id_seq'],
    ['bookclub_members', null],
    ['books', 'books_id_seq'],
    ['voting_sessions', 'voting_sessions_id_seq'],
    ['votes', 'votes_id_seq'],
    ['auth_sessions', 'auth_sessions_id_seq'],
  ];
  for (const [table, seq] of tables) {
    if (!seq) continue;
    await pool.query(
      `SELECT setval('${seq}', COALESCE((SELECT MAX(id) FROM ${table}), 1))`
    );
  }

  console.log('\nMigration complete!');
  console.log(`  Users:    ${users.length}`);
  console.log(`  Clubs:    ${bookclubs.length}`);
  console.log(`  Members:  ${user_bookclubs.length}`);
  console.log(`  Books:    ${validBooks.length}`);
  console.log(`  Sessions: ${validSessions.length}`);
  console.log(`  Votes:    ${votes.length}`);
  await pool.end();
}

main().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
