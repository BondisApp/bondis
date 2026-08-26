// ══════════════════════════════════════════════════════
// MAPEO NÚMEROS PÚBLICOS
//
// La API GCBA (y también OpenStreetMap) manda códigos como: "140C",
// "228F-1", "622R2", o incluso texto pegado: "101 Barrio Samoré".
// El usuario ve en el colectivo físico solo el número: 140, 228, 622.
// El ramal (C, F-1, R2) o lo que venga después es info interna — se
// muestra como subtexto pequeño.
//
// Compartido entre server.js y scripts/fetch-osm-routes.js para no
// duplicar esta lógica.
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

  // El número público es SIEMPRE el entero inicial (lo único que el vecino
  // ve pintado en el colectivo); todo lo que sigue —letra de ramal o texto
  // descriptivo— se guarda como ramal/subtítulo chico.
  //   "140C"              → número: 140,  ramal: C
  //   "228F-1"            → número: 228,  ramal: F-1
  //   "101 Barrio Samoré" → número: 101,  ramal: BARRIO SAMOR (recortado)
  //   "9 1"               → número: 9,    ramal: 1
  //   "59"                → número: 59,   ramal: (vacío)
  const match = sinCeros.match(/^(\d+)\s*(.*)$/);

  if (match) {
    return {
      publicNumber: match[1],
      branchCode:   match[2].trim().toUpperCase().slice(0, 12)
    };
  }

  // No arranca con número (código raro tipo "R333/9") → mostrar tal cual
  return { publicNumber: sinCeros || s, branchCode: '' };
}

module.exports = { parseRoute };
