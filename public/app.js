'use strict';

/* Booking page: session type -> calendar -> time slot -> contact details. */

const state = {
  config: null,
  trainingType: null,
  durationMinutes: null,
  month: null, // 'YYYY-MM'
  date: null, // 'YYYY-MM-DD'
  startTime: null, // '15:30'
  paymentMethod: null, // 'card' | 'zelle' | null when payments are off
  slots: [],
  submitting: false,
};

const $ = (selector) => document.querySelector(selector);
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/* ---------- helpers ---------- */

/** Parses 'YYYY-MM-DD' as a UTC date so no timezone can shift the day. */
function dateFromString(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function formatLongDate(value) {
  return dateFromString(value).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

function monthOf(dateString) {
  return dateString.slice(0, 7);
}

function shiftMonth(month, delta) {
  const [year, monthNumber] = month.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, monthNumber - 1 + delta, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    /* a non-JSON body means we fall back to the status code below */
  }
  if (!response.ok) {
    throw Object.assign(new Error(payload.error || 'Request failed'), {
      status: response.status,
      fields: payload.fields || {},
    });
  }
  return payload;
}

/* ---------- step 1: session type and length ---------- */

function renderTrainingTypes() {
  const container = $('#training-types');
  container.innerHTML = '';
  for (const type of state.config.trainingTypes) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'choice';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(state.trainingType === type.id));
    button.innerHTML = `<strong></strong><span></span>`;
    button.querySelector('strong').textContent = type.label;
    button.querySelector('span').textContent = type.blurb;
    button.addEventListener('click', () => {
      state.trainingType = type.id;
      renderTrainingTypes();
      updateSummary();
    });
    container.appendChild(button);
  }
}

function priceFor(minutes) {
  const price = (state.config.prices || []).find((p) => p.minutes === minutes);
  return price ? price.amountLabel : null;
}

function renderDurations() {
  const container = $('#durations');
  container.innerHTML = '';
  for (const duration of state.config.durations) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'choice';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(state.durationMinutes === duration.minutes));
    button.innerHTML = `<strong></strong><span class="price"></span>`;
    button.querySelector('strong').textContent = duration.label;
    const price = state.config.paymentsEnabled ? priceFor(duration.minutes) : null;
    if (price) button.querySelector('.price').textContent = price;
    button.addEventListener('click', async () => {
      if (state.durationMinutes === duration.minutes) return;
      state.durationMinutes = duration.minutes;
      // A longer session can invalidate the chosen slot, so re-check the day.
      state.startTime = null;
      renderDurations();
      await renderCalendar();
      if (state.date) await selectDate(state.date);
      updateSummary();
    });
    container.appendChild(button);
  }
}

function renderPaymentMethods() {
  const options = state.config.paymentOptions || [];
  const section = $('#payment-section');
  if (options.length === 0) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  if (options.length === 1) state.paymentMethod = options[0].id;

  const container = $('#payment-methods');
  container.innerHTML = '';
  for (const option of options) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'choice';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(state.paymentMethod === option.id));
    button.innerHTML = `<strong></strong><span></span>`;
    button.querySelector('strong').textContent = option.label;
    button.querySelector('span').textContent = option.blurb;
    button.addEventListener('click', () => {
      state.paymentMethod = option.id;
      renderPaymentMethods();
      updateSummary();
    });
    container.appendChild(button);
  }
}

/* ---------- step 2: calendar and slots ---------- */

async function renderCalendar() {
  const grid = $('#calendar');
  const [year, monthNumber] = state.month.split('-').map(Number);
  $('#month-label').textContent = `${MONTH_NAMES[monthNumber - 1]} ${year}`;

  const firstMonth = monthOf(state.config.firstDate);
  const lastMonth = monthOf(state.config.lastDate);
  $('#prev-month').disabled = state.month <= firstMonth;
  $('#next-month').disabled = state.month >= lastMonth;

  let overview;
  try {
    overview = await api(
      `/api/month?month=${state.month}&duration=${state.durationMinutes}`
    );
  } catch {
    grid.innerHTML = '<p class="empty-note">Could not load the calendar. Please refresh.</p>';
    return;
  }

  grid.innerHTML = '';
  const leadingBlanks = dateFromString(overview.days[0].date).getUTCDay();
  for (let i = 0; i < leadingBlanks; i += 1) {
    const blank = document.createElement('div');
    blank.className = 'day empty';
    grid.appendChild(blank);
  }

  const today = state.config.firstDate;
  for (const day of overview.days) {
    const bookable = day.open && day.inWindow && day.openCount > 0;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'day';
    button.dataset.date = day.date;
    button.disabled = !bookable;
    button.setAttribute('aria-pressed', String(state.date === day.date));
    if (bookable) button.classList.add('has-openings');
    else button.classList.add('unavailable');
    if (day.date === today) button.classList.add('today');

    const label = day.open
      ? `${day.openCount} open ${day.openCount === 1 ? 'slot' : 'slots'}`
      : 'closed';
    button.setAttribute('aria-label', `${formatLongDate(day.date)}, ${label}`);
    button.innerHTML = `<span></span><i class="dot"></i>`;
    button.querySelector('span').textContent = String(Number(day.date.slice(8)));
    if (!bookable) button.querySelector('.dot').style.visibility = 'hidden';

    button.addEventListener('click', () => selectDate(day.date));
    grid.appendChild(button);
  }
}

async function selectDate(date) {
  state.date = date;
  state.startTime = null;
  document.querySelectorAll('#calendar .day').forEach((day) => {
    day.setAttribute('aria-pressed', String(day.dataset.date === date));
  });

  const grid = $('#slot-grid');
  $('#slots-title').textContent = `Open times on ${formatLongDate(date)}`;
  grid.innerHTML = '<p class="empty-note">Loading times…</p>';

  let availability;
  try {
    availability = await api(
      `/api/availability?date=${date}&duration=${state.durationMinutes}`
    );
  } catch {
    grid.innerHTML = '<p class="empty-note">Could not load times. Please try again.</p>';
    return;
  }

  state.slots = availability.slots;
  renderSlots();
  updateSummary();
}

function renderSlots() {
  const grid = $('#slot-grid');
  grid.innerHTML = '';
  const openSlots = state.slots.filter((slot) => slot.available);

  if (openSlots.length === 0) {
    const note = document.createElement('p');
    note.className = 'empty-note';
    note.textContent =
      state.slots.length === 0
        ? 'We are closed that day — please pick another date.'
        : 'Every slot that day is taken. Try another date or a shorter session.';
    grid.appendChild(note);
    return;
  }

  for (const slot of state.slots) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'slot';
    button.disabled = !slot.available;
    button.textContent = slot.label;
    button.title = `${slot.label} – ${slot.endLabel}`;
    button.setAttribute('aria-pressed', String(state.startTime === slot.startTime));
    button.addEventListener('click', () => {
      state.startTime = slot.startTime;
      renderSlots();
      updateSummary();
    });
    grid.appendChild(button);
  }
}

/* ---------- summary rail and step markers ---------- */

function submitLabel(price) {
  if (state.paymentMethod === 'card') return price ? `Pay ${price} and book` : 'Continue to payment';
  if (state.paymentMethod === 'zelle') return 'Hold my slot';
  return 'Confirm booking';
}

function updateSummary() {
  const type = state.config.trainingTypes.find((t) => t.id === state.trainingType);
  const duration = state.config.durations.find((d) => d.minutes === state.durationMinutes);
  const slot = state.slots.find((s) => s.startTime === state.startTime);

  $('#sum-training').textContent = type ? type.label : '—';
  $('#sum-duration').textContent = duration ? duration.label : '—';
  $('#sum-date').textContent = state.date ? formatLongDate(state.date) : '—';
  $('#sum-time').textContent = slot ? `${slot.label} – ${slot.endLabel}` : '—';

  const price = state.config.paymentsEnabled ? priceFor(state.durationMinutes) : null;
  $('#sum-total-row').hidden = !price;
  $('#sum-total').textContent = price || '—';

  const needsPayment = (state.config.paymentOptions || []).length > 0;
  const picked = Boolean(state.trainingType && state.durationMinutes && state.date && state.startTime);
  const ready = picked && (!needsPayment || Boolean(state.paymentMethod));

  $('#submit-button').disabled = !ready || state.submitting;
  if (!state.submitting) $('#submit-button').textContent = submitLabel(price);

  $('#summary-hint').textContent = ready
    ? 'Fill in your details and confirm.'
    : !state.trainingType || !state.durationMinutes
      ? 'Pick a session type and length to get started.'
      : !state.startTime
        ? 'Choose a date and time on the calendar.'
        : 'Choose how you want to pay.';

  const stepOne = Boolean(state.trainingType && state.durationMinutes);
  document.querySelector('.step[data-step="1"]').classList.toggle('done', stepOne);
  document.querySelector('.step[data-step="2"]').classList.toggle('done', Boolean(state.startTime));
  document.querySelector('.step[data-step="3"]').classList.toggle('done', false);
}

function renderHours() {
  const list = $('#hours-list');
  list.innerHTML = '';
  for (const entry of state.config.hours) {
    const item = document.createElement('li');
    const day = document.createElement('span');
    day.textContent = entry.day;
    const times = document.createElement('span');
    if (entry.windows.length === 0) {
      times.textContent = 'Closed';
      times.className = 'closed';
    } else {
      times.textContent = entry.windows.join(', ');
    }
    item.append(day, times);
    list.appendChild(item);
  }
  const lead = state.config.minLeadMinutes;
  $('#lead-hint').textContent =
    lead >= 60
      ? `Same-day bookings close ${lead / 60} hour${lead === 60 ? '' : 's'} before start time.`
      : `Same-day bookings close ${lead} minutes before start time.`;
}

/* ---------- step 3: submit ---------- */

function clearFieldErrors() {
  document.querySelectorAll('[data-error-for]').forEach((node) => {
    node.textContent = '';
  });
  document.querySelectorAll('#booking-form input').forEach((input) => {
    input.classList.remove('invalid');
  });
  $('#form-error').textContent = '';
}

function showFieldErrors(fields) {
  for (const [name, message] of Object.entries(fields)) {
    const target = document.querySelector(`[data-error-for="${name}"]`);
    if (target) target.textContent = message;
    const input = document.getElementById(name);
    if (input) input.classList.add('invalid');
  }
}

async function submitBooking(event) {
  event.preventDefault();
  if (state.submitting) return;
  clearFieldErrors();

  state.submitting = true;
  $('#submit-button').disabled = true;
  $('#submit-button').textContent =
    state.paymentMethod === 'card' ? 'Opening payment…' : 'Booking…';

  const payload = {
    name: $('#name').value,
    email: $('#email').value,
    phone: $('#phone').value,
    notes: $('#notes').value,
    date: state.date,
    startTime: state.startTime,
    durationMinutes: state.durationMinutes,
    trainingType: state.trainingType,
    paymentMethod: state.paymentMethod,
  };

  try {
    const result = await api('/api/bookings', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    // Card payments finish on Stripe's own page.
    if (result.checkoutUrl) {
      window.location.assign(result.checkoutUrl);
      return;
    }

    showConfirmation(result.booking, result.zelle);
    $('#booking-form').reset();
    state.startTime = null;
    await renderCalendar();
    if (state.date) await selectDate(state.date);
  } catch (error) {
    if (error.fields && Object.keys(error.fields).length > 0) showFieldErrors(error.fields);
    $('#form-error').textContent = error.message;
    if (error.status === 409) {
      // Someone else took the slot — refresh so the grid tells the truth.
      state.startTime = null;
      await renderCalendar();
      if (state.date) await selectDate(state.date);
    }
  } finally {
    state.submitting = false;
    updateSummary();
  }
}

function formatHoldDeadline(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function showConfirmation(booking, zelle) {
  const paid = booking.paymentStatus === 'paid';
  const awaitingZelle = booking.status === 'pending' && booking.paymentMethod === 'zelle';

  $('#confirm-title').textContent = awaitingZelle
    ? 'Your slot is held'
    : "You're on the schedule!";

  $('#confirm-copy').textContent =
    `${booking.trainingLabel} · ${booking.durationMinutes} minutes · ` +
    `${formatLongDate(booking.date)} at ${booking.startLabel}` +
    (paid ? ` · ${booking.amountLabel} paid.` : '.');

  $('#confirm-code').textContent = booking.confirmationCode;

  const box = $('#zelle-box');
  box.hidden = !zelle;
  if (zelle) {
    $('#zelle-amount').textContent = zelle.amountLabel;
    $('#zelle-handle').textContent = zelle.handle;
    const steps = $('#zelle-steps');
    steps.innerHTML = '';
    for (const step of zelle.steps) {
      const item = document.createElement('li');
      item.textContent = step;
      steps.appendChild(item);
    }
    $('#zelle-hold').textContent =
      `We'll hold this time until ${formatHoldDeadline(zelle.holdExpiresAt)}. ` +
      `If the payment hasn't arrived by then, the slot reopens.`;
  }

  $('#confirm-hint').textContent = awaitingZelle
    ? 'Put the code in the Zelle memo so we can match your payment to this booking.'
    : "Save this code — you'll need it (plus your email) to look up or cancel the session.";

  const modal = $('#confirm-modal');
  modal.hidden = false;
  $('#confirm-close').focus();
}

/**
 * Stripe sends people back here after checkout. We ask our own server what
 * actually happened rather than trusting the URL.
 */
async function handleCheckoutReturn() {
  const params = new URLSearchParams(window.location.search);
  const completed = params.get('checkout');
  const cancelled = params.get('checkout_cancelled');
  if (!completed && !cancelled) return;

  // Drop the query string so a refresh doesn't replay this.
  window.history.replaceState({}, '', window.location.pathname + '#book');

  if (cancelled) {
    await api('/api/checkout/cancel', {
      method: 'POST',
      body: JSON.stringify({ session: cancelled }),
    }).catch(() => {});
    $('#form-error').textContent =
      'Payment was cancelled, so we released that slot. Pick a time to try again.';
    return;
  }

  try {
    const { booking } = await api(`/api/checkout?session=${encodeURIComponent(completed)}`);
    showConfirmation(booking);
  } catch (error) {
    $('#form-error').textContent = error.message;
  }
}

/* ---------- lookup and cancel ---------- */

let lookedUp = null;

async function lookupBooking(event) {
  event.preventDefault();
  $('#lookup-error').textContent = '';
  const body = JSON.stringify({
    confirmationCode: $('#lookup-code').value,
    email: $('#lookup-email').value,
  });
  try {
    const { booking } = await api('/api/bookings/lookup', { method: 'POST', body });
    lookedUp = booking;
    const result = $('#lookup-result');
    result.hidden = false;
    result.innerHTML = '<strong></strong><span></span>';
    result.querySelector('strong').textContent = `${booking.trainingLabel} session — ${booking.name}`;
    const payment =
      booking.paymentStatus === 'paid'
        ? ` · ${booking.amountLabel} paid`
        : booking.status === 'pending'
          ? ` · ${booking.amountLabel} due — awaiting payment`
          : '';
    result.querySelector('span').textContent =
      `${formatLongDate(booking.date)} · ${booking.startLabel} – ${booking.endLabel} ` +
      `(${booking.durationMinutes} min) · ${booking.phone}${payment}`;
    $('#cancel-button').hidden = false;
  } catch (error) {
    lookedUp = null;
    $('#lookup-result').hidden = true;
    $('#cancel-button').hidden = true;
    $('#lookup-error').textContent = error.message;
  }
}

async function cancelBooking() {
  if (!lookedUp) return;
  if (!window.confirm('Cancel this session? This cannot be undone.')) return;
  try {
    await api('/api/bookings/cancel', {
      method: 'POST',
      body: JSON.stringify({
        confirmationCode: lookedUp.confirmationCode,
        email: lookedUp.email,
      }),
    });
    const result = $('#lookup-result');
    result.innerHTML = '<strong>Booking cancelled.</strong><span>That time is open again.</span>';
    $('#cancel-button').hidden = true;
    lookedUp = null;
    await renderCalendar();
    if (state.date) await selectDate(state.date);
  } catch (error) {
    $('#lookup-error').textContent = error.message;
  }
}

/* ---------- boot ---------- */

async function init() {
  state.config = await api('/api/config');
  state.durationMinutes = state.config.durations[0].minutes;
  state.month = monthOf(state.config.firstDate);

  renderTrainingTypes();
  renderDurations();
  renderPaymentMethods();
  renderHours();
  await renderCalendar();
  updateSummary();
  await handleCheckoutReturn();

  $('#prev-month').addEventListener('click', async () => {
    state.month = shiftMonth(state.month, -1);
    await renderCalendar();
  });
  $('#next-month').addEventListener('click', async () => {
    state.month = shiftMonth(state.month, 1);
    await renderCalendar();
  });
  $('#booking-form').addEventListener('submit', submitBooking);
  $('#lookup-form').addEventListener('submit', lookupBooking);
  $('#cancel-button').addEventListener('click', cancelBooking);

  const modal = $('#confirm-modal');
  $('#confirm-close').addEventListener('click', () => {
    modal.hidden = true;
  });
  modal.addEventListener('click', (event) => {
    if (event.target === modal) modal.hidden = true;
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !modal.hidden) modal.hidden = true;
  });
}

init().catch((error) => {
  console.error(error);
  document.querySelector('#book').insertAdjacentHTML(
    'afterbegin',
    '<p class="error">Could not reach the booking service. Please refresh the page.</p>'
  );
});
