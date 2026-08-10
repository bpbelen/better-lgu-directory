// Zero-dependency regression test for the repository activity display
// buckets and cache TTL rules (#162), the site-side (main-pages) half of the
// feature. This repo has no package.json / test runner on either branch, so
// this is a plain Node script using the built-in `assert` module, following
// the scripts/test-rotation-index.js pattern. Run with:
//
//   node scripts/test-repo-activity-site.js
//
// It exits non-zero on any failure.
//
// Scope note: #162 splits across two branches (see CONTEXT.md's "Sync
// pipeline" entry and the #132 precedent — data/workflow changes land on
// `main`, site rendering on `main-pages`). This file covers only the
// `main-pages` side: the pure bucket/exactDate/ttlMs/isFresh functions
// exported from assets/js/repo-activity.js. The repo-URL parsing
// (parseRepoCell in scripts/sync-to-data.js) lives on `main` and is covered
// by that branch's own scripts/test-repo-activity-data.js — it cannot be
// required from here since main-pages has no sync-to-data.js parser logic
// for it (main-pages's copy is a mirror kept in sync by the automated merge,
// not a place new tests are added).
//
// Named `-site` (not the bare `test-repo-activity.js` this file and #163's
// companion both originally used) specifically so the two don't collide
// when sync-to-pages.yml's `git merge origin/main` runs after both land —
// same path, unrelated content, guaranteed conflict otherwise.

const assert = require('assert');
const { bucket, exactDate, ttlMs, isFresh, renderEmpty } = require('../assets/js/repo-activity.js');

let assertions = 0;
function check(condition, message) {
    assertions++;
    assert.ok(condition, message);
}

const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const NOW = Date.UTC(2026, 7, 10, 12, 0, 0); // 2026-08-10T12:00:00Z, arbitrary fixed "now"

function daysAgoIso(days, fromMs = NOW) {
    return new Date(fromMs - days * DAY_MS).toISOString();
}
function hoursAgoIso(hours, fromMs = NOW) {
    return new Date(fromMs - hours * HOUR_MS).toISOString();
}

// --- display buckets ---------------------------------------------------

check(bucket(hoursAgoIso(0), NOW) === 'today', 'a commit from right now buckets as "today"');
check(bucket(hoursAgoIso(23), NOW) === 'today', 'a commit 23h ago (same day) buckets as "today", never hour-level precision');
check(bucket(daysAgoIso(1), NOW) === 'yesterday', 'a commit 1 day ago buckets as "yesterday"');
check(bucket(daysAgoIso(2), NOW) === '2 days ago', 'a commit 2 days ago buckets as "2 days ago"');
check(bucket(daysAgoIso(6), NOW) === '6 days ago', 'a commit 6 days ago is still expressed in days (< 7)');
check(bucket(daysAgoIso(7), NOW) === '1 week ago', 'a commit exactly 7 days ago rolls over to "1 week ago" (singular)');
check(bucket(daysAgoIso(13), NOW) === '1 week ago', 'a commit 13 days ago is still "1 week ago" (floor division)');
check(bucket(daysAgoIso(14), NOW) === '2 weeks ago', 'a commit 14 days ago is "2 weeks ago" (plural)');
check(bucket(daysAgoIso(29), NOW) === '4 weeks ago', 'a commit 29 days ago is still expressed in weeks (< 30)');
check(bucket(daysAgoIso(30), NOW) === '1 month ago', 'a commit exactly 30 days ago rolls over to "1 month ago" (singular)');
check(bucket(daysAgoIso(60), NOW) === '2 months ago', 'a commit 60 days ago is "2 months ago" (plural)');
check(bucket(daysAgoIso(364), NOW) === '12 months ago', 'a commit 364 days ago is still expressed in months (< 365)');
check(bucket(daysAgoIso(365), NOW) === '1 year ago', 'a commit exactly 365 days ago rolls over to "1 year ago" (singular)');
check(bucket(daysAgoIso(800), NOW) === '2 years ago', 'a commit 800 days ago is "2 years ago" (plural)');

check(!/\d+\s*h(ou)?r/i.test(bucket(hoursAgoIso(3), NOW)), 'never renders hour-level precision, even for a very recent commit');

// --- exact date (the hover title) ---------------------------------------

check(exactDate('2026-08-07T14:22:10Z') === 'August 7, 2026', 'exactDate renders a human month/day/year, matching the datetime attribute');

// --- cache TTL bands, by commit age -------------------------------------

check(ttlMs(hoursAgoIso(0), NOW) === HOUR_MS, 'a commit from right now gets the 1h TTL band');
check(ttlMs(hoursAgoIso(23), NOW) === HOUR_MS, 'a commit 23h old is still in the <24h -> 1h TTL band');
check(ttlMs(hoursAgoIso(24), NOW) === 6 * HOUR_MS, 'a commit exactly 24h old rolls into the 6h TTL band');
check(ttlMs(daysAgoIso(6), NOW) === 6 * HOUR_MS, 'a commit 6 days old is still in the <7d -> 6h TTL band');
check(ttlMs(daysAgoIso(7), NOW) === 7 * DAY_MS, 'a commit exactly 7 days old rolls into the 7d TTL band');
check(ttlMs(daysAgoIso(240), NOW) === 7 * DAY_MS, 'a commit 8 months old is in the immovable 7d TTL band');

// --- isFresh: whether a cached entry needs no network request -----------

{
    const entry = { pushedAt: hoursAgoIso(1, NOW), fetchedAt: NOW };
    check(isFresh(entry, NOW) === true, 'a cache entry fetched right now is fresh at that same instant');
    check(isFresh(entry, NOW + 30 * 60000) === true, 'a <24h-commit cache entry is still fresh 30 minutes later (within its 1h TTL)');
    check(isFresh(entry, NOW + 2 * HOUR_MS) === false, 'a <24h-commit cache entry goes stale after its 1h TTL elapses');
}
{
    // Most of the ~55 repos sit in the oldest band — worth its own case.
    const entry = { pushedAt: daysAgoIso(240, NOW), fetchedAt: NOW };
    check(isFresh(entry, NOW + 6 * DAY_MS) === true, 'an old-commit cache entry is still fresh 6 days later (within its 7d TTL)');
    check(isFresh(entry, NOW + 8 * DAY_MS) === false, 'an old-commit cache entry goes stale after its 7d TTL elapses');
}
check(isFresh(null, NOW) === false, 'no cache entry is never fresh');
check(isFresh({}, NOW) === false, 'a malformed cache entry (no fetchedAt) is never fresh');
{
    // 404 / private / deleted repos are cached too, so a repeat visit
    // doesn't re-request a repo that's gone — same rationale as the oldest
    // TTL band (7d): a dead link doesn't come back quickly.
    const notFound = { notFound: true, fetchedAt: NOW };
    check(isFresh(notFound, NOW + 6 * DAY_MS) === true, 'a cached 404 result stays fresh for up to 7 days');
    check(isFresh(notFound, NOW + 8 * DAY_MS) === false, 'a cached 404 result goes stale after 7 days, so it gets re-checked eventually');
}

// --- renderEmpty: terminal-failure rendering (blank, not "—") -----------
//
// Rate-limited, network error, 404, or any other unfetchable case (Jan,
// 2026-08-10, overriding #162's original "renders a neutral —" AC — the
// dash sat off-centre next to the GitHub link). A minimal mock element
// stands in for a real DOM node — renderEmpty only touches .textContent
// and .classList.add, so no jsdom/browser dependency is needed here.
function mockRepoActivityEl(initialText) {
    const classes = new Set();
    return {
        textContent: initialText,
        classList: { add: (c) => classes.add(c), has: (c) => classes.has(c) },
        _classes: classes,
    };
}

{
    const el = mockRepoActivityEl('');
    renderEmpty(el);
    check(el.textContent === '', 'renderEmpty leaves the cell with no text content — no "—" placeholder');
    check(el.classList.has('repo-activity-empty'), 'renderEmpty adds the repo-activity-empty modifier class, so CSS can collapse the min-height reservation');
}
{
    // Simulates the skeleton-then-failure path: loading left markup behind,
    // renderEmpty must still fully clear it, not just append.
    const el = mockRepoActivityEl('<span class="repo-activity-skeleton" aria-hidden="true"></span>');
    renderEmpty(el);
    check(el.textContent === '', 'renderEmpty clears prior skeleton content, not just appends to it');
}

console.log(`✅ ${assertions} assertions passed.`);
