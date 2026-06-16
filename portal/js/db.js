/* ============================================
   PORTAL DOCUMENTAL - Capa de datos (IndexedDB)
   Todo se guarda en el navegador. En producción
   esto se reemplaza por un backend real (Supabase).
   ============================================ */
const DB_NOMBRE = 'portal_documental';
const DB_VERSION = 4; // v4: bitácora de actividad (centro de notificaciones)

let _db = null;

function abrirDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolver, rechazar) => {
        const peticion = indexedDB.open(DB_NOMBRE, DB_VERSION);

        peticion.onupgradeneeded = (e) => {
            const db = e.target.result;
            // Al cambiar de versión se reinician los datos de práctica
            for (const nombre of ['usuarios', 'carpetas', 'archivos', 'actividad']) {
                if (db.objectStoreNames.contains(nombre)) db.deleteObjectStore(nombre);
            }
            db.createObjectStore('usuarios', { keyPath: 'usuario' });
            db.createObjectStore('carpetas', { keyPath: 'id', autoIncrement: true });
            const archivos = db.createObjectStore('archivos', { keyPath: 'id', autoIncrement: true });
            archivos.createIndex('porCarpeta', 'carpetaId', { unique: false });
            db.createObjectStore('actividad', { keyPath: 'id', autoIncrement: true });
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
async function registrarActividad(accion, objetivo) {
    try {
        const s = sesionActual();
        if (!s) return;
        await dbAgregar('actividad', {
            usuario: s.usuario, nombre: s.nombre, rol: s.rol,
            accion, objetivo: objetivo || '', fecha: Date.now()
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

/* Crea un usuario (versión local). En modo nube, nube.js
   reemplaza esta función por el registro en Supabase. */
async function crearUsuarioDatos(usuario, nombre, rol, clave) {
    await dbAgregar('usuarios', {
        usuario, nombre, rol,
        activo: true,
        clave: await protegerClave(clave),
        creado: Date.now()
    });
    return '';
}

/* Crea los usuarios y carpetas de demostración la primera vez */
async function sembrarDatosIniciales() {
    const existentes = await dbTodos('usuarios');
    if (existentes.length > 0) return;

    const usuariosDemo = [
        { usuario: 'administrador', nombre: 'Ana Administradora', rol: 'administrador', clave: 'administrador123' },
        { usuario: 'operador',      nombre: 'Carlos Operador',    rol: 'operador',      clave: 'operador123' },
        { usuario: 'cliente',       nombre: 'Pedro Cliente',      rol: 'cliente',       clave: 'cliente123' },
        { usuario: 'acreedor',      nombre: 'Banco Acreedor',     rol: 'acreedor',      clave: 'acreedor123' }
    ];
    for (const u of usuariosDemo) {
        await dbAgregar('usuarios', {
            usuario: u.usuario,
            nombre: u.nombre,
            rol: u.rol,
            activo: true,
            clave: await protegerClave(u.clave),
            creado: Date.now()
        });
    }

    await dbAgregar('carpetas', {
        nombre: 'Insolvencia — Pedro Cliente (Exp. 001-2026)',
        descripcion: 'Proceso de insolvencia de persona natural no comerciante.',
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
