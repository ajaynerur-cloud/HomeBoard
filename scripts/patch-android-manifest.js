#!/usr/bin/env node
/*
 * Adds the permissions Capacitor's own plugin manifests don't declare, and
 * checks the ones that matter actually made it in.
 *
 * SCHEDULE_EXACT_ALARM is the one that matters here. Without it, Android 12
 * and later downgrade a scheduled reminder to an inexact alarm, which can
 * arrive many minutes after the task was actually due — useless for "take the
 * bins out before the lorry comes". With it declared, the user can grant
 * "Alarms & reminders" and reminders land on the minute.
 *
 * Run after `cap add android`, before the Gradle build. Safe to run twice.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'android');
const MANIFEST = path.join(ROOT, 'app', 'src', 'main', 'AndroidManifest.xml');
const PLUGINS = path.join(ROOT, 'app', 'src', 'main', 'assets', 'capacitor.plugins.json');

const EXTRA = [
  ['android.permission.SCHEDULE_EXACT_ALARM', 'reminders that arrive on the minute'],
  ['android.permission.POST_NOTIFICATIONS', 'showing a reminder at all on Android 13+'],
  ['android.permission.RECEIVE_BOOT_COMPLETED', 'reminders surviving a restart'],
  ['android.permission.VIBRATE', 'the reminder buzzing'],
];

const REQUIRED_PLUGINS = ['@capacitor/local-notifications', '@capacitor/app'];

function fail(msg) {
  console.error(`\n!! ${msg}\n`);
  process.exit(1);
}

if (!fs.existsSync(MANIFEST)) fail(`No manifest at ${MANIFEST}. Run "npx cap add android" first.`);

/*
 * Plugins are discovered from package.json, not from node_modules. Installing
 * them with --no-save leaves them on disk but invisible to the Capacitor CLI,
 * which produces an APK with no notification code in it — and Android then
 * greys out "Allow notifications" because the app declares no way to post one.
 * That shipped once; this check is here so it cannot ship again.
 */
let registered = [];
try {
  registered = JSON.parse(fs.readFileSync(PLUGINS, 'utf8')).map((p) => p.pkg);
} catch {
  fail(`Could not read ${PLUGINS}.`);
}
const missing = REQUIRED_PLUGINS.filter((p) => !registered.includes(p));
if (missing.length) {
  fail(
    `Capacitor did not register: ${missing.join(', ')}\n` +
    `   Registered: ${registered.length ? registered.join(', ') : '(none)'}\n` +
    `   These must be listed in package.json — installing with --no-save hides them from the CLI.`
  );
}
console.log(`Plugins registered: ${registered.join(', ')}`);

let xml = fs.readFileSync(MANIFEST, 'utf8');
const added = [];
for (const [perm, why] of EXTRA) {
  if (xml.includes(`android:name="${perm}"`)) continue;
  xml = xml.replace(
    /(\n\s*)<uses-permission android:name="android\.permission\.INTERNET" \/>/,
    `$1<!-- ${why} -->$1<uses-permission android:name="${perm}" />$&`
  );
  added.push(perm);
}

if (!xml.includes('android.permission.INTERNET')) fail('The manifest has no INTERNET permission — something is very wrong.');

fs.writeFileSync(MANIFEST, xml);
console.log(added.length ? `Added: ${added.map((p) => p.split('.').pop()).join(', ')}` : 'Permissions already present.');

const finalPerms = [...xml.matchAll(/uses-permission android:name="([^"]+)"/g)].map((m) => m[1].split('.').pop());
console.log(`Manifest now declares: ${finalPerms.join(', ')}`);
