/* ============================================
   PORTAL DOCUMENTAL - Lógica de la aplicación
   Roles:
   - administrador: control total → carpetas (crear/editar/
                    activar/desactivar/eliminar), archivos
                    (subir/eliminar) y usuarios (crear/
                    activar/desactivar/eliminar).
   - operador: SOLO ve las carpetas donde es operador
                    responsable, y sube archivos en ellas.
   - cliente / acreedor: solo ven y descargan los documentos
                    de sus carpetas ACTIVAS asignadas.
   ============================================ */

// ---- Protección de la página: sin sesión válida no se entra ----
const ROLES_VALIDOS = ['administrador', 'operador', 'cliente', 'acreedor'];
const sesion = sesionActual();
if (!sesion) {
    location.replace('index.html');
} else if (!ROLES_VALIDOS.includes(sesion.rol)) {
    cerrarSesion(); // sesión de una versión anterior del portal
}

const EXTENSIONES_PERMITIDAS = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'png', 'jpg', 'jpeg', 'mp3', 'mp4'];
const EXTENSIONES_VISTA = ['pdf', 'png', 'jpg', 'jpeg', 'mp3', 'mp4'];
const TAMANO_MAXIMO = 50 * 1024 * 1024; // 50 MB

const SESION_VALIDA = !!(sesion && ROLES_VALIDOS.includes(sesion.rol));
const ES_ADMIN = SESION_VALIDA && sesion.rol === 'administrador';
const ES_OPERADOR = SESION_VALIDA && sesion.rol === 'operador';
const ES_PERSONAL = ES_ADMIN || ES_OPERADOR; // ven estados y suben archivos

/* ¿Puede este usuario ver esta carpeta?
   El administrador ve todo (incluidas las desactivadas).
   El operador SOLO ve sus carpetas mientras estén ACTIVAS.
   Cliente/acreedor: sus carpetas activas asignadas. */
function puedeVerCarpeta(c) {
    if (ES_ADMIN) return true;
    if (ES_OPERADOR) return c.activa && (c.operadores || []).includes(sesion.usuario);
    return c.activa && (c.asignados || []).includes(sesion.usuario);
}

let carpetaAbierta = null;   // carpeta mostrada en la vista de detalle
let carpetaEditando = null;  // carpeta cargada en el modal (null = crear)
let nombrePorUsuario = {};   // usuario → nombre visible (para las tarjetas)

function nombreDe(usuario) {
    if (usuario === sesion.usuario) return sesion.nombre;
    return nombrePorUsuario[usuario] || usuario;
}

/* ¿Puede gestionar esta carpeta (subir/eliminar archivos y actualizar el
   estado del trámite)? El administrador en cualquiera; el operador solo
   en las suyas y mientras estén ACTIVAS. Clientes y acreedores nunca. */
function puedeGestionarCarpeta(c) {
    if (ES_ADMIN) return true;
    return ES_OPERADOR && c.activa && (c.operadores || []).includes(sesion.usuario);
}

document.addEventListener('DOMContentLoaded', iniciar);

// Red de seguridad: cualquier error de datos no atrapado se muestra como aviso
window.addEventListener('unhandledrejection', (evento) => {
    avisar((evento.reason && evento.reason.message) || 'Error de conexión con la base de datos.', 'error');
});

async function iniciar() {
    if (!SESION_VALIDA) return;
    pintarEncabezado();
    conectarEventos();
    await mostrarVistaCarpetas();
}

function pintarEncabezado() {
    const chip = document.getElementById('chip-usuario');
    chip.innerHTML = escaparHtml(sesion.nombre) +
        ' <span class="pt-insignia pt-insignia--rol">' + escaparHtml(ETIQUETAS_ROL[sesion.rol] || sesion.rol) + '</span>';
    document.getElementById('pestana-usuarios').hidden = !ES_ADMIN;
    document.getElementById('pestana-notificaciones').hidden = !ES_ADMIN;
    document.getElementById('boton-nueva-carpeta').hidden = !ES_ADMIN;
}

/* ============ NAVEGACIÓN ENTRE VISTAS ============ */
function mostrarVista(idVista) {
    for (const id of ['vista-carpetas', 'vista-carpeta', 'vista-usuarios', 'vista-notificaciones']) {
        document.getElementById(id).hidden = (id !== idVista);
    }
    document.getElementById('pestana-carpetas').classList.toggle('activa', idVista === 'vista-carpetas' || idVista === 'vista-carpeta');
    document.getElementById('pestana-usuarios').classList.toggle('activa', idVista === 'vista-usuarios');
    document.getElementById('pestana-notificaciones').classList.toggle('activa', idVista === 'vista-notificaciones');
}

/* ============ VISTA: LISTA DE CARPETAS ============ */
async function mostrarVistaCarpetas() {
    mostrarVista('vista-carpetas');
    carpetaAbierta = null;

    // Todo en paralelo: carpetas, conteo de archivos y (solo admin) nombres
    const [todas, archivos, usuarios] = await Promise.all([
        dbTodos('carpetas'),
        dbTodos('archivos'),
        ES_ADMIN ? dbTodos('usuarios') : Promise.resolve(null)
    ]);
    if (usuarios) {
        nombrePorUsuario = {};
        for (const u of usuarios) nombrePorUsuario[u.usuario] = u.nombre;
    }
    const visibles = todas.filter(puedeVerCarpeta);
    visibles.sort((a, b) => b.fecha - a.fecha);

    const conteo = {};
    for (const a of archivos) conteo[a.carpetaId] = (conteo[a.carpetaId] || 0) + 1;

    const lista = document.getElementById('lista-carpetas');
    const vacio = document.getElementById('carpetas-vacio');
    lista.innerHTML = visibles.map(c => tarjetaCarpeta(c, conteo[c.id] || 0)).join('');
    vacio.hidden = visibles.length > 0;
    vacio.textContent = ES_ADMIN
        ? 'Aún no hay carpetas. Crea la primera con el botón "+ Nueva carpeta".'
        : (ES_OPERADOR
            ? 'No tienes carpetas asignadas como operador. El administrador debe asignarte a un proceso.'
            : 'Todavía no tienes carpetas asignadas. Comunícate con la fundación.');
}

function tarjetaCarpeta(c, totalArchivos) {
    const estado = c.activa
        ? '<span class="pt-insignia pt-insignia--activa">Activa</span>'
        : '<span class="pt-insignia pt-insignia--inactiva">Desactivada</span>';
    const asignados = (c.asignados || []).length;
    const operadores = c.operadores || [];

    let acciones = '<button class="pt-boton pt-boton--primario pt-boton--mini" data-accion="abrir-carpeta" data-id="' + c.id + '">Abrir</button>';
    if (ES_ADMIN) {
        acciones +=
            ' <button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="editar-carpeta" data-id="' + c.id + '">Editar</button>' +
            ' <button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="alternar-carpeta" data-id="' + c.id + '">' + (c.activa ? 'Desactivar' : 'Activar') + '</button>' +
            ' <button class="pt-boton pt-boton--peligro pt-boton--mini" data-accion="eliminar-carpeta" data-id="' + c.id + '">Eliminar</button>';
    }

    return '<article class="pt-carpeta' + (c.activa ? '' : ' pt-carpeta--inactiva') + '">' +
        '<div class="pt-carpeta__cab">' + icono('carpeta') + (ES_PERSONAL ? estado : '') + '</div>' +
        '<h3 class="pt-carpeta__nombre">' + escaparHtml(c.nombre) + '</h3>' +
        '<p class="pt-carpeta__descripcion">' + escaparHtml(c.descripcion || '') + '</p>' +
        '<p class="pt-carpeta__datos">' + totalArchivos + ' documento(s)' +
            (ES_PERSONAL ? ' · ' + asignados + ' persona(s) asignada(s)' : '') +
            (ES_ADMIN ? ' · Operador: ' + (operadores.length ? operadores.map(o => escaparHtml(nombreDe(o))).join(', ') : 'sin asignar') : '') + '</p>' +
        '<div class="pt-carpeta__acciones">' + acciones + '</div>' +
        '</article>';
}

/* ============ VISTA: DETALLE DE CARPETA ============ */
async function abrirCarpeta(id) {
    const carpeta = await dbObtener('carpetas', id);
    if (!carpeta) return;
    // Nadie abre carpetas ajenas: ni clientes, ni acreedores, ni operadores
    if (!puedeVerCarpeta(carpeta)) {
        avisar('No tienes acceso a esta carpeta.', 'error');
        return;
    }
    carpetaAbierta = carpeta;
    mostrarVista('vista-carpeta');
    registrarActividad('abrir-carpeta', carpeta.nombre);

    document.getElementById('detalle-nombre').textContent = carpeta.nombre;
    document.getElementById('detalle-descripcion').textContent = carpeta.descripcion || 'Sin estado registrado todavía.';
    document.getElementById('detalle-estado').innerHTML = carpeta.activa
        ? '<span class="pt-insignia pt-insignia--activa">Activa</span>'
        : '<span class="pt-insignia pt-insignia--inactiva">Desactivada</span>';
    document.getElementById('zona-subida').hidden = !puedeGestionarCarpeta(carpeta);
    document.getElementById('boton-editar-descripcion').hidden = !puedeGestionarCarpeta(carpeta);
    document.getElementById('form-descripcion').hidden = true;

    await pintarArchivos();
}

/* ============ ESTADO DEL TRÁMITE (descripción) ============ */
function mostrarEditorDescripcion() {
    if (!carpetaAbierta || !puedeGestionarCarpeta(carpetaAbierta)) return;
    document.getElementById('descripcion-nueva').value = carpetaAbierta.descripcion || '';
    document.getElementById('form-descripcion').hidden = false;
    document.getElementById('boton-editar-descripcion').hidden = true;
    document.getElementById('descripcion-nueva').focus();
}

function ocultarEditorDescripcion() {
    document.getElementById('form-descripcion').hidden = true;
    if (carpetaAbierta) {
        document.getElementById('boton-editar-descripcion').hidden = !puedeGestionarCarpeta(carpetaAbierta);
    }
}

async function guardarDescripcion(evento) {
    evento.preventDefault();
    if (!carpetaAbierta || !puedeGestionarCarpeta(carpetaAbierta)) return;
    const texto = document.getElementById('descripcion-nueva').value.trim();
    await actualizarDescripcionCarpeta(carpetaAbierta.id, texto);
    carpetaAbierta.descripcion = texto;
    document.getElementById('detalle-descripcion').textContent = texto || 'Sin estado registrado todavía.';
    registrarActividad('actualizar-estado', carpetaAbierta.nombre);
    ocultarEditorDescripcion();
    avisar('Estado del trámite actualizado.');
}

async function pintarArchivos() {
    if (!carpetaAbierta) return;
    const archivos = await dbArchivosDeCarpeta(carpetaAbierta.id);
    archivos.sort((a, b) => b.fecha - a.fecha);

    const cuerpo = document.getElementById('lista-archivos');
    cuerpo.innerHTML = archivos.map(filaArchivo).join('');
    document.getElementById('archivos-vacio').hidden = archivos.length > 0;
}

function filaArchivo(a) {
    const ext = extensionDe(a.nombre);
    let acciones = '';
    if (EXTENSIONES_VISTA.includes(ext)) {
        acciones += '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="ver-archivo" data-id="' + a.id + '">Ver</button> ';
    }
    acciones += '<button class="pt-boton pt-boton--primario pt-boton--mini" data-accion="descargar-archivo" data-id="' + a.id + '">Descargar</button>';
    if (carpetaAbierta && puedeGestionarCarpeta(carpetaAbierta)) {
        acciones += ' <button class="pt-boton pt-boton--peligro pt-boton--mini" data-accion="eliminar-archivo" data-id="' + a.id + '">Eliminar</button>';
    }
    return '<tr>' +
        '<td><span class="pt-icono-archivo">' + iconoArchivo(ext) + '</span>' + escaparHtml(a.nombre) + '</td>' +
        '<td>' + formatoTamano(a.tamano) + '</td>' +
        '<td>' + escaparHtml(a.subidoPor) + '</td>' +
        '<td>' + formatoFecha(a.fecha) + '</td>' +
        '<td><div class="pt-celda-acciones">' + acciones + '</div></td>' +
        '</tr>';
}

/* ============ SUBIDA DE ARCHIVOS ============ */
async function subirArchivos(listaArchivos) {
    // Solo admin u operador responsable de ESTA carpeta
    if (!carpetaAbierta || !puedeGestionarCarpeta(carpetaAbierta)) return;
    const rechazados = [];
    let subidos = 0;

    for (const archivo of listaArchivos) {
        const ext = extensionDe(archivo.name);
        if (!EXTENSIONES_PERMITIDAS.includes(ext)) {
            rechazados.push(archivo.name + ' (tipo no permitido)');
            continue;
        }
        if (archivo.size > TAMANO_MAXIMO) {
            rechazados.push(archivo.name + ' (supera 50 MB)');
            continue;
        }
        await dbAgregar('archivos', {
            carpetaId: carpetaAbierta.id,
            nombre: archivo.name,
            tipo: archivo.type || 'application/octet-stream',
            tamano: archivo.size,
            blob: archivo,
            subidoPor: sesion.nombre || sesion.usuario,
            fecha: Date.now()
        });
        registrarActividad('subir-archivo', archivo.name + ' · ' + carpetaAbierta.nombre);
        subidos++;
    }

    if (subidos > 0) avisar(subidos + ' archivo(s) subido(s) correctamente.');
    if (rechazados.length > 0) avisar('No se subió: ' + rechazados.join(', '), 'error');
    await pintarArchivos();
}

async function descargarArchivo(id) {
    const archivo = await dbObtener('archivos', id);
    if (!archivo) return;
    const url = URL.createObjectURL(archivo.blob);
    const enlace = document.createElement('a');
    enlace.href = url;
    enlace.download = archivo.nombre;
    document.body.appendChild(enlace);
    enlace.click();
    enlace.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    registrarActividad('descargar-archivo', archivo.nombre + (carpetaAbierta ? ' · ' + carpetaAbierta.nombre : ''));
}

async function verArchivo(id) {
    const archivo = await dbObtener('archivos', id);
    if (!archivo) return;
    const url = URL.createObjectURL(archivo.blob);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    registrarActividad('ver-archivo', archivo.nombre + (carpetaAbierta ? ' · ' + carpetaAbierta.nombre : ''));
}

/* ============ DESCARGAR CARPETA COMPLETA (ZIP) ============ */
let _promesaJSZip = null;
/* Carga JSZip solo cuando se necesita, para no frenar el portal */
function cargarJSZip() {
    if (window.JSZip) return Promise.resolve(window.JSZip);
    if (_promesaJSZip) return _promesaJSZip;
    _promesaJSZip = new Promise((resolver, rechazar) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
        script.onload = () => window.JSZip
            ? resolver(window.JSZip)
            : rechazar(new Error('No se pudo cargar el compresor ZIP.'));
        script.onerror = () => {
            _promesaJSZip = null;
            rechazar(new Error('Sin conexión para cargar el compresor ZIP. Intenta de nuevo.'));
        };
        document.head.appendChild(script);
    });
    return _promesaJSZip;
}

const MARCAS_ACENTO_ZIP = new RegExp('[' + String.fromCharCode(0x300) + '-' + String.fromCharCode(0x36f) + ']', 'g');
function nombreArchivoSeguro(texto) {
    return String(texto)
        .normalize('NFD').replace(MARCAS_ACENTO_ZIP, '')
        .replace(/[^a-zA-Z0-9._-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 60) || 'carpeta';
}

async function descargarCarpetaZip() {
    if (!carpetaAbierta) return;
    const boton = document.getElementById('boton-descargar-zip');
    const textoOriginal = boton.textContent;
    boton.disabled = true;
    try {
        boton.textContent = 'Recopilando archivos…';
        const archivos = await descargarBlobsDeCarpeta(carpetaAbierta.id, (hechos, total) => {
            boton.textContent = 'Descargando ' + hechos + '/' + total + '…';
        });
        if (archivos.length === 0) {
            avisar('Esta carpeta no tiene documentos para descargar.', 'error');
            return;
        }

        boton.textContent = 'Comprimiendo…';
        const JSZip = await cargarJSZip();
        const zip = new JSZip();
        const repetidos = {};
        for (const archivo of archivos) {
            // si hay dos archivos con el mismo nombre, el segundo va como "nombre (2).ext"
            const vistos = repetidos[archivo.nombre] || 0;
            repetidos[archivo.nombre] = vistos + 1;
            let nombre = archivo.nombre;
            if (vistos > 0) {
                const punto = nombre.lastIndexOf('.');
                nombre = punto > 0
                    ? nombre.slice(0, punto) + ' (' + (vistos + 1) + ')' + nombre.slice(punto)
                    : nombre + ' (' + (vistos + 1) + ')';
            }
            zip.file(nombre, archivo.blob);
        }

        const blobZip = await zip.generateAsync(
            { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } },
            (avance) => { boton.textContent = 'Comprimiendo… ' + Math.round(avance.percent) + '%'; }
        );

        const url = URL.createObjectURL(blobZip);
        const enlace = document.createElement('a');
        enlace.href = url;
        enlace.download = nombreArchivoSeguro(carpetaAbierta.nombre) + '.zip';
        document.body.appendChild(enlace);
        enlace.click();
        enlace.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        registrarActividad('descargar-zip', carpetaAbierta.nombre + ' (' + archivos.length + ' archivos)');
        avisar('Carpeta descargada: ' + archivos.length + ' archivo(s) en un ZIP.');
    } catch (e) {
        avisar((e && e.message) || 'No se pudo crear el ZIP.', 'error');
    } finally {
        boton.disabled = false;
        boton.textContent = textoOriginal;
    }
}

async function eliminarArchivo(id) {
    // Solo admin u operador responsable de la carpeta abierta
    if (!carpetaAbierta || !puedeGestionarCarpeta(carpetaAbierta)) return;
    const archivo = await dbObtener('archivos', id);
    if (!archivo) return;
    if (!confirm('¿Eliminar el archivo "' + archivo.nombre + '"? Esta acción no se puede deshacer.')) return;
    await dbEliminar('archivos', id);
    registrarActividad('eliminar-archivo', archivo.nombre + ' · ' + carpetaAbierta.nombre);
    avisar('Archivo eliminado.');
    await pintarArchivos();
}

/* ============ GESTIÓN DE CARPETAS (administrador) ============ */
async function abrirModalCarpeta(carpeta) {
    if (!ES_ADMIN) return;
    carpetaEditando = carpeta || null;
    document.getElementById('modal-carpeta-titulo').textContent = carpeta ? 'Editar carpeta' : 'Nueva carpeta';
    document.getElementById('carpeta-nombre').value = carpeta ? carpeta.nombre : '';
    document.getElementById('carpeta-descripcion').value = carpeta ? (carpeta.descripcion || '') : '';
    document.getElementById('carpeta-activa').checked = carpeta ? !!carpeta.activa : true;

    // Listas para asignar: operadores responsables y clientes/acreedores
    const usuarios = await dbTodos('usuarios');
    const filaCheque = (u, marcados) =>
        '<label><input type="checkbox" value="' + escaparHtml(u.usuario) + '"' +
        (marcados.includes(u.usuario) ? ' checked' : '') + '> ' +
        escaparHtml(u.nombre) + ' <span class="pt-nota">(' + escaparHtml(ETIQUETAS_ROL[u.rol]) +
        (u.activo === false ? ' · desactivado' : '') + ')</span></label>';

    const operadores = usuarios.filter(u => u.rol === 'operador');
    const operadoresMarcados = carpeta ? (carpeta.operadores || []) : [];
    document.getElementById('carpeta-operadores').innerHTML = operadores.length === 0
        ? '<p class="pt-nota">No hay operadores creados todavía.</p>'
        : operadores.map(u => filaCheque(u, operadoresMarcados)).join('');

    const asignables = usuarios.filter(u => ['cliente', 'acreedor'].includes(u.rol));
    const marcados = carpeta ? (carpeta.asignados || []) : [];
    document.getElementById('carpeta-asignados').innerHTML = asignables.length === 0
        ? '<p class="pt-nota">No hay clientes ni acreedores creados todavía.</p>'
        : asignables.map(u => filaCheque(u, marcados)).join('');

    document.getElementById('modal-carpeta').hidden = false;
}

function cerrarModalCarpeta() {
    document.getElementById('modal-carpeta').hidden = true;
    carpetaEditando = null;
}

async function guardarCarpeta(evento) {
    evento.preventDefault();
    if (!ES_ADMIN) return;

    const nombre = document.getElementById('carpeta-nombre').value.trim();
    if (!nombre) return;
    const descripcion = document.getElementById('carpeta-descripcion').value.trim();
    const activa = document.getElementById('carpeta-activa').checked;
    const operadores = [...document.querySelectorAll('#carpeta-operadores input:checked')].map(c => c.value);
    const asignados = [...document.querySelectorAll('#carpeta-asignados input:checked')].map(c => c.value);

    if (carpetaEditando) {
        await dbGuardar('carpetas', { ...carpetaEditando, nombre, descripcion, activa, asignados, operadores });
        registrarActividad('editar-carpeta', nombre);
        avisar('Carpeta actualizada.');
    } else {
        await dbAgregar('carpetas', {
            nombre, descripcion, activa, asignados, operadores,
            creadaPor: sesion.usuario,
            fecha: Date.now()
        });
        registrarActividad('crear-carpeta', nombre);
        avisar('Carpeta creada.');
    }
    cerrarModalCarpeta();
    await mostrarVistaCarpetas();
}

async function alternarCarpeta(id) {
    if (!ES_ADMIN) return;
    const carpeta = await dbObtener('carpetas', id);
    if (!carpeta) return;
    carpeta.activa = !carpeta.activa;
    await dbGuardar('carpetas', carpeta);
    registrarActividad(carpeta.activa ? 'activar-carpeta' : 'desactivar-carpeta', carpeta.nombre);
    avisar(carpeta.activa ? 'Carpeta activada: los asignados ya pueden verla.' : 'Carpeta desactivada: queda oculta para los asignados.');
    await mostrarVistaCarpetas();
}

async function eliminarCarpeta(id) {
    if (!ES_ADMIN) return;
    const carpeta = await dbObtener('carpetas', id);
    if (!carpeta) return;
    if (!confirm('¿Eliminar la carpeta "' + carpeta.nombre + '" y TODOS sus archivos? Esta acción no se puede deshacer.')) return;
    await dbEliminarArchivosDeCarpeta(id);
    await dbEliminar('carpetas', id);
    registrarActividad('eliminar-carpeta', carpeta.nombre);
    avisar('Carpeta eliminada.');
    await mostrarVistaCarpetas();
}

/* ============ VISTA: USUARIOS (administrador) ============ */
async function mostrarVistaUsuarios() {
    if (!ES_ADMIN) return;
    mostrarVista('vista-usuarios');
    const usuarios = await dbTodos('usuarios');
    usuarios.sort((a, b) => a.usuario.localeCompare(b.usuario));

    document.getElementById('lista-usuarios').innerHTML = usuarios.map(u => {
        const activo = u.activo !== false;
        const estado = activo
            ? '<span class="pt-insignia pt-insignia--activa">Activo</span>'
            : '<span class="pt-insignia pt-insignia--inactiva">Desactivado</span>';
        const acciones = u.usuario === sesion.usuario
            ? '<span class="pt-nota">(tú)</span>'
            : '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="alternar-usuario" data-usuario="' + escaparHtml(u.usuario) + '">' + (activo ? 'Desactivar' : 'Activar') + '</button> ' +
              '<button class="pt-boton pt-boton--peligro pt-boton--mini" data-accion="eliminar-usuario" data-usuario="' + escaparHtml(u.usuario) + '">Eliminar</button>';
        return '<tr>' +
            '<td><code>' + escaparHtml(u.usuario) + '</code></td>' +
            '<td>' + escaparHtml(u.nombre) + '</td>' +
            '<td><span class="pt-insignia pt-insignia--rol">' + escaparHtml(ETIQUETAS_ROL[u.rol] || u.rol) + '</span></td>' +
            '<td>' + estado + '</td>' +
            '<td>' + formatoFecha(u.creado) + '</td>' +
            '<td><div class="pt-celda-acciones">' + acciones + '</div></td>' +
            '</tr>';
    }).join('');
}

/* ============ CENTRO DE NOTIFICACIONES (administrador) ============ */
const VERBOS_ACCION = {
    'ingreso':            { ic: 'ingreso',        verbo: 'inició sesión en el portal' },
    'abrir-carpeta':      { ic: 'carpeta-abrir',  verbo: 'abrió la carpeta' },
    'ver-archivo':        { ic: 'ver',            verbo: 'visualizó' },
    'descargar-archivo':  { ic: 'descargar',      verbo: 'descargó' },
    'descargar-zip':      { ic: 'paquete',        verbo: 'descargó la carpeta (ZIP)' },
    'subir-archivo':      { ic: 'subir',          verbo: 'subió' },
    'eliminar-archivo':   { ic: 'eliminar',       verbo: 'eliminó' },
    'crear-carpeta':      { ic: 'carpeta-nueva',  verbo: 'creó la carpeta' },
    'editar-carpeta':     { ic: 'editar',         verbo: 'editó la carpeta' },
    'activar-carpeta':    { ic: 'activar',        verbo: 'activó la carpeta' },
    'desactivar-carpeta': { ic: 'desactivar',     verbo: 'desactivó la carpeta' },
    'eliminar-carpeta':   { ic: 'eliminar',       verbo: 'eliminó la carpeta' },
    'actualizar-estado':  { ic: 'estado',         verbo: 'actualizó el estado de' }
};
const ROLES_NOTIF = ['cliente', 'acreedor', 'operador'];
let _actividadCache = [];
let _rolNotifActivo = 'cliente';

async function mostrarVistaNotificaciones() {
    if (!ES_ADMIN) return;
    mostrarVista('vista-notificaciones');
    document.getElementById('lista-notificaciones').innerHTML =
        '<p class="pt-nota" style="padding:2rem;">Cargando actividad…</p>';
    _actividadCache = await listarActividad();
    pintarNotificaciones();
}

function cambiarRolNotif(rol) {
    if (!ROLES_NOTIF.includes(rol)) return;
    _rolNotifActivo = rol;
    document.querySelectorAll('#sub-pestanas-notif button').forEach(b =>
        b.classList.toggle('activa', b.dataset.rol === rol));
    pintarNotificaciones();
}

function pintarNotificaciones() {
    const eventos = _actividadCache.filter(e => e.rol === _rolNotifActivo);
    const lista = document.getElementById('lista-notificaciones');
    const vacio = document.getElementById('notificaciones-vacio');

    if (eventos.length === 0) {
        lista.innerHTML = '';
        vacio.hidden = false;
        vacio.textContent = 'Todavía no hay actividad registrada de ' + ETIQUETAS_ROL[_rolNotifActivo].toLowerCase() + 's.';
        return;
    }
    vacio.hidden = true;

    // Agrupar por día para una bitácora más legible
    let html = '';
    let diaActual = '';
    for (const e of eventos) {
        const dia = new Date(e.fecha).toLocaleDateString('es-CO', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
        if (dia !== diaActual) {
            diaActual = dia;
            html += '<p class="pt-notif-dia">' + escaparHtml(dia.charAt(0).toUpperCase() + dia.slice(1)) + '</p>';
        }
        const info = VERBOS_ACCION[e.accion] || { ic: 'adjunto', verbo: e.accion };
        const hora = new Date(e.fecha).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
        html += '<div class="pt-notif">' +
            '<span class="pt-notif__icono">' + icono(info.ic) + '</span>' +
            '<div class="pt-notif__texto">' +
                '<p><strong>' + escaparHtml(e.nombre || e.usuario) + '</strong> ' + escaparHtml(info.verbo) +
                    (e.objetivo ? ' <span class="pt-notif__objetivo">«' + escaparHtml(e.objetivo) + '»</span>' : '') + '</p>' +
                '<p class="pt-notif__hora">' + hora + '</p>' +
            '</div>' +
        '</div>';
    }
    lista.innerHTML = html;
}

async function crearUsuario(evento) {
    evento.preventDefault();
    if (!ES_ADMIN) return;

    const usuario = document.getElementById('nuevo-usuario').value.trim().toLowerCase();
    const nombre = document.getElementById('nuevo-nombre').value.trim();
    const clave = document.getElementById('nueva-clave').value;
    const rol = document.getElementById('nuevo-rol').value;

    if (!usuario || !nombre || clave.length < 8 || !ROLES_VALIDOS.includes(rol)) {
        avisar('Revisa los datos: la contraseña necesita mínimo 8 caracteres.', 'error');
        return;
    }
    const existente = await dbObtener('usuarios', usuario);
    if (existente) {
        avisar('Ya existe un usuario con ese nombre.', 'error');
        return;
    }
    try {
        const aviso = await crearUsuarioDatos(usuario, nombre, rol, clave);
        avisar(aviso || ('Usuario "' + usuario + '" creado.'), aviso ? 'error' : undefined);
    } catch (e) {
        avisar(e.message || 'No se pudo crear el usuario.', 'error');
        return;
    }
    document.getElementById('form-usuario').reset();
    await mostrarVistaUsuarios();
}

/* El último administrador activo no se puede desactivar ni eliminar */
async function esUltimoAdminActivo(nombreUsuario) {
    const objetivo = await dbObtener('usuarios', nombreUsuario);
    if (!objetivo || objetivo.rol !== 'administrador' || objetivo.activo === false) return false;
    const usuarios = await dbTodos('usuarios');
    const adminsActivos = usuarios.filter(u => u.rol === 'administrador' && u.activo !== false);
    return adminsActivos.length <= 1;
}

async function alternarUsuario(nombreUsuario) {
    if (!ES_ADMIN || nombreUsuario === sesion.usuario) return;
    const objetivo = await dbObtener('usuarios', nombreUsuario);
    if (!objetivo) return;

    if (objetivo.activo !== false && await esUltimoAdminActivo(nombreUsuario)) {
        avisar('No puedes desactivar al último administrador activo.', 'error');
        return;
    }
    objetivo.activo = objetivo.activo === false;
    await dbGuardar('usuarios', objetivo);
    avisar(objetivo.activo
        ? 'Usuario "' + nombreUsuario + '" activado: ya puede ingresar.'
        : 'Usuario "' + nombreUsuario + '" desactivado: no podrá ingresar al portal.');
    await mostrarVistaUsuarios();
}

async function eliminarUsuario(nombreUsuario) {
    if (!ES_ADMIN || nombreUsuario === sesion.usuario) return;
    const objetivo = await dbObtener('usuarios', nombreUsuario);
    if (!objetivo) return;

    if (await esUltimoAdminActivo(nombreUsuario)) {
        avisar('No puedes eliminar al último administrador activo.', 'error');
        return;
    }
    if (!confirm('¿Eliminar al usuario "' + nombreUsuario + '"?')) return;
    await dbEliminar('usuarios', nombreUsuario);
    avisar('Usuario eliminado.');
    await mostrarVistaUsuarios();
}

/* ============ EVENTOS ============ */
function conectarEventos() {
    // Delegación: un solo escuchador para todos los botones con data-accion
    document.addEventListener('click', (evento) => {
        const boton = evento.target.closest('[data-accion]');
        if (!boton) return;
        const id = Number(boton.dataset.id);

        switch (boton.dataset.accion) {
            case 'salir':             cerrarSesion(); break;
            case 'salir-sitio':       cerrarSesion('../index.html'); break; // volver al sitio cierra la sesión
            case 'ver-carpetas':      mostrarVistaCarpetas(); break;
            case 'ver-usuarios':      mostrarVistaUsuarios(); break;
            case 'ver-notificaciones':   mostrarVistaNotificaciones(); break;
            case 'refrescar-notificaciones': mostrarVistaNotificaciones(); break;
            case 'notif-rol':         cambiarRolNotif(boton.dataset.rol); break;
            case 'nueva-carpeta':     abrirModalCarpeta(null); break;
            case 'cerrar-modal':      cerrarModalCarpeta(); break;
            case 'abrir-carpeta':     abrirCarpeta(id); break;
            case 'editar-carpeta':    dbObtener('carpetas', id).then(c => c && abrirModalCarpeta(c)); break;
            case 'alternar-carpeta':  alternarCarpeta(id); break;
            case 'eliminar-carpeta':  eliminarCarpeta(id); break;
            case 'ver-archivo':       verArchivo(id); break;
            case 'descargar-archivo': descargarArchivo(id); break;
            case 'eliminar-archivo':  eliminarArchivo(id); break;
            case 'alternar-usuario':  alternarUsuario(boton.dataset.usuario); break;
            case 'eliminar-usuario':  eliminarUsuario(boton.dataset.usuario); break;
            case 'editar-descripcion':   mostrarEditorDescripcion(); break;
            case 'cancelar-descripcion': ocultarEditorDescripcion(); break;
            case 'descargar-zip':        descargarCarpetaZip(); break;
        }
    });

    document.getElementById('form-carpeta').addEventListener('submit', guardarCarpeta);
    document.getElementById('form-usuario').addEventListener('submit', crearUsuario);
    document.getElementById('form-descripcion').addEventListener('submit', guardarDescripcion);

    // Subida por selector de archivos
    const entrada = document.getElementById('entrada-archivos');
    entrada.addEventListener('change', async () => {
        await subirArchivos([...entrada.files]);
        entrada.value = '';
    });

    // Subida arrastrando y soltando
    const zona = document.getElementById('zona-subida');
    zona.addEventListener('dragover', (e) => { e.preventDefault(); zona.classList.add('arrastrando'); });
    zona.addEventListener('dragleave', () => zona.classList.remove('arrastrando'));
    zona.addEventListener('drop', async (e) => {
        e.preventDefault();
        zona.classList.remove('arrastrando');
        if (e.dataTransfer && e.dataTransfer.files.length > 0) {
            await subirArchivos([...e.dataTransfer.files]);
        }
    });

    // Cerrar el modal al hacer clic fuera de la caja
    document.getElementById('modal-carpeta').addEventListener('click', (e) => {
        if (e.target.id === 'modal-carpeta') cerrarModalCarpeta();
    });
}

/* ============ UTILIDADES ============ */
function escaparHtml(texto) {
    return String(texto).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function extensionDe(nombre) {
    const partes = String(nombre).toLowerCase().split('.');
    return partes.length > 1 ? partes.pop() : '';
}

function iconoArchivo(ext) {
    if (ext === 'pdf' || ext === 'doc' || ext === 'docx') return icono('documento');
    if (ext === 'xls' || ext === 'xlsx') return icono('hoja');
    if (ext === 'png' || ext === 'jpg' || ext === 'jpeg') return icono('imagen');
    if (ext === 'mp3') return icono('audio');
    if (ext === 'mp4') return icono('video');
    return icono('adjunto');
}

function formatoTamano(bytes) {
    if (!bytes && bytes !== 0) return '—';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
}

function formatoFecha(marca) {
    if (!marca) return '—';
    return new Date(marca).toLocaleString('es-CO', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });
}

let toastTemporizador = null;
function avisar(mensaje, tipo) {
    const toast = document.getElementById('toast');
    if (!toast) { console.warn('Aviso (sin toast):', mensaje); return; }
    toast.textContent = mensaje;
    toast.className = 'pt-toast visible' + (tipo === 'error' ? ' pt-toast--error' : '');
    clearTimeout(toastTemporizador);
    toastTemporizador = setTimeout(() => toast.classList.remove('visible'), 4000);
}
