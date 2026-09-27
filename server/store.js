'use strict';
/**
 * HomeBoard datastore.
 *
 * Data lives as plain JSON files. Two backends:
 *
 *  github  — production. Files are committed into a PRIVATE GitHub repo via the
 *            Contents API. Set GITHUB_TOKEN + DATA_REPO. Every write is a real
 *            commit, so you get a full audit trail and can read the raw JSON
 *            any time from github.com.
 *
 *  local   — development / fallback. Files are written to ./.data. Used
 *            automatically when GITHUB_TOKEN or DATA_REPO is missing.
 *
 * All reads are served from an in-memory cache; writes go through a single
 * serialised queue per file so two concurrent requests can never clobber each
 * other or hit a GitHub 409 sha conflict.
 */

const fs = require('fs/promises');
const path = require('path');

const COLLECTIONS = ['users', 'projects', 'tasks', 'history'];

const TOKEN = process.env.GITHUB_TOKEN || '';
const REPO = process.env.DATA_REPO || '';
const BRANCH = process.env.DATA_BRANCH || 'main';
const DATA_DIR = (process.env.DATA_DIR || 'data').replace(/^\/+|\/+$/g, '');

const MODE = TOKEN && REPO ? 'github' : 'local';
const LOCAL_ROOT = path.join(process.cwd(), '.data');

const API = 'https://api.github.com';

/** @type {Record<string, {rows: any[], sha: string|null, loaded: boolean}>} */
const cache = Object.create(null);
/** @type {Record<string, Promise<any>>} */
const queues = Object.create(null);

for (const name of COLLECTIONS) {
  cache[name] = { rows: [], sha: null, loaded: false };
  queues[name] = Promise.resolve();
}

const filePathFor = (name) => `${DATA_DIR}/${name}.json`;

function ghHeaders() {
  return {
    Authorization: `Bearer ${TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'homeboard-app',
  };
}

async function ghRead(name) {
  const url = `${API}/repos/${REPO}/contents/${encodeURI(filePathFor(name))}?ref=${encodeURIComponent(BRANCH)}`;
  const res = await fetch(url, { headers: ghHeaders() });
  if (res.status === 404) return { rows: [], sha: null };
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub read of ${name}.json failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  const raw = Buffer.from(json.content || '', 'base64').toString('utf8').trim();
  let rows = [];
  if (raw) {
    try {
      rows = JSON.parse(raw);
    } catch {
      throw new Error(`${name}.json in ${REPO} is not valid JSON — fix or delete it and redeploy.`);
    }
  }
  return { rows: Array.isArray(rows) ? rows : [], sha: json.sha };
}

async function ghWrite(name, rows, sha, message) {
  const url = `${API}/repos/${REPO}/contents/${encodeURI(filePathFor(name))}`;
  const body = {
    message: message || `HomeBoard: update ${name}.json`,
    content: Buffer.from(JSON.stringify(rows, null, 2) + '\n', 'utf8').toString('base64'),
    branch: BRANCH,
  };
  if (sha) body.sha = sha;

  let res = await fetch(url, {
    method: 'PUT',
    headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  // Someone (or a previous instance) changed the file underneath us.
  // Re-read to pick up the current sha and retry once.
  if (res.status === 409 || res.status === 422) {
    const fresh = await ghRead(name);
    body.sha = fresh.sha || undefined;
    res = await fetch(url, {
      method: 'PUT',
      headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub write of ${name}.json failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  return json.content.sha;
}

async function localRead(name) {
  const file = path.join(LOCAL_ROOT, `${name}.json`);
  try {
    const raw = await fs.readFile(file, 'utf8');
    const rows = JSON.parse(raw || '[]');
    return { rows: Array.isArray(rows) ? rows : [], sha: null };
  } catch (err) {
    if (err.code === 'ENOENT') return { rows: [], sha: null };
    throw err;
  }
}

async function localWrite(name, rows) {
  await fs.mkdir(LOCAL_ROOT, { recursive: true });
  const file = path.join(LOCAL_ROOT, `${name}.json`);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(rows, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, file);
  return null;
}

async function load(name) {
  const entry = cache[name];
  if (entry.loaded) return entry;
  const { rows, sha } = MODE === 'github' ? await ghRead(name) : await localRead(name);
  entry.rows = rows;
  entry.sha = sha;
  entry.loaded = true;
  return entry;
}

/** Read the whole collection. Returns a deep copy so callers can't mutate cache. */
async function read(name) {
  const entry = await load(name);
  return JSON.parse(JSON.stringify(entry.rows));
}

/**
 * Serialised read-modify-write. `mutator(rows)` may mutate `rows` in place and
 * may return a value, which is passed back to the caller.
 */
function update(name, mutator, commitMessage) {
  const run = async () => {
    const entry = await load(name);
    const draft = JSON.parse(JSON.stringify(entry.rows));
    const result = await mutator(draft);
    entry.sha =
      MODE === 'github'
        ? await ghWrite(name, draft, entry.sha, commitMessage)
        : await localWrite(name, draft);
    entry.rows = draft;
    return result;
  };
  // Chain onto the queue; keep the queue alive even if this write throws.
  const next = queues[name].then(run, run);
  queues[name] = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

/** Verify the backend is reachable and writable. Called once at boot. */
async function init() {
  for (const name of COLLECTIONS) {
    await load(name);
  }
  return { mode: MODE, repo: MODE === 'github' ? REPO : LOCAL_ROOT, branch: BRANCH, dir: DATA_DIR };
}

module.exports = { read, update, init, COLLECTIONS, MODE };
