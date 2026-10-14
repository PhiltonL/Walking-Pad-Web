import { PadManager } from './pad.js';
import { DemoDriver } from './demo.js';
import { Tracker } from './tracker.js';
import * as store from './store.js';
import * as st from './stats.js';
import { encodeFit } from './fit.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

let settings = store.loadSettings();
let workouts = store.loadWorkouts();
let target = 1;
let lastEdit = 0;
let speedTimer = null;
let currentView = 'train';
let presetKey = '';
let detailId = null;
const speedHist = [];

const pad = new PadManager();
const tracker = new Tracker({ store: store.workoutStore });

const STATE_LABEL = {
  idle: 'Bereit', starting: 'Startet', running: 'Läuft', paused: 'Pausiert', stopping: 'Stoppt',
  finished: 'Beendet', stopped: 'Gestoppt', error: 'Fehler', 'safety key': 'Sicherheitsschlüssel gezogen', sleep: 'Standby',
};

// ---------------------------------------------------------------- helpers

let toastTimer;
function toast(text, action) {
  const el = $('toast');
  el.replaceChildren(document.createTextNode(text));
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.onclick = () => { el.hidden = true; action.fn(); };
    el.append(b);
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 8000);
}

const getPath = (o, p) => p.split('.').reduce((v, k) => v?.[k], o);
function setPath(o, p, val) {
  const keys = p.split('.');
  const last = keys.pop();
  keys.reduce((v, k) => v[k], o)[last] = val;
}

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const stamp = () => new Date().toISOString().slice(0, 10);

function limits() {
  const min = pad.info.minSpeed || 1;
  let max = pad.info.maxSpeed || 6;
  if (settings.speedLimit) max = Math.min(max, settings.speedLimit);
  return { min, max: Math.max(min, max) };
}

const fmtSpeed = (v) => st.fmtNum(v, 1);

// ---------------------------------------------------------------- training view

let renderQueued = false;
function schedule() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => { renderQueued = false; renderStatus(); renderTrain(); }, 50);
}

function renderStatus() {
  const s = pad.status;
  $('chip').dataset.status = s;
  $('chipText').textContent = {
    idle: 'Nicht verbunden', connecting: 'Verbinde …', waiting: 'Warte auf Laufband',
    connected: pad.deviceName ?? 'Verbunden',
  }[s];
  $('savedDevice').textContent = pad.deviceName ?? 'keins';
  $('btnForget').disabled = !pad.deviceName || pad.demo;
  $('btnDisconnect').disabled = s === 'idle' || pad.demo;
}

function renderConnectCard() {
  const s = pad.status, saved = pad.deviceName;
  const busy = s === 'connecting' || s === 'waiting';
  $('unsupported').hidden = pad.supported;
  $('btnConnect').hidden = busy || !pad.supported;
  $('btnConnect').textContent = saved ? `Mit ${saved} verbinden` : 'Laufband verbinden';
  $('btnCancel').hidden = !busy;
  $('btnConnectOther').hidden = !saved || !pad.supported || s === 'connecting';
  $('autoHint').hidden = !(saved && pad.supported && !pad.canAutoConnect);
  $('connectMsg').textContent =
    s === 'connecting' ? 'Verbinde …'
    : s === 'waiting' ? `${saved ?? 'Das Laufband'} ist gerade nicht erreichbar. Ich verbinde automatisch, sobald es eingeschaltet ist.`
    : 'Schalte dein Laufband ein und verbinde es.';
}

function renderPresets(min, max) {
  const list = settings.features.presets ? settings.presets.filter((v) => v >= min && v <= max) : [];
  const key = `${min}|${max}|${list}`;
  if (key === presetKey) return;
  presetKey = key;
  $('presets').replaceChildren(...list.map((v) => {
    const b = document.createElement('button');
    b.className = 'btn soft';
    b.textContent = fmtSpeed(v);
    b.onclick = () => setTarget(v);
    return b;
  }));
}

const SPARK_KERNEL = [1, 2, 3, 4, 3, 2, 1];

function smoothValues(values) {
  const r = (SPARK_KERNEL.length - 1) / 2;
  return values.map((_, i) => {
    let sum = 0, weight = 0;
    SPARK_KERNEL.forEach((w, k) => {
      const v = values[i + k - r];
      if (v !== undefined) { sum += v * w; weight += w; }
    });
    return sum / weight;
  });
}

// Catmull-Rom spline as cubic Beziers; control points stay between the segment's end values, so no overshoot.
function smoothPath(pts) {
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] ?? p2;
    const lo = Math.min(p1[1], p2[1]), hi = Math.max(p1[1], p2[1]);
    const clamp = (y) => Math.min(hi, Math.max(lo, y));
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, clamp(p1[1] + (p2[1] - p0[1]) / 6)];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, clamp(p2[1] - (p3[1] - p1[1]) / 6)];
    d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

function renderSpark() {
  const n = speedHist.length;
  if (n < 3) { $('spark').innerHTML = ''; return; }
  const values = smoothValues(speedHist);
  const lo = Math.min(...values) - 1, hi = Math.max(...values) + 1;
  const pts = values.map((v, i) => [(i / (n - 1)) * 300, 64 - ((v - lo) / (hi - lo)) * 44]);
  $('spark').innerHTML = `<path d="${smoothPath(pts)} L300,70 L0,70Z"/>`;
}

function renderTrain() {
  const connected = pad.status === 'connected';
  $('connectCard').hidden = connected;
  $('liveCard').hidden = !connected;
  if (!connected) {
    renderConnectCard();
    document.title = 'Walking Pad';
    return;
  }

  const d = pad.data, f = settings.features;
  const state = d.state ?? (d.speed > 0 ? 'running' : 'idle');
  const running = state === 'running', paused = state === 'paused';
  const starting = state === 'starting', stopping = state === 'stopping';
  const { min, max } = limits();

  $('stateLabel').textContent = STATE_LABEL[state] ?? state;
  $('mSpeed').textContent = fmtSpeed(d.speed ?? 0);
  $('mTime').textContent = st.fmtDuration(d.time ?? 0);
  $('mDist').textContent = st.fmtKm(d.distance ?? 0);
  $('mKcal').textContent = Math.round(d.calories ?? 0);
  $('avgSpeed').textContent = d.time > 0 ? `Ø ${fmtSpeed((d.distance / d.time) * 3.6)} km/h` : '';

  $('tileSteps').hidden = !f.steps;
  const realSteps = d.steps > 0;
  $('stepsLabel').textContent = realSteps ? 'Schritte' : 'Schritte (ca.)';
  $('mSteps').textContent = realSteps ? d.steps : st.estimateSteps(d.distance, settings.stepLengthCm);
  $('tileHr').hidden = !f.heartRate;
  $('mHr').textContent = d.heartRate > 0 ? d.heartRate : '–';

  $('countdown').hidden = !(starting && d.countdown > 0);
  $('countdown').textContent = d.countdown ?? '';

  $('btnStart').hidden = running || paused || starting || stopping;
  $('btnResume').hidden = !paused;
  $('btnPause').hidden = !running || !f.pause || pad.info.supportPause === false;
  $('btnStop').hidden = !(running || paused || starting);

  $('speedBox').hidden = !f.speedControl;
  for (const id of ['spdDown', 'spdUp', 'speedRange']) $(id).disabled = !running;
  if (running && d.speed > 0 && Date.now() - lastEdit > 3000) target = d.speed;
  target = Math.min(max, Math.max(min, target));
  $('targetSpeed').textContent = fmtSpeed(target);
  const r = $('speedRange');
  r.min = min; r.max = max; r.value = target;
  renderPresets(min, max);
  for (const b of $('presets').children) b.disabled = !running;

  const inclineOn = f.incline && pad.driver?.caps().incline;
  $('inclineBox').hidden = !inclineOn;
  if (inclineOn) $('targetIncline').textContent = st.fmtNum(d.incline ?? 0, 0);

  renderSpark();
  document.title = running ? `▶ ${st.fmtDuration(d.time)} · ${st.fmtKm(d.distance)} km` : 'Walking Pad';
}

function setTarget(v) {
  if (!pad.driver) return;
  const { min, max } = limits();
  target = Math.round(Math.min(max, Math.max(min, v)) * 10) / 10;
  lastEdit = Date.now();
  renderTrain();
  clearTimeout(speedTimer);
  speedTimer = setTimeout(() => pad.driver?.setSpeed(target), 250);
}

function changeIncline(delta) {
  const d = pad.driver;
  if (!d) return;
  const { minIncline = 0, maxIncline = 15 } = pad.info;
  d.setIncline(Math.min(maxIncline, Math.max(minIncline, (pad.data.incline ?? 0) + delta)));
}

function renderToday() {
  const t = st.summarize(workouts, st.startOfDay(Date.now()));
  $('todayDist').textContent = st.fmtKm(t.distance);
  $('todayTime').textContent = st.fmtDuration(t.duration);
  $('todayKcal').textContent = Math.round(t.calories);
  $('todayCount').textContent = t.count;
  const last = workouts[0];
  $('lastRun').hidden = !last;
  if (last) $('lastRun').textContent = `Letztes Training: ${st.fmtDateTime(last.startedAt)} · ${st.fmtKm(last.distance)} km · ${st.fmtDuration(last.duration)}`;
}

// ---------------------------------------------------------------- history view

function barChart(days) {
  const W = 560, H = 150, m = { l: 6, r: 6, t: 8, b: 24 };
  const max = Math.max(1000, ...days.map((d) => d.distance));
  const bw = (W - m.l - m.r) / days.length;
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Strecke der letzten ${days.length} Tage">`;
  days.forEach((d, i) => {
    const h = Math.max(3, ((H - m.t - m.b) * d.distance) / max);
    const x = m.l + i * bw + bw * 0.14;
    s += `<rect class="bar${d.distance ? '' : ' empty'}${d.today ? ' today' : ''}" x="${x.toFixed(1)}" y="${(H - m.b - h).toFixed(1)}" width="${(bw * 0.72).toFixed(1)}" height="${h.toFixed(1)}" rx="3"><title>${d.title}: ${st.fmtKm(d.distance)} km</title></rect>`;
    s += `<text x="${(x + bw * 0.36).toFixed(1)}" y="${H - 8}" text-anchor="middle">${d.label}</text>`;
  });
  return s + '</svg>';
}

const LC = { W: 560, H: 190, l: 34, r: 8, t: 10, b: 22 };

function lineScales(samples) {
  const tmax = Math.max(1, samples.at(-1)[0]);
  const vmax = Math.max(2, Math.ceil(Math.max(...samples.map((x) => x[1])) + 0.5));
  return {
    tmax, vmax,
    X: (t) => LC.l + ((LC.W - LC.l - LC.r) * t) / tmax,
    Y: (v) => LC.H - LC.b - ((LC.H - LC.t - LC.b) * v) / vmax,
  };
}

function lineChart(samples) {
  if (samples.length < 2) return '<p class="muted small">Zu wenige Messpunkte für ein Diagramm.</p>';
  const { tmax, vmax, X, Y } = lineScales(samples);
  const { W, H, l, r, b } = LC;
  const step = vmax > 8 ? 2 : 1;
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Geschwindigkeit über die Zeit">`;
  for (let v = 0; v <= vmax; v += step) {
    s += `<line class="grid" x1="${l}" x2="${W - r}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text x="${l - 6}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${v}</text>`;
  }
  const pts = samples.map((x) => `${X(x[0]).toFixed(1)},${Y(x[1]).toFixed(1)}`);
  s += `<polygon class="area" points="${X(0)},${Y(0)} ${pts.join(' ')} ${X(tmax)},${Y(0)}"/><polyline class="line" points="${pts.join(' ')}"/>`;
  for (const t of [0, tmax / 2, tmax]) {
    s += `<text x="${X(t).toFixed(1)}" y="${H - 6}" text-anchor="${t === 0 ? 'start' : t === tmax ? 'end' : 'middle'}">${st.fmtDuration(t)}</text>`;
  }
  s += `<g class="cursor" visibility="hidden"><line/><circle r="5"/></g>`;
  return s + '</svg>';
}

function attachChartHover(container, samples) {
  const svg = container.querySelector('svg');
  if (!svg || samples.length < 2) return;
  const { tmax, X, Y } = lineScales(samples);
  const cursor = svg.querySelector('.cursor');
  const line = cursor.querySelector('line'), dot = cursor.querySelector('circle');
  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.hidden = true;
  container.append(tip);

  const valuesAt = (t) => {
    let i = samples.findIndex((s) => s[0] >= t);
    if (i < 1) i = i === 0 ? 1 : samples.length - 1;
    const a = samples[i - 1], c = samples[i];
    const f = Math.min(1, Math.max(0, (t - a[0]) / (c[0] - a[0] || 1)));
    const mix = (k) => a[k] + (c[k] - a[k]) * f;
    return { speed: mix(1), dist: mix(2) };
  };

  const show = (e) => {
    const rect = svg.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) / rect.width) * LC.W;
    const t = Math.min(tmax, Math.max(0, ((vx - LC.l) / (LC.W - LC.l - LC.r)) * tmax));
    const p = valuesAt(t), x = X(t);
    line.setAttribute('x1', x); line.setAttribute('x2', x);
    line.setAttribute('y1', LC.t); line.setAttribute('y2', LC.H - LC.b);
    dot.setAttribute('cx', x); dot.setAttribute('cy', Y(p.speed));
    cursor.setAttribute('visibility', 'visible');
    tip.textContent = `${st.fmtDuration(t)} · ${fmtSpeed(p.speed)} km/h · ${st.fmtKm(p.dist)} km`;
    tip.hidden = false;
    const half = tip.offsetWidth / 2 + 4;
    tip.style.left = `${Math.min(rect.width - half, Math.max(half, (x / LC.W) * rect.width))}px`;
  };
  const hide = () => { cursor.setAttribute('visibility', 'hidden'); tip.hidden = true; };

  svg.addEventListener('pointermove', show);
  svg.addEventListener('pointerdown', show);
  svg.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hide(); });
  svg.addEventListener('pointercancel', hide);
}

function totals(prefix, since) {
  const t = st.summarize(workouts, since);
  $(prefix.dist).textContent = st.fmtNum(t.distance / 1000, t.distance >= 100000 ? 0 : 1);
  $(prefix.sub).textContent = `${t.count} Training${t.count === 1 ? '' : 's'} · ${st.fmtDuration(t.duration)} · ${Math.round(t.calories)} kcal`;
}

function renderHistory() {
  workouts = store.loadWorkouts();
  const now = Date.now();
  totals({ dist: 'wDist', sub: 'wSub' }, st.startOfWeek(now));
  totals({ dist: 'mDistM', sub: 'mSub' }, st.startOfMonth(now));
  totals({ dist: 'tDist', sub: 'tSub' }, 0);
  $('barChart').innerHTML = barChart(st.lastDays(workouts, 14, now));
  $('emptyHistory').hidden = workouts.length > 0;
  $('workoutList').replaceChildren(...workouts.map((w) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    const mk = (cls, text) => Object.assign(document.createElement('span'), { className: cls, textContent: text });
    b.append(
      mk('when', st.fmtDateTime(w.startedAt)),
      mk('dist', `${st.fmtKm(w.distance)} km`),
      mk('meta', `${st.fmtDuration(w.duration)} · ${Math.round(w.calories)} kcal · Ø ${fmtSpeed(w.avgSpeed)} km/h`),
    );
    b.onclick = () => openDetail(w.id);
    li.append(b);
    return li;
  }));
}

function openDetail(id) {
  const w = workouts.find((x) => x.id === id);
  if (!w) return;
  detailId = id;
  $('detailTitle').textContent = st.fmtDateTime(w.startedAt) + (w.partial ? ' (ab Mitte aufgezeichnet)' : '');
  const tile = (k, v) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  $('detailTiles').innerHTML =
    tile('Dauer', st.fmtDuration(w.duration)) + tile('Strecke', `${st.fmtKm(w.distance)} km`) +
    tile('Kalorien', `${Math.round(w.calories)} kcal`) + tile('Ø Tempo', `${fmtSpeed(w.avgSpeed)} km/h`) +
    tile('Max. Tempo', `${fmtSpeed(w.maxSpeed)} km/h`) + tile('Schritte (ca.)', st.estimateSteps(w.distance, settings.stepLengthCm));
  $('detailChart').innerHTML = lineChart(w.samples);
  attachChartHover($('detailChart'), w.samples);
  $('chartHint').hidden = w.samples.length < 2;
  $('detail').showModal();
}

// ---------------------------------------------------------------- settings

function syncSettingsUI() {
  document.querySelectorAll('[data-setting]').forEach((el) => {
    const v = getPath(settings, el.dataset.setting);
    if (el.type === 'checkbox') el.checked = !!v;
    else if (el.dataset.type === 'list') el.value = (v ?? []).join(', ');
    else el.value = v ?? '';
  });
}

function readSetting(el) {
  if (el.type === 'checkbox') return el.checked;
  if (el.dataset.type === 'list') {
    return [...new Set(el.value.split(/[,;\s]+/).map((x) => parseFloat(x.replace(',', '.'))).filter((x) => x >= 0.5 && x <= 20))].sort((a, b) => a - b);
  }
  if (el.type === 'number' || el.dataset.type === 'number') {
    const n = parseFloat(el.value);
    return Number.isFinite(n) ? n : null;
  }
  return el.value;
}

document.querySelectorAll('[data-setting]').forEach((el) => {
  el.addEventListener('change', () => {
    const val = readSetting(el);
    if (el.dataset.setting === 'stepLengthCm' && !val) { syncSettingsUI(); return; }
    setPath(settings, el.dataset.setting, val);
    if (!store.saveSettings(settings)) toast('Einstellungen konnten nicht gespeichert werden.');
    syncSettingsUI();
    presetKey = '';
    updateWakeLock();
    schedule();
  });
});

// ---------------------------------------------------------------- wake lock

let wakeLock = null;
async function updateWakeLock() {
  const want = settings.keepAwake && tracker.active && document.visibilityState === 'visible';
  try {
    if (want && !wakeLock && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } else if (!want && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {}
}

// ---------------------------------------------------------------- events

function showView(name) {
  currentView = name;
  for (const v of ['train', 'history', 'settings']) {
    $(`view-${v}`).hidden = v !== name;
    $(`tab-${v}`).setAttribute('aria-selected', String(v === name));
  }
  $('viewTitle').textContent = { train: 'Training', history: 'Verlauf', settings: 'Einstellungen' }[name];
  store.saveTab(name);
  if (name === 'history') renderHistory();
}
for (const v of ['train', 'history', 'settings']) $(`tab-${v}`).onclick = () => showView(v);

pad.addEventListener('status', schedule);
pad.addEventListener('info', schedule);
pad.addEventListener('data', () => {
  const d = pad.data;
  if (d.state === 'running' || (d.state === undefined && d.speed > 0)) {
    speedHist.push(d.speed ?? 0);
    if (speedHist.length > 90) speedHist.shift();
  }
  tracker.feed(d);
  schedule();
});
pad.addEventListener('connected', () => tracker.connectionRestored());
pad.addEventListener('disconnected', () => { tracker.connectionLost(); schedule(); });
pad.addEventListener('error', (e) => toast(`Verbindung fehlgeschlagen: ${e.detail}`));

tracker.addEventListener('start', () => { speedHist.length = 0; updateWakeLock(); });
tracker.addEventListener('end', updateWakeLock);
tracker.addEventListener('saved', (e) => {
  const { workout: w, stored } = e.detail;
  workouts = store.loadWorkouts();
  renderToday();
  if (currentView === 'history') renderHistory();
  toast(
    stored
      ? `Training gespeichert: ${st.fmtKm(w.distance)} km in ${st.fmtDuration(w.duration)}`
      : 'Training konnte nicht gespeichert werden (Speicher voll oder gesperrt). Bitte Daten exportieren.',
    stored ? { label: 'Ansehen', fn: () => { showView('history'); openDetail(w.id); } } : undefined,
  );
});
tracker.addEventListener('discarded', () => toast('Zu kurz – nicht gespeichert.'));

document.addEventListener('visibilitychange', updateWakeLock);
addEventListener('pagehide', () => tracker.flush());

const connect = (any) => pad.connectNew({ any }).catch((e) => toast(`Bluetooth-Fehler: ${e.message}`));
$('btnConnect').onclick = () => connect(false);
$('btnConnectOther').onclick = () => connect(true);
$('btnCancel').onclick = () => pad.disconnect();
$('btnDisconnect').onclick = () => pad.disconnect();
$('btnForget').onclick = () => { if (confirm('Gespeichertes Laufband vergessen?')) pad.forget(); };

$('btnStart').onclick = () => pad.driver?.cmdStart();
$('btnResume').onclick = () => pad.driver?.cmdStart();
$('btnPause').onclick = () => pad.driver?.cmdPause();
$('btnStop').onclick = () => pad.driver?.cmdStop();
$('spdDown').onclick = () => setTarget(target - settings.speedStep);
$('spdUp').onclick = () => setTarget(target + settings.speedStep);
$('speedRange').oninput = (e) => setTarget(parseFloat(e.target.value));
$('incDown').onclick = () => changeIncline(-1);
$('incUp').onclick = () => changeIncline(1);

$('detailFit').onclick = () => {
  const w = workouts.find((x) => x.id === detailId);
  if (!w) return;
  const d = new Date(w.startedAt), p = (n) => String(n).padStart(2, '0');
  download(`walkingpad-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.fit`, encodeFit(w), 'application/octet-stream');
};
$('detailClose').onclick = () => $('detail').close();
$('detail').addEventListener('click', (e) => { if (e.target === $('detail')) $('detail').close(); });
$('detailDelete').onclick = () => {
  if (!confirm('Dieses Training löschen?')) return;
  store.saveWorkouts(store.loadWorkouts().filter((w) => w.id !== detailId));
  $('detail').close();
  workouts = store.loadWorkouts();
  renderHistory();
  renderToday();
};

$('btnExportJson').onclick = () => download(`walkingpad-${stamp()}.json`, JSON.stringify({ version: 1, workouts: store.loadWorkouts() }), 'application/json');
$('btnExportCsv').onclick = () => download(`walkingpad-${stamp()}.csv`, st.toCsv(store.loadWorkouts()), 'text/csv');
$('fileImport').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const incoming = st.parseImport(await file.text());
  if (!incoming.length) { toast('Keine gültigen Trainings in der Datei gefunden.'); return; }
  const { list, added } = st.mergeWorkouts(store.loadWorkouts(), incoming);
  store.saveWorkouts(list);
  workouts = list;
  renderToday();
  toast(`${added} neue${added === 1 ? 's' : ''} Training${added === 1 ? '' : 's'} importiert.`);
};
$('btnDeleteAll').onclick = () => {
  if (!workouts.length || !confirm(`Alle ${workouts.length} Trainings unwiderruflich löschen?`)) return;
  store.saveWorkouts([]);
  workouts = [];
  renderToday();
  toast('Alle Trainings gelöscht.');
};

// ---------------------------------------------------------------- boot

syncSettingsUI();
renderStatus();
renderToday();
renderTrain();
showView(store.loadTab());
tracker.recover();

if (params.has('demo')) {
  $('demoBanner').hidden = false;
  const driver = new DemoDriver({ fast: Number(params.get('fast')) || 1 });
  pad.useDemo(driver);
  if (params.has('autostart')) setTimeout(() => driver.cmdStart(), 1000);
} else if (pad.supported && settings.autoConnect) {
  pad.autoConnect();
}
