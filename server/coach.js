'use strict';

/**
 * The "Meet your coach" section.
 *
 * ─── WHAT'S CONFIRMED AND WHAT ISN'T ────────────────────────────────────────
 * Confirmed by Bubba: the career path — Mississippi Gulf Coast, Southern
 * Illinois, Dallas Baptist, then the Washington Nationals organization. That
 * is what `playedAt`, `tagline` and `bio` are built from, and it is live.
 *
 * NOT confirmed: the physical details in `facts` came from a web search, not
 * from him. Check height, hometown and bats/throws and correct them.
 *
 * Deliberately empty: `highlights` and `seasons`. Every stats site was
 * unreachable, so no numbers here would be better than a plausible guess on a
 * page that takes payments. Fill them in from your own records — see the
 * drafts at the bottom of this file for the shape.
 *
 * PHOTOS: use pictures you own — ones you or your family took, or that you have
 * permission to use. Do not copy images off a college athletics site, MaxPreps,
 * Perfect Game, or a news article; those belong to the photographer or the
 * school, and this site takes payments, which is exactly the use they act on.
 * Drop files in `public/images/coach/` and list them under `photos` below.
 * ────────────────────────────────────────────────────────────────────────────
 */

const COACH = {
  publish: true,

  name: 'Bubba Hall',
  // Shown under the name. Keep it to one line.
  tagline: 'Right-handed pitcher · Washington Nationals organization',

  // Rewrite this in your own voice — it sells lessons harder than stats do.
  bio:
    'I pitched at Mississippi Gulf Coast Community College and Southern Illinois ' +
    'before finishing at Dallas Baptist, then signed with the Washington Nationals ' +
    'in 2022 and pitched in their system through 2025. I coach the things I spent ' +
    'those years working on: repeatable mechanics, command you can trust under ' +
    'pressure, and the part between the ears that nobody drills.',

  // Small facts shown as a row of chips. VERIFY THESE — they came from a search.
  facts: [
    { label: 'Position', value: 'RHP' },
    { label: 'Bats / Throws', value: 'R / R' },
    { label: 'Height', value: "6'1\"" },
    { label: 'Hometown', value: 'Hurley, MS' },
  ],

  // Where you played. Most recent first.
  playedAt: [
    'Washington Nationals organization',
    'Dallas Baptist University',
    'Southern Illinois University',
    'Mississippi Gulf Coast Community College',
  ],

  /**
   * The big numbers strip — three or four that sell you as a coach, not a full
   * stat dump. Empty until you supply real figures. Shape:
   *
   *   { value: '39', label: 'Strikeouts', note: '2021 season' },
   *   { value: '2.85', label: 'ERA', note: 'Career, college' },
   */
  highlights: [],

  /**
   * Season-by-season table. Empty means the table is skipped entirely. Only
   * the fields you fill in are shown; the rest render as dashes. Shape:
   *
   *   { year: '2021', team: 'Southern Illinois', level: 'NCAA D1',
   *     games: 21, wins: 1, losses: 2, saves: 2, innings: 30.1,
   *     era: 3.86, strikeouts: 39 },
   *   { year: '2023', team: 'Fredericksburg Nationals', level: 'Single-A', ... },
   */
  seasons: [],

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
