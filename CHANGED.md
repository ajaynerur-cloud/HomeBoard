# HomeBoard — files to update

Reminders now warn you **before** a task is due, not only as it passes, and every reminder
carries a **Snooze 10 min** button.

## Copy these into your repo

```
public/app.js               scheduling, snooze, lead time, notification channel
public/index.html           the lead-time control and the background-apps help
public/app.css              styles for those
scripts/reminders-test.js   39 assertions covering all of it
README.md                   documentation
```

Keep the paths exactly as they are in this folder.

```bash
cd /path/to/your/homeboard
cp -r /path/to/homeboard-update/public   .
cp -r /path/to/homeboard-update/scripts  .
cp    /path/to/homeboard-update/README.md .

git add public/app.js public/index.html public/app.css scripts/reminders-test.js README.md
git commit -m "Reminders: warn before the deadline, add snooze"
git push
```

Nothing changed on the server, so Render redeploying is enough for the web version. For Android,
**rebuild the APK** — the reminder logic lives in the bundled web assets.

## If you did not apply the previous update

The last one fixed the greyed-out "Allow notifications" switch. If you skipped it, these files are
not enough on their own — use the full zip instead. That update touched:

```
package.json                Capacitor packages moved into devDependencies
render.yaml                 npm install --omit=dev
.github/workflows/android.yml
scripts/setup-android.sh
scripts/patch-android-manifest.js   (new)
public/app.js
scripts/reminders-test.js   (new)
README.md
```

Quick check: if `package.json` has a `devDependencies` block listing `@capacitor/...`, you are
up to date and the five files above are all you need.

## What changed

**Two reminders per task.** One at a chosen lead time before the deadline — 10 minutes by default,
settable to 5, 15, 30, 60 or off — and one at the due time. A task due at 21:30 warns you at 21:20,
then again at 21:30.

**Snooze.** Both reminders carry a *Snooze 10 min* button. Snoozed reminders live in their own id
range so the app's twenty-second refresh cannot cancel them, which it otherwise would.

**They fire with the app closed.** These are alarms registered with Android, delivered by a
broadcast receiver that does not need the app running. Swiping HomeBoard out of recents does not
stop them, and they survive a reboot. They now go out on a dedicated max-importance channel, so
they arrive as a heads-up with sound rather than sliding silently into the shade.

**Phones that kill background apps** — Realme, Oppo, Xiaomi, Samsung, OnePlus — will still hold
alarms back, and no app-side code can override that. Settings now has a
*Reminders not arriving when the app is closed?* section with the exact steps.

## A bug this round caught

`leadMinutes()` read the saved setting with `Number(localStorage.getItem(...))`. For an unset value
that is `Number(null)`, which is **0**, not `NaN` — so the default of 10 minutes never applied and
the early warning was never scheduled for anyone who had not changed the setting. Fixed, and
covered by a test.
