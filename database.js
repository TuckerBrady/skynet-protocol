'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'skynet.db');

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS overminds (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    UNIQUE NOT NULL COLLATE NOCASE,
      org         TEXT    NOT NULL,
      team        TEXT,
      capabilities TEXT   DEFAULT '[]',
      last_seen   INTEGER,
      created_at  INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS messages (
      id           TEXT PRIMARY KEY,
      from_overmind TEXT NOT NULL,
      to_overmind   TEXT NOT NULL,
      subject       TEXT NOT NULL,
      body          TEXT NOT NULL,
      timestamp     INTEGER NOT NULL,
      status        TEXT DEFAULT 'unread'
        CHECK(status IN ('unread', 'read', 'acknowledged'))
    );
    CREATE TABLE IF NOT EXISTS missions (
      id            TEXT PRIMARY KEY,
      from_overmind TEXT NOT NULL,
      to_overmind   TEXT NOT NULL,
      title         TEXT NOT NULL,
      brief_content TEXT NOT NULL,
      status        TEXT DEFAULT 'dispatched'
        CHECK(status IN ('dispatched', 'in_progress', 'complete', 'failed')),
      passphrase    TEXT,
      created_at    INTEGER DEFAULT (unixepoch()),
      updated_at    INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS results (
      id               TEXT PRIMARY KEY,
      mission_id       TEXT NOT NULL,
      from_overmind    TEXT NOT NULL,
      summary          TEXT NOT NULL,
      deliverables_path TEXT,
      timestamp        INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (mission_id) REFERENCES missions(id)
    );
    CREATE TABLE IF NOT EXISTS tokens (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      token         TEXT    UNIQUE NOT NULL,
      overmind_name TEXT    NOT NULL,
      label         TEXT,
      created_at    INTEGER DEFAULT (unixepoch()),
      last_used     INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_messages_to     ON messages(to_overmind, status);
    CREATE INDEX IF NOT EXISTS idx_messages_from   ON messages(from_overmind);
    CREATE INDEX IF NOT EXISTS idx_missions_to     ON missions(to_overmind, status);
    CREATE INDEX IF NOT EXISTS idx_missions_from   ON missions(from_overmind);
    CREATE INDEX IF NOT EXISTS idx_results_mission ON results(mission_id);
  `);
  console.log('Skynet database initialized at', DB_PATH);
}

module.exports = { db, initDatabase };
