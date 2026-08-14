const express       = require('express');
const session        = require('express-session');
const FileStoreInit  = require('session-file-store');
const rateLimit      = require('express-rate-limit');
const { spawn }      = require('child_process');
const fs             = require('fs');
const path           = require('path');
const os             = require('os');
const crypto         = require('crypto');

const store     = require('./lib/store');
const auth      = require('./lib/auth');
const credCrypto = require('./lib/crypto');

const FileStore = FileStoreInit(session);

const app  = express();
const PORT = process.env.PORT || 3030;

const SCRIPT  = path.join(__dirname, 'bethpage_book.py');
const PYTHON  = process.platform === 'win32' ? 'python' : 'python3';
const WATCHER_ID_RE = /^[\w-]+_\d+$/;

app.set('trust proxy', 1);
app.use(express.json());

// ── Sessions ─────────────────────────────────────────────────────────────────
let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  sessionSecret = crypto.randomBytes(32).toString('hex');
  console.warn('[warn] SESSION_SECRET not set — using an ephemeral secret. ' +
               'All sessions will be invalidated on restart. Set SESSION_SECRET in production.');
}

app.use(session({
  store: new FileStore({ path: path.join(store.DATA_DIR, 'sessions'), logFn: () => {} }),
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  },
}));

app.use(express.static(path.join(__dirname, 'public')));

// ── Health check (no auth, no file I/O — used by Fly's health checks) ────────
app.get('/healthz', (req, res) => res.status(200).send('ok'));

// ── Auth ───────────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many attempts. Try again later.' },
});

// Fixed bcrypt hash of a random value — used so login timing doesn't reveal
// whether an email is registered (compare always runs, even on unknown email).
const DUMMY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEeOaVpMFVaLzZfADmfNz78m5xNc3wOm93m';

app.post('/api/auth/signup', authLimiter, async (req, res) => {
  const { email, password, inviteCode } = req.body || {};
  if (!email || !password) return res.status(400).json({ ok: false, error: 'Email and password required' });
  if (password.length < 8) return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters' });
  if (!auth.checkInviteCode(inviteCode)) return res.status(403).json({ ok: false, error: 'Invalid invite code' });

  const normEmail = String(email).trim().toLowerCase();

  try {
    const user = await store.updateUsers(async (users) => {
      if (users.some(u => u.email === normEmail)) {
        throw new Error('EMAIL_TAKEN');
      }
      const passwordHash = await auth.hashPassword(password);
      const newUser = { id: crypto.randomUUID(), email: normEmail, passwordHash, createdAt: new Date().toISOString() };
      users.push(newUser);
      return newUser;
    });
    req.session.userId = user.id;
    req.session.email  = user.email;
    res.json({ ok: true, email: user.email });
  } catch (e) {
    if (e.message === 'EMAIL_TAKEN') return res.status(409).json({ ok: false, error: 'Email already registered' });
    console.error(e);
    res.status(500).json({ ok: false, error: 'Signup failed' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  const normEmail = String(email || '').trim().toLowerCase();
  const users = store.getUsers();
  const user  = users.find(u => u.email === normEmail);

  const ok = await auth.verifyPassword(password || '', user ? user.passwordHash : DUMMY_HASH);
  if (!user || !ok) return res.status(401).json({ ok: false, error: 'Invalid email or password' });

  req.session.userId = user.id;
  req.session.email  = user.email;
  res.json({ ok: true, email: user.email });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ ok: false });
  res.json({ ok: true, email: req.session.email });
});

// ── Facilities (per user) ───────────────────────────────────────────────────
app.get('/api/facilities', auth.requireAuth, (req, res) => {
  const facilities = store.getFacilities(req.session.userId);
  const sanitized  = facilities.map(({ password, credit_card_id, ...rest }) => rest);
  res.json(sanitized);
});

app.post('/api/facilities', auth.requireAuth, async (req, res) => {
  const body = req.body || {};
  if (!body.name) return res.json({ ok: false, error: 'Facility name required' });

  const facility = {
    id:             body.id || crypto.randomUUID(),
    name:           body.name,
    site:           body.site || 'foreupsoftware',
    facilityId:     body.facilityId || '',
    bookingUrl:     body.bookingUrl || '',
    username:       body.username || '',
    password:       credCrypto.encrypt(body.password),
    credit_card_id: credCrypto.encrypt(body.credit_card_id),
    courses:        Array.isArray(body.courses) ? body.courses : [],
  };

  await store.updateFacilities(req.session.userId, (facilities) => { facilities.push(facility); });
  res.json({ ok: true });
});

function findFacilityForCourse(userId, scheduleId) {
  const facilities = store.getFacilities(userId);
  return facilities.find(fac => (fac.courses || []).some(c => String(c.id) === String(scheduleId))) || null;
}

// ── Watcher state helpers (per user) ────────────────────────────────────────
function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Prunes dead processes from state on each read.
function getWatchers(userId) {
  return store.updateState(userId, (state) => {
    for (const [id, w] of Object.entries(state)) {
      if (!isAlive(w.pid)) delete state[id];
    }
    return state;
  });
}

// ── API: list watchers ───────────────────────────────────────────────────────
app.get('/api/watchers', auth.requireAuth, async (req, res) => {
  const state = await getWatchers(req.session.userId);
  res.json(Object.entries(state).map(([id, w]) => ({ id, ...w })));
});

// ── API: start a watcher ─────────────────────────────────────────────────────
app.post('/api/watchers/start', auth.requireAuth, async (req, res) => {
  const userId = req.session.userId;
  const { dates, scheduleId, bookingClass, players, afterTime, beforeTime, facilityName, courseName, autoBook, snipe } = req.body;
  if (!dates?.length) return res.json({ ok: false, error: 'No dates provided' });
  if (!scheduleId)    return res.json({ ok: false, error: 'No course selected' });

  const fac = findFacilityForCourse(userId, scheduleId);
  if (!fac) return res.json({ ok: false, error: 'No facility configured for that course. Add it first.' });

  const id = `${scheduleId}_${Date.now()}`;

  const args = [PYTHON, '-u', SCRIPT];
  if (autoBook !== false) args.push('--book');
  if (snipe)              args.push('--snipe');
  dates.forEach(d => args.push('--date', d));
  args.push('--course', scheduleId);
  if (bookingClass) args.push('--booking-class', bookingClass);
  if (players)      args.push('--players', String(players));
  if (afterTime)    args.push('--after',  afterTime);
  if (beforeTime)   args.push('--before', beforeTime);

  const log = store.logFile(userId, id);
  store.ensureDir(store.logsDir(userId));
  fs.writeFileSync(log, '');
  const fd = fs.openSync(log, 'w');

  // Resolve + decrypt this one facility's credentials for this one spawn only —
  // passed via env (not argv, not a shared temp file) so it never appears in
  // `ps` output and can't collide with another concurrent watcher's creds.
  const decryptedFac = {
    ...fac,
    password:       credCrypto.decrypt(fac.password),
    credit_card_id: credCrypto.decrypt(fac.credit_card_id),
  };

  const child = spawn(args[0], args.slice(1), {
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, TEE_CREDS: JSON.stringify(decryptedFac) },
  });
  child.on('error', err => {
    fs.appendFileSync(log, `[spawn error] ${err.message}\n`);
  });
  child.unref();
  fs.closeSync(fd);

  await store.updateState(userId, (state) => {
    state[id] = {
      pid: child.pid,
      scheduleId, bookingClass, dates, players, afterTime, beforeTime,
      facilityName, courseName,
      autoBook: autoBook !== false,
      snipe: !!snipe,
      startedAt: new Date().toISOString(),
    };
  });

  res.json({ ok: true, id, pid: child.pid });
});

// ── API: stop a watcher ──────────────────────────────────────────────────────
app.post('/api/watchers/:id/stop', auth.requireAuth, async (req, res) => {
  const userId = req.session.userId;
  const id = req.params.id;
  if (!WATCHER_ID_RE.test(id)) return res.status(400).json({ ok: false, error: 'Invalid id' });

  const state = store.loadState(userId);
  const w = state[id];
  if (!w) return res.status(404).json({ ok: false, error: 'Not found' });

  try { process.kill(w.pid, 'SIGTERM'); } catch { /* already dead */ }
  await store.updateState(userId, (s) => { delete s[id]; });
  res.json({ ok: true });
});

// ── API: get log tail ────────────────────────────────────────────────────────
app.get('/api/watchers/:id/log', auth.requireAuth, (req, res) => {
  const id = req.params.id;
  if (!WATCHER_ID_RE.test(id)) return res.json({ lines: [] });
  const lines = parseInt(req.query.lines || '80');
  try {
    const content = fs.readFileSync(store.logFile(req.session.userId, id), 'utf8');
    const all = content.split('\n').filter(Boolean);
    res.json({ lines: all.slice(-lines) });
  } catch {
    res.json({ lines: [] });
  }
});

// ── API: stream log (SSE) ────────────────────────────────────────────────────
app.get('/api/watchers/:id/stream', auth.requireAuth, (req, res) => {
  const id = req.params.id;
  if (!WATCHER_ID_RE.test(id)) return res.status(400).end();
  const userId = req.session.userId;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const file = store.logFile(userId, id);
  let offset = 0;

  try {
    const content = fs.readFileSync(file, 'utf8');
    offset = Buffer.byteLength(content);
    content.split('\n').filter(Boolean).forEach(line => {
      res.write(`data: ${JSON.stringify(line)}\n\n`);
    });
  } catch {}

  const interval = setInterval(() => {
    try {
      const stat = fs.statSync(file);
      if (stat.size > offset) {
        const buf = Buffer.alloc(stat.size - offset);
        const fd  = fs.openSync(file, 'r');
        fs.readSync(fd, buf, 0, buf.length, offset);
        fs.closeSync(fd);
        offset = stat.size;
        buf.toString('utf8').split('\n').filter(Boolean).forEach(line => {
          res.write(`data: ${JSON.stringify(line)}\n\n`);
        });
      }
    } catch {}
  }, 1000);

  req.on('close', () => clearInterval(interval));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Tee Time UI  →  http://localhost:${PORT}`);
  console.log(`Phone (WiFi) →  http://${getLocalIp()}:${PORT}`);
});

function getLocalIp() {
  for (const iface of Object.values(os.networkInterfaces()).flat()) {
    if (iface.family === 'IPv4' && !iface.internal) return iface.address;
  }
  return 'localhost';
}
