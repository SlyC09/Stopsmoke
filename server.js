// Clean Web Push server + per-user state sync (GET/POST /api/state)
// One-next-slot scheduling, subscriptions grouped by userId
import express from 'express';
import fs from 'fs';
import path from 'path';
import schedule from 'node-schedule';
import webpush from 'web-push';
import { fileURLToPath } from 'url';

process.env.TZ = 'Asia/Oral';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- FRONT path (expects ./frontend/index.html) ----
const FRONT = path.join(__dirname, 'frontend');
const INDEX = path.join(FRONT, 'index.html');
if (!fs.existsSync(INDEX)) {
  console.error('[BOOT] Не найден frontend/index.html по пути:', INDEX);
  console.error('[BOOT] Структура:\n  <корень>/server.js\n  <корень>/frontend/index.html, app.js, sw.js, style.css');
  process.exit(1);
}
console.log('[BOOT] FRONT =', FRONT);

const DB_PATH = path.join(__dirname, 'db.json');

// ---- DB helpers ----
function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({
      vapid: {},
      subsByUser: {},   // { userId: [subscription, ...] }
      jobs: {},         // { userId: { whenISO } }
      statesByUser: {}  // { userId: <full client state object> }
    }, null, 2));
  }
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (e) {
    console.error('[BOOT] db.json повреждён. Удалите файл. Ошибка:', e.message);
    process.exit(1);
  }
}
function saveDB() { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }
let db = loadDB();

// ---- VAPID ----
if (!db.vapid.publicKey || !db.vapid.privateKey) {
  db.vapid = webpush.generateVAPIDKeys();
  saveDB();
}
webpush.setVapidDetails('mailto:you@example.com', db.vapid.publicKey, db.vapid.privateKey);

// ---- scheduler (one-next-slot per user) ----
const jobMap = new Map(); // userId -> Job

function cancelJob(userId) {
  const j = jobMap.get(userId);
  if (j) { try { j.cancel(); } catch {} }
  jobMap.delete(userId);
  db.jobs[userId] = { whenISO: null };
  saveDB();
  console.log(`[SCHED] cancel user=${userId}`);
}

async function pushToUser(userId, payload) {
  const subs = db.subsByUser[userId] || [];
  if (subs.length === 0) {
    console.warn(`[PUSH] user=${userId} подписок нет`);
    return;
  }
  await Promise.all(subs.map(async sub => {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload));
      console.log(`[PUSH] ok user=${userId} -> ${sub.endpoint.slice(-20)}`);
    } catch (e) {
      console.warn(`[PUSH] err user=${userId} ${e.statusCode || ''} ${e.message}`);
      if (e.statusCode === 404 || e.statusCode === 410) {
        // dead subscription -> remove
        db.subsByUser[userId] = (db.subsByUser[userId] || []).filter(s => s.endpoint !== sub.endpoint);
        saveDB();
        console.log(`[PUSH] removed dead sub for user=${userId}`);
      }
    }
  }));
}

function scheduleNext(userId, whenISO) {
  cancelJob(userId);
  if (!whenISO) return;

  const when = new Date(whenISO);
  if (isNaN(when.getTime())) { console.warn('[SCHED] bad date', whenISO); return; }
  if (when.getTime() <= Date.now()) { console.warn('[SCHED] past date', whenISO); return; }

  const job = schedule.scheduleJob(when, async () => {
    console.log(`[JOB] fire user=${userId} at ${new Date().toISOString()}`);
    await pushToUser(userId, {
      type: 'slot',
      title: 'Время по плану',
      body: 'Боже, дай мне разум и душевный покой принять то, что я не в силах изменить, мужество изменить то, что могу, и мудрость отличить одно от другого.',
      when: new Date().toISOString()
    });
    cancelJob(userId);
  });

  jobMap.set(userId, job);
  db.jobs[userId] = { whenISO: when.toISOString() };
  saveDB();
  console.log(`[SCHED] user=${userId} next=${when.toISOString()}`);
}

// ---- app ----
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use((req, _res, next) => { console.log(`[REQ] ${req.method} ${req.url}`); next(); });

app.use(express.static(FRONT));
app.get('/', (_req, res) => res.sendFile(INDEX));

// health
app.get('/__ping', (_req, res) => res.send('ok'));

// ---- web push API ----
app.get('/api/vapidPublicKey', (_req, res) => res.json({ publicKey: db.vapid.publicKey }));

app.post('/api/subscribe', (req, res) => {
  const { userId, subscription } = req.body || {};
  if (!userId || !subscription?.endpoint) {
    return res.status(400).json({ ok: false, msg: 'need userId & subscription.endpoint' });
  }
  const list = db.subsByUser[userId] || [];
  if (!list.find(s => s.endpoint === subscription.endpoint)) {
    list.push(subscription);
    db.subsByUser[userId] = list;
    saveDB();
    console.log(`[SUB] add user=${userId} -> ${subscription.endpoint.slice(-20)} (count=${list.length})`);
  }
  res.json({ ok: true, count: (db.subsByUser[userId] || []).length });
});

app.post('/api/schedule-next', (req, res) => {
  const { userId, whenIso } = req.body || {};
  if (!userId) return res.status(400).json({ ok: false, msg: 'no userId' });
  if (whenIso === null) { cancelJob(userId); return res.json({ ok: true, cancelled: true }); }
  scheduleNext(userId, whenIso);
  res.json({ ok: true, when: db.jobs[userId]?.whenISO || null });
});

// ---- per-user STATE sync (NEW) ----
app.get('/api/state', (req, res) => {
  const userId = String(req.query.userId || '');
  if (!userId) return res.status(400).json({ ok:false, msg:'no userId' });
  const st = db.statesByUser[userId];
  if (!st) return res.json({ ok:true, state: null });
  res.json({ ok:true, state: st });
});

app.post('/api/state', (req, res) => {
  const { userId, state } = req.body || {};
  if (!userId) return res.status(400).json({ ok:false, msg:'no userId' });
  if (!state || typeof state !== 'object') return res.status(400).json({ ok:false, msg:'bad state' });
  // Очень простая валидация (можно расширить)
  try {
    db.statesByUser[userId] = state;
    saveDB();
    return res.json({ ok:true });
  } catch (e) {
    return res.status(500).json({ ok:false, msg:e.message });
  }
});

// ---- debug ----
app.get('/api/debug/status', (req, res) => {
  const userId = String(req.query.userId || 'me');
  const subs = db.subsByUser[userId] || [];
  res.json({
    now: new Date().toISOString(),
    tz: process.env.TZ,
    userId,
    subsCount: subs.length,
    subsTail: subs.map(s => s.endpoint.slice(-20)),
    nextWhenISO: db.jobs[userId]?.whenISO || null,
    hasState: !!db.statesByUser[userId]
  });
});
app.post('/api/debug/push-test', async (req, res) => {
  const { userId } = req.body || {};
  await pushToUser(userId || 'me', { type:'test', title:'Тест', body:'Тестовое уведомление', when:new Date().toISOString() });
  res.json({ ok:true });
});
app.post('/api/debug/clear-subs', (req, res) => {
  const { userId } = req.body || {};
  const id = userId || 'me';
  const removed = (db.subsByUser[id] || []).length;
  delete db.subsByUser[id];
  saveDB();
  cancelJob(id);
  res.json({ ok:true, removed });
});

// ---- start ----
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server on http://localhost:${PORT}  (TZ=${process.env.TZ})`);
});
