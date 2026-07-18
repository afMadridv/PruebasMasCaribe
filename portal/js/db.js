/* ============================================
   PORTAL DOCUMENTAL - Capa de datos (IndexedDB)
   Todo se guarda en el navegador. En producción
   esto se reemplaza por un backend real (Supabase).
   ============================================ */
const DB_NOMBRE = 'portal_documental';
const DB_VERSION = 10; // v10: procesos del trámite con semáforo por días hábiles

let _db = null;

function abrirDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolver, rechazar) => {
        const peticion = indexedDB.open(DB_NOMBRE, DB_VERSION);

        peticion.onupgradeneeded = (e) => {
            const db = e.target.result;
            // Al cambiar de versión se reinician los datos de práctica
            for (const nombre of ['usuarios', 'carpetas', 'archivos', 'actividad', 'chat', 'hoja', 'mensajes', 'audiencias', 'recordatorios', 'procesos']) {
                if (db.objectStoreNames.contains(nombre)) db.deleteObjectStore(nombre);
            }
            db.createObjectStore('usuarios', { keyPath: 'usuario' });
            db.createObjectStore('carpetas', { keyPath: 'id', autoIncrement: true });
            const archivos = db.createObjectStore('archivos', { keyPath: 'id', autoIncrement: true });
            archivos.createIndex('porCarpeta', 'carpetaId', { unique: false });
            db.createObjectStore('actividad', { keyPath: 'id', autoIncrement: true });
            // Mensajería del trámite: dos canales por carpeta (cliente / acreedor)
            const mensajes = db.createObjectStore('mensajes', { keyPath: 'id', autoIncrement: true });
            mensajes.createIndex('porCarpeta', 'carpetaId', { unique: false });
            // Info del deudor: una fila por carpeta (clave = carpetaId)
            // Audiencias marcadas en el calendario de cada carpeta
            const audiencias = db.createObjectStore('audiencias', { keyPath: 'id', autoIncrement: true });
            audiencias.createIndex('porCarpeta', 'carpetaId', { unique: false });
            // Recordatorios personales (solo los ve quien los crea)
            const recordatorios = db.createObjectStore('recordatorios', { keyPath: 'id', autoIncrement: true });
            recordatorios.createIndex('porCarpeta', 'carpetaId', { unique: false });
            // Procesos del trámite (semáforo por días hábiles)
            const procesos = db.createObjectStore('procesos', { keyPath: 'id', autoIncrement: true });
            procesos.createIndex('porCarpeta', 'carpetaId', { unique: false });
        };

        peticion.onsuccess = () => { _db = peticion.result; resolver(_db); };
        peticion.onerror = () => rechazar(peticion.error);
    });
}

function _transaccion(almacen, modo, operacion) {
    return abrirDB().then(db => new Promise((resolver, rechazar) => {
        const tx = db.transaction(almacen, modo);
        const peticion = operacion(tx.objectStore(almacen));
        peticion.onsuccess = () => resolver(peticion.result);
        peticion.onerror = () => rechazar(peticion.error);
    }));
}

function dbAgregar(almacen, valor)  { return _transaccion(almacen, 'readwrite', s => s.add(valor)); }
function dbGuardar(almacen, valor)  { return _transaccion(almacen, 'readwrite', s => s.put(valor)); }
function dbObtener(almacen, clave)  { return _transaccion(almacen, 'readonly',  s => s.get(clave)); }
function dbTodos(almacen)           { return _transaccion(almacen, 'readonly',  s => s.getAll()); }
function dbEliminar(almacen, clave) { return _transaccion(almacen, 'readwrite', s => s.delete(clave)); }

function dbArchivosDeCarpeta(carpetaId) {
    return abrirDB().then(db => new Promise((resolver, rechazar) => {
        const tx = db.transaction('archivos', 'readonly');
        const peticion = tx.objectStore('archivos').index('porCarpeta').getAll(carpetaId);
        peticion.onsuccess = () => resolver(peticion.result);
        peticion.onerror = () => rechazar(peticion.error);
    }));
}

async function dbEliminarArchivosDeCarpeta(carpetaId) {
    const archivos = await dbArchivosDeCarpeta(carpetaId);
    for (const a of archivos) {
        await dbEliminar('archivos', a.id);
    }
}

/* Registra una acción en la bitácora (versión local). En modo nube,
   nube.js la reemplaza por la función segura del servidor.
   La auditoría nunca debe romper la acción principal: traga errores. */
async function registrarActividad(accion, objetivo, carpetaId) {
    try {
        const s = sesionActual();
        if (!s) return;
        await dbAgregar('actividad', {
            usuario: s.usuario, nombre: s.nombre, rol: s.rol,
            accion, objetivo: objetivo || '',
            carpetaId: carpetaId || null,
            fecha: Date.now()
        });
    } catch (e) { /* silencioso */ }
}

/* Lista la bitácora más reciente primero (solo la usa el administrador) */
async function listarActividad() {
    try {
        const todo = await dbTodos('actividad');
        todo.sort((a, b) => b.fecha - a.fecha);
        return todo.slice(0, 300);
    } catch (e) { return []; }
}

/* Actividad de UNA carpeta (notificaciones del trámite para el operador).
   En modo nube, RLS deja al operador leer solo la actividad de sus carpetas. */
async function listarActividadDeCarpeta(carpetaId) {
    try {
        const todo = await dbTodos('actividad');
        return todo
            .filter(e => e.carpetaId === carpetaId)
            .sort((a, b) => b.fecha - a.fecha)
            .slice(0, 200);
    } catch (e) { return []; }
}

/* ============ AUDIENCIAS (calendario de la carpeta, modo local) ============ */
async function audienciasListar(carpetaId) {
    const todas = await dbTodos('audiencias');
    return todas
        .filter(a => a.carpetaId === carpetaId)
        .sort((a, b) => (a.fecha + a.hora).localeCompare(b.fecha + b.hora));
}
async function audienciaGuardar(carpetaId, datos) {
    const s = sesionActual() || {};
    await dbAgregar('audiencias', {
        carpetaId,
        titulo: datos.titulo || '',
        fecha: datos.fecha,            // 'AAAA-MM-DD'
        hora: datos.hora || '',        // 'HH:MM'
        enlace: datos.enlace || '',
        creadoPor: s.usuario || '',
        creado: Date.now()
    });
}
async function audienciaEliminar(id) {
    await dbEliminar('audiencias', id);
}

/* ============ RECORDATORIOS PERSONALES (modo local) ============
   Cada quien ve SOLO los suyos. En modo nube lo garantiza RLS. */
async function recordatoriosListar(carpetaId) {
    const s = sesionActual() || {};
    const todos = await dbTodos('recordatorios');
    return todos
        .filter(r => r.carpetaId === carpetaId && r.usuario === s.usuario)
        .sort((a, b) => a.fechaInicio.localeCompare(b.fechaInicio));
}
async function recordatorioGuardar(datos) {
    const s = sesionActual() || {};
    if (datos.id) {
        const reg = await dbObtener('recordatorios', datos.id);
        if (!reg || reg.usuario !== s.usuario) throw new Error('Recordatorio no encontrado.');
        await dbGuardar('recordatorios', { ...reg, mensaje: datos.mensaje, fechaInicio: datos.fechaInicio, fechaFin: datos.fechaFin });
        return;
    }
    await dbAgregar('recordatorios', {
        usuario: s.usuario || '',
        carpetaId: datos.carpetaId,
        mensaje: datos.mensaje || '',
        fechaInicio: datos.fechaInicio,  // 'AAAA-MM-DD'
        fechaFin: datos.fechaFin,
        creado: Date.now()
    });
}
async function recordatorioEliminar(id) {
    const s = sesionActual() || {};
    const reg = await dbObtener('recordatorios', id);
    if (!reg || reg.usuario !== s.usuario) return;
    await dbEliminar('recordatorios', id);
}
/* TODOS mis recordatorios (calendario general del operador, modo local) */
async function recordatoriosMios() {
    const s = sesionActual() || {};
    const [todos, carpetas] = await Promise.all([dbTodos('recordatorios'), dbTodos('carpetas')]);
    const nombrePorCarpeta = {};
    for (const c of carpetas) nombrePorCarpeta[c.id] = c.nombre;
    return todos
        .filter(r => r.usuario === s.usuario)
        .map(r => ({ ...r, carpetaNombre: nombrePorCarpeta[r.carpetaId] || '' }));
}

/* Recordatorios míos cuyo rango incluye la fecha de hoy (para la ventana
   emergente al ingresar). Devuelve también el nombre de la carpeta. */
async function recordatoriosVigentes() {
    const s = sesionActual() || {};
    const hoy = fechaISOLocal(new Date());
    const [todos, carpetas] = await Promise.all([dbTodos('recordatorios'), dbTodos('carpetas')]);
    const nombrePorCarpeta = {};
    for (const c of carpetas) nombrePorCarpeta[c.id] = c.nombre;
    return todos
        .filter(r => r.usuario === s.usuario && r.fechaInicio <= hoy && hoy <= r.fechaFin)
        .map(r => ({ ...r, carpetaNombre: nombrePorCarpeta[r.carpetaId] || '' }));
}

/* 'AAAA-MM-DD' en hora local (toISOString usaría UTC y correría el día) */
function fechaISOLocal(d) {
    return d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');
}

/* ============ ORDEN MANUAL DE DOCUMENTOS (modo local) ============ */
async function actualizarOrdenArchivos(carpetaId, ids) {
    let n = 1;
    for (const id of ids) {
        const a = await dbObtener('archivos', id);
        if (a && a.carpetaId === carpetaId) {
            a.orden = n++;
            await dbGuardar('archivos', a);
        }
    }
}

/* ============ ASIGNADOS DE LA CARPETA (con correo, modo local) ============
   Para la notificación de audiencias: deudor/cliente y acreedores del
   trámite con su correo de contacto. */
async function asignadosDeCarpeta(carpetaId) {
    const carpeta = await dbObtener('carpetas', carpetaId);
    if (!carpeta) return [];
    const usuarios = await dbTodos('usuarios');
    return usuarios
        .filter(u => (carpeta.asignados || []).includes(u.usuario) && u.activo !== false)
        .map(u => ({ usuario: u.usuario, nombre: u.nombre, rol: u.rol, correo: u.correo || '' }));
}

/* ============ MENSAJERÍA DEL TRÁMITE (modo local) ============
   Dos canales por carpeta: 'cliente' y 'acreedor'. En modo nube,
   nube.js la reemplaza por la tabla mensajes (con RLS por canal). */
async function mensajesListar(carpetaId, canal) {
    const todos = await dbTodos('mensajes');
    return todos
        .filter(m => m.carpetaId === carpetaId && m.canal === canal)
        .sort((a, b) => a.fecha - b.fecha);
}
async function mensajesGuardar(carpetaId, canal, texto, archivo) {
    const s = sesionActual() || {};
    await dbAgregar('mensajes', {
        carpetaId, canal,
        autorUsuario: s.usuario || '',
        autorNombre: s.nombre || s.usuario || '',
        rol: s.rol || '',
        texto: texto || '',
        // adjunto opcional (en local el contenido va en el propio registro)
        archivoNombre: archivo ? archivo.name : '',
        archivoTamano: archivo ? archivo.size : 0,
        archivoTipo: archivo ? (archivo.type || 'application/octet-stream') : '',
        archivoBlob: archivo || null,
        fecha: Date.now()
    });
}

/* Devuelve el adjunto de un mensaje de chat, para descargarlo. En modo nube,
   nube.js la reemplaza descargando desde Storage (con RLS por canal). */
async function descargarAdjuntoChat(mensajeId) {
    const m = await dbObtener('mensajes', mensajeId);
    if (!m || !m.archivoBlob) throw new Error('El mensaje no tiene adjunto.');
    return { nombre: m.archivoNombre, blob: m.archivoBlob };
}

/* Devuelve los archivos de una carpeta CON su contenido (blob), para
   armar el ZIP. En modo nube, nube.js la reemplaza descargando desde
   Storage en paralelo. */
async function descargarBlobsDeCarpeta(carpetaId, alProgresar) {
    const archivos = await dbArchivosDeCarpeta(carpetaId);
    if (alProgresar) alProgresar(archivos.length, archivos.length);
    return archivos.map(a => ({ nombre: a.nombre, blob: a.blob }));
}

/* Actualiza solo la descripción (estado del trámite) de una carpeta.
   En modo nube, nube.js la reemplaza por una llamada segura al servidor. */
async function actualizarDescripcionCarpeta(carpetaId, descripcion) {
    const carpeta = await dbObtener('carpetas', carpetaId);
    if (!carpeta) return;
    carpeta.descripcion = descripcion;
    await dbGuardar('carpetas', carpeta);
}



/* ============ SEMÁFOROS: PROCESOS DEL TRÁMITE (modo local) ============
   Mismas reglas que el servidor (nube.js las reemplaza por funciones con
   validación en Supabase). Usa js/diasHabiles.js para los plazos. */
function _esAdminLocal() { const s = sesionActual(); return s && s.rol === 'administrador'; }

/* Réplica LOCAL de la función SQL calcular_semaforo (solo para el modo de
   práctica sin internet; en la nube el color viene de listar_procesos). */
function _semaforoLocal(p) {
    if (p.pausado) return { semaforo: 'pausado', diasRestantes: null };
    if (p.completado) return { semaforo: 'verde', diasRestantes: null };
    if (!p.completado && p.semaforoManual) {
        return { semaforo: p.semaforoManual, diasRestantes: contarDiasHabiles(fechaISOLocal(new Date()), p.fechaVencimiento) };
    }
    if (!p.fechaVencimiento) return { semaforo: 'verde', diasRestantes: null };
    const hoy = fechaISOLocal(new Date());
    const restantes = contarDiasHabiles(hoy, p.fechaVencimiento);
    if (p.fechaVencimiento < hoy) return { semaforo: 'rojo', diasRestantes: restantes };
    if (restantes <= 1) return { semaforo: 'naranja', diasRestantes: restantes };
    return { semaforo: 'verde', diasRestantes: restantes };
}

async function procesosListar(carpetaId) {
    const todos = await dbTodos('procesos');
    return todos
        .filter(p => p.carpetaId === carpetaId)
        .sort((a, b) => (a.orden - b.orden) || (a.id - b.id))
        .map(p => ({ ...p, ..._semaforoLocal(p) }));
}

async function procesosTodos() {
    const todos = await dbTodos('procesos');
    return todos
        .sort((a, b) => (a.carpetaId - b.carpetaId) || (a.orden - b.orden))
        .map(p => ({ ...p, ..._semaforoLocal(p) }));
}

async function procesoCrear(carpetaId, datos) {
    const carpeta = await dbObtener('carpetas', carpetaId);
    if (!carpeta) throw new Error('Carpeta no encontrada.');
    if (carpeta.pausado) throw new Error('El trámite está pausado: reactívalo antes de crear procesos.');
    if (!datos.nombre || !String(datos.nombre).trim()) throw new Error('El proceso necesita un nombre.');
    const dias = Math.floor(Number(datos.dias));
    if (!dias || dias <= 0) throw new Error('El plazo en días hábiles debe ser mayor que cero.');
    const existentes = await procesosListar(carpetaId);
    const hoy = fechaISOLocal(new Date());
    return dbAgregar('procesos', {
        carpetaId,
        nombre: String(datos.nombre).trim().slice(0, 120),
        dias,
        orden: datos.orden || (existentes.length ? Math.max(...existentes.map(p => p.orden)) + 1 : 1),
        completado: false,
        fechaInicio: hoy,
        fechaInicioHabil: primerDiaHabil(hoy),
        fechaVencimiento: calcularVencimientoHabil(hoy, dias),
        fechaCompletado: null,
        pausado: false,
        diasRestantesAlPausar: null,
        semaforoManual: null,
        creado: Date.now()
    });
}

async function procesoCompletar(procesoId) {
    const p = await dbObtener('procesos', procesoId);
    if (!p) throw new Error('Proceso no encontrado.');
    if (p.completado) throw new Error('Este proceso ya estaba completado.');
    if (p.pausado) throw new Error('El trámite está pausado: reactívalo primero.');
    const hoy = fechaISOLocal(new Date());
    if (hoy > p.fechaVencimiento && !_esAdminLocal()) {
        throw new Error('El plazo ya venció: solo el administrador puede marcarlo como completado.');
    }
    await dbGuardar('procesos', { ...p, completado: true, fechaCompletado: hoy, semaforoManual: null });
}

async function procesoEliminar(procesoId) {
    await dbEliminar('procesos', procesoId);
}

async function tramitePausar(carpetaId) {
    const carpeta = await dbObtener('carpetas', carpetaId);
    if (!carpeta) throw new Error('Carpeta no encontrada.');
    if (carpeta.pausado) throw new Error('El trámite ya estaba pausado.');
    const hoy = fechaISOLocal(new Date());
    await dbGuardar('carpetas', {
        ...carpeta, pausado: true, fechaPausa: hoy, fechaReactivacion: null,
        // congela también el conteo del trámite completo (60/90 días)
        diasRestantesTramiteAlPausar: carpeta.fechaVencimientoTramite
            ? Math.max(contarDiasHabiles(hoy, carpeta.fechaVencimientoTramite), 0)
            : null
    });
    for (const p of await procesosListar(carpetaId)) {
        if (p.completado) continue;
        await dbGuardar('procesos', {
            ...p, pausado: true, fechaPausa: hoy,
            diasRestantesAlPausar: Math.max(contarDiasHabiles(hoy, p.fechaVencimiento), 0)
        });
    }
}

async function tramiteReactivar(carpetaId) {
    const carpeta = await dbObtener('carpetas', carpetaId);
    if (!carpeta) throw new Error('Carpeta no encontrada.');
    if (!carpeta.pausado) throw new Error('El trámite no está pausado.');
    const hoy = fechaISOLocal(new Date());
    await dbGuardar('carpetas', {
        ...carpeta, pausado: false, fechaReactivacion: hoy,
        fechaVencimientoTramite: (carpeta.diasRestantesTramiteAlPausar === null || carpeta.diasRestantesTramiteAlPausar === undefined)
            ? (carpeta.fechaVencimientoTramite || null)
            : sumarDiasHabiles(hoy, carpeta.diasRestantesTramiteAlPausar),
        diasRestantesTramiteAlPausar: null
    });
    for (const p of await procesosListar(carpetaId)) {
        if (p.completado || !p.pausado) continue;
        await dbGuardar('procesos', {
            ...p, pausado: false, fechaPausa: null, fechaReactivacion: hoy,
            fechaVencimiento: sumarDiasHabiles(hoy, p.diasRestantesAlPausar || 0)
        });
    }
}

/* Conteo del trámite completo (modo local): 60 días hábiles, 90 con prórroga */
async function tramiteIniciar(carpetaId, fecha) {
    const carpeta = await dbObtener('carpetas', carpetaId);
    if (!carpeta) throw new Error('Carpeta no encontrada.');
    if (carpeta.pausado) throw new Error('El trámite está pausado: reactívalo antes de iniciar el conteo.');
    if (carpeta.fechaInicioTramite) throw new Error('El conteo del trámite ya fue iniciado el ' + carpeta.fechaInicioTramite + '.');
    const inicio = fecha || fechaISOLocal(new Date());
    await dbGuardar('carpetas', {
        ...carpeta,
        fechaInicioTramite: inicio,
        diasHabilesTramite: 60,
        tieneProrroga: false,
        fechaVencimientoTramite: calcularVencimientoHabil(inicio, 60),
        diasRestantesTramiteAlPausar: null
    });
}

async function tramiteProrroga(carpetaId) {
    if (!_esAdminLocal()) throw new Error('Solo el administrador puede aplicar la prórroga.');
    const carpeta = await dbObtener('carpetas', carpetaId);
    if (!carpeta) throw new Error('Carpeta no encontrada.');
    if (!carpeta.fechaInicioTramite) throw new Error('El trámite aún no tiene conteo iniciado.');
    if (carpeta.tieneProrroga) throw new Error('El trámite ya tiene la prórroga aplicada.');
    if (carpeta.pausado) throw new Error('El trámite está pausado: reactívalo antes de aplicar la prórroga.');
    await dbGuardar('carpetas', {
        ...carpeta,
        diasHabilesTramite: 90,
        tieneProrroga: true,
        fechaVencimientoTramite: calcularVencimientoHabil(carpeta.fechaInicioTramite, 90)
    });
}

async function procesoEditarAdmin(procesoId, cambios) {
    if (!_esAdminLocal()) throw new Error('Solo el administrador puede corregir procesos.');
    const p = await dbObtener('procesos', procesoId);
    if (!p) throw new Error('Proceso no encontrado.');
    const nuevo = { ...p };
    if (cambios.nombre) nuevo.nombre = String(cambios.nombre).trim().slice(0, 120);
    if (cambios.dias) nuevo.dias = Math.max(1, Math.floor(Number(cambios.dias)));
    if (cambios.vencimiento) nuevo.fechaVencimiento = cambios.vencimiento;
    if (typeof cambios.completado === 'boolean') {
        nuevo.completado = cambios.completado;
        nuevo.fechaCompletado = cambios.completado ? (p.fechaCompletado || fechaISOLocal(new Date())) : null;
    }
    if (cambios.semaforo !== undefined && cambios.semaforo !== null) {
        nuevo.semaforoManual = cambios.semaforo === '' ? null : cambios.semaforo;
    }
    await dbGuardar('procesos', nuevo);
}

/* ============ CHAT DE SOPORTE Y LLAMADAS (modo local: no disponibles) ============
   El soporte en vivo necesita el servidor (Supabase Realtime). En el modo de
   práctica sin internet estas funciones existen para que la interfaz no se
   rompa, pero avisan que la función es solo del modo nube. */
async function soporteOperadores() { return []; }
async function soporteMensajes() { return []; }
async function soporteEnviar() { throw new Error('El chat de soporte solo está disponible en modo nube.'); }
async function descargarAdjuntoSoporte() { throw new Error('Solo disponible en modo nube.'); }
async function solicitarRestablecimiento() {}
async function solicitudesClaveListar() { return []; }
async function solicitudClaveResolver() {}
async function marcarLeidosSoporte() {}
async function marcarLeidosCanal() {}
async function chatsNoLeidos() { return []; }
async function soporteNoLeidos() { return []; }
function suscribirMensajesNuevos() { return null; }
function suscribirLlamadasEntrantes() { return null; }
async function llamadaCrear() { throw new Error('Las llamadas solo están disponibles en modo nube.'); }
async function llamadaActualizar() {}
function canalSenalizacion() { return { enviar: () => {}, cerrar: () => {} }; }

/* Notificaciones (campana): en modo local no hay triggers de servidor */
async function notificacionesListar() { return []; }
async function notificacionesMarcarLeidas() {}
async function notificacionEliminar() {}
async function notificacionesGenerarVencidos() {}
async function notificarMiIngreso() {}
function suscribirNotificaciones() { return null; }

/* Presencia y última conexión (modo local: sin tiempo real) */
async function registrarConexion() {
    try {
        const s = sesionActual();
        if (!s) return;
        const u = await dbObtener('usuarios', s.usuario);
        if (u) await dbGuardar('usuarios', { ...u, ultimaConexion: Date.now() });
    } catch (e) { /* silencioso */ }
}
function presenciaIniciar() { return null; }

/* Fin de trámite (modo local): solo administrador */
async function tramiteFinalizar(carpetaId) {
    if (!_esAdminLocal()) throw new Error('Solo el administrador puede dar fin al trámite.');
    const carpeta = await dbObtener('carpetas', carpetaId);
    if (!carpeta) throw new Error('Carpeta no encontrada.');
    if (carpeta.finalizado) throw new Error('El trámite ya estaba finalizado.');
    await dbGuardar('carpetas', { ...carpeta, finalizado: true, fechaFinTramite: fechaISOLocal(new Date()) });
}

/* Consentimiento de datos (modo local) */
async function perfilPropio() {
    const s = sesionActual() || {};
    const u = s.usuario ? await dbObtener('usuarios', s.usuario) : null;
    return u ? { usuario: u.usuario, nombre: u.nombre, rol: u.rol, primerLogin: u.primerLogin !== false } : null;
}
async function consentimientoAceptar(version) {
    const s = sesionActual() || {};
    const u = s.usuario ? await dbObtener('usuarios', s.usuario) : null;
    if (!u) return;
    await dbGuardar('usuarios', { ...u, primerLogin: false, consentimiento: { fecha: Date.now(), version: version || '1.0' } });
}
async function consentimientosListar() {
    const usuarios = await dbTodos('usuarios');
    return usuarios.filter(u => u.consentimiento).map(u => ({
        usuario: u.usuario, nombre: u.nombre, rol: u.rol,
        fecha: u.consentimiento.fecha, version: u.consentimiento.version
    }));
}

/* Crea un usuario (versión local). En modo nube, nube.js
   reemplaza esta función por el registro en Supabase. */
async function crearUsuarioDatos(usuario, nombre, rol, clave, correo) {
    await dbAgregar('usuarios', {
        usuario, nombre, rol,
        activo: true,
        correo: correo || null,
        clave: await protegerClave(clave),
        creado: Date.now()
    });
    return '';
}

/* Restablece la contraseña de un usuario (versión local). En modo nube,
   nube.js la reemplaza por una Edge Function con privilegios de servidor. */
async function restablecerClave(usuario, nuevaClave) {
    const reg = await dbObtener('usuarios', usuario.usuario);
    if (!reg) throw new Error('Usuario no encontrado.');
    reg.clave = await protegerClave(nuevaClave);
    await dbGuardar('usuarios', reg);
}

/* Crea los usuarios y carpetas de demostración la primera vez */
async function sembrarDatosIniciales() {
    const existentes = await dbTodos('usuarios');
    if (existentes.length > 0) return;

    const usuariosDemo = [
        { usuario: 'administrador', nombre: 'Ana Administradora', rol: 'administrador', clave: 'administrador123', correo: 'ana@ejemplo.com' },
        { usuario: 'operador',      nombre: 'Carlos Operador',    rol: 'operador',      clave: 'operador123',      correo: 'carlos@ejemplo.com' },
        { usuario: 'cliente',       nombre: 'Pedro Cliente',      rol: 'cliente',       clave: 'cliente123',       correo: 'pedro@ejemplo.com' },
        { usuario: 'acreedor',      nombre: 'Banco Acreedor',     rol: 'acreedor',      clave: 'acreedor123',      correo: 'banco@ejemplo.com' }
    ];
    for (const u of usuariosDemo) {
        await dbAgregar('usuarios', {
            usuario: u.usuario,
            nombre: u.nombre,
            rol: u.rol,
            activo: true,
            correo: u.correo,
            clave: await protegerClave(u.clave),
            creado: Date.now()
        });
    }

    await dbAgregar('carpetas', {
        nombre: 'Insolvencia — Pedro Cliente (Exp. 001-2026)',
        descripcion: 'Notas internas: audiencia de conciliación pendiente de fecha.',
        activa: true,
        asignados: ['cliente', 'acreedor'],
        operadores: ['operador'],
        creadaPor: 'administrador',
        fecha: Date.now()
    });
    await dbAgregar('carpetas', {
        nombre: 'Conciliación — Caso de práctica (Exp. 002-2026)',
        descripcion: 'Carpeta sin operador asignado y desactivada: solo la ve el administrador.',
        activa: false,
        asignados: ['cliente'],
        operadores: [],
        creadaPor: 'administrador',
        fecha: Date.now()
    });
}
