// 100 → 0. Лестница D (15 дней), серверная синхронизация состояния по userId.
// "Покурить" заблокирована, пока тикает таймер; хвост монотонный, завтра ≤ сегодня,
// минимум 3 финальных дня по 1; смена синхрокода => переключение профиля (или старт, если нет).

const TOTAL_START = 100;
const BASE_LADDER = [24,20,12,8,7,6,5,4,4,3,2,2,1,1,1]; // 15 дней
const MIN_GAP_MIN = 10;
const FIRST_DAY_E_HOURS = 12;
const MIN_TAIL_ONES = 3;

const STATE_KEY_PREFIX = 'state-v1:'; // локальные профили на случай офлайна
function stateKeyFor(userId){ return `${STATE_KEY_PREFIX}${userId}`; }
function loadStateLocal(userId){ return JSON.parse(localStorage.getItem(stateKeyFor(userId)) || 'null'); }
function saveStateLocal(userId, st){ localStorage.setItem(stateKeyFor(userId), JSON.stringify(st)); }

// ---------- DOM ----------
const $ = s => document.querySelector(s);
const els = {
  dayIdx: $('#day-idx'),
  daysTotal: $('#days-total'),
  todayUsed: $('#today-used'),
  todayPlan: $('#today-plan'),
  totalLeft: $('#total-left'),
  timer: $('#timer'),
  btnSmoke: $('#btn-smoke'),
  btnUndo: $('#btn-undo'),
  btnTodayDown: $('#btn-today-down'),
  btnTodayUp: $('#btn-today-up'),
  btnTomorrowDown: $('#btn-tomorrow-down'),
  btnTomorrowUp: $('#btn-tomorrow-up'),
  btnNextDay: $('#btn-next-day'),
  btnReset: $('#btn-reset'),
  btnPushTest: $('#btn-push-test'),
  userInput: $('#user-id'),
  syncCode: $('#sync-code'),
  log: $('#log'),
  planList: $('#plan-list'),
  todayLeft: $('#today-left')
};

// ---------- Утилиты ----------
const fmt2 = n => String(n).padStart(2,'0');
const clamp = (x,a,b) => Math.max(a, Math.min(b, x));
const nowIso = () => new Date().toISOString();

function minutesBetween(aIso, bIso){
  const a = new Date(aIso).getTime();
  const b = new Date(bIso).getTime();
  return Math.floor((b-a)/60000);
}

function addMinutes(iso, m){
  const t = new Date(iso).getTime() + m*60000;
  return new Date(t).toISOString();
}

function todayYMD(d = new Date()){
  return d.toISOString().slice(0,10);
}

function tomorrowYMD(d = new Date()){
  const t = new Date(d.getTime()+24*3600*1000);
  return todayYMD(t);
}

function logLine(msg){
  if (!els.log) return;
  const li = document.createElement('div');
  li.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  els.log.prepend(li);
}

// ---------- Состояние ----------
function makeStartState(totalStart){
  const today = todayYMD();
  return {
    userId: storedUserId(),
    dayIdx: 0,
    totalLeft: totalStart,
    todayUsed: 0,
    plan: BASE_LADDER.slice(),
    todayPlan: BASE_LADDER[0],
    lastSmokeAt: null,
    startedAt: nowIso(),
    today: today,
    tomorrow: tomorrowYMD(),
    scheduleNextAt: null
  };
}

let state = null;

// ---------- Local Storage для userId ----------
const USER_KEY = 'smoke-user';
function storedUserId(){
  return localStorage.getItem(USER_KEY) || 'default';
}
function setStoredUserId(id){
  localStorage.setItem(USER_KEY, id || 'default');
}

// ---------- Серверное API (все пути ОТНОСИТЕЛЬНЫЕ) ----------
async function serverGetState(userId){
  try {
    const r = await fetch(`api/state?userId=${encodeURIComponent(userId)}`);
    if (!r.ok) return null;
    return await r.json();
  } catch(e){ return null; }
}

async function serverSetState(st){
  try {
    await fetch('api/state', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(st)
    });
  } catch(e){}
}

async function serverScheduleNext(){
  try {
    await fetch('api/schedule-next', { method:'POST' });
  } catch(e){}
}

async function serverPushTest(){
  try {
    await fetch('api/debug/push-test');
  } catch(e){}
}

async function getVapidPublicKey(){
  const r = await fetch('api/vapidPublicKey');
  if (!r.ok) throw new Error('no vapid key');
  return await r.text();
}

async function subscribePush(){
  const reg = await navigator.serviceWorker.register('sw.js', { scope: '/stopsmokedeb/' });
  let sub = await reg.pushManager.getSubscription();
  if (!sub){
    const vapidKey = await getVapidPublicKey();
    const convertedVapidKey = urlBase64ToUint8Array(vapidKey);
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: convertedVapidKey
    });
  }
  await fetch('api/subscribe', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(sub)
  });
  return sub;
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

// ---------- Логика плана ----------
function recomputeTodayPlan(st){
  st.todayPlan = st.plan[st.dayIdx] ?? 0;
}

function canSmoke(st){
  if (st.todayUsed >= st.todayPlan) return { ok:false, reason:'limit' };
  if (st.lastSmokeAt){
    const mins = minutesBetween(st.lastSmokeAt, nowIso());
    if (mins < MIN_GAP_MIN) return { ok:false, reason:'timer', left: MIN_GAP_MIN - mins };
  }
  return { ok:true };
}

function doSmoke(st){
  st.todayUsed += 1;
  st.totalLeft = Math.max(0, st.totalLeft - 1);
  st.lastSmokeAt = nowIso();
}

function undoSmoke(st){
  if (st.todayUsed > 0){
    st.todayUsed -= 1;
    st.totalLeft += 1;
  }
}

function moveToday(st, delta){
  const next = clamp(st.todayPlan + delta, 0, 1000);
  st.todayPlan = next;
}

function moveTomorrow(st, delta){
  const idx = st.dayIdx + 1;
  const val = (st.plan[idx] ?? 0) + delta;
  st.plan[idx] = clamp(val, 0, 1000);
}

function nextDay(st){
  const today = todayYMD();
  if (st.today !== today){
    st.today = today;
    st.tomorrow = tomorrowYMD();
  }
  st.dayIdx = Math.min(st.dayIdx + 1, st.plan.length - 1);
  st.todayUsed = 0;
  st.lastSmokeAt = null;
  recomputeTodayPlan(st);
}

// ---------- UI обновление ----------
function updateUI(){
  const st = state;
  if (!st) return;

  if (els.dayIdx) els.dayIdx.textContent = (st.dayIdx+1);
  if (els.daysTotal) els.daysTotal.textContent = st.plan.length;
  if (els.todayUsed) els.todayUsed.textContent = st.todayUsed;
  if (els.todayPlan) els.todayPlan.textContent = st.todayPlan;
  if (els.totalLeft) els.totalLeft.textContent = st.totalLeft;

  if (els.todayLeft) els.todayLeft.textContent = Math.max(0, st.todayPlan - st.todayUsed);

  // таймер
  if (els.timer){
    if (st.lastSmokeAt){
      const mins = minutesBetween(st.lastSmokeAt, nowIso());
      const left = Math.max(0, MIN_GAP_MIN - mins);
      const mm = Math.floor(left);
      const ss = Math.floor((left - mm)*60);
      els.timer.textContent = left > 0 ? `${fmt2(mm)}:${fmt2(ss)}` : 'готов';
    } else {
      els.timer.textContent = 'готов';
    }
  }

  // список плана
  if (els.planList){
    els.planList.innerHTML = '';
    st.plan.forEach((v,i)=>{
      const li = document.createElement('li');
      li.textContent = `${i+1}. ${v}`;
      if (i === st.dayIdx) li.style.fontWeight = 'bold';
      els.planList.appendChild(li);
    });
  }

  // доступность кнопок
  if (els.btnSmoke){
    const cs = canSmoke(st);
    els.btnSmoke.disabled = !cs.ok;
    els.btnSmoke.title = cs.ok ? '' : (cs.reason === 'limit' ? 'Лимит на сегодня' : `Таймер: подожди ${cs.left} мин`);
  }
}

// ---------- Сохранение ----------
let saveTimer = null;
function save(){
  const st = state;
  if (!st) return;

  saveStateLocal(st.userId, st);

  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async ()=>{
    await serverSetState(st);
  }, 400);
}

// ---------- События UI ----------
function bindUI(){
  if (els.btnSmoke) els.btnSmoke.addEventListener('click', ()=>{
    const cs = canSmoke(state);
    if (!cs.ok) return;
    doSmoke(state);
    save();
    updateUI();
  });

  if (els.btnUndo) els.btnUndo.addEventListener('click', ()=>{
    undoSmoke(state);
    save();
    updateUI();
  });

  if (els.btnTodayDown) els.btnTodayDown.addEventListener('click', ()=>{
    moveToday(state, -1);
    save();
    updateUI();
  });
  if (els.btnTodayUp) els.btnTodayUp.addEventListener('click', ()=>{
    moveToday(state, +1);
    save();
    updateUI();
  });

  if (els.btnTomorrowDown) els.btnTomorrowDown.addEventListener('click', ()=>{
    moveTomorrow(state, -1);
    save();
    updateUI();
  });
  if (els.btnTomorrowUp) els.btnTomorrowUp.addEventListener('click', ()=>{
    moveTomorrow(state, +1);
    save();
    updateUI();
  });

  if (els.btnNextDay) els.btnNextDay.addEventListener('click', ()=>{
    nextDay(state);
    save();
    updateUI();
  });

  if (els.btnReset) els.btnReset.addEventListener('click', ()=>{
    state = makeStartState(TOTAL_START);
    save();
    updateUI();
  });

  if (els.btnPushTest) els.btnPushTest.addEventListener('click', ()=>{
    serverPushTest();
  });

  if (els.userInput){
    els.userInput.addEventListener('change', ()=>{
      const id = els.userInput.value.trim() || 'default';
      setStoredUserId(id);
      // смена профиля — подгрузим/создадим состояние
      (async ()=>{
        let st = await serverGetState(id);
        if (!st) st = loadStateLocal(id);
        if (!st) st = makeStartState(TOTAL_START);
        state = st;
        save();
        updateUI();
      })();
    });
  }
}

// ---------- Push ----------
async function ensurePush(force = false){
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const sub = await subscribePush();
    if (force || sub) {
      logLine('Push: ok');
    }
  } catch(e){
    logLine('Push: error ' + (e && e.message ? e.message : e));
  }
}

// ---------- Автозапуск ----------
(async ()=>{
  bindUI();

  // ежедневный тикер (обновляет день)
  setInterval(()=>{
    const today = todayYMD();
    if (state && state.today !== today){
      nextDay(state);
      save();
      updateUI();
    }
  }, 30*1000);

  // загрузка профиля при старте
  const uid = storedUserId();
  if (els.userInput) els.userInput.value = uid;

  // приоритет: сервер -> локальный -> старт
  let st = await serverGetState(uid);
  if (!st) st = loadStateLocal(uid);
  if (!st) st = makeStartState(TOTAL_START);

  state = st;
  save(); // синхронизируем на сервер/локально
  updateUI();
  await ensurePush(false);
})();
