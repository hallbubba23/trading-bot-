'use strict';

const schedule = require('./schedule');

/**
 * Slot list for one day at one session length. Every candidate start is
 * returned — taken ones come back with `available: false` so the calendar can
 * show a full day rather than an empty one.
 */
function dayAvailability(store, date, durationMinutes, now = new Date()) {
  const starts = schedule.candidateStarts(date, durationMinutes);
  const booked = store.listByDate(date);

  const slots = starts.map((start) => {
    const taken = booked.some((b) =>
      schedule.overlaps(start, durationMinutes, b.startMinutes, b.durationMinutes)
    );
    const inFuture = schedule.isBookable(date, start, now);
    return {
      startTime: schedule.toClock(start),
      label: schedule.toDisplayTime(start),
      endLabel: schedule.toDisplayTime(start + durationMinutes),
      available: !taken && inFuture,
      reason: taken ? 'booked' : inFuture ? null : 'past',
    };
  });

  return {
    date,
    durationMinutes,
    open: schedule.isOpenOn(date),
    slots,
    openCount: slots.filter((s) => s.available).length,
  };
}

/**
 * One entry per day of `month` ('YYYY-MM'), used to paint the calendar grid.
 */
function monthOverview(store, month, durationMinutes, now = new Date()) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(month).trim());
  if (!match) return null;
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  if (monthNumber < 1 || monthNumber > 12) return null;

  const dayCount = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const pad = (n) => String(n).padStart(2, '0');
  const first = `${year}-${pad(monthNumber)}-01`;
  const last = `${year}-${pad(monthNumber)}-${pad(dayCount)}`;

  const byDate = new Map();
  for (const booking of store.listBetween(first, last)) {
    if (!byDate.has(booking.date)) byDate.set(booking.date, []);
    byDate.get(booking.date).push(booking);
  }

  const window = schedule.bookingWindow(now);
  const days = [];
  for (let day = 1; day <= dayCount; day += 1) {
    const date = `${year}-${pad(monthNumber)}-${pad(day)}`;
    const starts = schedule.candidateStarts(date, durationMinutes);
    const booked = byDate.get(date) || [];
    const openCount = starts.filter(
      (start) =>
        schedule.isBookable(date, start, now) &&
        !booked.some((b) =>
          schedule.overlaps(start, durationMinutes, b.startMinutes, b.durationMinutes)
        )
    ).length;

    days.push({
      date,
      open: schedule.isOpenOn(date),
      inWindow: date >= window.first && date <= window.last,
      openCount,
    });
  }

  return { month: `${year}-${pad(monthNumber)}`, durationMinutes, days };
}

module.exports = { dayAvailability, monthOverview };
