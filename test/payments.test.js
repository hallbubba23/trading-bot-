'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { BookingStore } = require('../server/db');
const { dayAvailability } = require('../server/availability');
const schedule = require('../server/schedule');
const payments = require('../server/payments');
const config = require('../server/config');

function upcomingOpenDate(offset = 7) {
  let date = schedule.addDays(schedule.toDateString(new Date()), offset);
  while (!schedule.isOpenOn(date)) date = schedule.addDays(date, 1);
  return date;
}

function heldBooking(overrides = {}) {
  const date = upcomingOpenDate();
  return {
    name: 'Ellis Vance',
    email: 'ellis@example.com',
    phone: '(555) 010-1234',
    date,
    startMinutes: schedule.candidateStarts(date, 60)[0],
    durationMinutes: 60,
    trainingType: 'hitting',
    notes: '',
    amountCents: 8000,
    status: 'pending',
    paymentMethod: 'zelle',
    paymentStatus: 'unpaid',
    ...overrides,
  };
}

/* ---------- pricing ---------- */

test('every session length has a price', () => {
  for (const duration of config.DURATIONS) {
    const amount = config.priceFor(duration.minutes, 'hitting');
    assert.ok(Number.isInteger(amount) && amount > 0, `${duration.minutes} needs a price`);
  }
});

test('a per-type override beats the base price', () => {
  const base = config.priceFor(60, 'hitting');
  config.PRICING[60].byType.pitching = 9500;
  try {
    assert.equal(config.priceFor(60, 'pitching'), 9500);
    assert.equal(config.priceFor(60, 'hitting'), base, 'other types are untouched');
  } finally {
    delete config.PRICING[60].byType.pitching;
  }
});

test('money is formatted for people, not machines', () => {
  assert.equal(payments.formatMoney(8000), '$80.00');
  assert.equal(payments.formatMoney(4500), '$45.00');
});

/* ---------- holds ---------- */

test('an unpaid hold blocks the slot while it is alive', () => {
  const store = new BookingStore(':memory:');
  const request = heldBooking();
  const now = new Date();
  store.create({ ...request, holdExpiresAt: new Date(now.getTime() + 60_000).toISOString() }, now);

  const availability = dayAvailability(store, request.date, 60, now);
  const slot = availability.slots.find(
    (s) => s.startTime === schedule.toClock(request.startMinutes)
  );
  assert.equal(slot.available, false, 'a held slot is not bookable');

  store.close();
});

test('an expired hold frees the slot again', () => {
  const store = new BookingStore(':memory:');
  const request = heldBooking();
  const now = new Date();
  const stale = new Date(now.getTime() - 60_000).toISOString();
  store.create({ ...request, holdExpiresAt: stale }, now);

  const released = store.releaseExpiredHolds(now);
  assert.equal(released, 1);

  const availability = dayAvailability(store, request.date, 60, now);
  const slot = availability.slots.find(
    (s) => s.startTime === schedule.toClock(request.startMinutes)
  );
  assert.equal(slot.available, true, 'the slot is open once the hold lapses');

  store.close();
});

test('a confirmed booking is never swept away', () => {
  const store = new BookingStore(':memory:');
  const now = new Date();
  store.create(
    { ...heldBooking(), status: 'confirmed', paymentStatus: 'paid', holdExpiresAt: null },
    now
  );
  assert.equal(store.releaseExpiredHolds(new Date(now.getTime() + 86_400_000)), 0);
  store.close();
});

test('marking paid confirms the booking and is idempotent', () => {
  const store = new BookingStore(':memory:');
  const now = new Date();
  const { booking } = store.create(
    { ...heldBooking(), holdExpiresAt: new Date(now.getTime() + 60_000).toISOString() },
    now
  );
  assert.equal(booking.status, 'pending');

  const paid = store.markPaid(booking.id, now);
  assert.equal(paid.status, 'confirmed');
  assert.equal(paid.paymentStatus, 'paid');
  assert.ok(paid.paidAt);
  assert.equal(paid.holdExpiresAt, null, 'a paid booking no longer expires');

  // Stripe can deliver the same webhook twice; the second must not change anything.
  const again = store.markPaid(booking.id, new Date(now.getTime() + 5000));
  assert.equal(again.paidAt, paid.paidAt);

  store.close();
});

test('a held slot still blocks a second booking of the same time', () => {
  const store = new BookingStore(':memory:');
  const now = new Date();
  const request = heldBooking();
  store.create({ ...request, holdExpiresAt: new Date(now.getTime() + 60_000).toISOString() }, now);
  const second = store.create({ ...request, holdExpiresAt: null, status: 'confirmed' }, now);
  assert.deepEqual(second, { ok: false, reason: 'conflict' });
  store.close();
});

/* ---------- Stripe form encoding ---------- */

test('nested parameters encode the way Stripe expects', () => {
  const encoded = payments.formEncode({
    mode: 'payment',
    line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: 8000 } }],
    metadata: { bookingId: '7' },
  });
  assert.ok(encoded.includes('mode=payment'));
  assert.ok(encoded.includes('line_items%5B0%5D%5Bquantity%5D=1'));
  assert.ok(encoded.includes('line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=8000'));
  assert.ok(encoded.includes('metadata%5BbookingId%5D=7'));
});

/* ---------- webhook signatures ---------- */

const SECRET = 'whsec_test_secret';

function signedHeader(body, secret = SECRET, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${body}`, 'utf8')
    .digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

test('a correctly signed webhook is accepted', () => {
  const body = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } });
  const event = payments.verifyWebhook(body, signedHeader(body), SECRET);
  assert.equal(event.type, 'checkout.session.completed');
  assert.equal(event.data.object.id, 'cs_1');
});

test('a forged webhook is rejected', () => {
  const body = JSON.stringify({ type: 'checkout.session.completed' });
  const header = signedHeader(body, 'whsec_the_wrong_secret');
  assert.throws(() => payments.verifyWebhook(body, header, SECRET), /Signature mismatch/);
});

test('a tampered body is rejected even with a real signature', () => {
  const body = JSON.stringify({ amount: 100 });
  const header = signedHeader(body, SECRET);
  const tampered = JSON.stringify({ amount: 1 });
  assert.throws(() => payments.verifyWebhook(tampered, header, SECRET), /Signature mismatch/);
});

test('a replayed old webhook is rejected', () => {
  const body = JSON.stringify({ type: 'checkout.session.completed' });
  const old = Math.floor(Date.now() / 1000) - 3600;
  assert.throws(
    () => payments.verifyWebhook(body, signedHeader(body, SECRET, old), SECRET),
    /too old/
  );
});

test('a missing signature or secret is rejected', () => {
  const body = '{}';
  assert.throws(() => payments.verifyWebhook(body, '', SECRET), /Missing signature/);
  assert.throws(() => payments.verifyWebhook(body, signedHeader(body), ''), /No webhook secret/);
});

/* ---------- the Zelle flow over HTTP ---------- */

const http = require('node:http');
const { createApp } = require('../server/index');

async function withZelleServer(run) {
  config.PAYMENTS.zelle.handle = 'coach@diamondtime.example';
  const store = new BookingStore(':memory:');
  const server = http.createServer(createApp(store));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base, store);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    config.PAYMENTS.zelle.handle = '';
  }
}

function bookingBody(overrides = {}) {
  const date = upcomingOpenDate();
  return {
    name: 'Ellis Vance',
    email: 'ellis@example.com',
    phone: '(555) 010-1234',
    date,
    startTime: schedule.toClock(schedule.candidateStarts(date, 60)[0]),
    durationMinutes: 60,
    trainingType: 'hitting',
    paymentMethod: 'zelle',
    ...overrides,
  };
}

const postJson = (base, path, body, headers = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

test('a Zelle booking holds the slot and waits to be confirmed', async () => {
  await withZelleServer(async (base) => {
    const settings = await (await fetch(`${base}/api/config`)).json();
    assert.equal(settings.paymentsEnabled, true);
    assert.deepEqual(settings.paymentOptions.map((o) => o.id), ['zelle']);
    assert.equal(settings.prices.find((p) => p.minutes === 60).amountLabel, '$80.00');

    const body = bookingBody();
    const response = await postJson(base, '/api/bookings', body);
    assert.equal(response.status, 201);
    const created = await response.json();

    assert.equal(created.booking.status, 'pending');
    assert.equal(created.booking.paymentStatus, 'unpaid');
    assert.equal(created.booking.amountLabel, '$80.00');
    assert.equal(created.zelle.handle, 'coach@diamondtime.example');
    assert.equal(created.zelle.memo, created.booking.confirmationCode);
    assert.ok(created.booking.holdExpiresAt, 'the hold has a deadline');

    // The slot is off the calendar while we wait for the money.
    const availability = await (
      await fetch(`${base}/api/availability?date=${body.date}&duration=60`)
    ).json();
    assert.equal(
      availability.slots.find((s) => s.startTime === body.startTime).available,
      false
    );

    // The coach sees it as owing money.
    const listed = await (
      await fetch(`${base}/api/admin/bookings?from=${body.date}&to=${body.date}`, {
        headers: { 'x-admin-token': 'coach' },
      })
    ).json();
    assert.equal(listed.bookings.length, 1);
    assert.equal(listed.bookings[0].paymentStatus, 'unpaid');

    // ...and confirms it by hand once the transfer lands.
    const marked = await postJson(
      base,
      `/api/admin/bookings/${listed.bookings[0].id}/mark-paid`,
      {},
      { 'x-admin-token': 'coach' }
    );
    assert.equal(marked.status, 200);
    const { booking: paid } = await marked.json();
    assert.equal(paid.status, 'confirmed');
    assert.equal(paid.paymentStatus, 'paid');
    assert.ok(paid.paidAt);
  });
});

test('marking paid requires the admin token', async () => {
  await withZelleServer(async (base) => {
    const created = await (await postJson(base, '/api/bookings', bookingBody())).json();
    const listed = await (
      await fetch(`${base}/api/admin/bookings`, { headers: { 'x-admin-token': 'coach' } })
    ).json();
    const id = listed.bookings.find(
      (b) => b.confirmationCode === created.booking.confirmationCode
    ).id;

    const attempt = await postJson(base, `/api/admin/bookings/${id}/mark-paid`, {});
    assert.equal(attempt.status, 401);
  });
});

test('with payments on, a booking must say how it will be paid', async () => {
  await withZelleServer(async (base) => {
    const response = await postJson(base, '/api/bookings', bookingBody({ paymentMethod: '' }));
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.ok(payload.fields.paymentMethod);
  });
});

test('a payment method the site does not offer is refused', async () => {
  await withZelleServer(async (base) => {
    // Stripe is not configured in this test, so card must not be accepted.
    const response = await postJson(base, '/api/bookings', bookingBody({ paymentMethod: 'card' }));
    assert.equal(response.status, 400);
    assert.ok((await response.json()).fields.paymentMethod);
  });
});

test('an abandoned checkout releases the slot on the next look', async () => {
  await withZelleServer(async (base, store) => {
    const body = bookingBody();
    const created = await (await postJson(base, '/api/bookings', body)).json();

    // Wind the hold back into the past, the way an abandoned checkout ages out.
    const booking = store.findByCode(created.booking.confirmationCode);
    store.db
      .prepare('UPDATE bookings SET hold_expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), booking.id);

    const availability = await (
      await fetch(`${base}/api/availability?date=${body.date}&duration=60`)
    ).json();
    assert.equal(
      availability.slots.find((s) => s.startTime === body.startTime).available,
      true,
      'the slot is bookable again'
    );
    assert.equal(store.findByCode(created.booking.confirmationCode), null);
  });
});

/* ---------- Zelle instructions ---------- */

test('Zelle instructions carry the code people must put in the memo', () => {
  config.PAYMENTS.zelle.handle = 'coach@diamondtime.example';
  try {
    const booking = {
      confirmationCode: 'K7M2QP',
      amountCents: 8000,
      holdExpiresAt: '2026-09-01T18:00:00.000Z',
    };
    const instructions = payments.zelleInstructions(booking);
    assert.equal(instructions.memo, 'K7M2QP');
    assert.equal(instructions.amountLabel, '$80.00');
    assert.equal(instructions.handle, 'coach@diamondtime.example');
    assert.ok(instructions.steps.some((step) => step.includes('K7M2QP')));
    assert.ok(instructions.steps.some((step) => step.includes('$80.00')));
  } finally {
    config.PAYMENTS.zelle.handle = '';
  }
});
