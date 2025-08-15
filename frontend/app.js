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
  btnWake: $('#btn-wake'),
  btnSmoke: $('#btn-smoke'),
  btnEarly: $('#btn-early'),
  btnShift: $('#btn-shift'),
  btnSkip: $('#btn-skip'),
  btnSleep: $('#btn-sleep'),
  hints: $('#hints'),
  userInput: $('#user-id'),
  btnSaveUser: $('#btn-save-user'),
};
function log(...a){ try{ console.log(...a); }catch{} }

// ---------- userId helpers ----------
function storedUserId(){ return localStorage.getItem('userId') || 'me'; }
function setStoredUserId(v){ localStorage.setItem('userId', v || 'me'); }
function getUserId(){
  const v = els.userInput && els.userInput.value && els.userInput.value.trim();
  if (v) { setStoredUserId(v); return v; }
  return storedUserId();
}
if (els.userInput) els.userInput.value = storedUserId();

// ---------- server state API ----------
async function serverGetState(uid){
  try{
    const r = await fetch(`/api/state?userId=${encodeURIComponent(uid)}`);
    const j = await r.json();
    return j.state || null;
  }catch{ return null; }
}
async function serverSaveState(uid, st){
  try{
    await fetch('/api/state', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ userId: uid, state: st })
    });
  }catch{}
}

// ---------- START state ----------
function makeStartState(total){
  return {
    plan: BASE_LADDER.slice(),
    dayIndex: 1,
    totalLeft: total,
    today: {
      awake:false, start:null, end:null,
      eHours: FIRST_DAY_E_HOURS,
      used:0, planToday: BASE_LADDER[0],
      rLeft:0, nextSlot:null
    }
  };
}

let state = makeStartState(TOTAL_START); // заполним реально в init()

function save(){
  const uid = storedUserId();
  saveStateLocal(uid, state);
  serverSaveState(uid, state); // простая синхронизация; можно дебаунсить, но и так ок
}

// ---------- миграция старого единого ключа (если был) ----------
(function migrateOnce(){
  const old = localStorage.getItem('state-v1');
  if (old) {
    const uid = storedUserId();
    if (!localStorage.getItem(stateKeyFor(uid))) {
      localStorage.setItem(stateKeyFor(uid), old);
    }
    localStorage.removeItem('state-v1');
  }
})();

// ---------- КПТ ----------
const HINTS = [
  "Похоже, тебе скучно. Что займёт 3 минуты вместо стика?",
  "Зачем сейчас куришь? Какая цель у этой затяжки?",
  "Оценка тяги 0–10? Запусти таймер на 120 сек и пересчитай.",
  "10 медленных вдохов. На выдохе: «Отпускаю».",
  "Выпей воды. Стало ли на 1–2 пункта легче?",
  "HALT: голоден? злишься? одинок? уставший?",
  "Мысль ≠ факт. Дай альтернативное объяснение.",
  "Волна тяги проходит за 3–5 минут. Оседлай её.",
  "5-4-3-2-1: назови 5 вещей, которые видишь…",
  "«Я выбираю себя, а не привычку.»",
  "Какая эмоция за craving’ом: стресс, скука, усталость?",
  "Если бы ты не курил — что сделал бы сейчас вместо этого?",
  "Оценка тяги по шкале 0–10? Через 3 минуты пересчитай.",
  "Подыши 10 раз медленно. На выдохе скажи про себя: “Отпускаю”.",
  "Выпей стакан воды. Изменилась ли тяга на 1–2 пункта?",
  "HALT: ты голоден, злишься, одинок, уставший? Что можешь сделать сейчас?",
  "Какая мысль сейчас в голове? Это факт или интерпретация?",
  "Поймай и назови искажение: “всё или ничего”? “катастрофизация”?",
  "Если бы близкий попросил тебя подержаться 10 минут — смог бы?",
  "Волна тяги обычно проходит за 3–5 минут. Оседлай волну.",
  "5-4-3-2-1: назови 5 вещей, которые видишь… Сфокусируйся на настоящем.",
  "Сдвинь действие: таймер на 10 минут, а потом решишь ещё раз.",
  "Три быстрых дела вместо стика: 10 приседаний, умыться, чек-лист на день.",
  "Подумай о цене: сколько денег/дней жизни ты даришь этой затяжке?",
  "Как ты почувствуешь себя через 15 минут, если не закуришь?",
  "Если закуришь — что станет лучше? Есть ли другой способ того же эффекта?",
  "Переформулируй мысль мягче: “Мне трудно сейчас, но я справляюсь.”",
  "Микро-действие 2 минуты: помыть кружку, открыть окно, размяться.",
  "Задай “почему”: почему именно сейчас? почему так важно?",
  "Переключение контекста: пройди в другую комнату/на улицу на 2 минуты.",
  "Когнитивный эксперимент: подожди 120 секунд и проверь тягу снова.",
  "Сравни с ценностью: здоровье/энергия/контроль — что важнее в этот момент?",
  "Сделай 10 глубоких вдохов: считай от 10 к 1 на выдохе.",
  "Умой лицо холодной водой — перезагрузка нервной системы.",
  "Зажуй жвачку/мятную конфету. Рот занят — тяга спадёт.",
  "Мини-прогулка 200 шагов. Вернёшься — решишь заново.",
  "Опиши craving одним словом. Уже стало чуть дальше от тебя?",
  "Замени первую затяжку “пустой” паузой 60 сек — просто подожди.",
  "Представь, что ты уже бросил 7 дней назад. Что ты бы сделал сейчас?",
  "Если бы была кнопка “Пропустить” в мозгу — на что бы ты её нажал?",
  "Напиши короткое сообщение самому себе: зачем тебе ноль?",
  "Выпей тёплый чай/кофе без стика. Получится?",
  "Проверь тело: шею/плечи/челюсть — расслабь.",
  "Сделай 15 секунд планки. Сброси напряжение.",
  "Спроси: это про никотин или про паузу? Можешь сделать паузу без никотина.",
  "Вспомни три причины, почему ты начал этот план из 82.",
  "Скажи себе: “Тяга пройдёт, если я ничего не сделаю.”",
  "Если сейчас 10/10 тяга, что сделает её 8/10? Выбери одно.",
  "Промой руки холодной водой и почувствуй кожу — заземлись.",
  "Посмотри в окно 60 сек и назови 3 звука вокруг.",
  "Сделай 20 вдохов по квадрату: 4-4-4-4 (вдох-пауза-выдох-пауза).",
  "Спроси: что будет через час, если сейчас не курить?",
  "Спроси наоборот: что будет через час, если сейчас закурить?",
  "Попроси поддержку: напиши “держи меня 10 минут”.",
  "Переименуй: не “ломка”, а “волна”. Волны проходят.",
  "Если мысль “а вдруг сорвусь” — ответ: “даже если, я вернусь к плану”.",
  "Отложи решение до следующего окна — оно уже в расписании.",
  "Сделай растяжку спины/шеи 90 секунд.",
  "Собери мусор на столе 2 минуты. Мини-контроль = меньше тяги.",
  "Съешь яблоко/йогурт — иногда это просто голод.",
  "Проверь сон: если не выспался, сделай микро-передышку 5 мин.",
  "Включи любимый трек на 3 минуты и пережди.",
  "Скажи: “Не идеально, но лучше, чем вчера.”",
  "Подумай о человеке, которым гордишься. Что бы он выбрал для тебя?",
  "Задай цену: этот стик = минус одно запланированное окно. Точно хочешь?",
  "Сделай 10 лёгких прыжков на месте.",
  "Запиши одну благодарность за сегодня. Тяга слабеет, когда есть смысл."
];

if (els.hints) els.hints.innerHTML = HINTS.slice(0, 10).map(h=>`<li>${h}</li>`).join('');

// ---------- VIEW ----------
function fmtTime(ms){
  if (!ms || ms<=0) return '—:—';
  const s=Math.floor(ms/1000), h=Math.floor(s/3600), m=Math.floor((s%3600)/60), ss=s%60;
  const pad=x=>String(x).padStart(2,'0');
  return h>0? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}
function toggle(btn, enabled){ if (btn) btn.disabled = !enabled; }
function updateUI(){
  if (els.dayIdx) els.dayIdx.textContent = state.dayIndex;
  if (els.daysTotal) els.daysTotal.textContent = state.plan.length;
  if (els.todayUsed) els.todayUsed.textContent = state.today.used;
  if (els.todayPlan) els.todayPlan.textContent = state.today.planToday;
  if (els.totalLeft) els.totalLeft.textContent = state.totalLeft;

  const nextTs = state.today.nextSlot ? new Date(state.today.nextSlot).getTime() : 0;
  if (els.timer) els.timer.textContent = nextTs>0? fmtTime(nextTs - Date.now()) : '—:—';

  const awake = state.today.awake;
  const canEarly = awake && state.today.rLeft>0;
  const canSmokeNow = awake && state.today.rLeft>0 && (nextTs===0 || nextTs<=Date.now());

  toggle(els.btnWake, !awake);
  toggle(els.btnSleep, awake);
  toggle(els.btnEarly, canEarly);
  toggle(els.btnSmoke, canSmokeNow);
  toggle(els.btnShift, awake && !!state.today.nextSlot);
  toggle(els.btnSkip,  awake && !!state.today.nextSlot);

  if (els.btnSmoke) els.btnSmoke.classList.toggle('disabled', !canSmokeNow);
}

// ---------- CORE ----------
function calcNextSlot(fromDate){
  const R = state.today.rLeft; if (R<=0) return null;
  const eMs = Math.max(1, Math.round((state.today.eHours || FIRST_DAY_E_HOURS)*3600*1000));
  const gap = Math.max(MIN_GAP_MIN*60*1000, Math.floor(eMs / R));
  return new Date(fromDate.getTime()+gap);
}

// Хвост: монотонный, <= сегодня, минимум minTailOnes единичек в конце
function buildTailWithOnes(totalLeft, prevCap, minTailOnes){
  let S = Math.max(0, Math.floor(totalLeft));
  if (S === 0) return [];
  if (S <= minTailOnes) return Array(S).fill(1);

  const cap = Math.max(1, Math.floor(prevCap));
  const ones = Math.max(minTailOnes, 1);
  const S_nonlast = S - ones;

  let k = Math.ceil(S_nonlast / cap);
  k = Math.max(1, Math.min(k, S_nonlast));

  const q = Math.floor(S_nonlast / k);
  let rem = S_nonlast % k;
  const arr = [];
  for (let i=0;i<k;i++){
    let v = q + (rem>0 ? 1 : 0);
    if (rem>0) rem--;
    v = Math.min(v, cap);
    if (i>0 && v > arr[i-1]) v = arr[i-1];
    arr.push(v);
  }
  for (let i=0;i<ones;i++) arr.push(1);
  return arr;
}

// ---------- PUSH ----------

// iOS detection + standalone check (чтобы пуш-разрешение просить только в установленной PWA на iOS)
const isStandalone = window.matchMedia('(display-mode: standalone)').matches
                  || window.navigator.standalone === true; // iOS Safari
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
           || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

async function askPushPermissionSafely() {
  // На iOS Safari разрешение для пушей доступно только в установленной PWA
  if (isIOS && !isStandalone) return { ok:false, reason:'install_required' };
  if (!('Notification' in window)) return { ok:false, reason:'no_api' };
  const perm = await Notification.requestPermission();
  return { ok: perm === 'granted' };
}

async function scheduleServerPush(when){
  try{
    const body = { userId: storedUserId(), whenIso: when ? when.toISOString() : null };
    const r = await fetch('/api/schedule-next', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    return await r.json().catch(()=>({}));
  }catch(e){ log('schedule-next err', e); return {}; }
}
async function cancelServerPush(){ return scheduleServerPush(null); }

async function ensurePush(forceResubscribe=false){
  try{
    if (!('serviceWorker' in navigator)) return;
    const reg = await navigator.serviceWorker.register('sw.js', { scope: './' });
    await navigator.serviceWorker.ready;

    const { publicKey } = await fetch('/api/vapidPublicKey').then(r=>r.json());
    const key = urlBase64ToUint8Array(publicKey);

    let sub = await reg.pushManager.getSubscription();
    if (sub) {
      const cur = new Uint8Array(sub.options.applicationServerKey || []);
      const same = cur.length===key.length && cur.every((v,i)=>v===key[i]);
      if (!same || forceResubscribe) { try{ await sub.unsubscribe(); }catch{} sub = null; }
    }
    if (!sub) {
      if (Notification.permission !== 'granted') return;
      sub = await reg.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey:key });
    }
    const payload = { userId: storedUserId(), subscription: sub.toJSON() };
    await fetch('/api/subscribe', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
  }catch(e){ log('ensurePush err', e); }
}
let btnNotify = document.getElementById('btn-notify');
let btnTest   = document.getElementById('btn-test-push');
(function ensureNotifyButtonsExist(){
  const host = document.getElementById('controls') || document.body;
  if (!btnNotify) {
    btnNotify = document.createElement('button');
    btnNotify.id = 'btn-notify';
    btnNotify.textContent = 'Включить уведомления';
    btnNotify.hidden = true;
    btnNotify.style.marginRight = '8px';
    host.appendChild(btnNotify);
  }
  if (!btnTest) {
    btnTest = document.createElement('button');
    btnTest.id = 'btn-test-push';
    btnTest.textContent = 'Тестовое уведомление';
    btnTest.hidden = true;
    host.appendChild(btnTest);
  }
})();

function refreshNotifyButtons() {
  const hasNotif = ('Notification' in window);
  const granted  = hasNotif && Notification.permission === 'granted';
  const canAsk   = hasNotif && !granted;
  if (btnNotify) btnNotify.hidden = !canAsk;
  if (btnTest)   btnTest.hidden   = !granted;
}
refreshNotifyButtons();

if (btnNotify) {
  btnNotify.addEventListener('click', async () => {
    const res = await askPushPermissionSafely();   // на iOS сработает только в установленной PWA
    if (res.ok) {
      await ensurePush(true);                      // подпишемся и отправим сабскрипшн на сервер
      alert('Уведомления включены 👍');
    } else if (res.reason === 'install_required') {
      alert('На iPhone сначала нажми «Поделиться» → «На экран “Домой”», открой с иконки и нажми кнопку ещё раз.');
    } else if (res.reason === 'no_api') {
      alert('Браузер не поддерживает уведомления.');
    } else {
      alert('Разрешение не выдано.');
    }
    refreshNotifyButtons();
  });
}

if (btnTest) {
  btnTest.addEventListener('click', async () => {
    try {
      await fetch('/api/debug/push-test', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ userId: storedUserId() })
      });
      alert('Тестовое пуш-уведомление отправлено. Проверь шторку уведомлений.');
    } catch (e) {
      alert('Не удалось отправить тест-пуш.');
    }
  });
}

function urlBase64ToUint8Array(base64String){
  const padding='='.repeat((4-base64String.length%4)%4);
  const base64=(base64String+padding).replace(/-/g,'+').replace(/_/g,'/');
  const raw=atob(base64); const arr=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++) arr[i]=raw.charCodeAt(i); return arr;
}

// ---------- BUTTONS ----------
if (els.btnWake) els.btnWake.addEventListener('click', async () => {
  if (state.today.awake) return;
  state.today.awake = true;
  state.today.start = new Date().toISOString();

  const planToday = state.plan[state.dayIndex-1] || 0;
  state.today.planToday = planToday;
  state.today.rLeft = planToday;
  state.today.used = 0;
  state.today.nextSlot = null;

  await cancelServerPush();
  save(); updateUI();
});

async function doSmoke(force=false){
  const nextTs = state.today.nextSlot ? new Date(state.today.nextSlot).getTime() : 0;
  const canSmokeNow = state.today.awake && state.today.rLeft>0 && (force || nextTs===0 || nextTs<=Date.now());
  if (!canSmokeNow) return;

  state.today.used += 1;
  state.today.rLeft -= 1;
  state.totalLeft -= 1;

  const now = new Date();
  if (state.today.rLeft > 0) {
    const next = calcNextSlot(now);
    state.today.nextSlot = next.toISOString();
    await scheduleServerPush(next);
  } else {
    state.today.nextSlot = null;
    await cancelServerPush();
  }
  save(); updateUI();
}
if (els.btnSmoke) els.btnSmoke.addEventListener('click', () => doSmoke(false));
if (els.btnEarly) els.btnEarly.addEventListener('click', async () => {
  const hint = HINTS[Math.floor(Math.random()*HINTS.length)];
  if (confirm(`${hint}\n\nВсё равно покурить сейчас?`)) await doSmoke(true);
});
if (els.btnShift) els.btnShift.addEventListener('click', async () => {
  if (!state.today.nextSlot) return;
  const t = new Date(state.today.nextSlot); t.setMinutes(t.getMinutes()+10);
  state.today.nextSlot = t.toISOString();
  await scheduleServerPush(t); save(); updateUI();
});
if (els.btnSkip) els.btnSkip.addEventListener('click', async () => {
  if (!state.today.nextSlot) return;
  const next = calcNextSlot(new Date());
  state.today.nextSlot = next.toISOString();
  await scheduleServerPush(next); save(); updateUI();
});
if (els.btnSleep) els.btnSleep.addEventListener('click', async () => {
  await cancelServerPush();

  state.today.awake = false;
  state.today.end = new Date().toISOString();
  try {
    const start = new Date(state.today.start).getTime();
    const end = new Date(state.today.end).getTime();
    const eHours = Math.max(8, Math.min(18, (end-start)/3600000));
    state.today.eHours = eHours;
  } catch {}

  const prevCap = state.plan[state.dayIndex-1] || 1;
  const tail = buildTailWithOnes(state.totalLeft, prevCap, MIN_TAIL_ONES);
  state.plan = state.plan.slice(0, state.dayIndex).concat(tail);

  state.dayIndex += 1;
  state.today = {
    awake:false, start:null, end:null,
    eHours: state.today.eHours || FIRST_DAY_E_HOURS,
    used:0, planToday: state.plan[state.dayIndex-1] || 0,
    rLeft:0, nextSlot:null
  };

  save(); updateUI();
  if (state.totalLeft <= 0) alert('Финиш: 0 стиков. Сильный ход.');
});

// ---------- SWITCH USER (переключение профиля) ----------
if (els.btnSaveUser && els.userInput) {
  els.btnSaveUser.addEventListener('click', async () => {
    const prev = storedUserId();
    const next = (els.userInput.value.trim() || 'me');
    if (prev === next) return;

    // 1) Сохраняем текущий профиль локально+на сервер
    save();

    // 2) Отменяем пуш-джобу старому userId
    try {
      await fetch('/api/schedule-next', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ userId: prev, whenIso: null })
      });
    } catch {}

    // 3) Переключаемся на новый userId
    setStoredUserId(next);

    // 4) Пробуем тянуть state с сервера; если нет — берём локальный, если нет — создаём старт
    let newState = await serverGetState(next);
    if (!newState) newState = loadStateLocal(next);
    if (!newState) newState = makeStartState(TOTAL_START);

    state = newState;
    save(); // зафиксируем локально и отправим на сервер
    updateUI();

    // 5) Переподпишемся на web push под новый userId
    await ensurePush(true);
  });
}

// ---------- INIT ----------
setInterval(updateUI, 1000);

(async function init(){
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
