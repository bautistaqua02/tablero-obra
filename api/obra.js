const SMARTSHEET_BASE = 'https://api.smartsheet.com/2.0';

export default async function handler(req, res) {
  /* CORS */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Falta el parámetro id' });

  const TOKEN = process.env.SMARTSHEET_TOKEN;
  if (!TOKEN) return res.status(500).json({ error: 'SMARTSHEET_TOKEN no configurado' });

  try {
    const url = `${SMARTSHEET_BASE}/sheets/${id}?include=rowPermalink&level=2`;
    const smRes = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    if (!smRes.ok) {
      const err = await smRes.json().catch(() => ({}));
      return res.status(smRes.status).json({
        error: `Smartsheet respondió ${smRes.status}: ${err.message || 'error'}`
      });
    }

    const sheet = await smRes.json();

    /* Mapear columnas */
    const colMap = {};
    (sheet.columns || []).forEach(c => {
      colMap[c.title.toLowerCase().trim()] = c.id;
    });

    const COL = {
      nombre: colId(colMap, 'nombre de la tarea','tarea','nombre','task name','actividad','name'),
      inicio: colId(colMap, 'fecha inicio','inicio','start','fecha de inicio'),
      fin: colId(colMap, 'fecha final','fin','finish','end','fecha de fin'),
      pct: colId(colMap, '% completo','% completado','% complete','porcentaje','avance','percent complete'),
      baseStart: colId(colMap, 'comienzo de línea de base','baseline start','inicio base'),
      baseFinish: colId(colMap, 'fin de línea de base','baseline finish','fin base'),
    };

    /* Parsear filas */
    const tareas = [];
    (sheet.rows || []).forEach(row => {
      const get = (colId) => {
        if (!colId) return null;
        const cell = (row.cells || []).find(c => c.columnId === colId);
        return cell ? (cell.displayValue ?? cell.value ?? null) : null;
      };

      const nombre = get(COL.nombre);
      const inicio = get(COL.inicio);
      const fin = get(COL.fin);
      const pct = parseFloat(get(COL.pct)) || 0;

      if (!nombre || !inicio || !fin) return;

      tareas.push({
        id: row.id,
        nivel: row.indent || 1,
        nombre,
        inicio,
        fin,
        pct: Math.round(pct),
        baseStart: get(COL.baseStart) || inicio,
        baseFinish: get(COL.baseFinish) || fin,
        completada: pct >= 100,
        esPadre: row.hasChildren || false,
      });
    });

    /* Resumen */
    const avanceGeneral = tareas.length
      ? Math.round(tareas.reduce((s, t) => s + t.pct, 0) / tareas.length)
      : 0;

    const todasFechas = tareas.flatMap(t => [t.inicio, t.fin]).filter(Boolean).sort();

    const resumen = {
      nombre: sheet.name,
      avance: avanceGeneral,
      fechaInicio: todasFechas[0] || null,
      fechaFin: todasFechas[todasFechas.length - 1] || null,
      totalTareas: tareas.length,
      completadas: tareas.filter(t => t.completada).length,
    };

    return res.status(200).json({ resumen, tareas, columnas: Object.keys(colMap) });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

function colId(map, ...nombres) {
  for (const n of nombres) {
    if (map[n]) return map[n];
  }
  return null;
}
