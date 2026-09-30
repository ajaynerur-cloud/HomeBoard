# HomeBoard — files to update

**New-task push notifications.** The moment someone adds a task for you — or hands you one — your
phone gets a notification, even with HomeBoard closed. Permission is asked for straight after
sign-in; nobody has to find a switch.

## Copy these into your repo

```
server/push.js                      (new) Web Push + Firebase sender, device list
server/routes/push.js               (new) /api/push/config · subscribe · unsubscribe · test
server/index.js                     mounts the routes, starts push, health shows push status
server/store.js                     adds the push.json collection
server/routes/tasks.js              pushes on new task and on reassign
server/routes/auth.js               deleting an account removes its devices
public/app.js                       asks on sign-in, registers the device, banner, tap-to-open
public/sw.js                        shows pushes with the app closed; opens the task on tap
public/index.html                   the banner and Account → New tasks
package.json                        web-push; @capacitor/push-notifications; test:push
render.yaml                         FCM_SERVICE_ACCOUNT
.github/workflows/android.yml       writes google-services.json from a secret
scripts/patch-android-manifest.js   checks the push plugin, FCM channel, Firebase file
scripts/setup-android.sh            GOOGLE_SERVICES_JSON for local builds
scripts/push-test.js                (new) 40 assertions, server side
scripts/push-ui-test.js             (new) 16 assertions in real Chromium
README.md                           section 7, API table
```

## After copying

1. `git add -A && git commit -m "Push a notification when a task is added" && git push`
   — Render redeploys. **Browsers and the installed PWA work immediately**; no keys to set.
2. **For the APK**, do the one-off Firebase setup in README §7 (a `GOOGLE_SERVICES_JSON` repo
   secret, and `FCM_SERVICE_ACCOUNT` on Render), then rebuild the APK and reinstall.
3. Check `/api/health` → `"push":{"web":true,"fcm":true}`.

## What happens

- Alice adds *Take the bins out* for Bob → within a second Bob's phone shows
  **New task from Alice — Take the bins out — Home**. Tapping it opens that task.
- Reassigning a task to someone sends **Alice handed you a task**.
- Adding a task for yourself, or editing one without reassigning, sends nothing.
- Signing out stops pushes to that device; deleting the account removes all of them. Devices
  the push service reports as gone (app uninstalled, browser data cleared) are pruned.
- A push never slows down or fails the request that created the task.

## About "override the permission"

The app now asks by itself the moment you sign in, keeps a banner up until it's answered, and asks
again on the next tap if the first prompt was ignored. What it cannot do — no app can — is tick
*Allow* on the person's behalf: Android 13+ and every browser require that one tap. On Android 12
and older there is no prompt at all; notifications are on from install.

## Tests

All green: smoke 46 · store 9 · qr 10 · reminders 39 · ui 42 · push 31 (+9 with `HB_TEST_FCM=1`)
· push-ui 16.
