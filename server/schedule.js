'use strict';

const {
  SLOT_MINUTES,
  HOURS,
  CLOSED_DATES,
  BOOKING_WINDOW_DAYS,
  MIN_LEAD_MINUTES,
} = require('./config');

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{1,2}):(\d{2})$/;

/** '15:30' -> 930. Returns null if the string isn't a real clock time. */
function parseTime(value) {
  if (typeof value !== 'string') return null;
  const match = TIME_RE.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** 930 -> '15:30'. */
function toClock(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 930 -> '3:30 PM', for anything a person reads. */
function toDisplayTime(minutes) {
  const h24 = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const suffix = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

/** Splits 'YYYY-MM-DD' and rejects impossible dates like 2026-02-30. */
function parseDate(value) {
  if (typeof value !== 'string') return null;
  const match = DATE_RE.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const asUtc = new Date(Date.UTC(year, month - 1, day));
  if (
    asUtc.getUTCFullYear() !== year ||
    asUtc.getUTCMonth() !== month - 1 ||
    asUtc.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

function isValidDate(value) {
  return parseDate(value) !== null;
}

/** Day of week for a date string, 0 = Sunday. Uses UTC so DST can't shift it. */
function dayOfWeek(dateStr) {
  const parts = parseDate(dateStr);
  if (!parts) return null;
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

/** Local calendar date of `now`, as 'YYYY-MM-DD'. */
function toDateString(now) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(dateStr, count) {
  const parts = parseDate(dateStr);
  if (!parts) return null;
  const shifted = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day + count)
  );
  return shifted.toISOString().slice(0, 10);
}

/** Open windows for a date, as [{ open, close }] in minutes. Empty when closed. */
function windowsForDate(dateStr) {
  if (CLOSED_DATES.includes(dateStr)) return [];
  const weekday = dayOfWeek(dateStr);
  if (weekday === null) return [];
  const windows = HOURS[weekday] || [];
  return windows
    .map((w) => ({ open: parseTime(w.open), close: parseTime(w.close) }))
    .filter((w) => w.open !== null && w.close !== null && w.close > w.open);
}

function isOpenOn(dateStr) {
  return windowsForDate(dateStr).length > 0;
}

/**
 * Every start time on `dateStr` where a `duration`-minute session fits
 * entirely inside one open window.
 */
function candidateStarts(dateStr, duration) {
  const starts = [];
  for (const window of windowsForDate(dateStr)) {
    for (let t = window.open; t + duration <= window.close; t += SLOT_MINUTES) {
      starts.push(t);
    }
  }
  return starts;
}

function overlaps(startA, durationA, startB, durationB) {
  return startA < startB + durationB && startB < startA + durationA;
}

/** First and last date the calendar will accept, inclusive. */
function bookingWindow(now) {
  const first = toDateString(now);
  return { first, last: addDays(first, BOOKING_WINDOW_DAYS) };
}

/**
 * True when `start` on `dateStr` is far enough in the future to book.
 * Past days and same-day slots inside the lead time are rejected.
 */
function isBookable(dateStr, start, now) {
  const today = toDateString(now);
  if (dateStr < today) return false;
  if (dateStr > today) return true;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  return start >= nowMinutes + MIN_LEAD_MINUTES;
}

module.exports = {
  SLOT_MINUTES,
  parseTime,
  toClock,
  toDisplayTime,
  parseDate,
  isValidDate,
  dayOfWeek,
  toDateString,
  addDays,
  windowsForDate,
  isOpenOn,
  candidateStarts,
  overlaps,
  bookingWindow,
  isBookable,
};
