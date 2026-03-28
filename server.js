/**
 * BONDIS Backend — server.js  v10
 * API tiempo real colectivos CABA
 *
 * Arquitectura:
 *   1. Ingesta GCBA  → fetchGCBA()    cada 30s
 *   2. Ingesta GPS   → POST /gps      desde dispositivos Teltonika
 *   3. Data Fusion   → fuseData()     combina fuentes + trust_score
 *   4. API REST      → GET /vehicles  para el frontend
 *   5. WebSocket     → ws://...       push tiempo real
 *
 * v10 cambios:
 *   - Logging diagnóstico primeros 10 vehículos GCBA (ver consola al arrancar)
 *   - parseRoute(): separa número público del ramal interno
 *   - Variables de entorno via .env para deploy en Railway/Render
 */

// Credenciales GCBA
process.env.GCBA_CLIENT_ID     = process.env.GCBA_CLIENT_ID     || '336f8aa91c004231a1232af1f24456c9';
process.env.GCBA_CLIENT_SECRET = process.env.GCBA_CLIENT_SECRET || '7c99EEC3C0F84aE598596AEd219ADd44';
process.env.PORT               = process.env.PORT               || '3000';
try { require('dotenv').config(); } catch(e) {}
const express    = require('express');
const cors       = require('cors');
const axios      = require('axios');
const { WebSocketServer } = require('ws');
const cron       = require('node-cron');
const http       = require('http');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(cors({
  origin: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : '*'
}));
app.use(express.json());

// ══════════════════════════════════════════════════════
// STORE EN MEMORIA
// ══════════════════════════════════════════════════════
const gpsStore  = new Map();
const gcbaStore = new Map();
let   fusedStore = [];

// ══════════════════════════════════════════════════════
// MAPEO NÚMEROS PÚBLICOS  ← NUEVO EN v10
//
// La API GCBA manda códigos internos: "140C", "228F-1", "622R2"
// El usuario ve en el colectivo físico solo el número: 140, 228, 622
// El ramal (C, F-1, R2) es info interna — lo mostramos como subtexto pequeño
//
// Esta función devuelve:
//   publicNumber: "140"   → número visible en el colectivo
//   branchCode:  "C"      → ramal interno (puede estar vacío)
// ══════════════════════════════════════════════════════
function parseRoute(rawId) {
  if (!rawId || rawId === '?') return { publicNumber: rawId || '?', branchCode: '' };

  const s = String(rawId).trim();

  // Casos especiales: trenes y subtes
  if (/^RTr/i.test(s)) return { publicNumber: 'Tren', branchCode: '' };
  if (/^RM/i.test(s))  return { publicNumber: 'Metro', branchCode: s.replace(/^RM/i,'').replace(/^0+/,'') };

  // Quitar ceros iniciales: "0140C" → "140C"
  const sinCeros = s.replace(/^0+(?=\d)/, '');

  // Separar número del sufijo de ramal
  // Patrones que maneja la API GCBA:
  //   "140C"   → número: 140, ramal: C
  //   "228F-1" → número: 228, ramal: F-1
  //   "622R2"  → número: 622, ramal: R2
  //   "371D"   → número: 371, ramal: D
  //   "59"     → número: 59,  ramal: (vacío)
  const match = sinCeros.match(/^(\d+)([A-Z][\w-]*)$/i);

  if (match) {
    return {
      publicNumber: match[1],
      branchCode:   match[2].toUpperCase()
    };
  }

  // Sin sufijo alfabético → ya es número público
  return { publicNumber: sinCeros || s, branchCode: '' };
}

// ══════════════════════════════════════════════════════
// LOGGING DIAGNÓSTICO  ← NUEVO EN v10
// Muestra en consola los primeros 10 vehículos de la API GCBA
// con TODOS sus campos — así sabemos exactamente qué manda la API
// Desactivar en producción poniendo GCBA_LOG_VEHICLES=false en .env
// ══════════════════════════════════════════════════════
let _diagCount = 0;
const DIAG_MAX = 10;
const DIAG_ON  = process.env.GCBA_LOG_VEHICLES !== 'false';

function logVehicleDiag(rawEntity, index) {
  if (!DIAG_ON || _diagCount >= DIAG_MAX) return;
  _diagCount++;
  console.log(`\n━━━ [GCBA RAW #${index}] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(JSON.stringify(rawEntity, null, 2));
  // Mostrar también qué parse haría parseRoute con ese campo
  const routeField = rawEntity.route_short_name || rawEntity.route_id || '?';
  const parsed = parseRoute(routeField);
  console.log(`  → route_short_name: "${rawEntity.route_short_name}" | route_id: "${rawEntity.route_id}"`);
  console.log(`  → parseRoute("${routeField}") = número: "${parsed.publicNumber}", ramal: "${parsed.branchCode}"`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}

// ══════════════════════════════════════════════════════
// 1. INGESTA GPS PROPIO
// ══════════════════════════════════════════════════════
app.post('/gps', (req, res) => {
  const { device_id, vehicle_id, id_ruta, matricula, lat, lng, bearing, speed, odometer } = req.body;

  if (!vehicle_id || !lat || !lng) {
    return res.status(400).json({ error: 'Campos requeridos: vehicle_id, lat, lng' });
  }

  const entry = {
    vehicle_id,
    id_ruta,
    matricula,
    lat:      parseFloat(lat),
    lng:      parseFloat(lng),
    bearing:  parseFloat(bearing) || 0,
    speed:    parseFloat(speed)   || 0,
    odometer: parseInt(odometer)  || 0,
    timestamp: Date.now() / 1000,
    device_id
  };

  gpsStore.set(vehicle_id, entry);
  fuseData();
  broadcastUpdate();
  res.json({ ok: true, received: entry.timestamp });
});

// ══════════════════════════════════════════════════════
// 2. INGESTA API GCBA
// ══════════════════════════════════════════════════════
async function fetchGCBA() {
  const clientId     = process.env.GCBA_CLIENT_ID;
  const clientSecret = process.env.GCBA_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.warn('[GCBA] Credenciales no configuradas — usando datos de ejemplo');
    loadGCBAMockData();
    return;
  }

  try {
    console.log('[GCBA] Consultando posiciones...');
    const url = `https://apitransporte.buenosaires.gob.ar/colectivos/vehiclePositionsSimple` +
                `?client_id=${clientId}&client_secret=${clientSecret}`;

    const response = await axios.get(url, { timeout: 10000 });
    const entities = Array.isArray(response.data) ? response.data : [];

    // Resetear contador de diagnóstico en cada fetch para loguear siempre los primeros 10
    // del PRIMER fetch (no de cada actualización — evitar spam en consola)
    // Para re-loguear: reiniciar el server

    gcbaStore.clear();
    entities.forEach((e, index) => {
      if (!e.latitude || !e.longitude) return;

      // ── LOGGING DIAGNÓSTICO ── (primeros 10 vehículos, solo primera vez)
      logVehicleDiag(e, index);

      // ── PARSEO DEL NÚMERO DE RUTA ──
      // route_short_name es el campo correcto según GTFS
      // Fallback a route_id si no viene
      const routeRaw = e.route_short_name || e.route_id || '?';
      const { publicNumber, branchCode } = parseRoute(routeRaw);

      gcbaStore.set(String(e.id), {
        vehicle_id:    String(e.id),
        id_ruta:       routeRaw,       // ID interno original (para filtros internos)
        publicNumber,                  // Número visible en el colectivo: 140, 371, 228
        branchCode,                    // Ramal interno: C, D, F-1 (para subtexto)
        matricula:     String(e.id),
        lat:           parseFloat(e.latitude),
        lng:           parseFloat(e.longitude),
        bearing:       parseFloat(e.direction) * 90 || 0,
        speed:         parseFloat(e.speed) || 0,
        timestamp:     e.timestamp || Date.now() / 1000,
        status:        parseFloat(e.speed) > 0 ? 'IN_TRANSIT_TO' : 'STOPPED_AT',
        trip_id:       e.trip_id ? String(e.trip_id) : null
      });
    });

    console.log(`[GCBA] ${gcbaStore.size} vehículos recibidos`);
    fuseData();
    broadcastUpdate();

  } catch (err) {
    console.error('[GCBA] Error al consultar API:', err.message);
  }
}

function loadGCBAMockData() {
  const mockLines = [
    { raw: '060A', pub: '60',  branch: 'A' },
    { raw: '064',  pub: '64',  branch: '' },
    { raw: '075B', pub: '75',  branch: 'B' },
    { raw: '0140C',pub: '140', branch: 'C' },
    { raw: '0168', pub: '168', branch: '' },
    { raw: '029',  pub: '29',  branch: '' },
    { raw: '039D', pub: '39',  branch: 'D' },
    { raw: '0152', pub: '152', branch: '' },
  ];
  gcbaStore.clear();
  for (let i = 0; i < 80; i++) {
    const ldef = mockLines[i % mockLines.length];
    const id   = `gcba-${ldef.raw}-${i}`;
    gcbaStore.set(id, {
      vehicle_id:   id,
      id_ruta:      ldef.raw,
      publicNumber: ldef.pub,
      branchCode:   ldef.branch,
      matricula:    `XX${100+i}YY`,
      lat:  -34.527 + Math.random() * 0.178,
      lng:  -58.532 + Math.random() * 0.200,
      bearing: Math.floor(Math.random() * 360),
      speed:   Math.random() > 0.2 ? 5 + Math.random() * 40 : 0,
      timestamp: Date.now() / 1000 - Math.random() * 60,
      status: 'IN_TRANSIT_TO'
    });
  }
  fuseData();
  broadcastUpdate();
}

// ══════════════════════════════════════════════════════
// 3. DATA FUSION ENGINE
// ══════════════════════════════════════════════════════
function fuseData() {
  const now = Date.now() / 1000;
  const GPS_TIMEOUT = parseInt(process.env.GPS_TIMEOUT) / 1000 || 120;
  const result = [];

  // GPS propio (fuente primaria)
  gpsStore.forEach((gps, id) => {
    const age   = now - gps.timestamp;
    const fresh = age < GPS_TIMEOUT;
    const trust = fresh ? Math.max(60, 100 - (age / GPS_TIMEOUT) * 40) : 20;
    const { publicNumber, branchCode } = parseRoute(gps.id_ruta);

    result.push({
      id,
      id_ruta:      gps.id_ruta,
      publicNumber,
      branchCode,
      matricula:    gps.matricula,
      posicion: {
        latitud:   gps.lat,
        longitud:  gps.lng,
        rumbo:     gps.bearing,
        velocidad: gps.speed,
        odometro:  gps.odometer
      },
      current_status: gps.speed > 2 ? 'IN_TRANSIT_TO' : 'STOPPED_AT',
      timestamp:   gps.timestamp,
      data_source: 'GPS_DIRECTO',
      trust_score: Math.round(trust),
      age_seconds: Math.round(age)
    });
  });

  // GCBA (vehículos sin GPS propio)
  gcbaStore.forEach((gcba, id) => {
    if (gpsStore.has(id)) return;
    const age   = now - gcba.timestamp;
    const trust = Math.max(20, 65 - (age / 120) * 30);

    result.push({
      id,
      id_ruta:      gcba.id_ruta,
      publicNumber: gcba.publicNumber,
      branchCode:   gcba.branchCode,
      matricula:    gcba.matricula,
      posicion: {
        latitud:   gcba.lat,
        longitud:  gcba.lng,
        rumbo:     gcba.bearing,
        velocidad: gcba.speed,
        odometro:  0
      },
      current_status: gcba.status,
      timestamp:   gcba.timestamp,
      trip_id:     gcba.trip_id || null,
      data_source: 'API_GCBA',
      trust_score: Math.round(trust),
      age_seconds: Math.round(age)
    });
  });

  // Snap-to-road: proyectar vehículos GCBA a sus shapes GTFS
  // Se activa automáticamente cuando gtfsLoaded === true (~20-30s después del arranque)
  applySnapToRoad(result);

  fusedStore = result;
  return result;
}

// ══════════════════════════════════════════════════════
// 4. API REST
// ══════════════════════════════════════════════════════
app.get('/vehicles', (req, res) => {
  const { line, source, min_trust } = req.query;
  let data = fusedStore;
  if (line)      data = data.filter(v => v.id_ruta === line || v.publicNumber === line);
  if (source)    data = data.filter(v => v.data_source === source.toUpperCase());
  if (min_trust) data = data.filter(v => v.trust_score >= parseInt(min_trust));
  res.json({
    ok: true, timestamp: Date.now() / 1000,
    total: data.length,
    gps_count: data.filter(v => v.data_source === 'GPS_DIRECTO').length,
    api_count: data.filter(v => v.data_source === 'API_GCBA').length,
    vehicles: data
  });
});

app.get('/vehicles/:id', (req, res) => {
  const vehicle = fusedStore.find(v => v.id === req.params.id);
  if (!vehicle) return res.status(404).json({ error: 'Vehículo no encontrado' });
  res.json(vehicle);
});

app.get('/lines', (req, res) => {
  const lines = {};
  fusedStore.forEach(v => {
    const key = v.publicNumber || v.id_ruta;
    if (!lines[key]) {
      lines[key] = { publicNumber: key, id_ruta: v.id_ruta, total: 0, gps: 0, api: 0, speeds: [] };
    }
    lines[key].total++;
    if (v.data_source === 'GPS_DIRECTO') lines[key].gps++;
    else lines[key].api++;
    if (v.posicion.velocidad > 0) lines[key].speeds.push(v.posicion.velocidad);
  });

  const result = Object.values(lines).map(l => {
    const avg = l.speeds.length
      ? Math.round(l.speeds.reduce((a,b) => a+b, 0) / l.speeds.length) : 0;
    delete l.speeds;
    return { ...l, avg_speed: avg };
  }).sort((a,b) => {
    const na = parseInt(a.publicNumber) || 9999;
    const nb = parseInt(b.publicNumber) || 9999;
    return na - nb;
  });

  res.json({ ok: true, lines: result });
});

app.get('/stats', (req, res) => {
  const now    = Date.now() / 1000;
  const active = fusedStore.filter(v => now - v.timestamp < 120);
  const gps    = active.filter(v => v.data_source === 'GPS_DIRECTO');
  const moving = active.filter(v => v.posicion.velocidad > 2);
  const speeds = moving.map(v => v.posicion.velocidad);
  const avgSpeed = speeds.length ? Math.round(speeds.reduce((a,b) => a+b, 0) / speeds.length) : 0;
  const avgTrust = active.length
    ? Math.round(active.reduce((a,v) => a + v.trust_score, 0) / active.length) : 0;
  res.json({
    ok: true, timestamp: now,
    total_vehicles: fusedStore.length,
    active_vehicles: active.length,
    gps_direct: gps.length,
    api_gcba: active.length - gps.length,
    offline: fusedStore.length - active.length,
    moving: moving.length,
    stopped: active.length - moving.length,
    avg_speed_kmh: avgSpeed,
    avg_trust_score: avgTrust,
    lines_active: new Set(active.map(v => v.publicNumber || v.id_ruta)).size,
    gps_coverage_pct: active.length ? Math.round((gps.length / active.length) * 100) : 0
  });
});

// Servir frontend
const path = require('path');
app.get('/', (req, res) => {
  // Servir v12, fallback a v9
  const v12 = path.join(__dirname, 'bondis-mvp-v12.html');
  const v9  = path.join(__dirname, 'bondis-mvp-v9.html');
  const fs  = require('fs');
  res.sendFile(fs.existsSync(v12) ? v12 : v9);
});
app.get('/bondis', (req, res) => res.redirect('/'));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    vehicles: fusedStore.length,
    timestamp: Date.now()
  });
});

// ══════════════════════════════════════════════════════
// 5. WEBSOCKET
// ══════════════════════════════════════════════════════
wss.on('connection', (ws) => {
  console.log(`[WS] Cliente conectado. Total: ${wss.clients.size}`);
  ws.send(JSON.stringify({
    type: 'snapshot',
    timestamp: Date.now() / 1000,
    vehicles: fusedStore
  }));

  ws.on('message', (msg) => {
    try {
      const { type, payload } = JSON.parse(msg);
      if (type === 'subscribe_line') {
        ws.subscribedLine = payload.line;
      }
    } catch(e) {}
  });

  ws.on('close', () => {
    console.log(`[WS] Cliente desconectado. Total: ${wss.clients.size}`);
  });
});

function broadcastUpdate() {
  if (wss.clients.size === 0) return;
  wss.clients.forEach(ws => {
    if (ws.readyState !== 1) return;
    const data = ws.subscribedLine
      ? fusedStore.filter(v => v.id_ruta === ws.subscribedLine || v.publicNumber === ws.subscribedLine)
      : fusedStore;
    ws.send(JSON.stringify({
      type: 'update',
      timestamp: Date.now() / 1000,
      total: data.length,
      vehicles: data
    }));
  });
}

// ══════════════════════════════════════════════════════
// MÓDULO PARADAS — GTFS ESTÁTICO (sin cambios respecto v9)
// ══════════════════════════════════════════════════════
const https    = require('https');
const fs       = require('fs');
const { execSync } = require('child_process');

let stopsStore     = new Map();
let stopTimesStore = new Map();
let gtfsLoaded     = false;

const shapeStore   = new Map();
const tripShapeMap = new Map();
const stopShapes   = new Map();
const routeShapes  = new Map();
const SHAPE_STOP_RADIUS_M = 40;

async function loadGTFS() {
  const clientId     = process.env.GCBA_CLIENT_ID;
  const clientSecret = process.env.GCBA_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.warn('[GTFS] Sin credenciales — paradas no disponibles');
    return;
  }
  try {
    const gtfsDir = path.join(__dirname, 'gtfs');
    const routesFile = path.join(gtfsDir, 'routes.txt');

    // Si ya existe la carpeta gtfs con routes.txt, usar los archivos locales directamente
    if (fs.existsSync(routesFile)) {
      console.log('[GTFS] Usando archivos locales existentes...');
    } else {
      console.log('[GTFS] Descargando feed de paradas...');
      const url     = `https://apitransporte.buenosaires.gob.ar/colectivos/feed-gtfs?client_id=${clientId}&client_secret=${clientSecret}`;
      const zipPath = path.join(__dirname, 'gtfs.zip');
      await downloadFile(url, zipPath);
      if (!fs.existsSync(gtfsDir)) fs.mkdirSync(gtfsDir);
      try {
        execSync(`powershell -command "Expand-Archive -Force '${zipPath}' '${gtfsDir}'"`, { timeout: 30000 });
      } catch(e) {
        execSync(`tar -xf "${zipPath}" -C "${gtfsDir}"`, { timeout: 30000 });
      }
    }
    // Cargar routes.txt primero para mapear route_id → route_short_name
    if (fs.existsSync(routesFile)) {
      await parseFileLines(routesFile, parseRouteLine, true);
      console.log(`[GTFS] ${routeIdToName.size} rutas mapeadas (routes.txt)`);
    }
    const tripsFile = path.join(gtfsDir, 'trips.txt');
    if (fs.existsSync(tripsFile)) {
      await parseFileLines(tripsFile, parseTripLine, true);
      console.log(`[GTFS] ${tripRouteMap.size} trips mapeados`);
    }
    const stopsFile = path.join(gtfsDir, 'stops.txt');
    if (fs.existsSync(stopsFile)) {
      await parseFileLines(stopsFile, parseStopLine, true);
      console.log(`[GTFS] ${stopsStore.size} paradas cargadas`);
    }
    const shapesFile = path.join(gtfsDir, 'shapes.txt');
    if (fs.existsSync(shapesFile)) {
      console.log('[GTFS] Cargando shapes.txt...');
      await parseFileLines(shapesFile, parseShapeLine, true);
      console.log(`[GTFS] ${shapeStore.size} shapes cargados`);
    }
    tripShapeMap.forEach((shapeId, tripId) => {
      const routeId = tripRouteMap.get(tripId);
      if (!routeId || routeId === '?') return;
      // Preferir route_short_name del routes.txt; si no existe usar el routeId directamente
      const routeName = routeIdToName.get(routeId) || routeId;
      const { publicNumber } = parseRoute(routeName);
      if (!routeShapes.has(publicNumber)) routeShapes.set(publicNumber, new Set());
      routeShapes.get(publicNumber).add(shapeId);
    });
    console.log('[GTFS] Indexando shapes por parada...');
    buildStopShapesIndex();
    gtfsLoaded = true;
    console.log(`[GTFS] ✅ ${stopsStore.size} paradas listas`);
  } catch(err) {
    console.error('[GTFS] Error:', err.message);
  }
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, res => {
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', err => { fs.unlink(dest, () => {}); reject(err); });
  });
}

function parseFileLines(filePath, lineHandler, skipHeader) {
  return new Promise((resolve, reject) => {
    const readline = require('readline');
    const stream   = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl       = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let headers = null, first = true;
    rl.on('line', line => {
      if (!line.trim()) return;
      if (first) { headers = line.split(',').map(h => h.trim().replace(/"/g,'')); first = false; return; }
      lineHandler(line, headers);
    });
    rl.on('close', resolve);
    rl.on('error', reject);
    stream.on('error', reject);
  });
}

const tripRouteMap  = new Map();
const routeIdToName = new Map(); // route_id numerico → route_short_name (ej: "6030" → "184")

function parseRouteLine(line, headers) {
  const cols      = line.split(',').map(c => c.trim().replace(/"/g,''));
  const routeId   = cols[headers.indexOf('route_id')];
  const shortName = cols[headers.indexOf('route_short_name')] || '';
  if (routeId && shortName) routeIdToName.set(routeId, shortName);
}

function parseTripLine(line, headers) {
  const cols     = line.split(',').map(c => c.trim().replace(/"/g,''));
  const idxTrip  = headers.indexOf('trip_id');
  const idxRoute = headers.indexOf('route_id'); // siempre usar route_id del trip
  const idxShape = headers.indexOf('shape_id');
  const tripId   = cols[idxTrip];
  if (!tripId) return;
  tripRouteMap.set(tripId, cols[idxRoute] || '?');
  if (idxShape >= 0 && cols[idxShape]) tripShapeMap.set(tripId, cols[idxShape]);
}

function parseShapeLine(line, headers) {
  const cols    = line.split(',').map(c => c.trim().replace(/"/g,''));
  const shapeId = cols[headers.indexOf('shape_id')];
  const lat     = parseFloat(cols[headers.indexOf('shape_pt_lat')]);
  const lng     = parseFloat(cols[headers.indexOf('shape_pt_lon')]);
  if (!shapeId || isNaN(lat) || isNaN(lng)) return;
  if (!shapeStore.has(shapeId)) shapeStore.set(shapeId, []);
  shapeStore.get(shapeId).push({ lat, lng });
}

function buildStopShapesIndex() {
  const SAMPLE = 3;
  shapeStore.forEach((points, shapeId) => {
    for (let i = 0; i < points.length; i += SAMPLE) {
      const pt = points[i];
      stopsStore.forEach((stop, stopId) => {
        if (Math.abs(pt.lat - stop.lat) > 0.002 || Math.abs(pt.lng - stop.lng) > 0.003) return;
        const dist = haversine(pt.lat, pt.lng, stop.lat, stop.lng);
        if (dist <= SHAPE_STOP_RADIUS_M) {
          if (!stopShapes.has(stopId)) stopShapes.set(stopId, new Set());
          stopShapes.get(stopId).add(shapeId);
        }
      });
    }
  });
}

function parseStopLine(line, headers) {
  const cols = line.split(',').map(c => c.trim().replace(/"/g,''));
  const lat  = parseFloat(cols[headers.indexOf('stop_lat')]);
  const lng  = parseFloat(cols[headers.indexOf('stop_lon')]);
  if (!lat || !lng) return;
  stopsStore.set(cols[headers.indexOf('stop_id')], {
    stop_id: cols[headers.indexOf('stop_id')],
    name:    cols[headers.indexOf('stop_name')] || cols[headers.indexOf('stop_id')],
    lat, lng, lines: new Set()
  });
}

app.get('/stops', (req, res) => {
  if (!gtfsLoaded) return res.json({ ok: false, error: 'GTFS no cargado aún', stops: [] });
  const lat    = parseFloat(req.query.lat);
  const lng    = parseFloat(req.query.lng);
  const radius = parseFloat(req.query.radius) || 400;
  if (!lat || !lng) return res.status(400).json({ error: 'lat y lng requeridos' });

  const nearby = [];
  stopsStore.forEach(stop => {
    const dist = haversine(lat, lng, stop.lat, stop.lng);
    if (dist <= radius) {
      nearby.push({
        stop_id: stop.stop_id, name: stop.name,
        lat: stop.lat, lng: stop.lng,
        distance: Math.round(dist),
        lines: [...stop.lines].filter(l => l !== '?').sort()
      });
    }
  });

  nearby.forEach(stop => {
    if (stop.lines.length === 0 && stopShapes.has(stop.stop_id)) {
      const shapesHere = stopShapes.get(stop.stop_id);
      routeShapes.forEach((shapeIds, route) => {
        for (const sid of shapeIds) {
          if (shapesHere.has(sid)) { stop.lines.push(route); break; }
        }
      });
      stop.lines = [...new Set(stop.lines)].sort();
    }
  });

  nearby.sort((a,b) => a.distance - b.distance);
  res.json({ ok: true, total: nearby.length, stops: nearby.slice(0, 20) });
});

app.get('/eta', (req, res) => {
  const { stop_id } = req.query;
  if (!stop_id) return res.status(400).json({ error: 'stop_id requerido' });
  const stop = stopsStore.get(stop_id);
  if (!stop) return res.status(404).json({ error: 'Parada no encontrada' });

  const now    = Date.now() / 1000;
  const active = fusedStore.filter(v => now - v.timestamp < 180);
  const ETA_RADIUS = 2000;
  const byLine = new Map();

  // Filtrar por GTFS: solo líneas que realmente pasan por esta parada
  let allowedLines = null;
  if (gtfsLoaded && stopShapes.has(stop_id)) {
    const shapesEnParada = stopShapes.get(stop_id);
    allowedLines = new Set();
    routeShapes.forEach((shapeIds, pubNum) => {
      for (const sid of shapeIds) {
        if (shapesEnParada.has(sid)) { allowedLines.add(pubNum); break; }
      }
    });
    console.log('[ETA] Parada ' + stop_id + ': ' + allowedLines.size + ' lineas GTFS -> ' + [...allowedLines].slice(0,10).join(', '));
  }

  active.forEach(v => {
    const dist = haversine(stop.lat, stop.lng, v.posicion.latitud, v.posicion.longitud);
    if (dist > ETA_RADIUS) return;
    const lineKey = v.publicNumber || v.id_ruta;
    // Si hay indice GTFS, filtrar solo lineas que pasan por esta parada
    if (allowedLines && !allowedLines.has(lineKey)) return;
    if (!byLine.has(lineKey)) byLine.set(lineKey, []);
    byLine.get(lineKey).push({ v, dist });
  });

  const etas = [];
  byLine.forEach((vehicles, line) => {
    vehicles.sort((a,b) => a.dist - b.dist);
    const { v, dist: minDist } = vehicles[0];
    const speed      = v.posicion.velocidad > 3 ? v.posicion.velocidad : 12;
    const etaMinutes = Math.round((minDist / 1000) / speed * 60);
    etas.push({
      line,
      branchCode:   v.branchCode || '',
      vehicle_id:   v.id,
      distance_m:   Math.round(minDist),
      eta_minutes:  etaMinutes,
      speed_kmh:    Math.round(speed),
      data_source:  v.data_source,
      trust_score:  v.trust_score
    });
  });

  etas.sort((a,b) => a.eta_minutes - b.eta_minutes);
  res.json({
    ok: true, stop_id,
    stop_name: stop.name,
    lat: stop.lat, lng: stop.lng,
    gtfs_filter: allowedLines ? 'activo' : 'fallback_radio',
    etas: etas.slice(0, 10)
  });
});


function haversine(lat1, lng1, lat2, lng2) {
  const R    = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a    = Math.sin(dLat/2)**2 +
               Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ══════════════════════════════════════════════════════
// SNAP-TO-ROAD — proyección GPS → shape GTFS
//
// Usa shapeStore y tripShapeMap que YA están en memoria.
// Se aplica en fuseData() solo cuando gtfsLoaded === true.
// Costo: $0 | Latencia: ~0.01ms por vehículo
// ══════════════════════════════════════════════════════

const SNAP_MAX_DIST_M  = 120;   // umbral máximo para aceptar snap (metros)
const SNAP_WINDOW      = 8;     // segmentos adyacentes a evaluar alrededor del punto más cercano

/**
 * Proyecta el punto P al segmento AB en coordenadas lat/lon.
 * Trabaja en espacio local (metros) para proyección lineal correcta.
 * Devuelve { lat, lon, dist } — el punto más cercano sobre el segmento.
 */
function projectToSegment(pLat, pLng, aLat, aLng, bLat, bLng) {
  const cosLat = Math.cos(pLat * Math.PI / 180);
  const abX = (bLng - aLng) * cosLat * 111320;
  const abY = (bLat - aLat) * 111320;
  const apX = (pLng - aLng) * cosLat * 111320;
  const apY = (pLat - aLat) * 111320;
  const ab2 = abX * abX + abY * abY;
  if (ab2 === 0) return { lat: aLat, lng: aLng, dist: haversine(pLat, pLng, aLat, aLng) };
  const t    = Math.max(0, Math.min(1, (apX * abX + apY * abY) / ab2));
  const pjLat = aLat + t * (bLat - aLat);
  const pjLng = aLng + t * (bLng - aLng);
  return { lat: pjLat, lng: pjLng, dist: haversine(pLat, pLng, pjLat, pjLng) };
}

/**
 * Snappea un punto GPS a su shape GTFS.
 * Devuelve { lat, lng, snapped, snapDist } — coords corregidas + metadata.
 */
function snapToShape(rawLat, rawLng, tripId) {
  if (!gtfsLoaded || !tripId) return { lat: rawLat, lng: rawLng, snapped: false };

  const shapeId = tripShapeMap.get(tripId);
  if (!shapeId) return { lat: rawLat, lng: rawLng, snapped: false };

  const shape = shapeStore.get(shapeId);
  if (!shape || shape.length < 2) return { lat: rawLat, lng: rawLng, snapped: false };

  // Paso 1: encontrar el punto más cercano del shape para acotar la búsqueda
  let nearestIdx  = 0;
  let nearestDist = Infinity;
  for (let i = 0; i < shape.length; i++) {
    const d = haversine(rawLat, rawLng, shape[i].lat, shape[i].lng);
    if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
  }

  // Rechazo rápido: si el punto más cercano del shape está muy lejos, no hacer snap
  // (trip_id incorrecto, colectivo fuera de servicio, etc.)
  if (nearestDist > SNAP_MAX_DIST_M * 2.5) {
    return { lat: rawLat, lng: rawLng, snapped: false };
  }

  // Paso 2: evaluar segmentos en la ventana alrededor del punto más cercano
  const start = Math.max(0, nearestIdx - SNAP_WINDOW);
  const end   = Math.min(shape.length - 2, nearestIdx + SNAP_WINDOW);

  let bestDist = Infinity;
  let bestLat  = rawLat;
  let bestLng  = rawLng;

  for (let i = start; i <= end; i++) {
    const proj = projectToSegment(
      rawLat, rawLng,
      shape[i].lat, shape[i].lng,
      shape[i + 1].lat, shape[i + 1].lng
    );
    if (proj.dist < bestDist) {
      bestDist = proj.dist;
      bestLat  = proj.lat;
      bestLng  = proj.lng;
    }
  }

  if (bestDist > SNAP_MAX_DIST_M) {
    return { lat: rawLat, lng: rawLng, snapped: false };
  }

  return { lat: bestLat, lng: bestLng, snapped: true, snapDist: Math.round(bestDist) };
}

// Contador de diagnóstico snap (log cada 20 ciclos)
let _snapCycle = 0;

/**
 * Aplica snap-to-road a todos los vehículos de una lista fused.
 * Modifica posicion.latitud / posicion.longitud en los vehículos de la API GCBA.
 */
function applySnapToRoad(fusedList) {
  if (!gtfsLoaded) return fusedList;

  let snapped = 0, skipped = 0, noTrip = 0;

  fusedList.forEach(v => {
    // Solo API GCBA — los GPS propios ya son precisos
    if (v.data_source !== 'API_GCBA') return;
    if (!v.trip_id) { noTrip++; return; }

    const result = snapToShape(v.posicion.latitud, v.posicion.longitud, v.trip_id);

    if (result.snapped) {
      v.posicion.latitud  = result.lat;
      v.posicion.longitud = result.lng;
      v._snapDist = result.snapDist;
      snapped++;
    } else {
      skipped++;
    }
  });

  _snapCycle++;
  if (_snapCycle % 20 === 1) {
    const total = snapped + skipped + noTrip;
    console.log(`[Snap] ${snapped}/${total} snapped | ${noTrip} sin trip_id | ${skipped} descartados`);
  }

  return fusedList;
}

// ══════════════════════════════════════════════════════
// SCHEDULER
// ══════════════════════════════════════════════════════
cron.schedule('*/30 * * * * *', () => { fetchGCBA(); });

cron.schedule('0 4 * * *', () => {
  console.log('[GTFS] Recarga diaria...');
  stopsStore.clear(); stopTimesStore.clear(); tripRouteMap.clear(); routeIdToName.clear();
  tripShapeMap.clear(); shapeStore.clear(); stopShapes.clear();
  routeShapes.clear(); gtfsLoaded = false;
  loadGTFS();
});

// ══════════════════════════════════════════════════════
// ARRANQUE
// ══════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('');
  console.log('🚌  BONDIS Backend v10 arrancado');
  console.log(`    REST  →  http://localhost:${PORT}`);
  console.log(`    WS    →  ws://localhost:${PORT}`);
  console.log('');
  console.log('    Endpoints:');
  console.log(`    GET /vehicles   GET /lines   GET /stats   GET /health`);
  console.log(`    GET /stops      GET /eta     POST /gps`);
  console.log('');
  console.log('    [DIAG] Logging primeros 10 vehículos GCBA activo.');
  console.log('    [DIAG] Para desactivar: agregar GCBA_LOG_VEHICLES=false en .env');
  console.log('');

  fetchGCBA();
  loadGTFS();
});
