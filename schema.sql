CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  google_id     TEXT UNIQUE,
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('superadmin','member')),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  last_login    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id         SERIAL PRIMARY KEY,
  user_id    INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bookclubs (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bookclub_members (
  user_id     INT  NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
  bookclub_id INT  NOT NULL REFERENCES bookclubs(id) ON DELETE CASCADE,
  club_role   TEXT NOT NULL DEFAULT 'member' CHECK (club_role IN ('admin','member')),
  joined_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, bookclub_id)
);

CREATE TABLE IF NOT EXISTS books (
  id               SERIAL PRIMARY KEY,
  bookclub_id      INT  NOT NULL REFERENCES bookclubs(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  author           TEXT,
  genre            TEXT,
  cover_url        TEXT,
  open_library_id  TEXT,
  page_count       INT,
  description      TEXT,
  submitted_at     TIMESTAMPTZ,
  added_at         TIMESTAMPTZ DEFAULT NOW(),
  selected         BOOLEAN DEFAULT FALSE,
  selected_at      TIMESTAMPTZ,
  active_for_voting BOOLEAN DEFAULT TRUE,
  added_by_name    TEXT,
  added_by_user_id INT REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS voting_sessions (
  id          SERIAL PRIMARY KEY,
  bookclub_id INT  NOT NULL REFERENCES bookclubs(id) ON DELETE CASCADE,
  is_closed   BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  closed_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS votes (
  id            SERIAL PRIMARY KEY,
  session_id    INT  NOT NULL REFERENCES voting_sessions(id) ON DELETE CASCADE,
  voter_user_id INT  REFERENCES users(id) ON DELETE SET NULL,
  voter_name    TEXT,
  book_id_1     INT  REFERENCES books(id) ON DELETE CASCADE,
  book_id_2     INT  REFERENCES books(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (session_id, voter_user_id)
);

-- Allow email to be optional (users who sign in via Google only)
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;

-- Book archiving
ALTER TABLE books ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;

-- Configurable voting sessions
ALTER TABLE voting_sessions ADD COLUMN IF NOT EXISTS votes_per_member  INT     NOT NULL DEFAULT 2;
ALTER TABLE voting_sessions ADD COLUMN IF NOT EXISTS results_visible   BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS session_books (
  session_id INT NOT NULL REFERENCES voting_sessions(id) ON DELETE CASCADE,
  book_id    INT NOT NULL REFERENCES books(id)           ON DELETE CASCADE,
  PRIMARY KEY (session_id, book_id)
);

CREATE TABLE IF NOT EXISTS vote_entries (
  id       SERIAL PRIMARY KEY,
  vote_id  INT NOT NULL REFERENCES votes(id) ON DELETE CASCADE,
  book_id  INT REFERENCES books(id) ON DELETE CASCADE,
  UNIQUE (vote_id, book_id)
);

-- Genres (managed by superadmin)
CREATE TABLE IF NOT EXISTS genres (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_genres_name            ON genres(name);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_token    ON auth_sessions(token);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id  ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_bookclub_members_user  ON bookclub_members(user_id);
CREATE INDEX IF NOT EXISTS idx_bookclub_members_club  ON bookclub_members(bookclub_id);
CREATE INDEX IF NOT EXISTS idx_books_bookclub         ON books(bookclub_id);
CREATE INDEX IF NOT EXISTS idx_books_added_by         ON books(added_by_user_id);
CREATE INDEX IF NOT EXISTS idx_voting_sessions_club   ON voting_sessions(bookclub_id);
CREATE INDEX IF NOT EXISTS idx_votes_session          ON votes(session_id);
CREATE INDEX IF NOT EXISTS idx_votes_voter            ON votes(voter_user_id);
CREATE INDEX IF NOT EXISTS idx_users_google_id        ON users(google_id);
CREATE INDEX IF NOT EXISTS idx_session_books_session  ON session_books(session_id);
CREATE INDEX IF NOT EXISTS idx_vote_entries_vote      ON vote_entries(vote_id);
