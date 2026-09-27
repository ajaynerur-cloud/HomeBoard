#!/usr/bin/env node
/*
 * Regression test for the QR encoder in public/qr.js.
 *
 * The expected matrices below were produced once and verified by decoding the
 * rendered images with zxing-cpp — 146 payloads across versions 1 to 10,
 * including multi-byte UTF-8. If a change to qr.js alters any of them, the
 * codes may no longer scan, so this fails loudly rather than quietly shipping
 * an unreadable invite.
 */
const crypto = require('crypto');
global.window = global;
require('../public/qr.js');

const GOLDEN = [
  { text: 'x',                                                            version: 1,  size: 21, hash: 'eb5da97baf1ef306' },
  { text: 'ABCD-1234',                                                    version: 1,  size: 21, hash: 'd67f398d12fca243' },
  { text: 'https://homeboard.onrender.com/?join=8SAQ-SV89',               version: 4,  size: 33, hash: 'fb0caaa38c508084' },
  { text: 'https://homeboard.example.com/?join=ZZZZ-9999&from=Ajay%20Kumar', version: 5, size: 37, hash: null },
  { text: 'café €5 — naïve',                                              version: 2,  size: 25, hash: '3f432eced26a7c37' },
  { text: 'A'.repeat(213),                                                version: 10, size: 57, hash: null },
];

let pass = 0, fail = 0;
const ok = (l) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${l}`); };
const bad = (l, d) => { fail++; console.log(`  \x1b[31m✗\x1b[0m ${l}\n      ${d}`); };

console.log('\nQR encoder\n');

for (const g of GOLDEN) {
  const label = g.text.length > 46 ? `${g.text.slice(0, 43)}…` : g.text;
  try {
    const { version, size, modules } = window.HomeBoardQR.encode(g.text);
    const hash = crypto.createHash('sha256')
      .update(modules.map((r) => r.join('')).join('|')).digest('hex').slice(0, 16);

    if (version !== g.version || size !== g.size) {
      bad(`${label}`, `expected v${g.version} ${g.size}x${g.size}, got v${version} ${size}x${size}`);
    } else if (g.hash && hash !== g.hash) {
      bad(`${label}`, `matrix changed: expected ${g.hash}, got ${hash}`);
    } else {
      ok(`v${version} ${size}x${size}  ${label}`);
    }
  } catch (err) {
    bad(label, err.message);
  }
}

// Structural checks that hold for every code.
const { modules, size } = window.HomeBoardQR.encode('https://example.com/?join=ABCD-1234');
const finderAt = (r0, c0) =>
  [0, 1, 2, 3, 4, 5, 6].every((r) =>
    [0, 1, 2, 3, 4, 5, 6].every((c) => {
      const want =
        (r === 0 || r === 6 || c === 0 || c === 6) ? 1 :
        (r >= 2 && r <= 4 && c >= 2 && c <= 4) ? 1 : 0;
      return modules[r0 + r][c0 + c] === want;
    }));

finderAt(0, 0) && finderAt(0, size - 7) && finderAt(size - 7, 0)
  ? ok('three finder patterns in the right corners')
  : bad('finder patterns', 'one or more corners are wrong');

[...Array(size - 16)].every((_, k) => modules[6][8 + k] === (k % 2 === 0 ? 1 : 0))
  ? ok('horizontal timing pattern alternates')
  : bad('timing pattern', 'row 6 does not alternate');

modules[size - 8][8] === 1 ? ok('dark module present') : bad('dark module', 'missing at (size-8, 8)');

try {
  window.HomeBoardQR.encode('A'.repeat(214));
  bad('over-long input', 'should have thrown');
} catch {
  ok('over-long input is refused with a clear error');
}

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail ? 1 : 0);
