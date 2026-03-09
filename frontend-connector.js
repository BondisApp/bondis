/**
 * BONDIS Frontend Connector
 * Reemplaza el simulador en bondis-mvp.html por conexión real al backend
 *
 * USO: Copiar este bloque dentro del <script> de bondis-mvp.html,
 * reemplazando la sección "SIMULACIÓN DE MOVIMIENTO"
 */

// ── CONFIGURACIÓN ────────────────────────────────────
const BACKEND_URL = 'http://localhost:3000';   // Cambiar en producción
const WS_URL      = 'ws://localhost:3000';

// ── CONEXIÓN WEBSOCKET ───────────────────────────────
let ws;
let wsReconnectTimer;

function connectWebSocket() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log('[WS] Conectado al backend BONDIS');
    document.getElementById('api-badge').innerHTML =
      '<div class="api-dot"></div> BONDIS Backend · conectado';

    // Suscribirse a línea específica si hay filtro activo
    if (activeFilter !== 'ALL') {
      ws.send(JSON.stringify({ type: 'subscribe_line', payload: { line: activeFilter } }));
    }
  };

  ws.onmessage = (event) => {
    const { type, vehicles: data, timestamp } = JSON.parse(event.data);

    if (type === 'snapshot' || type === 'update') {
      // Transformar formato backend → formato frontend
      vehicles = data.map(v => ({
        id:          v.id,
        id_ruta:     v.id_ruta,
        matricula:   v.matricula,
        posicion: {
          latitud:   v.posicion.latitud,
          longitud:  v.posicion.longitud,
          rumbo:     v.posicion.rumbo,
          velocidad: v.posicion.velocidad,
        },
        current_status: v.current_status,
        timestamp:   v.timestamp,
        data_source: v.data_source,
        trust_score: v.trust_score,
      }));

      updateMap();

      // Reiniciar barra de progreso
      const bar = document.getElementById('refresh-progress');
      bar.style.animation = 'none';
      bar.offsetHeight; // reflow
      bar.style.animation = 'refreshAnim 30s linear';
    }
  };

  ws.onclose = () => {
    console.warn('[WS] Desconectado. Reintentando en 5s...');
    document.getElementById('api-badge').innerHTML =
      '<div class="api-dot" style="background:#ff3d00;animation:none"></div> Backend · desconectado';

    wsReconnectTimer = setTimeout(connectWebSocket, 5000);
  };

  ws.onerror = (err) => {
    console.error('[WS] Error:', err);
  };
}

// ── FALLBACK: si no hay backend, usar REST polling ────
async function pollREST() {
  try {
    const res  = await fetch(`${BACKEND_URL}/vehicles`);
    const data = await res.json();
    vehicles   = data.vehicles.map(v => ({
      id:          v.id,
      id_ruta:     v.id_ruta,
      matricula:   v.matricula,
      posicion: {
        latitud:   v.posicion.latitud,
        longitud:  v.posicion.longitud,
        rumbo:     v.posicion.rumbo,
        velocidad: v.posicion.velocidad,
      },
      current_status: v.current_status,
      timestamp:   v.timestamp,
      data_source: v.data_source,
      trust_score: v.trust_score,
    }));
    updateMap();
  } catch(e) {
    console.warn('[REST] No se pudo conectar al backend');
  }
}

// ── ARRANQUE ─────────────────────────────────────────
// Intentar WebSocket primero, fallback a REST cada 30s
connectWebSocket();
setInterval(updateClock, 1000);

// Fallback REST por si el WebSocket falla
setInterval(() => {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    pollREST();
  }
}, 30000);
