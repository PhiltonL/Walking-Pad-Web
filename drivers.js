// Supported protocols:
//   FitShow – frames 0x02 | payload | xor | 0x03 on service F100 (char F101/F100) or FFF0 (notify FFF1, write FFF2)
//   Eway    – frames 0xF0 | cmd | len | payload | sum on service FFF0
//   FTMS    – Bluetooth SIG Fitness Machine Service 0x1826

export const SVC = { FTMS: 0x1826, FFF0: 0xfff0, F100: 0xf100, DIS: 0x180a, HR: 0x180d, BATT: 0x180f };

export const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join(' ');
export const parseHex = (s) =>
  Uint8Array.from((s.replace(/0x/gi, '').match(/[0-9a-f]{2}/gi) || []).map((h) => parseInt(h, 16)));
export const toU8 = (dv) => new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength).slice();

const u16 = (b, i) => b[i] | (b[i + 1] << 8);
const s16 = (b, i) => { const v = u16(b, i); return v & 0x8000 ? v - 0x10000 : v; };
const u24 = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const s8 = (v) => (v & 0x80 ? v - 256 : v);
const bits = (v, names) => names.filter((_, i) => v & (1 << i)).join(', ') || '–';

export class GattQueue {
  constructor() { this.p = Promise.resolve(); this.pending = 0; }
  run(fn) {
    this.pending++;
    const r = this.p.then(fn).finally(() => this.pending--);
    this.p = r.catch(() => {});
    return r;
  }
}

async function rawWrite(ctx, char, bytes, note) {
  return ctx.queue.run(async () => {
    ctx.log('tx', char.uuid, bytes, note);
    if (char.properties.write) await char.writeValueWithResponse(bytes);
    else await char.writeValueWithoutResponse(bytes);
  }).catch((e) => ctx.log('err', char.uuid, e.message));
}

class Driver extends EventTarget {
  constructor(name, ctx) {
    super();
    this.name = name;
    this.ctx = ctx;
    this.timers = [];
    this.info = {};
    this.data = {};
  }
  log(...a) { this.ctx.log(...a); }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  every(ms, fn) { this.timers.push(setInterval(fn, ms)); }
  later(ms, fn) { this.timers.push(setTimeout(fn, ms)); }
  dispose() { this.timers.forEach(clearInterval); this.timers = []; }
  write(char, bytes, note) { return rawWrite(this.ctx, char, bytes, note); }
  read(char) { return this.ctx.queue.run(async () => toU8(await char.readValue())); }
  async subscribe(char, handler) {
    char.addEventListener('characteristicvaluechanged', (e) => {
      const b = toU8(e.target.value);
      this.log('rx', char.uuid, b, this.name);
      handler(b);
    });
    await this.ctx.queue.run(() => char.startNotifications());
  }
  update(patch) { Object.assign(this.data, patch); this.emit('data', this.data); }
  setInfo(patch) { Object.assign(this.info, patch); this.emit('info', this.info); }
  caps() {
    const { minIncline, maxIncline } = this.info;
    return {
      incline: maxIncline !== undefined && maxIncline !== minIncline,
      pause: this.info.supportPause !== false,
    };
  }
  extras() { return []; }
}

// ---------------------------------------------------------------- FitShow
// Frame: 0x02 | payload… | xor(payload) | 0x03
// Proto 1 (treadmill on fff0: notify fff1, write fff2) and proto 3 (char f100 in service f100).

const FS_STATE_P1 = { 0: 'idle', 1: 'finished', 2: 'starting', 3: 'running', 4: 'stopping', 5: 'error', 6: 'safety key', 7: 'sleep', 10: 'paused' };
const FS_STATE_P3 = { 0: 'idle', 1: 'starting', 2: 'running', 3: 'paused', 4: 'stopping', 5: 'pausing', 6: 'error' };

export class FitShowDriver extends Driver {
  static frame(payload) {
    let x = 0;
    for (const b of payload) x ^= b;
    return Uint8Array.from([0x02, ...payload, x & 0xff, 0x03]);
  }
  static valid(b) {
    if (b.length < 4 || b[0] !== 0x02 || b[b.length - 1] !== 0x03) return false;
    let x = 0;
    for (let i = 1; i < b.length - 1; i++) x ^= b[i];
    return x === 0;
  }

  constructor(ctx, { proto, tx, rx, key }) {
    super(`FitShow P${proto}`, ctx);
    Object.assign(this, { proto, tx, rx, key });
    this.buf = [];
    this.type = 0;
  }

  send(payload) { return this.write(this.tx, FitShowDriver.frame(payload)); }

  async init() {
    await this.subscribe(this.rx, (b) => this.feed(b));
    if (this.key && this.key !== this.rx) {
      await this.subscribe(this.key, (b) => {
        if (FitShowDriver.valid(b)) this.update({ lastKeyEvent: `${b[2]} / ${b[3]} / ${b[4]}` });
      });
    }
    if (this.proto === 1) {
      this.send([0x50, 0, 0, 0, 0, 0, 0, 0, 0]);
      this.send([0x50, 3]);
      this.send([0x50, 2]);
      this.send([0x51]);
    } else {
      const ts = Math.floor(Date.now() / 1000);
      this.send([0x52, 1, ts & 255, (ts >> 8) & 255, (ts >> 16) & 255, (ts >>> 24) & 255]);
      this.send([0x51, 0]);
    }
    // The app polls every 9 × 50 ms.
    this.every(450, () => {
      if (this.ctx.queue.pending < 3) this.send(this.proto === 1 ? [0x51] : [0x51, 0]);
    });
  }

  feed(chunk) {
    this.buf.push(...chunk);
    while (this.buf.length) {
      const s = this.buf.indexOf(0x02);
      if (s < 0) { this.buf = []; return; }
      if (s > 0) this.buf.splice(0, s);
      let found = false;
      for (let j = 3; j < this.buf.length; j++) {
        if (this.buf[j] === 0x03 && FitShowDriver.valid(this.buf.slice(0, j + 1))) {
          this.handle(Uint8Array.from(this.buf.splice(0, j + 1)));
          found = true;
          break;
        }
      }
      if (!found) {
        if (this.buf.length > 64) this.buf.shift();
        else return;
      }
    }
  }

  handle(b) {
    const cmd = b[1];
    if (this.proto === 1) {
      if (cmd === 0x50) this.paramP1(b);
      else if (cmd === 0x51) this.stateP1(b);
      else if (cmd === 0x53 && b[2] === 1 && b.length === 6) this.update({ countdown: b[3] });
    } else {
      if (cmd === 0x52) this.paramP3(b);
      else if (cmd === 0x51) this.stateP3(b);
      else if (cmd === 0x53 && b[2] === 1 && b.length === 6) this.update({ countdown: b[3] });
    }
  }

  flags(f, light) {
    this.setInfo({
      imperial: !!(f & 1),
      supportPause: !!(f & 2),
      supportHeart: !!(f & 8),
      ...(light !== undefined && { light }),
    });
  }

  paramP1(b) {
    const sub = b[2], n = b.length;
    if (sub === 0) {
      this.setInfo({ modelBytes: hex(b.slice(3, n - 2)) });
    } else if (sub === 2 && n >= 7) {
      this.setInfo({ maxSpeed: b[3] / 10, minSpeed: b[4] / 10 });
      if (n > 7 && !this.info.newProtocol) this.flags(b[5], n > 8 ? b[6] : undefined);
    } else if (sub === 3) {
      if (n === 7) {
        const lo = s8(b[4]);
        this.setInfo({ maxIncline: s8(b[3]) - (lo > 0 ? lo : 0), minIncline: lo >= 0 ? -lo : lo });
      } else if (n > 7) {
        this.setInfo({ maxIncline: s8(b[3]), minIncline: s8(b[4]), newProtocol: true });
        this.flags(b[5], n > 8 ? b[6] : undefined);
      }
    }
  }

  stateP1(b) {
    const st = b[2];
    const p = { state: FS_STATE_P1[st] ?? `unknown(${st})`, stateCode: st };
    if (st === 2) p.countdown = b[3];
    if (st === 5) p.errorCode = b[3];
    if ((st === 3 || st === 4 || st === 10) && b.length > 15) {
      p.speed = b[3] / 10;
      p.incline = s8(b[4]);
      p.heartRate = b[13];
      if (st === 3) {
        p.time = u16(b, 5);
        p.distance = u16(b, 7);
        p.calories = u16(b, 9) / 10;
        p.steps = u16(b, 11);
      }
      if (b.length > 16) p.undecodedTail = hex(b.slice(14, b.length - 2));
    }
    if (st === 0 || st === 1) p.speed = 0;
    this.update(p);
  }

  paramP3(b) {
    if (b.length <= 6) return;
    const type = b[2] & 15, mask = b[4];
    this.type = type;
    this.flags(b[3]);
    const info = { deviceType: type };
    let i = 5;
    if (type === 0) {
      if (mask & 1) { info.minSpeed = b[5] / 10; info.maxSpeed = b[6] / 10; i = 7; }
      if (mask & 2) { info.minIncline = s8(b[i]); info.maxIncline = b[i + 1]; i += 2; }
      if (mask & 4) info.fan = b[i++];
      if (mask & 8) info.light = b[i];
    } else {
      if (mask & 1) { info.minLevel = b[5]; info.maxLevel = b[6]; i = 7; }
      if (mask & 2) { info.minIncline = s8(b[i]); info.maxIncline = b[i + 1]; i += 2; }
      if (mask & 8) info.light = b[i];
    }
    this.setInfo(info);
  }

  stateP3(b) {
    if (b.length <= 6) return;
    const st = b[2];
    const p = { state: FS_STATE_P3[st] ?? `unknown(${st})`, stateCode: st };
    if (st === 1) p.countdown = b[3];
    if (st === 6) p.errorCode = b[3];
    if (st !== 1 && st !== 6) {
      const f = u16(b, 3);
      p.fieldFlags = '0x' + f.toString(16).padStart(4, '0');
      let i = 5;
      if (this.type === 0) {
        if (f & 1) p.speed = b[i++] / 10;
        if (f & 2) p.incline = s8(b[i++]);
        if (f & 4) p.unknownField4 = b[i++];
      } else {
        if (f & 1) { p.speed = u16(b, i) / 100; i += 2; }
        if (f & 2) p.incline = s8(b[i++]);
        if (f & 4) p.level = b[i++];
      }
      if (f & 8) p.heartRate = b[i++];
      if (f & 16) { p.time = u16(b, i); i += 2; }
      if (f & 32) { p.calories = u16(b, i) / 10; i += 2; }
      if (f & 64) { p.distance = u24(b, i); i += 3; }
      if (f & 128) { p.steps = u16(b, i); i += 2; }
      if (f & 256) p.cadence = b[i++];
      if (f & 512) { p.power = u16(b, i); i += 2; }
    }
    this.update(p);
  }

  cmdStart() {
    if (this.proto === 3) return this.send([0x53, 1]);
    return this.send(this.info.newProtocol ? [0x53, 1] : [0x53, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
  }
  cmdPause() { return this.send(this.proto === 1 ? [0x53, 10] : [0x53, 3]); }
  cmdStop() { return this.send(this.proto === 1 ? [0x53, 3] : [0x53, 4]); }
  setSpeed(kmh, incline = this.data.incline ?? 0) {
    const v = Math.round(kmh * 10);
    if (this.proto === 3) return this.send([0x54, 1, v]);
    return this.send([0x53, 2, v, incline & 0xff]);
  }
  setIncline(inc) {
    if (this.proto === 3) return this.send([0x54, 2, inc & 0xff]);
    return this.send([0x53, 2, Math.round((this.data.speed ?? 0) * 10), inc & 0xff]);
  }
  setFan(v) { return this.send(this.proto === 3 ? [0x54, 4, v] : [0x5c, 2, v]); }
  setLight(v) { return this.send(this.proto === 3 ? [0x54, 8, v] : [0x5c, 1, v, 0, 0, 0]); }

  extras() {
    const x = [];
    if (this.info.fan) for (let i = 0; i <= this.info.fan; i++) x.push({ label: `Lüfter ${i}`, fn: () => this.setFan(i) });
    if (this.info.light) {
      x.push({ label: 'Licht an', fn: () => this.setLight(1) });
      x.push({ label: 'Licht aus', fn: () => this.setLight(0) });
    }
    return x;
  }
}

// ---------------------------------------------------------------- Eway
// Frame: 0xF0 | cmd | len | payload(len) | sum(all previous bytes) & 0xFF
// Same characteristics as FitShow (write fff2, notify fff1).

const EW_STATE = { 0: 'none', 1: 'idle', 2: 'starting', 3: 'running', 4: 'paused', 5: 'finished' };
const EW_ERRORS = { 1: 'Drehzahlverlust', 2: 'Überlast', 4: 'Motor', 5: 'Kommunikation', 6: 'Unterspannung', 10: 'Sicherheitsschlüssel abgezogen', 50: 'Wartungshinweis (ölen)' };
const EW_KEYS = { 0: '–', 1: 'Start', 2: 'Stop', 3: 'Set', 4: 'Pause', 5: 'Vol+', 6: 'Vol−', 7: 'Ton', 8: 'Musik zurück', 9: 'Musik vor', 160: 'Lüfter' };

export class EwayDriver extends Driver {
  static frame(cmd, payload = []) {
    const b = [0xf0, cmd, payload.length, ...payload];
    b.push(b.reduce((s, x) => s + x, 0) & 0xff);
    return Uint8Array.from(b);
  }

  constructor(ctx, { tx, rx }) {
    super('Eway', ctx);
    Object.assign(this, { tx, rx });
    this.buf = [];
    this.linked = false;
    this.keepAlive = false;
    this.user = { age: 30, sex: 0, height: 175, weight: 70 };
  }

  send(cmd, payload) { return this.write(this.tx, EwayDriver.frame(cmd, payload)); }

  async init() {
    await this.subscribe(this.rx, (b) => this.feed(b));
    let tries = 0;
    const link = () => {
      if (this.linked) return;
      if (tries++ >= 15) { this.log('err', 'Eway', 'Kein Link nach 15 Versuchen'); return; }
      this.send(0xc0);
      this.later(500, link);
    };
    link();
  }

  feed(chunk) {
    this.buf.push(...chunk);
    while (this.buf.length) {
      const s = this.buf.indexOf(0xf0);
      if (s < 0) { this.buf = []; return; }
      if (s > 0) this.buf.splice(0, s);
      if (this.buf.length < 4) return;
      const n = this.buf[2] + 4;
      if (this.buf.length < n) {
        if (this.buf.length > 64) this.buf.shift();
        return;
      }
      const f = this.buf.slice(0, n);
      if ((f.slice(0, n - 1).reduce((a, x) => a + x, 0) & 0xff) === f[n - 1]) {
        this.buf.splice(0, n);
        this.handle(Uint8Array.from(f));
      } else {
        this.buf.shift();
      }
    }
  }

  handle(b) {
    switch (b[1]) {
      case 0xd0:
        this.linked = true;
        this.send(0xc1, [0, 0]);
        break;
      case 0xd1: this.parseInfo(b); break;
      case 0xd3: this.parseData(b); break;
      case 0xd4: this.send(0xc5, new Array(10).fill(0)); break;
      case 0xd5: this.send(0xc6, [1]); break;
      case 0xd6: this.send(0xc3, [1, 0, 0]); break;
      case 0xdd: {
        const code = b[3];
        this.update({ errorCode: code, error: EW_ERRORS[code] ?? `Fehler ${code}` });
        break;
      }
      case 0xe0: case 0xe1: case 0xde: case 0xdf:
        this.update({ [`response_0x${b[1].toString(16)}`]: hex(b.slice(3, -1)) });
        break;
    }
  }

  parseInfo(b) {
    if (b.length < 16) return;
    const bcd = (x) => (x >> 4) * 10 + (x & 15);
    this.setInfo({
      minSpeed: b[3] / 10,
      maxSpeed: b[4] / 10,
      minIncline: b[5],
      maxIncline: b[6],
      metric: b[7] === 0,
      smart: b[8] === 1,
      protocolCode: b[9],
      modelCode: bcd(b[10]) * 100 + bcd(b[11]),
      software: `C${String(b[12]).padStart(2, '0')}A${String(b[13]).padStart(2, '0')}V${String(b[14]).padStart(2, '0')}`,
    });
    if (!this.keepAlive) {
      this.keepAlive = true;
      this.every(1000, () => {
        if (this.ctx.queue.pending < 3) this.send(0xc3, [0, 0, 0]);
      });
    }
  }

  parseData(b) {
    if (b.length < 20) return;
    const st = b[14];
    this.update({
      state: EW_STATE[st] ?? `unknown(${st})`,
      stateCode: st,
      time: b[4] * 60 + b[3],
      distanceRaw: b[5] * 100 + b[6],
      distance: (b[5] * 100 + b[6]) * 10,
      calories: b[7] * 100 + b[8],
      heartRate: b[9],
      speed: b[10] / 10,
      incline: s8(b[11]),
      paceRaw: b[12] * 100 + b[13],
      sportMode: b[15],
      steps: b[16],
      paceFrequency: b[17],
      hardKey: EW_KEYS[b[18]] ?? b[18],
    });
  }

  cmdStart() {
    if (this.data.stateCode === 4) return this.send(0xc3, [1, 0, 0]);
    const { age, sex, height, weight } = this.user;
    return this.send(0xc4, [0, age, sex, height, weight]);
  }
  cmdPause() { return this.send(0xc3, [4, 0, 0]); }
  cmdStop() { return this.send(0xc3, [2, 0, 0]); }
  setSpeed(kmh) { return this.send(0xc3, [3, Math.round(kmh * 10), (this.data.incline ?? 0) & 0xff]); }
  setIncline(inc) { return this.send(0xc3, [3, Math.round((this.data.speed ?? 0) * 10), inc & 0xff]); }

  extras() {
    return [
      { label: 'Lüfter', fn: () => this.send(0xc3, [0xa0, 0, 0]) },
      { label: 'Lauter', fn: () => this.send(0xc3, [5, 0, 0]) },
      { label: 'Leiser', fn: () => this.send(0xc3, [6, 0, 0]) },
      { label: 'Ton an/aus', fn: () => this.send(0xc3, [7, 0, 0]) },
      { label: 'Musik zurück', fn: () => this.send(0xc3, [8, 0, 0]) },
      { label: 'Musik vor', fn: () => this.send(0xc3, [9, 0, 0]) },
      { label: 'Letztes Training lesen', fn: () => this.send(0xe1) },
      { label: 'Fehlerspeicher lesen', fn: () => this.send(0xe0, [0]) },
    ];
  }
}

export async function probeFff0(ctx, tx, rx) {
  let result = null;
  const onVal = (e) => {
    const b = toU8(e.target.value);
    ctx.log('rx', rx.uuid, b, 'probe');
    if (b[0] === 0x02) result ??= 'fitshow';
    else if (b[0] === 0xf0) result ??= 'eway';
  };
  rx.addEventListener('characteristicvaluechanged', onVal);
  await ctx.queue.run(() => rx.startNotifications());
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await rawWrite(ctx, tx, FitShowDriver.frame([0x50, 2]), 'probe FitShow');
  await rawWrite(ctx, tx, FitShowDriver.frame([0x51]), 'probe FitShow');
  for (let i = 0; i < 15 && !result; i++) await wait(100);
  for (let k = 0; k < 3 && !result; k++) {
    await rawWrite(ctx, tx, EwayDriver.frame(0xc0), 'probe Eway');
    for (let i = 0; i < 6 && !result; i++) await wait(100);
  }
  rx.removeEventListener('characteristicvaluechanged', onVal);
  return result;
}

// ---------------------------------------------------------------- FTMS

const MACHINE_FEATURES = ['Average Speed', 'Cadence', 'Total Distance', 'Inclination', 'Elevation Gain', 'Pace', 'Step Count', 'Resistance Level', 'Stride Count', 'Expended Energy', 'Heart Rate', 'Metabolic Equivalent', 'Elapsed Time', 'Remaining Time', 'Power', 'Force on Belt & Power', 'User Data Retention'];
const TARGET_FEATURES = ['Speed', 'Inclination', 'Resistance', 'Power', 'Heart Rate', 'Expended Energy', 'Step Number', 'Stride Number', 'Distance', 'Training Time', '2 HR Zones', '3 HR Zones', '5 HR Zones', 'Bike Simulation', 'Wheel Circumference', 'Spin Down', 'Cadence'];
const TRAINING = ['Other', 'Idle', 'Warming Up', 'Low Intensity Interval', 'High Intensity Interval', 'Recovery Interval', 'Isometric', 'Heart Rate Control', 'Fitness Test', 'Speed Too Low', 'Speed Too High', 'Cool Down', 'Watt Control', 'Manual Mode', 'Pre-Workout', 'Post-Workout'];
const CP_OPS = { 0: 'Request Control', 1: 'Reset', 2: 'Set Speed', 3: 'Set Incline', 7: 'Start/Resume', 8: 'Stop/Pause' };
const CP_RESULT = { 1: 'Success', 2: 'Not Supported', 3: 'Invalid Parameter', 4: 'Operation Failed', 5: 'Control Not Permitted' };

export function parseTreadmillData(b) {
  const f = u16(b, 0);
  const p = { fieldFlags: '0x' + f.toString(16).padStart(4, '0') };
  let i = 2;
  if (!(f & 1)) { p.speed = u16(b, i) / 100; i += 2; }
  if (f & 2) { p.avgSpeed = u16(b, i) / 100; i += 2; }
  if (f & 4) { p.distance = u24(b, i); i += 3; }
  if (f & 8) { p.incline = s16(b, i) / 10; p.rampAngle = s16(b, i + 2) / 10; i += 4; }
  if (f & 16) { p.elevationGainPos = u16(b, i) / 10; p.elevationGainNeg = u16(b, i + 2) / 10; i += 4; }
  if (f & 32) { p.paceKmPerMin = b[i] / 10; i += 1; }
  if (f & 64) { p.avgPaceKmPerMin = b[i] / 10; i += 1; }
  if (f & 128) {
    p.calories = u16(b, i);
    const perH = u16(b, i + 2), perM = b[i + 4];
    if (perH !== 0xffff) p.kcalPerHour = perH;
    if (perM !== 0xff) p.kcalPerMin = perM;
    i += 5;
  }
  if (f & 256) { p.heartRate = b[i]; i += 1; }
  if (f & 512) { p.met = b[i] / 10; i += 1; }
  if (f & 1024) { p.time = u16(b, i); i += 2; }
  if (f & 2048) { p.remainingTime = u16(b, i); i += 2; }
  if (f & 4096) { p.forceOnBelt = s16(b, i); p.power = s16(b, i + 2); i += 4; }
  if (i < b.length) p.undecodedTail = hex(b.slice(i));
  return p;
}

export class FtmsDriver extends Driver {
  constructor(ctx, service) {
    super('FTMS', ctx);
    this.service = service;
    this.hasControl = false;
    this.cp = null;
  }

  async char(u) {
    try { return await this.service.getCharacteristic(u); } catch { return null; }
  }

  async init() {
    const c = {};
    for (const [k, u] of Object.entries({ feat: 0x2acc, data: 0x2acd, training: 0x2ad3, sr: 0x2ad4, ir: 0x2ad5, cp: 0x2ad9, status: 0x2ada })) {
      c[k] = await this.char(u);
    }
    this.cp = c.cp;
    if (c.feat) {
      const b = await this.read(c.feat);
      const m = u32(b, 0), t = u32(b, 4);
      this.targetBits = t;
      this.setInfo({ machineFeatures: bits(m, MACHINE_FEATURES), targetFeatures: bits(t, TARGET_FEATURES) });
    }
    if (c.sr) {
      const b = await this.read(c.sr);
      this.setInfo({ minSpeed: u16(b, 0) / 100, maxSpeed: u16(b, 2) / 100, speedStep: u16(b, 4) / 100 });
    }
    if (c.ir) {
      const b = await this.read(c.ir);
      this.setInfo({ minIncline: s16(b, 0) / 10, maxIncline: s16(b, 2) / 10, inclineStep: u16(b, 4) / 10 });
    }
    if (c.data) await this.subscribe(c.data, (b) => this.update(parseTreadmillData(b)));
    if (c.status) await this.subscribe(c.status, (b) => this.onStatus(b));
    if (c.training) {
      if (c.training.properties.read) {
        try { this.onTraining(await this.read(c.training)); } catch {}
      }
      if (c.training.properties.notify) await this.subscribe(c.training, (b) => this.onTraining(b));
    }
    if (c.cp) await this.subscribe(c.cp, (b) => this.onCp(b));
  }

  caps() {
    return {
      incline: this.targetBits !== undefined ? !!(this.targetBits & 2) : super.caps().incline,
      pause: true,
    };
  }

  onTraining(b) {
    if (b.length < 2) return;
    const p = { trainingStatus: TRAINING[b[1]] ?? `0x${b[1].toString(16)}` };
    if (b[0] & 1 && b.length > 2) p.trainingStatusText = new TextDecoder().decode(b.slice(2));
    if (b[1] === 1) p.state = 'idle';
    this.update(p);
  }

  onStatus(b) {
    const p = {};
    switch (b[0]) {
      case 0x01: p.machineStatus = 'Reset'; break;
      case 0x02:
        p.machineStatus = b[1] === 2 ? 'Paused by user' : 'Stopped by user';
        p.state = b[1] === 2 ? 'paused' : 'stopped';
        break;
      case 0x03: p.machineStatus = 'Stopped by safety key'; p.state = 'safety key'; break;
      case 0x04: p.machineStatus = 'Started/Resumed by user'; p.state = 'running'; break;
      case 0x05: p.machineStatus = 'Target speed changed'; p.targetSpeed = u16(b, 1) / 100; break;
      case 0x06: p.machineStatus = 'Target incline changed'; p.targetIncline = s16(b, 1) / 10; break;
      case 0xff: p.machineStatus = 'Control permission lost'; this.hasControl = false; break;
      default: p.machineStatus = `op 0x${b[0].toString(16)} ${hex(b.slice(1))}`;
    }
    this.update(p);
  }

  onCp(b) {
    if (b[0] !== 0x80) return;
    const ok = b[2] === 1;
    if (!ok && (b[1] === 0 || b[2] === 5)) this.hasControl = false;
    this.update({ lastControlResponse: `${CP_OPS[b[1]] ?? b[1]}: ${CP_RESULT[b[2]] ?? b[2]}` });
  }

  async control(bytes) {
    if (!this.cp) { this.log('err', 'FTMS', 'Keine Control-Point-Characteristic (0x2AD9)'); return; }
    if (!this.hasControl) {
      this.hasControl = true;
      await this.write(this.cp, Uint8Array.of(0x00));
    }
    return this.write(this.cp, Uint8Array.from(bytes));
  }

  cmdStart() { return this.control([0x07]); }
  cmdStop() { return this.control([0x08, 0x01]); }
  cmdPause() { return this.control([0x08, 0x02]); }
  setSpeed(kmh) { const v = Math.round(kmh * 100); return this.control([0x02, v & 255, v >> 8]); }
  setIncline(pct) { const v = Math.round(pct * 10) & 0xffff; return this.control([0x03, v & 255, v >> 8]); }
  extras() { return [{ label: 'FTMS Reset', fn: () => this.control([0x01]) }]; }
}
