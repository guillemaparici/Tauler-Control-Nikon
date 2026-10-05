// sim.js — cámara simulada para el modo demo (?demo). Misma interfaz que NikonCamera.
import { Emitter } from './nikon.js';

const OPTS = {
  iso: ['100', '200', '400', '800', '1600', '3200', '6400', '12800'],
  aperture: ['f/3.5', 'f/4', 'f/5.6', 'f/8', 'f/11', 'f/16', 'f/22'],
  shutter: ['bulb', '30"', '25"', '20"', '15"', '13"', '10"', '8"', '6"', '5"', '4"', '3"', '2"', '1"',
    '1/2', '1/4', '1/8', '1/15', '1/30', '1/60', '1/125', '1/250', '1/500', '1/1000', '1/2000', '1/4000'],
  wb: ['Auto', 'Luz día', 'Nublado', 'Tungsteno', 'Fluorescente'],
};

export class SimCamera extends Emitter {
  constructor() {
    super();
    this.connected = false; this.lv = false; this.n = 0;
    this.cur = { iso: '1600', aperture: 'f/3.5', shutter: '20"', wb: 'Auto' };
    this.stars = Array.from({ length: 220 }, () => ({ x: Math.random() * 960, y: Math.random() * 520, r: Math.random() * 1.5 + 0.3 }));
    this.cv = document.createElement('canvas'); this.cv.width = 960; this.cv.height = 640;
    this.cx = this.cv.getContext('2d');
    this.busy = false; this.k = 0;
  }
  static supported() { return true; }
  async reconnectKnown() { return false; }
  async requestAndConnect() { await this.connectDevice(); }
  async connectDevice() {
    this.connected = true;
    this.emit('log', 'Cámara simulada conectada (modo demo)');
    this.publish();
  }
  async disconnect() { clearInterval(this.timer); this.connected = false; this.lv = false; this.publish(); }
  state() {
    return { connected: this.connected, model: 'Nikon D3300 (demo)', battery: 87, lv: this.lv, free_mb: 30000 - this.n * 6,
      shots_left: 1800 - this.n, warn: null, error: null, ...this.cur };
  }
  options() { return OPTS; }
  publish() { this.emit('state', { ...this.state(), opts: OPTS }); }
  async setProp(name, label) { this.cur[name] = label; this.publish(); }
  async lvStart() {
    this.lv = true; this.publish(); clearInterval(this.timer);
    this.timer = setInterval(() => this.frame(), 1000 / 20);
  }
  async lvStop() { this.lv = false; clearInterval(this.timer); this.publish(); }
  async af() { this.emit('log', 'AF (demo)'); }
  async mf(dir, step) { this.emit('log', `MF ${dir * step} (demo)`); }
  async shoot() { this.n++; const name = `DSC_${String(this.n).padStart(4, '0')}.JPG`; this.publish(); return [{ name, size: 4200000 }]; }
  report() { return 'Modo demo: sin cámara real.'; }
  frame() {
    if (this.busy) return;
    this.busy = true;
    const c = this.cx, k = this.k++;
    c.fillStyle = '#050914'; c.fillRect(0, 0, 960, 640);
    const a = k * 0.0006, ca = Math.cos(a), sa = Math.sin(a);
    c.fillStyle = '#fff';
    for (const s of this.stars) {
      const x = 480 + (s.x - 480) * ca - (s.y - 320) * sa, y = 320 + (s.x - 480) * sa + (s.y - 320) * ca;
      c.globalAlpha = 0.5 + 0.5 * Math.random(); c.beginPath(); c.arc(x, y, s.r, 0, 6.3); c.fill();
    }
    c.globalAlpha = 1; c.fillStyle = '#0b0f0b'; c.fillRect(0, 450, 960, 190);
    c.fillStyle = '#fff'; c.font = '14px monospace'; c.fillText('DEMO · frame ' + k, 14, 626);
    this.cv.toBlob(async b => {
      if (b && this.lv) this.emit('frame', new Uint8Array(await b.arrayBuffer()));
      this.busy = false;
    }, 'image/jpeg', 0.8);
  }
}
