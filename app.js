// app.js — interfaz de NikonLink (fase A). Modo demo: añade ?demo a la URL.
import { NikonCamera } from './nikon.js';
import { SimCamera } from './sim.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const DEMO = new URLSearchParams(location.search).has('demo');
const cam = DEMO ? new SimCamera() : new NikonCamera();
let S = { connected: false };

/* ---------- registro y avisos ---------- */
const logLines = [];
function log(m) {
  logLines.unshift(new Date().toLocaleTimeString('es-ES') + '  ' + m);
  logLines.length = Math.min(logLines.length, 80);
  $('#log').textContent = logLines.join('\n');
  if (String(m).startsWith('⚠')) toast(m);
}
let toastTimer = 0;
function toast(m) {
  const el = $('#toast');
  el.textContent = m; el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 7000);
}
const fmtMB = mb => mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB';

/* ---------- compatibilidad ---------- */
(function compat() {
  const el = $('#compat');
  let msg = '';
  if (DEMO) msg = 'Modo demo: cámara simulada. Quita ?demo de la dirección para usar tu Nikon.';
  else if (!window.isSecureContext) msg = 'Esta página necesita HTTPS (o localhost) para poder usar USB.';
  else if (!navigator.usb) {
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    msg = ios ? 'iPhone y iPad no permiten controlar cámaras por USB desde el navegador. Usa un ordenador o un móvil/tablet Android con Chrome.'
      : 'Este navegador no soporta WebUSB. Usa Chrome, Edge u Opera en ordenador, o Chrome en Android.';
    $('#btnConnect').disabled = true;
  }
  if (msg) { el.textContent = msg; el.hidden = false; }
})();

/* ---------- modo rojo, pantalla, pestañas ---------- */
$('#btnRed').onclick = () => {
  const on = document.body.classList.toggle('red');
  $('#btnRed').classList.toggle('on', on);
  $('meta[name=theme-color]').content = on ? '#050000' : '#0b0d10';
  try { localStorage.setItem('nl_red', on ? '1' : '0'); } catch (e) { /* ignore */ }
};
try { if (localStorage.getItem('nl_red') === '1') $('#btnRed').click(); } catch (e) { /* ignore */ }
$('#btnFs').onclick = () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.();
$$('.tab').forEach(b => b.onclick = () => {
  $$('.tab').forEach(x => x.classList.toggle('on', x === b));
  $$('.pane').forEach(p => p.classList.toggle('on', p.id === b.dataset.p));
});
let wakeLock = null;
async function wake() {
  try {
    if ($('#ckWake').checked && 'wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (e) { /* ignore */ }
}
$('#ckWake').onchange = () => { if ($('#ckWake').checked) wake(); else { wakeLock?.release(); wakeLock = null; } };
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wake(); });
document.addEventListener('pointerdown', wake, { once: true });

/* ---------- diales táctiles (scroll-snap) ---------- */
const ITEM = 64;
const DIALS = {};
function makeDial(key, title) {
  const wrap = document.createElement('div');
  wrap.className = 'dial';
  wrap.innerHTML = '<h4></h4><div class="strip"></div><div class="mk"></div>';
  wrap.querySelector('h4').textContent = title;
  $('#dials').appendChild(wrap);
  const strip = wrap.querySelector('.strip');
  const d = { list: [], cur: null, ignoreUntil: 0, userUntil: 0, touching: false, timer: 0 };
  const hl = i => [...strip.children].forEach((c, k) => c.classList.toggle('sel', k === i));
  d.fill = list => {
    if (JSON.stringify(list) === JSON.stringify(d.list)) return;
    d.list = list.slice();
    strip.replaceChildren(...list.map(v => { const e = document.createElement('div'); e.className = 'it'; e.textContent = v; return e; }));
    d.cur = null;
  };
  d.set = v => {
    if (d.touching || performance.now() < d.userUntil) return;
    const i = d.list.indexOf(v);
    if (i < 0) return;
    d.cur = v;
    d.ignoreUntil = performance.now() + 250;
    strip.scrollTo({ left: i * ITEM, behavior: 'auto' });
    hl(i);
  };
  strip.addEventListener('pointerdown', () => { d.touching = true; });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => strip.addEventListener(ev, () => { d.touching = false; }));
  strip.addEventListener('scroll', () => {
    if (performance.now() < d.ignoreUntil || !S.connected) return;
    const i = Math.min(d.list.length - 1, Math.max(0, Math.round(strip.scrollLeft / ITEM)));
    hl(i);
    clearTimeout(d.timer);
    d.timer = setTimeout(() => {
      const v = d.list[i];
      if (v !== undefined && v !== d.cur) {
        d.cur = v;
        d.userUntil = performance.now() + 700;
        run(() => cam.setProp(key, v));
      }
    }, 140);
  }, { passive: true });
  DIALS[key] = d;
}
makeDial('iso', 'ISO');
makeDial('aperture', 'DIAFRAGMA');
makeDial('shutter', 'VELOCIDAD');

/* ---------- ejecutar órdenes con control de errores ---------- */
async function run(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) log(okMsg(r));
    return r;
  } catch (e) {
    log('⚠ ' + (e && e.message ? e.message : e));
  }
}

/* ---------- estado ---------- */
function fillSelect(sel, list, val) {
  if (!list || !list.length) return;
  if ([...sel.options].map(o => o.value).join('|') !== list.join('|'))
    sel.replaceChildren(...list.map(v => { const o = document.createElement('option'); o.value = o.textContent = v; return o; }));
  if (val !== undefined) sel.value = val;
}
function applyState(m) {
  const was = S.connected;
  S = m;
  if (m.opts) {
    ['iso', 'aperture', 'shutter'].forEach(k => DIALS[k].fill(m.opts[k] || []));
    fillSelect($('#wb'), m.opts.wb, m.wb);
  }
  ['iso', 'aperture', 'shutter'].forEach(k => m[k] !== undefined && DIALS[k].set(m[k]));
  if (m.wb !== undefined && document.activeElement !== $('#wb')) $('#wb').value = m.wb;
  const c = $('#conn');
  c.textContent = m.connected ? 'Conectada · ' + (m.model || 'Nikon') : (m.error ? 'Sin cámara' : 'Sin cámara');
  c.className = 'pill ' + (m.connected ? 'ok' : 'bad');
  $('#bat').hidden = m.battery == null; $('#bat').textContent = '🔋 ' + m.battery + '%';
  $('#free').hidden = m.free_mb == null; $('#free').textContent = '💾 ' + fmtMB(m.free_mb || 0);
  $('#btnLv').classList.toggle('on', !!m.lv);
  $('#btnLv').disabled = $('#btnAf').disabled = $('#mfM').disabled = $('#mfP').disabled = !m.connected;
  $('#btnConnect').textContent = m.connected ? 'Desconectar' : 'Conectar cámara';
  $('#btnConnect').classList.toggle('primary', !m.connected);
  $('#lvBadge').textContent = m.lv ? 'LV activo' : 'LV apagado';
  if (!m.lv) { $('#noimg').style.display = ''; if (was && !m.connected) clearCanvas(); }
  let info = m.connected
    ? `${m.model || 'Nikon'} · ISO ${m.iso ?? '–'} · ${m.aperture ?? '–'} · ${m.shutter ?? '–'} · WB ${m.wb ?? '–'}` + (m.shots_left != null ? ` · ${m.shots_left} tomas restantes` : '')
    : (m.error || 'Sin datos de cámara.');
  if (m.connected && m.warn) info += '\n⚠ ' + m.warn;
  $('#camInfo').textContent = info;
  $('#camInfo').style.whiteSpace = 'pre-line';
  if (m.connected && m.warn && !was) toast('⚠ ' + m.warn);
  if (!m.connected && m.error && was) toast('⚠ Cámara desconectada: ' + m.error);
}
cam.on('state', applyState);
cam.on('log', log);

/* ---------- conectar / desconectar ---------- */
$('#btnConnect').onclick = async () => {
  if (S.connected) { await cam.disconnect(); return; }
  $('#btnConnect').disabled = true;
  try { await cam.requestAndConnect(); }
  catch (e) {
    if (e && e.name === 'NotFoundError') log('Selección de cámara cancelada');   // el usuario cerró el diálogo
    else log('⚠ ' + (e && e.message ? e.message : e));
  } finally { $('#btnConnect').disabled = false; }
};
async function autoReconnect() {
  try { if (await cam.reconnectKnown()) log('Cámara reconectada automáticamente'); }
  catch (e) { log('Reconexión automática: ' + e.message); }
}
let retryTimer = 0;
function scheduleRetry() {                               // reconexión silenciosa si la cámara se durmió o se cayó
  clearTimeout(retryTimer);
  if (DEMO || S.connected || !S.error || !navigator.usb) return;
  retryTimer = setTimeout(async () => { await autoReconnect(); scheduleRetry(); }, 3000);
}
cam.on('state', scheduleRetry);
if (!DEMO && navigator.usb) {
  autoReconnect();                                       // cámara ya autorizada en una visita anterior
  navigator.usb.addEventListener('connect', () => setTimeout(autoReconnect, 800));
}

/* ---------- controles ---------- */
$('#wb').onchange = e => run(() => cam.setProp('wb', e.target.value));
$('#btnLv').onclick = () => run(() => S.lv ? cam.lvStop() : cam.lvStart());
$('#btnAf').onclick = () => run(() => cam.af(), () => 'AF realizado');
$('#mfM').onclick = () => run(() => cam.mf(-1, +$('#mfStep').value));
$('#mfP').onclick = () => run(() => cam.mf(1, +$('#mfStep').value));
let shooting = false;
async function shoot() {
  if (!S.connected) return toast('⚠ Conecta primero la cámara');
  if (shooting) return;
  shooting = true; $('#btnShoot').style.opacity = .5;
  await run(() => cam.shoot(), f => 'Foto guardada en la tarjeta: ' + f.map(x => `${x.name} (${(x.size / 1048576).toFixed(1)} MB)`).join(', '));
  shooting = false; $('#btnShoot').style.opacity = 1;
}
$('#btnShoot').onclick = shoot;
document.addEventListener('keydown', e => {
  if (e.code === 'Space' && !/INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement.tagName)) { e.preventDefault(); shoot(); }
});
$('#ckGrid').onchange = e => $('#grid').classList.toggle('on', e.target.checked);
$('#ckHist').onchange = e => $('#hist').classList.toggle('on', e.target.checked);

/* ---------- visor: "Drop Oldest Frame" ----------
   Solo hay UN frame pendiente: si llega otro mientras se decodifica, lo sustituye.
   Nunca se acumula cola, así que la latencia está acotada. */
const lvc = $('#lv'), lvx = lvc.getContext('2d', { alpha: false, desynchronized: true });
const hx = $('#hist').getContext('2d');
const probe = document.createElement('canvas'); probe.width = 128; probe.height = 86;
const px = probe.getContext('2d', { willReadFrequently: true });
const bins = new Uint32Array(256);
let pending = null, decoding = false, frames = 0, frameNo = 0;
function clearCanvas() { lvx.fillStyle = '#000'; lvx.fillRect(0, 0, lvc.width, lvc.height); }
cam.on('frame', buf => { pending = buf; if (!decoding) pump(); });
async function pump() {
  decoding = true;
  while (pending) {
    const buf = pending; pending = null;
    try {
      const bmp = await createImageBitmap(new Blob([buf], { type: 'image/jpeg' }));
      drawBitmap(bmp);
      bmp.close();
    } catch (e) { /* frame corrupto: se descarta */ }
  }
  decoding = false;
}
function drawBitmap(bmp) {
  if (lvc.width !== bmp.width || lvc.height !== bmp.height) { lvc.width = bmp.width; lvc.height = bmp.height; }
  lvx.drawImage(bmp, 0, 0);
  $('#noimg').style.display = 'none';
  frames++;
  if ((++frameNo % 6 === 0) && $('#hist').classList.contains('on')) drawHist(bmp);
}
function drawHist(bmp) {
  px.drawImage(bmp, 0, 0, 128, 86);
  const d = px.getImageData(0, 0, 128, 86).data;
  bins.fill(0);
  for (let i = 0; i < d.length; i += 4) bins[(d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0]++;
  let max = 1; for (let i = 1; i < 255; i++) if (bins[i] > max) max = bins[i];
  hx.clearRect(0, 0, 140, 56);
  hx.fillStyle = getComputedStyle(document.body).getPropertyValue('--fg').trim() || '#fff';
  hx.globalAlpha = 0.85;
  for (let i = 0; i < 256; i += 2) { const h = Math.min(54, (bins[i] + bins[i + 1]) / max * 54 * 1.4); hx.fillRect(i * 140 / 256, 56 - h, 1.6, h); }
  hx.globalAlpha = 1;
  if (bins[255] + bins[254] > 128 * 86 * 0.01) { hx.fillStyle = '#f33'; hx.fillRect(136, 0, 4, 56); }
}
setInterval(() => { $('#fps').textContent = frames + ' fps'; frames = 0; }, 1000);

/* ---------- informe de diagnóstico ---------- */
$('#btnCopy').onclick = async () => {
  const txt = cam.report();
  try { await navigator.clipboard.writeText(txt); toast('Informe copiado. Pégalo en el chat.'); }
  catch (e) { toast('No se pudo copiar: usa "Descargar .txt"'); }
};
$('#btnSave').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([cam.report()], { type: 'text/plain' }));
  a.download = 'nikonlink-informe.txt'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};

if (DEMO) log('Modo demo activo: pulsa "Conectar cámara".');
window.__nikonlink = { cam };   // útil para depurar desde la consola
