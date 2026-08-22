'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const schedule = require('../server/schedule');

test('parseTime accepts clock times and rejects junk', () => {
  assert.equal(schedule.parseTime('15:30'), 930);
  assert.equal(schedule.parseTime('9:05'), 545);
  assert.equal(schedule.parseTime('24:00'), null);
  assert.equal(schedule.parseTime('15:60'), null);
  assert.equal(schedule.parseTime('half past three'), null);
});

test('display times read the way a person says them', () => {
  assert.equal(schedule.toDisplayTime(0), '12:00 AM');
  assert.equal(schedule.toDisplayTime(720), '12:00 PM');
  assert.equal(schedule.toDisplayTime(930), '3:30 PM');
});

test('parseDate rejects days that do not exist', () => {
  assert.deepEqual(schedule.parseDate('2026-02-28'), { year: 2026, month: 2, day: 28 });
  assert.equal(schedule.parseDate('2026-02-30'), null);
  assert.equal(schedule.parseDate('2026-13-01'), null);
  assert.equal(schedule.parseDate('06/01/2026'), null);
});

test('dayOfWeek is stable regardless of local timezone', () => {
  assert.equal(schedule.dayOfWeek('2026-08-24'), 1); // a Monday
  assert.equal(schedule.dayOfWeek('2026-08-23'), 0); // a Sunday
});

test('Sunday is closed and weekdays are open', () => {
  assert.equal(schedule.isOpenOn('2026-08-23'), false);
  assert.equal(schedule.isOpenOn('2026-08-24'), true);
});

test('candidate starts fit the session inside opening hours', () => {
  // Monday: 15:00–20:00.
  const halfHour = schedule.candidateStarts('2026-08-24', 30);
  assert.equal(halfHour[0], 15 * 60);
  assert.equal(halfHour.at(-1), 19 * 60 + 30);

  const fullHour = schedule.candidateStarts('2026-08-24', 60);
  assert.equal(fullHour.at(-1), 19 * 60, 'an hour cannot start at 19:30 when we close at 20:00');
});

test('a closed day offers no starts', () => {
  assert.deepEqual(schedule.candidateStarts('2026-08-23', 30), []);
});

test('overlap is half-open, so back-to-back sessions are fine', () => {
  assert.equal(schedule.overlaps(900, 60, 960, 30), false); // 15:00-16:00 vs 16:00-16:30
  assert.equal(schedule.overlaps(900, 60, 930, 30), true); // 15:00-16:00 vs 15:30-16:00
  assert.equal(schedule.overlaps(930, 30, 900, 60), true);
});

test('lead time blocks slots that start too soon today', () => {
  const now = new Date('2026-08-24T16:00:00');
  assert.equal(schedule.isBookable('2026-08-24', 16 * 60 + 30, now), false, 'inside the lead time');
  assert.equal(schedule.isBookable('2026-08-24', 17 * 60, now), true, 'exactly one hour out');
  assert.equal(schedule.isBookable('2026-08-23', 18 * 60, now), false, 'yesterday');
  assert.equal(schedule.isBookable('2026-08-25', 9 * 60, now), true, 'tomorrow');
});

test('addDays crosses month boundaries', () => {
  assert.equal(schedule.addDays('2026-08-31', 1), '2026-09-01');
  assert.equal(schedule.addDays('2026-03-01', -1), '2026-02-28');
});
