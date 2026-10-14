const pad2 = (n) => String(n).padStart(2, '0');

export function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${pad2(m)}:${pad2(sec)}` : `${pad2(m)}:${pad2(sec)}`;
}

export const fmtNum = (v, digits = 1) =>
  (v || 0).toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const fmtKm = (meters) => fmtNum((meters || 0) / 1000, 2);

export const fmtDateTime = (ts) =>
  new Date(ts).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export const estimateSteps = (meters, stepLengthCm) => Math.round((meters || 0) / ((stepLengthCm || 70) / 100));

export function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function startOfWeek(ts) {
  const d = new Date(startOfDay(ts));
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

export function startOfMonth(ts) {
  const d = new Date(startOfDay(ts));
  d.setDate(1);
  return d.getTime();
}

export function summarize(list, since = 0) {
  const r = { count: 0, distance: 0, duration: 0, calories: 0 };
  for (const w of list) {
    if (w.startedAt < since) continue;
    r.count++;
    r.distance += w.distance;
    r.duration += w.duration;
    r.calories += w.calories;
  }
  return r;
}

export function lastDays(list, n, now = Date.now()) {
  const days = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const start = d.getTime();
    d.setDate(d.getDate() + 1);
    const end = d.getTime();
    days.push({
      start,
      label: new Date(start).toLocaleDateString('de-DE', { weekday: 'short' }).replace('.', ''),
      title: new Date(start).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' }),
      today: i === 0,
      distance: list.reduce((s, w) => s + (w.startedAt >= start && w.startedAt < end ? w.distance : 0), 0),
    });
  }
  return days;
}

export function toCsv(list) {
  const rows = [['id', 'start', 'ende', 'dauer_s', 'strecke_m', 'kalorien_kcal', 'tempo_schnitt_kmh', 'tempo_max_kmh']];
  for (const w of [...list].sort((a, b) => a.startedAt - b.startedAt)) {
    rows.push([w.id, new Date(w.startedAt).toISOString(), new Date(w.endedAt).toISOString(), w.duration, w.distance, w.calories, w.avgSpeed, w.maxSpeed]);
  }
  return rows.map((r) => r.join(',')).join('\n');
}

export function parseImport(text) {
  let data;
  try { data = JSON.parse(text); } catch { return []; }
  const list = Array.isArray(data) ? data : data?.workouts;
  if (!Array.isArray(list)) return [];
  return list
    .filter((w) => w && Number.isFinite(w.startedAt) && Number.isFinite(w.duration) && Number.isFinite(w.distance))
    .map((w) => ({
      id: String(w.id ?? `${w.startedAt}-import`),
      startedAt: w.startedAt,
      endedAt: Number.isFinite(w.endedAt) ? w.endedAt : w.startedAt + w.duration * 1000,
      duration: w.duration,
      distance: w.distance,
      calories: Number(w.calories) || 0,
      avgSpeed: Number(w.avgSpeed) || (w.duration ? (w.distance / w.duration) * 3.6 : 0),
      maxSpeed: Number(w.maxSpeed) || 0,
      samples: Array.isArray(w.samples) ? w.samples : [],
      partial: !!w.partial,
    }));
}

export function mergeWorkouts(existing, incoming) {
  const byId = new Map(existing.map((w) => [w.id, w]));
  let added = 0;
  for (const w of incoming) {
    if (!byId.has(w.id)) added++;
    byId.set(w.id, w);
  }
  return { list: [...byId.values()].sort((a, b) => b.startedAt - a.startedAt), added };
}
