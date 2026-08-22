'use strict';

const crypto = require('node:crypto');

const { PAYMENTS, PRICING } = require('./config');
const schedule = require('./schedule');

const STRIPE_API = 'https://api.stripe.com/v1';

/** 8000 -> '$80.00'. */
function formatMoney(amountCents, currency = PRICING.currency) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(amountCents / 100);
}

/**
 * Stripe takes form-encoded bodies with bracketed nesting, e.g.
 * `line_items[0][price_data][currency]=usd`.
 */
function formEncode(value, prefix = '', out = []) {
  if (value === null || value === undefined) return out;
  if (Array.isArray(value)) {
    value.forEach((item, index) => formEncode(item, `${prefix}[${index}]`, out));
  } else if (typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      formEncode(inner, prefix ? `${prefix}[${key}]` : key, out);
    }
  } else {
    out.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
  }
  return out;
}

async function stripeRequest(path, { method = 'POST', body } = {}) {
  const key = PAYMENTS.stripe.secretKey;
  if (!key) throw Object.assign(new Error('Stripe is not configured.'), { code: 'no_stripe' });

  const response = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
      'stripe-version': '2024-06-20',
    },
    body: body ? formEncode(body).join('&') : undefined,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload.error?.message || `Stripe returned ${response.status}`;
    throw Object.assign(new Error(message), { code: 'stripe_error', status: response.status });
  }
  return payload;
}

/**
 * Opens a Stripe Checkout page for one held booking. Stripe collects the card
 * (and Apple/Google Pay) on its own domain, so no card data ever reaches us.
 */
async function createCheckoutSession(booking, { trainingLabel }) {
  const { publicUrl } = PAYMENTS.stripe;
  const when = `${booking.date} at ${schedule.toDisplayTime(booking.startMinutes)}`;

  const session = await stripeRequest('/checkout/sessions', {
    body: {
      mode: 'payment',
      success_url: `${publicUrl}/?checkout={CHECKOUT_SESSION_ID}`,
      cancel_url: `${publicUrl}/?checkout_cancelled={CHECKOUT_SESSION_ID}`,
      client_reference_id: booking.confirmationCode,
      customer_email: booking.email,
      // Stripe requires 30 minutes minimum; it matches our hold exactly.
      expires_at: Math.floor(Date.now() / 1000) + PAYMENTS.holdMinutes.card * 60,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: PRICING.currency,
            unit_amount: booking.amountCents,
            product_data: {
              name: `${trainingLabel} — ${booking.durationMinutes} minute session`,
              description: `${when} · ${booking.name}`,
            },
          },
        },
      ],
      metadata: {
        bookingId: String(booking.id),
        confirmationCode: booking.confirmationCode,
      },
      payment_intent_data: {
        metadata: {
          bookingId: String(booking.id),
          confirmationCode: booking.confirmationCode,
        },
      },
    },
  });

  return { id: session.id, url: session.url };
}

function retrieveSession(sessionId) {
  return stripeRequest(`/checkout/sessions/${encodeURIComponent(sessionId)}`, { method: 'GET' });
}

/**
 * Checks the `Stripe-Signature` header against the raw request body. Stripe
 * signs `${timestamp}.${body}`, so the body must not be re-serialized first.
 *
 * @returns the parsed event
 * @throws if the signature, secret, or timestamp doesn't check out
 */
function verifyWebhook(rawBody, signatureHeader, secret = PAYMENTS.stripe.webhookSecret, toleranceSeconds = 300) {
  if (!secret) throw Object.assign(new Error('No webhook secret configured.'), { code: 'no_secret' });
  if (!signatureHeader) throw Object.assign(new Error('Missing signature.'), { code: 'bad_signature' });

  const parts = Object.create(null);
  for (const piece of String(signatureHeader).split(',')) {
    const [key, value] = piece.split('=');
    if (!key || !value) continue;
    if (key.trim() === 'v1') (parts.v1 ||= []).push(value.trim());
    else parts[key.trim()] = value.trim();
  }

  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp)) {
    throw Object.assign(new Error('Missing timestamp.'), { code: 'bad_signature' });
  }
  const age = Math.abs(Date.now() / 1000 - timestamp);
  if (age > toleranceSeconds) {
    throw Object.assign(new Error('Signature timestamp is too old.'), { code: 'stale_signature' });
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');

  const supplied = parts.v1 || [];
  const matches = supplied.some((candidate) => {
    const a = Buffer.from(candidate, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
  if (!matches) throw Object.assign(new Error('Signature mismatch.'), { code: 'bad_signature' });

  try {
    return JSON.parse(rawBody);
  } catch {
    throw Object.assign(new Error('Webhook body was not JSON.'), { code: 'bad_payload' });
  }
}

/**
 * What to tell someone paying by Zelle. There is no Zelle merchant API — no
 * way to charge a customer or confirm a transfer programmatically — so the
 * player sends money from their own banking app and the coach confirms it by
 * hand in the dashboard.
 */
function zelleInstructions(booking) {
  const { handle, recipientName } = PAYMENTS.zelle;
  return {
    handle,
    recipientName,
    amount: booking.amountCents,
    amountLabel: formatMoney(booking.amountCents),
    memo: booking.confirmationCode,
    holdExpiresAt: booking.holdExpiresAt,
    steps: [
      `Open your banking app and choose Zelle.`,
      `Send ${formatMoney(booking.amountCents)} to ${handle} (${recipientName}).`,
      `Put your confirmation code ${booking.confirmationCode} in the memo so we can match it.`,
    ],
  };
}

module.exports = {
  formatMoney,
  formEncode,
  createCheckoutSession,
  retrieveSession,
  verifyWebhook,
  zelleInstructions,
};
