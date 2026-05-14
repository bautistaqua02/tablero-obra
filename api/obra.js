const SMARTSHEET_BASE = 'https://api.smartsheet.com/2.0';

/* ─── Caché en memoria (vive mientras el proceso serverless esté activo) ─── */
const cache = new Map(); // key: sheetId → { data, ts }
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

module.exports = async function handler(req, res) {
  /* CORS */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id, nocache } = req.query;
  if (!id) return res.status(400).json({ error: 'Falta el parámetro id' });

  const TOKEN = process.env.SMARTSHEET_TOKEN;
  if (!TOKEN) return res.status(500).json({ error: 'SMARTSHEET_TOKEN no configurado' });

  /* ─── Servir desde caché si está vigente (salvo nocache=1) ─── */
  const now = Date.now();
  if (!nocache && cache.has(id)) {
    const { data, ts } = cache.get(id);
    if (now - ts < CACHE_TTL) {
      res.setHeader('X-Cache', 'HIT');
      return res.status(200).json(data);
    }
  }

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

    /* ─── Mapear columnas ─── */
    const colMap = {};
    (sheet.columns || []).forEach(c => {
      colMap[c.title.toLowerCase().trim()] = c.id;
    });

    const COL = {
      nombre:     colId(colMap, 'nombre de la tarea','tarea','nombre','task name','actividad','name'),
      inicio:     colId(colMap, 'inicio','fecha inicio','start','fecha de inicio','comienzo'),
      fin:        colId(colMap, 'fin','fecha final','finish','end','fecha de fin','finalización'),
      pct:        colId(colMap, '% completado','% completo','% complete','porcentaje','avance','percent complete'),
      baseStart:  colId(colMap, 'comienzo de línea de base','baseline start','inicio base','inicio línea base'),
      baseFinish: colId(colMap, 'fin de línea de base','baseline finish','fin base','fin línea base'),
      duracion:   colId(colMap, 'duración','duration','dias','días'),
      presupuesto:colId(colMap, 'presupuesto','budget','costo planificado'),
      gastoReal:  colId(colMap, 'gasto real','costo real','actual cost','costo','real'),
      critico:    colId(colMap, 'hito critico','hito crítico','crítico','critico','critical','ruta crítica','ruta critica','es crítico','es critico'),
    };

    /* ─── Parsear filas ─── */
    const todasLasFilas = [];
    (sheet.rows || []).forEach(row => {
      const get = (cId) => {
        if (!cId) return null;
        const cell = (row.cells || []).find(c => c.columnId === cId);
        return cell ? (cell.displayValue ?? cell.value ?? null) : null;
      };

      const nombre = get(COL.nombre);
      if (!nombre) return;

      const inicio  = formatDate(get(COL.inicio));
      const fin     = formatDate(get(COL.fin));
      const rawPct  = get(COL.pct);
      const pct     = Math.min(100, Math.max(0, Math.round(parseFloat(rawPct) || 0)));

      // Calcular duración en días si está disponible, sino de fechas
      let duracionDias = parseFloat(get(COL.duracion)) || null;
      if (!duracionDias && inicio && fin) {
        duracionDias = Math.max(1, Math.round((new Date(fin) - new Date(inicio)) / 86400000));
      }

      todasLasFilas.push({
        id:           row.id,
        parentId:     row.parentId || null,
        nivel:        row.indent || 1,
        nombre,
        inicio,
        fin,
        pct,
        duracionDias: duracionDias || 1,
        baseStart:    formatDate(get(COL.baseStart)) || inicio,
        baseFinish:   formatDate(get(COL.baseFinish)) || fin,
        completada:   pct >= 100,
        esPadre:      row.hasChildren || false,
        presupuesto:  cleanNum(get(COL.presupuesto)),
        gastoReal:    cleanNum(get(COL.gastoReal)),
        // Columna crítico: acepta checkbox (true/false) o texto ("sí","si","yes","1","x")
        critico:      parseCritico(get(COL.critico)),
      });
    });

    /* ─── Separar padres e hijas ─── */
    const tareasSolo = todasLasFilas.filter(t => t.inicio && t.fin);

    // Solo hojas (no padres) para calcular avance — evita doble conteo
    const hojasConFechas = tareasSolo.filter(t => !t.esPadre);

    /* ─── Avance ponderado por duración (solo hojas) ─── */
    const totalDias = hojasConFechas.reduce((s, t) => s + t.duracionDias, 0);
    const avanceGeneral = totalDias > 0
      ? Math.round(hojasConFechas.reduce((s, t) => s + (t.pct * t.duracionDias), 0) / totalDias)
      : 0;

    /* ─── Fechas de rango ─── */
    const todasFechas = tareasSolo.flatMap(t => [t.inicio, t.fin]).filter(Boolean).sort();
    const todasBase   = tareasSolo.flatMap(t => [t.baseStart, t.baseFinish]).filter(Boolean).sort();

    /* ─── Presupuesto total (suma de hojas o del nivel 1 si existe) ─── */
    const presupuestoTotal = tareasSolo.reduce((s, t) => s + (t.presupuesto || 0), 0);
    const gastoRealTotal   = tareasSolo.reduce((s, t) => s + (t.gastoReal || 0), 0);

    const resumen = {
      nombre:        sheet.name,
      avance:        avanceGeneral,
      fechaInicio:   todasFechas[0] || null,
      fechaFin:      todasFechas[todasFechas.length - 1] || null,
      baseStart:     todasBase[0] || todasFechas[0] || null,
      baseFinish:    todasBase[todasBase.length - 1] || todasFechas[todasFechas.length - 1] || null,
      totalTareas:   hojasConFechas.length,
      completadas:   hojasConFechas.filter(t => t.completada).length,
      presupuesto:   presupuestoTotal,
      gastoReal:     gastoRealTotal,
      cachedAt:      new Date().toISOString(),
    };

    const payload = {
      resumen,
      tareas: tareasSolo,          // todas (padres + hijas) con parentId
      columnas: Object.keys(colMap)
    };

    /* ─── Guardar en caché ─── */
    cache.set(id, { data: payload, ts: now });
    res.setHeader('X-Cache', 'MISS');

    return res.status(200).json(payload);

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

/* ─── Helpers ─── */
function colId(map, ...nombres) {
  for (const n of nombres) { if (map[n]) return map[n]; }
  return null;
}

function formatDate(val) {
  if (!val) return null;
  if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}/.test(val)) return val.substring(0, 10);
  try {
    const d = new Date(val);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().substring(0, 10);
  } catch { return null; }
}

function cleanNum(s) {
  if (!s && s !== 0) return 0;
  const c = String(s).trim().replace(/\$/g,'').replace(/\./g,'').replace(',','.');
  return parseFloat(c.replace(/[^0-9.-]/g, '')) || 0;
}

function parseCritico(val) {
  if (val === null || val === undefined || val === '') return false;
  if (typeof val === 'boolean') return val;
  const s = String(val).trim().toLowerCase();
  return ['true','1','sí','si','yes','x','✓','crítico','critico'].includes(s);
}
