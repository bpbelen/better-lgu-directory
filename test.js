// Throwaway check that the bucket/TTL rules in prototype.html behave, run
// against the real extracted source with a minimal DOM stub.
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/proto.check.js', 'utf8');

const stubRow = { innerHTML: '' };
global.document = {
  getElementById: () => stubRow,
  querySelectorAll: () => [],
  querySelector: () => null,
  addEventListener: () => {},
  createElement: () => ({ classList: { contains: () => false } }),
};

const mod = new Function(src + '\n;return { bucket, ttlHours, mixedFor };')();
const { bucket, ttlHours } = mod;

const H = h => new Date(Date.now() - h * 3600000).toISOString();

const cases = [
  [H(0.5), 'today', 1],
  [H(3), 'today', 1],
  [H(30), 'yesterday', 6],
  [H(72), '3 days ago', 6],
  [H(6 * 24), '6 days ago', 6],
  [H(8 * 24), '1 week ago', 168],
  [H(26 * 24), '3 weeks ago', 168],
  [H(45 * 24), '1 month ago', 168],
  [H(214 * 24), '7 months ago', 168],
  [H(400 * 24), '1 year ago', 168],
];

let fail = 0;
for (const [iso, wantBucket, wantTtl] of cases) {
  const gotBucket = bucket(iso);
  const gotTtl = ttlHours(iso);
  const ok = gotBucket === wantBucket && gotTtl === wantTtl;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${wantBucket.padEnd(14)} got "${gotBucket}" ttl=${gotTtl}h (want ${wantTtl}h)`);
}
console.log(fail === 0 ? '\nall bucket/TTL cases pass' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
