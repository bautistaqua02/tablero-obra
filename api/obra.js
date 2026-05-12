const SMARTSHEET_BASE = 'https://api.smartsheet.com/2.0';

module.exports = async function handler(req, res) {
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
      inicio: colId(colMap, 'inicio','fecha inicio','start','fecha de inicio','comienzo'),
      fin: colId(colMap, 'fin','fecha final','finish','end','fecha de fin','finalización'),
      pct: colId(colMap, '% completado','% completo','% complete','porcentaje','avance','percent complete'),
      baseStart: colId(colMap, 'comienzo de línea de base','baseline start','inicio base','inicio línea base'),
      baseFinish: colId(colMap, 'fin de línea de base','baseline finish','fin base','fin línea base'),
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
      const inicio = formatDate(get(COL.inicio));
      const fin = formatDate(get(COL.fin));
      const pct = parseFloat(get(COL.pct)) || 0;

      if (!nombre) return;

      tareas.push({
        id: row.id,
        nivel: row.indent || 1,
        nombre,
        inicio,
        fin,
        pct: Math.round(pct),
        baseStart: formatDate(get(COL.baseStart)) || inicio,
        baseFinish: formatDate(get(COL.baseFinish)) || fin,
        completada: pct >= 100,
        esPadre: row.hasChildren || false,
      });
    });

    /* Resumen */
    const tareasConFechas = tareas.filter(t => t.inicio && t.fin);
    const avanceGeneral = tareasConFechas.length
      ? Math.round(tareasConFechas.reduce((s, t) => s + t.pct, 0) / tareasConFechas.length)
      : 0;

    const todasFechas = tareasConFechas.flatMap(t => [t.inicio, t.fin]).filter(Boolean).sort();
    const todasBase = tareasConFechas.flatMap(t => [t.baseStart, t.baseFinish]).filter(Boolean).sort();

    const resumen = {
      nombre: sheet.name,
      avance: avanceGeneral,
      fechaInicio: todasFechas[0] || null,
      fechaFin: todasFechas[todasFechas.length - 1] || null,
      baseStart: todasBase[0] || todasFechas[0] || null,
      baseFinish: todasBase[todasBase.length - 1] || todasFechas[todasFechas.length - 1] || null,
      totalTareas: tareasConFechas.length,
      completadas: tareasConFechas.filter(t => t.completada).length,
    };

    return res.status(200).json({ resumen, tareas: tareasConFechas, columnas: Object.keys(colMap) });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

function colId(map, ...nombres) {
  for (const n of nombres) {
    if (map[n]) return map[n];
  }
  return null;
}

function formatDate(val) {
  if (!val) return null;
  // Si ya es formato YYYY-MM-DD
  if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}/.test(val)) {
    return val.substring(0, 10);
  }
  // Si es timestamp o Date
  try {
    const d = new Date(val);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().substring(0, 10);
  } catch {
    return null;
  }
}
