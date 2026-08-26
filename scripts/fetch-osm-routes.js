/**
 * Descarga los recorridos reales de las líneas de colectivos de CABA/AMBA
 * desde OpenStreetMap (API pública "Overpass") y los guarda en
 * osm-routes.json, en el mismo formato que server.js espera para usarlos
 * como "shapes" adicionales en el snap-to-road.
 *
 * Por qué: el GTFS oficial de GCBA está congelado desde 2019/2021 y el
 * propio gobierno lo tiene marcado como "suspendido, en revisión". OSM es
 * mantenido por la comunidad y está mucho más al día (confirmado: incluye
 * medios de pago como Mercado Pago QR que no existían en 2021).
 *
 * Uso: node scripts/fetch-osm-routes.js
 * Se puede volver a correr cuando se quiera refrescar (pensado para hacerlo
 * cada ~15 días, junto con el chequeo del GTFS).
 */
const fs = require('fs');
const path = require('path');
const { haversine } = require('../lib/geo');
const { parseRoute } = require('../lib/parseRoute');

// Caja que cubre CABA + la mayoría de AMBA (Gran Buenos Aires)
const BBOX = { south: -35.05, west: -59.30, north: -34.30, east: -58.00 };

// overpass.kumi.systems no es alcanzable desde algunos entornos (timeout de
// conexión) — se prueba solo, sin mirror alternativo, con reintentos pacientes.
const OVERPASS_URL    = 'https://overpass-api.de/api/interpreter';
const BATCH_SIZE      = 50;   // relaciones por consulta de geometría
const BATCH_DELAY_MS  = 6000; // pausa entre tandas — buena práctica con un server público gratuito
const OUT_FILE         = path.join(__dirname, '..', 'osm-routes.json');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function overpassQuery(query, attempt = 1) {
  let text;
  try {
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': '*/*',
        'User-Agent': 'BondisApp-RouteRefresh/1.0 (contacto: consulting.whl@gmail.com)'
      },
      body: 'data=' + encodeURIComponent(query)
    });
    text = await res.text();
    if (!res.ok || text.trim().startsWith('<?xml') || text.trim().startsWith('<!DOCTYPE')) {
      throw new Error(`respuesta no válida (HTTP ${res.status})`);
    }
  } catch (err) {
    if (attempt < 4) {
      console.log(`  [Overpass] ${err.message} (intento ${attempt}), reintentando en 10s...`);
      await sleep(10000);
      return overpassQuery(query, attempt + 1);
    }
    throw new Error('Overpass no respondió correctamente tras varios intentos: ' + err.message);
  }
  return JSON.parse(text);
}

// Cose los "ways" (tramos de calle) de una relación en el orden en que
// aparecen sus miembros, respetando la dirección real del recorrido.
// Cada way puede estar digitalizado en cualquier sentido en OSM, así que
// se elige el extremo que mejor conecta con el tramo anterior.
function stitchRoute(relation, wayGeomById) {
  const wayMembers = relation.members.filter(m =>
    m.type === 'way' && m.role !== 'platform' && m.role !== 'stop'
  );

  let path = [];
  for (const m of wayMembers) {
    const geom = wayGeomById.get(m.ref);
    if (!geom || geom.length === 0) continue;

    if (path.length === 0) {
      path = geom.slice();
      continue;
    }

    const last = path[path.length - 1];
    const distToStart = haversine(last.lat, last.lon, geom[0].lat, geom[0].lon);
    const distToEnd    = haversine(last.lat, last.lon, geom[geom.length - 1].lat, geom[geom.length - 1].lon);

    if (distToEnd < distToStart) {
      path = path.concat(geom.slice().reverse());
    } else {
      path = path.concat(geom);
    }
  }
  return path;
}

async function main() {
  // Reanudable: si ya hay un osm-routes.json de una corrida anterior (por
  // ej. si el server público cortó pedidos a mitad de camino), se arranca
  // desde ahí y solo se piden las líneas que todavía faltan.
  const routes = [];
  const already = new Set();
  if (fs.existsSync(OUT_FILE)) {
    try {
      const prev = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
      (prev.routes || []).forEach(r => { routes.push(r); already.add(r.osmId); });
      console.log(`[OSM] Retomando corrida anterior: ${routes.length} recorridos ya guardados`);
    } catch (e) { /* archivo corrupto o vacío — arrancar de cero */ }
  }

  console.log('[OSM] Buscando relaciones route=bus en CABA/AMBA...');
  const tagsQuery = `[out:json][timeout:60];
relation["route"="bus"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
out tags;`;
  const tagsResult = await overpassQuery(tagsQuery);
  const relationsMeta = tagsResult.elements.filter(e => e.tags && e.tags.ref);
  const metaById = new Map(relationsMeta.map(m => [m.id, m]));
  console.log(`[OSM] ${relationsMeta.length} relaciones con ref válido (de ${tagsResult.elements.length} totales)`);

  const ids = relationsMeta.map(r => r.id).filter(id => !already.has(id));
  console.log(`[OSM] ${ids.length} relaciones pendientes de descargar`);

  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batchIds = ids.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(ids.length / BATCH_SIZE);
    console.log(`[OSM] Tanda ${batchNum}/${totalBatches} (${batchIds.length} líneas)...`);

    const geomQuery = `[out:json][timeout:90];
relation(id:${batchIds.join(',')});
(._;>;);
out geom;`;

    let result;
    try {
      result = await overpassQuery(geomQuery);
    } catch (e) {
      console.warn(`  [OSM] Tanda ${batchNum} falló, se omite (se puede reintentar corriendo el script de nuevo): ${e.message}`);
      await sleep(BATCH_DELAY_MS);
      continue;
    }

    const wayGeomById = new Map();
    result.elements.filter(e => e.type === 'way').forEach(w => {
      wayGeomById.set(w.id, w.geometry || []);
    });

    result.elements.filter(e => e.type === 'relation').forEach(rel => {
      const meta = metaById.get(rel.id);
      if (!meta) return;
      const points = stitchRoute(rel, wayGeomById);
      if (points.length < 2) return;

      const { publicNumber, branchCode } = parseRoute(meta.tags.ref);
      routes.push({
        osmId: rel.id,
        publicNumber,
        branchCode,
        name: meta.tags.name || '',
        points: points.map(p => [
          Math.round(p.lat * 1e6) / 1e6,
          Math.round(p.lon * 1e6) / 1e6
        ])
      });
    });

    // Guardar progreso después de cada tanda — si el server público corta
    // los pedidos a mitad de camino (pasó hoy), no se pierde lo ya bajado.
    saveOutput(routes);

    if (i + BATCH_SIZE < ids.length) await sleep(BATCH_DELAY_MS);
  }

  saveOutput(routes);
  const sizeMB = (fs.statSync(OUT_FILE).size / 1024 / 1024).toFixed(1);
  console.log(`[OSM] Listo: ${routes.length} recorridos guardados en ${OUT_FILE} (${sizeMB} MB)`);
}

function saveOutput(routes) {
  const output = {
    generatedAt: new Date().toISOString(),
    source: 'OpenStreetMap (Overpass API) — © OpenStreetMap contributors, datos bajo licencia ODbL',
    bbox: BBOX,
    totalRoutes: routes.length,
    routes
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(output));
}

main().catch(err => {
  console.error('[OSM] Error fatal:', err);
  process.exit(1);
});
