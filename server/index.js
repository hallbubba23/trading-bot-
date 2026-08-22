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

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'coach';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY_BYTES = 16 * 1024;

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

function readJsonBody(req) {
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
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
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
  };
}

function adminBooking(booking) {
  return { ...publicBooking(booking), id: booking.id, createdAt: booking.createdAt };
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
    const body = await readJsonBody(req);
    const checked = validateBooking(body, now);
    if (!checked.ok) {
      return sendJson(res, 400, {
        error: 'Please fix the highlighted fields.',
        fields: checked.errors,
      });
    }
    const result = store.create(checked.value);
    if (!result.ok) {
      return sendJson(res, 409, {
        error: 'Sorry — that time was just booked by someone else. Please pick another slot.',
      });
    }
    return sendJson(res, 201, { booking: publicBooking(result.booking) });
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
    return sendJson(res, 200, { cancelled: publicBooking(booking) });
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
      const bookings = store.listBetween(from, to).map(adminBooking);
      return sendJson(res, 200, { from, to, bookings });
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

  server.listen(PORT, HOST, () => {
    console.log(`Diamond Time booking site running at http://localhost:${PORT}`);
    console.log(`Coach dashboard: http://localhost:${PORT}/admin`);
    if (ADMIN_TOKEN === 'coach') {
      console.warn('WARNING: using the default admin token. Set ADMIN_TOKEN before going live.');
    }
  });

  const shutdown = () => {
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
