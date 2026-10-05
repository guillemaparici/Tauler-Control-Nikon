// node test/ptp.test.mjs — pruebas sin cámara ni navegador.
import assert from 'node:assert/strict';
import { PTPUsb, PTPTimeout, parsePropDesc, parseDeviceInfo, encodeVal, OC } from '../js/ptp.js';
import { NikonCamera, fmtShutter, fmtAperture } from '../js/nikon.js';
import { MockNikon } from './mock-usb.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

async function connected(opts, mockSetup) {
  const m = new MockNikon(opts); mockSetup?.(m);
  const cam = new NikonCamera();
  await cam.connectDevice(m);
  return { m, cam };
}

test('formatos de velocidad/diafragma', () => {
  assert.equal(fmtShutter(40), '1/250');
  assert.equal(fmtShutter(62), '1/160');         // no "1/161"
  assert.equal(fmtShutter(125), '1/80');
  assert.equal(fmtShutter(300000), '30"');
  assert.equal(fmtShutter(6000), '0.6"');
  assert.equal(fmtShutter(5000), '1/2');
  assert.equal(fmtShutter(3), '1/4000');
  assert.equal(fmtShutter(0xffffffff), 'bulb');
  assert.equal(fmtAperture(560), 'f/5.6');
  assert.equal(fmtAperture(350), 'f/3.5');
});

test('parsers de PropDesc y DeviceInfo', async () => {
  const m = new MockNikon();
  const pd = parsePropDesc(m._propDesc(0x500f));
  assert.deepEqual(pd.values, [100, 200, 400, 800, 1600, 3200, 6400, 12800]);
  assert.equal(pd.cur, 800);
  assert.equal(parsePropDesc(m._propDesc(0x5001)).range[1], 100);
  assert.deepEqual([...encodeVal(4, 800)], [0x20, 0x03]);
  assert.deepEqual([...encodeVal(6, 0xffffffff)], [255, 255, 255, 255]);
});

test('conexión: modelo, propiedades, batería, tarjeta', async () => {
  const { cam } = await connected();
  assert.equal(cam.model, 'D3300');
  assert.equal(cam.cur.iso, '800');
  assert.equal(cam.cur.aperture, 'f/3.5');
  assert.equal(cam.cur.shutter, '1/250');
  assert.equal(cam.cur.wb, 'Auto');
  assert.equal(cam.opts.shutter[0].label, 'bulb');
  assert.equal(cam.battery, 80);
  assert.ok(Math.abs(cam.free_mb - 20e9 / 1048576) < 1);
  assert.equal(cam.shots_left, 1500);
  assert.equal(cam.warn, null);
  assert.match(cam.report(), /D3300/);
  await cam.disconnect();
});

test('cambiar ISO y velocidad; rechazo de valor inválido', async () => {
  const { cam, m } = await connected();
  await cam.setProp('iso', '3200');
  assert.equal(cam.cur.iso, '3200'); assert.equal(m.props[0x500f].cur, 3200);
  await cam.setProp('shutter', '1/80');
  assert.equal(m.props[0x500d].cur, 125); assert.equal(cam.cur.shutter, '1/80');
  await assert.rejects(() => cam.setProp('iso', '51200'), /no permitido/);
  await cam.disconnect();
});

test('dial fuera de M: aviso y error claro al cambiar velocidad', async () => {
  const { cam } = await connected({}, m => { m.props[0x500e].cur = 3; m.mode = 3; });
  assert.match(cam.warn, /dial/);
  await assert.rejects(() => cam.setProp('aperture', 'f/5.6'), /rechaz/);
  await cam.disconnect();
});

test('Live View: frames JPEG sin cabecera Nikon, y se detiene', async () => {
  const { cam, m } = await connected();
  const frames = []; cam.on('frame', f => frames.push(f));
  await cam.lvStart();
  assert.equal(cam.lv, true);
  await sleep(300);
  await cam.lvStop();
  assert.ok(frames.length >= 5, 'pocos frames: ' + frames.length);
  assert.deepEqual([...frames[0].slice(0, 3)], [0xff, 0xd8, 0xff]);
  assert.deepEqual([...frames[0].slice(-2)], [0xff, 0xd9]);
  assert.equal(m.lv, false);
  await cam.disconnect();
});

test('disparo: espera al evento, lee nombre y tamaño; reanuda el LV', async () => {
  const { cam } = await connected();
  await cam.lvStart();
  const files = await cam.shoot();
  assert.equal(files.length, 1);
  assert.match(files[0].name, /^DSC_\d{4}\.JPG$/);
  assert.equal(files[0].size, 4200000);
  assert.equal(cam.lv, true);
  await cam.disconnect();
});

test('disparo sin foco: error legible y la cámara sigue viva', async () => {
  const { cam, m } = await connected({}, m => { m.focusDenied = true; });
  await assert.rejects(() => cam.shoot(), /rechaz|ocupada/);
  m.focusDenied = false;
  const files = await cam.shoot();
  assert.equal(files.length, 1);
  await cam.disconnect();
});

test('AF y MF', async () => {
  const { cam, m } = await connected();
  await cam.af(); await cam.mf(-1, 2); await cam.mf(1, 3);
  assert.ok(m.log.some(l => l.op === 0x90c1));
  assert.deepEqual(m.log.filter(l => l.op === 0x9204).map(l => l.params), [[1, 50], [2, 200]]);
  await cam.disconnect();
});

test('el disparo se adelanta a los frames de Live View (prioridad)', async () => {
  const { cam, m } = await connected();
  await cam.lvStart(); await sleep(100);
  const polls = m.lvPolls;
  const p = await cam.shoot();
  assert.ok(p.length === 1);
  assert.ok(m.lvPolls - polls < 12, 'el LV se tragó el disparo');
  await cam.disconnect();
});

test('framing: contenedores troceados y datos+respuesta pegados', async () => {
  for (const opts of [{ chunk: 7 }, { chunk: 100 }, { coalesce: true }, { coalesce: true, chunk: 13 }]) {
    const m = new MockNikon(opts); const u = new PTPUsb(m); await u.open();
    let r = await u.transaction(OC.OpenSession, [1], null, 2000, 0); assert.equal(r.rc, 0x2001);
    r = await u.transaction(OC.GetDeviceInfo); assert.equal(parseDeviceInfo(r.data).model, 'D3300');
    r = await u.transaction(OC.GetDevicePropDesc, [0x500f]); assert.equal(parsePropDesc(r.data).cur, 800);
  }
});

test('timeout: la lectura sigue viva y la respuesta tardía se descarta', async () => {
  const m = new MockNikon(); const u = new PTPUsb(m); await u.open();
  await u.transaction(OC.OpenSession, [1], null, 2000, 0);
  m.delay = 200;
  await assert.rejects(() => u.transaction(OC.GetDeviceInfo, [], null, 50), PTPTimeout);
  await sleep(300);                                    // llega la respuesta caducada
  m.delay = 0;
  const r = await u.transaction(OC.GetDevicePropDesc, [0x500f], null, 1000);
  assert.equal(parsePropDesc(r.data).code, 0x500f);    // no se confunde con la respuesta vieja
});

test('cámara que se cuelga: tras 3 timeouts se da por desconectada', async () => {
  const { cam, m } = await connected();
  let state = null; cam.on('state', s => { state = s; });
  m.hang = true;
  const ps = [1, 2, 3].map(() => cam.submit(async c => { await c.u.transaction(OC.GetDeviceInfo, [], null, 40); }, 1).catch(e => e));
  const res = await Promise.all(ps);
  assert.ok(res.every(e => e instanceof Error));
  await sleep(100);
  assert.equal(cam.connected, false);
  assert.equal(state.connected, false);
});

test('interfaz bloqueada: mensaje explicativo', async () => {
  const m = new MockNikon(); m.denyClaim = true;
  const cam = new NikonCamera();
  await assert.rejects(() => cam.connectDevice(m), /interfaz|cámara/);
  assert.equal(cam.connected, false);
});

test('reconexión: segunda sesión tras desconectar (sesión ya abierta)', async () => {
  const m = new MockNikon(); const cam = new NikonCamera();
  await cam.connectDevice(m); await cam.disconnect();
  m.session = true;                                   // la cámara no cerró la sesión
  await cam.connectDevice(m);
  assert.equal(cam.connected, true);
  await cam.disconnect();
});

let fail = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log('  ✓', name); }
  catch (e) { fail++; console.log('  ✗', name, '\n     ', e.message); }
}
console.log(fail ? `\n${fail} FALLOS` : '\nTODO OK');
process.exit(fail ? 1 : 0);
