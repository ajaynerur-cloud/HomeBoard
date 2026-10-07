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
