/* ============================================
   PORTAL DOCUMENTAL - Días hábiles colombianos
   Lunes a viernes, excluyendo festivos de Colombia
   (Ley 51 de 1983 "Ley Emiliani": varios festivos se
   trasladan al lunes siguiente).
   La MISMA lista vive en el servidor (tabla festivos_colombia
   de esquema.sql): si se agrega un año aquí, agregarlo allá.
   ============================================ */

/* Festivos oficiales de Colombia 2024–2027 ('AAAA-MM-DD') */
const FESTIVOS_COLOMBIA = [
    // 2024
    '2024-01-01', '2024-01-08', '2024-03-25', '2024-03-28', '2024-03-29',
    '2024-05-01', '2024-05-13', '2024-06-03', '2024-06-10', '2024-07-01',
    '2024-07-20', '2024-08-07', '2024-08-19', '2024-10-14', '2024-11-04',
    '2024-11-11', '2024-12-08', '2024-12-25',
    // 2025
    '2025-01-01', '2025-01-06', '2025-03-24', '2025-04-17', '2025-04-18',
    '2025-05-01', '2025-06-02', '2025-06-23', '2025-06-30', '2025-07-20',
    '2025-08-07', '2025-08-18', '2025-10-13', '2025-11-03', '2025-11-17',
    '2025-12-08', '2025-12-25',
    // 2026
    '2026-01-01', '2026-01-12', '2026-03-23', '2026-04-02', '2026-04-03',
    '2026-05-01', '2026-05-18', '2026-06-08', '2026-06-15', '2026-06-29',
    '2026-07-20', '2026-08-07', '2026-08-17', '2026-10-12', '2026-11-02',
    '2026-11-16', '2026-12-08', '2026-12-25',
    // 2027
    '2027-01-01', '2027-01-11', '2027-03-22', '2027-03-25', '2027-03-26',
    '2027-05-01', '2027-05-10', '2027-05-31', '2027-06-07', '2027-07-05',
    '2027-07-20', '2027-08-07', '2027-08-16', '2027-10-18', '2027-11-01',
    '2027-11-15', '2027-12-08', '2027-12-25'
];
const _FESTIVOS_SET = new Set(FESTIVOS_COLOMBIA);

/* Acepta 'AAAA-MM-DD' o Date; devuelve Date a medianoche local */
function _aFecha(f) {
    if (f instanceof Date) return new Date(f.getFullYear(), f.getMonth(), f.getDate());
    const [a, m, d] = String(f).split('-').map(Number);
    return new Date(a, m - 1, d);
}

/* Date → 'AAAA-MM-DD' en hora local */
function _aISO(d) {
    return d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');
}

/* ¿Es día hábil? (lunes a viernes y no festivo colombiano) */
function esDiaHabil(fecha) {
    const d = _aFecha(fecha);
    const dia = d.getDay(); // 0 = domingo, 6 = sábado
    if (dia === 0 || dia === 6) return false;
    return !_FESTIVOS_SET.has(_aISO(d));
}

/* Suma N días hábiles a una fecha. El conteo empieza DESPUÉS de la fecha
   dada: sumarDiasHabiles(viernes, 3) → miércoles siguiente (lun, mar, mié).
   Con n = 0 devuelve el mismo día. Devuelve 'AAAA-MM-DD'. */
function sumarDiasHabiles(fecha, diasHabiles) {
    const d = _aFecha(fecha);
    let n = Math.max(0, Math.floor(Number(diasHabiles) || 0));
    while (n > 0) {
        d.setDate(d.getDate() + 1);
        if (esDiaHabil(d)) n--;
    }
    return _aISO(d);
}

/* Resta N días hábiles a una fecha. Devuelve 'AAAA-MM-DD'. */
function restarDiasHabiles(fecha, diasHabiles) {
    const d = _aFecha(fecha);
    let n = Math.max(0, Math.floor(Number(diasHabiles) || 0));
    while (n > 0) {
        d.setDate(d.getDate() - 1);
        if (esDiaHabil(d)) n--;
    }
    return _aISO(d);
}

/* Cuenta los días hábiles ENTRE dos fechas: excluye la fecha de inicio e
   incluye la final. contarDiasHabiles(lunes, viernes de la misma semana) = 4.
   Si fechaFin < fechaInicio devuelve un número negativo (días de atraso). */
function contarDiasHabiles(fechaInicio, fechaFin) {
    const ini = _aFecha(fechaInicio);
    const fin = _aFecha(fechaFin);
    if (fin < ini) return -contarDiasHabiles(fin, ini);
    let cuenta = 0;
    const d = new Date(ini);
    while (d < fin) {
        d.setDate(d.getDate() + 1);
        if (esDiaHabil(d)) cuenta++;
    }
    return cuenta;
}

/* Fecha de vencimiento de un plazo: N días hábiles contados desde la fecha
   de inicio. Si la fecha de inicio NO es hábil, el plazo corre desde el
   siguiente día hábil. Devuelve 'AAAA-MM-DD'. */
function calcularVencimientoHabil(fechaInicio, diasLimite) {
    let d = _aFecha(fechaInicio);
    // si empieza en sábado/domingo/festivo, el conteo parte del día hábil siguiente... el día 1 del plazo ES ese día hábil
    if (!esDiaHabil(d)) {
        while (!esDiaHabil(d)) d.setDate(d.getDate() + 1);
        return sumarDiasHabiles(d, Math.max(1, diasLimite) - 1);
    }
    return sumarDiasHabiles(d, Math.max(1, diasLimite));
}

/* Primer día hábil igual o posterior a la fecha dada. */
function primerDiaHabil(fecha) {
    const d = _aFecha(fecha);
    while (!esDiaHabil(d)) d.setDate(d.getDate() + 1);
    return _aISO(d);
}

/* NOTA: el COLOR del semáforo ya NO se calcula aquí. La única fuente de
   verdad es la función SQL calcular_semaforo (vía la RPC listar_procesos);
   el navegador solo pinta lo que recibe. Este archivo queda únicamente para
   aritmética de fechas (vencimientos, conteos, calendario). En modo local
   (práctica sin internet) el equivalente vive en db.js. */

function fechaISOLocalHabil() {
    const d = new Date();
    return _aISO(d);
}
