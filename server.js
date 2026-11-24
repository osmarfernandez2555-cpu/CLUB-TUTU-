// =====================================================================
//  Club Tutu+ · servidor de la landing
//  - Sirve index.html
//  - Tutu Express: manda el CUIT al robot de créditos (consulta-bancor)
//    sin exponer ROBOT_CLAVE en la página, y devuelve un resultado simple
//  - Guarda los leads (PostgreSQL si hay DATABASE_URL, si no en un archivo)
//  - Mystery Box: cuenta a los interesados
// =====================================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROBOT_URL = (process.env.ROBOT_URL || '').replace(/\/+$/, '');   // ej: https://consulta-bancor-production.up.railway.app
const ROBOT_CLAVE = process.env.ROBOT_CLAVE || '';                    // la misma ROBOT_CLAVE del robot
const EXPRESS_BANCOS = process.env.EXPRESS_BANCOS || '';               // vacío = los bancos por defecto del robot
const LEADS_WEBHOOK = process.env.LEADS_WEBHOOK || '';                 // opcional: URL que recibe cada lead (Kommo, Make, Ruthina…)
const ADMIN_CLAVE = process.env.ADMIN_CLAVE || '';                     // para ver /admin
const MYSTERY_APERTURA = process.env.MYSTERY_APERTURA || '2026-12-04T20:00:00-03:00';
const MYSTERY_URL = process.env.MYSTERY_URL || 'https://osmarfernandez2555-cpu.github.io/mistery-box-tutu/';
const REFERIDOS_URL = process.env.REFERIDOS_URL || 'https://tutu-referidos.up.railway.app/referidos';
const MAX_ESPERA_MS = 150000; // después de 2 min y medio se corta y pasa a un asesor

// ---------------------------------------------------------------------
//  Base de datos (PostgreSQL) con respaldo en archivo
// ---------------------------------------------------------------------
let pool = null;
if (process.env.DATABASE_URL) {
  try {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /railway|amazonaws|render/.test(process.env.DATABASE_URL) && !/\.internal/.test(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : false });
  } catch (e) { console.log('[DB] no se pudo cargar pg:', e.message); }
}
const ARCHIVO = path.join(__dirname, 'datos.json');
let mem = { leads: [], interes: [] };
try { mem = JSON.parse(fs.readFileSync(ARCHIVO, 'utf8')); } catch {}
const guardarArchivo = () => { if (!pool) fs.writeFile(ARCHIVO, JSON.stringify(mem), () => {}); };

async function iniciarDB() {
  if (!pool) { console.log('[DB] sin DATABASE_URL: guardo en datos.json'); return; }
  await pool.query(`CREATE TABLE IF NOT EXISTS club_express (
    id TEXT PRIMARY KEY, creado TIMESTAMPTZ DEFAULT now(), nombre TEXT, telefono TEXT, cuit TEXT,
    robot_id TEXT, resultado TEXT, bancos TEXT, detalle JSONB, vehiculo TEXT, ip TEXT)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS club_mystery (
    dispositivo TEXT PRIMARY KEY, creado TIMESTAMPTZ DEFAULT now(), telefono TEXT, nombre TEXT)`);
  console.log('[DB] PostgreSQL listo');
}

async function nuevoLead(l) {
  if (pool) await pool.query('INSERT INTO club_express (id,nombre,telefono,cuit,robot_id,resultado,ip) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [l.id, l.nombre, l.telefono, l.cuit, l.robot_id, l.resultado, l.ip]);
  else { mem.leads.push({ ...l, creado: new Date().toISOString() }); guardarArchivo(); }
}
async function actualizarLead(id, campos) {
  if (pool) {
    const k = Object.keys(campos);
    if (!k.length) return;
    await pool.query(`UPDATE club_express SET ${k.map((c, i) => `${c}=$${i + 2}`).join(',')} WHERE id=$1`, [id, ...k.map(c => campos[c])]);
  } else { const l = mem.leads.find(x => x.id === id); if (l) Object.assign(l, campos); guardarArchivo(); }
}
async function leerLead(id) {
  if (pool) return (await pool.query('SELECT * FROM club_express WHERE id=$1', [id])).rows[0] || null;
  return mem.leads.find(x => x.id === id) || null;
}
async function totalInteres() {
  if (pool) return Number((await pool.query('SELECT count(*) FROM club_mystery')).rows[0].count);
  return mem.interes.length;
}

// ---------------------------------------------------------------------
//  Utilidades
// ---------------------------------------------------------------------
function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function leerBody(req, max = 5000) {
  return new Promise(resolve => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > max) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
  });
}
const ipDe = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const limpio = (s, n = 80) => String(s || '').replace(/[<>]/g, '').trim().slice(0, n);

function cuitValido(c) {
  if (!/^\d{11}$/.test(c)) return false;
  if (!['20', '23', '24', '27', '30', '33', '34'].includes(c.slice(0, 2))) return false;
  const m = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const s = m.reduce((a, x, i) => a + x * Number(c[i]), 0);
  let v = 11 - (s % 11);
  if (v === 11) v = 0;
  if (v === 10) v = 9;
  return v === Number(c[10]);
}

// Límite simple: 5 consultas por hora por IP, 3 por día por CUIT
const limites = new Map();
function pasaLimite(clave, max, ventanaMs) {
  const ahora = Date.now();
  const lista = (limites.get(clave) || []).filter(t => ahora - t < ventanaMs);
  if (lista.length >= max) { limites.set(clave, lista); return false; }
  lista.push(ahora); limites.set(clave, lista);
  return true;
}

async function avisarWebhook(evento, datos) {
  if (!LEADS_WEBHOOK) return;
  try {
    await fetch(LEADS_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origen: 'club-tutu', evento, ...datos }), signal: AbortSignal.timeout(10000) });
  } catch (e) { console.log('[Webhook] error:', e.message); }
}

// Lee el pedido del robot y lo traduce a algo simple para la página
const APROBADO = new Set(['APROBADO', 'PREAPROBADO']);
const NOMBRES = { bancor: 'Bancor', nacion: 'Banco Nación', galicia: 'Banco Galicia', santander: 'Santander', decreditos: 'deCréditos' };
function interpretar(t, transcurrido) {
  const res = Array.isArray(t.resultados) ? t.resultados : [];
  const aprobados = res.filter(r => APROBADO.has(String(r.estado).toUpperCase()));
  if (aprobados.length) return { estado: 'aprobado', bancos: aprobados.map(r => NOMBRES[r.banco] || r.banco) };
  if (t.estado === 'listo') {
    const todosNo = res.length > 0 && res.every(r => String(r.estado).toUpperCase() === 'DENEGADO');
    return { estado: todosNo ? 'sin_oferta' : 'revisar' };
  }
  if (transcurrido > MAX_ESPERA_MS) return { estado: 'revisar' };
  return { estado: 'evaluando', avance: res.length, cola: t.estado === 'en_cola' };
}

// ---------------------------------------------------------------------
//  Rutas
// ---------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
    }
    if (req.method === 'GET' && /^\/fonts\/[a-z0-9-]+\.woff2$/.test(url.pathname)) {
      const f = path.join(__dirname, url.pathname);
      if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'font/woff2', 'Cache-Control': 'public, max-age=31536000, immutable' });
      return fs.createReadStream(f).pipe(res);
    }
    if (req.method === 'GET' && url.pathname === '/salud') return json(res, 200, { ok: true, robot: !!(ROBOT_URL && ROBOT_CLAVE), db: !!pool });

    if (req.method === 'GET' && url.pathname === '/api/config') {
      return json(res, 200, { mysteryApertura: MYSTERY_APERTURA, mysteryUrl: MYSTERY_URL, referidosUrl: REFERIDOS_URL, interesados: await totalInteres() });
    }

    // ----- Tutu Express: arranca la evaluación -----
    if (req.method === 'POST' && url.pathname === '/api/express/consultar') {
      const b = await leerBody(req);
      const nombre = limpio(b.nombre, 60);
      const telefono = String(b.telefono || '').replace(/\D/g, '').slice(0, 15);
      const cuit = String(b.cuit || '').replace(/\D/g, '');
      if (nombre.length < 2) return json(res, 400, { error: 'Escribí tu nombre.', campo: 'nombre' });
      if (telefono.length < 8) return json(res, 400, { error: 'Revisá el teléfono: tiene que tener código de área y número.', campo: 'telefono' });
      if (!cuitValido(cuit)) return json(res, 400, { error: 'Ese CUIT/CUIL no es válido. Son 11 números, sin guiones.', campo: 'cuit' });
      if (!b.acepto) return json(res, 400, { error: 'Necesitamos tu autorización para consultar.', campo: 'acepto' });
      const ip = ipDe(req);
      if (!pasaLimite('ip:' + ip, 5, 3600e3) || !pasaLimite('cuit:' + cuit, 3, 86400e3)) {
        return json(res, 429, { error: 'Hiciste varias consultas seguidas. Probá de nuevo en un rato o escribinos por WhatsApp.' });
      }
      const id = crypto.randomUUID();
      let robot_id = '', resultado = 'evaluando';
      if (ROBOT_URL && ROBOT_CLAVE) {
        try {
          const r = await fetch(`${ROBOT_URL}/api/robot/consultar`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'x-robot': ROBOT_CLAVE },
            body: JSON.stringify({ cuit, ...(EXPRESS_BANCOS ? { bancos: EXPRESS_BANCOS } : {}) }),
            signal: AbortSignal.timeout(15000),
          });
          const d = await r.json().catch(() => ({}));
          if (r.ok && d.id) robot_id = String(d.id);
          else { console.log('[Robot] respuesta:', r.status, d.error || ''); resultado = 'revisar'; }
        } catch (e) { console.log('[Robot] no responde:', e.message); resultado = 'revisar'; }
      } else { console.log('[Robot] faltan ROBOT_URL / ROBOT_CLAVE'); resultado = 'revisar'; }
      await nuevoLead({ id, nombre, telefono, cuit, robot_id, resultado, ip });
      avisarWebhook('express_nuevo', { id, nombre, telefono, cuit });
      return json(res, 200, { ok: true, id });
    }

    // ----- Tutu Express: estado de la evaluación -----
    if (req.method === 'GET' && url.pathname === '/api/express/estado') {
      const l = await leerLead(String(url.searchParams.get('id') || ''));
      if (!l) return json(res, 404, { error: 'No encontramos esa consulta.' });
      if (['aprobado', 'sin_oferta', 'revisar'].includes(l.resultado)) {
        return json(res, 200, { estado: l.resultado, bancos: l.bancos ? String(l.bancos).split('|') : [] });
      }
      const transcurrido = Date.now() - new Date(l.creado).getTime();
      let t = { estado: 'en_cola', resultados: [] };
      try {
        const r = await fetch(`${ROBOT_URL}/api/robot/resultado?id=${encodeURIComponent(l.robot_id)}`, { headers: { 'x-robot': ROBOT_CLAVE }, signal: AbortSignal.timeout(10000) });
        if (r.ok) t = await r.json();
        else if (r.status === 404) t = { estado: 'listo', resultados: [] }; // el robot se reinició: pasa a un asesor
      } catch (e) { console.log('[Robot] estado:', e.message); }
      const out = interpretar(t, transcurrido);
      if (out.estado !== 'evaluando') {
        await actualizarLead(l.id, { resultado: out.estado, bancos: (out.bancos || []).join('|'), detalle: JSON.stringify(t.resultados || []) });
        avisarWebhook('express_resultado', { id: l.id, nombre: l.nombre, telefono: l.telefono, cuit: l.cuit, resultado: out.estado, bancos: out.bancos || [], detalle: t.resultados || [] });
      }
      return json(res, 200, out);
    }

    // ----- Tutu Express: vehículo que le interesa -----
    if (req.method === 'POST' && url.pathname === '/api/express/vehiculo') {
      const b = await leerBody(req);
      const l = await leerLead(String(b.id || ''));
      if (!l) return json(res, 404, { error: 'No encontramos esa consulta.' });
      const vehiculo = limpio(b.vehiculo, 160);
      if (vehiculo.length < 2) return json(res, 400, { error: 'Contanos qué vehículo te interesa.' });
      await actualizarLead(l.id, { vehiculo });
      avisarWebhook('express_vehiculo', { id: l.id, nombre: l.nombre, telefono: l.telefono, cuit: l.cuit, resultado: l.resultado, bancos: l.bancos ? String(l.bancos).split('|') : [], vehiculo });
      return json(res, 200, { ok: true });
    }

    // ----- Mystery Box: me interesa -----
    if (req.method === 'POST' && url.pathname === '/api/mystery/interes') {
      const b = await leerBody(req);
      const dispositivo = limpio(b.dispositivo, 64);
      if (dispositivo.length < 8) return json(res, 400, { error: 'Falta el identificador.' });
      const telefono = String(b.telefono || '').replace(/\D/g, '').slice(0, 15);
      if (!pasaLimite('mb:' + ipDe(req), 20, 3600e3)) return json(res, 429, { error: 'Demasiados intentos.' });
      if (pool) {
        await pool.query(`INSERT INTO club_mystery (dispositivo, telefono) VALUES ($1, NULLIF($2,''))
          ON CONFLICT (dispositivo) DO UPDATE SET telefono = COALESCE(NULLIF($2,''), club_mystery.telefono)`, [dispositivo, telefono]);
      } else {
        const ya = mem.interes.find(x => x.dispositivo === dispositivo);
        if (ya) { if (telefono) ya.telefono = telefono; } else mem.interes.push({ dispositivo, telefono, creado: new Date().toISOString() });
        guardarArchivo();
      }
      if (telefono) avisarWebhook('mystery_avisame', { telefono });
      return json(res, 200, { ok: true, interesados: await totalInteres() });
    }

    // ----- Panel simple para ver resultados -----
    if (req.method === 'GET' && url.pathname === '/admin') {
      if (!ADMIN_CLAVE || url.searchParams.get('clave') !== ADMIN_CLAVE) { res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Agregá ?clave=TU_ADMIN_CLAVE a la dirección'); }
      const leads = pool ? (await pool.query('SELECT * FROM club_express ORDER BY creado DESC LIMIT 300')).rows : [...mem.leads].reverse();
      const interes = pool ? (await pool.query('SELECT * FROM club_mystery ORDER BY creado DESC')).rows : [...mem.interes].reverse();
      const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      const fila = l => `<tr><td>${esc(new Date(l.creado).toLocaleString('es-AR', { timeZone: 'America/Argentina/Cordoba', hour12: false }))}</td><td>${esc(l.nombre)}</td><td><a href="https://wa.me/${esc(l.telefono)}">${esc(l.telefono)}</a></td><td>${esc(l.cuit)}</td><td>${esc(l.resultado)}</td><td>${esc(String(l.bancos || '').split('|').join(', '))}</td><td>${esc(l.vehiculo)}</td></tr>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(`<!DOCTYPE html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Club Tutu+ · Panel</title>
<style>body{font:14px system-ui;margin:24px;color:#0b1f3f}h1{font-size:20px}table{border-collapse:collapse;width:100%;margin-bottom:32px}td,th{border-bottom:1px solid #e3e8f0;padding:8px;text-align:left}th{background:#f2f5fa}.n{font-size:32px;font-weight:800;color:#003685}</style>
<h1>Mystery Box</h1><p><span class="n">${interes.length}</span> interesados · ${interes.filter(i => i.telefono).length} dejaron WhatsApp</p>
<p>${interes.filter(i => i.telefono).map(i => `<a href="https://wa.me/${esc(i.telefono)}">${esc(i.telefono)}</a>`).join(' · ')}</p>
<h1>Tutu Express (${leads.length})</h1><table><tr><th>Fecha</th><th>Nombre</th><th>Teléfono</th><th>CUIT</th><th>Resultado</th><th>Bancos</th><th>Vehículo</th></tr>${leads.map(fila).join('')}</table>`);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('No encontrado');
  } catch (e) {
    console.error(e);
    json(res, 500, { error: 'Algo falló de nuestro lado. Probá de nuevo en un momento.' });
  }
});

iniciarDB().catch(e => console.log('[DB] error al iniciar:', e.message)).finally(() => {
  server.listen(PORT, () => console.log(`Club Tutu+ en http://localhost:${PORT}  ·  robot: ${ROBOT_URL || 'SIN CONFIGURAR'}`));
});
