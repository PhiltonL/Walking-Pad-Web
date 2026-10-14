import { SVC, GattQueue, FitShowDriver, EwayDriver, FtmsDriver, probeFff0 } from './drivers.js';
import { loadDevice, saveDevice, clearDevice } from './store.js';

const OPTIONAL_SERVICES = [SVC.FTMS, SVC.FFF0, SVC.F100, SVC.DIS];
const DEFAULT_FILTERS = [
  { namePrefix: 'FIT' }, { namePrefix: 'FS-' }, { namePrefix: 'EW-' },
  { services: [SVC.FTMS] }, { services: [SVC.FFF0] }, { services: [SVC.F100] },
];
const debug = (...a) => { if (globalThis.padDebug) console.debug('[pad]', ...a); };

/**
 * Owns the Bluetooth connection: remembers the device, reconnects automatically
 * (via advertisement watching where the browser supports it) and exposes the active driver.
 * status: idle | connecting | waiting | connected
 */
export class PadManager extends EventTarget {
  status = 'idle';
  device = null;
  driver = null;
  deviceName = loadDevice()?.name ?? null;
  demo = false;
  #userDisconnect = false;
  #connecting = false;
  #failures = 0;
  #retryTimer = null;
  #abort = null;
  #ctx = { queue: new GattQueue(), log: debug };

  get supported() { return !!navigator.bluetooth; }
  get canAutoConnect() { return !!navigator.bluetooth?.getDevices; }
  get data() { return this.driver?.data ?? {}; }
  get info() { return this.driver?.info ?? {}; }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  setStatus(status) { this.status = status; this.emit('status'); }

  async connectNew({ any = false } = {}) {
    const saved = loadDevice();
    const filters = !any && saved?.name ? [{ name: saved.name }] : DEFAULT_FILTERS;
    let device;
    try {
      device = await navigator.bluetooth.requestDevice({ filters, optionalServices: OPTIONAL_SERVICES });
    } catch (e) {
      if (e.name === 'NotFoundError') return;
      throw e;
    }
    this.#userDisconnect = false;
    this.#setDevice(device);
    await this.#tryConnect(device, true);
  }

  async autoConnect() {
    const saved = loadDevice();
    if (!saved || !this.canAutoConnect) return false;
    let devices;
    try { devices = await navigator.bluetooth.getDevices(); } catch { return false; }
    const device = devices.find((d) => d.id === saved.id) ?? devices.find((d) => d.name === saved.name);
    if (!device) return false;
    this.#userDisconnect = false;
    this.#setDevice(device);
    this.#waitForDevice(device, 500);
    return true;
  }

  disconnect() {
    this.#userDisconnect = true;
    this.#stopWaiting();
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    else this.setStatus('idle');
  }

  async forget() {
    this.disconnect();
    clearDevice();
    try { await this.device?.forget?.(); } catch {}
    this.device = null;
    this.deviceName = null;
    this.emit('status');
  }

  useDemo(driver) {
    this.demo = true;
    this.deviceName = 'Demo-Laufband';
    this.driver = driver;
    driver.addEventListener('data', () => this.emit('data'));
    this.setStatus('connected');
    this.emit('connected');
  }

  #setDevice(device) {
    if (this.device && this.device !== device) this.device.removeEventListener('gattserverdisconnected', this.#onDisconnected);
    this.device = device;
    device.addEventListener('gattserverdisconnected', this.#onDisconnected);
  }

  #onDisconnected = () => {
    const driver = this.driver;
    if (!driver) return;
    driver.dispose();
    this.driver = null;
    this.emit('disconnected');
    if (this.#userDisconnect) { this.setStatus('idle'); return; }
    this.#failures = 0;
    this.#waitForDevice(this.device, 1500);
  };

  #waitForDevice(device, delay) {
    this.#stopWaiting();
    this.setStatus('waiting');
    this.#retryTimer = setTimeout(() => this.#tryConnect(device), delay);
    if (!device.watchAdvertisements) return;
    this.#abort = new AbortController();
    const onAdv = () => this.#tryConnect(device);
    device.addEventListener('advertisementreceived', onAdv, { once: true });
    device.watchAdvertisements({ signal: this.#abort.signal }).catch(() => {
      device.removeEventListener('advertisementreceived', onAdv);
    });
  }

  #stopWaiting() {
    clearTimeout(this.#retryTimer);
    this.#abort?.abort();
    this.#abort = null;
  }

  async #tryConnect(device, loud = false) {
    if (this.#connecting || this.driver) return;
    this.#connecting = true;
    this.#stopWaiting();
    try {
      await this.#connectDevice(device);
      this.#failures = 0;
    } catch (e) {
      console.warn('Verbindung fehlgeschlagen', e);
      this.#failures++;
      if (loud) this.emit('error', e.message);
      try { if (device.gatt.connected) device.gatt.disconnect(); } catch {}
      if (this.#userDisconnect) this.setStatus('idle');
      else this.#waitForDevice(device, Math.min(30_000, 3000 * this.#failures));
    } finally {
      this.#connecting = false;
    }
  }

  async #connectDevice(device) {
    this.setStatus('connecting');
    this.#ctx = { queue: new GattQueue(), log: debug };
    const server = await device.gatt.connect();
    const services = await server.getPrimaryServices();
    const chars = new Map();
    for (const s of services) {
      try { for (const c of await s.getCharacteristics()) chars.set(c.uuid, c); } catch {}
    }
    const driver = await this.#buildDriver(services, chars);
    if (!driver) throw new Error('Das Gerät spricht kein unterstütztes Protokoll.');
    this.driver = driver;
    saveDevice({ id: device.id, name: device.name });
    this.deviceName = device.name;
    this.setStatus('connected');
    this.emit('connected');
  }

  async #buildDriver(services, chars) {
    const find = (n) => services.find((s) => s.uuid === BluetoothUUID.getService(n));
    const ch = (n) => chars.get(BluetoothUUID.getCharacteristic(n));
    const wire = (d) => {
      d.addEventListener('data', () => this.emit('data'));
      d.addEventListener('info', () => this.emit('info'));
      return d;
    };
    const ctx = this.#ctx;

    let vendor = null;
    if (find(SVC.F100)) {
      const key = ch(0xf105);
      if (ch(0xf100)) vendor = new FitShowDriver(ctx, { proto: 3, tx: ch(0xf100), rx: ch(0xf100), key });
      else if (ch(0xf101)) vendor = new FitShowDriver(ctx, { proto: 1, tx: ch(0xf101), rx: ch(0xf101), key });
    } else if (find(SVC.FFF0) && ch(0xfff1) && ch(0xfff2)) {
      const kind = await probeFff0(ctx, ch(0xfff2), ch(0xfff1));
      if (kind === 'fitshow') vendor = new FitShowDriver(ctx, { proto: 1, tx: ch(0xfff2), rx: ch(0xfff1) });
      if (kind === 'eway') vendor = new EwayDriver(ctx, { tx: ch(0xfff2), rx: ch(0xfff1) });
    }
    if (vendor) {
      wire(vendor);
      try {
        await vendor.init();
        return vendor;
      } catch (e) {
        console.warn('Herstellerprotokoll fehlgeschlagen, versuche FTMS', e);
        vendor.dispose();
      }
    }
    if (find(SVC.FTMS)) {
      const d = wire(new FtmsDriver(ctx, find(SVC.FTMS)));
      await d.init();
      return d;
    }
    return null;
  }
}
