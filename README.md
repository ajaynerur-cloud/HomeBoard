<p align="center">
  <img src="public/icons/icon-192.png" width="88" alt="HomeBoard">
</p>

<h1 align="center">HomeBoard</h1>

<p align="center"><em>Push to-dos to the people you live with.</em></p>

---

HomeBoard is a shared task board for a household. You create a board, invite the
people you live with, and put tasks on each other's plate. Every task shows the
time left to do it, counting down. When someone marks a task done, its details,
steps and notes are **deleted for good** — only the name is kept, so the board
stays clean but you can still see who did what.

| | |
|---|---|
| **Data** | Plain JSON committed to a **private** GitHub repo. Code lives in a **public** repo. |
| **Hosting** | Render free tier. |
| **Android** | Installable PWA, plus a one-click GitHub Action that builds a real `.apk`. |
| **Cost** | £0. |

## What it does

- **Sign up / sign in** — email + password, bcrypt-hashed, JWT sessions that last 30 days, with a
  show-password toggle because phone keyboards lie.
- **Boards** — one board per household or project. Invite by email, by 8-character code, or by **QR**.
- **Push a task to someone** — pick any member as the owner. It lands on their "For me" tab.
- **Live countdown** — `2h 23m left`, `5h overdue`. Colour-coded, refreshes on its own.
- **Reminders** — a real notification when time runs out. On Android these are scheduled with the
  operating system, so they arrive with HomeBoard closed.
- **Stays in sync** — everyone's board updates on its own. Poll every 20 seconds while the app is
  open, plus a refresh button, pull-to-refresh, and a refresh whenever you come back to it.
- **Details** — free-text notes, a checklist of steps, priority, and a due date with one-tap presets.
- **Track** — tabs for *For me*, *Whole board*, *I assigned*, and *Finished*.
- **Hand off** — reassign a task from inside it, or hand the whole board to someone else.
- **Notes** — a comment thread per task, so "where's the key?" doesn't become a phone call.
- **Read before you finish** — tapping a task opens it. Completing happens from inside, and offers
  an **Undo** for a few seconds, because completing wipes the details.
- **Complete = purge** — details, steps and notes are deleted; a name-only line goes into Finished.
- **Leave properly** — leave a board, hand it over, delete your account and everything on it, or
  close the app from inside it.
- **Works offline** — the app shell is cached; it opens instantly and survives a dead signal.
- **Light and dark** — follows the system, or force one in Account.

## The two repos

This is the part worth understanding before you start.

```
  homeboard              PUBLIC    the code in this folder
  homeboard-data         PRIVATE   users.json, projects.json, tasks.json, history.json
```

The server never stores anything on disk in production. Every write is a commit
to the private repo via the GitHub Contents API. That means: no database to pay
for, a complete history of every change, and you can read your own raw data at
any time by opening the private repo on github.com.

Reads are served from memory and writes are queued per file, so two people
finishing tasks at the same second cannot clobber each other.

---

## Setup

### 1. Create the two repos

On GitHub, create:

- `homeboard` — **public**. Push this folder to it.
- `homeboard-data` — **private**. Leave it empty, but tick *"Add a README"* so the
  default branch exists.

```bash
cd homeboard
git init
git add .
git commit -m "HomeBoard"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/homeboard.git
git push -u origin main
```

### 2. Make a token for the data repo

GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**

- **Repository access**: *Only select repositories* → `homeboard-data`
- **Permissions**: *Repository permissions → Contents → **Read and write***
- Expiry: whatever you're comfortable with (set a calendar reminder to rotate it).

Copy the token. It is shown once.

> Scope it to the data repo only. A token with access to everything is a token
> you'll regret leaving on a free host.

### 3. Deploy to Render

1. [render.com](https://render.com) → **New → Web Service** → connect your `homeboard` repo.
2. Render reads `render.yaml` and fills in the build and start commands.
3. Add the environment variables it asks you for:

   | Key | Value |
   |---|---|
   | `GITHUB_TOKEN` | the token from step 2 |
   | `DATA_REPO` | `YOUR-USERNAME/homeboard-data` |
   | `JWT_SECRET` | leave it — Render generates one |
   | `DATA_BRANCH` | `main` |
   | `DATA_DIR` | `data` |

4. Deploy. You get a URL like `https://homeboard-xxxx.onrender.com`.
5. Open `/api/health` — it should say `"storage": "github"`. If it says `"local"`,
   one of `GITHUB_TOKEN` / `DATA_REPO` is missing or misspelled.

> **Free tier note:** Render spins the service down after 15 minutes of no
> traffic, so the first request after a quiet spell takes 30–50 seconds. Your
> data is safe regardless — it lives in GitHub, not on Render's disk.

### 4. Install it on Android

Open the Render URL in Chrome on the phone → menu (⋮) → **Add to Home screen**.
HomeBoard will also show its own install banner the first time.

Once installed it runs full-screen with its own icon. The app shell is cached on
the device, so it opens straight into HomeBoard even when the server is asleep —
you get HomeBoard's own waking screen, not the host's.

### 5. (Optional) Build a real APK

If you want an installable `.apk` — to sideload, or to put on Play Store:

**In the cloud, no tools needed:**

Your repo → **Actions** → **Build Android APK** → **Run workflow** → paste your
Render URL → run it. About four minutes later, download `HomeBoard-debug-apk`
from the run's Artifacts. Transfer to the phone and open it.

The build checks `/api/health` on the URL you give it before it builds anything,
so a typo fails the workflow in thirty seconds instead of producing an APK that
can never sign anyone in.

**Or locally**, with Android Studio installed:

```bash
./scripts/setup-android.sh https://your-homeboard.onrender.com
cd android && ./gradlew assembleDebug
# → android/app/build/outputs/apk/debug/app-debug.apk
```

**Build on JDK 17, not 21.** Capacitor 6 generates a Gradle 8.2.1 project, and
Gradle only runs on Java 21 from 8.5 onwards, so a newer JDK fails the build
with "Unsupported Java". The workflow pins 17; `setup-android.sh` checks your
local JDK and stops if it's too new.

The `android/` folder is generated, not committed — `cap add android` rebuilds
it from `capacitor.config.json` and `public/` every time, so there's no native
project to keep in sync.

For Play Store you'll need `assembleRelease` with your own signing key — the
debug APK is for sideloading only.

#### How the APK is put together

The APK **bundles its own copy of the web app** and loads it from
`https://localhost` inside the WebView. It does not point the WebView at your
server. It only calls your server for the API, using the URL written into
`public/config.js` at build time.

That one decision is what keeps the host's cold-start page off your screen: the
UI is already on the phone, so the app draws instantly and shows its own waking
screen while the first API call brings the server back. It also means auth has
to be token-based rather than cookie-based across that origin boundary, which is
why the app stores a bearer token — cookies would be dropped.

`public/config.js` is empty in the repo, which is correct for the web version
(same origin, no base URL needed). The Android build rewrites it. If you run
`setup-android.sh` locally, put it back before committing:

```bash
git checkout public/config.js
```

<details>
<summary><strong>If the build fails at "sdkmanager failed with exit code 1"</strong></summary>

You're on an old copy of `.github/workflows/android.yml`. Google removed the
legacy `tools` SDK package in September 2026, and `android-actions/setup-android@v3`
still asks for it by default, so that step fails on every run regardless of your
project.

The workflow in this repo no longer uses that action — `ubuntu-latest` already
ships the Android SDK at `/usr/local/lib/android/sdk`, and the Android Gradle
Plugin downloads whatever platform and build-tools it needs. Replace your
workflow file with the current one and re-run.

If you'd rather keep the action, the minimal patch is to stop it requesting the
dead package:

```yaml
- uses: android-actions/setup-android@v3
  with:
    packages: 'platform-tools'
```
</details>

### 6. Reminders

Turn them on in **Account → Remind me when a task is due**.

In the APK they are scheduled with Android itself, so they arrive whether or not HomeBoard is
running. In a browser they use the Notifications API, which can only fire while the page is open —
the toggle's own description says which one you're getting, so nobody is promised something the
platform won't deliver. Install the app if you want reminders that always arrive.

The Capacitor packages live in `devDependencies`, which matters more than it sounds: **the
Capacitor CLI discovers plugins by reading `package.json`**. Installing them with `--no-save` leaves
them in `node_modules` but invisible to the CLI, and you get an APK with no notification code in it
at all — at which point Android greys out the "Allow notifications" switch in system settings,
because the app declares no way to post one. `scripts/patch-android-manifest.js` runs in the build
and fails it if the plugins did not register, so that cannot happen again.

That script also adds the permissions Capacitor's own manifests leave out, chiefly
`SCHEDULE_EXACT_ALARM`. Without it Android 12 and later downgrade a scheduled reminder to an inexact
alarm that can land many minutes late. With it, the app can ask for "Alarms & reminders" and
reminders arrive on the minute — and if that is off, HomeBoard says reminders may be late rather
than quietly being late.

Render never needs any of this, so `render.yaml` builds with `npm install --omit=dev`.

<details>
<summary><strong>If "Allow notifications" is greyed out in Android settings</strong></summary>

That means the installed APK declares no notification permission — it was built before this was
fixed. Rebuild from the current workflow and reinstall. You can confirm a good build from the
workflow log: the "Check plugins registered" step prints

```
Plugins registered: @capacitor/app, @capacitor/local-notifications
Manifest now declares: SCHEDULE_EXACT_ALARM, POST_NOTIFICATIONS, RECEIVE_BOOT_COMPLETED, VIBRATE, INTERNET
```
</details>

### 7. The cold start, and what to do about it

A free Render service spins down after about 15 minutes with no traffic. The
next request wakes it, which takes 30–50 seconds, and while that happens Render
serves **its own holding page** — the black "SERVICE WAKING UP" screen. That page
comes from Render's edge before your app is running, so no amount of application
code can replace it on a first-ever visit.

What this repo does about it:

| Where | What you see |
|---|---|
| Installed PWA, or any repeat visit | HomeBoard opens instantly from the device cache, then shows **HomeBoard's** waking screen while the API comes back. Render's page never renders. |
| The APK | Same — the UI is bundled in the app. |
| First-ever visit in a browser, service asleep | Render's holding page for ~40 seconds. Unavoidable on the free plan. |

To remove even that last case, keep the service from sleeping:

1. Repo → **Settings → Secrets and variables → Actions → Variables** → add
   `HOMEBOARD_URL` = your live URL.
2. Repo → **Actions** → enable **Keep HomeBoard awake**.

It pings `/api/health` every ten minutes.

> **Read this before you enable it.** A free Render account gets 750
> instance-hours a month and a month is about 730 hours, so keeping *one*
> service awake round the clock just fits. If you run a second free service on
> the same account, you will exhaust the allowance partway through the month and
> **both** will stop until it resets. With two or more, either leave the pinger
> off or move to a paid instance, which doesn't sleep at all.
>
> GitHub also disables scheduled workflows after 60 days with no commits to the
> repo, and its cron can run late under load. It's a workaround, not a guarantee.

---

## Running it locally

```bash
npm install
cp .env.example .env     # leave GITHUB_TOKEN blank to use local files
npm run dev
# → http://localhost:3000
```

Without a token it writes to `./.data/*.json` so you can poke at it without
touching your real data.

Check everything works:

```bash
npm start &
npm run smoke
```

That runs 46 assertions across signup, invites, assignment, permission
boundaries, undo, ownership transfer, account deletion, and the
complete-and-purge behaviour.

Two more suites:

```bash
npm run test:store   # the GitHub datastore against a fake Contents API —
                     # sha conflicts, 20 concurrent writers, queue recovery
npm run test:qr      # the QR encoder against verified golden matrices
npm run test:reminders  # the Android reminder flow against a stand-in plugin —
                     # permission granted, refused, already denied, revoked,
                     # and exact alarms disallowed
npm run test:ui      # 42 real browser assertions through the whole UI
                     # (needs: npm i --no-save playwright && npx playwright install chromium)
```

To check the mobile build's behaviour without building an APK:

```bash
# terminal 1
APP_ORIGIN=http://localhost:3200 PORT=3100 npm start
# terminal 2
SLEEPY=3 npm run test:android
# then open http://localhost:3200
```

That serves the app on its own origin, the way Capacitor serves it from
`https://localhost`, and routes the API through a proxy that plays dead for the
first three requests. You should see HomeBoard's waking screen, never a holding
page, and signup should go through once the proxy stops.

---

## API

All endpoints under `/api`. Auth is a `Bearer` token or the `hb_token` cookie.

| Method | Path | Does |
|---|---|---|
| `POST` | `/auth/signup` | create an account |
| `POST` | `/auth/signin` | sign in |
| `POST` | `/auth/signout` | clear the cookie |
| `GET` | `/auth/me` | current user |
| `GET` | `/projects` | boards you're on |
| `POST` | `/projects` | create a board |
| `PATCH` | `/projects/:id` | rename (owner) |
| `DELETE` | `/projects/:id` | delete board + its tasks (owner) |
| `POST` | `/projects/:id/invite` | invite by email |
| `POST` | `/projects/join` | join with a code |
| `POST` | `/projects/:id/rotate-code` | new join code (owner) |
| `DELETE` | `/projects/:id/members/:userId` | remove someone, or leave |
| `POST` | `/projects/:id/transfer-owner` | hand the board to another member |
| `DELETE` | `/auth/me` | delete the account and everything only it owns |
| `GET` | `/tasks` | live tasks on your boards |
| `POST` | `/tasks` | create / push to someone |
| `PATCH` | `/tasks/:id` | edit, reassign, tick a step |
| `POST` | `/tasks/:id/comments` | add a note |
| `POST` | `/tasks/:id/complete` | **delete the task**, keep a name-only record |
| `POST` | `/tasks/restore` | undo a completion (the task comes back from the client) |
| `DELETE` | `/tasks/:id` | delete with no record |
| `GET` | `/tasks/history/list` | what's been finished |
| `GET` | `/health` | status + which storage backend is live |

## What's stored

```jsonc
// users.json — passwords are bcrypt hashes, never plaintext
{ "id": "usr_…", "name": "Ajay", "email": "…", "passwordHash": "$2a$…",
  "avatarColor": "#0f766e", "createdAt": "…" }

// projects.json
{ "id": "prj_…", "name": "Home", "emoji": "🏠", "ownerId": "usr_…",
  "members": [{ "userId": "usr_…", "role": "owner", "joinedAt": "…" }],
  "inviteCode": "8SAQ-SV89", "createdAt": "…" }

// tasks.json — deleted outright on completion
{ "id": "tsk_…", "projectId": "prj_…", "title": "Take the bins out",
  "details": "Green bin this week. Gate code 4412.",
  "checklist": [{ "id": "chk_…", "text": "Green bin to the kerb", "done": false }],
  "assigneeId": "usr_…", "createdById": "usr_…",
  "dueAt": "…", "priority": "normal", "comments": [], "createdAt": "…", "updatedAt": "…" }

// history.json — all that survives completion
{ "id": "hst_…", "projectId": "prj_…", "title": "Take the bins out",
  "completedById": "usr_…", "assignedToId": "usr_…",
  "completedAt": "…", "wasLate": false }
```

## Security notes

- Passwords: bcrypt, cost 10. Sign-in runs a compare even when the email doesn't
  exist, so response timing doesn't leak which emails are registered.
- Sessions: signed JWTs, `httpOnly` `SameSite=Lax` cookie, `Secure` in production.
- Rate limits: 30 **failed** auth attempts per IP per 15 minutes, 300 API calls per minute.
  Successful sign-ins don't count, because everyone in one house shares a public IP and a flat cap
  locks out the third person trying to sign up. Override with `AUTH_RATE_LIMIT`.
- Every task and board route checks membership before it reads or writes anything.
- Anyone holding a board's join code can join that board — treat it like a door key,
  and use **Reset code** if it gets out.
- Put the app behind HTTPS (Render does this for you). Never commit `.env`.

## Layout

```
server/
  index.js          express app, static hosting, error handling
  store.js          the GitHub-JSON datastore (+ local fallback)
  auth.js           hashing, tokens, the requireAuth middleware
  routes/           auth.js · projects.js · tasks.js
public/
  index.html        the whole UI shell
  app.js            front end — vanilla JS, no framework, no build step
  qr.js             QR encoder, written out in full so invites work offline
  app.css           design system, light + dark
  sw.js             offline shell cache (serves the shell before the network)
  config.js         API base URL — empty for web, written by the Android build
  manifest.webmanifest
  icons/
scripts/
  smoke-test.js     30 end-to-end API assertions
  store-test.js     GitHub datastore under conflict + concurrency
  qr-test.js        QR encoder against verified golden matrices
  reminders-test.js Android reminder flow, plugin stood in for
  patch-android-manifest.js  checks plugins registered, adds alarm permissions
  ui-test.js        21 browser assertions through the real UI
  android-sim.js    stands in for the APK — own origin, sleeping host
  setup-android.sh  builds the native project
resources/          1024px icon + splash, used for the Android build
.github/workflows/
  android.yml       cloud APK build
  keep-warm.yml     optional pinger that stops the free service sleeping
render.yaml         Render deploy config
capacitor.config.json
```

MIT.
