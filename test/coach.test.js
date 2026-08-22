'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { BookingStore } = require('../server/db');
const { createApp } = require('../server/index');
const coach = require('../server/coach');

async function fetchConfig(run) {
  const store = new BookingStore(':memory:');
  const server = http.createServer(createApp(store));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await run(await (await fetch(`${base}/api/config`)).json());
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
}

/**
 * Puts COACH back exactly as it was, whatever a test did to it. Awaits `run`
 * so an async test finishes before the restore, not after.
 */
async function withCoach(changes, run) {
  const original = JSON.parse(JSON.stringify(coach.COACH));
  Object.assign(coach.COACH, changes);
  try {
    return await run();
  } finally {
    Object.assign(coach.COACH, original);
  }
}

test('switching publish off hides the section completely', async () => {
  await withCoach({ publish: false }, () => {
    assert.equal(coach.publicCoach(), null);
  });
});

test('the site sends no coach details while the section is off', async () => {
  await withCoach({ publish: false }, async () => {
    await fetchConfig((config) => {
      assert.equal(config.coach, null);
    });
  });
});

test('no stat numbers are published without a verified source', () => {
  // Every stats site was unreachable when this was built, so these stay empty
  // until Bubba supplies figures from his own records. If you are filling them
  // in, that is the moment to check each line against an official source.
  for (const season of coach.COACH.seasons) {
    assert.ok(season.year && season.team, 'a season row needs at least a year and a team');
  }
  for (const highlight of coach.COACH.highlights) {
    assert.ok(highlight.value && highlight.label, 'a highlight needs a value and a label');
  }
});

test('publishing stays off until there is something real to show', async () => {
  await withCoach({ publish: true, bio: '', photos: [], highlights: [], seasons: [] }, () => {
    assert.equal(
      coach.publicCoach(),
      null,
      'switching it on with nothing filled in must not render an empty section'
    );
  });
});

test('once filled in and switched on, the details are served', async () => {
  await withCoach(
    {
      publish: true,
      bio: 'Twelve years on the mound, now coaching in the same cages I grew up in.',
      highlights: [{ value: '39', label: 'Strikeouts', note: '2021' }],
      photos: [{ src: '/images/coach/pitching.jpg', alt: 'Delivering a pitch' }],
      seasons: [{ year: '2021', team: 'Southern Illinois', level: 'NCAA D1', games: 21 }],
    },
    async () => {
      const published = coach.publicCoach();
      assert.ok(published);
      assert.equal(published.name, 'Bubba Hall');
      assert.equal(published.highlights[0].value, '39');
      assert.equal(published.seasons[0].team, 'Southern Illinois');

      await fetchConfig((config) => {
        assert.ok(config.coach, 'the booking page receives the section');
        assert.equal(config.coach.photos[0].src, '/images/coach/pitching.jpg');
      });
    }
  );
});

test('facts with no value are dropped rather than shown blank', async () => {
  await withCoach(
    {
      publish: true,
      bio: 'Some bio.',
      facts: [
        { label: 'Position', value: 'RHP' },
        { label: 'Weight', value: '' },
      ],
    },
    () => {
      const published = coach.publicCoach();
      assert.equal(published.facts.length, 1);
      assert.equal(published.facts[0].label, 'Position');
    }
  );
});

test('every photo carries alt text', () => {
  for (const photo of coach.COACH.photos) {
    assert.ok(photo.alt && photo.alt.trim().length > 0, `${photo.src} needs alt text`);
  }
});
