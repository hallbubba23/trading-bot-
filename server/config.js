'use strict';

/**
 * All of the knobs a coach is likely to want to change live here.
 * Times are minutes past midnight so slot math never touches a Date object.
 */

const SLOT_MINUTES = 30;

// 0 = Sunday ... 6 = Saturday. A day with no entry is closed.
const HOURS = {
  0: [{ open: '08:00', close: '21:00' }], // Sunday
  1: [{ open: '16:30', close: '21:00' }], // Monday
  2: [{ open: '16:30', close: '21:00' }], // Tuesday
  3: [{ open: '16:30', close: '21:00' }], // Wednesday
  4: [{ open: '16:30', close: '21:00' }], // Thursday
  5: [{ open: '16:30', close: '21:00' }], // Friday
  6: [{ open: '08:00', close: '21:00' }], // Saturday
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

/**
 * What a session costs, in cents, keyed by duration. Add a `byType` entry to
 * charge different rates per training type, e.g. { pitching: 9000 }.
 */
const PRICING = {
  currency: 'usd',
  30: { amount: 4500, byType: {} },
  60: { amount: 8000, byType: {} },
};

function priceFor(durationMinutes, trainingType) {
  const tier = PRICING[durationMinutes];
  if (!tier) return null;
  return tier.byType[trainingType] ?? tier.amount;
}

/**
 * Payment settings. Card payments turn on as soon as STRIPE_SECRET_KEY is set;
 * Zelle turns on as soon as ZELLE_HANDLE is set. With neither configured the
 * site still works and books sessions as pay-at-the-facility.
 */
const PAYMENTS = {
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    // Where Stripe sends people back to. Must be reachable from their phone.
    publicUrl: process.env.PUBLIC_URL || 'http://localhost:3000',
  },
  zelle: {
    // The email or phone number players send money to.
    handle: process.env.ZELLE_HANDLE || '',
    recipientName: process.env.ZELLE_NAME || 'Diamond Time Baseball',
  },
  // How long a slot stays held while we wait for the money.
  holdMinutes: {
    card: 30,
    zelle: Number(process.env.ZELLE_HOLD_HOURS || 12) * 60,
  },
};

function cardEnabled() {
  return Boolean(PAYMENTS.stripe.secretKey);
}

function zelleEnabled() {
  return Boolean(PAYMENTS.zelle.handle);
}

/** With no processor configured we fall back to collecting money in person. */
function paymentsEnabled() {
  return cardEnabled() || zelleEnabled();
}

module.exports = {
  SLOT_MINUTES,
  HOURS,
  TRAINING_TYPES,
  DURATIONS,
  CLOSED_DATES,
  BOOKING_WINDOW_DAYS,
  MIN_LEAD_MINUTES,
  PRICING,
  PAYMENTS,
  priceFor,
  cardEnabled,
  zelleEnabled,
  paymentsEnabled,
};
