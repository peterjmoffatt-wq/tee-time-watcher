const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app  = express();
const PORT = 3030;

const SCRIPT      = path.join(__dirname, 'bethpage_book.py');
const STATE_FILE  = path.join(os.homedir(), '.tee_watchers.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Watcher state (persisted to disk) ─────────────────────────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return {}; }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

// Prune dead processes from state on each read
function getWatchers() {
  const state = loadState();
  let changed = false;
  for (const [id, w] of Object.entries(state)) {
    if (!isAlive(w.pid)) { delete state[id]; changed = true; }
  }
  if (changed) saveState(state);
  return state;
}

function logFile(watcherId) {
  return path.join(os.homedir(), `.tee_${watcherId}.log`);
}

// ── API: list all watchers ─────────────────────────────────────────────────
app.get('/api/watchers', (req, res) => {
  const watchers = getWatchers();
  res.json(Object.entries(watchers).map(([id, w]) => ({ id, ...w })));
});

// ── API: start a watcher ───────────────────────────────────────────────────
app.post('/api/watchers/start', (req, res) => {
  const { dates, scheduleId, bookingClass, players, afterTime, beforeTime, facilityName, courseName, autoBook, snipe } = req.body;
  if (!dates?.length) return res.json({ ok: false, error: 'No dates provided' });
  if (!scheduleId)    return res.json({ ok: false, error: 'No course selected' });

  const id = `${scheduleId}_${Date.now()}`;
  const state = getWatchers();

  const args = ['python3', '-u', SCRIPT];
  if (autoBook !== false) args.push('--book');
  if (snipe)              args.push('--snipe');
  dates.forEach(d => args.push('--date', d));
  args.push('--course', scheduleId);
  if (bookingClass) args.push('--booking-class', bookingClass);
  if (players)      args.push('--players', String(players));
  if (afterTime)    args.push('--after',  afterTime);
  if (beforeTime)   args.push('--before', beforeTime);

  const log = logFile(id);
  fs.writeFileSync(log, '');
  const fd    = fs.openSync(log, 'w');
  const child = spawn(args[0], args.slice(1), {
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  fs.closeSync(fd);

  state[id] = {
    pid: child.pid,
    scheduleId, bookingClass, dates, players, afterTime, beforeTime,
    facilityName, courseName,
    autoBook: autoBook !== false,
    snipe: !!snipe,
    startedAt: new Date().toISOString(),
  };
  saveState(state);

  res.json({ ok: true, id, pid: child.pid });
});

// ── API: stop a watcher ────────────────────────────────────────────────────
app.post('/api/watchers/:id/stop', (req, res) => {
  const state = getWatchers();
  const w = state[req.params.id];
  if (!w) return res.json({ ok: false, error: 'Not found' });
  try {
    process.kill(w.pid, 'SIGTERM');
    delete state[req.params.id];
    saveState(state);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── API: get log tail ──────────────────────────────────────────────────────
app.get('/api/watchers/:id/log', (req, res) => {
  const lines = parseInt(req.query.lines || '80');
  try {
    const content = fs.readFileSync(logFile(req.params.id), 'utf8');
    const all = content.split('\n').filter(Boolean);
    res.json({ lines: all.slice(-lines) });
  } catch {
    res.json({ lines: [] });
  }
});

// ── API: stream log (SSE) ──────────────────────────────────────────────────
app.get('/api/watchers/:id/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const file = logFile(req.params.id);
  let offset = 0;

  // Send existing content first
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

// ── API: courses ───────────────────────────────────────────────────────────
app.get('/api/courses', (req, res) => {
  res.json(JSON.parse(fs.readFileSync(path.join(__dirname, 'courses.json'), 'utf8')));
});

// ── API: add facility ──────────────────────────────────────────────────────
app.post('/api/facilities', (req, res) => {
  const file = path.join(__dirname, 'courses.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.push(req.body);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  res.json({ ok: true });
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
