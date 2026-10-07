/*
 * Fingerprint unlock, in a real browser.
 *   npm start & node scripts/fingerprint-test.js [baseUrl]
 *
 * Browser half: Chromium's virtual authenticator stands in for the phone's
 * fingerprint sensor (WebAuthn, user verification required).
 * APK half: a stand-in NativeBiometric plugin, the way the Capacitor bridge
 * exposes @capgo/capacitor-native-biometric — matched, cancelled, and failing.
 */
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:3000';

const AUTO_NOT_NOW = `
  document.addEventListener('DOMContentLoaded', () => {
    new MutationObserver(() => {
      if (document.querySelector('#sheet-notify.open')) document.querySelector('#notify-later')?.click();
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
  });
`;

// Behaves like the native plugin. window.__bio = 'ok' | 'cancel' | 'fail'
const NATIVE_STUB = `
  window.__bio = 'ok'; window.__bioCalls = 0;
  window.Capacitor = { Plugins: { NativeBiometric: {
    isAvailable: async () => ({ isAvailable: true, biometryType: 3 }),
    verifyIdentity: async () => {
      window.__bioCalls++;
      if (window.__bio === 'cancel') throw Object.assign(new Error('User canceled'), { code: '13' });
      if (window.__bio === 'fail') throw Object.assign(new Error('Too many attempts.'), { code: '7' });
    },
  } } };
`;

let pass = 0, fail = 0;
const check = (l, c, d) => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${l}`); } else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${l} — ${d || ''}`); } };
const visible = async (p, sel) => p.locator(`${sel}:not(.hidden)`).count().then((n) => n === 1);

async function signUp(p, email, name) {
  await p.goto(BASE);
  await p.click('#tab-signup');
  await p.fill('[name=name]', name);
  await p.fill('#auth-form [name=email]', email);
  await p.fill('#auth-form [name=password]', 'homeboard123');
  await p.click('#auth-submit');
  await p.waitForSelector('#app-screen:not(.hidden)');
  await p.waitForTimeout(800);
}

(async () => {
  const b = await chromium.launch(process.env.PLAYWRIGHT_CHROME ? { executablePath: process.env.PLAYWRIGHT_CHROME } : {});
  const s = Date.now();
  const errs = [];

  /* ── Browser: WebAuthn ── */
  console.log('\nFingerprint — browser (WebAuthn)\n');
  const ctx = await b.newContext({ viewport: { width: 430, height: 932 } });
  await ctx.addInitScript(AUTO_NOT_NOW);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(e.message));
  const cdp = await ctx.newCDPSession(p);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
  } });

  await signUp(p, `fp.${s}@demo.com`, 'Finger Fran');
  check('the board offers fingerprint unlock', await visible(p, '#bio-banner'));
  await p.click('#bio-banner-on');
  await p.waitForTimeout(1200);
  check('turning it on registers a credential', (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials.length === 1);
  check('and the banner goes away', !(await visible(p, '#bio-banner')));
  await p.click('#open-account');
  check('Account shows it switched on', await p.isChecked('#bio-toggle'));
  await p.keyboard.press('Escape');
  const tokenBefore = await p.evaluate(() => localStorage.getItem('hb.token'));

  await p.waitForTimeout(1100); // so the refreshed token has a different iat
  await p.reload();
  await p.waitForSelector('#lock-screen:not(.hidden), #app-screen:not(.hidden)');
  await p.waitForTimeout(1500);
  check('reopening goes through the fingerprint, not the password', await p.locator('#auth-screen:not(.hidden)').count() === 0);
  check('and lands on the board', await visible(p, '#app-screen'));
  const tokenAfter = await p.evaluate(() => localStorage.getItem('hb.token'));
  check('the unlock rolls the session over', tokenAfter && tokenAfter !== tokenBefore);

  // Finger not recognised.
  await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false });
  await p.reload();
  await p.waitForSelector('#lock-screen:not(.hidden)');
  await p.waitForTimeout(800);
  check('a finger that does not match leaves it locked', await visible(p, '#lock-screen') && !(await visible(p, '#app-screen')));
  await p.click('#lock-unlock');
  await p.waitForTimeout(1200);
  check('still locked after another try', await visible(p, '#lock-screen'));
  await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: true });
  await p.click('#lock-unlock');
  await p.waitForSelector('#app-screen:not(.hidden)', { timeout: 5000 });
  check('the right finger opens it', true);

  // Password fallback.
  await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false });
  await p.reload();
  await p.waitForSelector('#lock-screen:not(.hidden)');
  await p.click('#lock-password');
  check('"Use my password instead" goes to sign-in', await visible(p, '#auth-screen'));
  check('with the email filled in', (await p.inputValue('#auth-form [name=email]')) === `fp.${s}@demo.com`);
  await p.fill('#auth-form [name=password]', 'homeboard123');
  await p.click('#auth-submit');
  await p.waitForSelector('#app-screen:not(.hidden)');
  check('and the password still works', true);

  // Signing out turns it off.
  await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: true });
  p.on('dialog', (d) => d.accept());
  await p.click('#open-account');
  await p.click('#signout-btn');
  await p.waitForTimeout(800);
  check('signing out clears fingerprint unlock', await p.evaluate(() => localStorage.getItem('hb.bio')) === null);
  await p.reload();
  await p.waitForTimeout(800);
  check('so the next open asks for the password', await visible(p, '#auth-screen') && !(await visible(p, '#lock-screen')));

  /* ── APK: native plugin ── */
  console.log('\nFingerprint — Android app (native plugin stood in for)\n');
  const ctx2 = await b.newContext({ viewport: { width: 430, height: 932 } });
  await ctx2.addInitScript(AUTO_NOT_NOW);
  await ctx2.addInitScript(NATIVE_STUB);
  const a = await ctx2.newPage();
  a.on('pageerror', (e) => errs.push(e.message));
  await signUp(a, `fpa.${s}@demo.com`, 'Android Andy');
  await a.click('#open-account');
  check('Account offers fingerprint in the APK', await visible(a, '#bio-block'));
  await a.check('#bio-toggle');
  await a.waitForTimeout(500);
  check('turning it on asks for the finger once', await a.evaluate(() => window.__bioCalls) === 1);
  check('and saves it as native', await a.evaluate(() => JSON.parse(localStorage.getItem('hb.bio')).kind) === 'native');

  await a.reload();
  await a.waitForSelector('#app-screen:not(.hidden)', { timeout: 5000 });
  check('reopening the app unlocks with the fingerprint prompt', await a.evaluate(() => window.__bioCalls) === 1);

  await a.addInitScript(() => { window.__bio = 'cancel'; });
  await a.reload();
  await a.waitForTimeout(1000);
  check('cancelling the prompt keeps it locked', await visible(a, '#lock-screen'));
  check('without a scary error', !(await visible(a, '#lock-alert')));
  await a.evaluate(() => { window.__bio = 'fail'; });
  await a.click('#lock-unlock');
  await a.waitForTimeout(400);
  check('a real failure says so', await visible(a, '#lock-alert'), await a.textContent('#lock-alert'));
  await a.evaluate(() => { window.__bio = 'ok'; });
  await a.click('#lock-unlock');
  await a.waitForSelector('#app-screen:not(.hidden)', { timeout: 5000 });
  check('then the finger opens it', true);

  check('no page errors', errs.length === 0, errs.join(' | '));
  await b.close();
  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
