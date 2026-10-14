const K = {
  settings: 'walkingpad.settings.v1',
  workouts: 'walkingpad.workouts.v1',
  draft: 'walkingpad.draft.v1',
  device: 'walkingpad.device.v1',
  tab: 'walkingpad.tab',
};

const read = (k, fallback) => {
  try {
    const v = localStorage.getItem(k);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
};
const write = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
    return true;
  } catch {
    return false;
  }
};
const remove = (k) => {
  try { localStorage.removeItem(k); } catch {}
};

export const DEFAULT_SETTINGS = {
  features: { speedControl: true, pause: true, presets: true, incline: false, heartRate: false, steps: true },
  speedLimit: null,
  speedStep: 0.1,
  presets: [2, 3, 4, 5],
  stepLengthCm: 70,
  autoConnect: true,
  keepAwake: true,
};

export function loadSettings() {
  const s = read(K.settings, {});
  return { ...DEFAULT_SETTINGS, ...s, features: { ...DEFAULT_SETTINGS.features, ...(s.features ?? {}) } };
}
export const saveSettings = (s) => write(K.settings, s);

export function loadWorkouts() {
  const list = read(K.workouts, []);
  return Array.isArray(list) ? list.sort((a, b) => b.startedAt - a.startedAt) : [];
}
export const saveWorkouts = (list) => write(K.workouts, list);

export const loadDevice = () => read(K.device, null);
export const saveDevice = (d) => write(K.device, d);
export const clearDevice = () => remove(K.device);

export const loadTab = () => read(K.tab, 'train');
export const saveTab = (t) => write(K.tab, t);

export const workoutStore = {
  addWorkout(w) {
    const list = loadWorkouts();
    list.push(w);
    return saveWorkouts(list);
  },
  loadDraft: () => read(K.draft, null),
  saveDraft: (d) => write(K.draft, d),
  clearDraft: () => remove(K.draft),
};
