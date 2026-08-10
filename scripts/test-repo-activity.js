// Zero-dependency regression test for the repository-URL parsing added by
// #162 (repository activity). This repo has no package.json / test runner on
// either branch, so this is a plain Node script using the built-in `assert`
// module, following the scripts/test-rotation-index.js pattern. Run with:
//
//   node scripts/test-repo-activity.js
//
// It exits non-zero on any failure.
//
// Scope note: #162 splits across two branches (see CONTEXT.md's "Sync
// pipeline" entry and the #132 precedent — data/workflow changes land on
// `main`, site rendering on `main-pages`). This file covers only the `main`
// side: parseRepoCell() in scripts/sync-to-data.js, which is the one place
// that reads a github.com repo URL out of README.md's Repository cell. The
// display-bucket and cache-TTL rules (today/yesterday/N days/weeks/months,
// and the 1h/6h/7d TTL bands) are browser-module logic that lives on
// `main-pages` and are covered by that branch's own test file — they cannot
// be required from here since main has no browser module to import.

const assert = require('assert');
const { parseRepoCell } = require('./sync-to-data.js');

let assertions = 0;
function check(condition, message) {
    assertions++;
    assert.ok(condition, message);
}

// --- canonical github.com repo links ----------------------------------------

{
    const info = parseRepoCell('[GitHub](https://github.com/BetterSolano/bettersolano)');
    check(info.owner === 'BetterSolano', 'parses the owner from a canonical repo link');
    check(info.repo === 'bettersolano', 'parses the repo name from a canonical repo link');
    check(info.ref === undefined, 'a canonical link (no /tree/<ref>) carries no ref');
}

// --- the one non-canonical link in the table: a pinned /tree/<ref> ---------
// (bettercalauan/bettercalauan/tree/react-typescript, per DESIGN.md)

{
    const info = parseRepoCell('[GitHub](https://github.com/bettercalauan/bettercalauan/tree/react-typescript)');
    check(info.owner === 'bettercalauan', 'a pinned link still parses the owner');
    check(info.repo === 'bettercalauan', 'a pinned link still parses the repo name');
    check(info.ref === 'react-typescript', 'the /tree/<ref> segment is preserved as ref');
}

// --- empty cells -------------------------------------------------------------

for (const empty of ['-', '', '—', '–', '  -  ']) {
    check(parseRepoCell(empty) === null, `an empty cell ("${empty}") parses to null, not an error`);
}

// --- cells that don't yield a parseable github.com repo URL ----------------

check(parseRepoCell('[Website](https://example.gov.ph)') === null, 'a non-GitHub link parses to null');
check(parseRepoCell('[GitHub](https://github.com/an-org-with-no-repo)') === null, 'an org/user profile URL with no repo segment parses to null');
check(parseRepoCell('not a markdown link at all') === null, 'a cell with no [label](url) link parses to null');
check(parseRepoCell('[GitHub](https://gitlab.com/owner/repo)') === null, 'a look-alike host (gitlab.com) is not mistaken for github.com');

// --- trailing slash tolerance ------------------------------------------------

{
    const info = parseRepoCell('[GitHub](https://github.com/owner/repo/)');
    check(info.owner === 'owner' && info.repo === 'repo', 'a trailing slash on a canonical link does not corrupt the repo name');
}

// --- purity: repeated calls on the same input agree (no hidden state) -------

{
    const a = parseRepoCell('[GitHub](https://github.com/owner/repo)');
    const b = parseRepoCell('[GitHub](https://github.com/owner/repo)');
    check(JSON.stringify(a) === JSON.stringify(b), 'parseRepoCell is pure — same input, same output');
}

console.log(`✅ ${assertions} assertions passed.`);
