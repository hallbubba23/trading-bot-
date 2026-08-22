'use strict';

/**
 * The "Meet your coach" section.
 *
 * ─── READ THIS FIRST ────────────────────────────────────────────────────────
 * `publish` is false, so this whole section is hidden on the site right now.
 * That is deliberate. The draft values below came from a web search and have
 * NOT been checked against an official source, and parents are being asked to
 * pay money on the strength of them. Go through every line, fix what's wrong,
 * add your photos, and only then set `publish: true`.
 *
 * PHOTOS: use pictures you own — ones you or your family took, or that you have
 * permission to use. Do not copy images off a college athletics site, MaxPreps,
 * Perfect Game, or a news article; those belong to the photographer or the
 * school, and this site takes payments, which is exactly the use they act on.
 * Drop files in `public/images/coach/` and list them under `photos` below.
 * ────────────────────────────────────────────────────────────────────────────
 */

const COACH = {
  // Flip to true once every value below is verified and your photos are in.
  publish: false,

  name: 'Bubba Hall',
  // Shown under the name. Keep it to one line.
  tagline: 'Right-handed pitcher',

  // Two or three sentences, in your own voice. This sells the lessons more
  // than the stats do — say who you coach well and what a session is like.
  bio: '',

  // Small facts shown as a row of chips. Delete any you'd rather not post.
  facts: [
    { label: 'Position', value: 'RHP' },
    { label: 'Bats / Throws', value: 'R / R' },
    { label: 'Height', value: "6'1\"" },
    { label: 'Hometown', value: 'Hurley, MS' },
  ],

  // Where you played. Most recent first.
  playedAt: [
    'Dallas Baptist University',
    'Southern Illinois University',
    'Mississippi Gulf Coast Community College',
  ],

  /**
   * The big numbers strip. Pick three or four that actually sell you as a
   * pitching coach — strikeouts, appearances, ERA — not a full stat dump.
   */
  highlights: [
    // { value: '39', label: 'Strikeouts', note: '2021 season' },
  ],

  /**
   * Season-by-season table. Leave empty and the table is skipped entirely.
   * Only the fields you fill in are shown.
   */
  seasons: [
    // {
    //   year: '2021',
    //   team: 'Southern Illinois',
    //   level: 'NCAA D1',
    //   games: 21, wins: 1, losses: 2, saves: 2, strikeouts: 39,
    //   innings: null, era: null,
    // },
  ],

  /**
   * Photos of you. Files go in `public/images/coach/`, and every one needs
   * alt text describing the picture for anyone using a screen reader.
   */
  photos: [
    // { src: '/images/coach/pitching.jpg', alt: 'Bubba Hall delivering a pitch from the mound' },
  ],
};

/** True only when the section is switched on and has something to show. */
function coachSectionReady() {
  if (!COACH.publish) return false;
  return Boolean(
    COACH.bio || COACH.photos.length || COACH.highlights.length || COACH.seasons.length
  );
}

/** What the booking page gets. Returns null while the section is off. */
function publicCoach() {
  if (!coachSectionReady()) return null;
  return {
    name: COACH.name,
    tagline: COACH.tagline,
    bio: COACH.bio,
    facts: COACH.facts.filter((fact) => fact.value),
    playedAt: COACH.playedAt,
    highlights: COACH.highlights,
    seasons: COACH.seasons,
    photos: COACH.photos,
  };
}

module.exports = { COACH, coachSectionReady, publicCoach };
