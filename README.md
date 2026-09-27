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

- **Sign up / sign in** — email + password, bcrypt-hashed, JWT sessions that last 30 days.
- **Boards** — one board per household or project. Invite by email, or share an 8-character join code.
- **Push a task to someone** — pick any member as the owner. It lands on their "For me" tab.
- **Live countdown** — `2h 23m left`, `5h overdue`. Colour-coded, refreshes on its own.
- **Details** — free-text notes, a checklist of steps, priority, and a due date with one-tap presets.
- **Track** — tabs for *For me*, *Whole board*, *I assigned*, and *Finished*.
- **Hand off** — reassign a task to someone else from inside it.
- **Notes** — a comment thread per task, so "where's the key?" doesn't become a phone call.
- **Complete = purge** — details, steps and notes are deleted; a name-only line goes into Finished.
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

It then runs full-screen with its own icon, and opens offline.

### 5. (Optional) Build a real APK

If you want an installable `.apk` — to sideload, or to put on Play Store:

**In the cloud, no tools needed:**

Your repo → **Actions** → **Build Android APK** → **Run workflow** → paste your
Render URL → run it. About four minutes later, download `HomeBoard-debug-apk`
from the run's Artifacts. Transfer to the phone and open it.

**Or locally**, with Android Studio installed:

```bash
# put your Render URL in capacitor.config.json → server.url first
./scripts/setup-android.sh
cd android && ./gradlew assembleDebug
# → android/app/build/outputs/apk/debug/app-debug.apk
```

For Play Store you'll need `assembleRelease` with your own signing key — the
debug APK is for sideloading only.

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

That runs 30 assertions across signup, invites, assignment, permission
boundaries, and the complete-and-purge behaviour.

Two more suites:

```bash
npm run test:store   # the GitHub datastore against a fake Contents API —
                     # sha conflicts, 20 concurrent writers, queue recovery
npm run test:ui      # 21 real browser assertions through the whole UI
                     # (needs: npm i --no-save playwright)
```

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
| `GET` | `/tasks` | live tasks on your boards |
| `POST` | `/tasks` | create / push to someone |
| `PATCH` | `/tasks/:id` | edit, reassign, tick a step |
| `POST` | `/tasks/:id/comments` | add a note |
| `POST` | `/tasks/:id/complete` | **delete the task**, keep a name-only record |
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
- Rate limits: 20 auth attempts per IP per 15 minutes, 300 API calls per minute.
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
  app.css           design system, light + dark
  sw.js             offline shell cache
  manifest.webmanifest
  icons/
scripts/
  smoke-test.js     30 end-to-end API assertions
  store-test.js     GitHub datastore under conflict + concurrency
  ui-test.js        21 browser assertions through the real UI
  setup-android.sh  builds the native project
resources/          1024px icon + splash, used for the Android build
.github/workflows/
  android.yml       cloud APK build
render.yaml         Render deploy config
capacitor.config.json
```

MIT.
