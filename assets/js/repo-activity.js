// Repository activity (#162): the "Updated N days ago" second line inside
// each directory row's Repository cell. Client-side, unauthenticated GitHub
// API, never stored in this repository — see DESIGN.md on
// prototype/repo-activity-ui for the full design record and reasoning.
//
// This is a plain script (no bundler/build step on this branch), so it's
// wrapped in an IIFE and attaches nothing to `window` except through the
// DOM it renders into. The handful of pure functions (bucket/exactDate/
// ttlMs/isFresh) are exported via `module.exports` when running under
// Node, purely so scripts/test-repo-activity.js can exercise them with
// zero dependencies — that branch of the export never runs in the browser.
(function () {
    'use strict';

    var CACHE_PREFIX = 'ghcache:';
    var CONCURRENCY = 3;
    var ROOT_MARGIN = '200px';
    var HOUR_MS = 3600000;
    var DAY_MS = 24 * HOUR_MS;

    // -------------------------------------------------------------------
    // Pure helpers — no DOM, no network, no storage. Kept side-effect free
    // so they can be unit tested directly.
    // -------------------------------------------------------------------

    // Display bucketing. Day granularity is deliberate: TTL is measured in
    // hours, so hour-level precision would be precision the cache can't
    // back — never show it.
    function bucket(iso, now) {
        var then = new Date(iso).getTime();
        var days = Math.floor(((now == null ? Date.now() : now) - then) / DAY_MS);
        if (days <= 0) return 'today';
        if (days === 1) return 'yesterday';
        if (days < 7) return days + ' days ago';
        if (days < 30) {
            var w = Math.floor(days / 7);
            return w + (w === 1 ? ' week ago' : ' weeks ago');
        }
        if (days < 365) {
            var m = Math.floor(days / 30);
            return m + (m === 1 ? ' month ago' : ' months ago');
        }
        var y = Math.floor(days / 365);
        return y + (y === 1 ? ' year ago' : ' years ago');
    }

    function exactDate(iso) {
        return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    }

    // Cache TTL as a function of the *commit's* age, not the cache entry's
    // age — a repo touched 8 months ago can't change bucket within a week;
    // one touched this morning can flip bucket by tonight. See DESIGN.md.
    function ttlMs(pushedAtIso, now) {
        var hrs = ((now == null ? Date.now() : now) - new Date(pushedAtIso).getTime()) / HOUR_MS;
        if (hrs < 24) return 1 * HOUR_MS;
        if (hrs < 24 * 7) return 6 * HOUR_MS;
        return 7 * DAY_MS;
    }

    // Whether a cached entry is still usable without hitting the network.
    // A "not found" (404) result is cached and treated like the oldest TTL
    // band (7 days) — a deleted/renamed/private repo doesn't come back
    // quickly, and re-checking it on every page view would burn quota for
    // no benefit.
    function isFresh(entry, now) {
        now = now == null ? Date.now() : now;
        if (!entry || typeof entry.fetchedAt !== 'number') return false;
        if (entry.notFound) return (now - entry.fetchedAt) < (7 * DAY_MS);
        if (!entry.pushedAt) return false;
        return (now - entry.fetchedAt) < ttlMs(entry.pushedAt, entry.fetchedAt);
    }

    // -------------------------------------------------------------------
    // Everything below touches the DOM, localStorage, or the network —
    // none of it runs (or is reachable) under the Node test.
    // -------------------------------------------------------------------

    var hasDom = typeof document !== 'undefined' && typeof window !== 'undefined';

    if (hasDom) {
        (function runInBrowser() {
            // ---- localStorage cache, degrading silently if unavailable
            // (quota exceeded, private browsing, disabled). ----

            function readCache(key) {
                try {
                    var raw = window.localStorage.getItem(key);
                    if (!raw) return null;
                    var parsed = JSON.parse(raw);
                    return parsed && typeof parsed === 'object' ? parsed : null;
                } catch (e) {
                    return null;
                }
            }

            function writeCache(key, entry) {
                try {
                    window.localStorage.setItem(key, JSON.stringify(entry));
                } catch (e) {
                    // Full, disabled, or private mode — proceed without a cache.
                }
            }

            // ---- concurrency queue: 2-3 in flight, so a fast scroll to the
            // bottom of a 100-per-page listing doesn't burst every visible
            // row's request at once. ----

            function createQueue(limit) {
                var active = 0;
                var pending = [];

                function runNext() {
                    if (active >= limit || pending.length === 0) return;
                    active++;
                    var job = pending.shift();
                    job.task().then(job.resolve, job.reject).then(function () {
                        active--;
                        runNext();
                    });
                }

                return function enqueue(task) {
                    return new Promise(function (resolve, reject) {
                        pending.push({ task: task, resolve: resolve, reject: reject });
                        runNext();
                    });
                };
            }

            var enqueue = createQueue(CONCURRENCY);

            // ---- in-flight promise dedupe: two cells never fetch the same
            // repo twice concurrently. ----

            var inFlight = {};

            function fetchActivity(owner, repo) {
                var slug = owner + '/' + repo;
                if (inFlight[slug]) return inFlight[slug];
                var promise = enqueue(function () { return doFetch(slug); }).then(
                    function (result) { delete inFlight[slug]; return result; },
                    function (err) { delete inFlight[slug]; throw err; },
                );
                inFlight[slug] = promise;
                return promise;
            }

            // ETag revalidation saves bandwidth only — a 304 still
            // decrements the rate limit (measured against the live API,
            // see DESIGN.md), so it is not a substitute for the TTL, which
            // is the real quota control here.
            function doFetch(slug) {
                var cacheKey = CACHE_PREFIX + slug;
                var cached = readCache(cacheKey);
                var headers = {};
                if (cached && cached.etag) headers['If-None-Match'] = cached.etag;

                return fetch('https://api.github.com/repos/' + slug, { headers: headers })
                    .then(function (res) {
                        if (res.status === 304 && cached) {
                            var revalidated = {
                                pushedAt: cached.pushedAt,
                                etag: cached.etag,
                                fetchedAt: Date.now(),
                            };
                            writeCache(cacheKey, revalidated);
                            return revalidated;
                        }
                        if (res.status === 404) {
                            var notFound = { notFound: true, fetchedAt: Date.now() };
                            writeCache(cacheKey, notFound);
                            return notFound;
                        }
                        if (!res.ok) {
                            // Rate-limited (403/429) or any other non-ok
                            // status: fall back to stale cache if we have
                            // one, else render neutral — never surface the
                            // status code.
                            return cached;
                        }
                        return res.json().then(function (data) {
                            var entry = {
                                pushedAt: data.pushed_at,
                                etag: res.headers.get('ETag') || undefined,
                                fetchedAt: Date.now(),
                            };
                            writeCache(cacheKey, entry);
                            return entry;
                        });
                    })
                    .catch(function () {
                        // Network error: same neutral fallback as rate-limited.
                        return cached;
                    });
            }

            // ---- rendering: three states, matching prototype.html. The
            // observed/handled element (`.repo-activity[data-repo]`) IS the
            // line to fill — a sibling of the repo link after a <br>, not a
            // wrapper around it, so kramdown's markdown parsing of
            // {{ lgu.repo }} is never touched by this script. ----

            function renderLoading(el) {
                el.innerHTML = '<span class="repo-activity-skeleton" aria-hidden="true"></span>';
            }

            function renderNone(el) {
                el.innerHTML = '<span class="repo-activity-none">—</span>';
            }

            function renderValue(el, iso) {
                el.textContent = 'Updated ';
                var time = document.createElement('time');
                time.setAttribute('datetime', iso);
                time.setAttribute('title', exactDate(iso));
                time.textContent = bucket(iso);
                el.appendChild(time);
            }

            function handleCell(el) {
                var slug = el.getAttribute('data-repo');
                if (!slug || slug.indexOf('/') === -1) return;
                var cacheKey = CACHE_PREFIX + slug;
                var cached = readCache(cacheKey);

                // Fast path: a fresh cache entry needs no network at all —
                // satisfies "repeat visits within the TTL make no request."
                if (cached && isFresh(cached)) {
                    if (cached.notFound) renderNone(el); else renderValue(el, cached.pushedAt);
                    return;
                }

                renderLoading(el);
                var slashIndex = slug.indexOf('/');
                var owner = slug.slice(0, slashIndex);
                var repo = slug.slice(slashIndex + 1);
                fetchActivity(owner, repo).then(function (entry) {
                    if (!entry || entry.notFound || !entry.pushedAt) {
                        renderNone(el);
                        return;
                    }
                    renderValue(el, entry.pushedAt);
                });
            }

            // ---- fetch gating: pagination (existing show/hide) decides the
            // candidate set — a hidden (display:none) row cannot intersect,
            // so it never triggers a fetch until paged into view;
            // IntersectionObserver decides exactly when a visible row
            // fires. Complementary, not alternatives — see DESIGN.md. ----

            function init() {
                var cells = document.querySelectorAll('.repo-activity[data-repo]');
                if (!cells.length) return;

                if (!('IntersectionObserver' in window)) {
                    // No IO support: still gated by the concurrency queue,
                    // so this degrades to "slower," not "bursts every row."
                    cells.forEach(handleCell);
                    return;
                }

                var observer = new IntersectionObserver(function (entries) {
                    entries.forEach(function (entry) {
                        if (!entry.isIntersecting) return;
                        observer.unobserve(entry.target);
                        handleCell(entry.target);
                    });
                }, { rootMargin: ROOT_MARGIN });

                cells.forEach(function (cell) { observer.observe(cell); });
            }

            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', init);
            } else {
                init();
            }
        })();
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { bucket: bucket, exactDate: exactDate, ttlMs: ttlMs, isFresh: isFresh };
    }
})();
