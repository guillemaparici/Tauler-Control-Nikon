// nikon.js — cámara Nikon (PTP + extensiones Nikon) sobre WebUSB.
// Todas las operaciones pasan por UNA cola con prioridad (disparo 0 > ajustes 1 > resto 5);
// el Live View se sirve cuando la cola está vacía, así que un disparo siempre se adelanta.

import {
  PTPUsb, PTPError, PTPTimeout, PTPDisconnected, RC, OC, hex,
  parseDeviceInfo, parsePropDesc, encodeVal, readString,
} from './ptp.js';

export const NIKON_VID = 0x04b0;
const sleep = ms => new Promise(r => setTimeout(r, ms));

export class Emitter {
  constructor() { this._h = {}; }
  on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); return this; }
  emit(ev, data) { for (const f of this._h[ev] || []) { try { f(data); } catch (e) { console.error(e); } } }
}

// ---------- formatos ----------
const STD_SHUTTER = [2, 3, 4, 5, 6, 8, 10, 13, 15, 20, 25, 30, 40, 50, 60, 80, 100, 125, 160, 200, 250,
  320, 400, 500, 640, 800, 1000, 1250, 1600, 2000, 2500, 3200, 4000, 5000, 6400, 8000];
export function fmtShutter(raw) {
  if (raw === 0xffffffff) return 'bulb';
  if (raw === 0xfffffffe) return 'time';
  const s = raw / 10000;
  if (s <= 0) return '?';
  if (s >= 1) return `${+s.toFixed(2)}"`;
  if (raw <= 3) return '1/4000';
  const inv = 1 / s;
  let best = null, bd = 1e9;
  for (const n of STD_SHUTTER) { const d = Math.abs(Math.log(inv / n)); if (d < bd) { bd = d; best = n; } }
  return bd < 0.06 ? '1/' + best : `${+s.toFixed(2)}"`;
}
export const fmtAperture = raw => 'f/' + +(raw / 100).toFixed(1);
export const fmtIso = raw => String(raw);
const WB = { 1: 'Manual', 2: 'Auto', 3: 'Un toque', 4: 'Luz día', 5: 'Fluorescente', 6: 'Tungsteno',
  7: 'Flash', 0x8010: 'Nublado', 0x8011: 'Sombra', 0x8012: 'Temperatura K', 0x8013: 'Preajuste' };
export const fmtWb = raw => WB[raw] || 'WB ' + hex(raw);

export const PROPS = {
  iso: [0x500f, fmtIso], aperture: [0x5007, fmtAperture], shutter: [0x500d, fmtShutter], wb: [0x5005, fmtWb],
};
const DPC_BATTERY = 0x5001, DPC_EXPPROGRAM = 0x500e;

function sortOpts(name, pairs) {
  if (name === 'shutter') return pairs.slice().sort((a, b) => b.raw - a.raw);  // bulb, 30" … 1/4000
  if (name === 'iso' || name === 'aperture') return pairs.slice().sort((a, b) => a.raw - b.raw);
  return pairs;
}

export class NikonCamera extends Emitter {
  constructor() {
    super();
    this.u = null; this.device = null;
    this.connected = false; this.connecting = false; this.error = null;
    this.ops = new Set(); this.model = 'Nikon';
    this.opts = {}; this.cur = {}; this.dtype = {};
    this.battery = null; this.free_mb = null; this.shots_left = null; this.warn = null;
    this.lv = false; this.storageId = null;
    this.dirty = new Set(); this.q = []; this.seq = 0; this.running = false;
    this.timeouts = 0; this.lvFail = 0; this.lastSlow = 0; this.needStorage = false; this.captureOp = null;
    this.diag = []; this.info = null;
    if (typeof navigator !== 'undefined' && navigator.usb) {
      navigator.usb.addEventListener('disconnect', e => {
        if (this.device && e.device === this.device) this._drop('cable USB desconectado');
      });
    }
  }

  static supported() { return typeof navigator !== 'undefined' && !!navigator.usb; }
  _d(m) { this.diag.push(m); if (this.diag.length > 400) this.diag.shift(); }

  // ---------- conexión ----------
  async requestAndConnect() {
    const dev = await navigator.usb.requestDevice({ filters: [{ vendorId: NIKON_VID }] });
    await this.connectDevice(dev);
  }

  async reconnectKnown() {
    if (this.connected || this.connecting || !NikonCamera.supported()) return false;
    const devs = (await navigator.usb.getDevices()).filter(d => d.vendorId === NIKON_VID);
    if (!devs.length) return false;
    await this.connectDevice(devs[0]);
    return true;
  }

  async connectDevice(device) {
    if (this.connected || this.connecting) return;
    this.connecting = true; this.error = null; this.diag = [];
    this._d(`Dispositivo ${hex(device.vendorId)}:${hex(device.productId)} ${device.productName || ''}`);
    try {
      this.device = device;
      this.u = new PTPUsb(device);
      await this.u.open();
      this._d('USB abierto, interfaz PTP reclamada');
      let r = await this.u.transaction(OC.OpenSession, [1], null, 10000, 0);
      if (r.rc === RC.SESSION_OPEN) {
        await this.u.transaction(OC.CloseSession);
        this.u.tid = 0;
        r = await this.u.transaction(OC.OpenSession, [1], null, 10000, 0);
      }
      this._d('OpenSession → ' + hex(r.rc));
      if (r.rc !== RC.OK) throw new PTPError('OpenSession falló (' + hex(r.rc) + ')', r.rc);
      this.u.tid = 0;
      const di = await this._call(OC.GetDeviceInfo);
      this.info = parseDeviceInfo(di.data);
      this.ops = this.info.ops;
      this.model = this.info.model || 'Nikon';
      this._d(`Modelo: ${this.model} · versión ${this.info.version} · ext ${hex(this.info.vendorExt, 8)}`);
      if (!this.ops.has(OC.NK_GetEvent)) this._d('⚠ La cámara no declara operaciones Nikon: control limitado');
      await this._refreshProps();
      await this._checkMode();
      await this._refreshSlow();
      this.lv = false; this.connected = true; this.timeouts = 0;
      this.running = true;
      this._loop();
      this.emit('log', 'Cámara conectada: ' + this.model);
      this.publish();
    } catch (e) {
      this._d('✗ ' + e.message);
      try { await this.u?.close(); } catch (x) { /* ignore */ }
      this.u = null; this.device = null; this.connected = false;
      this.error = e.message;
      this.publish();
      throw e;
    } finally { this.connecting = false; }
  }

  async disconnect() {                                  // desconexión pedida por el usuario: sin error
    this.running = false;
    await this._close(null);
  }

  async _close(reason) {
    const u = this.u;
    this.connected = false; this.lv = false;
    this.error = reason || null;
    this.u = null; this.device = null;
    for (const j of this.q.splice(0)) j.reject(new PTPDisconnected(reason || 'desconectada'));
    this.publish();                                    // la interfaz lo ve al instante
    if (u) {
      try { if (u.ifn !== null) { await Promise.race([u.transaction(OC.CloseSession, [], null, 1200), sleep(1500)]); } } catch (e) { /* ignore */ }
      try { await u.close(); } catch (e) { /* ignore */ }
    }
  }

  async _drop(reason) {
    if (!this.connected && !this.u) return;
    this.running = false;
    this.emit('log', '⚠ Cámara desconectada: ' + reason);
    this._d('Desconexión: ' + reason);
    await this._close(reason);
  }

  async _call(op, params = [], data = null, timeout = 10000, ok = [RC.OK]) {
    const r = await this.u.transaction(op, params, data, timeout);
    if (!ok.includes(r.rc)) throw new PTPError(`Operación ${hex(op)} rechazada (${hex(r.rc)})`, r.rc);
    return r;
  }

  async _ready(timeout = 5000) {
    if (!this.ops.has(OC.NK_DeviceReady)) return;
    const end = performance.now() + timeout;
    while (performance.now() < end) {
      const r = await this.u.transaction(OC.NK_DeviceReady, [], null, 3000);
      if (r.rc !== RC.BUSY) return;
      await sleep(50);
    }
  }

  // ---------- propiedades ----------
  async _refreshProps(names = null) {
    for (const [name, [code, fmt]] of Object.entries(PROPS)) {
      if (names && !names.includes(name)) continue;
      let pd;
      try {
        const r = await this._call(OC.GetDevicePropDesc, [code]);
        pd = parsePropDesc(r.data);
      } catch (e) {
        if (e instanceof PTPTimeout || e instanceof PTPDisconnected) throw e;
        this._d(`Propiedad ${name} (${hex(code)}): ${e.message}`);
        continue;
      }
      let pairs;
      if (pd.values) pairs = pd.values.map(v => ({ label: fmt(v), raw: v }));
      else if (pd.range) {
        pairs = [];
        const [lo, hi, st] = pd.range;
        for (let v = lo; v <= hi && pairs.length < 300; v += Math.max(st, 1)) pairs.push({ label: fmt(v), raw: v });
      } else pairs = this.opts[name] || [];
      const seen = new Set(), uniq = [];
      for (const p of pairs) if (!seen.has(p.label)) { seen.add(p.label); uniq.push(p); }
      this.opts[name] = sortOpts(name, uniq);
      this.cur[name] = fmt(pd.cur);
      this.dtype[name] = pd.dtype;
      this._d(`Propiedad ${name}: actual=${this.cur[name]} (raw ${pd.cur}), ${uniq.length} valores`);
    }
  }

  async _checkMode() {
    try {
      const r = await this._call(OC.GetDevicePropValue, [DPC_EXPPROGRAM]);
      const mode = new DataView(r.data.buffer, r.data.byteOffset, r.data.byteLength).getUint16(0, true);
      this.warn = mode === 1 ? null : 'Gira el dial de la cámara a M (manual) para controlar velocidad y diafragma.';
      this._d('Modo de exposición: ' + mode + (mode === 1 ? ' (M)' : ''));
    } catch (e) {
      if (e instanceof PTPTimeout || e instanceof PTPDisconnected) throw e;
    }
  }

  async _setProp(name, label) {
    if (!PROPS[name]) throw new PTPError('Propiedad desconocida: ' + name);
    const o = (this.opts[name] || []).find(p => p.label === label);
    if (!o) throw new PTPError(`Valor no permitido ahora: ${name} ${label}`);
    await this._call(OC.SetDevicePropValue, [PROPS[name][0]], encodeVal(this.dtype[name], o.raw));
    await this._ready();
    await this._refreshProps([name]);
    if (this.cur[name] !== label) throw new PTPError(`La cámara no aceptó ${name}=${label} (¿dial en M?)`);
    return label;
  }

  async _refreshSlow() {
    this.lastSlow = performance.now();
    try {
      const r = await this._call(OC.GetDevicePropValue, [DPC_BATTERY]);
      this.battery = r.data[0];
    } catch (e) { if (e instanceof PTPTimeout || e instanceof PTPDisconnected) throw e; }
    await this._updateStorage();
  }

  async _updateStorage() {
    this.needStorage = false;
    try {
      if (this.storageId === null) {
        const r = await this._call(OC.GetStorageIDs);
        const dv = new DataView(r.data.buffer, r.data.byteOffset, r.data.byteLength);
        if (dv.getUint32(0, true) < 1) return;
        this.storageId = dv.getUint32(4, true);
      }
      const r = await this._call(OC.GetStorageInfo, [this.storageId]);
      const dv = new DataView(r.data.buffer, r.data.byteOffset, r.data.byteLength);
      this.free_mb = Number(dv.getBigUint64(14, true)) / 1048576;
      const imgs = dv.getUint32(22, true);
      this.shots_left = imgs === 0xffffffff ? null : imgs;
    } catch (e) { if (e instanceof PTPTimeout || e instanceof PTPDisconnected) throw e; }
  }

  // ---------- eventos ----------
  async _events() {
    if (!this.ops.has(OC.NK_GetEvent)) return [];
    let r;
    try { r = await this.u.transaction(OC.NK_GetEvent, [], null, 3000); }
    catch (e) {
      if (e instanceof PTPTimeout) {                   // cámara dormida o colgada: tras 3 silencios, desconexión
        if (++this.timeouts >= 3) throw new PTPDisconnected('la cámara no responde (¿en reposo?)');
        return [];
      }
      throw e;
    }
    this.timeouts = 0;
    if (r.rc !== RC.OK || r.data.length < 2) return [];
    const dv = new DataView(r.data.buffer, r.data.byteOffset, r.data.byteLength);
    const n = dv.getUint16(0, true), out = [];
    for (let i = 0; i < n && 2 + 6 * i + 6 <= r.data.length; i++)
      out.push([dv.getUint16(2 + 6 * i, true), dv.getUint32(4 + 6 * i, true)]);
    return out;
  }

  async _idleTick() {
    let changed = false;
    for (const [code, param] of await this._events()) {
      if (code === 0x4006) this.dirty.add(param);
      else if (code === 0x4002 || code === 0xc101) this.needStorage = true;
    }
    if (this.dirty.size) {
      const names = Object.entries(PROPS).filter(([, [c]]) => this.dirty.has(c)).map(([n]) => n);
      if (this.dirty.has(DPC_EXPPROGRAM)) await this._checkMode();
      this.dirty.clear();
      if (names.length) await this._refreshProps(names);
      changed = true;
    }
    if (this.needStorage || performance.now() - this.lastSlow > 30000) { await this._refreshSlow(); changed = true; }
    return changed;
  }

  // ---------- Live View ----------
  async _lvStart() {
    if (this.lv) return;
    const r = await this.u.transaction(OC.NK_StartLV, [], null, 8000);
    this._d('StartLiveView → ' + hex(r.rc));
    if (r.rc !== RC.OK) throw new PTPError(`Live View rechazado (${hex(r.rc)}). ¿Dial en modo foto? ¿Objetivo en MF?`, r.rc);
    await this._ready(5000);
    this.lvFail = 0; this.lv = true;
  }

  async _lvStop() {
    if (!this.lv) return;
    this.lv = false;
    try { await this.u.transaction(OC.NK_EndLV, [], null, 4000); await this._ready(3000); }
    catch (e) { if (e instanceof PTPDisconnected) throw e; }
  }

  async _lvFrame() {
    const r = await this.u.transaction(OC.NK_GetLV, [], null, 3000);
    if (r.rc !== RC.OK || !r.data.length) {
      if (this.lvFail < 3) this._d('GetLiveViewImg → ' + hex(r.rc) + ', ' + r.data.length + ' bytes');
      if (++this.lvFail > 80) { this.lv = false; throw new PTPError('El Live View no entrega imágenes'); }
      await sleep(30);
      return null;
    }
    this.lvFail = 0;
    const d = r.data, lim = Math.min(d.length - 3, 4000);
    let i = -1;
    for (let k = 0; k < lim; k++) if (d[k] === 0xff && d[k + 1] === 0xd8 && d[k + 2] === 0xff) { i = k; break; }
    if (i < 0) return null;
    let j = d.length;
    while (j > i + 2 && !(d[j - 2] === 0xff && d[j - 1] === 0xd9)) { j--; if (d.length - j > 64) { j = d.length; break; } }
    return d.slice(i, j);
  }

  // ---------- foco ----------
  async _af() {
    const r = await this.u.transaction(OC.NK_AfDrive, [], null, 10000);
    if (r.rc !== RC.OK) throw new PTPError(`AF no disponible (${hex(r.rc)}): ¿objetivo en MF?`, r.rc);
    await this._ready(8000);
  }

  async _mf(dir, step) {
    const amount = { 1: 10, 2: 50, 3: 200 }[step] || 50;
    await this._call(OC.NK_MfDrive, [dir < 0 ? 1 : 2, amount]);
    await this._ready(3000);
  }

  // ---------- disparo ----------
  async _initiate(waitMs) {
    for (let k = 0; k < 4; k++) {
      const ops = this.captureOp === null ? [OC.InitiateCapture] : [this.captureOp];
      if (this.captureOp === null && this.ops.has(OC.NK_CaptureMedia)) ops.push(OC.NK_CaptureMedia);
      let rc = null;
      for (const op of ops) {
        const params = op === OC.InitiateCapture ? [0, 0] : [0xffffffff, 0];
        rc = (await this.u.transaction(op, params, null, waitMs)).rc;
        this._d(`Disparo con ${hex(op)} → ${hex(rc)}`);
        if (rc === RC.OK) { this.captureOp = op; return; }
        if (rc === RC.BUSY) break;
      }
      if (rc === RC.BUSY) { await sleep(300); continue; }
      throw new PTPError(`La cámara rechazó el disparo (${hex(rc)}): ¿sin foco (AF), tarjeta llena o sin tarjeta?`, rc);
    }
    throw new PTPError('La cámara sigue ocupada');
  }

  async _collect(waitMs) {
    const handles = []; let last = null;
    const end = performance.now() + waitMs;
    while (performance.now() < end) {
      for (const [code, param] of await this._events()) {
        last = performance.now();
        if (code === 0x4002 || code === 0xc101) handles.push(param);
        else if (code === 0x4006) this.dirty.add(param);
      }
      if (handles.length && last && performance.now() - last > 600) break;
      await sleep(80);
    }
    if (!handles.length) throw new PTPError('No se confirmó la escritura de la foto (sin evento de objeto nuevo)');
    return handles;
  }

  async _objectInfo(h) {
    const r = await this._call(OC.GetObjectInfo, [h]);
    const dv = new DataView(r.data.buffer, r.data.byteOffset, r.data.byteLength);
    const [name] = readString(dv, 52);
    return { handle: h, name, size: dv.getUint32(8, true), format: dv.getUint16(4, true) };
  }

  async _capture() {
    const wasLv = this.lv;
    if (wasLv) await this._lvStop();
    await this._events();                       // vaciar eventos antiguos
    await this._initiate(20000);
    const handles = await this._collect(20000);
    const files = [];
    for (const h of handles) files.push(await this._objectInfo(h));
    this.needStorage = true;
    await this._updateStorage();
    if (wasLv) { try { await this._lvStart(); } catch (e) { /* ignore */ } }
    return files;
  }

  // ---------- cola y bucle ----------
  submit(fn, prio = 5) {
    return new Promise((resolve, reject) => {
      if (!this.connected) return reject(new PTPError('Sin cámara conectada'));
      this.q.push({ prio, seq: this.seq++, fn, resolve, reject });
      this.q.sort((a, b) => a.prio - b.prio || a.seq - b.seq);
    });
  }

  async _loop() {
    let lvn = 0, lastIdle = 0;
    while (this.running) {
      try {
        const job = this.q.shift();
        if (job) {
          try { job.resolve(await job.fn(this)); this.timeouts = 0; }
          catch (e) {
            job.reject(e);
            if (e instanceof PTPDisconnected) throw e;
            if (e instanceof PTPTimeout && ++this.timeouts >= 3) throw new PTPDisconnected('timeouts repetidos');
          }
          this.publish();
          continue;
        }
        if (this.lv) {
          const f = await this._lvFrame();
          if (f) { this.emit('frame', f); this.timeouts = 0; }
          if (++lvn % 40 === 0 && await this._idleTick()) this.publish();
          await sleep(0);
        } else {
          const now = performance.now();
          if (now - lastIdle > 1000) { lastIdle = now; if (await this._idleTick()) this.publish(); }
          await sleep(25);
        }
      } catch (e) {
        if (!this.running) return;
        if (e instanceof PTPDisconnected) { await this._drop(e.message); return; }
        if (e instanceof PTPTimeout) {
          if (++this.timeouts >= 3) { await this._drop('timeouts repetidos'); return; }
          continue;
        }
        this.emit('log', '⚠ ' + e.message);
        this.publish();
        await sleep(100);
      }
    }
  }

  // ---------- API pública ----------
  setProp(name, label) { return this.submit(c => c._setProp(name, label), 1); }
  lvStart() { return this.submit(c => c._lvStart(), 1); }
  lvStop() { return this.submit(c => c._lvStop(), 1); }
  af() { return this.submit(c => c._af(), 1); }
  mf(dir, step) { return this.submit(c => c._mf(dir, step), 1); }
  shoot() { return this.submit(c => c._capture(), 0); }

  state() {
    return {
      connected: this.connected, model: this.model, battery: this.battery, lv: this.lv,
      free_mb: this.free_mb, shots_left: this.shots_left, warn: this.warn, error: this.error,
      ...this.cur,
    };
  }
  options() { return Object.fromEntries(Object.entries(this.opts).map(([k, v]) => [k, v.map(p => p.label)])); }
  publish() { this.emit('state', { ...this.state(), opts: this.options() }); }

  // Informe de diagnóstico: pégamelo si algo falla.
  report() {
    const L = [];
    L.push('NikonLink — informe de diagnóstico (fase A, WebUSB)');
    L.push('Fecha: ' + new Date().toISOString());
    L.push('Navegador: ' + (typeof navigator !== 'undefined' ? navigator.userAgent : 'node'));
    L.push('Conectada: ' + this.connected + (this.error ? ' · error: ' + this.error : ''));
    if (this.info) {
      L.push(`Cámara: ${this.info.manufacturer} ${this.info.model} · versión ${this.info.version} · ext ${hex(this.info.vendorExt, 8)} (${this.info.extDesc})`);
      L.push('Operaciones: ' + [...this.info.ops].sort((a, b) => a - b).map(o => hex(o)).join(' '));
      L.push('Eventos: ' + [...this.info.events].sort((a, b) => a - b).map(o => hex(o)).join(' '));
      L.push('Propiedades: ' + [...this.info.props].sort((a, b) => a - b).map(o => hex(o)).join(' '));
    }
    for (const [n, list] of Object.entries(this.opts))
      L.push(`${n} (actual ${this.cur[n]}): ` + list.map(p => `${p.label}[${p.raw}]`).join(' '));
    L.push('Batería: ' + this.battery + ' · libre MB: ' + (this.free_mb && Math.round(this.free_mb)) + ' · tomas restantes: ' + this.shots_left);
    L.push('Aviso: ' + (this.warn || '—'));
    L.push('--- pasos ---');
    L.push(...this.diag);
    return L.join('\n');
  }
}
