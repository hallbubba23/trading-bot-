# Diamond Time — Baseball Training Booking Site

A booking website for one-on-one baseball training. Players pick what they want
to work on (**hitting**, **pitching**, or **fielding**), choose a **30 minute**
or **1 hour** session, grab an open slot on the calendar, and enter their name,
email, and phone number. Coaches see the whole schedule on a private dashboard.

No dependencies to install — it runs on Node's built-in HTTP server and its
built-in SQLite. Node 22.5 or newer.

## Running it

```bash
npm start          # http://localhost:3000
npm test           # 26 tests
```

The database file is created automatically at `data/bookings.db`.

| Variable      | Default            | What it does                                 |
| ------------- | ------------------ | -------------------------------------------- |
| `PORT`        | `3000`             | Port to listen on                            |
| `HOST`        | `0.0.0.0`          | Interface to bind                            |
| `ADMIN_TOKEN` | `coach`            | Password for the coach dashboard             |
| `DB_FILE`     | `data/bookings.db` | Where bookings are stored                    |

**Set `ADMIN_TOKEN` to something real before putting this on the internet.**
The server warns on startup while the default is still in use.

## Pages

- **`/`** — the booking page. Session type → length → calendar → time slot →
  contact details. Players get a 6-character confirmation code, and can look up
  or cancel their own session with that code plus their email.
- **`/admin`** — the coach dashboard. Sign in with the admin token to see every
  booking grouped by day, with contact links, notes, session counts, and a
  cancel button. Filter by date range or training type.

## Changing the schedule

Everything a coach is likely to want to change lives in
[`server/config.js`](server/config.js):

- `HOURS` — opening hours per weekday (`0` = Sunday). A day with no entry is
  closed. A day can have multiple windows, e.g. a morning and an evening block.
- `TRAINING_TYPES` — the session types and their descriptions.
- `DURATIONS` — the session lengths offered.
- `CLOSED_DATES` — one-off closures (holidays, tournaments).
- `BOOKING_WINDOW_DAYS` — how far ahead the calendar opens (default 60).
- `MIN_LEAD_MINUTES` — how close to start time same-day booking stays open
  (default 60).
- `SLOT_MINUTES` — the grid the calendar snaps to (default 30).

Restart the server after editing.

## How booking works

Slots are generated from opening hours on a 30-minute grid. A session is offered
only where it fits entirely inside an open window — so a 1-hour session can't
start at 8:30 PM on a day that closes at 9:00 PM, though a 30-minute one can.

Current hours are Monday–Friday 4:30 PM–9:00 PM and Saturday–Sunday
8:00 AM–9:00 PM.

Double-booking is prevented in the database, not just the browser: the conflict
check and the insert share one `BEGIN IMMEDIATE` transaction, so two people
clicking the same slot at the same moment can't both get it. The loser gets a
409 and the calendar refreshes underneath them.

Times are stored as a date string plus minutes-past-midnight rather than
timestamps, so daylight saving can never shift an appointment.

## API

Public:

| Method | Path                     | Purpose                                    |
| ------ | ------------------------ | ------------------------------------------ |
| GET    | `/api/config`            | Training types, lengths, hours, date range |
| GET    | `/api/month`             | Open-slot counts per day (`month`, `duration`) |
| GET    | `/api/availability`      | Slots for one day (`date`, `duration`)     |
| POST   | `/api/bookings`          | Create a booking                           |
| POST   | `/api/bookings/lookup`   | Find a booking (code + email)              |
| POST   | `/api/bookings/cancel`   | Cancel a booking (code + email)            |

Coach-only — send the token as an `X-Admin-Token` header or `Bearer` auth:

| Method | Path                       | Purpose                        |
| ------ | -------------------------- | ------------------------------ |
| GET    | `/api/admin/bookings`      | List bookings (`from`, `to`)   |
| DELETE | `/api/admin/bookings/:id`  | Cancel any booking             |

Invalid submissions come back as `400` with a `fields` object mapping each bad
field to a message the form shows inline.

## Layout

```
server/
  index.js         HTTP server, routes, static files
  config.js        hours, training types, durations  ← edit this
  schedule.js      time math, slot generation, overlap rules
  availability.js  turns bookings + hours into what's open
  validate.js      request validation and normalization
  db.js            SQLite storage
public/
  index.html       booking page
  admin.html       coach dashboard
  app.js  admin.js  styles.css
test/              node:test suites
```

## Worth knowing before going live

- **Email/SMS is not wired up.** Confirmation codes are shown on screen, not
  sent. Add a mail step in `POST /api/bookings` in `server/index.js` if you want
  actual confirmation emails.
- **The admin dashboard is protected by a single shared token**, which is fine
  for one coach and not for a staff of ten. Swap in real accounts if you need
  per-person logins and an audit trail.
- **Put it behind HTTPS.** The admin token is sent on every dashboard request.
- **Back up `data/bookings.db`** — it's the only copy of the schedule.
- Times run in the server's local timezone; run the server in the facility's
  timezone.
