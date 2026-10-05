// ptp.js — PTP (Picture Transfer Protocol) sobre WebUSB.
// Sin dependencias. Un PTPUsb NO admite transacciones concurrentes: nikon.js
// las serializa todas en una única cola.

export const CT = { CMD: 1, DATA: 2, RESP: 3, EVENT: 4 };
export const RC = { OK: 0x2001, GENERAL: 0x2002, BUSY: 0x2019, SESSION_OPEN: 0x201e };
export const OC = {
  GetDeviceInfo: 0x1001, OpenSession: 0x1002, CloseSession: 0x1003,
  GetStorageIDs: 0x1004, GetStorageInfo: 0x1005, GetObjectInfo: 0x1008, GetObject: 0x1009,
  InitiateCapture: 0x100e, GetDevicePropDesc: 0x1014, GetDevicePropValue: 0x1015,
  SetDevicePropValue: 0x1016,
  // extensiones Nikon
  NK_AfDrive: 0x90c1, NK_GetEvent: 0x90c7, NK_DeviceReady: 0x90c8,
  NK_StartLV: 0x9201, NK_EndLV: 0x9202, NK_GetLV: 0x9203, NK_MfDrive: 0x9204,
  NK_CaptureMedia: 0x9207, NK_TerminateCapture: 0x920c,
};

export class PTPError extends Error {
  constructor(msg, code) { super(msg); this.name = 'PTPError'; this.code = code; }
}
export class PTPTimeout extends PTPError { constructor(m = 'Timeout USB') { super(m); this.name = 'PTPTimeout'; } }
export class PTPDisconnected extends PTPError { constructor(m) { super(m); this.name = 'PTPDisconnected'; } }

export const hex = (n, w = 4) => '0x' + (n >>> 0).toString(16).toUpperCase().padStart(w, '0');

function concat(chunks, total) {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

function mapUsbError(e) {
  if (e instanceof PTPError) return e;
  const n = e && e.name;
  if (n === 'NotFoundError' || n === 'NetworkError' || n === 'InvalidStateError')
    return new PTPDisconnected('USB: ' + (e.message || n));
  return new PTPError('USB: ' + ((e && e.message) || e));
}

export class PTPUsb {
  constructor(device) {
    this.dev = device;
    this.tid = 0;
    this.inEp = this.outEp = null;
    this.ifn = null;
    this.left = new Uint8Array(0);
    this.pending = null;      // transferIn en curso (se conserva tras un timeout: no se pierden datos)
    this.onlog = () => {};
  }

  async open() {
    const d = this.dev;
    if (!d.opened) {
      try { await d.open(); } catch (e) { throw new PTPError(explainAccess(e, 'abrir'), 'open'); }
    }
    if (d.configuration === null || d.configuration === undefined) await d.selectConfiguration(1);
    let found = null;
    for (const intf of d.configuration.interfaces) {
      for (const alt of intf.alternates) {
        if (alt.interfaceClass === 6) { found = { intf, alt }; break; }
      }
      if (found) break;
    }
    if (!found) throw new PTPError('La cámara no expone una interfaz PTP (clase 6)');
    this.ifn = found.intf.interfaceNumber;
    try { await d.claimInterface(this.ifn); }
    catch (e) { throw new PTPError(explainAccess(e, 'reclamar la interfaz de'), 'claim'); }
    if (found.alt.alternateSetting) await d.selectAlternateInterface(this.ifn, found.alt.alternateSetting);
    for (const ep of found.alt.endpoints) {
      if (ep.type === 'bulk' && ep.direction === 'in') this.inEp = ep;
      else if (ep.type === 'bulk' && ep.direction === 'out') this.outEp = ep;
    }
    if (!this.inEp || !this.outEp) throw new PTPError('Endpoints USB de PTP no encontrados');
    for (const [dir, ep] of [['in', this.inEp], ['out', this.outEp]]) {
      try { await d.clearHalt(dir, ep.endpointNumber); } catch (e) { /* no pasa nada */ }
    }
    // vaciar restos de una sesión anterior interrumpida
    for (let i = 0; i < 6; i++) {
      try { await this._chunk(70); } catch (e) { break; }
    }
  }

  async close() {
    try { if (this.ifn !== null) await this.dev.releaseInterface(this.ifn); } catch (e) { /* ignore */ }
    try { if (this.dev.opened) await this.dev.close(); } catch (e) { /* ignore */ }
  }

  async _write(bytes) {
    try {
      const r = await this.dev.transferOut(this.outEp.endpointNumber, bytes);
      if (r.status !== 'ok') throw new PTPError('Escritura USB: ' + r.status);
      if (bytes.length % (this.outEp.packetSize || 512) === 0)
        await this.dev.transferOut(this.outEp.endpointNumber, new Uint8Array(0)); // paquete de longitud cero
    } catch (e) { throw mapUsbError(e); }
  }

  // Una lectura USB. Si vence el timeout se lanza PTPTimeout PERO la lectura
  // sigue viva y la próxima llamada la reutiliza (WebUSB no permite cancelarla).
  async _chunk(timeout) {
    if (!this.pending) {
      this.pending = this.dev.transferIn(this.inEp.endpointNumber, 65536).then(r => {
        if (r.status === 'stall') { this.dev.clearHalt('in', this.inEp.endpointNumber).catch(() => {}); throw new PTPError('Stall USB'); }
        if (r.status === 'babble') throw new PTPError('Desbordamiento USB');
        return r.data ? new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength) : new Uint8Array(0);
      }, e => { throw mapUsbError(e); });
      this.pending.catch(() => {}); // evita "unhandled rejection" si vence el timeout antes
    }
    // La lectura (y su resultado, aunque llegue tarde) se conserva hasta que alguien la consume.
    const p = this.pending;
    let t, timedOut = false;
    const timer = new Promise((_, rej) => { t = setTimeout(() => { timedOut = true; rej(new PTPTimeout()); }, timeout); });
    try { return await Promise.race([p, timer]); }
    finally {
      clearTimeout(t);
      if (!timedOut && this.pending === p) this.pending = null;
    }
  }

  async _container(timeout) {
    let chunks = this.left.length ? [this.left] : [];
    let total = this.left.length;
    this.left = new Uint8Array(0);
    let empties = 0;
    while (total < 12) {
      const c = await this._chunk(timeout);
      if (!c.length && ++empties > 50) throw new PTPError('Lectura USB vacía repetida');
      chunks.push(c); total += c.length;
    }
    let buf = concat(chunks, total); chunks = [buf];
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const length = dv.getUint32(0, true), type = dv.getUint16(4, true),
      code = dv.getUint16(6, true), tid = dv.getUint32(8, true);
    if (length < 12) throw new PTPError('Contenedor PTP inválido');
    empties = 0;
    while (total < length) {
      const c = await this._chunk(timeout);
      if (!c.length) { if (++empties > 50) throw new PTPError('Contenedor PTP truncado'); continue; }
      chunks.push(c); total += c.length;
    }
    buf = concat(chunks, total);
    this.left = buf.slice(length);                 // lo que sobre es del siguiente contenedor
    return { type, code, tid, payload: buf.subarray(12, length) };
  }

  // Devuelve {rc, params, data}. No lanza por rc != OK.
  async transaction(op, params = [], data = null, timeout = 10000, tid = null) {
    const my = tid !== null ? tid : ++this.tid;
    const cmd = new Uint8Array(12 + 4 * params.length);
    const dv = new DataView(cmd.buffer);
    dv.setUint32(0, cmd.length, true); dv.setUint16(4, CT.CMD, true);
    dv.setUint16(6, op, true); dv.setUint32(8, my, true);
    params.forEach((p, i) => dv.setUint32(12 + 4 * i, p >>> 0, true));
    await this._write(cmd);
    if (data) {
      const d = new Uint8Array(12 + data.length);
      const ddv = new DataView(d.buffer);
      ddv.setUint32(0, d.length, true); ddv.setUint16(4, CT.DATA, true);
      ddv.setUint16(6, op, true); ddv.setUint32(8, my, true);
      d.set(data, 12);
      await this._write(d);
    }
    let rdata = new Uint8Array(0);
    for (;;) {
      const c = await this._container(timeout);
      if (c.tid !== my && c.type !== CT.EVENT) continue;   // resto de una transacción anterior caducada
      if (c.type === CT.DATA) rdata = c.payload;
      else if (c.type === CT.RESP) {
        const pdv = new DataView(c.payload.buffer, c.payload.byteOffset, c.payload.byteLength);
        const ps = [];
        for (let o = 0; o + 4 <= c.payload.length; o += 4) ps.push(pdv.getUint32(o, true));
        return { rc: c.code, params: ps, data: rdata };
      }
    }
  }
}

function explainAccess(e, what) {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  const base = `No se pudo ${what} la cámara (${(e && e.message) || e}). `;
  if (/Windows/i.test(ua))
    return base + 'En Windows hay que instalar el driver WinUSB en la cámara con Zadig (ver README) y cerrar otros programas que la usen.';
  if (/Android/i.test(ua))
    return base + 'En Android: acepta el permiso USB, cierra apps de fotos/galería que usen la cámara y prueba a desconectar y volver a conectar el cable OTG.';
  if (/Linux/i.test(ua))
    return base + 'En Linux hace falta una regla udev para la cámara (ver README) y que ningún programa (gvfs, gphoto2) la tenga abierta.';
  return base + 'Cierra otros programas que usen la cámara (Fotos, Captura de Imagen, gphoto2) y vuelve a conectarla.';
}

// ---------- datasets PTP ----------
export function readString(dv, off) {
  const n = dv.getUint8(off);
  let s = '';
  for (let i = 0; i < n; i++) { const c = dv.getUint16(off + 1 + 2 * i, true); if (c) s += String.fromCharCode(c); }
  return [s, off + 1 + 2 * n];
}

export function parseDeviceInfo(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const vendorExt = dv.getUint32(2, true);
  let off = 8, desc, man, model, ver;
  [desc, off] = readString(dv, off);
  off += 2;
  const arr = o => {
    const n = dv.getUint32(o, true); o += 4;
    const v = [];
    for (let i = 0; i < n; i++) v.push(dv.getUint16(o + 2 * i, true));
    return [v, o + 2 * n];
  };
  let ops, evs, props;
  [ops, off] = arr(off); [evs, off] = arr(off); [props, off] = arr(off);
  [, off] = arr(off); [, off] = arr(off);
  [man, off] = readString(dv, off); [model, off] = readString(dv, off); [ver, off] = readString(dv, off);
  return { vendorExt, extDesc: desc, ops: new Set(ops), events: new Set(evs), props: new Set(props), manufacturer: man, model, version: ver };
}

const SZ = { 1: 1, 2: 1, 3: 2, 4: 2, 5: 4, 6: 4, 7: 8, 8: 8 };
function getVal(dv, off, t) {
  switch (t) {
    case 1: return dv.getInt8(off); case 2: return dv.getUint8(off);
    case 3: return dv.getInt16(off, true); case 4: return dv.getUint16(off, true);
    case 5: return dv.getInt32(off, true); case 6: return dv.getUint32(off, true);
    case 7: return Number(dv.getBigInt64(off, true)); case 8: return Number(dv.getBigUint64(off, true));
  }
  throw new PTPError('Tipo de propiedad no numérico: ' + t);
}
export function encodeVal(t, v) {
  const b = new Uint8Array(SZ[t]); const dv = new DataView(b.buffer);
  switch (t) {
    case 1: dv.setInt8(0, v); break; case 2: dv.setUint8(0, v); break;
    case 3: dv.setInt16(0, v, true); break; case 4: dv.setUint16(0, v, true); break;
    case 5: dv.setInt32(0, v, true); break; case 6: dv.setUint32(0, v, true); break;
    case 7: dv.setBigInt64(0, BigInt(v), true); break; case 8: dv.setBigUint64(0, BigInt(v), true); break;
  }
  return b;
}

export function parsePropDesc(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const code = dv.getUint16(0, true), dtype = dv.getUint16(2, true), getset = dv.getUint8(4);
  if (!SZ[dtype]) throw new PTPError('Tipo de propiedad no numérico: ' + dtype);
  const sz = SZ[dtype];
  let off = 5;
  const rd = () => { const v = getVal(dv, off, dtype); off += sz; return v; };
  const def = rd(), cur = rd();
  const form = dv.getUint8(off); off += 1;
  let values = null, range = null;
  if (form === 1) range = [rd(), rd(), rd()];
  else if (form === 2) {
    const n = dv.getUint16(off, true); off += 2;
    values = []; for (let i = 0; i < n; i++) values.push(rd());
  }
  return { code, dtype, getset, def, cur, form, values, range };
}
