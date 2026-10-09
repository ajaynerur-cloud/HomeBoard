#!/usr/bin/env node
/*
 * The app version lives in three places that must agree, or a phone can end
 * up running a new page with old code (or the other way round):
 *   public/index.html   <meta name="hb-version">  and every ?v= on its tags
 *   public/sw.js        VERSION and the ?v= in its SHELL list
 * Run before committing a front-end change:  node scripts/version-check.js
 */
const fs = require('fs');
const path = require('path');
const pub = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const html = pub('index.html');
const sw = pub('sw.js');
const v = (html.match(/<meta name="hb-version" content="([^"]+)"/) || [])[1];
const problems = [];
if (!v) problems.push('index.html has no <meta name="hb-version">');
for (const [, q] of html.matchAll(/\?v=([^"']+)/g)) if (q !== v) problems.push(`index.html has ?v=${q}, meta says ${v}`);
const swv = (sw.match(/const VERSION = 'homeboard-v([^']+)'/) || [])[1];
if (swv !== v) problems.push(`sw.js VERSION is v${swv}, index.html says ${v}`);
for (const [, q] of sw.matchAll(/\?v=([^"']+)/g)) if (q !== v) problems.push(`sw.js SHELL has ?v=${q}, expected ${v}`);
for (const f of ['app.js', 'app.css', 'qr.js', 'repeat.js']) {
  if (!html.includes(`/${f}?v=${v}`)) problems.push(`index.html does not load /${f}?v=${v}`);
  if (!sw.includes(`/${f}?v=${v}`)) problems.push(`sw.js does not cache /${f}?v=${v}`);
}
if (problems.length) { console.error('Version mismatch:\n  ' + problems.join('\n  ')); process.exit(1); }
console.log(`App version ${v} — index.html and sw.js agree.`);
