import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export type DB = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  dept TEXT NOT NULL,
  title TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'employee'
);
CREATE TABLE IF NOT EXISTS departments (name TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS places (
  name TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  lng REAL,
  lat REAL
);
CREATE TABLE IF NOT EXISTS geocache (
  address TEXT PRIMARY KEY,
  lng REAL NOT NULL,
  lat REAL NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  draft TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id, updated_at);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  cards TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, id);
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  conversation_id TEXT,
  requester_id TEXT NOT NULL,
  category TEXT NOT NULL,
  subject TEXT,
  start TEXT NOT NULL,
  end TEXT NOT NULL,
  location TEXT,
  attendees TEXT NOT NULL DEFAULT '[]',
  headcount INTEGER,
  visitor TEXT,
  counterpart TEXT,
  note TEXT,
  analysis TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  decision_note TEXT,
  final_start TEXT,
  final_end TEXT,
  event_id TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_req_status ON requests(status, created_at);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  request_id TEXT UNIQUE,
  category TEXT NOT NULL,
  subject TEXT NOT NULL,
  start TEXT NOT NULL,
  end TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  attendees TEXT NOT NULL DEFAULT '[]',
  note TEXT,
  created_by TEXT,
  source TEXT NOT NULL DEFAULT 'request',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_start ON events(start);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  event_id TEXT,
  request_id TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  rsvp TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  read_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_unique ON notifications(user_id, type, COALESCE(event_id, request_id));
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, created_at);
`;

export function openDb(dbPath: string): DB {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  db.exec(SCHEMA);
  return db;
}

/** 同步事务包装（node:sqlite 无内置 transaction helper） */
export function transaction<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const getSetting = (db: DB, key: string, def = ''): string => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? def;
};
export const setSetting = (db: DB, key: string, value: string) => {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
};

export interface Contact {
  id: string;
  name: string;
  dept: string;
  title: string;
  role: 'boss' | 'employee';
}
export const allContacts = (db: DB) => db.prepare('SELECT * FROM contacts ORDER BY rowid').all() as unknown as Contact[];
export const getContact = (db: DB, id: string) => db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as unknown as Contact | undefined;
export const getBoss = (db: DB) => db.prepare("SELECT * FROM contacts WHERE role = 'boss' LIMIT 1").get() as unknown as Contact;

export interface EventRow {
  id: string;
  request_id: string | null;
  category: string;
  subject: string;
  start: string;
  end: string;
  location: string;
  attendees: string;
  note: string | null;
  created_by: string | null;
  source: string;
  created_at: string;
}
export interface RequestRow {
  id: string;
  idempotency_key: string;
  conversation_id: string | null;
  requester_id: string;
  category: string;
  subject: string | null;
  start: string;
  end: string;
  location: string | null;
  attendees: string;
  headcount: number | null;
  visitor: string | null;
  counterpart: string | null;
  note: string | null;
  analysis: string | null;
  /** withdrawn：发起人在老板处理前撤回 */
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  decision_note: string | null;
  final_start: string | null;
  final_end: string | null;
  event_id: string | null;
  created_at: string;
  decided_at: string | null;
}
export interface NotificationRow {
  id: string;
  user_id: string;
  type: 'reminder' | 'invite' | 'request_result';
  event_id: string | null;
  request_id: string | null;
  title: string;
  body: string;
  rsvp: string | null;
  created_at: string;
  delivered_at: string | null;
  read_at: string | null;
}
