// Simulated pad for trying the UI without hardware: open index.html?demo (add &fast=30 to run 30x faster).
export class DemoDriver extends EventTarget {
  constructor({ fast = 1 } = {}) {
    super();
    this.name = 'Demo';
    this.fast = fast;
    this.info = { minSpeed: 1, maxSpeed: 6, supportPause: true };
    this.data = { state: 'idle', speed: 0, time: 0, distance: 0, calories: 0, steps: 0 };
    this.dist = 0;
    this.kcal = 0;
    this.target = 1;
    this.timer = setInterval(() => this.tick(), 1000);
  }

  emit() { this.dispatchEvent(new CustomEvent('data')); }

  tick() {
    const d = this.data;
    if (d.state === 'starting') {
      d.countdown -= 1;
      if (d.countdown <= 0) { d.countdown = undefined; d.state = 'running'; d.speed = this.target; }
    } else if (d.state === 'running') {
      d.time += this.fast;
      this.dist += (d.speed / 3.6) * this.fast;
      this.kcal += ((25 + 10 * d.speed) / 3600) * this.fast;
      d.distance = Math.round(this.dist);
      d.calories = Math.round(this.kcal * 10) / 10;
    }
    this.emit();
  }

  cmdStart() {
    const d = this.data;
    if (d.state === 'paused') { d.state = 'running'; d.speed = this.target; }
    else {
      Object.assign(d, { time: 0, distance: 0, calories: 0, speed: 0, state: 'starting', countdown: 3 });
      this.dist = 0; this.kcal = 0; this.target = 1;
    }
    this.emit();
  }
  cmdPause() { this.data.state = 'paused'; this.data.speed = 0; this.emit(); }
  cmdStop() {
    this.data.state = 'finished'; this.data.speed = 0; this.emit();
    setTimeout(() => { this.data.state = 'idle'; this.emit(); }, 2000);
  }
  setSpeed(kmh) { this.target = kmh; if (this.data.state === 'running') { this.data.speed = kmh; this.emit(); } }
  setIncline() {}
  caps() { return { incline: false, pause: true }; }
  extras() { return []; }
  dispose() { clearInterval(this.timer); }
}
