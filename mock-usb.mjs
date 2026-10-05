// mock-usb.mjs — una "Nikon" falsa con la interfaz de un USBDevice de WebUSB.
// Sirve para probar ptp.js / nikon.js sin cámara (en Node y en el navegador).
import { JPEG_B64 } from './frame-jpeg.mjs';

const u16 = n => [n & 255, (n >> 8) & 255];
const u32 = n => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
const u64 = n => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return [...b]; };
const str = s => s ? [s.length + 1, ...[...s].flatMap(c => u16(c.charCodeAt(0))), 0, 0] : [0];
const arr16 = a => [...u32(a.length), ...a.flatMap(u16)];

export class MockNikon {
  constructor(opts = {}) {
    this.opts = { chunk: 16384, coalesce: false, ...opts };
    this.vendorId = 0x04b0; this.productId = 0x0428; this.productName = 'D3300 (mock)';
    this.opened = false; this.configuration = null;
    this.eps = [
      { endpointNumber: 1, direction: 'in', type: 'bulk', packetSize: 512 },
      { endpointNumber: 2, direction: 'out', type: 'bulk', packetSize: 512 },
      { endpointNumber: 3, direction: 'in', type: 'interrupt', packetSize: 64 },
    ];
    this.configuration = null;
    this.inq = []; this.waiters = []; this.cur = null;
    this.session = false; this.lv = false; this.lvPolls = 0;
    this.events = []; this.log = []; this.delay = 0; this.hang = false;
    this.nextHandle = 0x2000; this.files = new Map();
    this.focusDenied = false; this.mode = 1;
    this.props = {
      0x500f: { t: 4, cur: 800, vals: [100, 200, 400, 800, 1600, 3200, 6400, 12800] },
      0x5007: { t: 4, cur: 350, vals: [350, 400, 450, 560, 800, 1100, 1600, 2200] },
      0x500d: { t: 6, cur: 40, vals: [0xffffffff, 300000, 200000, 130000, 80000, 40000, 10000, 5000, 2500, 1250, 625, 312, 125, 62, 50, 40, 20, 10, 5, 3] },
      0x5005: { t: 4, cur: 2, vals: [2, 4, 5, 6, 7] },
      0x500e: { t: 4, cur: 1, vals: [1, 2, 3, 4] },
      0x5001: { t: 2, cur: 80, range: [0, 100, 1] },
    };
  }
  _config() {
    this.configuration = { interfaces: [{ interfaceNumber: 0, alternates: [{ alternateSetting: 0, interfaceClass: 6, endpoints: this.eps }] }] };
  }
  async open() { this.opened = true; this._config(); }
  async close() { this.opened = false; }
  async selectConfiguration() { this._config(); }
  async claimInterface() { if (this.denyClaim) { const e = new Error('Access denied'); e.name = 'SecurityError'; throw e; } }
  async releaseInterface() {}
  async selectAlternateInterface() {}
  async clearHalt() {}

  // ---- host → dispositivo ----
  async transferOut(ep, data) {
    const b = new Uint8Array(data.buffer ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : data);
    if (b.length === 0) return { status: 'ok', bytesWritten: 0 };
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const len = dv.getUint32(0, true), type = dv.getUint16(4, true), op = dv.getUint16(6, true), tid = dv.getUint32(8, true);
    const body = b.slice(12, len);
    if (type === 1) {
      const params = []; for (let o = 0; o + 4 <= body.length; o += 4) params.push(new DataView(body.buffer, o, 4).getUint32(0, true));
      this.log.push({ op, params });
      if (op === 0x1016) this.cur = { op, params, tid };
      else this._respond(op, params, tid, null);
    } else if (type === 2 && this.cur) {
      const c = this.cur; this.cur = null; this._respond(c.op, c.params, c.tid, body);
    }
    return { status: 'ok', bytesWritten: b.length };
  }

  _container(type, code, tid, payload) {
    const out = new Uint8Array(12 + payload.length); const dv = new DataView(out.buffer);
    dv.setUint32(0, out.length, true); dv.setUint16(4, type, true); dv.setUint16(6, code, true); dv.setUint32(8, tid, true);
    out.set(payload, 12); return out;
  }
  _push(...containers) {
    const all = this.opts.coalesce ? [Uint8Array.from(containers.flatMap(c => [...c]))] : containers;
    const send = () => {
      for (const c of all) for (let o = 0; o < c.length; o += this.opts.chunk) this.inq.push(c.slice(o, o + this.opts.chunk));
      this._flush();
    };
    if (this.delay) setTimeout(send, this.delay); else send();
  }
  _flush() { while (this.waiters.length && this.inq.length) this.waiters.shift()(); }

  // ---- dispositivo → host ----
  async transferIn(ep, length) {
    if (this.hang) await new Promise(() => {});
    if (!this.inq.length) await new Promise(r => this.waiters.push(r));
    let c = this.inq.shift();
    if (c.length > length) { this.inq.unshift(c.slice(length)); c = c.slice(0, length); }
    return { status: 'ok', data: new DataView(c.buffer, c.byteOffset, c.byteLength) };
  }

  _propDesc(code) {
    const p = this.props[code]; const w = p.t === 6 ? u32 : p.t === 2 ? (n => [n]) : u16;
    const head = [...u16(code), ...u16(p.t), 1, ...w(p.cur), ...w(p.cur)];
    if (p.vals) return Uint8Array.from([...head, 2, ...u16(p.vals.length), ...p.vals.flatMap(w)]);
    return Uint8Array.from([...head, 1, ...w(p.range[0]), ...w(p.range[1]), ...w(p.range[2])]);
  }

  _respond(op, params, tid, data) {
    const R = (rc, ps = []) => this._container(3, rc, tid, Uint8Array.from(ps.flatMap(u32)));
    const D = payload => this._container(2, op, tid, Uint8Array.from(payload));
    const OK = 0x2001;
    switch (op) {
      case 0x1002: if (this.session) return this._push(R(0x201e)); this.session = true; return this._push(R(OK));
      case 0x1003: this.session = false; return this._push(R(OK));
      case 0x1001: {
        const ops = [0x1001, 0x1002, 0x1003, 0x1004, 0x1005, 0x1008, 0x1009, 0x100e, 0x1014, 0x1015, 0x1016,
          0x90c1, 0x90c7, 0x90c8, 0x9201, 0x9202, 0x9203, 0x9204, 0x9207];
        return this._push(D([...u16(100), ...u32(0x0a), ...u16(100), ...str('Nikon & Sony PTP'), ...u16(0),
          ...arr16(ops), ...arr16([0x4002, 0x4006]), ...arr16(Object.keys(this.props).map(Number)), ...arr16([]), ...arr16([0x3801]),
          ...str('Nikon Corporation'), ...str('D3300'), ...str('V1.02'), ...str('0000')]), R(OK));
      }
      case 0x1014: return this._push(D(this._propDesc(params[0])), R(OK));
      case 0x1015: { const p = this.props[params[0]]; const v = p.t === 2 ? [p.cur] : u16(p.cur); return this._push(D(v), R(OK)); }
      case 0x1016: {
        const p = this.props[params[0]];
        if (this.mode !== 1 && params[0] !== 0x500f) return this._push(R(0x2002));
        const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const v = p.t === 6 ? dv.getUint32(0, true) : p.t === 2 ? dv.getUint8(0) : dv.getUint16(0, true);
        if (p.vals && !p.vals.includes(v)) return this._push(R(0x201b));
        p.cur = v; this.events.push([0x4006, params[0]]); return this._push(R(OK));
      }
      case 0x1004: return this._push(D([...u32(1), ...u32(0x10001)]), R(OK));
      case 0x1005: return this._push(D([...u16(4), ...u16(2), ...u16(0), ...u64(32e9), ...u64(20e9), ...u32(1500)]), R(OK));
      case 0x90c8: return this._push(R(OK));
      case 0x90c7: {
        const ev = this.events.splice(0);
        return this._push(D([...u16(ev.length), ...ev.flatMap(([c, p]) => [...u16(c), ...u32(p)])]), R(OK));
      }
      case 0x9201: if (this.mode === 9) return this._push(R(0xa00b)); this.lv = true; return this._push(R(OK));
      case 0x9202: this.lv = false; return this._push(R(OK));
      case 0x9203: {
        if (!this.lv) return this._push(R(0xa00b));
        const jpg = Uint8Array.from(atob(JPEG_B64), c => c.charCodeAt(0));
        const head = new Uint8Array(384).fill(7);          // cabecera Nikon (relleno)
        this.lvPolls++;
        return this._push(D([...head, ...jpg, 0, 0, 0, 0]), R(OK));
      }
      case 0x90c1: return this._push(R(this.focusDenied ? 0xa001 : OK));
      case 0x9204: return this._push(R(OK));
      case 0x100e: {
        if (this.focusDenied) return this._push(R(0x2019));
        const h = this.nextHandle++; const name = `DSC_${String(h - 0x2000 + 1).padStart(4, '0')}.JPG`;
        this.files.set(h, { name, size: 4200000 });
        this.events.push([0x4002, h]); return this._push(R(OK));
      }
      case 0x1008: {
        const f = this.files.get(params[0]); const head = new Uint8Array(52);
        const dv = new DataView(head.buffer); dv.setUint32(0, 0x10001, true); dv.setUint16(4, 0x3801, true); dv.setUint32(8, f.size, true);
        return this._push(D([...head, ...str(f.name)]), R(OK));
      }
      default: return this._push(R(0x2005));
    }
  }
}
