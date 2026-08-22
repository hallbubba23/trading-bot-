'use strict';

const {
  TRAINING_TYPES,
  DURATIONS,
  BOOKING_WINDOW_DAYS,
  cardEnabled,
  zelleEnabled,
  paymentsEnabled,
} = require('./config');
const schedule = require('./schedule');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

const VALID_TYPES = new Set(TRAINING_TYPES.map((t) => t.id));
const VALID_DURATIONS = new Set(DURATIONS.map((d) => d.minutes));

function asString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** Digits only, so '(555) 010-1234' and '555-010-1234' compare equal. */
function normalizePhone(value) {
  const digits = asString(value).replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

function formatPhone(digits) {
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return digits;
}

/**
 * Turns a raw request body into a booking we're willing to store.
 *
 * @returns {{ ok: true, value: object } | { ok: false, errors: Record<string,string> }}
 */
function validateBooking(body, now = new Date()) {
  const errors = {};
  const input = body && typeof body === 'object' ? body : {};

  const name = asString(input.name);
  if (name.length < 2) errors.name = 'Please enter the player’s full name.';
  else if (name.length > 80) errors.name = 'Name is too long (80 characters max).';

  const email = asString(input.email).toLowerCase();
  if (!email) errors.email = 'Please enter an email address.';
  else if (email.length > 120 || !EMAIL_RE.test(email)) {
    errors.email = 'That email address doesn’t look right.';
  }

  const phone = normalizePhone(input.phone);
  if (!phone) errors.phone = 'Please enter a phone number.';
  else if (phone.length < 10 || phone.length > 15) {
    errors.phone = 'Please enter a valid phone number.';
  }

  const trainingType = asString(input.trainingType);
  if (!VALID_TYPES.has(trainingType)) {
    errors.trainingType = 'Choose hitting, pitching, or fielding.';
  }

  const durationMinutes = Number(input.durationMinutes);
  if (!VALID_DURATIONS.has(durationMinutes)) {
    errors.durationMinutes = 'Choose a 30 minute or 1 hour session.';
  }

  const date = asString(input.date);
  const window = schedule.bookingWindow(now);
  if (!schedule.isValidDate(date)) {
    errors.date = 'Pick a date on the calendar.';
  } else if (date < window.first) {
    errors.date = 'That date has already passed.';
  } else if (date > window.last) {
    errors.date = `Bookings open ${BOOKING_WINDOW_DAYS} days ahead.`;
  } else if (!schedule.isOpenOn(date)) {
    errors.date = 'The facility is closed that day.';
  }

  const startMinutes = schedule.parseTime(input.startTime);
  if (startMinutes === null) {
    errors.startTime = 'Pick a start time.';
  } else if (!errors.date && !errors.durationMinutes) {
    const starts = schedule.candidateStarts(date, durationMinutes);
    if (!starts.includes(startMinutes)) {
      errors.startTime = 'That session doesn’t fit in our hours that day.';
    } else if (!schedule.isBookable(date, startMinutes, now)) {
      errors.startTime = 'That start time is too soon — please pick a later slot.';
    }
  }

  const notes = asString(input.notes);
  if (notes.length > 500) errors.notes = 'Notes are limited to 500 characters.';

  // With no processor configured everyone pays at the facility.
  const paymentMethod = paymentsEnabled() ? asString(input.paymentMethod) : 'none';
  if (paymentsEnabled()) {
    const allowed = [cardEnabled() && 'card', zelleEnabled() && 'zelle'].filter(Boolean);
    if (!paymentMethod) errors.paymentMethod = 'Choose how you want to pay.';
    else if (!allowed.includes(paymentMethod)) {
      errors.paymentMethod = 'That payment method isn’t available.';
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      name,
      email,
      phone: formatPhone(phone),
      date,
      startMinutes,
      durationMinutes,
      trainingType,
      notes,
      paymentMethod,
    },
  };
}

module.exports = { validateBooking, normalizePhone, formatPhone };
