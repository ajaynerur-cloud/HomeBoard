# HomeBoard — files to update (push, round 2)

Fixes for new-task notifications not arriving on Android and in the browser.

## What was wrong, and what changed

| Problem | Fix |
|---|---|
| **Phone browsers never showed the prompt.** Chrome on Android blocks or silently hides a permission prompt that doesn't come from a tap, and the old code asked automatically after sign-in. | Right after sign-in a **Turn on notifications** sheet appears; its button is the tap that asks. It comes back every launch until notifications are on. If they're blocked, it says exactly where to unblock them (Chrome ⓘ → Permissions, installed app → App info, etc.). |
| **iPhone Safari tab** can't receive web push at all. | The sheet tells iPhone users to Add to Home Screen first. |
| **APK built without Firebase never asked for permission at all**, so nothing — not even reminders — could show. | Android's permission dialog now appears at sign-in on every APK build. |
| **Testing with your own account did nothing** — tasks you add for yourself were never pushed. | Adding a task for yourself now buzzes your *other* devices (never the one you used). |
| **After the update, the old app code kept running** from the offline cache until a second reload. | The page reloads itself once when the new version takes over. |
| **No way to see why a push didn't arrive.** | Account → *Troubleshoot notifications* lists each device and the last delivery result, with the push service's error if it failed. `/api/push/status` returns the same. |
| **Tapping a notification that launched the APK** didn't open the task. | The tap is kept until sign-in finishes, then opens the task. |
| Apple's push service rejects the placeholder VAPID contact. | Uses your Render URL automatically (`RENDER_EXTERNAL_URL`). |
| No alert at all on a device that couldn't register for push. | **Backstop:** while HomeBoard is open or in the background, a task newly on your plate raises a notification on the device itself. |

## Important for the APK

Notifications **with the app fully closed** on Android can only come through Firebase — there is no
other way to wake a closed Android app instantly. If you haven't yet, do the one-off setup in
**README §7** (`GOOGLE_SERVICES_JSON` secret in GitHub + `FCM_SERVICE_ACCOUNT` on Render), then
rebuild and reinstall. Without it, Account → New tasks says *"built without Firebase"*, and new
tasks only reach the phone while HomeBoard is open or in the background.

## Copy these into your repo

```
public/app.js                 permission sheet, native ask, backstop, diagnostics, reload-on-update
public/index.html             the Turn on notifications sheet, Troubleshoot panel
public/sw.js                  version bump so phones pick the new code up
server/push.js                self-assign → other devices, delivery log, VAPID subject
server/routes/push.js         GET /api/push/status
server/routes/tasks.js        passes the originating device
server/index.js               allows the X-HB-Device header from the APK
scripts/push-test.js          36 assertions (45 with HB_TEST_FCM=1)
scripts/push-ui-test.js       21 — phone browser, blocked, iPhone, backstop, closed-page push
scripts/push-android-test.js  (new) 17 — APK with and without Firebase, cold-start tap
scripts/ui-test.js            answers "Not now" to the new sheet
scripts/reminders-test.js     reminders are now on by default once allowed
README.md                     §7 updated
CHANGED.md
```

If you didn't apply round 1, use the full zip instead.

Then: commit and push → Render redeploys. For Android, re-run **Build Android APK** and reinstall.

## Check it works

1. On the phone, open HomeBoard, sign in → tap **Turn on notifications → Allow**
   (APK: tap **Allow** on Android's dialog).
2. Account → **Send me a test**. Close the app, and try again from another device.
3. If nothing arrives: Account → **Troubleshoot notifications** shows which step failed.

## Tests

All green: smoke 46 · store 9 · qr 10 · reminders 38 · ui 42 · push 36 (+9 FCM) · push-ui 21 · push-android 17.
