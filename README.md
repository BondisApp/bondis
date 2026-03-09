# BONDIS Backend

API en tiempo real para posiciones de colectivos en CABA.

## Instalación

```bash
git clone https://github.com/tuusuario/bondis-backend
cd bondis-backend
npm install
cp .env.example .env
# Editá .env con tus credenciales GCBA
node server.js
```

## Endpoints

| Método | URL | Descripción |
|--------|-----|-------------|
| GET | /vehicles | Todos los vehículos (GPS + GCBA fusionados) |
| GET | /vehicles/:id | Detalle de un vehículo |
| GET | /lines | Resumen por línea |
| GET | /stats | Métricas globales |
| GET | /health | Healthcheck |
| POST | /gps | Ingesta GPS propio (Teltonika) |

### Filtros en /vehicles

```
GET /vehicles?line=60
GET /vehicles?source=GPS_DIRECTO
GET /vehicles?min_trust=80
GET /vehicles?line=152&min_trust=70
```

## WebSocket

```javascript
const ws = new WebSocket('ws://localhost:3000');

// Recibir actualizaciones
ws.onmessage = (e) => {
  const { type, vehicles } = JSON.parse(e.data);
  // type: 'snapshot' (primera vez) | 'update' (cada refresh)
};

// Suscribirse a una línea
ws.send(JSON.stringify({ type: 'subscribe_line', payload: { line: '60' } }));
```

## Ingesta GPS propio (Teltonika FMB920)

```bash
curl -X POST http://localhost:3000/gps \
  -H "Content-Type: application/json" \
  -d '{
    "device_id": "TEL-001",
    "vehicle_id": "60-001",
    "id_ruta": "60",
    "matricula": "AB123CD",
    "lat": -34.6037,
    "lng": -58.3816,
    "bearing": 90,
    "speed": 32,
    "odometer": 245000
  }'
```

## Deploy en producción

### Railway (recomendado para MVP)
```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

### Variables de entorno en producción
```
GCBA_CLIENT_ID=...
GCBA_CLIENT_SECRET=...
PORT=3000
NODE_ENV=production
ALLOWED_ORIGINS=https://bondis.com.ar
```
