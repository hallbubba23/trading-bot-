'use strict';

/**
 * All of the knobs a coach is likely to want to change live here.
 * Times are minutes past midnight so slot math never touches a Date object.
 */

const SLOT_MINUTES = 30;

// 0 = Sunday ... 6 = Saturday. A day with no entry is closed.
const HOURS = {
  1: [{ open: '15:00', close: '20:00' }], // Monday
  2: [{ open: '15:00', close: '20:00' }], // Tuesday
  3: [{ open: '15:00', close: '20:00' }], // Wednesday
  4: [{ open: '15:00', close: '20:00' }], // Thursday
  5: [{ open: '15:00', close: '19:00' }], // Friday
  6: [{ open: '09:00', close: '15:00' }], // Saturday
};

const TRAINING_TYPES = [
  {
    id: 'hitting',
    label: 'Hitting',
    blurb: 'Tee work, soft toss, and live BP in the cage.',
  },
  {
    id: 'pitching',
    label: 'Pitching',
    blurb: 'Mechanics, bullpen work, and command drills off the mound.',
  },
  {
    id: 'fielding',
    label: 'Fielding',
    blurb: 'Infield and outfield reads, footwork, and glove work.',
  },
];

const DURATIONS = [
  { minutes: 30, label: '30 minutes' },
  { minutes: 60, label: '1 hour' },
];

// Dates the facility is closed regardless of the weekly schedule.
const CLOSED_DATES = [
  // '2026-07-04',
];

// How far ahead the calendar lets people book.
const BOOKING_WINDOW_DAYS = 60;

// Minimum lead time before a session can start, in minutes.
const MIN_LEAD_MINUTES = 60;

module.exports = {
  SLOT_MINUTES,
  HOURS,
  TRAINING_TYPES,
  DURATIONS,
  CLOSED_DATES,
  BOOKING_WINDOW_DAYS,
  MIN_LEAD_MINUTES,
};
