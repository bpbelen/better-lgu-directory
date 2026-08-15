// PROTOTYPE — throwaway. Three variants of the Logo wall, switchable via
// ?variant=, injected into the REAL live home page (fetched to live-index.html)
// between the Featured hero and the directory table. Sub-shape A.
//
//   node prototype/logo-wall/build-prototype.js
//   then serve this directory and open logo-wall-prototype.html

const fs = require('fs');
const path = require('path');

const dir = __dirname;
const logos = require('./logos.json').filter((r) => r.ok);

// The count is a claim about the directory, so it comes from the count of
// Active entries — NOT from how many Logos happened to fetch. Sourcing it from
// the crawl would make the headline number drop whenever a portal shipped a
// broken favicon, which reads as "LGUs left the movement".
const total = require('./logos.json').length;
const activeCount = total;

const itemsFrom = (list) =>
    list
        .map(
            (l) => `<li class="lw-item">
    <a class="lw-link" href="https://${l.domain}" title="${l.name}">
      <img class="lw-img" src="./logos/${l.file}" alt="${l.name}" loading="lazy">
    </a>
  </li>`,
        )
        .join('\n  ');

const items = itemsFrom(logos);
// B's second row is offset so the two rows aren't the same sequence twice.
const itemsOffset = itemsFrom(logos.slice(Math.floor(logos.length / 2)).concat(logos.slice(0, Math.floor(logos.length / 2))));

// The marquee track is duplicated so the loop is seamless.
const track = (extraClass = '', src = items) =>
    `<ul class="lw-track ${extraClass}" aria-label="Better LGU portals">
  ${src}
  ${src.replace(/<li class="lw-item">/g, '<li class="lw-item" aria-hidden="true" tabindex="-1">')}
</ul>`;

// Bounded: always exactly one row tall, however many Logos there are. The
// overflow scrolls instead of wrapping, so the directory table below never
// gets pushed further down as the directory grows.
const rail = `<ul class="lw-rail" aria-label="Better LGU portals">
  ${items}
</ul>`;

const variants = {
    A: {
        name: 'Count-led band',
        html: `<section class="lw lw-a" data-variant="A">
  <div class="lw-inner lw-a-inner">
    <div class="lw-a-copy">
      <div class="lw-count">${activeCount}</div>
      <h2 class="lw-a-heading">LGU portals live<br>and counting</h2>
    </div>
    <div class="lw-a-rail">
      <div class="lw-marquee">${track()}</div>
    </div>
  </div>
</section>`,
    },
    B: {
        name: 'Full-bleed ornament, two rows',
        html: `<section class="lw lw-b" data-variant="B">
  <div class="lw-marquee">${track('lw-fwd')}</div>
  <div class="lw-marquee lw-b-second">${track('lw-rev', itemsOffset)}</div>
</section>`,
    },
    C: {
        name: 'Scrollable rail, no auto-motion',
        html: `<section class="lw lw-c" data-variant="C">
  <div class="lw-inner">
    <div class="lw-c-head">
      <h2 class="lw-c-heading">The movement so far</h2>
      <p class="lw-c-sub">${activeCount} Better LGU portals — drag or scroll to browse.</p>
    </div>
  </div>
  <div class="lw-c-rail-wrap">${rail}</div>
</section>`,
    },
};

const css = `
<style>
/* ---- PROTOTYPE Logo wall ---- */
.lw { --lw-plate: #fff; --lw-border: #e9ecef; --lw-ink: #212529; --lw-muted: #868e96;
      --lw-primary: #0052bc; font-family: 'Figtree', system-ui, sans-serif; display: none; }
.lw[data-active] { display: block; }
.lw-inner { max-width: 1280px; margin: 0 auto; padding: 0 1rem; }

/* plate + grayscale treatment, shared by every variant */
.lw-item { list-style: none; flex: 0 0 auto; }
.lw-link { display: block; box-sizing: border-box; width: 148px; height: 96px; padding: .6rem;
  background: var(--lw-plate); border: 1px solid var(--lw-border); border-radius: 12px;
  transition: box-shadow .2s ease, transform .2s ease, border-color .2s ease; }
/* Explicit width+height+contain rather than max-*: the page's Tailwind preflight
   sets img height:auto, which lets a large intrinsic logo overflow the
   plate and get clipped by the border radius. */
.lw-img { display: block; width: 100%; height: 100%; object-fit: contain; object-position: center;
  transition: filter .2s ease, opacity .2s ease; }
@media (hover: hover) and (pointer: fine) {
  .lw-img { filter: grayscale(1); opacity: .72; }
  .lw-link:hover .lw-img { filter: grayscale(0); opacity: 1; }
  .lw-link:hover { border-color: #dee2e6; box-shadow: 0 6px 20px rgb(0 0 0 / .10); transform: translateY(-2px); }
}
.lw-link:focus-visible { outline: 3px solid var(--lw-primary); outline-offset: 3px; }
.lw-link:focus-visible .lw-img { filter: grayscale(0); opacity: 1; }

/* marquee mechanics */
.lw-marquee { overflow: hidden; -webkit-mask-image: linear-gradient(90deg, transparent, #000 6%, #000 94%, transparent);
  mask-image: linear-gradient(90deg, transparent, #000 6%, #000 94%, transparent); }
.lw-track { display: flex; gap: 1rem; margin: 0; padding: .5rem 0; width: max-content;
  animation: lw-scroll 70s linear infinite; }
.lw-rev { animation-direction: reverse; }
@keyframes lw-scroll { from { transform: translateX(0); } to { transform: translateX(-50%); } }
.lw-marquee:hover .lw-track, .lw-marquee:focus-within .lw-track { animation-play-state: paused; }

/* bounded rail — one row always, scrolls rather than wraps */
.lw-rail { display: flex; gap: 1rem; margin: 0; padding: .5rem 1rem; list-style: none;
  overflow-x: auto; scroll-snap-type: x proximity; overscroll-behavior-x: contain;
  scrollbar-width: thin; }
.lw-rail .lw-item { scroll-snap-align: start; }

/* ---- A: count-led band ---- */
.lw-a { background: #fff; border-block: 1px solid var(--lw-border); padding: 2.5rem 0; }
.lw-a-inner { display: grid; grid-template-columns: minmax(200px, 260px) 1fr; gap: 2.5rem; align-items: center; }
.lw-count { font-size: 3.75rem; font-weight: 800; line-height: 1; color: var(--lw-primary); letter-spacing: -.03em; }
.lw-a-heading { font-size: 1.15rem; font-weight: 600; color: var(--lw-ink); margin: .5rem 0 0; line-height: 1.3; }
.lw-a-rail { min-width: 0; }
@media (max-width: 760px) { .lw-a-inner { grid-template-columns: 1fr; gap: 1.25rem; text-align: center; } }

/* ---- B: full-bleed ornament ---- */
.lw-b { background: #f8f9fa; padding: 2rem 0; border-block: 1px solid var(--lw-border); }
.lw-b-second { margin-top: 1rem; }
/* No plate in B — the logos sit straight on the background. Trade: a
   white-on-transparent mark has nothing to sit against and disappears. */
.lw-b .lw-link { width: 120px; height: 78px; background: none; border: 0; padding: 0; }
@media (hover: hover) and (pointer: fine) {
  .lw-b .lw-link:hover { box-shadow: none; border-color: transparent; transform: scale(1.06); }
}

/* ---- C: scrollable rail, no auto-motion ---- */
.lw-c { background: #fff; border-block: 1px solid var(--lw-border); padding: 2.5rem 0; }
.lw-c-head { text-align: center; margin-bottom: 1.25rem; }
.lw-c-heading { font-size: 1.75rem; font-weight: 700; color: var(--lw-ink); margin: 0; letter-spacing: -.02em; }
.lw-c-sub { color: var(--lw-muted); margin: .5rem 0 0; }
.lw-c-rail-wrap { max-width: 1280px; margin: 0 auto; }

/* Reduced motion: stop the animation, but stay one row tall — wrapping into a
   grid would push the directory table down further with every new entry. */
@media (prefers-reduced-motion: reduce) {
  .lw-track { animation: none; overflow-x: auto; scrollbar-width: thin; }
  .lw-marquee { overflow: visible; -webkit-mask-image: none; mask-image: none; }
  .lw-track .lw-item[aria-hidden="true"] { display: none; }
}

/* ---- the switcher bar. Deliberately not part of the design being judged. ---- */
#lw-bar { position: fixed; left: 50%; bottom: 1.25rem; transform: translateX(-50%); z-index: 9999;
  display: flex; align-items: center; gap: .25rem; background: #111; color: #fff;
  border-radius: 999px; padding: .35rem .4rem; box-shadow: 0 10px 30px rgb(0 0 0 / .35);
  font: 500 13px/1 ui-monospace, SFMono-Regular, Menlo, monospace; }
#lw-bar button { all: unset; cursor: pointer; padding: .5rem .7rem; border-radius: 999px; }
#lw-bar button:hover { background: #333; }
#lw-bar .lw-label { padding: 0 .75rem; white-space: nowrap; }
#lw-bar .lw-meta { color: #9aa0a6; padding-right: .75rem; }
</style>`;

const js = `
<script>
(function () {
  var keys = ${JSON.stringify(Object.keys(variants))};
  var names = ${JSON.stringify(Object.fromEntries(Object.entries(variants).map(([k, v]) => [k, v.name])))};
  function current() {
    var v = new URLSearchParams(location.search).get('variant');
    return keys.indexOf(v) === -1 ? keys[0] : v;
  }
  function render() {
    var v = current();
    keys.forEach(function (k) {
      var el = document.querySelector('.lw[data-variant="' + k + '"]');
      if (k === v) el.setAttribute('data-active', ''); else el.removeAttribute('data-active');
    });
    document.querySelector('#lw-bar .lw-label').textContent = v + ' — ' + names[v];
  }
  function go(step) {
    var i = keys.indexOf(current());
    var next = keys[(i + step + keys.length) % keys.length];
    var u = new URL(location.href);
    u.searchParams.set('variant', next);
    history.replaceState(null, '', u);
    render();
  }
  document.getElementById('lw-prev').onclick = function () { go(-1); };
  document.getElementById('lw-next').onclick = function () { go(1); };
  document.addEventListener('keydown', function (e) {
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.key === 'ArrowLeft') go(-1);
    if (e.key === 'ArrowRight') go(1);
  });
  render();
})();
</script>`;

const bar = `
<div id="lw-bar">
  <button id="lw-prev" aria-label="Previous variant">←</button>
  <span class="lw-label"></span>
  <button id="lw-next" aria-label="Next variant">→</button>
  <span class="lw-meta">${logos.length}/${total} logos · ${Math.round((1 - logos.length / total) * 100)}% culled</span>
</div>`;

let html = fs.readFileSync(path.join(dir, 'live-index.html'), 'utf8');

// The live page links its assets relatively (assets/css/style.css), which
// resolve against localhost when served from here and 404 — the page renders
// unstyled. Point them back at the real origin.
html = html.replace(/(href|src)="(assets\/)/g, '$1="https://lgu.bettergov.ph/$2');

const wall = Object.values(variants).map((v) => v.html).join('\n');

// Inject between the hero <section> and the <main> that holds the directory table.
const mainIdx = html.indexOf('<main');
if (mainIdx === -1) throw new Error('could not find <main> in live-index.html');
html = html.slice(0, mainIdx) + wall + '\n' + html.slice(mainIdx);

html = html.replace('</head>', css + '\n</head>').replace('</body>', bar + js + '\n</body>');

fs.writeFileSync(path.join(dir, 'logo-wall-prototype.html'), html);
console.log(`wrote logo-wall-prototype.html — ${logos.length} logos, variants ${Object.keys(variants).join(', ')}`);
