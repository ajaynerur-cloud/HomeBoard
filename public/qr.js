/*
 * A small QR Code generator — model 2, byte mode, error correction level M,
 * versions 1 to 10 (up to 213 characters). Enough for a join link.
 *
 * Written out in full rather than pulled from a CDN because the app has to
 * work offline and inside the APK, where there is no network to fetch from.
 *
 * Exposes window.HomeBoardQR.toSvg(text, { size, margin, dark, light }).
 */
(function (global) {
  'use strict';

  /* ---------- GF(256) arithmetic, primitive polynomial 0x11D ---------- */
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function initTables() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

  /** Generator polynomial for `degree` error-correction codewords. */
  function generatorPoly(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= mul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  function ecCodewords(data, count) {
    const gen = generatorPoly(count);
    const res = new Array(count).fill(0);
    for (const byte of data) {
      const factor = byte ^ res[0];
      res.shift();
      res.push(0);
      for (let i = 0; i < count; i++) res[i] ^= mul(gen[i + 1], factor);
    }
    return res;
  }

  /* ---------- version tables, error correction level M ---------- */
  // [ec codewords per block, group1 blocks, group1 data cw, group2 blocks, group2 data cw]
  const VERSIONS = {
    1:  [10, 1, 16, 0, 0],
    2:  [16, 1, 28, 0, 0],
    3:  [26, 1, 44, 0, 0],
    4:  [18, 2, 32, 0, 0],
    5:  [24, 2, 43, 0, 0],
    6:  [16, 4, 27, 0, 0],
    7:  [18, 4, 31, 0, 0],
    8:  [22, 2, 38, 2, 39],
    9:  [22, 3, 36, 2, 37],
    10: [26, 4, 43, 1, 44],
  };

  const ALIGNMENT = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
    7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  };

  const dataCodewordsFor = (v) => {
    const [, g1, d1, g2, d2] = VERSIONS[v];
    return g1 * d1 + g2 * d2;
  };
  const countBitsFor = (v) => (v <= 9 ? 8 : 16);
  const capacityFor = (v) => Math.floor((dataCodewordsFor(v) * 8 - 4 - countBitsFor(v)) / 8);

  /* ---------- BCH codes for the format and version strips ---------- */

  function formatBits(maskIndex) {
    // Level M is 0b00. Five data bits: [ec level (2)][mask (3)].
    const data = (0b00 << 3) | maskIndex;
    let rem = data << 10;
    for (let i = 4; i >= 0; i--) {
      if (rem & (1 << (i + 10))) rem ^= 0b10100110111 << i;
    }
    return ((data << 10) | rem) ^ 0b101010000010010;
  }

  function versionBits(version) {
    let rem = version << 12;
    for (let i = 5; i >= 0; i--) {
      if (rem & (1 << (i + 12))) rem ^= 0b1111100100101 << i;
    }
    return (version << 12) | rem;
  }

  /* ---------- bit buffer ---------- */
  class Bits {
    constructor() { this.bits = []; }
    push(value, length) {
      for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
    }
    get length() { return this.bits.length; }
    toBytes() {
      const out = [];
      for (let i = 0; i < this.bits.length; i += 8) {
        let byte = 0;
        for (let j = 0; j < 8; j++) byte = (byte << 1) | (this.bits[i + j] || 0);
        out.push(byte);
      }
      return out;
    }
  }

  /* ---------- encode the payload into final codewords ---------- */
  function encodeData(bytes, version) {
    const [ecPerBlock, g1, d1, g2, d2] = VERSIONS[version];
    const totalData = dataCodewordsFor(version);

    const bits = new Bits();
    bits.push(0b0100, 4);                       // byte mode
    bits.push(bytes.length, countBitsFor(version));
    for (const b of bytes) bits.push(b, 8);

    // Terminator, then pad to a byte boundary.
    const capacityBits = totalData * 8;
    bits.push(0, Math.min(4, capacityBits - bits.length));
    while (bits.length % 8 !== 0) bits.push(0, 1);

    const data = bits.toBytes();
    const PAD = [0xec, 0x11];
    for (let i = 0; data.length < totalData; i++) data.push(PAD[i % 2]);

    // Split into blocks, compute EC for each, then interleave.
    const blocks = [];
    let at = 0;
    for (let i = 0; i < g1; i++) { blocks.push(data.slice(at, at + d1)); at += d1; }
    for (let i = 0; i < g2; i++) { blocks.push(data.slice(at, at + d2)); at += d2; }
    const ecBlocks = blocks.map((b) => ecCodewords(b, ecPerBlock));

    const out = [];
    const maxData = Math.max(d1, d2);
    for (let i = 0; i < maxData; i++) {
      for (const b of blocks) if (i < b.length) out.push(b[i]);
    }
    for (let i = 0; i < ecPerBlock; i++) {
      for (const b of ecBlocks) out.push(b[i]);
    }
    return out;
  }

  /* ---------- matrix construction ---------- */
  const MASKS = [
    (i, j) => (i + j) % 2 === 0,
    (i) => i % 2 === 0,
    (i, j) => j % 3 === 0,
    (i, j) => (i + j) % 3 === 0,
    (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
    (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
    (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
    (i, j) => (((i + j) % 2) + ((i * j) % 3)) % 2 === 0,
  ];

  function buildMatrix(version, codewords, maskIndex) {
    const size = version * 4 + 17;
    const m = Array.from({ length: size }, () => new Array(size).fill(null));
    const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

    const set = (r, c, v) => { m[r][c] = v ? 1 : 0; reserved[r][c] = true; };

    // Finder patterns and their separators.
    const finder = (top, left) => {
      for (let r = -1; r <= 7; r++) {
        for (let c = -1; c <= 7; c++) {
          const rr = top + r, cc = left + c;
          if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
          const on =
            (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
            (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
            (r >= 2 && r <= 4 && c >= 2 && c <= 4);
          set(rr, cc, on);
        }
      }
    };
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

    // Timing patterns.
    for (let i = 8; i < size - 8; i++) {
      set(6, i, i % 2 === 0);
      set(i, 6, i % 2 === 0);
    }

    // Alignment patterns, skipping the three finder corners.
    const centers = ALIGNMENT[version];
    for (const r of centers) {
      for (const c of centers) {
        if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
          }
        }
      }
    }

    // Dark module.
    set(size - 8, 8, true);

    // Reserve the format strips (values written after masking is chosen).
    for (let i = 0; i < 9; i++) {
      if (m[8][i] === null) { m[8][i] = 0; reserved[8][i] = true; }
      if (m[i][8] === null) { m[i][8] = 0; reserved[i][8] = true; }
    }
    for (let i = 0; i < 8; i++) {
      if (m[8][size - 1 - i] === null) { m[8][size - 1 - i] = 0; reserved[8][size - 1 - i] = true; }
      if (m[size - 1 - i][8] === null) { m[size - 1 - i][8] = 0; reserved[size - 1 - i][8] = true; }
    }

    // Version strips, versions 7 and up.
    if (version >= 7) {
      const vb = versionBits(version);
      for (let i = 0; i < 18; i++) {
        const bit = (vb >>> i) & 1;
        const a = Math.floor(i / 3);
        const b = (i % 3) + size - 11;
        set(a, b, bit);
        set(b, a, bit);
      }
    }

    // Data, zigzagging up and down two columns at a time.
    let bitIndex = 0;
    let upward = true;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // skip the vertical timing column
      for (let step = 0; step < size; step++) {
        const row = upward ? size - 1 - step : step;
        for (let k = 0; k < 2; k++) {
          const col = right - k;
          if (reserved[row][col]) continue;
          let bit = 0;
          if (bitIndex < codewords.length * 8) {
            bit = (codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1;
          }
          bitIndex++;
          m[row][col] = bit ^ (MASKS[maskIndex](row, col) ? 1 : 0);
        }
      }
      upward = !upward;
    }

    // Now write the real format bits.
    const fb = formatBits(maskIndex);
    for (let i = 0; i < 15; i++) {
      // Most significant bit first: position 0 of each strip carries bit 14.
      const bit = (fb >>> (14 - i)) & 1;
      if (i < 6) m[8][i] = bit;
      else if (i < 8) m[8][i + 1] = bit;
      else if (i === 8) m[7][8] = bit;
      else m[14 - i][8] = bit;

      // The second copy takes 7 modules going up the left of the bottom-right
      // area and 8 along the top-right. Splitting at 8 instead of 7 lands bit 7
      // on the dark module and leaves (8, size-8) never written — which makes
      // every code undecodable.
      if (i < 7) m[size - 1 - i][8] = bit;
      else m[8][size - 15 + i] = bit;
    }
    m[size - 8][8] = 1;

    return m;
  }

  /* ---------- mask scoring, as the spec defines it ---------- */
  function penalty(m) {
    const size = m.length;
    let score = 0;

    // Rule 1: runs of five or more of the same colour.
    const runScore = (line) => {
      let total = 0, run = 1;
      for (let i = 1; i < line.length; i++) {
        if (line[i] === line[i - 1]) run++;
        else { if (run >= 5) total += run - 2; run = 1; }
      }
      if (run >= 5) total += run - 2;
      return total;
    };
    for (let i = 0; i < size; i++) {
      score += runScore(m[i]);
      score += runScore(m.map((row) => row[i]));
    }

    // Rule 2: 2x2 blocks of one colour.
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = m[r][c];
        if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
      }
    }

    // Rule 3: finder-like patterns.
    const A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    const matches = (line, i, pat) => pat.every((v, k) => line[i + k] === v);
    for (let i = 0; i < size; i++) {
      const row = m[i];
      const col = m.map((r) => r[i]);
      for (let j = 0; j + 11 <= size; j++) {
        if (matches(row, j, A) || matches(row, j, B)) score += 40;
        if (matches(col, j, A) || matches(col, j, B)) score += 40;
      }
    }

    // Rule 4: imbalance between dark and light.
    let dark = 0;
    for (const row of m) for (const v of row) if (v) dark++;
    const pct = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;

    return score;
  }

  /* ---------- public API ---------- */
  function toBytes(text) {
    // UTF-8, so accents and the like survive.
    const out = [];
    for (const ch of unescape(encodeURIComponent(text))) out.push(ch.charCodeAt(0));
    return out;
  }

  function encode(text) {
    const bytes = toBytes(text);
    let version = 0;
    for (let v = 1; v <= 10; v++) {
      if (bytes.length <= capacityFor(v)) { version = v; break; }
    }
    if (!version) throw new Error(`Too long for a QR code: ${bytes.length} bytes, limit is ${capacityFor(10)}.`);

    const codewords = encodeData(bytes, version);

    let best = null;
    let bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      const m = buildMatrix(version, codewords, mask);
      const s = penalty(m);
      if (s < bestScore) { bestScore = s; best = m; }
    }
    return { version, size: best.length, modules: best };
  }

  function toSvg(text, opts = {}) {
    const { size = 220, margin = 4, dark = '#16302f', light = '#ffffff' } = opts;
    const { modules, size: n } = encode(text);
    const total = n + margin * 2;

    let path = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (modules[r][c]) path += `M${c + margin} ${r + margin}h1v1h-1z`;
      }
    }
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
      `viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" aria-label="QR code">` +
      `<rect width="${total}" height="${total}" fill="${light}"/>` +
      `<path d="${path}" fill="${dark}"/>` +
      `</svg>`
    );
  }

  global.HomeBoardQR = { encode, toSvg, capacity: capacityFor(10) };
})(typeof window !== 'undefined' ? window : globalThis);
