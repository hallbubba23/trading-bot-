'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const config = require('./config');
const schedule = require('./schedule');
const { BookingStore } = require('./db');
const { validateBooking } = require('./validate');
const { dayAvailability, monthOverview } = require('./availability');
const payments = require('./payments');
const { publicCoach } = require('./coach');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'coach';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY_BYTES = 64 * 1024;

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, message) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(message);
}

/** Collects the request body as a string, capped so a huge POST can't sink us. */
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = (await readRawBody(req)).trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('invalid JSON'), { status: 400 });
  }
}

/** Constant-time compare so the admin token can't be probed a byte at a time. */
function tokenMatches(supplied) {
  const a = Buffer.from(String(supplied || ''));
  const b = Buffer.from(ADMIN_TOKEN);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function isAdmin(req, url) {
  const header = req.headers['x-admin-token'];
  const auth = req.headers.authorization;
  const bearer = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  return tokenMatches(header || bearer || url.searchParams.get('token'));
}

/** Human-readable weekly hours for the info panel. */
function hoursSummary() {
  return DAY_NAMES.map((name, index) => {
    const windows = (config.HOURS[index] || []).map(
      (w) =>
        `${schedule.toDisplayTime(schedule.parseTime(w.open))} – ${schedule.toDisplayTime(
          schedule.parseTime(w.close)
        )}`
    );
    return { day: name, windows };
  });
}

/** Prices the booking page shows next to each session length. */
function priceList() {
  return config.DURATIONS.map((duration) => {
    const amount = config.priceFor(duration.minutes, null);
    return {
      minutes: duration.minutes,
      amountCents: amount,
      amountLabel: payments.formatMoney(amount),
    };
  });
}

function paymentOptions() {
  const options = [];
  if (config.cardEnabled()) {
    options.push({
      id: 'card',
      label: 'Card',
      blurb: 'Visa, Mastercard, Apple Pay, or Google Pay. Confirms instantly.',
    });
  }
  if (config.zelleEnabled()) {
    options.push({
      id: 'zelle',
      label: 'Zelle',
      blurb: `Send from your banking app to ${config.PAYMENTS.zelle.handle}. We confirm once it lands.`,
    });
  }
  return options;
}

function publicBooking(booking) {
  const type = config.TRAINING_TYPES.find((t) => t.id === booking.trainingType);
  return {
    confirmationCode: booking.confirmationCode,
    name: booking.name,
    email: booking.email,
    phone: booking.phone,
    date: booking.date,
    startTime: schedule.toClock(booking.startMinutes),
    startLabel: schedule.toDisplayTime(booking.startMinutes),
    endLabel: schedule.toDisplayTime(booking.startMinutes + booking.durationMinutes),
    durationMinutes: booking.durationMinutes,
    trainingType: booking.trainingType,
    trainingLabel: type ? type.label : booking.trainingType,
    notes: booking.notes,
    status: booking.status,
    paymentMethod: booking.paymentMethod,
    paymentStatus: booking.paymentStatus,
    amountCents: booking.amountCents,
    amountLabel: payments.formatMoney(booking.amountCents),
    holdExpiresAt: booking.holdExpiresAt,
  };
}

function adminBooking(booking) {
  return {
    ...publicBooking(booking),
    id: booking.id,
    createdAt: booking.createdAt,
    paidAt: booking.paidAt,
  };
}

function createApp(store) {
  return async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname } = url;

    try {
      if (pathname.startsWith('/api/')) {
        return await handleApi(store, req, res, url);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendText(res, 405, 'Method not allowed');
      }
      return await serveStatic(res, pathname);
    } catch (error) {
      if (error && error.status) return sendJson(res, error.status, { error: error.message });
      console.error('request failed:', error);
      return sendJson(res, 500, { error: 'Something went wrong on our end.' });
    }
  };
}

async function handleApi(store, req, res, url) {
  const { pathname } = url;
  const now = new Date();

  if (req.method === 'GET' && pathname === '/api/config') {
    const window = schedule.bookingWindow(now);
    return sendJson(res, 200, {
      trainingTypes: config.TRAINING_TYPES,
      durations: config.DURATIONS,
      slotMinutes: config.SLOT_MINUTES,
      hours: hoursSummary(),
      firstDate: window.first,
      lastDate: window.last,
      minLeadMinutes: config.MIN_LEAD_MINUTES,
      prices: priceList(),
      paymentOptions: paymentOptions(),
      paymentsEnabled: config.paymentsEnabled(),
      zelleHoldHours: Math.round(config.PAYMENTS.holdMinutes.zelle / 60),
      // null until the coach section is filled in and switched on.
      coach: publicCoach(),
    });
  }

  if (req.method === 'GET' && pathname === '/api/availability') {
    const date = url.searchParams.get('date') || '';
    const duration = Number(url.searchParams.get('duration'));
    if (!schedule.isValidDate(date)) {
      return sendJson(res, 400, { error: 'A valid date is required (YYYY-MM-DD).' });
    }
    if (!config.DURATIONS.some((d) => d.minutes === duration)) {
      return sendJson(res, 400, { error: 'Unsupported session length.' });
    }
    return sendJson(res, 200, dayAvailability(store, date, duration, now));
  }

  if (req.method === 'GET' && pathname === '/api/month') {
    const month = url.searchParams.get('month') || '';
    const duration = Number(url.searchParams.get('duration'));
    if (!config.DURATIONS.some((d) => d.minutes === duration)) {
      return sendJson(res, 400, { error: 'Unsupported session length.' });
    }
    const overview = monthOverview(store, month, duration, now);
    if (!overview) return sendJson(res, 400, { error: 'A valid month is required (YYYY-MM).' });
    return sendJson(res, 200, overview);
  }

  if (req.method === 'POST' && pathname === '/api/bookings') {
    return createBooking(store, req, res, now);
  }

  // Stripe sends people back here with the session id in the URL. We ask
  // Stripe directly rather than trusting the redirect, so a booking confirms
  // even when the webhook is slow or not configured yet.
  if (req.method === 'GET' && pathname === '/api/checkout') {
    const sessionId = url.searchParams.get('session') || '';
    let booking = store.findBySessionId(sessionId);
    if (!booking) return sendJson(res, 404, { error: 'We could not find that checkout.' });

    if (booking.paymentStatus !== 'paid') {
      try {
        const session = await payments.retrieveSession(sessionId);
        if (session.payment_status === 'paid') booking = store.markPaid(booking.id, now);
      } catch (error) {
        console.error('could not check the Stripe session:', error.message);
      }
    }
    return sendJson(res, 200, { booking: publicBooking(booking) });
  }

  // The player backed out of Stripe Checkout — free the slot straight away
  // instead of making everyone wait for the hold to lapse.
  if (req.method === 'POST' && pathname === '/api/checkout/cancel') {
    const body = await readJsonBody(req);
    const booking = store.findBySessionId(String(body.session || ''));
    if (booking && booking.status === 'pending' && booking.paymentStatus !== 'paid') {
      store.cancel(booking.id);
      return sendJson(res, 200, { released: true });
    }
    return sendJson(res, 200, { released: false });
  }

  if (req.method === 'POST' && pathname === '/api/webhooks/stripe') {
    return stripeWebhook(store, req, res, now);
  }

  if (req.method === 'POST' && pathname === '/api/bookings/lookup') {
    const body = await readJsonBody(req);
    const booking = store.findByCode(String(body.confirmationCode || '').trim());
    // Require both halves so a guessed code alone reveals nothing.
    const emailMatches =
      booking && booking.email === String(body.email || '').trim().toLowerCase();
    if (!booking || !emailMatches) {
      return sendJson(res, 404, {
        error: 'No booking matches that confirmation code and email.',
      });
    }
    return sendJson(res, 200, { booking: publicBooking(booking) });
  }

  if (req.method === 'POST' && pathname === '/api/bookings/cancel') {
    const body = await readJsonBody(req);
    const booking = store.findByCode(String(body.confirmationCode || '').trim());
    const emailMatches =
      booking && booking.email === String(body.email || '').trim().toLowerCase();
    if (!booking || !emailMatches) {
      return sendJson(res, 404, {
        error: 'No booking matches that confirmation code and email.',
      });
    }
    store.cancel(booking.id);
    return sendJson(res, 200, {
      cancelled: publicBooking(booking),
      refundNote:
        booking.paymentStatus === 'paid'
          ? 'Your session is cancelled. Refunds are handled by the coach — we’ll be in touch.'
          : null,
    });
  }

  // ---- Coach-only routes ----------------------------------------------------

  if (pathname.startsWith('/api/admin/')) {
    if (!isAdmin(req, url)) {
      return sendJson(res, 401, { error: 'Admin token required.' });
    }

    if (req.method === 'GET' && pathname === '/api/admin/bookings') {
      const from = url.searchParams.get('from') || schedule.toDateString(now);
      const to = url.searchParams.get('to') || schedule.addDays(from, 30);
      if (!schedule.isValidDate(from) || !schedule.isValidDate(to)) {
        return sendJson(res, 400, { error: 'from and to must be YYYY-MM-DD dates.' });
      }
      const bookings = store.listBetween(from, to, now).map(adminBooking);
      return sendJson(res, 200, { from, to, bookings });
    }

    // Zelle can't be verified automatically, so the coach confirms it here.
    const paidMatch = /^\/api\/admin\/bookings\/(\d+)\/mark-paid$/.exec(pathname);
    if (req.method === 'POST' && paidMatch) {
      const booking = store.markPaid(Number(paidMatch[1]), now);
      if (!booking) return sendJson(res, 404, { error: 'No booking with that id.' });
      return sendJson(res, 200, { booking: adminBooking(booking) });
    }

    const cancelMatch = /^\/api\/admin\/bookings\/(\d+)$/.exec(pathname);
    if (req.method === 'DELETE' && cancelMatch) {
      const removed = store.cancel(Number(cancelMatch[1]));
      if (!removed) return sendJson(res, 404, { error: 'No booking with that id.' });
      return sendJson(res, 200, { ok: true });
    }
  }

  return sendJson(res, 404, { error: 'Unknown endpoint.' });
}

async function createBooking(store, req, res, now) {
  const body = await readJsonBody(req);
  const checked = validateBooking(body, now);
  if (!checked.ok) {
    return sendJson(res, 400, {
      error: 'Please fix the highlighted fields.',
      fields: checked.errors,
    });
  }

  const request = checked.value;
  const amountCents = config.paymentsEnabled()
    ? config.priceFor(request.durationMinutes, request.trainingType)
    : 0;
  const owesMoney = request.paymentMethod !== 'none' && amountCents > 0;
  const holdMinutes =
    request.paymentMethod === 'card'
      ? config.PAYMENTS.holdMinutes.card
      : config.PAYMENTS.holdMinutes.zelle;

  const result = store.create(
    {
      ...request,
      amountCents,
      status: owesMoney ? 'pending' : 'confirmed',
      paymentStatus: 'unpaid',
      holdExpiresAt: owesMoney
        ? new Date(now.getTime() + holdMinutes * 60_000).toISOString()
        : null,
    },
    now
  );

  if (!result.ok) {
    return sendJson(res, 409, {
      error: 'Sorry — that time was just booked by someone else. Please pick another slot.',
    });
  }

  let booking = result.booking;
  const trainingLabel =
    config.TRAINING_TYPES.find((t) => t.id === booking.trainingType)?.label || booking.trainingType;

  if (request.paymentMethod === 'card') {
    try {
      const session = await payments.createCheckoutSession(booking, { trainingLabel });
      booking = store.attachCheckoutSession(booking.id, session.id);
      return sendJson(res, 201, {
        booking: publicBooking(booking),
        checkoutUrl: session.url,
      });
    } catch (error) {
      // Never leave a slot held for a checkout that failed to open.
      store.cancel(booking.id);
      console.error('could not open Stripe Checkout:', error.message);
      return sendJson(res, 502, {
        error: 'We could not open the card payment page. Please try again, or pay by Zelle.',
      });
    }
  }

  if (request.paymentMethod === 'zelle') {
    return sendJson(res, 201, {
      booking: publicBooking(booking),
      zelle: payments.zelleInstructions(booking),
    });
  }

  return sendJson(res, 201, { booking: publicBooking(booking) });
}

async function stripeWebhook(store, req, res, now) {
  const raw = await readRawBody(req);
  let event;
  try {
    event = payments.verifyWebhook(raw, req.headers['stripe-signature']);
  } catch (error) {
    console.error('rejected a Stripe webhook:', error.message);
    return sendJson(res, 400, { error: 'Signature check failed.' });
  }

  const session = event.data?.object || {};
  const bookingId = Number(session.metadata?.bookingId);
  const booking =
    (session.id && store.findBySessionId(session.id)) ||
    (Number.isFinite(bookingId) ? store.getById(bookingId) : null);

  if (booking) {
    if (event.type === 'checkout.session.completed' && session.payment_status === 'paid') {
      store.markPaid(booking.id, now);
      console.log(`payment received for ${booking.confirmationCode}`);
    } else if (event.type === 'checkout.session.expired' && booking.paymentStatus !== 'paid') {
      store.cancel(booking.id);
      console.log(`checkout expired, released ${booking.confirmationCode}`);
    }
  }

  // Always 200 once the signature checks out, so Stripe stops retrying.
  return sendJson(res, 200, { received: true });
}

async function serveStatic(res, pathname) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).slice(1);
  const requested = path.join(PUBLIC_DIR, relative);
  const candidates = path.extname(requested) ? [requested] : [`${requested}.html`, requested];

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
      return sendText(res, 403, 'Forbidden');
    }
    let stats;
    try {
      stats = await fsp.stat(resolved);
    } catch {
      continue;
    }
    if (!stats.isFile()) continue;

    res.writeHead(200, {
      'content-type': CONTENT_TYPES[path.extname(resolved)] || 'application/octet-stream',
      'content-length': stats.size,
      'cache-control': 'no-cache',
    });
    return fs.createReadStream(resolved).pipe(res);
  }

  return sendText(res, 404, 'Not found');
}

function start() {
  const store = new BookingStore(process.env.DB_FILE);
  const server = http.createServer(createApp(store));

  // Sweep lapsed holds on a timer too, so slots reopen even on a quiet site.
  const sweep = setInterval(() => {
    try {
      const released = store.releaseExpiredHolds();
      if (released > 0) console.log(`released ${released} expired hold(s)`);
    } catch (error) {
      console.error('hold sweep failed:', error.message);
    }
  }, 5 * 60_000);
  sweep.unref();

  server.listen(PORT, HOST, () => {
    console.log(`Diamond Time booking site running at http://localhost:${PORT}`);
    console.log(`Coach dashboard: http://localhost:${PORT}/admin`);
    if (ADMIN_TOKEN === 'coach') {
      console.warn('WARNING: using the default admin token. Set ADMIN_TOKEN before going live.');
    }
    const methods = [
      config.cardEnabled() ? 'card (Stripe)' : null,
      config.zelleEnabled() ? 'Zelle' : null,
    ].filter(Boolean);
    console.log(
      methods.length
        ? `Payments: ${methods.join(' and ')}`
        : 'Payments: none configured — sessions book as pay-at-the-facility.'
    );
    if (config.cardEnabled() && !config.PAYMENTS.stripe.webhookSecret) {
      console.warn('WARNING: STRIPE_WEBHOOK_SECRET is not set. Payments still confirm on return from Stripe, but set it before going live.');
    }
  });

  const shutdown = () => {
    clearInterval(sweep);
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
}

if (require.main === module) start();

module.exports = { createApp, start };
