'use strict';

/* Coach dashboard: token sign-in, day-by-day schedule, cancel a session. */

const $ = (selector) => document.querySelector(selector);
const STORAGE_KEY = 'diamond-time-admin-token';

let token = '';
let bookings = [];

function formatLongDate(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

function today() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function addDays(dateString, count) {
  const [year, month, day] = dateString.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + count)).toISOString().slice(0, 10);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      'x-admin-token': token,
      ...(options.headers || {}),
    },
  });
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    /* fall through to the status check */
  }
  if (!response.ok) {
    throw Object.assign(new Error(payload.error || 'Request failed'), {
      status: response.status,
    });
  }
  return payload;
}

function readStoredToken() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function storeToken(value) {
  try {
    if (value) window.localStorage.setItem(STORAGE_KEY, value);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* private browsing — the token just won't persist */
  }
}

/* ---------- rendering ---------- */

function renderStats(visible) {
  const totalMinutes = visible.reduce((sum, b) => sum + b.durationMinutes, 0);
  const byType = {};
  for (const booking of visible) {
    byType[booking.trainingLabel] = (byType[booking.trainingLabel] || 0) + 1;
  }
  const breakdown =
    Object.entries(byType)
      .map(([label, count]) => `${count} ${label.toLowerCase()}`)
      .join(' · ') || 'nothing booked yet';

  $('#stats').innerHTML = `
    <div class="stat card"><span class="stat-value"></span><span class="stat-label">Sessions</span></div>
    <div class="stat card"><span class="stat-value"></span><span class="stat-label">Coaching hours</span></div>
    <div class="stat card wide"><span class="stat-value small"></span><span class="stat-label">Breakdown</span></div>
  `;
  const values = document.querySelectorAll('#stats .stat-value');
  values[0].textContent = String(visible.length);
  values[1].textContent = (totalMinutes / 60).toFixed(1);
  values[2].textContent = breakdown;
}

function renderSchedule(visible) {
  const container = $('#schedule');
  container.innerHTML = '';

  if (visible.length === 0) {
    container.innerHTML = '<div class="card"><p class="empty-note">No sessions in this range.</p></div>';
    return;
  }

  const byDate = new Map();
  for (const booking of visible) {
    if (!byDate.has(booking.date)) byDate.set(booking.date, []);
    byDate.get(booking.date).push(booking);
  }

  for (const [date, dayBookings] of byDate) {
    const card = document.createElement('div');
    card.className = 'card day-card';

    const heading = document.createElement('h2');
    heading.textContent = formatLongDate(date);
    const count = document.createElement('span');
    count.className = 'day-count';
    count.textContent = `${dayBookings.length} session${dayBookings.length === 1 ? '' : 's'}`;
    heading.appendChild(count);
    card.appendChild(heading);

    const table = document.createElement('table');
    table.className = 'booking-table';
    table.innerHTML = `
      <thead>
        <tr>
          <th>Time</th><th>Player</th><th>Training</th>
          <th>Contact</th><th>Notes</th><th>Code</th><th></th>
        </tr>
      </thead>
      <tbody></tbody>
    `;
    const body = table.querySelector('tbody');

    for (const booking of dayBookings) {
      const row = document.createElement('tr');

      const cells = [
        `${booking.startLabel} – ${booking.endLabel}`,
        booking.name,
        `${booking.trainingLabel} (${booking.durationMinutes} min)`,
        '',
        booking.notes || '—',
        booking.confirmationCode,
      ];
      for (const value of cells) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.appendChild(cell);
      }

      // Contact cell gets real links rather than plain text.
      const contact = row.children[3];
      const mail = document.createElement('a');
      mail.href = `mailto:${booking.email}`;
      mail.textContent = booking.email;
      const tel = document.createElement('a');
      tel.href = `tel:${booking.phone.replace(/\D/g, '')}`;
      tel.textContent = booking.phone;
      contact.append(mail, document.createElement('br'), tel);

      const actions = document.createElement('td');
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'button danger small';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => cancelBooking(booking));
      actions.appendChild(cancel);
      row.appendChild(actions);

      body.appendChild(row);
    }

    card.appendChild(table);
    container.appendChild(card);
  }
}

function applyFilter() {
  const type = $('#filter-type').value;
  const visible = type ? bookings.filter((b) => b.trainingType === type) : bookings;
  renderStats(visible);
  renderSchedule(visible);
}

/* ---------- actions ---------- */

async function load() {
  const from = $('#from').value || today();
  const to = $('#to').value || addDays(from, 30);
  try {
    const data = await api(`/api/admin/bookings?from=${from}&to=${to}`);
    bookings = data.bookings;
    applyFilter();
  } catch (error) {
    if (error.status === 401) return signOut('That token was not accepted.');
    $('#schedule').innerHTML = '<div class="card"><p class="error"></p></div>';
    $('#schedule .error').textContent = error.message;
  }
}

async function cancelBooking(booking) {
  const when = `${formatLongDate(booking.date)} at ${booking.startLabel}`;
  if (!window.confirm(`Cancel ${booking.name}'s session on ${when}?`)) return;
  try {
    await api(`/api/admin/bookings/${booking.id}`, { method: 'DELETE' });
    bookings = bookings.filter((b) => b.id !== booking.id);
    applyFilter();
  } catch (error) {
    window.alert(error.message);
  }
}

function showDashboard() {
  $('#sign-in').hidden = true;
  $('#dashboard').hidden = false;
  load();
}

function signOut(message = '') {
  token = '';
  storeToken('');
  bookings = [];
  $('#dashboard').hidden = true;
  $('#sign-in').hidden = false;
  $('#token-error').textContent = message;
}

async function signIn(event) {
  event.preventDefault();
  token = $('#token').value.trim();
  $('#token-error').textContent = '';
  if (!token) {
    $('#token-error').textContent = 'Enter the admin token.';
    return;
  }
  try {
    await api(`/api/admin/bookings?from=${today()}&to=${today()}`);
    storeToken(token);
    $('#token').value = '';
    showDashboard();
  } catch (error) {
    signOut(error.status === 401 ? 'That token was not accepted.' : error.message);
  }
}

function init() {
  $('#from').value = today();
  $('#to').value = addDays(today(), 30);

  $('#token-form').addEventListener('submit', signIn);
  $('#refresh').addEventListener('click', load);
  $('#from').addEventListener('change', load);
  $('#to').addEventListener('change', load);
  $('#filter-type').addEventListener('change', applyFilter);
  $('#sign-out').addEventListener('click', (event) => {
    event.preventDefault();
    signOut();
  });

  const stored = readStoredToken();
  if (stored) {
    token = stored;
    showDashboard();
  }
}

init();
