// Zero-dependency regression test for the Logo wall predicate (#179) in
// crawl-lgu-meta.js — same shape as test-featured-eligibility.js: no
// package.json / test runner on either branch, plain Node `assert`. Run with:
//
//   node scripts/test-logo-eligibility.js
//
// It exits non-zero on any failure.
//
// Covers: the candidate chain order (SVG rel=icon > other rel=icon > largest
// manifest icon > apple-touch-icon > favicon.ico), the 64px floor (SVG
// exempt), the 1.2MB byte ceiling, and SVG sanitization
// (script/foreignObject/external href rejected). Isolated function tests
// against fixed inputs — no live HTTP — matching test-featured-eligibility.js;
// the wired end-to-end behaviour (fetch -> candidate -> row) is left to a
// live/manual run, same split as the Featured predicate's two test files.

const assert = require('assert');
const {
    LOGO_MIN_PX,
    LOGO_MAX_BYTES,
    linkTags,
    declaredPx,
    logoCandidates,
    intrinsicPx,
    svgIsUnsafe,
} = require('./crawl-lgu-meta.js');

let failures = 0;
function test(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
    } catch (err) {
        failures++;
        console.log(`  ❌ ${name}\n     ${err.message}`);
    }
}

async function asyncTest(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
    } catch (err) {
        failures++;
        console.log(`  ❌ ${name}\n     ${err.message}`);
    }
}

console.log('\nlinkTags() / declaredPx()');

test('parses rel, href, sizes and type off a <link> tag', () => {
    const [tag] = linkTags('<link rel="icon" href="/icon.svg" type="image/svg+xml">');
    assert.strictEqual(tag.rel, 'icon');
    assert.strictEqual(tag.href, '/icon.svg');
    assert.strictEqual(tag.type, 'image/svg+xml');
});

test('declaredPx reads the first WxH pair out of a sizes attribute', () => {
    assert.strictEqual(declaredPx('32x32'), 32);
    assert.strictEqual(declaredPx('180x180'), 180);
    assert.strictEqual(declaredPx(''), 0);
    assert.strictEqual(declaredPx('any'), 0);
});

console.log('\nlogoCandidates() — chain order');

(async () => {
    await asyncTest('ranks SVG rel=icon above every other source', async () => {
        const html = `
            <link rel="apple-touch-icon" href="/apple-touch-icon.png">
            <link rel="icon" href="/favicon.png">
            <link rel="icon" type="image/svg+xml" href="/favicon.svg">
        `;
        const candidates = await logoCandidates('https://example.test/', html);
        assert.strictEqual(candidates[0].source, 'rel-icon-svg');
        assert.ok(candidates[0].url.endsWith('/favicon.svg'));
    });

    await asyncTest('ranks any other rel=icon above apple-touch-icon', async () => {
        const html = `
            <link rel="apple-touch-icon" href="/apple-touch-icon.png">
            <link rel="icon" href="/favicon.png">
        `;
        const candidates = await logoCandidates('https://example.test/', html);
        const relIcon = candidates.findIndex((c) => c.source === 'rel-icon');
        const appleTouch = candidates.findIndex((c) => c.source === 'apple-touch-icon');
        assert.ok(relIcon < appleTouch, 'rel-icon must be tried before apple-touch-icon');
    });

    await asyncTest('apple-touch-icon ranks above favicon.ico', async () => {
        const html = `<link rel="apple-touch-icon" href="/apple-touch-icon.png">`;
        const candidates = await logoCandidates('https://example.test/', html);
        const appleTouch = candidates.findIndex((c) => c.source === 'apple-touch-icon');
        const favicon = candidates.findIndex((c) => c.source === 'favicon.ico');
        assert.ok(appleTouch < favicon, 'apple-touch-icon must be tried before favicon.ico');
    });

    await asyncTest('favicon.ico is always present as the last-resort candidate', async () => {
        const candidates = await logoCandidates('https://example.test/', '<html></html>');
        assert.ok(candidates.some((c) => c.source === 'favicon.ico'));
        assert.strictEqual(candidates[candidates.length - 1].source, 'favicon.ico');
    });

    await asyncTest('a manifest with no reachable link contributes no candidate, chain still resolves', async () => {
        const html = `<link rel="manifest" href="/manifest.json">`;
        const candidates = await logoCandidates('https://example.test/', html);
        assert.ok(candidates.every((c) => c.source !== 'manifest'));
        assert.ok(candidates.some((c) => c.source === 'favicon.ico'));
    });

    await asyncTest('resolves relative hrefs against the page URL', async () => {
        const html = `<link rel="icon" href="icons/favicon.png">`;
        const candidates = await logoCandidates('https://example.test/sub/', html);
        const relIcon = candidates.find((c) => c.source === 'rel-icon');
        assert.strictEqual(relIcon.url, 'https://example.test/sub/icons/favicon.png');
    });

    console.log('\nintrinsicPx()');

    test('reads PNG intrinsic width from the IHDR chunk', () => {
        const png = Buffer.alloc(24);
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
        png.writeUInt32BE(64, 16);
        assert.deepStrictEqual(intrinsicPx(png, 'image/png'), { px: 64, ext: 'png' });
    });

    test('treats SVG as vector (Infinity px), exempt from the size floor', () => {
        const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
        const result = intrinsicPx(svg, 'image/svg+xml');
        assert.strictEqual(result.ext, 'svg');
        assert.strictEqual(result.px, Infinity);
    });

    test('reports an unrecognized format as bin', () => {
        const result = intrinsicPx(Buffer.from('not an image'), 'application/octet-stream');
        assert.strictEqual(result.ext, 'bin');
    });

    console.log('\nLOGO_MIN_PX / LOGO_MAX_BYTES constants');

    test('the size floor is 64px', () => {
        assert.strictEqual(LOGO_MIN_PX, 64);
    });

    test('the byte ceiling is 1.2MB', () => {
        assert.strictEqual(LOGO_MAX_BYTES, 1.2 * 1024 * 1024);
    });

    console.log('\nsvgIsUnsafe()');

    test('passes a plain, self-contained SVG', () => {
        assert.strictEqual(svgIsUnsafe(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>')), false);
    });

    test('rejects an SVG containing <script>', () => {
        assert.strictEqual(
            svgIsUnsafe(Buffer.from('<svg><script>alert(1)</script></svg>')),
            true,
        );
    });

    test('rejects an SVG containing <foreignObject>', () => {
        assert.strictEqual(
            svgIsUnsafe(Buffer.from('<svg><foreignObject><body xmlns="http://www.w3.org/1999/xhtml">x</body></foreignObject></svg>')),
            true,
        );
    });

    test('rejects an SVG with an external href', () => {
        assert.strictEqual(
            svgIsUnsafe(Buffer.from('<svg><image href="https://evil.test/x.png"/></svg>')),
            true,
        );
    });

    test('rejects an SVG with an external xlink:href', () => {
        assert.strictEqual(
            svgIsUnsafe(Buffer.from('<svg><use xlink:href="http://evil.test/sprite.svg#x"/></svg>')),
            true,
        );
    });

    test('allows an SVG with a same-document href fragment', () => {
        assert.strictEqual(
            svgIsUnsafe(Buffer.from('<svg><use href="#local-symbol"/></svg>')),
            false,
        );
    });

    test('allows an SVG with a data: URI href', () => {
        assert.strictEqual(
            svgIsUnsafe(Buffer.from('<svg><image href="data:image/png;base64,AAAA"/></svg>')),
            false,
        );
    });

    console.log(failures === 0 ? '\n✅ All Logo eligibility tests passed.\n' : `\n❌ ${failures} test(s) failed.\n`);
    process.exit(failures === 0 ? 0 : 1);
})();
