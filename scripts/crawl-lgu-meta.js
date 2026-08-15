const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { README_PATH, parseTable, validateLgu } = require('./sync-to-data.js');

const LGU_META_PATH = process.argv[2] || path.join(__dirname, '../_data/lgu-meta.yml');

const USER_AGENT = 'BetterLGUDirectoryBot/1.0 (+https://lgu.bettergov.ph)';
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const IMAGE_SIZE_CEILING_BYTES = 400 * 1024; // #127: 400KB ceiling, checked on fetched bytes

// #122: the crawl excludes any Entry whose resolved title/description is
// byte-identical (whitespace-normalised) to BetterGov.ph's generic template
// copy — a portal can be mechanically complete yet still not be "about" the
// LGU. Kept in one place so a future template revision is a one-line change.
const BOILERPLATE_DESCRIPTION =
    'Community-powered portal of the Republic of the Philippines. Access government services, stay updated with the latest news, and find information about the Philippines.';
const BOILERPLATE_TITLE =
    'BetterGov.ph | Republic of the Philippines | Community Powered Government Portal';

function normalizeWhitespace(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function isBoilerplate(title, description) {
    const normDescription = normalizeWhitespace(description);
    const normTitle = normalizeWhitespace(title);
    return (
        normDescription === normalizeWhitespace(BOILERPLATE_DESCRIPTION) ||
        normTitle === normalizeWhitespace(BOILERPLATE_TITLE)
    );
}

// --- Ineligibility reasons -------------------------------------------------
//
// Every rule that can keep an Entry out of the Featured pool reports why, as
// a { summaries, message } pair:
//
//   summaries — one or more variable-free phrases naming the rule(s) that
//               failed. These are the grouping keys for the end-of-run tally,
//               so they must never embed a URL, byte count, status code or
//               content type. A portal missing two meta fields reports two
//               summaries, so each field's total stays readable as one number
//               rather than splitting across every combination it appeared in.
//   message   — the single per-portal log line, which does carry those
//               specifics.
//
// Before this, all of these paths returned a bare null and main() printed one
// static "incomplete, boilerplate, or robots-disallowed" line for every one of
// them — which named three causes out of seven and made a missing meta tag
// indistinguishable from a 404 on the og:image.
function reason(summaries, message) {
    const list = Array.isArray(summaries) ? summaries : [summaries];
    return { summaries: list, message: message || list.join('; ') };
}

// extractMeta() resolves each field through its fallback chain first, so a
// blank here means *every* source for that field was absent — name them all,
// otherwise the log sends the reader looking for an og: tag they may have
// deliberately skipped in favour of the plain HTML one.
const META_FIELD_SOURCES = [
    ['image', 'og:image'],
    ['title', 'og:title/<title>'],
    ['description', 'og:description/meta[name=description]'],
];

function missingMetaReason({ title, description, image }) {
    const values = { title, description, image };
    const missing = META_FIELD_SOURCES.filter(([field]) => !values[field]).map(([, label]) => label);
    if (missing.length === 0) return null;
    // One summary per absent field: a portal missing both the image and the
    // description counts towards each field's own tally row, so "how many
    // portals have no og:image at all" is a single number in the summary.
    return reason(
        missing.map((label) => `missing ${label}`),
        `missing ${missing.join(' + ')}`,
    );
}

function boilerplateReason(title, description) {
    // isBoilerplate() stays the single gate (see its comment above) so a future
    // template revision only has to be made there; the per-field checks below
    // exist purely to tell the operator which field tripped it.
    if (!isBoilerplate(title, description)) return null;

    const matched = [];
    if (normalizeWhitespace(title) === normalizeWhitespace(BOILERPLATE_TITLE)) matched.push('title');
    if (normalizeWhitespace(description) === normalizeWhitespace(BOILERPLATE_DESCRIPTION)) {
        matched.push('description');
    }
    const generic = "BetterGov.ph's generic template copy";
    return reason(
        'boilerplate BetterGov.ph template copy',
        // A rule added to isBoilerplate() but not mirrored here still reports —
        // just without naming the field.
        matched.length === 0
            ? `title/description is still ${generic}`
            : `${matched.join(' and ')} ${matched.length > 1 ? 'are' : 'is'} still ${generic}`,
    );
}

function formatBytes(bytes) {
    return `${(bytes / 1024).toFixed(1)}KB`;
}

// The og:image is fetched separately from the page, so it has four distinct
// ways to fail. The page itself answering fine means none of them make the
// portal "unreachable" — they are all metadata-quality rejections.
function imageRejectionReason({ imageUrl, fetchError, statusCode, contentType, byteLength, truncatedOversize }) {
    // Tested for presence, not truthiness: an Error carrying an empty message
    // still means the fetch failed, and falling through would misreport it as
    // a content-type problem — exactly the misattribution this reporting
    // exists to remove.
    if (fetchError !== undefined && fetchError !== null) {
        const detail = String(fetchError) || 'no error detail available';
        return reason('og:image could not be fetched', `og:image could not be fetched (${imageUrl}): ${detail}`);
    }
    if (!Number.isFinite(statusCode)) {
        return reason('og:image response was unusable', `og:image returned no usable HTTP status (${imageUrl})`);
    }
    if (statusCode >= 400 || statusCode < 200) {
        return reason('og:image returned an HTTP error', `og:image returned HTTP ${statusCode} (${imageUrl})`);
    }
    const normalizedType = (contentType || '').toLowerCase();
    if (!normalizedType.startsWith('image/')) {
        return reason(
            'og:image is not an image',
            `og:image served as ${normalizedType ? `"${normalizedType}"` : 'no Content-Type'} (${imageUrl})`,
        );
    }
    if (truncatedOversize || byteLength > IMAGE_SIZE_CEILING_BYTES) {
        // A truncated fetch stopped reading at the ceiling, so the real size is
        // unknown — say so rather than reporting the ceiling as the size.
        const ceiling = formatBytes(IMAGE_SIZE_CEILING_BYTES);
        return reason(
            'og:image exceeds the size ceiling',
            truncatedOversize
                ? `og:image exceeds the ${ceiling} ceiling (truncated mid-download) (${imageUrl})`
                : `og:image is ${formatBytes(byteLength)}, over the ${ceiling} ceiling (${imageUrl})`,
        );
    }
    return null;
}

// Groups the run's rejections by summary so a systemic problem (say, twelve
// portals with no og:image at all) reads as one line instead of needing the
// whole per-portal log scrolled and counted by hand. Takes one entry per
// rejected portal — each being that portal's list of summaries — so the
// headline count stays a portal count even though a portal can fail two rules
// at once, in which case it contributes to both tally rows.
function formatIneligibleSummary(rejections) {
    if (rejections.length === 0) return '';

    const counts = new Map();
    for (const summaries of rejections) {
        for (const summary of new Set(summaries)) {
            counts.set(summary, (counts.get(summary) || 0) + 1);
        }
    }

    const rows = [...counts.entries()].sort(
        (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
    );
    const labelWidth = Math.max(...rows.map(([label]) => label.length));
    const countWidth = Math.max(...rows.map(([, count]) => String(count).length));

    return [
        `Ineligible (${rejections.length}):`,
        ...rows.map(([label, count]) => `  ${label.padEnd(labelWidth)}  ${String(count).padStart(countWidth)}`),
    ].join('\n');
}

// Escape a value for safe embedding inside a double-quoted YAML scalar.
function yamlStr(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function sha1First8(value) {
    return crypto.createHash('sha1').update(value).digest('hex').slice(0, 8);
}

// Marker used internally to distinguish "the portal looked down" (network
// error, timeout, non-2xx/3xx on the page itself) from "the portal answered
// but the metadata isn't good enough" (missing/oversized image, boilerplate
// copy, robots disallow). Only the former preserves the previous row — see
// the catch block in main() below and issue #132's failure-tolerance
// requirement.
class PortalUnreachableError extends Error {}

function requestOnce(urlString, { method = 'GET', maxBytes } = {}) {
    return new Promise((resolve, reject) => {
        let url;
        try {
            url = new URL(urlString);
        } catch (err) {
            reject(new PortalUnreachableError(`Invalid URL: ${urlString}`));
            return;
        }

        const lib = url.protocol === 'http:' ? http : https;
        const req = lib.request(
            url,
            {
                method,
                headers: { 'User-Agent': USER_AGENT },
                timeout: REQUEST_TIMEOUT_MS,
            },
            (res) => {
                const chunks = [];
                let total = 0;
                let aborted = false;

                res.on('data', (chunk) => {
                    if (aborted) return;
                    total += chunk.length;
                    if (maxBytes && total > maxBytes) {
                        aborted = true;
                        res.destroy();
                        resolve({
                            statusCode: res.statusCode,
                            headers: res.headers,
                            body: Buffer.concat(chunks),
                            truncatedOversize: true,
                        });
                        return;
                    }
                    chunks.push(chunk);
                });
                res.on('end', () => {
                    if (aborted) return;
                    resolve({
                        statusCode: res.statusCode,
                        headers: res.headers,
                        body: Buffer.concat(chunks),
                        truncatedOversize: false,
                    });
                });
                res.on('error', (err) => reject(new PortalUnreachableError(err.message)));
            },
        );

        req.on('timeout', () => {
            req.destroy(new PortalUnreachableError(`Timed out fetching ${urlString}`));
        });
        req.on('error', (err) => reject(new PortalUnreachableError(err.message)));
        req.end();
    });
}

// Follows redirects manually (Node's http/https do not) so we can keep
// enforcing our own timeout and User-Agent on every hop.
async function fetchFollowingRedirects(urlString, opts = {}) {
    let currentUrl = urlString;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const res = await requestOnce(currentUrl, opts);
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
            currentUrl = new URL(res.headers.location, currentUrl).toString();
            continue;
        }
        return { ...res, finalUrl: currentUrl };
    }
    throw new PortalUnreachableError(`Too many redirects fetching ${urlString}`);
}

// Minimal hand-rolled robots.txt check (#128) — deliberately not a full RFC
// parser: we fetch exactly one page per site, so path-level rule matching
// buys nothing, and a library would be this repo's first npm dependency.
// Looks only for a blanket "Disallow: /" in the "*" group or a group naming
// our UA, and reads any Crawl-delay set for either.
async function checkRobots(origin) {
    let body;
    try {
        const res = await fetchFollowingRedirects(new URL('/robots.txt', origin).toString());
        if (res.statusCode >= 400) {
            return { disallowed: false, crawlDelaySeconds: 0 };
        }
        body = res.body.toString('utf8');
    } catch {
        // No robots.txt (or it's unreachable) is not itself a reason to skip —
        // absence of the file means no rules apply.
        return { disallowed: false, crawlDelaySeconds: 0 };
    }

    const ourUaLower = 'betterlgudirectorybot';
    let currentAgents = [];
    let groupJustStarted = false;
    let disallowed = false;
    let crawlDelaySeconds = 0;

    for (const rawLine of body.split(/\r?\n/)) {
        const line = rawLine.replace(/#.*$/, '').trim();
        if (!line) continue;
        const [rawKey, ...rest] = line.split(':');
        if (!rawKey || rest.length === 0) continue;
        const key = rawKey.trim().toLowerCase();
        const value = rest.join(':').trim();

        if (key === 'user-agent') {
            if (!groupJustStarted) currentAgents = [];
            currentAgents.push(value.toLowerCase());
            groupJustStarted = true;
            continue;
        }

        groupJustStarted = false;
        const appliesToUs = currentAgents.includes('*') || currentAgents.includes(ourUaLower);
        if (!appliesToUs) continue;

        if (key === 'disallow' && value === '/') {
            disallowed = true;
        } else if (key === 'crawl-delay') {
            const seconds = Number(value);
            if (Number.isFinite(seconds) && seconds > crawlDelaySeconds) {
                crawlDelaySeconds = seconds;
            }
        }
    }

    return { disallowed, crawlDelaySeconds };
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Attribute parsing shared by title/meta extraction — deliberately regex
// based rather than a DOM parser, matching this repo's zero-dependency rule.
function parseTagAttrs(tagSource) {
    const attrs = {};
    const attrPattern = /([a-zA-Z][\w:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let match;
    while ((match = attrPattern.exec(tagSource)) !== null) {
        const name = match[1].toLowerCase();
        const value = match[3] !== undefined ? match[3] : match[4];
        attrs[name] = value;
    }
    return attrs;
}

function decodeHtmlEntities(value) {
    return String(value)
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'");
}

function extractMeta(html) {
    const metaTags = html.match(/<meta\s+[^>]*>/gi) || [];
    const meta = {};
    for (const tag of metaTags) {
        const attrs = parseTagAttrs(tag);
        const key = (attrs.property || attrs.name || '').toLowerCase();
        if (key && attrs.content !== undefined) {
            meta[key] = attrs.content;
        }
    }

    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const documentTitle = titleMatch ? decodeHtmlEntities(titleMatch[1]).trim() : '';

    // #122: title resolves og:title falling back to <title>; description
    // resolves og:description falling back to <meta name="description">;
    // the image has no fallback source — og:image only.
    const title = decodeHtmlEntities(meta['og:title'] || documentTitle || '').trim();
    const description = decodeHtmlEntities(meta['og:description'] || meta['description'] || '').trim();
    const image = (meta['og:image'] || '').trim();

    return { title, description, image };
}

// README domain cells are markdown links — e.g. "[bettersolano.org]
// (https://bettersolano.org)" — the same raw form validateLgu() stores
// (sync-to-data.js relies on kramdown re-processing that text at render
// time; see index.md's `markdown="1"` table wrapper). Extract the real URL
// to crawl and the bare hostname to display, falling back to treating the
// whole cell as a bare hostname if it isn't a markdown link.
function extractDomainLink(rawCell) {
    const match = /\[([^\]]+)\]\(([^)]+)\)/.exec(rawCell || '');
    if (match) {
        return { label: match[1].trim(), url: match[2].trim() };
    }
    const bare = String(rawCell || '').trim();
    return { label: bare, url: /^https?:\/\//i.test(bare) ? bare : `https://${bare}` };
}

// Crawls one Entry's portal and returns { row, reason }: a complete lgu-meta
// row when the portal clears the bar, or `row: null` plus the specific
// { summary, message } rejection when it is reachable but does not meet the
// completeness/quality bar (#122, #125, #127). Throws PortalUnreachableError
// if the portal itself looks down — callers use that to decide whether to
// preserve the previous row instead of dropping it.
async function crawlEntry(entry, displayDomain, origin) {
    const rejected = (why) => ({ row: null, reason: why });

    const robots = await checkRobots(origin);
    if (robots.disallowed) {
        return rejected(
            reason('robots.txt disallows our crawler', `robots.txt at ${origin} disallows ${USER_AGENT}`),
        );
    }
    if (robots.crawlDelaySeconds > 0) {
        await sleep(robots.crawlDelaySeconds * 1000);
    }

    const pageRes = await fetchFollowingRedirects(origin);
    if (pageRes.statusCode >= 400 || pageRes.statusCode < 200) {
        throw new PortalUnreachableError(`${displayDomain} returned HTTP ${pageRes.statusCode}`);
    }

    const contentType = (pageRes.headers['content-type'] || '').toLowerCase();
    if (contentType && !contentType.includes('html')) {
        throw new PortalUnreachableError(`${displayDomain} did not return HTML (${contentType})`);
    }

    const html = pageRes.body.toString('utf8');
    const { title, description, image } = extractMeta(html);

    // Mechanically incomplete — no fallback (#125), no row.
    const incomplete = missingMetaReason({ title, description, image });
    if (incomplete) {
        return rejected(incomplete);
    }

    // Complete but not "about" the LGU (#122's quality floor) — no row.
    const boilerplate = boilerplateReason(title, description);
    if (boilerplate) {
        return rejected(boilerplate);
    }

    if (robots.crawlDelaySeconds > 0) {
        await sleep(robots.crawlDelaySeconds * 1000);
    }

    const imageUrl = new URL(image, pageRes.finalUrl).toString();
    let imageRes;
    try {
        imageRes = await fetchFollowingRedirects(imageUrl, { maxBytes: IMAGE_SIZE_CEILING_BYTES });
    } catch (err) {
        // The image failing to load is a metadata-quality problem, not the
        // whole portal being down — the page itself answered fine.
        return rejected(imageRejectionReason({ imageUrl, fetchError: err.message }));
    }

    const imageRejection = imageRejectionReason({
        imageUrl,
        statusCode: imageRes.statusCode,
        contentType: imageRes.headers['content-type'] || '',
        byteLength: imageRes.body.length,
        truncatedOversize: imageRes.truncatedOversize,
    });
    if (imageRejection) {
        return rejected(imageRejection);
    }

    return {
        row: {
            name: entry.name,
            domain: displayDomain,
            image: imageUrl,
            title,
            description,
            order_key: sha1First8(displayDomain),
        },
        reason: null,
    };
}

function parseExistingLguMeta(filePath) {
    // Reads the previously-generated _data/lgu-meta.yml, if any, so an
    // unreachable-this-run portal can keep its last-known-good row (#132:
    // "a portal that's down leaves its previous row untouched"). Hand-rolled
    // reader matching the hand-rolled writer below — this file's schema is
    // simple and fixed, so a YAML library is not worth adding. Keyed by the
    // clean display domain (not the README's raw markdown cell).
    if (!fs.existsSync(filePath)) return new Map();

    const content = fs.readFileSync(filePath, 'utf8');
    const byDomain = new Map();
    const entryBlocks = content.split(/\n(?=- name:)/);

    for (const block of entryBlocks) {
        if (!block.trim().startsWith('- name:')) continue;
        const get = (key) => {
            const m = block.match(new RegExp(`${key}:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
            return m ? m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : '';
        };
        const domain = get('domain');
        if (!domain) continue;
        byDomain.set(domain, {
            name: get('name'),
            domain,
            image: get('image'),
            title: get('title'),
            description: get('description'),
            order_key: get('order_key'),
        });
    }
    return byDomain;
}

function formatLguMetaYaml(rows) {
    if (rows.length === 0) return '';
    return rows
        .map((row) =>
            [
                `- name: "${yamlStr(row.name)}"`,
                `  domain: "${yamlStr(row.domain)}"`,
                `  image: "${yamlStr(row.image)}"`,
                `  title: "${yamlStr(row.title)}"`,
                `  description: "${yamlStr(row.description)}"`,
                `  order_key: "${yamlStr(row.order_key)}"`,
            ].join('\n'),
        )
        .join('\n');
}

async function main() {
    console.log('🚀 Starting Featured Portal metadata crawl...');
    const readmeContent = fs.readFileSync(README_PATH, 'utf8');
    const rawLgus = parseTable(readmeContent, '<!-- SYNC_LGU_TABLE_START -->', '<!-- SYNC_LGU_TABLE_END -->');
    const lgus = rawLgus.map(validateLgu);

    // #122: eligibility gate #1 — status must be Active. Domain is required
    // by construction: no domain means nothing to crawl, so such an Entry can
    // never satisfy the completeness gate.
    const candidates = lgus.filter((lgu) => lgu.status === '🟢 Active' && lgu.domain && lgu.domain !== '-');

    const previous = parseExistingLguMeta(LGU_META_PATH);
    const rows = [];
    // One entry per portal kept out of the pool — each entry being that
    // portal's summaries — tallied at the end of the run.
    const rejections = [];

    for (const entry of candidates) {
        const { label: displayDomain, url: origin } = extractDomainLink(entry.domain);
        try {
            const { row, reason: rejection } = await crawlEntry(entry, displayDomain, origin);
            if (row) {
                rows.push(row);
                console.log(`  ✅ ${displayDomain} — featured row generated`);
            } else {
                // A rejection with no reason would be a bug in this script, not
                // a fact about the portal — say so rather than dereferencing
                // null and having the catch below blame the network for it.
                const described = rejection || reason('rejected without a stated reason (bug)');
                rejections.push(described.summaries);
                console.log(`  ⛔ ${displayDomain} — ineligible: ${described.message}`);
            }
        } catch (err) {
            if (!(err instanceof PortalUnreachableError)) {
                rejections.push(['crawl error (not a portal problem)']);
                console.log(`  ⛔ ${displayDomain} — crawl error: ${err.stack || err.message}`);
            } else if (previous.has(displayDomain)) {
                rows.push(previous.get(displayDomain));
                console.log(`  ⚠️  ${displayDomain} — unreachable this run (${err.message}); kept previous row`);
            } else {
                rejections.push(['unreachable, with no previous row to keep']);
                console.log(`  ⛔ ${displayDomain} — unreachable and no previous row (${err.message})`);
            }
        }
    }

    const dataDir = path.dirname(LGU_META_PATH);
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(LGU_META_PATH, formatLguMetaYaml(rows));
    console.log(`🎉 Featured pool: ${rows.length} eligible portal(s). Written to ${LGU_META_PATH}`);

    const summaryBlock = formatIneligibleSummary(rejections);
    if (summaryBlock) {
        console.log(`\n${summaryBlock}`);
    }
}

if (require.main === module) {
    main().catch((err) => {
        console.error(`\n❌ CRAWL FAILED: ${err.stack || err.message}`);
        process.exit(1);
    });
}

module.exports = {
    USER_AGENT,
    PortalUnreachableError,
    crawlEntry,
    IMAGE_SIZE_CEILING_BYTES,
    BOILERPLATE_DESCRIPTION,
    BOILERPLATE_TITLE,
    normalizeWhitespace,
    isBoilerplate,
    missingMetaReason,
    boilerplateReason,
    imageRejectionReason,
    formatIneligibleSummary,
    sha1First8,
    extractMeta,
    parseTagAttrs,
    extractDomainLink,
    parseExistingLguMeta,
    formatLguMetaYaml,
};
