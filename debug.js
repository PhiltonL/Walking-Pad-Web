import { SVC, hex, parseHex, toU8, GattQueue, FitShowDriver, EwayDriver, FtmsDriver, probeFff0 } from './drivers.js';

const $ = (id) => document.getElementById(id);
const uuid16 = (n) => BluetoothUUID.getService(n);
const short = (u) => (/^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/i.exec(u)?.[1] ?? u);

const DIS_CHARS = { 0x2a29: 'Hersteller', 0x2a24: 'Modell', 0x2a25: 'Seriennummer', 0x2a27: 'Hardware', 0x2a26: 'Firmware', 0x2a28: 'Software' };

const S = {
  device: null,
  drivers: [],
  primary: null,
  chars: new Map(),
  devInfo: {},
  targetSpeed: 1.0,
  targetIncline: 0,
  editedAt: 0,
  rows: [],
  lastRowAt: 0,
  logLines: [],
  lastByKey: new Map(),
  speedTimer: null,
};

const queue = new GattQueue();
const ctx = { queue, log };

// ---------------------------------------------------------------- log

function log(kind, src, payload, note) {
  const text = payload instanceof Uint8Array ? hex(payload) : String(payload);
  const key = kind + src;
  if ($('dedupe').checked && (kind === 'rx' || kind === 'tx')) {
    if (S.lastByKey.get(key) === text) return;
    S.lastByKey.set(key, text);
  }
  const line = `${new Date().toISOString().slice(11, 23)}  ${kind.padEnd(4)} ${short(src).padEnd(8)} ${text}${note ? '   · ' + note : ''}`;
  S.logLines.push(line);
  if (S.logLines.length > 20000) S.logLines.splice(0, 5000);
  const pre = $('log');
  pre.append(line + '\n');
  if (pre.childNodes.length > 800) pre.removeChild(pre.firstChild);
  if ($('autoscroll').checked) pre.scrollTop = pre.scrollHeight;
}

// ---------------------------------------------------------------- connect

async function connect() {
  const optionalServices = [SVC.FTMS, SVC.FFF0, SVC.F100, SVC.DIS, SVC.HR, SVC.BATT];
  const opts = $('allDevices').checked
    ? { acceptAllDevices: true, optionalServices }
    : {
        filters: [{ namePrefix: 'FIT' }, { namePrefix: 'FS-' }, { namePrefix: 'EW-' }, { services: [SVC.FTMS] }, { services: [SVC.FFF0] }],
        optionalServices,
      };

  let device;
  try {
    device = await navigator.bluetooth.requestDevice(opts);
  } catch (e) {
    if (e.name !== 'NotFoundError') log('err', 'app', e.message);
    return;
  }

  setStatus(`verbinde mit ${device.name ?? device.id} …`);
  $('btnConnect').disabled = true;
  try {
    device.addEventListener('gattserverdisconnected', onDisconnected);
    const server = await device.gatt.connect();
    S.device = device;
    $('btnDisconnect').disabled = false;
    log('app', 'app', `verbunden mit ${device.name ?? device.id}`);
    const services = await server.getPrimaryServices();
    await explore(services);
    await setupDrivers(services);
    setStatus(`${device.name ?? 'Gerät'} · ${S.drivers.map((d) => d.name).join(' + ') || 'kein Protokoll'}`, true);
  } catch (e) {
    log('err', 'app', e.message);
    setStatus('Fehler – siehe Log');
    device.gatt.connected && device.gatt.disconnect();
    $('btnConnect').disabled = false;
  }
}

async function explore(services) {
  const lines = [];
  S.chars.clear();
  for (const s of services) {
    lines.push(`Service ${short(s.uuid)}  ${s.uuid}`);
    let chars = [];
    try { chars = await s.getCharacteristics(); } catch (e) { lines.push(`  (${e.message})`); }
    for (const c of chars) {
      const p = c.properties;
      const props = ['read', 'write', 'writeWithoutResponse', 'notify', 'indicate'].filter((k) => p[k]).join(' ');
      lines.push(`  └ ${short(c.uuid)}  [${props}]`);
      S.chars.set(c.uuid, c);
      if (s.uuid === uuid16(SVC.DIS) && p.read) {
        const n = parseInt(short(c.uuid), 16);
        try {
          const v = await queue.run(async () => toU8(await c.readValue()));
          S.devInfo[DIS_CHARS[n] ?? short(c.uuid)] = new TextDecoder().decode(v).replace(/\0+$/, '');
        } catch {}
      }
      if (s.uuid === uuid16(SVC.BATT) && p.read) {
        try { S.devInfo.Batterie = (await queue.run(async () => toU8(await c.readValue())))[0] + ' %'; } catch {}
      }
    }
  }
  $('gatt').textContent = lines.join('\n');
  const sel = $('rawChar');
  sel.innerHTML = '';
  for (const [u, c] of S.chars) {
    if (c.properties.write || c.properties.writeWithoutResponse) sel.add(new Option(`schreiben → ${short(u)}`, u));
  }
  $('btnRaw').disabled = sel.options.length === 0;
  renderInfo();
}

async function setupDrivers(services) {
  const find = (n) => services.find((s) => s.uuid === uuid16(n));
  const ch = (n) => S.chars.get(BluetoothUUID.getCharacteristic(n));
  const drivers = [];

  if (find(SVC.F100)) {
    const key = ch(0xf105);
    if (ch(0xf100)) drivers.push(new FitShowDriver(ctx, { proto: 3, tx: ch(0xf100), rx: ch(0xf100), key }));
    else if (ch(0xf101)) drivers.push(new FitShowDriver(ctx, { proto: 1, tx: ch(0xf101), rx: ch(0xf101), key }));
  } else if (find(SVC.FFF0) && ch(0xfff1) && ch(0xfff2)) {
    log('app', 'app', 'Service fff0 gefunden – teste FitShow- und Eway-Protokoll …');
    const kind = await probeFff0(ctx, ch(0xfff2), ch(0xfff1));
    log('app', 'app', `fff0-Protokoll: ${kind ?? 'keine Antwort'}`);
    if (kind === 'fitshow') drivers.push(new FitShowDriver(ctx, { proto: 1, tx: ch(0xfff2), rx: ch(0xfff1) }));
    if (kind === 'eway') drivers.push(new EwayDriver(ctx, { tx: ch(0xfff2), rx: ch(0xfff1) }));
  }
  if (find(SVC.FTMS)) drivers.push(new FtmsDriver(ctx, find(SVC.FTMS)));

  for (const d of drivers) {
    d.addEventListener('data', () => onData(d));
    d.addEventListener('info', () => { renderInfo(); renderControls(); });
    try {
      await d.init();
      log('app', 'app', `${d.name} initialisiert`);
    } catch (e) {
      log('err', d.name, e.message);
    }
  }
  S.drivers = drivers;
  S.primary = drivers[0] ?? null;

  const sel = $('driverSelect');
  sel.innerHTML = '';
  drivers.forEach((d, i) => sel.add(new Option(d.name, i)));
  sel.disabled = drivers.length < 2;
  renderControls();
  renderFields();
}

function onDisconnected() {
  log('app', 'app', 'Verbindung getrennt');
  for (const d of S.drivers) d.dispose();
  S.drivers = [];
  S.primary = null;
  S.device = null;
  setStatus('getrennt');
  $('btnConnect').disabled = false;
  $('btnDisconnect').disabled = true;
  renderControls();
}

function setStatus(text, on = false) {
  const el = $('status');
  el.textContent = text;
  el.classList.toggle('on', on);
}

// ---------------------------------------------------------------- data / render

const fmt = {
  speed: (v) => v.toFixed(1),
  distance: (m) => (m / 1000).toFixed(2),
  time: (s) => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(sec).padStart(2, '0')}`;
  },
  calories: (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1)),
  steps: String,
  heartRate: (v) => (v ? String(v) : '–'),
  incline: String,
  state: String,
};

function onData(driver) {
  if (driver === S.primary) {
    const d = driver.data;
    for (const k of Object.keys(fmt)) {
      if (d[k] !== undefined) $('t-' + k).textContent = fmt[k](d[k]);
    }
    if (d.speed !== undefined && Date.now() - S.editedAt > 3000 && d.state === 'running') {
      S.targetSpeed = d.speed;
      $('targetSpeed').textContent = S.targetSpeed.toFixed(1);
      $('speedRange').value = S.targetSpeed;
    }
    if (d.incline !== undefined && Date.now() - S.editedAt > 3000) {
      S.targetIncline = d.incline;
      $('targetIncline').textContent = S.targetIncline;
    }
    record(d);
  }
  renderFieldsThrottled();
}

let fieldsPending = false;
function renderFieldsThrottled() {
  if (fieldsPending) return;
  fieldsPending = true;
  requestAnimationFrame(() => { fieldsPending = false; renderFields(); });
}

function kvTable(sections) {
  const t = document.createElement('table');
  for (const [title, obj] of sections) {
    const entries = Object.entries(obj);
    if (!entries.length) continue;
    const th = t.insertRow().appendChild(document.createElement('th'));
    th.colSpan = 2;
    th.textContent = title;
    for (const [k, v] of entries) {
      const r = t.insertRow();
      r.insertCell().textContent = k;
      const c = r.insertCell();
      c.className = 'v';
      c.textContent = typeof v === 'number' && !Number.isInteger(v) ? +v.toFixed(3) : String(v);
    }
  }
  return t;
}

function renderFields() {
  if (!S.drivers.length) return;
  $('fields').replaceChildren(kvTable(S.drivers.map((d) => [d.name + (d === S.primary ? ' (Steuerung)' : ''), d.data])));
}

function renderInfo() {
  $('info').replaceChildren(kvTable([['Device Information Service', S.devInfo], ...S.drivers.map((d) => [d.name, d.info])]));
}

function renderControls() {
  const d = S.primary;
  const on = !!d;
  for (const id of ['btnStart', 'btnStop']) $(id).disabled = !on;
  document.querySelectorAll('.spd, #speedRange').forEach((b) => (b.disabled = !on));
  const caps = d?.caps() ?? {};
  $('btnPause').disabled = !on || !caps.pause;
  $('inclineRow').hidden = !caps.incline;
  $('t-incline-u').textContent = d instanceof FtmsDriver ? '%' : '';

  const min = d?.info.minSpeed || 0.5, max = d?.info.maxSpeed || 6;
  const r = $('speedRange');
  r.min = min; r.max = max; r.step = d?.info.speedStep || 0.1;

  const presets = $('presets');
  presets.replaceChildren();
  if (on) {
    for (let v = Math.ceil(min); v <= max; v += 1) {
      const b = document.createElement('button');
      b.textContent = `${v.toFixed(1)}`;
      b.onclick = () => setTarget(v);
      presets.append(b);
    }
  }
  const extras = $('extras');
  extras.replaceChildren();
  for (const x of d?.extras() ?? []) {
    const b = document.createElement('button');
    b.textContent = x.label;
    b.onclick = x.fn;
    extras.append(b);
  }
  $('ctrlHint').hidden = !(d instanceof FitShowDriver);
}

// ---------------------------------------------------------------- controls

function setTarget(v) {
  const d = S.primary;
  if (!d) return;
  const min = d.info.minSpeed || 0.5, max = d.info.maxSpeed || 6;
  S.targetSpeed = Math.round(Math.min(max, Math.max(min, v)) * 10) / 10;
  S.editedAt = Date.now();
  $('targetSpeed').textContent = S.targetSpeed.toFixed(1);
  $('speedRange').value = S.targetSpeed;
  clearTimeout(S.speedTimer);
  S.speedTimer = setTimeout(() => d.setSpeed(S.targetSpeed), 250);
}

function setIncline(v) {
  const d = S.primary;
  if (!d) return;
  const { minIncline = 0, maxIncline = 15 } = d.info;
  S.targetIncline = Math.min(maxIncline, Math.max(minIncline, v));
  S.editedAt = Date.now();
  $('targetIncline').textContent = S.targetIncline;
  d.setIncline(S.targetIncline);
}

$('btnConnect').onclick = connect;
$('btnDisconnect').onclick = () => S.device?.gatt.disconnect();
$('btnStart').onclick = () => S.primary?.cmdStart();
$('btnPause').onclick = () => S.primary?.cmdPause();
$('btnStop').onclick = () => S.primary?.cmdStop();
document.querySelectorAll('.spd').forEach((b) => (b.onclick = () => setTarget(S.targetSpeed + parseFloat(b.dataset.ds))));
$('speedRange').oninput = (e) => setTarget(parseFloat(e.target.value));
$('inclUp').onclick = () => setIncline(S.targetIncline + (S.primary?.info.inclineStep || 1));
$('inclDown').onclick = () => setIncline(S.targetIncline - (S.primary?.info.inclineStep || 1));
$('driverSelect').onchange = (e) => {
  S.primary = S.drivers[+e.target.value];
  renderControls();
  renderFields();
};

$('btnRaw').onclick = () => {
  const c = S.chars.get($('rawChar').value);
  let bytes = parseHex($('rawHex').value);
  if (!c || !bytes.length) return;
  if ($('rawFrame').value === 'fitshow') bytes = FitShowDriver.frame([...bytes]);
  if ($('rawFrame').value === 'eway') bytes = EwayDriver.frame(bytes[0], [...bytes.slice(1)]);
  queue.run(async () => {
    log('tx', c.uuid, bytes, 'manuell');
    if (c.properties.write) await c.writeValueWithResponse(bytes);
    else await c.writeValueWithoutResponse(bytes);
  }).catch((e) => log('err', c.uuid, e.message));
};
$('rawHex').onkeydown = (e) => { if (e.key === 'Enter') $('btnRaw').click(); };

// ---------------------------------------------------------------- recording / export

function record(d) {
  if (!$('record').checked || Date.now() - S.lastRowAt < 1000) return;
  S.lastRowAt = Date.now();
  S.rows.push({ timestamp: new Date().toISOString(), protocol: S.primary.name, ...d });
  $('recCount').textContent = `${S.rows.length} Zeilen`;
}

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

$('btnCsv').onclick = () => {
  if (!S.rows.length) return;
  const cols = [...new Set(S.rows.flatMap(Object.keys))];
  const esc = (v) => (v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const csv = [cols.join(','), ...S.rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
  download(`walkingpad-${stamp()}.csv`, csv, 'text/csv');
};
$('btnRecClear').onclick = () => { S.rows = []; $('recCount').textContent = '0 Zeilen'; };
$('btnLogClear').onclick = () => { S.logLines = []; S.lastByKey.clear(); $('log').textContent = ''; };
$('btnLogSave').onclick = () => download(`walkingpad-log-${stamp()}.txt`, S.logLines.join('\n'), 'text/plain');

// ---------------------------------------------------------------- boot

if (!navigator.bluetooth) {
  $('unsupported').hidden = false;
  $('btnConnect').disabled = true;
}
window.walkingPad = S;
renderControls();
