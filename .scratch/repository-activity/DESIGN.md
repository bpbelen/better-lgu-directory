# Repository activity — shared understanding

Outcome of a `/grill-with-docs` session. Nothing here is built yet; this is the
agreed design, recorded so implementation doesn't re-litigate it.

**The ask:** show when the repository behind each Better LGU portal was last
updated, in the directory.

---

## Settled decisions

| # | Decision | Answer |
|---|----------|--------|
| Q1 | What "last update" means | `pushed_at` from the repo root response — revisit only if Dependabot noise proves real |
| Q2 | Which surface | Jekyll site (`main-pages`) only, never `README.md` |
| Q3 | Name collision with existing `⚠️ Stale` | Distinct term; the two clocks stay separate |
| Q4 | Which entries | Every Entry with a repo link (~55), not just `🟢 Active` |
| Q5 | What it's for | Informational only; no automated status changes |
| Q6 | Where the fetch happens | **Client-side**, browser → GitHub API, unauthenticated |
| Q11 | Visual treatment | Second line inside the existing **Repository** cell |
| Q12 | How JS finds `owner/repo` | `sync-to-data.js` emits structured fields; `index.md` stamps `data-repo` |
| Q13 | Cache | `localStorage`, TTL varies by commit age |
| Q14 | Failure handling | Neutral `—` on the page; no error text shown to visitors |
| Q15 | Fetch trigger | Pagination picks candidates, IntersectionObserver fires them |
| Q16 | Search/filter | Incidentally searchable once fetched; not advertised |
| Q17 | Domain term | **Repository activity** |

---

## Why client-side, not build-time

Build-time (baking values into `_data/lgus.yml` during `sync-to-pages.yml`) was
the initial recommendation and was **overruled on the destination**, not on this
feature alone.

Last commit is step one. The intended destination is a repo stats panel —
contributors, stars, last commit. Forks was considered and dropped: here a fork
usually means someone copying a portal to start their own LGU, which is a
positive signal, but it's indistinguishable from drive-by forks in the count, so
the number is unreadable.

The argument that decided it:

- **API cost was never the differentiator.** `stars`, `forks`, `pushed_at`,
  `created_at`, `language` all arrive in the *same* `/repos/{owner}/{repo}`
  response. A full build-time stats panel is ~110 authenticated calls per sync
  against 5000/hr — trivial.
- **Git cost is the differentiator.** Build-time means committing that data on
  every sync. Star counts move constantly → a churn diff every run with no
  informational content. Contributor lists are large (login + avatar URL +
  contribution count, × N people × 55 repos) and every sync writes a fresh blob
  → permanent, unbounded history growth in a repo whose whole point is a
  hand-curated markdown table.
- **Liveness starts paying off.** The objection to client-side was that
  "3 days ago" can't render the difference between a value fetched 30 seconds
  ago and one baked 18 hours ago. True for last-commit alone; false for stars
  and contributors, which change perceptibly.

### What this costs, accepted knowingly

- **60 requests/hour per IP**, unauthenticated. Mitigated by age-based TTL,
  IntersectionObserver, and keeping contributors behind a disclosure.
- **No reliable activity *filter*.** `filterDirectory()` scans `td[j].textContent`
  at filter time, so injected values are only searchable for rows already
  fetched. A trustworthy "recently updated" filter would need build-time data.
  **This is the trigger to revisit the hybrid** — if that filter is ever wanted,
  reopen Q6.

### Measured fact that closed the door on "just cache harder"

`bettergov.ph/projects` stores ETags and sends `If-None-Match`. Tested against
the live API:

```
plain request      → HTTP 200, x-ratelimit-remaining: 35
conditional (304)  → HTTP 304, x-ratelimit-remaining: 34   ← still decremented
```

**A 304 still costs a request.** ETag saves bandwidth, not quota. TTL is the
only real quota control.

---

## Prior art: `bettergov.ph/projects`

Already does this client-side (`assets/index-Drgacmdw.js`). Reuse the shape:

- Unauthenticated `fetch("https://api.github.com/repos/{owner}/{repo}")`
- `localStorage` cache under a `ghcache:` prefix
- ETag stored, `If-None-Match` on revalidate
- On `403`/`429`/non-ok → fall back to stale cache, else a default
- In-flight promise dedupe via a `Map`
- `IntersectionObserver` (rootMargin `200px`) so a card only fetches on scroll-in

**Deliberate divergences:** their TTL is a flat 5 minutes (we use age-based, see
below) because they show a handful of projects and we show ~55.

---

## Design detail

### Display buckets

Display granularity is aligned to cache granularity so a cached value can never
render a visibly wrong answer. **Never show hour-level precision** — the cache
cannot back it.

```
today · yesterday · N days ago · N weeks ago · N months ago
```

Markup carries the machine value; JS computes the visible string from it against
`Date.now()` at render, so it cannot drift:

```html
<time datetime="2026-08-07T14:22:10Z" title="August 7, 2026">3 days ago</time>
```

### Cache TTL, by age of the commit

A repo last touched 8 months ago cannot change its bucket within a week. One
touched this morning can change it by tonight.

```
last commit < 24h   → TTL 1h    (bucket can flip today → yesterday)
last commit < 7d    → TTL 6h
older               → TTL 7d    (bucket is weeks/months — immovable)
```

Most of the ~55 repos sit in the third band, so this uses far less quota than a
flat 12h *and* is more accurate on the repos where accuracy is noticeable. Worst
case for "maintainer pushes, page still shows the old value" is 1 hour.

### Fetch gating

Two complementary layers — not alternatives:

- **Pagination** decides the *candidate set* (which rows are in the DOM)
- **IntersectionObserver** decides *when each one fires* (scroll into view)

At 10/page all ten are visible → ~10 calls. At 100/page only ~10–15 rows occupy
the viewport → still ~10–15 calls, spent gradually while scrolling. Add a
concurrency queue (2–3 in flight) so a fast scroll to the bottom doesn't burst.

### Placement

Second line inside the existing **Repository** cell:

```
| Repository          |          | Repository            |
|---------------------|    →     |-----------------------|
| GitHub              |          | GitHub                |
|                     |          | Updated 3 days ago    |
```

**Not a 7th column.** `filterDirectory()` in `index.md` reads `td[4]` for status
and `td[5]` for the adoption tag; inserting a column before those silently breaks
the status filter and the "Open for adoption" checkbox. The table is also already
6 wide and scrolls horizontally.

**Not tooltip-only** — invisible on touch, which is most of the traffic.

The cell reserves its height from the start so injection doesn't reflow the table.

### Repo identification

`sync-to-data.js` (offline, already the parser) emits structured `owner`/`repo`
so `index.md` can stamp `data-repo="owner/name"` on the row. JS never regexes
presentation markup. Entries with no repo carry no attribute and are skipped.

**One special case:** `bettercalauan/bettercalauan/tree/react-typescript` pins a
branch. It is the only non-canonical repo link in the table, and every repo link
is GitHub. Parse `/tree/<ref>` and preserve it; the maintainer pinned that branch
because that's where the portal lives.

### Failure handling

- **Rate-limited / network error** → neutral `—`. Throttling is a property of the
  viewer's session, not the Entry; labelling it per-row would put misleading
  noise on every visible row at once. One page-level notice if it's surfaced at all.
- **404** (deleted, renamed, gone private) → also neutral `—` on the page. Showing
  a 404 to a visitor reads as *the directory* being broken.
- The 404 signal is real and worth keeping, but it belongs to maintainers.
  Route it to `scripts/check-stale.js`, which already exists as the local
  maintainer report that "reads git history and prints — it never edits
  README.md, and is deliberately not wired into CI." A dead repo link is the same
  class of finding as a stale entry.

### Forward path — the stats panel

Last commit ships in the cell now. When contributors/stars arrive, the row gains
a disclosure that expands into a detail panel beneath it.

That disclosure is not decoration — **it is the throttle contributors needs.**
Contributors requires a second endpoint (`/contributors?per_page=100`), so as a
per-row fetch it would cost 20 calls per 10-row page and hit the 60/hr wall on
the visitor's third page. Behind an opt-in expansion, it's only spent on rows
someone actually asked about.

---

## Domain term for `CONTEXT.md`

**Repository activity**: public GitHub signals about an Entry's linked repository
(last commit, contributors, stars), fetched in the browser at view time and never
stored in this repository.
_Avoid_: portal activity (the portal is the site; this measures the repo), stale
(reserved for directory inactivity on the Entry row — a different clock).

The existing `⚠️ Stale` tag means *no directory activity on the Entry row for 30
days*, judged by hand. Repository activity is a separate measurement and must
never be conflated with it, or drive it (Q5).

---

## Not decided / out of scope

- The stats panel itself — contributors, stars, disclosure UI. Deliberately later.
- Wiring 404 detection into `check-stale.js` — follow-up.
- Any automated status or `⚠️ Stale` change driven by repository activity — ruled
  out at Q5.
