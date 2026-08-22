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
  created_at        TEXT    NOT NULL,
  status            TEXT    NOT NULL DEFAULT 'confirmed',
  payment_method    TEXT    NOT NULL DEFAULT 'none',
  payment_status    TEXT    NOT NULL DEFAULT 'unpaid',
  amount_cents      INTEGER NOT NULL DEFAULT 0,
  stripe_session_id TEXT,
  hold_expires_at   TEXT,
  paid_at           TEXT
);
CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings (date);
CREATE INDEX IF NOT EXISTS idx_bookings_session ON bookings (stripe_session_id);
`;

// Columns added after the first release, for databases created before them.
const ADDED_COLUMNS = {
  status: "TEXT NOT NULL DEFAULT 'confirmed'",
  payment_method: "TEXT NOT NULL DEFAULT 'none'",
  payment_status: "TEXT NOT NULL DEFAULT 'unpaid'",
  amount_cents: 'INTEGER NOT NULL DEFAULT 0',
  stripe_session_id: 'TEXT',
  hold_expires_at: 'TEXT',
  paid_at: 'TEXT',
};

// No I, O, 0 or 1 — codes get read aloud over the phone and typed into a memo.
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
    this.#migrate();
  }

  close() {
    this.db.close();
  }

  /** Adds any column this version expects but an older database file lacks. */
  #migrate() {
    const existing = new Set(
      this.db.prepare('PRAGMA table_info(bookings)').all().map((row) => row.name)
    );
    for (const [column, definition] of Object.entries(ADDED_COLUMNS)) {
      if (!existing.has(column)) {
        this.db.exec(`ALTER TABLE bookings ADD COLUMN ${column} ${definition}`);
      }
    }
  }

  /**
   * Drops unpaid holds whose window has passed, freeing the slot. Called
   * before anything that reads or writes availability, so an abandoned
   * checkout never keeps a time off the calendar.
   *
   * @returns the number of holds released
   */
  releaseExpiredHolds(now = new Date()) {
    const result = this.db
      .prepare(
        `DELETE FROM bookings
          WHERE status = 'pending'
            AND hold_expires_at IS NOT NULL
            AND hold_expires_at < ?`
      )
      .run(now.toISOString());
    return result.changes;
  }

  listByDate(date, now = new Date()) {
    this.releaseExpiredHolds(now);
    return this.db
      .prepare('SELECT * FROM bookings WHERE date = ? ORDER BY start_minutes')
      .all(date)
      .map(toBooking);
  }

  listBetween(firstDate, lastDate, now = new Date()) {
    this.releaseExpiredHolds(now);
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

  findBySessionId(sessionId) {
    const row = this.db
      .prepare('SELECT * FROM bookings WHERE stripe_session_id = ?')
      .get(String(sessionId));
    return row ? toBooking(row) : null;
  }

  /**
   * Writes a booking, refusing any request that overlaps one already on the
   * books. The read and the write share one IMMEDIATE transaction so two
   * people clicking the same slot can't both win.
   *
   * A booking that still owes money goes in as `pending` with a hold expiry;
   * one that owes nothing goes straight to `confirmed`.
   *
   * @returns {{ ok: true, booking: object } | { ok: false, reason: 'conflict' }}
   */
  create(request, now = new Date()) {
    this.releaseExpiredHolds(now);
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
              training_type, notes, confirmation_code, created_at,
              status, payment_method, payment_status, amount_cents,
              hold_expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
          now.toISOString(),
          request.status || 'confirmed',
          request.paymentMethod || 'none',
          request.paymentStatus || 'unpaid',
          request.amountCents || 0,
          request.holdExpiresAt || null
        );
      this.db.exec('COMMIT');
      return { ok: true, booking: this.getById(Number(result.lastInsertRowid)) };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  attachCheckoutSession(id, sessionId) {
    this.db
      .prepare('UPDATE bookings SET stripe_session_id = ? WHERE id = ?')
      .run(sessionId, id);
    return this.getById(id);
  }

  /**
   * Marks a booking paid and confirms it. Idempotent, so a Stripe webhook
   * delivered twice — which Stripe explicitly allows — is harmless.
   */
  markPaid(id, now = new Date()) {
    const booking = this.getById(id);
    if (!booking) return null;
    if (booking.paymentStatus === 'paid') return booking;
    this.db
      .prepare(
        `UPDATE bookings
            SET status = 'confirmed',
                payment_status = 'paid',
                paid_at = ?,
                hold_expires_at = NULL
          WHERE id = ?`
      )
      .run(now.toISOString(), id);
    return this.getById(id);
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
    status: row.status,
    paymentMethod: row.payment_method,
    paymentStatus: row.payment_status,
    amountCents: row.amount_cents,
    stripeSessionId: row.stripe_session_id,
    holdExpiresAt: row.hold_expires_at,
    paidAt: row.paid_at,
  };
}

module.exports = { BookingStore, DEFAULT_FILE };
