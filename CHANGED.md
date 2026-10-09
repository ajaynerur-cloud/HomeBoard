# HomeBoard — offline-first sync + fingerprint unlock

## 1. Local copy, manual sync

| Before | Now |
|---|---|
| Every tap went straight to the server; no signal = nothing works. | Every change is saved on the phone first and shows at once. Works with no signal, and opens with no signal. |
| Polled the server every 20 s. | Sync when **you** press it (⟳ button, pull down, or the *Sync now* strip). A badge counts what's waiting. |
| — | **Account → Sync**: auto-sync every 5/15/30/60 min or *Never*, plus *sync when I open or leave* (both on by default as a safety net; turn both off for fully manual). |
| — | Offline edits are folded (create+delete = nothing sent; many edits = one). Conflicts with tasks someone else finished are reported, not silently lost. |
| — | *Save a copy of my data (JSON)* in Account. Sign-out warns about unsynced changes. |

## 2. Fingerprint unlock (mobile)

Sign in with the password once → tap **Turn on** on the *Open with your fingerprint* banner (or
Account → Fingerprint). From then on the app opens to a lock screen and a fingerprint gets you in;
**Use my password instead** is always available. Re-locks after 5 minutes in the background.

- **APK:** Android's native fingerprint prompt (`@capgo/capacitor-native-biometric`). **Rebuild the APK.**
- **Browser / PWA:** the phone's built-in authenticator via WebAuthn (needs HTTPS).

## Files

```
public/app.js                 local store + outbox + sync engine, fingerprint lock
public/index.html             sync badge/strip, Account → Sync + Fingerprint, lock screen
public/app.css                styles for the above
public/sw.js                  version bump (v6)
server/routes/tasks.js        accepts app-made ids/times, replay-safe
server/routes/auth.js         POST /api/auth/refresh
package.json                  + @capgo/capacitor-native-biometric, test scripts
scripts/patch-android-manifest.js   checks the biometric plugin, adds USE_BIOMETRIC
scripts/sync-test.js          (new) 21 assertions
scripts/fingerprint-test.js   (new) 24 assertions
scripts/ui-test.js            updated for manual sync
README.md                     new sections: Offline and sync, Fingerprint unlock
```

Commit and push → Render redeploys. For Android, re-run **Build Android APK** and reinstall.

## Tests

smoke 46 · store 9 · qr 10 · reminders 38 · ui 45 · sync 21 · fingerprint 24 · push 36 · push-android 17 — all green.
`push-ui` can't run headless here (it fails the same way on the original code), so it wasn't re-checked.

## Round 2 — fingerprint fixes

| Problem | Fix |
|---|---|
| Switching fingerprint on flicked straight back off, with no message. | It now always says why: no fingerprint enrolled on the phone, APK built without the plugin (rebuild), browser can't do it, prompt closed. When it can't work on this phone the switch is greyed out with the reason underneath. |
| No fingerprint option on the sign-in screen. | **Sign in with fingerprint** appears above the password form whenever this phone has fingerprint on — after signing out too. In the APK the prompt opens by itself. |
| Signing out turned fingerprint off. | It stays on. The phone holds a device key the server can revoke; turning fingerprint off deletes it on the server. |
| Plugin error codes were read wrongly (cancel vs. failed). | Mapped to what `@capgo/capacitor-native-biometric` 6 actually sends (16 cancel, 10 not recognised, 3 none enrolled…). |

Files this round: `public/app.js`, `public/index.html`, `public/app.css`, `public/sw.js` (v7),
`server/routes/auth.js`, `server/store.js` (new `devices` collection), `scripts/fingerprint-test.js` (33), `README.md`, `CHANGED.md`.

**You must rebuild the APK** (Actions → Build Android APK) and reinstall — an APK built before the
fingerprint plugin was added cannot read fingerprints, and Account → Fingerprint will now say so.

## Round 3 — don't wake Render at sign-in

- **Fingerprint** and **a password this phone already knows** sign in on the phone and open the board
  straight away; the server session is fetched afterwards in the background. No waking screen.
- First download on a new phone runs behind a *Fetching your boards…* placeholder.
- Notification setup and sign-out no longer show the waking screen.
- With fingerprint on, signing out keeps the local copy on the phone.

Files this round: `public/app.js`, `public/sw.js` (v8), `package.json`, `scripts/login-test.js` (new, 16),
`README.md`, `CHANGED.md`. No server change. The APK carries its own copy of the app, so **re-run
Build Android APK** to get this on the phone app.

## Round 4 — repeating tasks (daily, weekly, recurring reminders)

- **Repeat** in the task form: every day · every weekday · every week · every 2 weeks · every month ·
  custom (every N days/weeks/months, pick weekdays). Live preview of the next 3 dates.
- Done → a line in Finished, and the task moves to its next date (steps unticked, details kept,
  notes cleared). Reminders follow it, so a daily task reminds you daily.
- ↻ on the card and in the task view. Works offline; Undo works before or after syncing.
- A sync no longer hides an Undo that's still on screen.

Files this round: `public/repeat.js` (new, shared with the server), `public/app.js`, `public/index.html`,
`public/app.css`, `public/sw.js` (v9), `server/routes/tasks.js`, `package.json`,
`scripts/repeat-rules-test.js` (new, 18), `scripts/repeat-test.js` (new, 23), `README.md`, `CHANGED.md`.
The APK carries its own copy of the app, so **re-run Build Android APK** and reinstall to get this on
the phone app (the browser/PWA picks it up on its own).

## Round 5 — "I don't see Repeat"

The phone was running an older copy of the app. The APK carries its own copy, and a browser
serves the one its service worker cached — so a server update alone doesn't reach it.

- **Account** footer now shows the app version (e.g. `v10`), and the server's if they differ.
- After a sync, an out-of-date app shows **"A newer HomeBoard is out"** — in the browser with an
  **Update** button; in the APK telling you to install the new APK.
- Page and code are now cached as a matching pair (`?v=10`), so a phone can never mix an old page
  with new code. `npm run version:check` keeps the three version numbers in step.

Files this round: `public/index.html`, `public/app.js`, `public/sw.js` (v10), `server/index.js`
(`/api/health` reports `appVersion`), `package.json`, `scripts/version-check.js` (new),
`scripts/update-test.js` (new), `CHANGED.md`.

**To see Repeat on the phone:** push, then **GitHub → Actions → Build Android APK → Run workflow**,
download the new APK and install it over the old one.
