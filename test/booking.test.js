'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { BookingStore } = require('../server/db');
const { validateBooking } = require('../server/validate');
const { dayAvailability } = require('../server/availability');
const schedule = require('../server/schedule');
const { createApp } = require('../server/index');

/** A date a week or so out that the facility is actually open on. */
function upcomingOpenDate(offset = 7) {
  let date = schedule.addDays(schedule.toDateString(new Date()), offset);
  while (!schedule.isOpenOn(date)) date = schedule.addDays(date, 1);
  return date;
}

function validRequest(overrides = {}) {
  const date = upcomingOpenDate();
  const start = schedule.candidateStarts(date, 60)[0];
  return {
    name: 'Ellis Vance',
    email: 'Ellis@Example.com',
    phone: '(555) 010-1234',
    date,
    startTime: schedule.toClock(start),
    durationMinutes: 60,
    trainingType: 'hitting',
    notes: '12u, wants work on inside pitches',
    ...overrides,
  };
}

/* ---------- validation ---------- */

test('a well-formed request passes and is normalized', () => {
  const result = validateBooking(validRequest());
  assert.equal(result.ok, true);
  assert.equal(result.value.email, 'ellis@example.com', 'email is lowercased');
  assert.equal(result.value.phone, '(555) 010-1234', 'phone is reformatted');
  assert.equal(typeof result.value.startMinutes, 'number');
});

test('phone numbers are accepted in whatever shape people type them', () => {
  for (const phone of ['5550101234', '555-010-1234', '+1 (555) 010-1234']) {
    const result = validateBooking(validRequest({ phone }));
    assert.equal(result.ok, true, `${phone} should be accepted`);
    assert.equal(result.value.phone, '(555) 010-1234');
  }
});

test('missing and malformed fields each get their own message', () => {
  const result = validateBooking({});
  assert.equal(result.ok, false);
  for (const field of ['name', 'email', 'phone', 'date', 'startTime', 'trainingType', 'durationMinutes']) {
    assert.ok(result.errors[field], `expected an error for ${field}`);
  }
});

test('only hitting, pitching, and fielding are accepted', () => {
  assert.equal(validateBooking(validRequest({ trainingType: 'baserunning' })).ok, false);
  for (const type of ['hitting', 'pitching', 'fielding']) {
    assert.equal(validateBooking(validRequest({ trainingType: type })).ok, true);
  }
});

test('only 30 and 60 minute sessions are accepted', () => {
  assert.equal(validateBooking(validRequest({ durationMinutes: 45 })).ok, false);
  assert.equal(validateBooking(validRequest({ durationMinutes: 30 })).ok, true);
});

test('a start time outside opening hours is rejected', () => {
  const result = validateBooking(validRequest({ startTime: '03:00' }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.startTime);
});

test('an hour cannot be booked into the last half-hour of the day', () => {
  const date = upcomingOpenDate();
  const lastHalfHourStart = schedule.candidateStarts(date, 30).at(-1);
  const result = validateBooking(
    validRequest({ date, durationMinutes: 60, startTime: schedule.toClock(lastHalfHourStart) })
  );
  assert.equal(result.ok, false, 'a 60 minute session would run past closing');
});

test('dates in the past and beyond the booking window are refused', () => {
  const yesterday = schedule.addDays(schedule.toDateString(new Date()), -1);
  assert.equal(validateBooking(validRequest({ date: yesterday })).ok, false);
  const farOut = schedule.addDays(schedule.toDateString(new Date()), 400);
  assert.equal(validateBooking(validRequest({ date: farOut })).ok, false);
});

/* ---------- store ---------- */

test('a booking blocks the slots it occupies', () => {
  const store = new BookingStore(':memory:');
  const request = validateBooking(validRequest()).value;
  assert.equal(store.create(request).ok, true);

  const availability = dayAvailability(store, request.date, 30);
  const taken = availability.slots.filter((slot) => slot.reason === 'booked');
  assert.equal(taken.length, 2, 'a one hour session covers two 30 minute slots');

  store.close();
});

test('overlapping bookings are refused, adjacent ones are not', () => {
  const store = new BookingStore(':memory:');
  const first = validateBooking(validRequest()).value;
  assert.equal(store.create(first).ok, true);

  const overlapping = { ...first, startMinutes: first.startMinutes + 30 };
  assert.deepEqual(store.create(overlapping), { ok: false, reason: 'conflict' });

  const adjacent = { ...first, startMinutes: first.startMinutes + 60 };
  assert.equal(store.create(adjacent).ok, true);

  store.close();
});

test('lookup requires the code and the matching email', () => {
  const store = new BookingStore(':memory:');
  const { booking } = store.create(validateBooking(validRequest()).value);

  assert.equal(store.findByCode(booking.confirmationCode).email, 'ellis@example.com');
  assert.equal(store.findByCode('NOPE42'), null);

  assert.equal(store.cancel(booking.id), true);
  assert.equal(store.findByCode(booking.confirmationCode), null);

  store.close();
});

/* ---------- HTTP API ---------- */

async function withServer(run) {
  const store = new BookingStore(':memory:');
  const server = http.createServer(createApp(store));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base, store);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
}

const postJson = (base, path, body, headers = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

test('the booking flow works end to end over HTTP', async () => {
  await withServer(async (base) => {
    const config = await (await fetch(`${base}/api/config`)).json();
    assert.deepEqual(
      config.trainingTypes.map((t) => t.id),
      ['hitting', 'pitching', 'fielding']
    );
    assert.deepEqual(config.durations.map((d) => d.minutes), [30, 60]);

    const request = validRequest();
    const created = await postJson(base, '/api/bookings', request);
    assert.equal(created.status, 201);
    const { booking } = await created.json();
    assert.match(booking.confirmationCode, /^[A-Z2-9]{6}$/);
    assert.equal(booking.trainingLabel, 'Hitting');

    // The slot is gone from availability now.
    const availability = await (
      await fetch(`${base}/api/availability?date=${request.date}&duration=60`)
    ).json();
    const slot = availability.slots.find((s) => s.startTime === request.startTime);
    assert.equal(slot.available, false);
    assert.equal(slot.reason, 'booked');

    // Booking it again conflicts.
    const again = await postJson(base, '/api/bookings', request);
    assert.equal(again.status, 409);

    // Lookup needs both halves.
    const wrongEmail = await postJson(base, '/api/bookings/lookup', {
      confirmationCode: booking.confirmationCode,
      email: 'someone@else.com',
    });
    assert.equal(wrongEmail.status, 404);

    const found = await postJson(base, '/api/bookings/lookup', {
      confirmationCode: booking.confirmationCode,
      email: request.email,
    });
    assert.equal(found.status, 200);

    // Cancelling frees the slot.
    const cancelled = await postJson(base, '/api/bookings/cancel', {
      confirmationCode: booking.confirmationCode,
      email: request.email,
    });
    assert.equal(cancelled.status, 200);

    const after = await (
      await fetch(`${base}/api/availability?date=${request.date}&duration=60`)
    ).json();
    assert.equal(after.slots.find((s) => s.startTime === request.startTime).available, true);
  });
});

test('invalid submissions come back with per-field messages', async () => {
  await withServer(async (base) => {
    const response = await postJson(base, '/api/bookings', validRequest({ email: 'nope' }));
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.ok(payload.fields.email);
  });
});

test('the month view reports open counts per day', async () => {
  await withServer(async (base) => {
    const date = upcomingOpenDate();
    const month = date.slice(0, 7);
    const before = await (await fetch(`${base}/api/month?month=${month}&duration=60`)).json();
    const dayBefore = before.days.find((d) => d.date === date);
    assert.ok(dayBefore.openCount > 0);

    await postJson(base, '/api/bookings', validRequest({ date }));

    const after = await (await fetch(`${base}/api/month?month=${month}&duration=60`)).json();
    const dayAfter = after.days.find((d) => d.date === date);
    assert.equal(dayAfter.openCount, dayBefore.openCount - 2, 'an hour removes two starts');
  });
});

test('admin routes require the token', async () => {
  await withServer(async (base) => {
    const unauthorized = await fetch(`${base}/api/admin/bookings`);
    assert.equal(unauthorized.status, 401);

    const wrong = await fetch(`${base}/api/admin/bookings`, {
      headers: { 'x-admin-token': 'guess' },
    });
    assert.equal(wrong.status, 401);

    await postJson(base, '/api/bookings', validRequest());
    const listed = await fetch(`${base}/api/admin/bookings?from=${upcomingOpenDate(0)}&to=${upcomingOpenDate(30)}`, {
      headers: { 'x-admin-token': 'coach' },
    });
    assert.equal(listed.status, 200);
    const { bookings } = await listed.json();
    assert.equal(bookings.length, 1);
    assert.equal(bookings[0].phone, '(555) 010-1234');

    const removed = await fetch(`${base}/api/admin/bookings/${bookings[0].id}`, {
      method: 'DELETE',
      headers: { 'x-admin-token': 'coach' },
    });
    assert.equal(removed.status, 200);
  });
});

test('static files are served and traversal is blocked', async () => {
  await withServer(async (base) => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);

    const admin = await fetch(`${base}/admin`);
    assert.equal(admin.status, 200);

    const escape = await fetch(`${base}/../server/config.js`);
    assert.notEqual(escape.status, 200);
  });
});
