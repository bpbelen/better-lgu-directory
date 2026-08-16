// PROTOTYPE — throwaway. Answers: what do the real Logos look like on a wall,
// and what is the real cull rate of the favicon-family chain?
// Not production code. No tests, no retries, minimal error handling.
//
// Chain (per the grilling session): apple-touch-icon -> web manifest icons
// (largest) -> <link rel=icon> -> /favicon.ico
//
//   node prototype/logo-wall/crawl-logos-prototype.js

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { README_PATH, parseTable, validateLgu } = require('../../scripts/sync-to-data.js');

const OUT_DIR = path.join(__dirname, 'logos');
const MIN_PX = 64;
const MAX_BYTES = Number(process.env.MAX_KB || 200) * 1024;

function get(url, { maxRedirects = 5 } = {}) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('http://') ? http : https;
        const req = lib.get(
            url,
            {
                timeout: 15000,
                headers: {
                    'user-agent':
                        'Mozilla/5.0 (compatible; better-lgu-directory-prototype/0.0; +https://lgu.bettergov.ph)',
                    accept: '*/*',
                },
            },
            (res) => {
                const { statusCode, headers } = res;
                if (statusCode >= 300 && statusCode < 400 && headers.location) {
                    res.resume();
                    if (maxRedirects === 0) return reject(new Error('too many redirects'));
                    return resolve(
                        get(new URL(headers.location, url).toString(), { maxRedirects: maxRedirects - 1 }),
                    );
                }
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () =>
                    resolve({ statusCode, headers, body: Buffer.concat(chunks), finalUrl: url }),
                );
            },
        );
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
    });
}

// --- crude HTML tag scraping. Good enough for a prototype. ---
function linkTags(html) {
    return [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => {
        const tag = m[0];
        const attr = (name) => {
            const re = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
            const hit = tag.match(re);
            return hit ? (hit[2] ?? hit[3] ?? hit[4] ?? '').trim() : '';
        };
        return { rel: attr('rel').toLowerCase(), href: attr('href'), sizes: attr('sizes'), type: attr('type') };
    });
}

function sizeOf(sizes) {
    const m = /(\d+)\s*x\s*(\d+)/i.exec(sizes || '');
    return m ? Number(m[1]) : 0;
}

async function candidates(pageUrl, html) {
    const out = [];
    const links = linkTags(html);
    const abs = (href) => new URL(href, pageUrl).toString();

    for (const l of links.filter((l) => l.rel.includes('apple-touch-icon') && l.href))
        out.push({ source: 'apple-touch-icon', url: abs(l.href), declaredPx: sizeOf(l.sizes) || 180 });

    const manifestLink = links.find((l) => l.rel.includes('manifest') && l.href);
    if (manifestLink) {
        try {
            const res = await get(abs(manifestLink.href));
            const icons = JSON.parse(res.body.toString('utf8')).icons || [];
            for (const i of icons)
                if (i.src)
                    out.push({
                        source: 'manifest',
                        url: new URL(i.src, res.finalUrl).toString(),
                        declaredPx: sizeOf(i.sizes),
                    });
        } catch {
            /* prototype: a broken manifest is just one fewer candidate */
        }
    }

    for (const l of links.filter((l) => /(^|\s)icon(\s|$)/.test(l.rel) && l.href))
        out.push({
            source: 'rel-icon',
            url: abs(l.href),
            declaredPx: sizeOf(l.sizes),
            svg: l.type === 'image/svg+xml' || l.href.endsWith('.svg'),
        });

    out.push({ source: 'favicon.ico', url: abs('/favicon.ico'), declaredPx: 0 });

    // Prefer transparent-artwork sources over apple-touch-icon. Apple's own
    // spec expects apple-touch-icon to be an OPAQUE square with internal
    // padding — fine on iOS, but on the plateless Logo wall (variant B) that
    // reads as a boxy tile next to floating marks from rel=icon/SVG sources.
    // SVG rel-icon ranks highest (vector, almost always transparent, no
    // resolution ceiling), then any other rel-icon, then the manifest (mixed:
    // maskable icons carry the same opaque-square convention as
    // apple-touch-icon), then apple-touch-icon itself, then the raw favicon.
    const rank = (c) => {
        if (c.source === 'rel-icon' && c.svg) return 0;
        if (c.source === 'rel-icon') return 1;
        if (c.source === 'manifest') return 2;
        if (c.source === 'apple-touch-icon') return 3;
        return 4; // favicon.ico
    };
    return out.sort((a, b) => rank(a) - rank(b) || b.declaredPx - a.declaredPx);
}

// PNG/ICO/SVG intrinsic size, zero-dep. Prototype-grade.
function intrinsicPx(buf, contentType) {
    if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
        return { px: buf.readUInt32BE(16), ext: 'png' };
    if (buf.slice(0, 4).equals(Buffer.from([0x00, 0x00, 0x01, 0x00]))) {
        let max = 0;
        const n = buf.readUInt16LE(4);
        for (let i = 0; i < n; i++) max = Math.max(max, buf[6 + i * 16] || 256);
        return { px: max, ext: 'ico' };
    }
    const head = buf.slice(0, 400).toString('utf8');
    if (/<svg/i.test(head) || (contentType || '').includes('svg')) return { px: Infinity, ext: 'svg' };
    if (buf.slice(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return { px: 0, ext: 'jpg' };
    if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP')
        return { px: 0, ext: 'webp' }; // prototype: don't parse VP8 headers
    return { px: 0, ext: 'bin' };
}

function unsafeSvg(buf) {
    const s = buf.toString('utf8');
    return /<script|<foreignObject|xlink:href\s*=\s*["']?https?:|href\s*=\s*["']?https?:/i.test(s);
}

async function tryCandidate(c) {
    const res = await get(c.url);
    if (res.statusCode !== 200) return { ok: false, why: `HTTP ${res.statusCode}` };
    const ct = (res.headers['content-type'] || '').toLowerCase();
    if (ct.includes('html')) return { ok: false, why: 'served HTML (SPA catch-all)' };
    if (res.body.length === 0) return { ok: false, why: 'empty body' };
    if (res.body.length > MAX_BYTES)
        return { ok: false, why: `over ${Math.round(MAX_BYTES / 1024)}KB ceiling (${Math.round(res.body.length / 1024)}KB)` };
    const { px, ext } = intrinsicPx(res.body, ct);
    if (ext === 'svg' && unsafeSvg(res.body)) return { ok: false, why: 'SVG failed sanitize' };
    if (ext === 'bin') return { ok: false, why: `unrecognized format (${ct || 'no content-type'})` };
    if (px < MIN_PX) return { ok: false, why: `${px}px, under the ${MIN_PX}px floor` };
    return { ok: true, buf: res.body, ext, px, source: c.source, url: c.url };
}

async function main() {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const rows = parseTable(
        fs.readFileSync(README_PATH, 'utf8'),
        '<!-- SYNC_LGU_TABLE_START -->',
        '<!-- SYNC_LGU_TABLE_END -->',
    )
        .map(validateLgu)
        .filter((r) => (r.status || '').includes('🟢'));
    console.log(`${rows.length} Active entries\n`);

    const results = [];
    for (const row of rows) {
        // `domain` is the raw markdown cell: [label](https://…)
        const portal = (/\((https?:\/\/[^)]+)\)/.exec(row.domain) || [])[1];
        let domain;
        try {
            domain = new URL(portal).hostname.replace(/^www\./, '');
        } catch {
            results.push({ name: row.name, ok: false, why: `unparseable portal cell: ${row.domain}` });
            continue;
        }
        let html;
        try {
            const page = await get(portal);
            if (page.statusCode !== 200) throw new Error(`HTTP ${page.statusCode}`);
            html = page.body.toString('utf8');
        } catch (err) {
            results.push({ name: row.name, domain, ok: false, why: `page fetch failed: ${err.message}` });
            console.log(`✗ ${domain} — page fetch failed: ${err.message}`);
            continue;
        }

        const tried = [];
        let won = null;
        for (const c of await candidates(portal, html)) {
            let r;
            try {
                r = await tryCandidate(c);
            } catch (err) {
                r = { ok: false, why: err.message };
            }
            tried.push(`${c.source} ${c.url} → ${r.ok ? 'OK' : r.why}`);
            if (r.ok) {
                won = r;
                break;
            }
        }

        if (!won) {
            results.push({ name: row.name, domain, ok: false, why: 'no candidate passed', tried });
            console.log(`✗ ${domain} — no candidate passed (${tried.length} tried)`);
            continue;
        }

        const file = `${domain}.${won.ext}`;
        fs.writeFileSync(path.join(OUT_DIR, file), won.buf);
        results.push({
            name: row.name,
            domain,
            portal,
            ok: true,
            file,
            source: won.source,
            px: won.px === Infinity ? 'vector' : won.px,
            bytes: won.buf.length,
        });
        console.log(`✓ ${domain} — ${won.source}, ${won.px === Infinity ? 'vector' : won.px + 'px'}, ${Math.round(won.buf.length / 1024)}KB`);
    }

    fs.writeFileSync(path.join(__dirname, 'logos.json'), JSON.stringify(results, null, 2));
    const ok = results.filter((r) => r.ok).length;
    console.log(`\n${ok}/${results.length} Active entries produced a Logo (cull rate ${Math.round((1 - ok / results.length) * 100)}%)`);
}

main();
