const GRACE_MS = 120_000;
const RECOVER_MAX_AGE_MS = 10 * 60_000;
const SAMPLE_MS = 5_000;
const DRAFT_MS = 15_000;
const MIN_DURATION_S = 30;
const MIN_DISTANCE_M = 20;

const round = (v, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

/**
 * Turns the pad's live data (state, time, distance, calories, speed) into saved workouts.
 * A workout starts when the pad reports "running" and ends on any non-running state,
 * a counter reset, or after a connection loss longer than GRACE_MS.
 */
export class Tracker extends EventTarget {
  constructor({ store, now = () => Date.now() }) {
    super();
    this.store = store;
    this.now = now;
    this.cur = null;
    this.graceTimer = null;
    this.lastSampleAt = 0;
    this.lastDraftAt = 0;
  }

  get active() { return this.cur !== null; }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  feed(d) {
    const t = this.now();
    const live = d.state === 'running' || d.state === 'paused' || (d.state === undefined && d.speed > 0);

    if (this.cur?.last && d.time !== undefined && d.time + 5 < this.cur.last.time) {
      this.finish(this.cur.updatedAt);
    }
    if (!this.cur) {
      if (d.state === 'running' || (d.state === undefined && d.speed > 0)) this.begin(d, t);
      else return;
    }
    if (!live) { this.finish(t); return; }

    this.clearGrace();
    const c = this.cur;
    const paused = d.state === 'paused';
    const time = d.time ?? Math.round((t - c.startedAt) / 1000);
    c.last = {
      time,
      distance: d.distance ?? c.last?.distance ?? 0,
      calories: d.calories ?? c.last?.calories ?? 0,
      speed: d.speed ?? 0,
    };
    c.updatedAt = t;

    if (!paused) {
      c.maxSpeed = Math.max(c.maxSpeed, c.last.speed);
      if (t - this.lastSampleAt >= SAMPLE_MS) {
        c.samples.push(this.sample(c.last));
        this.lastSampleAt = t;
      }
    }
    if (t - this.lastDraftAt >= DRAFT_MS) this.flush();
    this.emit('update');
  }

  sample(l) { return [l.time, round(l.speed, 1), Math.round(l.distance), round(l.calories, 1)]; }

  begin(d, t) {
    this.cur = {
      id: `${t}-${Math.random().toString(36).slice(2, 6)}`,
      startedAt: t - (d.time ?? 0) * 1000,
      updatedAt: t,
      maxSpeed: 0,
      samples: [],
      last: null,
      partial: (d.time ?? 0) > 5,
    };
    this.lastSampleAt = 0;
    this.lastDraftAt = 0;
    this.emit('start');
  }

  finish(endedAt = this.now()) {
    const c = this.cur;
    if (!c) return;
    this.cur = null;
    this.clearGrace();
    this.store.clearDraft();

    const l = c.last;
    if (!l || (l.time < MIN_DURATION_S && l.distance < MIN_DISTANCE_M)) {
      this.emit('discarded');
      this.emit('end');
      return;
    }
    const lastSample = c.samples.at(-1);
    if (!lastSample || lastSample[0] !== l.time) c.samples.push(this.sample(l));

    const workout = {
      id: c.id,
      startedAt: c.startedAt,
      endedAt,
      duration: l.time,
      distance: Math.round(l.distance),
      calories: round(l.calories, 1),
      avgSpeed: l.time > 0 ? round((l.distance / l.time) * 3.6, 2) : 0,
      maxSpeed: round(c.maxSpeed, 1),
      samples: c.samples,
      partial: c.partial,
    };
    const stored = this.store.addWorkout(workout);
    this.emit('saved', { workout, stored });
    this.emit('end');
  }

  flush() {
    if (!this.cur) return;
    this.store.saveDraft(this.cur);
    this.lastDraftAt = this.now();
  }

  /** Call once at startup: finishes or resumes a workout that was interrupted by closing the page. */
  recover() {
    const draft = this.store.loadDraft();
    if (!draft?.last) { this.store.clearDraft(); return; }
    this.cur = draft;
    if (this.now() - draft.updatedAt > RECOVER_MAX_AGE_MS) this.finish(draft.updatedAt);
    else this.startGrace();
    this.emit('start');
  }

  connectionLost() { if (this.cur) this.startGrace(); }
  connectionRestored() { this.clearGrace(); }

  startGrace() {
    this.clearGrace();
    this.graceTimer = setTimeout(() => this.finish(this.cur?.updatedAt), GRACE_MS);
  }

  clearGrace() {
    clearTimeout(this.graceTimer);
    this.graceTimer = null;
  }
}
