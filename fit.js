// Minimal FIT activity encoder (Garmin FIT protocol 2.0): one session, one lap, 1 record per sample.
// Message and field numbers follow the FIT SDK profile.

const FIT_EPOCH_S = 631065600;
const SPORT_WALKING = 11;
const SUB_SPORT_INDOOR_WALKING = 27;
const CRC_TABLE = [0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400];

const BASE_TYPE = { enum: 0x00, u8: 0x02, u16: 0x84, u32: 0x86, u32z: 0x8c };
const SIZE = { enum: 1, u8: 1, u16: 2, u32: 4, u32z: 4 };

function crc16(bytes, crc = 0) {
  for (const b of bytes) {
    let tmp = CRC_TABLE[crc & 0xf];
    crc = ((crc >> 4) & 0x0fff) ^ tmp ^ CRC_TABLE[b & 0xf];
    tmp = CRC_TABLE[crc & 0xf];
    crc = ((crc >> 4) & 0x0fff) ^ tmp ^ CRC_TABLE[(b >> 4) & 0xf];
  }
  return crc;
}

const toFitTime = (ms) => Math.round(ms / 1000) - FIT_EPOCH_S;

function recordsOf(w) {
  const rows = new Map();
  const add = (t, kmh, dist) => rows.set(Math.round(t), { t: Math.round(t), kmh, dist });
  const s = w.samples ?? [];
  const first = s[0];
  add(0, first?.[1] ?? w.avgSpeed, 0);
  for (const [t, kmh, dist] of s) add(Math.min(t, w.duration), kmh, dist);
  add(w.duration, s.at(-1)?.[1] ?? w.avgSpeed, w.distance);
  return [...rows.values()].sort((a, b) => a.t - b.t);
}

export function encodeFit(w, tzOffsetMin = -new Date().getTimezoneOffset()) {
  const body = [];
  const put = (value, size) => {
    const n = Math.max(0, Math.min(2 ** (8 * size) - 1, Math.round(value) || 0));
    for (let i = 0; i < size; i++) body.push(Math.floor(n / 2 ** (8 * i)) % 256);
  };
  const define = (local, global, fields) => {
    body.push(0x40 | local, 0, 0, global & 0xff, global >> 8, fields.length);
    for (const [num, type] of fields) body.push(num, SIZE[type], BASE_TYPE[type]);
    return fields.map(([, type]) => type);
  };
  const data = (local, types, values) => {
    body.push(local);
    types.forEach((type, i) => put(values[i], SIZE[type]));
  };

  const startTs = toFitTime(w.startedAt);
  const endTs = startTs + Math.round(w.duration);
  const durationMs = w.duration * 1000;
  const avgSpeed = w.duration > 0 ? (w.distance / w.duration) * 1000 : 0;
  const maxSpeed = (w.maxSpeed / 3.6) * 1000;
  const serial = (Math.floor(w.startedAt / 1000) >>> 0) || 1;

  let t = define(0, 0, [[0, 'enum'], [1, 'u16'], [2, 'u16'], [3, 'u32z'], [4, 'u32']]);
  data(0, t, [4, 255, 0, serial, startTs]);

  const eventFields = [[253, 'u32'], [0, 'enum'], [1, 'enum'], [4, 'u8']];
  t = define(1, 21, eventFields);
  data(1, t, [startTs, 0, 0, 0]);

  t = define(2, 20, [[253, 'u32'], [5, 'u32'], [6, 'u16']]);
  for (const r of recordsOf(w)) data(2, t, [startTs + r.t, r.dist * 100, (r.kmh / 3.6) * 1000]);

  data(1, define(1, 21, eventFields), [endTs, 0, 4, 0]);

  t = define(3, 19, [[253, 'u32'], [254, 'u16'], [0, 'enum'], [1, 'enum'], [2, 'u32'], [7, 'u32'], [8, 'u32'], [9, 'u32'], [11, 'u16'], [13, 'u16'], [14, 'u16'], [24, 'enum'], [25, 'enum'], [39, 'enum']]);
  data(3, t, [endTs, 0, 9, 1, startTs, durationMs, durationMs, w.distance * 100, w.calories, avgSpeed, maxSpeed, 7, SPORT_WALKING, SUB_SPORT_INDOOR_WALKING]);

  t = define(4, 18, [[253, 'u32'], [254, 'u16'], [0, 'enum'], [1, 'enum'], [2, 'u32'], [5, 'enum'], [6, 'enum'], [7, 'u32'], [8, 'u32'], [9, 'u32'], [11, 'u16'], [14, 'u16'], [15, 'u16'], [25, 'u16'], [26, 'u16']]);
  data(4, t, [endTs, 0, 8, 1, startTs, SPORT_WALKING, SUB_SPORT_INDOOR_WALKING, durationMs, durationMs, w.distance * 100, w.calories, avgSpeed, maxSpeed, 0, 1]);

  t = define(5, 34, [[253, 'u32'], [0, 'u32'], [1, 'u16'], [2, 'enum'], [3, 'enum'], [4, 'enum'], [5, 'u32']]);
  data(5, t, [endTs, durationMs, 1, 0, 26, 1, endTs + tzOffsetMin * 60]);

  const size = body.length;
  const header = [14, 0x20, 2140 & 0xff, 2140 >> 8, size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, (size >>> 24) & 0xff, 0x2e, 0x46, 0x49, 0x54];
  const headerCrc = crc16(header);
  header.push(headerCrc & 0xff, headerCrc >> 8);
  const fileCrc = crc16(body, crc16(header));
  return Uint8Array.from([...header, ...body, fileCrc & 0xff, fileCrc >> 8]);
}
