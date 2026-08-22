'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const { overlaps } = require('./schedule');

const DEFAULT_FILE = path.join(__dirname, '..', 'data', 'bookings.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bookings (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT    NOT NULL,
  email             TEXT    NOT NULL,
  phone             TEXT    NOT NULL,
  date              TEXT    NOT NULL,
  start_minutes     INTEGER NOT NULL,
  duration_minutes  INTEGER NOT NULL,
  training_type     TEXT    NOT NULL,
  notes             TEXT    NOT NULL DEFAULT '',
  confirmation_code TEXT    NOT NULL UNIQUE,
  created_at        TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings (date);
`;

// No I, O, 0 or 1 — codes get read aloud over the phone.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newConfirmationCode() {
  const bytes = crypto.randomBytes(6);
  let code = '';
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return code;
}

class BookingStore {
  constructor(file = DEFAULT_FILE) {
    if (file !== ':memory:') {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    }
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  listByDate(date) {
    return this.db
      .prepare('SELECT * FROM bookings WHERE date = ? ORDER BY start_minutes')
      .all(date)
      .map(toBooking);
  }

  listBetween(firstDate, lastDate) {
    return this.db
      .prepare(
        `SELECT * FROM bookings
          WHERE date >= ? AND date <= ?
          ORDER BY date, start_minutes`
      )
      .all(firstDate, lastDate)
      .map(toBooking);
  }

  getById(id) {
    const row = this.db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    return row ? toBooking(row) : null;
  }

  findByCode(code) {
    const row = this.db
      .prepare('SELECT * FROM bookings WHERE confirmation_code = ?')
      .get(String(code).toUpperCase());
    return row ? toBooking(row) : null;
  }

  /**
   * Writes a booking, refusing any request that overlaps one already on the
   * books. The read and the write share one IMMEDIATE transaction so two
   * people clicking the same slot can't both win.
   *
   * @returns {{ ok: true, booking: object } | { ok: false, reason: 'conflict' }}
   */
  create(request) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const sameDay = this.db
        .prepare(
          'SELECT start_minutes, duration_minutes FROM bookings WHERE date = ?'
        )
        .all(request.date);

      const clash = sameDay.some((row) =>
        overlaps(
          request.startMinutes,
          request.durationMinutes,
          row.start_minutes,
          row.duration_minutes
        )
      );
      if (clash) {
        this.db.exec('ROLLBACK');
        return { ok: false, reason: 'conflict' };
      }

      const code = this.#unusedCode();
      const result = this.db
        .prepare(
          `INSERT INTO bookings
             (name, email, phone, date, start_minutes, duration_minutes,
              training_type, notes, confirmation_code, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          request.name,
          request.email,
          request.phone,
          request.date,
          request.startMinutes,
          request.durationMinutes,
          request.trainingType,
          request.notes,
          code,
          new Date().toISOString()
        );
      this.db.exec('COMMIT');
      return { ok: true, booking: this.getById(Number(result.lastInsertRowid)) };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  cancel(id) {
    const result = this.db.prepare('DELETE FROM bookings WHERE id = ?').run(id);
    return result.changes > 0;
  }

  #unusedCode() {
    const exists = this.db.prepare(
      'SELECT 1 FROM bookings WHERE confirmation_code = ?'
    );
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = newConfirmationCode();
      if (!exists.get(code)) return code;
    }
    throw new Error('could not generate an unused confirmation code');
  }
}

function toBooking(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    date: row.date,
    startMinutes: row.start_minutes,
    durationMinutes: row.duration_minutes,
    trainingType: row.training_type,
    notes: row.notes,
    confirmationCode: row.confirmation_code,
    createdAt: row.created_at,
  };
}

module.exports = { BookingStore, DEFAULT_FILE };
