# Logo wall prototype — findings

Throwaway. Answers Q26 (heading/copy) from the grilling session, and incidentally
re-opened Q25 (byte ceiling) and Q12 (marquee threshold).

## Run it

```
node prototype/logo-wall/crawl-logos-prototype.js     # writes logos/ + logos.json
curl -so prototype/logo-wall/live-index.html https://lgu.bettergov.ph/
node prototype/logo-wall/build-prototype.js           # writes logo-wall-prototype.html
python3 -m http.server 8791 --directory prototype/logo-wall
```

`MAX_KB=1200` on the crawler raises the byte ceiling.

`logos/` and `live-index.html` are not committed — regenerate them.

## Variants

Injected into the **real live home page**, between the Featured hero and the
directory table. Switch with `?variant=`, the bottom bar, or ← / →.

- **A — Count-led band.** Asymmetric: big live count + heading on the left, single
  marquee rail on the right, white background.
- **B — Full-bleed ornament, two rows.** No heading at all, two rows scrolling in
  opposite directions, smaller plates, gray background.
- **C — Static centred grid.** No motion, centred heading + count subline, all
  logos visible at once. Doubles as a preview of the reduced-motion fallback.

## What the crawl actually found

26 Active entries, favicon-family chain (apple-touch-icon → manifest → rel=icon →
/favicon.ico).

| Byte ceiling | Logos | Cull rate |
|---|---|---|
| 200KB (the Q25 recommendation) | 16/26 | 38% |
| 1.2MB | 23/26 | 12% |

**The 200KB ceiling was wrong.** 7 of its 10 failures were the ceiling itself, not
missing logos — portals commonly ship unoptimized favicons (529KB, 643KB, 803KB,
1061KB). At 1.2MB only three entries fail, and all three fail for real reasons:

- `betterlaspinas.org` — only a 32px favicon.ico, under the 64px floor
- `bettergeneraltrias.org` — only a 48px favicon.ico, under the floor
- `betterindang.org` — declares `/favicon.svg`, serves 404. No icon at all.

Those three are exactly the "your portal needs to expose a bigger mark" cases the
Discussion is for.

**Cost:** 23 logos at a 1.2MB ceiling = **5.2MB** in `main-pages`. That is the real
trade against the 200KB ceiling's 16 logos at well under 1MB.

Other observations:

- `favicon.ico` on SPA-hosted portals frequently returns the app shell as HTML
  rather than a 404 — the content-type check catches it, a status check would not.
- Source distribution: apple-touch-icon won 11, rel=icon won 12, the manifest and
  `/favicon.ico` fallbacks never won once. The manifest step may not earn its code.
- 8 of the 23 are SVG, so the min-size floor never applies to a third of them.
- 23 logos is comfortably over the ~8 threshold from Q12 — the static-grid fallback
  will realistically only ever fire for reduced-motion, not for low counts.
