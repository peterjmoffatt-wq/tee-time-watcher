const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

ensureDir(DATA_DIR);

// ── Per-path async mutex ────────────────────────────────────────────────────
// Serializes read-modify-write cycles against the same file, including across
// await gaps (bcrypt hashing, AES encryption) that a plain readFileSync/
// writeFileSync pair does not protect against.
const _locks = new Map(); // absolute path -> promise chain tail

function withFileLock(absPath, fn) {
  const prev = _locks.get(absPath) || Promise.resolve();
  const next = prev.then(fn, fn).finally(() => {
    if (_locks.get(absPath) === next) _locks.delete(absPath);
  });
  _locks.set(absPath, next);
  return next;
}

// ── Atomic JSON read/write ──────────────────────────────────────────────────
function readJson(absPath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(absPath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(absPath, data) {
  ensureDir(path.dirname(absPath));
  const tmp = `${absPath}.tmp-${crypto.randomBytes(6).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, absPath);
}

// ── Paths ────────────────────────────────────────────────────────────────────
const usersFile = () => path.join(DATA_DIR, 'users.json');
const userDir    = (userId) => path.join(DATA_DIR, 'users', userId);
const facilitiesFile = (userId) => path.join(userDir(userId), 'facilities.json');
const watchersFile   = (userId) => path.join(userDir(userId), 'watchers.json');
const logsDir        = (userId) => path.join(userDir(userId), 'logs');
const logFile         = (userId, watcherId) => path.join(logsDir(userId), `${watcherId}.log`);

// ── Users ────────────────────────────────────────────────────────────────────
function getUsers() {
  return readJson(usersFile(), []);
}

function updateUsers(fn) {
  return withFileLock(usersFile(), async () => {
    const users  = readJson(usersFile(), []);
    const result = await fn(users);
    writeJsonAtomic(usersFile(), users);
    return result;
  });
}

// ── Facilities (per user) ───────────────────────────────────────────────────
function getFacilities(userId) {
  return readJson(facilitiesFile(userId), []);
}

function updateFacilities(userId, fn) {
  const file = facilitiesFile(userId);
  return withFileLock(file, async () => {
    const facilities = readJson(file, []);
    const result = await fn(facilities);
    writeJsonAtomic(file, facilities);
    return result;
  });
}

// ── Watchers (per user) ─────────────────────────────────────────────────────
function loadState(userId) {
  return readJson(watchersFile(userId), {});
}

function saveState(userId, state) {
  writeJsonAtomic(watchersFile(userId), state);
}

function updateState(userId, fn) {
  const file = watchersFile(userId);
  return withFileLock(file, async () => {
    const state  = readJson(file, {});
    const result = await fn(state);
    writeJsonAtomic(file, state);
    return result;
  });
}

module.exports = {
  DATA_DIR,
  ensureDir,
  getUsers,
  updateUsers,
  getFacilities,
  updateFacilities,
  loadState,
  saveState,
  updateState,
  userDir,
  logsDir,
  logFile,
};
