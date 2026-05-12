/* ═══════════════════════════════════════════════════════
   API Route: /api/obra?id=SHEET_ID
   Corre en Vercel como serverless function.
   Lee SMARTSHEET_TOKEN desde variables de entorno de Vercel.
   Nunca expone el token al navegador.
   ═══════════════════════════════════════════════════════ */

const SMARTSHEET_BASE = 'https://api.smartsheet.com/2.0';

export default async function handler(req, res) {
  /* CORS — permite que tu HTML llame a esta función */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Falta el parámetro id (Sheet ID de Smartsheet).' });

  const TOKEN = process.env.SMARTSHEET_TOKEN;
  if (!TOKEN) return res.status(500).json({ error: 'SMARTSHEET_TOKEN no configurado en Vercel.' });

  try {
    /* ── 1. Traer la hoja completa con baseline ── */
    const url = `${SMARTSHEET_BASE}/sheets/${id}?include=rowPermalink&level=2`;
    const smRes = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type':  'application/json'
      }
    });

    if (!smRes.ok) {
      const err = await smRes.json().catch(() => ({}));
      return res.status(smRes.status).json({
        error: `Smartsheet respondió ${smRes.status}: ${err.message || 'error desconocido'}`
      });
    }

    const sheet = await smRes.json();

    /* ── 2. Mapear columnas por nombre ── */
    const colMap = {};
    (sheet.columns || []).forEach(c => {
      const k = c.title.toLowerCase().trim();
      colMap[k] = c.id;
      /* También guardamos por tipo de sistema */
      if (c.systemColumnType) colMap['_sys_' + c.systemColumnType.toLowerCase()] = c.id;
    });

    /* Columnas clave — ajustá los nombres si en tu hoja se llaman diferente */
    const COL = {
      nombre:           colId(colMap, 'tarea','nombre','task name','actividad','name'),
      inicio:           colId(colMap, 'inicio','start','fecha inicio','fecha de inicio'),
      fin:              colId(colMap, 'fin','finish','end','fecha fin','fecha de fin'),
      pct:              colId(colMap, '% completado','% complete','porcentaje','avance','percent complete'),
      baseStart:        colId(colMap, 'baseline start','inicio base','inicio planificado'),
      baseFinish:       colId(colMap, 'baseline finish','fin base','fin planificado'),
      predecesores:     colId(colMap, 'predecesores','predecessors'),
    };

    /* ── 3. Parsear filas ── */
    const tareas = [];
    (sheet.rows || []).forEach(row => {
      const get = (colId) => {
        if (!colId) return null;
        const cell = (row.cells || []).find(c => c.columnId === colId);
        return cell ? (cell.displayValue ?? cell.value ?? null) : null;
      };

      const nombre     = get(COL.nombre);
      const inicio     = get(COL.inicio);
      const fin        = get(COL.fin);
      const pct        = parseFloat(get(COL.pct)) || 0;
      const baseStart  = get(COL.baseStart);
      const baseFinish = get(COL.baseFinish);

      /* Solo filas con nombre y fechas */
      if (!nombre || !inicio || !fin) return;

      tareas.push({
        id:          row.id,
        nivel:       row.indent || 1,   /* 1 = tarea padre, 2+ = subtarea */
        nombre,
        inicio,
        fin,
        pct:         Math.round(pct),
        baseStart:   baseStart || inicio,
        baseFinish:  baseFinish || fin,
        completada:  pct >= 100,
        esPadre:     row.hasChildren || false,
      });
    });

    if (!tareas.length) {
      return res.status(404).json({ error: 'No se encontraron tareas con fechas en la hoja.' });
    }

    /* ── 4. Calcular resumen general de la obra ── */
    const tareasPadre  = tareas.filter(t => t.nivel === 1);
    const avanceGeneral = tareasPadre.length
      ? Math.round(tareasPadre.reduce((s, t) => s + t.pct, 0) / tareasPadre.length)
      : Math.round(tareas.reduce((s, t) => s + t.pct, 0) / tareas.length);

    const todasFechas = tareas.flatMap(t => [t.inicio, t.fin]).filter(Boolean).sort();
    const todasBase   = tareas.flatMap(t => [t.baseStart, t.baseFinish]).filter(Boolean).sort();

    const resumen = {
      nombre:        sheet.name,
      avance:        avanceGeneral,
      fechaInicio:   todasFechas[0]  || null,
      fechaFin:      todasFechas[todasFechas.length - 1] || null,
      baseStart:     todasBase[0]    || null,
      baseFinish:    todasBase[todasBase.length - 1] || null,
      totalTareas:   tareas.length,
      completadas:   tareas.filter(t => t.completada).length,
    };

    /* ── 5. Respuesta final ── */
    return res.status(200).json({ resumen, tareas });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

/* Helper: busca el ID de columna por múltiples nombres posibles */
function colId(map, ...nombres) {
  for (const n of nombres) {
    if (map[n]) return map[n];
  }
  return null;
}
