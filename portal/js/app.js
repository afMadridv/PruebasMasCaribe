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
const ROLES_VALIDOS = ['administrador', 'monitor', 'operador', 'cliente', 'acreedor'];
const sesion = sesionActual();
if (!sesion) {
    location.replace('index.html');
} else if (!ROLES_VALIDOS.includes(sesion.rol)) {
    cerrarSesion(); // sesión de una versión anterior del portal
}

const EXTENSIONES_PERMITIDAS = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'png', 'jpg', 'jpeg', 'mp3', 'mp4'];
// Vista dentro del portal: PDF/imágenes/audio/video en visor nativo; Word y
// Excel se renderizan con librerías (docx-preview y SheetJS), ver verArchivo.
const EXTENSIONES_VISTA = ['pdf', 'png', 'jpg', 'jpeg', 'mp3', 'mp4', 'doc', 'docx', 'xls', 'xlsx'];
const TAMANO_MAXIMO = 100 * 1024 * 1024; // 100 MB

const SESION_VALIDA = !!(sesion && ROLES_VALIDOS.includes(sesion.rol));
const ES_ADMIN = SESION_VALIDA && sesion.rol === 'administrador';
// Monitor: ve TODO como el administrador (menos la pestaña de usuarios)
// pero no puede crear, editar ni eliminar nada.
const ES_MONITOR = SESION_VALIDA && sesion.rol === 'monitor';
const ES_SUPERVISION = ES_ADMIN || ES_MONITOR; // vistas globales (Estados, Calendario, Notificaciones)
const ES_OPERADOR = SESION_VALIDA && sesion.rol === 'operador';
const ES_PERSONAL = ES_ADMIN || ES_OPERADOR; // ven estados y suben archivos
const ES_CLIENTE = SESION_VALIDA && sesion.rol === 'cliente';
const ES_ACREEDOR = SESION_VALIDA && sesion.rol === 'acreedor';

/* ¿Puede este usuario ver esta carpeta?
   El administrador ve todo (incluidas las desactivadas).
   El operador SOLO ve sus carpetas mientras estén ACTIVAS.
   Cliente/acreedor: sus carpetas activas asignadas. */
function puedeVerCarpeta(c) {
    if (ES_ADMIN || ES_MONITOR) return true; // el monitor ve todas (solo lectura)
    if (ES_OPERADOR) return c.activa && (c.operadores || []).includes(sesion.usuario);
    return c.activa && (c.asignados || []).includes(sesion.usuario);
}

let carpetaAbierta = null;   // carpeta mostrada en la vista de detalle
let carpetaEditando = null;  // carpeta cargada en el modal (null = crear)
let nombrePorUsuario = {};   // usuario → nombre visible (para las tarjetas)
let _carpetasVisibles = [];  // carpetas que el usuario puede ver (ya filtradas por rol)
let _conteoArchivos = {};    // carpetaId → nº de archivos
let _procesosPorCarpeta = {}; // carpetaId → procesos del trámite (semáforos)
let _filtroCarpetas = 'activas'; // sección activa del administrador: 'activas' | 'desactivadas'
let _busquedaCarpetas = '';      // texto del buscador de carpetas
let _busquedaEstados = '';       // texto del buscador de la pestaña Estados

/* Filtra carpetas/trámites por nombre o por nombre del operador */
function filtrarPorBusqueda(carpetas, texto) {
    const q = String(texto || '').trim().toLowerCase();
    if (!q) return carpetas;
    return carpetas.filter(c =>
        (c.nombre || '').toLowerCase().includes(q) ||
        (c.operadores || []).some(o => (nombreDe(o) || '').toLowerCase().includes(q) || String(o).toLowerCase().includes(q)));
}

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
    pintarLeyes();
    await mostrarVistaCarpetas();
    // Recordatorios personales vigentes: ventana emergente en la esquina
    mostrarRecordatoriosVigentes();
    // Chat de soporte flotante + tiempo real + llamadas entrantes
    iniciarSoporte();
    // Campana de notificaciones (todos los roles)
    iniciarCampana();
    // Primer ingreso de cliente/acreedor: consentimiento de datos (bloqueante)
    verificarConsentimiento();
    // Trámites cerrados: recordar en cada ingreso el plazo para descargar
    avisarCierresPendientes();
    // Marca de última conexión + presencia en tiempo real (En línea / Desconectado)
    registrarConexion();
    presenciaIniciar((enLinea) => {
        _usuariosEnLinea = enLinea || new Set();
        pintarEstadoConexion();
    });
    // El botón "atrás" del navegador no debe sacar del portal
    instalarAtrasSeguro();
    // Aviso del navegador al cerrar la pestaña (Decreto 0042 de 2026)
    instalarAvisoCierre();
    // Aviso de ingreso en la campana (fecha y hora), como el de "nuevo dispositivo"
    avisarIngresoEnCampana();
}

/* ============ CIERRE DE SESIÓN CON CONFIRMACIÓN (Decreto 0042 de 2026) ============
   Ningún usuario cierra sesión por accidente: se confirma al pulsar el botón, y
   el navegador advierte si intenta cerrar la pestaña o salir del portal. */
let _cerrandoSesion = false;   // al confirmar la salida, se desactiva el aviso de beforeunload

async function confirmarSalida(destino) {
    if (!await confirmarPortal(
        'Estás a punto de finalizar tu sesión segura bajo los lineamientos del ' +
        'Decreto 0042 de 2026. ¿Deseas confirmar y salir del portal?',
        'Cerrar sesión')) return;
    _cerrandoSesion = true;   // salida intencional: no dispares el aviso del navegador
    cerrarSesion(destino);    // limpia los tokens de Supabase y redirige al login
}

function instalarAvisoCierre() {
    window.addEventListener('beforeunload', (e) => {
        if (_cerrandoSesion) return;               // el usuario ya confirmó la salida
        if (!sesionActual()) return;               // sin sesión, nada que advertir
        e.preventDefault();
        e.returnValue = '';                        // el navegador muestra su diálogo estándar
        return '';
    });
}

/* ============ BOTÓN "ATRÁS" DEL NAVEGADOR ============
   No saca del portal: cierra lo que esté abierto encima, o vuelve de la
   carpeta al listado principal, y solo en la vista principal ofrece salir
   (previa confirmación). Se mantiene una "trampa" en el historial. */
function instalarAtrasSeguro() {
    history.pushState({ portal: true }, '');
    window.addEventListener('popstate', async () => {
        history.pushState({ portal: true }, ''); // re-armar para el próximo "atrás"

        // 1) cerrar el modal o panel que esté abierto encima
        const modal = [...document.querySelectorAll('.pt-modal')].find(m => !m.hidden);
        if (modal) { modal.hidden = true; return; }
        const campana = document.getElementById('campana-dropdown');
        if (campana && !campana.hidden) { campana.hidden = true; return; }
        const soporte = document.getElementById('soporte-panel');
        if (soporte && !soporte.hidden) { minimizarSoporte(); return; }

        // 2) si NO estamos en el listado de carpetas (portal principal),
        //    volver a él: desde una carpeta o desde otra pestaña
        if (document.getElementById('vista-carpetas').hidden) { mostrarVistaCarpetas(); return; }

        // 3) ya en el portal principal: confirmar antes de cerrar sesión
        if (await confirmarPortal('¿Quieres cerrar sesión y salir del portal?', 'Salir del portal')) {
            cerrarSesion();
        }
    });
}

/* ============ PRESENCIA: EN LÍNEA / DESCONECTADO ============ */
let _usuariosEnLinea = new Set();

function puntoConexion(usuario) {
    const en = _usuariosEnLinea.has(usuario);
    return '<span class="pt-conexion' + (en ? ' pt-conexion--en-linea' : '') + '" data-usuario-conexion="' + escaparHtml(usuario) + '"' +
        ' title="' + (en ? 'En línea' : 'Desconectado') + '"></span> ' + (en ? 'En línea' : 'Desconectado');
}

/* Actualiza los indicadores ya pintados sin recargar la tabla */
function pintarEstadoConexion() {
    document.querySelectorAll('[data-usuario-conexion]').forEach(el => {
        const en = _usuariosEnLinea.has(el.dataset.usuarioConexion);
        el.classList.toggle('pt-conexion--en-linea', en);
        el.title = en ? 'En línea' : 'Desconectado';
        if (el.nextSibling && el.nextSibling.nodeType === 3) el.nextSibling.textContent = ' ' + (en ? 'En línea' : 'Desconectado');
    });
}

/* ============ GENERADOR DE CREDENCIALES (formulario de usuarios) ============
   Contraseña de 12 caracteres con mayúsculas, minúsculas, números y un
   símbolo garantizados, usando crypto.getRandomValues (API criptográfica
   del navegador). Se muestra en texto plano para copiarla antes de guardar. */
function generarClaveSegura() {
    const azar = (letras, n) => Array.from(crypto.getRandomValues(new Uint32Array(n)))
        .map(x => letras[x % letras.length]).join('');
    return azar('abcdefghjkmnpqrstuvwxyz', 5) + azar('ABCDEFGHJKMNPQRSTUVWXYZ', 3) +
        azar('23456789', 3) + azar('!#$%*+', 1);
}

function generarCredenciales() {
    const azar = (letras, n) => Array.from(crypto.getRandomValues(new Uint32Array(n)))
        .map(x => letras[x % letras.length]).join('');
    const usuario = 'usuario' + azar('0123456789', 4);
    const clave = generarClaveSegura();
    document.getElementById('nuevo-usuario').value = usuario;
    document.getElementById('nueva-clave').value = clave;
    avisar('Credenciales generadas: ' + usuario + ' / ' + clave + ' — cópialas antes de guardar.');
}

/* Botón "Generar contraseña segura" del modal Editar usuario */
function generarClaveEditar() {
    const clave = generarClaveSegura();
    document.getElementById('editar-clave').value = clave; // visible en texto plano
    avisar('Contraseña generada: ' + clave + ' — cópiala antes de guardar.');
}

/* ============ MENÚ LATERAL: LEYES DE INSOLVENCIA ============
   Marco legal colombiano de insolvencia y conciliación. Cada enlace
   abre el texto oficial en la página de la Secretaría del Senado
   (rama legislativa) en una pestaña nueva. */
const LEYES_INSOLVENCIA = [
    { n: 'Ley 1116 de 2006', d: 'Régimen de insolvencia empresarial', url: 'http://www.secretariasenado.gov.co/senado/basedoc/ley_1116_2006.html' },
    { n: 'Ley 1564 de 2012', d: 'Código General del Proceso (insolvencia de persona natural no comerciante)', url: 'http://www.secretariasenado.gov.co/senado/basedoc/ley_1564_2012.html' },
    { n: 'Ley 2445 de 2025', d: 'Reforma al régimen de insolvencia de persona natural', url: 'http://www.secretariasenado.gov.co/senado/basedoc/ley_2445_2025.html' },
    { n: 'Ley 550 de 1999', d: 'Reactivación empresarial y reestructuración', url: 'http://www.secretariasenado.gov.co/senado/basedoc/ley_0550_1999.html' },
    { n: 'Ley 222 de 1995', d: 'Régimen de procesos concursales', url: 'http://www.secretariasenado.gov.co/senado/basedoc/ley_0222_1995.html' },
    { n: 'Ley 1676 de 2013', d: 'Garantías mobiliarias', url: 'http://www.secretariasenado.gov.co/senado/basedoc/ley_1676_2013.html' },
    { n: 'Ley 2069 de 2020', d: 'Emprendimiento', url: 'http://www.secretariasenado.gov.co/senado/basedoc/ley_2069_2020.html' },
    { n: 'Decreto 560 de 2020', d: 'Medidas de insolvencia (emergencia)', url: 'http://www.secretariasenado.gov.co/senado/basedoc/decreto_0560_2020.html' },
    { n: 'Decreto 772 de 2020', d: 'Insolvencia de pequeñas empresas', url: 'http://www.secretariasenado.gov.co/senado/basedoc/decreto_0772_2020.html' },
    { n: 'Estatuto Tributario', d: 'Decreto 624 de 1989', url: 'http://www.secretariasenado.gov.co/senado/basedoc/estatuto_tributario.html' }
];

function pintarLeyes() {
    const cont = document.getElementById('lista-leyes');
    if (!cont) return;
    cont.innerHTML = LEYES_INSOLVENCIA.map(l =>
        '<a class="pt-ley" href="' + l.url + '" target="_blank" rel="noopener noreferrer" title="Abrir el texto oficial en una pestaña nueva">' +
            '<span class="pt-ley__ic">' + icono('documento', 18) + '</span>' +
            '<span class="pt-ley__txt"><strong>' + escaparHtml(l.n) + '</strong>' +
            '<span>' + escaparHtml(l.d) + '</span></span>' +
        '</a>').join('');
}

function pintarEncabezado() {
    const chip = document.getElementById('chip-usuario');
    chip.innerHTML = escaparHtml(sesion.nombre) +
        ' <span class="pt-insignia pt-insignia--rol">' + escaparHtml(ETIQUETAS_ROL[sesion.rol] || sesion.rol) + '</span>';
    // Estados: personal (operador gestiona los suyos) y supervisión (admin/monitor ven todo)
    document.getElementById('pestana-estados').hidden = !(ES_PERSONAL || ES_MONITOR);
    // Calendario: supervisión (todo) y operador (sus carpetas + recordatorios)
    document.getElementById('pestana-calendario').hidden = !(ES_SUPERVISION || ES_OPERADOR);
    document.getElementById('pestana-usuarios').hidden = !ES_ADMIN; // el monitor NUNCA la ve
    document.getElementById('pestana-notificaciones').hidden = !ES_SUPERVISION;
    document.getElementById('boton-nueva-carpeta').hidden = !ES_ADMIN;
}

/* ============ NAVEGACIÓN ENTRE VISTAS ============ */
function mostrarVista(idVista) {
    for (const id of ['vista-carpetas', 'vista-carpeta', 'vista-estados', 'vista-calendario', 'vista-usuarios', 'vista-notificaciones']) {
        const el = document.getElementById(id);
        if (el) el.hidden = (id !== idVista);
    }
    // El detalle de carpeta usa columnas extra: se amplía el contenedor
    const contenido = document.querySelector('.pt-contenido');
    if (contenido) contenido.classList.toggle('pt-contenido--ancha', idVista === 'vista-carpeta');
    document.getElementById('pestana-carpetas').classList.toggle('activa', idVista === 'vista-carpetas' || idVista === 'vista-carpeta');
    document.getElementById('pestana-estados').classList.toggle('activa', idVista === 'vista-estados');
    document.getElementById('pestana-calendario').classList.toggle('activa', idVista === 'vista-calendario');
    document.getElementById('pestana-usuarios').classList.toggle('activa', idVista === 'vista-usuarios');
    document.getElementById('pestana-notificaciones').classList.toggle('activa', idVista === 'vista-notificaciones');
    // El refresco automático de "Estados" solo corre mientras la vista está abierta
    if (idVista !== 'vista-estados') detenerAutoRefrescoEstados();
    // El chat flotante de la carpeta solo existe dentro de la carpeta
    if (idVista !== 'vista-carpeta') {
        const seccionChat = document.getElementById('pt-chats');
        const burbujaChat = document.getElementById('chat-carpeta-burbuja');
        if (seccionChat) seccionChat.hidden = true;
        if (burbujaChat) burbujaChat.hidden = true;
    }
}

/* ============ VISTA: LISTA DE CARPETAS ============ */
async function mostrarVistaCarpetas() {
    mostrarVista('vista-carpetas');
    carpetaAbierta = null;

    // Todo en paralelo. El nº de documentos y el peso YA vienen cacheados en
    // cada carpeta (columnas total_archivos / peso_total_mb, actualizadas por
    // trigger al subir/eliminar): ya no se descargan TODOS los metadatos de
    // archivos solo para contar.
    const [todas, procesos, usuarios] = await Promise.all([
        dbTodos('carpetas'),
        procesosTodos().catch(() => []),
        ES_SUPERVISION ? dbTodos('usuarios') : Promise.resolve(null)
    ]);
    if (usuarios) {
        nombrePorUsuario = {};
        for (const u of usuarios) nombrePorUsuario[u.usuario] = u.nombre;
    }
    const visibles = todas.filter(puedeVerCarpeta);
    visibles.sort((a, b) => b.fecha - a.fecha);

    _conteoArchivos = {};
    for (const c of visibles) _conteoArchivos[c.id] = c.totalArchivos || 0;
    _procesosPorCarpeta = {};
    for (const p of procesos) (_procesosPorCarpeta[p.carpetaId] = _procesosPorCarpeta[p.carpetaId] || []).push(p);
    _carpetasVisibles = visibles;

    pintarCarpetasSegunFiltro();
}

/* Pinta la lista de carpetas según el filtro activo. Solo el administrador ve
   las dos secciones (Activas / Desactivadas); los demás solo ven sus carpetas
   activas asignadas, así que no se les muestra el conmutador. */
function pintarCarpetasSegunFiltro() {
    const barra = document.getElementById('sub-pestanas-carpetas');
    const lista = document.getElementById('lista-carpetas');
    const vacio = document.getElementById('carpetas-vacio');

    const activas = _carpetasVisibles.filter(c => c.activa);
    const desactivadas = _carpetasVisibles.filter(c => !c.activa);

    if (ES_SUPERVISION) {
        barra.hidden = false;
        barra.innerHTML =
            '<button class="' + (_filtroCarpetas === 'activas' ? 'activa' : '') + '" data-accion="filtro-carpetas" data-filtro="activas">' +
                icono('carpeta', 17) + ' Activas (' + activas.length + ')</button>' +
            '<button class="' + (_filtroCarpetas === 'desactivadas' ? 'activa' : '') + '" data-accion="filtro-carpetas" data-filtro="desactivadas">' +
                icono('desactivar', 17) + ' Desactivadas (' + desactivadas.length + ')</button>';
    } else {
        barra.hidden = true;
    }

    let mostradas = ES_SUPERVISION
        ? (_filtroCarpetas === 'desactivadas' ? desactivadas : activas)
        : _carpetasVisibles;
    mostradas = filtrarPorBusqueda(mostradas, _busquedaCarpetas);

    lista.innerHTML = mostradas.map(c => tarjetaCarpeta(c, _conteoArchivos[c.id] || 0)).join('');
    vacio.hidden = mostradas.length > 0;
    vacio.textContent = ES_SUPERVISION
        ? (_filtroCarpetas === 'desactivadas'
            ? 'No hay carpetas desactivadas.'
            : 'No hay carpetas activas. Crea una con el botón "+ Nueva carpeta".')
        : (ES_OPERADOR
            ? 'No tienes carpetas asignadas como operador. El administrador debe asignarte a un proceso.'
            : 'Todavía no tienes carpetas asignadas. Comunícate con la fundación.');
}

function cambiarFiltroCarpetas(filtro) {
    if (filtro !== 'activas' && filtro !== 'desactivadas') return;
    _filtroCarpetas = filtro;
    pintarCarpetasSegunFiltro();
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

    // Estado del trámite en la tarjeta: proceso actual + semáforo por días hábiles
    const etapaHtml = '<p class="pt-carpeta__etapa">' +
        resumenSemaforoCarpeta(c, _procesosPorCarpeta[c.id] || []) + '</p>';

    return '<article class="pt-carpeta' + (c.activa ? '' : ' pt-carpeta--inactiva') + '">' +
        '<div class="pt-carpeta__cab">' + icono('carpeta') + ((ES_PERSONAL || ES_MONITOR) ? estado : '') + '</div>' +
        '<h3 class="pt-carpeta__nombre">' + escaparHtml(c.nombre) + '</h3>' +
        etapaHtml +
        // Las notas internas solo las ve el personal (y el monitor, en lectura)
        ((ES_PERSONAL || ES_MONITOR) ? '<p class="pt-carpeta__descripcion">' + escaparHtml(c.descripcion || '') + '</p>' : '') +
        '<p class="pt-carpeta__datos">' + totalArchivos + ' documento(s)' +
            (ES_SUPERVISION ? ' · ' + (c.pesoTotalMb || 0).toFixed(2) + ' MB' : '') +
            ((ES_PERSONAL || ES_MONITOR) ? ' · ' + asignados + ' persona(s) asignada(s)' : '') +
            (ES_SUPERVISION ? ' · Operador: ' + (operadores.length ? operadores.map(o => escaparHtml(nombreDe(o))).join(', ') : 'sin asignar') : '') + '</p>' +
        '<div class="pt-carpeta__acciones">' + acciones + '</div>' +
        '</article>';
}

/* ============ SEMÁFORO: HELPERS COMPARTIDOS ============ */
const NOMBRE_SEMAFORO = { verde: 'Al día', naranja: 'Por vencer', rojo: 'Vencido', pausado: 'Pausado' };

function puntoSemaforo(color, tam) {
    return '<span class="pt-semaforo pt-semaforo--' + color + '" style="width:' + (tam || 12) + 'px;height:' + (tam || 12) + 'px;"></span>';
}

/* Proceso "actual" del trámite: el primero NO completado según el orden */
function procesoActualDe(procesos) {
    return (procesos || []).find(p => !p.completado) || null;
}

/* Semáforo de un proceso: el color YA viene calculado del servidor
   (RPC listar_procesos → calcular_semaforo). Aquí solo se lee; si la
   carpeta entera está pausada, se muestra pausado. */
function semaforoEfectivo(p, pausadoCarpeta) {
    if (pausadoCarpeta || p.pausado) return { color: 'pausado', diasRestantes: null };
    return { color: p.semaforo || 'verde', diasRestantes: (p.diasRestantes === undefined ? null : p.diasRestantes) };
}

/* Conteo del TRÁMITE completo (60/90 días hábiles): línea de resumen.
   Los días restantes del trámite son aritmética de fechas (no color). */
function resumenTramite(c) {
    if (c.finalizado) {
        return puntoSemaforo('verde', 10) + ' <strong>Trámite finalizado</strong>' +
            (c.fechaFinTramite ? ' el ' + escaparHtml(formatoFechaDia(c.fechaFinTramite)) : '') +
            resumenCierre(c);
    }
    if (!c.fechaInicioTramite) return null;
    const total = c.diasHabilesTramite || 60;
    if (c.pausado) {
        return puntoSemaforo('pausado', 10) + ' Trámite: en pausa · plazo de ' + total +
            ' días hábiles' + (c.tieneProrroga ? ' (con prórroga)' : '');
    }
    const restantes = c.fechaVencimientoTramite
        ? contarDiasHabiles(fechaISOLocalHabil(), c.fechaVencimientoTramite) : null;
    const vencido = c.fechaVencimientoTramite && c.fechaVencimientoTramite < fechaISOLocalHabil();
    return puntoSemaforo(vencido ? 'rojo' : (restantes !== null && restantes <= 5 ? 'naranja' : 'verde'), 10) +
        ' Trámite: ' + (vencido
            ? '<strong>plazo vencido</strong> el ' + escaparHtml(formatoVencimiento(c.fechaVencimientoTramite))
            : '<strong>' + restantes + '</strong> de ' + total + ' días hábiles restantes · vence el ' +
              escaparHtml(formatoVencimiento(c.fechaVencimientoTramite))) +
        (c.tieneProrroga ? ' · con prórroga' : '');
}

/* Aviso de cada ingreso: por cada trámite finalizado que el usuario todavía
   puede ver, recuerda cuántos días hábiles le quedan para descargar. */
async function avisarCierresPendientes() {
    if (typeof avisosFinTramite !== 'function') return;
    let avisos = [];
    try { avisos = await avisosFinTramite(); } catch (e) { return; }
    avisos.filter(a => a.activa).forEach((a, i) => {
        setTimeout(() => avisar(textoAvisoCierre(a.nombre, a.diasRestantes, a.fechaDesactivacion), 'aviso'),
                   1200 + i * 600);
    });
}

/* Ventana emergente al abrir una carpeta con el trámite ya finalizado */
function mostrarModalCierre(c) {
    if (!c || !c.finalizado || !c.fechaDesactivacion) return;
    if (document.getElementById('modal-cierre-tramite')) return;
    const dias = diasParaCierre(c);
    const caja = document.createElement('div');
    caja.className = 'pt-modal';
    caja.id = 'modal-cierre-tramite';
    caja.innerHTML =
        '<div class="pt-modal__caja">' +
            '<h3>Trámite finalizado</h3>' +
            '<p>' + escaparHtml(textoAvisoCierre(c.nombre, dias, c.fechaDesactivacion)) + '</p>' +
            (c.activa
                ? '<p>La carpeta se desactivará el <strong>' +
                  escaparHtml(formatoFechaDia(c.fechaDesactivacion)) + '</strong>.</p>'
                : '<p>La carpeta ya fue <strong>desactivada</strong>.</p>') +
            '<div class="pt-modal__acciones">' +
                '<button class="pt-boton pt-boton--primario" data-accion="cerrar-modal-cierre">Entendido</button>' +
            '</div>' +
        '</div>';
    document.body.appendChild(caja);
    caja.querySelector('[data-accion="cerrar-modal-cierre"]')
        .addEventListener('click', () => caja.remove());
}

/* Días hábiles que quedan para descargar antes de que la carpeta se desactive.
   Devuelve null si la carpeta no está finalizada o no tiene fecha programada. */
function diasParaCierre(c) {
    if (!c || !c.finalizado || !c.fechaDesactivacion) return null;
    return Math.max(contarDiasHabiles(fechaISOLocalHabil(), c.fechaDesactivacion), 0);
}

/* Complemento de la línea "Trámite finalizado": cuenta regresiva y fecha exacta
   en que la carpeta deja de estar disponible. */
function resumenCierre(c) {
    const dias = diasParaCierre(c);
    if (dias === null) return '';
    const fecha = escaparHtml(formatoFechaDia(c.fechaDesactivacion));
    if (!c.activa) return ' · <strong>carpeta desactivada</strong> el ' + fecha;
    if (dias === 0) return ' · <strong>se desactiva hoy</strong> (' + fecha + ')';
    return ' · quedan <strong>' + dias + '</strong> día' + (dias === 1 ? '' : 's') +
           ' hábil' + (dias === 1 ? '' : 'es') + ' para descargar · se desactiva el ' + fecha;
}

/* Texto único del aviso de cierre, para la notificación y el modal */
function textoAvisoCierre(nombre, dias, fechaISO) {
    const fecha = formatoFechaDia(fechaISO);
    return 'El trámite «' + nombre + '» finalizó. Tienes ' + dias + ' día' + (dias === 1 ? '' : 's') +
        ' hábil' + (dias === 1 ? '' : 'es') + ' (hasta el ' + fecha + ') para descargar los documentos ' +
        'de la carpeta. Después de esa fecha deberás solicitarlos escribiendo al correo de la fundación.';
}

/* Línea de resumen de la tarjeta: proceso actual + color, o estado general */
function resumenSemaforoCarpeta(c, procesos) {
    if (c.pausado) return puntoSemaforo('pausado', 11) + ' <span><strong>Trámite en pausa</strong></span>';
    const actual = procesoActualDe(procesos);
    if (!actual) {
        if ((procesos || []).length > 0) return puntoSemaforo('verde', 11) + ' <span><strong>Todos los procesos completados</strong></span>';
        return icono('estado', 15) + ' <span>Sin procesos definidos todavía</span>';
    }
    const s = semaforoEfectivo(actual, c.pausado);
    const restantes = (s.diasRestantes === null) ? '' :
        s.diasRestantes < 0 ? ' · ' + Math.abs(s.diasRestantes) + ' día(s) hábil(es) de atraso' :
        ' · ' + (s.diasRestantes === 0 ? 'vence HOY' : s.diasRestantes + ' día(s) hábil(es) restantes');
    return puntoSemaforo(s.color, 11) + ' <span><strong>' + escaparHtml(actual.nombre) + '</strong>' +
        ' · ' + NOMBRE_SEMAFORO[s.color] + escaparHtml(restantes) + '</span>';
}

/* "19 de enero (martes)" para los vencimientos */
function formatoVencimiento(iso) {
    const [a, m, d] = String(iso).split('-').map(Number);
    if (!a || !m || !d) return String(iso);
    const f = new Date(a, m - 1, d);
    const dia = f.toLocaleDateString('es-CO', { weekday: 'long' });
    const texto = f.toLocaleDateString('es-CO', { day: 'numeric', month: 'long' }) +
        (a !== new Date().getFullYear() ? ' de ' + a : '');
    return texto + ' (' + dia + ')';
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
    registrarActividad('abrir-carpeta', carpeta.nombre, carpeta.id);

    document.getElementById('detalle-nombre').textContent = carpeta.nombre;
    document.getElementById('detalle-estado').innerHTML = carpeta.activa
        ? '<span class="pt-insignia pt-insignia--activa">Activa</span>'
        : '<span class="pt-insignia pt-insignia--inactiva">Desactivada</span>';

    // Resumen del semáforo del trámite (se gestiona desde la pestaña "Estados")
    pintarSemaforoDetalle(carpeta);

    // Trámite cerrado: recordar el plazo para descargar los documentos
    mostrarModalCierre(carpeta);

    // Notas internas del operador: las ve el personal (y el monitor, en lectura)
    document.getElementById('zona-notas').hidden = !(ES_PERSONAL || ES_MONITOR);
    document.getElementById('detalle-descripcion').textContent = carpeta.descripcion || 'Sin notas internas todavía.';
    document.getElementById('zona-subida').hidden = !puedeGestionarCarpeta(carpeta);
    document.getElementById('boton-editar-descripcion').hidden = !puedeGestionarCarpeta(carpeta);
    document.getElementById('form-descripcion').hidden = true;
    // Generar expediente: solo administrador y operador responsable
    document.getElementById('boton-generar-expediente').hidden = !puedeGestionarCarpeta(carpeta);

    // Sub-pestañas de la carpeta.
    // Siempre se entra por "Archivos": evita abrir otra carpeta directo en
    // otra pestaña por arrastrar el estado de la carpeta anterior.
    _subPanelCarpeta = 'archivos';
    _editandoOrden = false;     // el modo de reordenar no se arrastra entre carpetas
    montarSubPestanasCarpeta(carpeta);
    prepararCalendarioLateral(carpeta); // calendario de audiencias (columna derecha)
    quitarAdjuntoChat(); // adjunto pendiente de otra carpeta no debe arrastrarse
    _chatCarpetaMin = true;   // el chat flotante arranca minimizado en cada carpeta
    _acreedorDestino = '';

    await pintarArchivos();
    await pintarChats();
}

/* ============ RESUMEN DEL SEMÁFORO EN EL DETALLE DE LA CARPETA ============
   Solo lectura: muestra el proceso actual, su vencimiento y la cronología.
   La gestión (completar, pausar, crear procesos) vive en la pestaña "Estados". */
async function pintarSemaforoDetalle(carpeta) {
    const zona = document.getElementById('detalle-semaforo');
    if (!zona) return;
    let procesos = [];
    try { procesos = await procesosListar(carpeta.id); } catch (e) { zona.innerHTML = ''; return; }

    if (carpeta.pausado) {
        zona.innerHTML = '<div class="pt-semaforo-resumen">' + puntoSemaforo('pausado', 14) +
            ' <strong>Trámite en pausa</strong>' +
            (carpeta.fechaPausa ? ' <span class="pt-nota">desde el ' + formatoFechaDia(carpeta.fechaPausa) + '</span>' : '') +
            '</div>';
        return;
    }
    if (procesos.length === 0) { zona.innerHTML = ''; return; }

    const actual = procesoActualDe(procesos);
    let cabeza;
    if (!actual) {
        cabeza = '<div class="pt-semaforo-resumen">' + puntoSemaforo('verde', 14) +
            ' <strong>Todos los procesos completados</strong> <span class="pt-nota">(' + procesos.length + ' en total)</span></div>';
    } else {
        const s = semaforoEfectivo(actual, carpeta.pausado);
        cabeza = '<div class="pt-semaforo-resumen">' + puntoSemaforo(s.color, 14) +
            ' <strong>' + escaparHtml(actual.nombre) + '</strong>' +
            ' <span class="pt-nota">· Vencimiento: ' + escaparHtml(formatoVencimiento(actual.fechaVencimiento)) +
            (s.diasRestantes === null ? '' :
                s.diasRestantes < 0 ? ' · ' + Math.abs(s.diasRestantes) + ' día(s) hábil(es) de atraso'
                : ' · ' + (s.diasRestantes === 0 ? 'vence HOY (último día hábil)' : s.diasRestantes + ' día(s) hábil(es) restantes')) +
            '</span></div>';
    }
    // Cronología compacta de todos los procesos
    const linea = procesos.map(p => {
        const s = semaforoEfectivo(p, carpeta.pausado);
        return '<span class="pt-semaforo-cadena__paso' + (p.completado ? ' hecho' : '') + '" title="' +
            escaparHtml(p.nombre + ' · ' + NOMBRE_SEMAFORO[s.color]) + '">' +
            puntoSemaforo(p.completado ? 'verde' : s.color, 10) + ' ' + escaparHtml(p.nombre) + '</span>';
    }).join('<span class="pt-semaforo-cadena__flecha">→</span>');
    zona.innerHTML = cabeza + '<div class="pt-semaforo-cadena">' + linea + '</div>';
}

/* ============ VISTA: ESTADOS DE LOS TRÁMITES (semáforos) ============
   Operador → gestiona los procesos SOLO de sus trámites (completar, pausar,
   reactivar, crear). Administrador → lo mismo en todos + corrección manual.
   Monitor → ve la tabla global en solo lectura. La vista se refresca sola
   cada 5 minutos mientras esté abierta. */
let _estadosCarpetas = [];        // carpetas visibles en la vista Estados
let _estadosProcesos = {};        // carpetaId → procesos
let _autoRefrescoEstados = null;  // temporizador de recarga (5 min)

function detenerAutoRefrescoEstados() {
    if (_autoRefrescoEstados) { clearInterval(_autoRefrescoEstados); _autoRefrescoEstados = null; }
}

async function mostrarVistaEstados() {
    if (!ES_PERSONAL && !ES_MONITOR) return;
    mostrarVista('vista-estados');
    document.getElementById('estados-nota').textContent = ES_SUPERVISION
        ? 'Semáforos de todos los trámites por días hábiles colombianos (lun–vie, sin festivos). ' +
          (ES_ADMIN ? 'Puedes corregir tiempos y estados: la corrección queda registrada.' : 'Vista de solo lectura.')
        : 'Aquí controlas la etapa de los trámites que tienes a cargo. Los plazos corren en días hábiles colombianos (lun–vie, sin festivos).';
    document.getElementById('contenido-estados').innerHTML =
        '<p class="pt-nota" style="padding:1.5rem 0;">Cargando estados…</p>';
    await cargarYPintarEstados();
    detenerAutoRefrescoEstados();
    _autoRefrescoEstados = setInterval(() => {
        if (!document.getElementById('vista-estados').hidden) cargarYPintarEstados();
    }, 5 * 60 * 1000);
}

async function cargarYPintarEstados() {
    try {
        const [carpetas, procesos] = await Promise.all([dbTodos('carpetas'), procesosTodos()]);
        _estadosCarpetas = carpetas.filter(puedeVerCarpeta).sort((a, b) => b.fecha - a.fecha);
        _estadosProcesos = {};
        for (const p of procesos) (_estadosProcesos[p.carpetaId] = _estadosProcesos[p.carpetaId] || []).push(p);
    } catch (e) {
        document.getElementById('contenido-estados').innerHTML =
            '<div class="pt-vacio">' + escaparHtml((e && e.message) || 'No se pudieron cargar los estados.') + '</div>';
        return;
    }
    pintarEstados();
}

let _filtroEstados = 'activos'; // sub-pestaña del admin/monitor: 'activos' | 'desactivados'

function cambiarFiltroEstados(filtro) {
    if (filtro !== 'activos' && filtro !== 'desactivados') return;
    _filtroEstados = filtro;
    pintarEstados();
}

function pintarEstados() {
    const cont = document.getElementById('contenido-estados');
    if (!cont) return;
    if (_estadosCarpetas.length === 0) {
        cont.innerHTML = '<div class="pt-vacio">' + (ES_OPERADOR
            ? 'No tienes trámites asignados como operador.'
            : 'No hay trámites todavía.') + '</div>';
        return;
    }
    if (!ES_SUPERVISION) {
        // Operador: solo llegan sus carpetas ACTIVAS (RLS); tarjetas de gestión
        cont.innerHTML = filtrarPorBusqueda(_estadosCarpetas, _busquedaEstados).map(tarjetaEstadoTramite).join('') ||
            '<div class="pt-vacio">Sin resultados para la búsqueda.</div>';
        return;
    }
    // Admin/monitor: dos vistas separadas — trámites activos y desactivados
    const activos = _estadosCarpetas.filter(c => c.activa);
    const desactivados = _estadosCarpetas.filter(c => !c.activa);
    const lista = filtrarPorBusqueda(_filtroEstados === 'desactivados' ? desactivados : activos, _busquedaEstados);
    const subTabs =
        '<div class="pt-sub-pestanas" style="margin-bottom:1.2rem;">' +
            '<button class="' + (_filtroEstados === 'activos' ? 'activa' : '') + '" data-accion="filtro-estados" data-filtro="activos">' +
                icono('carpeta', 17) + ' Activos (' + activos.length + ')</button>' +
            '<button class="' + (_filtroEstados === 'desactivados' ? 'activa' : '') + '" data-accion="filtro-estados" data-filtro="desactivados">' +
                icono('desactivar', 17) + ' Desactivados (' + desactivados.length + ')</button>' +
        '</div>';
    cont.innerHTML = subTabs + (lista.length
        ? tablaEstadosGlobal(lista)
        : '<div class="pt-vacio">' + (_busquedaEstados
            ? 'Sin resultados para la búsqueda.'
            : (_filtroEstados === 'desactivados'
                ? 'No hay trámites desactivados.' : 'No hay trámites activos.')) + '</div>');
}

/* ---- Tabla global (administrador y monitor) ---- */
function tablaEstadosGlobal(carpetas) {
    const filas = (carpetas || _estadosCarpetas).map(c => {
        const procesos = _estadosProcesos[c.id] || [];
        const actual = procesoActualDe(procesos);
        const operadores = (c.operadores || []).map(o => escaparHtml(nombreDe(o))).join(', ') || '<span class="pt-nota">sin asignar</span>';
        let semaforo, venc = '—', restantes = '—', procesoNombre = '<span class="pt-nota">sin procesos</span>';
        if (c.pausado) {
            semaforo = puntoSemaforo('pausado', 14) + ' Pausado';
            if (actual) { procesoNombre = escaparHtml(actual.nombre); venc = '<span class="pt-nota">en pausa</span>'; }
        } else if (!actual) {
            semaforo = procesos.length ? puntoSemaforo('verde', 14) + ' Completado' : '<span class="pt-nota">—</span>';
            if (procesos.length) procesoNombre = '<span class="pt-nota">todos completados</span>';
        } else {
            const s = semaforoEfectivo(actual, c.pausado);
            semaforo = puntoSemaforo(s.color, 14) + ' ' + NOMBRE_SEMAFORO[s.color] +
                (actual.semaforoManual && !actual.completado ? ' <span class="pt-nota" title="Fijado a mano por el administrador">(manual)</span>' : '');
            procesoNombre = escaparHtml(actual.nombre);
            venc = escaparHtml(formatoVencimiento(actual.fechaVencimiento));
            restantes = s.diasRestantes === null ? '—'
                : s.diasRestantes < 0 ? '<strong style="color:var(--pt-peligro,#ef4444);">' + s.diasRestantes + '</strong>'
                : String(s.diasRestantes);
        }
        // Conteo del trámite completo (60 días hábiles, 90 con prórroga)
        let conteo;
        if (c.finalizado) {
            conteo = puntoSemaforo('verde', 10) + ' <strong>finalizado</strong>' +
                (c.fechaFinTramite ? ' (' + escaparHtml(c.fechaFinTramite) + ')' : '');
        } else if (!c.fechaInicioTramite) {
            conteo = '<span class="pt-nota">sin iniciar</span>';
        } else if (c.pausado) {
            conteo = puntoSemaforo('pausado', 10) + ' en pausa · ' + (c.diasHabilesTramite || 60) + ' días' +
                (c.tieneProrroga ? ' (prórroga)' : '');
        } else {
            const rt = c.fechaVencimientoTramite ? contarDiasHabiles(fechaISOLocalHabil(), c.fechaVencimientoTramite) : null;
            const vencidoT = c.fechaVencimientoTramite && c.fechaVencimientoTramite < fechaISOLocalHabil();
            conteo = vencidoT
                ? '<strong style="color:var(--pt-peligro,#ef4444);">vencido</strong> (' + (c.diasHabilesTramite || 60) + ' días)'
                : '<strong>' + rt + '</strong> de ' + (c.diasHabilesTramite || 60) +
                  (c.tieneProrroga ? ' <span class="pt-nota">(prórroga)</span>' : '');
        }

        let acciones = '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="detalle-tramite" data-id="' + c.id + '">Ver detalle</button>';
        if (ES_ADMIN && c.finalizado) {
            // trámite cerrado: sin acciones de flujo
        } else if (ES_ADMIN) {
            acciones += ' <button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="nuevo-proceso" data-id="' + c.id + '">+ Proceso</button>' +
                (actual && !c.pausado ? ' <button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="editar-proceso" data-id="' + actual.id + '">Editar</button>' : '') +
                (!c.fechaInicioTramite && !c.pausado
                    ? ' <button class="pt-boton pt-boton--primario pt-boton--mini" data-accion="iniciar-tramite" data-id="' + c.id + '">Iniciar conteo</button>' : '') +
                (c.fechaInicioTramite && !c.tieneProrroga && !c.pausado
                    ? ' <button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="prorroga-tramite" data-id="' + c.id + '">Prórroga 90</button>' : '') +
                (c.pausado
                    ? ' <button class="pt-boton pt-boton--primario pt-boton--mini" data-accion="reactivar-tramite" data-id="' + c.id + '">Reactivar</button>'
                    : ' <button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="pausar-tramite" data-id="' + c.id + '">Pausar</button>') +
                ' <button class="pt-boton pt-boton--peligro pt-boton--mini" data-accion="finalizar-tramite" data-id="' + c.id + '">Fin de trámite</button>';
        }
        return '<tr class="pt-fila-estado" data-accion="detalle-tramite" data-id="' + c.id + '" style="cursor:pointer;">' +
            '<td>' + operadores + '</td>' +
            '<td>' + escaparHtml(c.nombre) + (c.activa ? '' : ' <span class="pt-nota">(desactivada)</span>') + '</td>' +
            '<td>' + procesoNombre + '</td>' +
            '<td>' + semaforo + '</td>' +
            '<td>' + venc + '</td>' +
            '<td>' + restantes + '</td>' +
            '<td>' + conteo + '</td>' +
            '<td><div class="pt-celda-acciones">' + acciones + '</div></td>' +
            '</tr>';
    }).join('');
    return '<div class="pt-tabla-envoltura"><table class="pt-tabla">' +
        '<thead><tr><th>Operador</th><th>Trámite</th><th>Proceso actual</th><th>Semáforo</th><th>Vencimiento</th><th>Días hábiles restantes</th><th>Trámite (60/90)</th><th>Acciones</th></tr></thead>' +
        '<tbody>' + filas + '</tbody></table></div>';
}

/* ---- Tarjeta de gestión por trámite (operador) ---- */
function tarjetaEstadoTramite(c) {
    const procesos = _estadosProcesos[c.id] || [];
    const actual = procesoActualDe(procesos);
    const gestiona = puedeGestionarCarpeta(c) || (ES_OPERADOR && (c.operadores || []).includes(sesion.usuario));

    let cabeceraEstado;
    if (c.pausado) {
        cabeceraEstado = puntoSemaforo('pausado', 14) + ' <strong>Trámite en pausa</strong>' +
            (c.fechaPausa ? ' <span class="pt-nota">desde el ' + formatoFechaDia(c.fechaPausa) + '</span>' : '');
    } else if (!actual) {
        cabeceraEstado = procesos.length
            ? puntoSemaforo('verde', 14) + ' <strong>Todos los procesos completados</strong>'
            : '<span class="pt-nota">Este trámite aún no tiene procesos. Crea el primero.</span>';
    } else {
        const s = semaforoEfectivo(actual, c.pausado);
        cabeceraEstado = puntoSemaforo(s.color, 14) + ' <strong>' + escaparHtml(actual.nombre) + '</strong>' +
            '<span class="pt-nota"> · Vencimiento: ' + escaparHtml(formatoVencimiento(actual.fechaVencimiento)) +
            (s.diasRestantes === null ? '' :
                s.diasRestantes < 0 ? ' · <strong>' + Math.abs(s.diasRestantes) + ' día(s) hábil(es) de atraso</strong>'
                : ' · ' + (s.diasRestantes === 0 ? '<strong>vence HOY (último día hábil)</strong>' : s.diasRestantes + ' día(s) hábil(es) restantes')) +
            '</span>';
    }

    let botones = '';
    if (gestiona && !c.finalizado) {
        if (actual && !c.pausado) {
            botones += '<button class="pt-boton pt-boton--primario pt-boton--mini" data-accion="completar-proceso" data-id="' + actual.id + '">' +
                icono('activar', 15) + ' Marcar como completado</button> ';
        }
        botones += '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="nuevo-proceso" data-id="' + c.id + '">+ Nuevo proceso</button> ';
        if (!c.fechaInicioTramite && !c.pausado) {
            botones += '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="iniciar-tramite" data-id="' + c.id + '">Iniciar conteo (60 días)</button> ';
        }
        // La prórroga también la puede aplicar el operador responsable
        if (c.fechaInicioTramite && !c.tieneProrroga && !c.pausado) {
            botones += '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="prorroga-tramite" data-id="' + c.id + '">Añadir prórroga (90)</button> ';
        }
        botones += c.pausado
            ? '<button class="pt-boton pt-boton--primario pt-boton--mini" data-accion="reactivar-tramite" data-id="' + c.id + '">Reactivar trámite</button>'
            : '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="pausar-tramite" data-id="' + c.id + '">Pausar trámite</button>';
    }

    const lineaTramite = resumenTramite(c);
    return '<article class="pt-estado-tramite-card' + (c.pausado ? ' pt-estado-tramite-card--pausada' : '') + '">' +
        '<div class="pt-estado-tramite-card__cab"><h3>' + escaparHtml(c.nombre) + '</h3>' +
        '<div class="pt-celda-acciones">' + botones + '</div></div>' +
        '<p class="pt-estado-tramite-card__actual">' + cabeceraEstado + '</p>' +
        (lineaTramite ? '<p class="pt-estado-tramite-card__actual pt-nota">' + lineaTramite + '</p>' : '') +
        cronologiaProcesos(c, procesos, gestiona) +
        '</article>';
}

/* Cronología de procesos de un trámite (compartida por tarjeta y modal) */
function cronologiaProcesos(c, procesos, gestiona) {
    if (!procesos.length) return '';
    const filas = procesos.map(p => {
        const s = semaforoEfectivo(p, c.pausado);
        const detalle = p.completado
            ? 'Completado' + (p.fechaCompletado ? ' el ' + formatoFechaDia(p.fechaCompletado) : '')
            : (c.pausado || p.pausado)
                ? 'En pausa · ' + (p.diasRestantesAlPausar ?? '—') + ' día(s) hábil(es) guardado(s)'
                : 'Vence: ' + formatoVencimiento(p.fechaVencimiento) +
                  (s.diasRestantes === null ? '' :
                   s.diasRestantes < 0 ? ' · ' + Math.abs(s.diasRestantes) + ' día(s) de atraso'
                   : ' · faltan ' + s.diasRestantes + ' día(s) hábil(es)');
        let acciones = '';
        if (gestiona && !p.completado && !c.pausado) {
            acciones += '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="completar-proceso" data-id="' + p.id + '">Completar</button> ';
        }
        if (ES_ADMIN) {
            acciones += '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="editar-proceso" data-id="' + p.id + '">Editar</button> ';
        }
        if (gestiona) {
            acciones += '<button class="pt-boton pt-boton--peligro pt-boton--mini" data-accion="eliminar-proceso" data-id="' + p.id + '">Eliminar</button>';
        }
        return '<div class="pt-proceso-fila">' +
            puntoSemaforo(p.completado ? 'verde' : s.color, 12) +
            '<div class="pt-proceso-fila__txt"><strong>' + p.orden + '. ' + escaparHtml(p.nombre) + '</strong>' +
            '<span class="pt-nota">Plazo: ' + p.dias + ' día(s) hábil(es) · ' + escaparHtml(detalle) +
            (p.semaforoManual && !p.completado ? ' · semáforo manual' : '') + '</span></div>' +
            '<div class="pt-celda-acciones">' + acciones + '</div>' +
            '</div>';
    }).join('');
    return '<div class="pt-proceso-lista">' + filas + '</div>';
}

/* ---- Acciones sobre procesos y trámites ---- */
let _carpetaProcesoNuevo = null;

function abrirModalProceso(carpetaId) {
    if (!ES_PERSONAL) return;
    cerrarDetalleTramite();   // si venía del modal de detalle, se cierra para no quedar detrás
    _carpetaProcesoNuevo = carpetaId;
    document.getElementById('proceso-nombre').value = '';
    document.getElementById('proceso-dias').value = '';
    document.getElementById('proceso-venc-previo').textContent = '';
    document.getElementById('modal-proceso').hidden = false;
    document.getElementById('proceso-nombre').focus();
}

function cerrarModalProceso() {
    document.getElementById('modal-proceso').hidden = true;
    _carpetaProcesoNuevo = null;
}

async function crearProcesoDesdeModal(evento) {
    evento.preventDefault();
    if (!ES_PERSONAL || !_carpetaProcesoNuevo) return;
    const nombre = document.getElementById('proceso-nombre').value.trim();
    const dias = Math.floor(Number(document.getElementById('proceso-dias').value));
    if (!nombre) { avisar('El proceso necesita un nombre.', 'error'); return; }
    if (!dias || dias <= 0) { avisar('El plazo en días hábiles debe ser mayor que cero.', 'error'); return; }
    try {
        await procesoCrear(_carpetaProcesoNuevo, { nombre, dias });
        registrarActividad('crear-proceso', nombre + ' (' + dias + ' días hábiles)', _carpetaProcesoNuevo);
        avisar('Proceso creado. Vence el ' + formatoVencimiento(calcularVencimientoHabil(new Date(), dias)) + '.');
    } catch (e) {
        avisar((e && e.message) || 'No se pudo crear el proceso.', 'error');
        return;
    }
    cerrarModalProceso();
    cerrarDetalleTramite(); // si la acción vino del modal de detalle, se cierra
    await cargarYPintarEstados();
}

async function completarProcesoAccion(procesoId) {
    if (!ES_PERSONAL) return;
    if (!await confirmarPortal('¿Marcar este proceso como completado? Esta acción queda registrada.')) return;
    try {
        await procesoCompletar(procesoId);
        registrarActividad('completar-proceso', nombreProceso(procesoId));
        avisar('Proceso marcado como completado.');
    } catch (e) {
        avisar((e && e.message) || 'No se pudo completar el proceso.', 'error');
    }
    cerrarDetalleTramite(); // si la acción vino del modal de detalle, se cierra
    await cargarYPintarEstados();
}

async function eliminarProcesoAccion(procesoId) {
    if (!ES_PERSONAL) return;
    if (!await confirmarPortal('¿Eliminar este proceso del trámite? Esta acción no se puede deshacer.')) return;
    try {
        await procesoEliminar(procesoId);
        registrarActividad('eliminar-proceso', nombreProceso(procesoId));
        avisar('Proceso eliminado.');
    } catch (e) {
        avisar((e && e.message) || 'No se pudo eliminar el proceso.', 'error');
    }
    cerrarDetalleTramite(); // si la acción vino del modal de detalle, se cierra
    await cargarYPintarEstados();
}

async function pausarTramiteAccion(carpetaId) {
    if (!ES_PERSONAL) return;
    const c = _estadosCarpetas.find(x => x.id === carpetaId);
    if (!await confirmarPortal('¿Pausar el trámite' + (c ? ' "' + c.nombre + '"' : '') + '?\n\n' +
        'El reloj de los plazos se detiene: se guardan los días hábiles que le quedan a cada proceso pendiente y se reanudan al reactivar.')) return;
    try {
        await tramitePausar(carpetaId);
        registrarActividad('pausar-tramite', (c && c.nombre) || String(carpetaId), carpetaId);
        avisar('Trámite pausado: los plazos quedan congelados.');
    } catch (e) {
        avisar((e && e.message) || 'No se pudo pausar el trámite.', 'error');
    }
    cerrarDetalleTramite(); // si la acción vino del modal de detalle, se cierra
    await cargarYPintarEstados();
}

async function reactivarTramiteAccion(carpetaId) {
    if (!ES_PERSONAL) return;
    const c = _estadosCarpetas.find(x => x.id === carpetaId);
    if (!await confirmarPortal('¿Reactivar el trámite' + (c ? ' "' + c.nombre + '"' : '') + '?\n\n' +
        'Los vencimientos se recalculan desde hoy con los días hábiles que quedaban al pausar.')) return;
    try {
        await tramiteReactivar(carpetaId);
        registrarActividad('reactivar-tramite', (c && c.nombre) || String(carpetaId), carpetaId);
        avisar('Trámite reactivado: los plazos vuelven a correr.');
    } catch (e) {
        avisar((e && e.message) || 'No se pudo reactivar el trámite.', 'error');
    }
    cerrarDetalleTramite(); // si la acción vino del modal de detalle, se cierra
    await cargarYPintarEstados();
}

/* ---- Conteo del trámite completo: iniciar (60 días) y prórroga (90) ---- */
async function iniciarTramiteAccion(carpetaId) {
    if (!ES_PERSONAL) return;
    const c = _estadosCarpetas.find(x => x.id === carpetaId);
    if (!await confirmarPortal('Confirme el inicio del conteo del trámite' + (c ? ' "' + c.nombre + '"' : '') + '.\n\n' +
        'Corren 60 días hábiles colombianos desde hoy (ampliables a 90 con la prórroga).', 'Iniciar conteo')) return;
    try {
        await tramiteIniciar(carpetaId);
        registrarActividad('iniciar-tramite', (c && c.nombre) || String(carpetaId), carpetaId);
        avisar('Conteo iniciado: 60 días hábiles.');
    } catch (e) {
        avisar((e && e.message) || 'No se pudo iniciar el conteo.', 'error');
    }
    cerrarDetalleTramite();
    await cargarYPintarEstados();
}

/* Fin de trámite: EXCLUSIVO del administrador (el servidor lo exige) */
async function finalizarTramiteAccion(carpetaId) {
    if (!ES_ADMIN) return;
    const c = _estadosCarpetas.find(x => x.id === carpetaId);
    if (!await confirmarPortal('Confirme el FIN del trámite' + (c ? ' "' + c.nombre + '"' : '') + '.\n\n' +
        'El trámite queda cerrado: se detiene el conteo de días hábiles y ya no se podrán iniciar conteos ni aplicar prórrogas. Esta acción queda registrada.', 'Fin de trámite')) return;
    try {
        await tramiteFinalizar(carpetaId);
        registrarActividad('fin-tramite', (c && c.nombre) || String(carpetaId), carpetaId);
        avisar('Trámite finalizado.');
    } catch (e) {
        avisar((e && e.message) || 'No se pudo finalizar el trámite.', 'error');
    }
    cerrarDetalleTramite();
    await cargarYPintarEstados();
}

async function prorrogaTramiteAccion(carpetaId) {
    if (!ES_PERSONAL) return; // admin u operador responsable (el servidor valida)
    const c = _estadosCarpetas.find(x => x.id === carpetaId);
    if (!await confirmarPortal('Confirme la PRÓRROGA del trámite' + (c ? ' "' + c.nombre + '"' : '') + '.\n\n' +
        'El plazo pasa de 60 a 90 días hábiles contados desde la MISMA fecha de inicio. Solo se puede aplicar una vez.', 'Añadir prórroga')) return;
    try {
        await tramiteProrroga(carpetaId);
        registrarActividad('prorroga-tramite', (c && c.nombre) || String(carpetaId), carpetaId);
        avisar('Prórroga aplicada: el trámite ahora tiene 90 días hábiles.');
    } catch (e) {
        avisar((e && e.message) || 'No se pudo aplicar la prórroga.', 'error');
    }
    cerrarDetalleTramite();
    await cargarYPintarEstados();
}

function nombreProceso(procesoId) {
    for (const lista of Object.values(_estadosProcesos)) {
        const p = lista.find(x => x.id === procesoId);
        if (p) return p.nombre;
    }
    return String(procesoId);
}

/* ---- Corrección del administrador (modal editar proceso) ---- */
let _procesoEditandoId = null;

function abrirModalEditarProceso(procesoId) {
    if (!ES_ADMIN) return;
    cerrarDetalleTramite();   // no dejar el modal de detalle detrás
    let proceso = null;
    for (const lista of Object.values(_estadosProcesos)) {
        proceso = lista.find(x => x.id === procesoId) || proceso;
    }
    if (!proceso) return;
    _procesoEditandoId = procesoId;
    document.getElementById('edproc-nombre').value = proceso.nombre;
    document.getElementById('edproc-dias').value = proceso.dias;
    document.getElementById('edproc-vencimiento').value = proceso.fechaVencimiento || '';
    document.getElementById('edproc-completado').value = '';
    document.getElementById('edproc-semaforo').value = proceso.semaforoManual || '';
    document.getElementById('modal-editar-proceso').hidden = false;
}

function cerrarModalEditarProceso() {
    document.getElementById('modal-editar-proceso').hidden = true;
    _procesoEditandoId = null;
}

async function guardarEdicionProceso(evento) {
    evento.preventDefault();
    if (!ES_ADMIN || !_procesoEditandoId) return;
    const cambios = {
        nombre: document.getElementById('edproc-nombre').value.trim() || null,
        dias: Math.floor(Number(document.getElementById('edproc-dias').value)) || null,
        vencimiento: document.getElementById('edproc-vencimiento').value || null,
        semaforo: document.getElementById('edproc-semaforo').value  // '' = automático
    };
    const comp = document.getElementById('edproc-completado').value;
    if (comp === 'true') cambios.completado = true;
    if (comp === 'false') cambios.completado = false;
    try {
        await procesoEditarAdmin(_procesoEditandoId, cambios);
        registrarActividad('corregir-proceso', nombreProceso(_procesoEditandoId));
        avisar('Corrección guardada (quedó registrada con tu usuario).');
    } catch (e) {
        avisar((e && e.message) || 'No se pudo guardar la corrección.', 'error');
        return;
    }
    cerrarModalEditarProceso();
    cerrarDetalleTramite(); // si la acción vino del modal de detalle, se cierra
    await cargarYPintarEstados();
}

/* ---- Modal "Ver detalle" del trámite (admin/monitor) ---- */
function abrirDetalleTramite(carpetaId) {
    if (!ES_SUPERVISION) return;
    const c = _estadosCarpetas.find(x => x.id === carpetaId);
    if (!c) return;
    const procesos = _estadosProcesos[carpetaId] || [];
    const totales = procesos.reduce((s, p) => s + (p.dias || 0), 0);
    const completados = procesos.filter(p => p.completado);
    const hoy = fechaISOLocalHabil();
    const pendiente = procesoActualDe(procesos);
    const restantes = (c.pausado || !pendiente) ? null : contarDiasHabiles(hoy, pendiente.fechaVencimiento);

    let acciones = '';
    if (ES_ADMIN && !c.finalizado) {
        acciones = '<div class="pt-celda-acciones" style="margin:.8rem 0;">' +
            '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="nuevo-proceso" data-id="' + c.id + '">+ Nuevo proceso</button> ' +
            (!c.fechaInicioTramite && !c.pausado
                ? '<button class="pt-boton pt-boton--primario pt-boton--mini" data-accion="iniciar-tramite" data-id="' + c.id + '">Iniciar conteo (60 días)</button> ' : '') +
            (c.fechaInicioTramite && !c.tieneProrroga && !c.pausado
                ? '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="prorroga-tramite" data-id="' + c.id + '">Aplicar prórroga (90 días)</button> ' : '') +
            (c.pausado
                ? '<button class="pt-boton pt-boton--primario pt-boton--mini" data-accion="reactivar-tramite" data-id="' + c.id + '">Reactivar trámite</button>'
                : '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="pausar-tramite" data-id="' + c.id + '">Pausar trámite</button>') +
            ' <button class="pt-boton pt-boton--peligro pt-boton--mini" data-accion="finalizar-tramite" data-id="' + c.id + '">Fin de trámite</button>' +
            '</div>';
    }

    const lineaTramite = resumenTramite(c);
    document.getElementById('detalle-tramite-cuerpo').innerHTML =
        '<h3>' + escaparHtml(c.nombre) + '</h3>' +
        '<p class="pt-nota">Operador(es): ' + ((c.operadores || []).map(o => escaparHtml(nombreDe(o))).join(', ') || 'sin asignar') +
            ' · Estado: ' + (c.activa ? 'activa' : 'desactivada') +
            ' · Pausado: ' + (c.pausado ? 'sí' + (c.fechaPausa ? ' (desde ' + escaparHtml(c.fechaPausa) + ')' : '') : 'no') + '</p>' +
        (lineaTramite
            ? '<p class="pt-nota">' + lineaTramite +
              (c.fechaInicioTramite ? ' · inició el ' + escaparHtml(formatoFechaDia(c.fechaInicioTramite)) : '') + '</p>'
            : '<p class="pt-nota">Conteo del trámite (60/90 días hábiles): sin iniciar.</p>') +
        '<p class="pt-nota">Días hábiles totales de los plazos: <strong>' + totales + '</strong>' +
            ' · Procesos completados: <strong>' + completados.length + ' de ' + procesos.length + '</strong>' +
            (restantes === null ? '' : ' · Días hábiles restantes del proceso actual: <strong>' + restantes + '</strong>') + '</p>' +
        acciones +
        (procesos.length ? cronologiaProcesos(c, procesos, ES_ADMIN) : '<p class="pt-nota">Sin procesos definidos.</p>') +
        '<div class="pt-modal__acciones">' +
            '<button class="pt-boton pt-boton--fantasma" data-accion="cerrar-modal-detalle-tramite">Cerrar</button>' +
        '</div>';
    document.getElementById('modal-detalle-tramite').hidden = false;
}

function cerrarDetalleTramite() {
    document.getElementById('modal-detalle-tramite').hidden = true;
}

/* ============ VISTA: CALENDARIO DE VENCIMIENTOS ============
   Admin/monitor: TODOS los trámites; al hacer clic en una fecha se ve la
   descripción, la fecha Y el operador responsable.
   Operador: calendario general de SUS carpetas: vencimientos de procesos,
   vencimiento del trámite (60/90) y sus recordatorios privados. */
let _mesCalVenc = null;
let _diaCalVencSel = null;
let _recordatoriosCalCache = [];
let _filtroCalOperador = '';   // '' = todos los operadores (panorama general)
let _filtroCalTramite = '';    // '' = todos los trámites

async function mostrarVistaCalendarioVenc() {
    if (!ES_SUPERVISION && !ES_OPERADOR) return;
    mostrarVista('vista-calendario');
    document.getElementById('contenido-calendario-venc').innerHTML =
        '<p class="pt-nota" style="padding:1.5rem 0;">Cargando calendario…</p>';
    try {
        const [carpetas, procesos, recordatorios] = await Promise.all([
            dbTodos('carpetas'),
            procesosTodos(),
            ES_OPERADOR ? recordatoriosMios().catch(() => []) : Promise.resolve([])
        ]);
        _estadosCarpetas = carpetas.filter(puedeVerCarpeta);
        _estadosProcesos = {};
        for (const p of procesos) (_estadosProcesos[p.carpetaId] = _estadosProcesos[p.carpetaId] || []).push(p);
        _recordatoriosCalCache = recordatorios || [];
    } catch (e) {
        document.getElementById('contenido-calendario-venc').innerHTML =
            '<div class="pt-vacio">' + escaparHtml((e && e.message) || 'No se pudo cargar el calendario.') + '</div>';
        return;
    }
    if (!_mesCalVenc) { const hoy = new Date(); _mesCalVenc = new Date(hoy.getFullYear(), hoy.getMonth(), 1); }
    _diaCalVencSel = null;
    pintarCalendarioVenc();
}

/* Color del vencimiento para el calendario (según el estado del proceso) */
function colorVencimiento(c, p) {
    if (p.completado) {
        // verde si se completó a tiempo; rojo apagado si se completó tarde
        return (p.fechaCompletado && p.fechaCompletado <= p.fechaVencimiento) ? 'verde' : 'rojo';
    }
    return semaforoEfectivo(p, c.pausado).color;
}

function pintarCalendarioVenc() {
    const cont = document.getElementById('contenido-calendario-venc');
    if (!cont || !_mesCalVenc) return;
    const anio = _mesCalVenc.getFullYear();
    const mes = _mesCalVenc.getMonth();
    const hoyISO = fechaISOLocalHabil();

    // Filtros del admin/monitor: primero el panorama general (sin filtros) y
    // luego por operador y/o trámite específico para una vista más ordenada.
    let carpetasCal = _estadosCarpetas;
    if (_filtroCalOperador) carpetasCal = carpetasCal.filter(c => (c.operadores || []).includes(_filtroCalOperador));
    if (_filtroCalTramite) carpetasCal = carpetasCal.filter(c => String(c.id) === String(_filtroCalTramite));

    // marcas por día: procesos, vencimiento del trámite (60/90) y, para el
    // operador, sus recordatorios privados
    const porDia = {};
    const marcar = (iso, m) => { if (iso) (porDia[iso] = porDia[iso] || []).push(m); };
    for (const c of carpetasCal) {
        for (const p of (_estadosProcesos[c.id] || [])) {
            marcar(p.fechaVencimiento, { tipo: 'proceso', c, p });
        }
        if (c.fechaVencimientoTramite) marcar(c.fechaVencimientoTramite, { tipo: 'tramite', c });
    }
    for (const r of _recordatoriosCalCache) {
        marcar(r.fechaInicio, { tipo: 'recordatorio', r });
        if (r.fechaFin && r.fechaFin !== r.fechaInicio) marcar(r.fechaFin, { tipo: 'recordatorio', r, fin: true });
    }
    const colorMarca = (m) => m.tipo === 'proceso' ? colorVencimiento(m.c, m.p)
        : m.tipo === 'tramite' ? (m.c.fechaVencimientoTramite < hoyISO ? 'rojo' : 'naranja')
        : 'pausado'; // recordatorios en gris

    // resumen: rojos (vencidos sin completar), naranjas (0–1 día hábil),
    // verdes (completados a tiempo). Respeta los filtros elegidos: sin
    // filtros es el panorama general.
    let rojos = 0, naranjas = 0, verdes = 0;
    for (const c of carpetasCal) {
        for (const p of (_estadosProcesos[c.id] || [])) {
            const col = colorVencimiento(c, p);
            if (p.completado) { if (col === 'verde') verdes++; }
            else if (col === 'rojo') rojos++;
            else if (col === 'naranja') naranjas++;
        }
    }

    const primerDia = (new Date(anio, mes, 1).getDay() + 6) % 7; // lunes = 0
    const diasMes = new Date(anio, mes + 1, 0).getDate();
    let celdas = '';
    for (let i = 0; i < primerDia; i++) celdas += '<span class="pt-calv__dia pt-calv__dia--vacio"></span>';
    for (let d = 1; d <= diasMes; d++) {
        const iso = anio + '-' + String(mes + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
        const noHabil = !esDiaHabil(iso);
        const marcas = porDia[iso] || [];
        const puntos = marcas.slice(0, 4).map(m => puntoSemaforo(colorMarca(m), 8)).join('') +
            (marcas.length > 4 ? '<small>+' + (marcas.length - 4) + '</small>' : '');
        celdas += '<button type="button" class="pt-calv__dia' +
            (noHabil ? ' pt-calv__dia--nohabil' : '') +
            (iso === hoyISO ? ' pt-calv__dia--hoy' : '') +
            (iso === _diaCalVencSel ? ' pt-calv__dia--sel' : '') + '"' +
            ' data-accion="cal-venc-dia" data-fecha="' + iso + '"' +
            (marcas.length ? ' title="' + marcas.length + ' vencimiento(s)"' : (noHabil ? ' title="Día no hábil"' : '')) +
            '><span class="pt-calv__num">' + d + '</span><span class="pt-calv__puntos">' + puntos + '</span></button>';
    }

    // lista del día seleccionado
    let listaDia = '';
    if (_diaCalVencSel) {
        const marcas = porDia[_diaCalVencSel] || [];
        const filaDia = (m) => {
            if (m.tipo === 'proceso') {
                // Para admin/monitor se muestra también el operador responsable
                const responsables = ES_SUPERVISION
                    ? ' · Operador responsable: ' + ((m.c.operadores || []).map(o => nombreDe(o)).join(', ') || 'sin asignar')
                    : '';
                const vencido = colorVencimiento(m.c, m.p) === 'rojo' && !m.p.completado;
                // Estado VENCIDO: la fila entera lleva directo a la carpeta del trámite
                const abre = vencido ? ' data-accion="abrir-carpeta" data-id="' + m.c.id + '" style="cursor:pointer;" title="Abrir la carpeta del trámite"' : '';
                return '<div class="pt-proceso-fila"' + abre + '>' + puntoSemaforo(colorVencimiento(m.c, m.p), 12) +
                    '<div class="pt-proceso-fila__txt"><strong>' + escaparHtml(m.p.nombre) + '</strong>' +
                    '<span class="pt-nota">' + escaparHtml(m.c.nombre) +
                    ' · plazo de ' + m.p.dias + ' día(s) hábil(es) · vence el ' + escaparHtml(formatoFechaDia(m.p.fechaVencimiento)) +
                    (m.p.completado ? ' · completado' + (m.p.fechaCompletado ? ' el ' + escaparHtml(m.p.fechaCompletado) : '') : '') +
                    escaparHtml(responsables) + '</span></div>' +
                    '<div class="pt-celda-acciones">' +
                        (vencido ? '<button class="pt-boton pt-boton--primario pt-boton--mini" data-accion="abrir-carpeta" data-id="' + m.c.id + '">Abrir carpeta</button> ' : '') +
                        (ES_ADMIN ? '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="editar-proceso" data-id="' + m.p.id + '">Editar</button>' : '') +
                    '</div>' +
                    '</div>';
            }
            if (m.tipo === 'tramite') {
                const responsables = ES_SUPERVISION
                    ? ' · Operador responsable: ' + ((m.c.operadores || []).map(o => nombreDe(o)).join(', ') || 'sin asignar')
                    : '';
                return '<div class="pt-proceso-fila">' + puntoSemaforo(colorMarca(m), 12) +
                    '<div class="pt-proceso-fila__txt"><strong>Vencimiento del trámite completo (' + (m.c.diasHabilesTramite || 60) + ' días hábiles)</strong>' +
                    '<span class="pt-nota">' + escaparHtml(m.c.nombre) + escaparHtml(responsables) + '</span></div></div>';
            }
            // recordatorio privado (solo el operador ve los suyos)
            return '<div class="pt-proceso-fila">' + puntoSemaforo('pausado', 12) +
                '<div class="pt-proceso-fila__txt"><strong>Recordatorio' + (m.fin ? ' (termina)' : '') + '</strong>' +
                '<span class="pt-nota">' + escaparHtml(m.r.mensaje) +
                (m.r.carpetaNombre ? ' · ' + escaparHtml(m.r.carpetaNombre) : '') + '</span></div></div>';
        };
        listaDia = '<div class="pt-calv-dia-detalle"><h3>' + escaparHtml(formatoFechaDia(_diaCalVencSel)) + '</h3>' +
            (marcas.length === 0
                ? '<p class="pt-nota">No hay vencimientos este día.</p>'
                : marcas.map(filaDia).join('')) +
            '</div>';
    }

    // Filtros por operador y trámite (solo admin/monitor)
    let filtros = '';
    if (ES_SUPERVISION) {
        const operadoresUnicos = [...new Set(_estadosCarpetas.flatMap(c => c.operadores || []))];
        filtros = '<div class="pt-calv-filtros">' +
            '<label class="pt-nota">Operador: <select id="filtro-cal-operador">' +
                '<option value="">Todos (panorama general)</option>' +
                operadoresUnicos.map(o => '<option value="' + escaparHtml(o) + '"' +
                    (_filtroCalOperador === o ? ' selected' : '') + '>' + escaparHtml(nombreDe(o)) + '</option>').join('') +
            '</select></label>' +
            '<label class="pt-nota">Trámite: <select id="filtro-cal-tramite">' +
                '<option value="">Todos</option>' +
                _estadosCarpetas
                    .filter(c => !_filtroCalOperador || (c.operadores || []).includes(_filtroCalOperador))
                    .map(c => '<option value="' + c.id + '"' +
                        (String(_filtroCalTramite) === String(c.id) ? ' selected' : '') + '>' + escaparHtml(c.nombre) + '</option>').join('') +
            '</select></label>' +
            ((_filtroCalOperador || _filtroCalTramite)
                ? ' <button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="cal-venc-limpiar">Quitar filtros</button>' : '') +
            '</div>';
    }

    cont.innerHTML =
        '<div class="pt-calv-resumen">' +
            '<span>' + puntoSemaforo('rojo', 12) + ' Vencidos sin completar: <strong>' + rojos + '</strong></span>' +
            '<span>' + puntoSemaforo('naranja', 12) + ' Por vencer (0–1 día hábil): <strong>' + naranjas + '</strong></span>' +
            '<span>' + puntoSemaforo('verde', 12) + ' Completados a tiempo: <strong>' + verdes + '</strong></span>' +
        '</div>' +
        filtros +
        '<div class="pt-cal__barra" style="max-width:520px;">' +
            '<button type="button" class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="cal-venc-mes" data-delta="-1" aria-label="Mes anterior">‹</button>' +
            '<strong>' + MESES[mes].charAt(0).toUpperCase() + MESES[mes].slice(1) + ' ' + anio + '</strong>' +
            '<button type="button" class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="cal-venc-mes" data-delta="1" aria-label="Mes siguiente">›</button>' +
        '</div>' +
        '<div class="pt-calv__semana"><span>L</span><span>M</span><span>X</span><span>J</span><span>V</span><span>S</span><span>D</span></div>' +
        '<div class="pt-calv__rejilla">' + celdas + '</div>' +
        '<p class="pt-nota" style="margin-top:.6rem;">Los días grises son fines de semana o festivos colombianos. Haz clic en un día para ver sus vencimientos.</p>' +
        listaDia;

    // listeners de los filtros (se recrean con cada render)
    const selOp = document.getElementById('filtro-cal-operador');
    if (selOp) selOp.addEventListener('change', () => {
        _filtroCalOperador = selOp.value;
        _filtroCalTramite = '';   // el filtro de trámite se reinicia al cambiar de operador
        _diaCalVencSel = null;
        pintarCalendarioVenc();
    });
    const selTr = document.getElementById('filtro-cal-tramite');
    if (selTr) selTr.addEventListener('change', () => {
        _filtroCalTramite = selTr.value;
        _diaCalVencSel = null;
        pintarCalendarioVenc();
    });
}

function cambiarMesCalVenc(delta) {
    if (!_mesCalVenc) return;
    _mesCalVenc = new Date(_mesCalVenc.getFullYear(), _mesCalVenc.getMonth() + Number(delta || 0), 1);
    _diaCalVencSel = null;
    pintarCalendarioVenc();
}

/* ============ CHATS DEL TRÁMITE (cliente↔operador, acreedor↔operador) ============
   El cliente ve solo su chat; el acreedor solo el suyo; operador y admin ven
   ambos. El acceso real lo valida el servidor (RLS); aquí solo se muestra. */
const CANALES_CHAT = { cliente: 'Cliente ↔ operador', acreedor: 'Acreedor ↔ operador' };
let _canalChat = null;

function canalesAccesibles() {
    if (ES_PERSONAL || ES_MONITOR) return ['cliente', 'acreedor']; // el monitor solo LEE
    if (sesion.rol === 'cliente') return ['cliente'];
    if (sesion.rol === 'acreedor') return ['acreedor'];
    return [];
}

/* El chat de la carpeta vive ANCLADO en la esquina (como el de soporte):
   minimizado queda como burbuja con contador de no leídos. */
let _chatCarpetaMin = true;      // arranca minimizado (burbuja)
let _acreedorDestino = '';       // '' = todos; uuid = hilo con UN acreedor

function pintarVisibilidadChatCarpeta(hayCanales) {
    const seccion = document.getElementById('pt-chats');
    const burbuja = document.getElementById('chat-carpeta-burbuja');
    const enCarpeta = carpetaAbierta && !document.getElementById('vista-carpeta').hidden;
    if (!hayCanales || !enCarpeta) { seccion.hidden = true; burbuja.hidden = true; return; }
    seccion.hidden = _chatCarpetaMin;
    burbuja.hidden = !_chatCarpetaMin;
}

function abrirChatCarpeta() {
    _chatCarpetaMin = false;
    pintarVisibilidadChatCarpeta(canalesAccesibles().length > 0);
    pintarMensajes();
}

function minimizarChatCarpeta() {
    _chatCarpetaMin = true;
    pintarVisibilidadChatCarpeta(canalesAccesibles().length > 0);
}

async function pintarChats() {
    const seccion = document.getElementById('pt-chats');
    if (!seccion || !carpetaAbierta) return;
    const canales = canalesAccesibles();
    pintarVisibilidadChatCarpeta(canales.length > 0);
    if (canales.length === 0) return;
    // El monitor lee los chats pero no escribe: se oculta la caja de envío
    document.getElementById('form-mensaje').hidden = ES_MONITOR;
    if (!canales.includes(_canalChat)) _canalChat = canales[0];
    await pintarSelectorAcreedor();

    const tabs = document.getElementById('chat-tabs');
    tabs.hidden = canales.length < 2;   // con un solo canal no hace falta la barra
    tabs.innerHTML = canales.map(c =>
        '<button class="' + (c === _canalChat ? 'activa' : '') + '" data-accion="chat-canal" data-canal="' + c + '">' +
        escaparHtml(CANALES_CHAT[c]) + '</button>').join('');
    pintarBadgesChats();   // badge rojo de no leídos por canal

    await pintarMensajes();
}

function cambiarCanal(canal) {
    if (!canalesAccesibles().includes(canal)) return;
    quitarAdjuntoChat(); // el adjunto pendiente no debe saltar a otro canal
    _canalChat = canal;
    _acreedorDestino = '';
    document.querySelectorAll('#chat-tabs button').forEach(b =>
        b.classList.toggle('activa', b.dataset.canal === canal));
    pintarSelectorAcreedor().then(() => pintarMensajes());
}

/* Selector "¿con qué acreedor?" (solo personal de la carpeta, canal acreedor):
   permite conversar con UN acreedor en particular o con todos. */
async function pintarSelectorAcreedor() {
    const cont = document.getElementById('chat-destinatario');
    if (!cont) return;
    const gestiona = carpetaAbierta && puedeGestionarCarpeta(carpetaAbierta);
    if (!gestiona || _canalChat !== 'acreedor') { cont.hidden = true; cont.innerHTML = ''; return; }
    try {
        if (!_asignadosCache.length || _asignadosCache._carpeta !== carpetaAbierta.id) {
            _asignadosCache = await asignadosDeCarpeta(carpetaAbierta.id);
            _asignadosCache._carpeta = carpetaAbierta.id;
        }
    } catch (e) { cont.hidden = true; return; }
    const acreedores = _asignadosCache.filter(p => p.rol === 'acreedor');
    if (acreedores.length === 0) { cont.hidden = true; cont.innerHTML = ''; return; }
    cont.hidden = false;
    cont.innerHTML = '<label class="pt-nota">Conversar con: ' +
        '<select id="select-acreedor-destino">' +
        '<option value="">Todos los acreedores</option>' +
        acreedores.map(a => '<option value="' + escaparHtml(a.id) + '"' +
            (_acreedorDestino === a.id ? ' selected' : '') + '>' + escaparHtml(a.nombre) + '</option>').join('') +
        '</select></label>';
    document.getElementById('select-acreedor-destino').addEventListener('change', (e) => {
        _acreedorDestino = e.target.value;
        pintarMensajes();
    });
}

async function pintarMensajes() {
    if (!carpetaAbierta || !_canalChat) return;
    const cont = document.getElementById('chat-mensajes');
    let mensajes = await mensajesListar(carpetaAbierta.id, _canalChat);
    // Hilo con UN acreedor (personal): lo suyo, lo dirigido a él y los avisos
    // del personal "para todos"
    if (_canalChat === 'acreedor' && _acreedorDestino) {
        mensajes = mensajes.filter(m =>
            m.perfilId === _acreedorDestino ||
            m.destinatarioId === _acreedorDestino ||
            (!m.destinatarioId && ['operador', 'administrador'].includes(m.rol)));
    }
    cont.innerHTML = mensajes.length
        ? mensajes.map(filaMensaje).join('')
        : '<p class="pt-chat-vacio">Aún no hay mensajes en este chat.</p>';
    cont.scrollTop = cont.scrollHeight;
    // Al ver el canal, sus mensajes quedan leídos (validado en el servidor)
    if (typeof marcarLeidosCanal === 'function') {
        marcarLeidosCanal(carpetaAbierta.id, _canalChat)
            .then(() => refrescarNoLeidos())
            .catch(() => {});
    }
}

function filaMensaje(m) {
    const mio = m.autorUsuario && m.autorUsuario === sesion.usuario;
    const rolEtq = ETIQUETAS_ROL[m.rol] || m.rol || '';
    // Adjunto opcional del mensaje (todos los participantes del canal pueden enviarlos)
    let adjunto = '';
    if (m.archivoNombre) {
        adjunto = '<div class="pt-chat-msg__adjunto">' +
            '<span class="pt-icono-archivo">' + iconoArchivo(extensionDe(m.archivoNombre)) + '</span>' +
            '<span class="pt-chat-msg__adjunto-info">' + escaparHtml(m.archivoNombre) +
                '<small>' + formatoTamano(m.archivoTamano) + '</small></span>' +
            '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="descargar-adjunto" data-id="' + m.id + '">Descargar</button>' +
            '</div>';
    }
    return '<div class="pt-chat-msg' + (mio ? ' pt-chat-msg--mio' : '') + '">' +
        '<div class="pt-chat-msg__meta"><strong>' + escaparHtml(m.autorNombre || m.autorUsuario || '—') + '</strong>' +
        (rolEtq ? ' · ' + escaparHtml(rolEtq) : '') + ' · ' + formatoFecha(m.fecha) + '</div>' +
        (m.texto ? '<div class="pt-chat-msg__texto">' + escaparHtml(m.texto) + '</div>' : '') +
        adjunto +
        '</div>';
}

/* ---- Adjunto pendiente de enviar en el chat ---- */
let _adjuntoChat = null;

function ponerAdjuntoChat(archivo) {
    if (!archivo) return;
    const ext = extensionDe(archivo.name);
    if (!EXTENSIONES_PERMITIDAS.includes(ext)) {
        avisar('Tipo de archivo no permitido: ' + archivo.name, 'error');
        return;
    }
    if (archivo.size > TAMANO_MAXIMO) {
        avisar('El archivo supera 50 MB: ' + archivo.name, 'error');
        return;
    }
    _adjuntoChat = archivo;
    const chip = document.getElementById('chat-adjunto-chip');
    document.getElementById('chat-adjunto-nombre').textContent =
        archivo.name + ' (' + formatoTamano(archivo.size) + ')';
    chip.hidden = false;
}

function quitarAdjuntoChat() {
    _adjuntoChat = null;
    const entrada = document.getElementById('chat-adjunto');
    if (entrada) entrada.value = '';
    const chip = document.getElementById('chat-adjunto-chip');
    if (chip) chip.hidden = true;
}

async function enviarMensaje(evento) {
    evento.preventDefault();
    if (!carpetaAbierta || !_canalChat || ES_MONITOR) return; // el monitor no escribe
    const campo = document.getElementById('mensaje-input');
    const texto = campo.value.trim();
    const archivo = _adjuntoChat;
    if (!texto && !archivo) return; // mensaje vacío sin adjunto: nada que enviar
    const botonEnviar = document.querySelector('#form-mensaje button[type="submit"]');
    if (botonEnviar) botonEnviar.disabled = true;
    // Personal en canal acreedor: el mensaje va dirigido al acreedor elegido
    // ('' = para todos). Las demás combinaciones no llevan destinatario.
    const destinatario = (_canalChat === 'acreedor' && puedeGestionarCarpeta(carpetaAbierta))
        ? (_acreedorDestino || null) : null;
    try {
        await mensajesGuardar(carpetaAbierta.id, _canalChat, texto, archivo || null, destinatario);
        campo.value = '';
        quitarAdjuntoChat();
        registrarActividad('mensaje-chat', CANALES_CHAT[_canalChat] + ' · ' + carpetaAbierta.nombre +
            (archivo ? ' · adjunto: ' + archivo.name : ''), carpetaAbierta.id);
        await pintarMensajes();
    } catch (e) {
        avisar((e && e.message) || 'No se pudo enviar el mensaje.', 'error');
    } finally {
        if (botonEnviar) botonEnviar.disabled = false;
    }
}

/* Descarga el adjunto de un mensaje (local: blob del registro; nube: Storage
   con RLS por canal). */
async function descargarAdjuntoDeChat(mensajeId) {
    try {
        const adj = await descargarAdjuntoChat(mensajeId);
        if (!adj || !adj.blob) return;
        const url = URL.createObjectURL(adj.blob);
        const enlace = document.createElement('a');
        enlace.href = url;
        enlace.download = adj.nombre || 'adjunto';
        document.body.appendChild(enlace);
        enlace.click();
        enlace.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        registrarActividad('descargar-archivo', (adj.nombre || 'adjunto') + ' (chat)' +
            (carpetaAbierta ? ' · ' + carpetaAbierta.nombre : ''), carpetaAbierta && carpetaAbierta.id);
    } catch (e) {
        avisar((e && e.message) || 'No se pudo descargar el adjunto.', 'error');
    }
}

/* ============ CHAT DE SOPORTE FLOTANTE (admin ↔ operadores) ============
   Burbuja global: sigue visible/minimizada aunque el usuario entre a una
   carpeta. El admin ve la lista de TODOS los operadores activos y abre el
   hilo de cualquiera; el operador solo su propio hilo con la administración.
   Los permisos reales los valida el servidor (puede_soporte). */
let _soporteOperador = null;          // hilo abierto: { id, nombre }
let _soporteNoLeidosPorOperador = {}; // operadorId → nº de no leídos
let _chatsNoLeidosCache = [];         // no leídos de los chats de carpeta

function soporteDisponible() { return ES_ADMIN || ES_OPERADOR; }

async function iniciarSoporte() {
    if (soporteDisponible()) {
        document.getElementById('soporte-burbuja').hidden = false;
    }
    await refrescarNoLeidos();
    // Tiempo real: mensajes nuevos (de carpeta o de soporte) → sonido,
    // parpadeo rojo y contadores; si el chat está abierto, se repinta solo.
    suscribirMensajesNuevos(async (tipo, fila) => {
        const autor = tipo === 'soporte' ? fila.autor_id : fila.perfil_id;
        if (autor === sesion._id) return;   // mis propios mensajes no avisan
        sonarAviso();
        parpadearBurbuja();
        if (tipo === 'soporte' && _soporteOperador && !document.getElementById('soporte-panel').hidden &&
            fila.operador_id === _soporteOperador.id) {
            await pintarSoporteMensajes();
            await marcarLeidosSoporte(_soporteOperador.id).catch(() => {});
        }
        if (tipo === 'carpeta' && carpetaAbierta && fila.carpeta_id === carpetaAbierta.id &&
            fila.canal === _canalChat && !document.getElementById('vista-carpeta').hidden) {
            await pintarMensajes();
        }
        await refrescarNoLeidos();
    });
    // Llamadas entrantes (solo las inicia el administrador; el servidor lo exige)
    suscribirLlamadasEntrantes((fila) => recibirLlamada(fila));
}

/* Sonido corto de aviso (WebAudio: no necesita archivos) */
function sonarAviso() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gan = ctx.createGain();
        osc.connect(gan); gan.connect(ctx.destination);
        osc.frequency.value = 880;
        gan.gain.setValueAtTime(0.15, ctx.currentTime);
        gan.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
        osc.start(); osc.stop(ctx.currentTime + 0.5);
        setTimeout(() => ctx.close().catch(() => {}), 800);
    } catch (e) { /* sin audio no pasa nada */ }
}

function parpadearBurbuja() {
    const b = document.getElementById('soporte-burbuja');
    if (!b || b.hidden) return;
    b.classList.add('pt-soporte-burbuja--alerta');
    setTimeout(() => b.classList.remove('pt-soporte-burbuja--alerta'), 6000);
}

async function refrescarNoLeidos() {
    try {
        const [sop, chats] = await Promise.all([
            soporteDisponible() ? soporteNoLeidos() : Promise.resolve([]),
            chatsNoLeidos()
        ]);
        _chatsNoLeidosCache = chats || [];
        _soporteNoLeidosPorOperador = {};
        let total = 0;
        for (const f of (sop || [])) { _soporteNoLeidosPorOperador[f.operadorId] = f.noLeidos; total += f.noLeidos; }
        const cont = document.getElementById('soporte-burbuja-contador');
        if (cont) { cont.hidden = total === 0; cont.textContent = total > 99 ? '99+' : String(total); }
        pintarBadgesChats();
        if (_soporteOperador === null && ES_ADMIN && !document.getElementById('soporte-lista').hidden) {
            await pintarSoporteLista();   // refresca los badges de la lista
        }
    } catch (e) { /* contadores no rompen el portal */ }
}

function noLeidosDe(carpetaId, canal) {
    const f = _chatsNoLeidosCache.find(x => x.carpetaId === carpetaId && x.canal === canal);
    return f ? f.noLeidos : 0;
}

/* Badge rojo de no leídos en las pestañas del chat de la carpeta abierta */
function pintarBadgesChats() {
    document.querySelectorAll('#chat-tabs button').forEach(b => {
        const n = carpetaAbierta ? noLeidosDe(carpetaAbierta.id, b.dataset.canal) : 0;
        let badge = b.querySelector('.pt-badge-noleidos');
        if (n > 0) {
            if (!badge) { badge = document.createElement('span'); badge.className = 'pt-badge-noleidos'; b.appendChild(badge); }
            badge.textContent = n > 99 ? '99+' : String(n);
        } else if (badge) badge.remove();
    });
    // Contador de la burbuja del chat de la carpeta (suma de sus canales)
    const contBurbuja = document.getElementById('chat-carpeta-contador');
    if (contBurbuja && carpetaAbierta) {
        const total = canalesAccesibles().reduce((s, c) => s + noLeidosDe(carpetaAbierta.id, c), 0);
        contBurbuja.hidden = total === 0;
        contBurbuja.textContent = total > 99 ? '99+' : String(total);
    }
}

async function abrirSoporte() {
    if (!soporteDisponible()) return;
    document.getElementById('soporte-panel').hidden = false;
    document.getElementById('soporte-burbuja').hidden = true;
    if (ES_OPERADOR) {
        // El operador conversa directo con la administración (su propio hilo)
        _soporteOperador = { id: sesion._id, nombre: 'Administración' };
        await abrirHiloSoporte(_soporteOperador);
    } else if (_soporteOperador) {
        await abrirHiloSoporte(_soporteOperador);
    } else {
        await pintarSoporteLista();
    }
}

function minimizarSoporte() {
    document.getElementById('soporte-panel').hidden = true;
    if (soporteDisponible()) document.getElementById('soporte-burbuja').hidden = false;
}

/* Lista de operadores activos (solo administrador) */
async function pintarSoporteLista() {
    _soporteOperador = null;
    document.getElementById('soporte-titulo').textContent = 'Soporte · operadores';
    document.getElementById('soporte-boton-volver').hidden = true;
    document.getElementById('soporte-boton-llamar').hidden = true;
    document.getElementById('soporte-mensajes').hidden = true;
    document.getElementById('form-soporte').hidden = true;
    const lista = document.getElementById('soporte-lista');
    lista.hidden = false;
    lista.innerHTML = '<p class="pt-nota">Cargando operadores…</p>';
    let operadores = [];
    try { operadores = await soporteOperadores(); } catch (e) {
        lista.innerHTML = '<p class="pt-nota">' + escaparHtml(e.message || 'No se pudo cargar la lista.') + '</p>';
        return;
    }
    lista.innerHTML = operadores.length === 0
        ? '<p class="pt-nota">No hay operadores activos todavía.</p>'
        : operadores.map(o => {
            const n = _soporteNoLeidosPorOperador[o._id] || 0;
            return '<button type="button" class="pt-soporte-lista__item" data-accion="soporte-elegir" ' +
                'data-uuid="' + escaparHtml(o._id) + '" data-nombre="' + escaparHtml(o.nombre) + '">' +
                icono('usuario', 18) + ' <strong>' + escaparHtml(o.nombre) + '</strong>' +
                ' <span class="pt-nota">(' + escaparHtml(o.usuario) + ')</span>' +
                (n > 0 ? '<span class="pt-badge-noleidos">' + n + '</span>' : '') +
                '</button>';
        }).join('');
}

async function abrirHiloSoporte(operador) {
    _soporteOperador = operador;
    document.getElementById('soporte-titulo').textContent = 'Soporte · ' + operador.nombre;
    document.getElementById('soporte-lista').hidden = true;
    document.getElementById('soporte-mensajes').hidden = false;
    document.getElementById('form-soporte').hidden = false;
    document.getElementById('soporte-boton-volver').hidden = !ES_ADMIN;
    document.getElementById('soporte-boton-llamar').hidden = !ES_ADMIN; // SOLO admin llama
    await pintarSoporteMensajes();
    await marcarLeidosSoporte(operador.id).catch(() => {});
    await refrescarNoLeidos();
}

async function pintarSoporteMensajes() {
    if (!_soporteOperador) return;
    const cont = document.getElementById('soporte-mensajes');
    let mensajes = [];
    try { mensajes = await soporteMensajes(_soporteOperador.id); } catch (e) {
        cont.innerHTML = '<p class="pt-chat-vacio">' + escaparHtml(e.message || 'No se pudo cargar el chat.') + '</p>';
        return;
    }
    cont.innerHTML = mensajes.length
        ? mensajes.map(m => {
            const mio = m.autorId === sesion._id;
            let adjunto = '';
            if (m.archivoNombre) {
                adjunto = '<div class="pt-chat-msg__adjunto">' +
                    '<span class="pt-icono-archivo">' + iconoArchivo(extensionDe(m.archivoNombre)) + '</span>' +
                    '<span class="pt-chat-msg__adjunto-info">' + escaparHtml(m.archivoNombre) +
                        '<small>' + formatoTamano(m.archivoTamano) + '</small></span>' +
                    '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="descargar-adjunto-soporte" data-id="' + m.id + '">Descargar</button>' +
                    '</div>';
            }
            return '<div class="pt-chat-msg' + (mio ? ' pt-chat-msg--mio' : '') + '">' +
                '<div class="pt-chat-msg__meta"><strong>' + escaparHtml(m.autorNombre || '—') + '</strong>' +
                (m.rol ? ' · ' + escaparHtml(ETIQUETAS_ROL[m.rol] || m.rol) : '') + ' · ' + formatoFecha(m.fecha) + '</div>' +
                (m.texto ? '<div class="pt-chat-msg__texto">' + escaparHtml(m.texto) + '</div>' : '') +
                adjunto +
                '</div>';
        }).join('')
        : '<p class="pt-chat-vacio">Aún no hay mensajes con ' + escaparHtml(_soporteOperador.nombre) + '.</p>';
    cont.scrollTop = cont.scrollHeight;
}

/* ---- Adjunto pendiente del chat de soporte ---- */
let _adjuntoSoporte = null;

function ponerAdjuntoSoporte(archivo) {
    if (!archivo) return;
    const ext = extensionDe(archivo.name);
    if (!EXTENSIONES_PERMITIDAS.includes(ext)) { avisar('Tipo de archivo no permitido: ' + archivo.name, 'error'); return; }
    if (archivo.size > TAMANO_MAXIMO) { avisar('El archivo supera 100 MB: ' + archivo.name, 'error'); return; }
    _adjuntoSoporte = archivo;
    document.getElementById('soporte-adjunto-nombre').textContent = archivo.name + ' (' + formatoTamano(archivo.size) + ')';
    document.getElementById('soporte-adjunto-chip').hidden = false;
}

function quitarAdjuntoSoporte() {
    _adjuntoSoporte = null;
    const entrada = document.getElementById('soporte-adjunto');
    if (entrada) entrada.value = '';
    const chip = document.getElementById('soporte-adjunto-chip');
    if (chip) chip.hidden = true;
}

async function descargarAdjuntoDeSoporte(mensajeId) {
    try {
        const adj = await descargarAdjuntoSoporte(mensajeId);
        if (!adj || !adj.blob) return;
        const url = URL.createObjectURL(adj.blob);
        const enlace = document.createElement('a');
        enlace.href = url; enlace.download = adj.nombre || 'adjunto';
        document.body.appendChild(enlace); enlace.click(); enlace.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) {
        avisar((e && e.message) || 'No se pudo descargar el adjunto.', 'error');
    }
}

async function enviarSoporte(evento) {
    evento.preventDefault();
    if (!_soporteOperador) return;
    const campo = document.getElementById('soporte-input');
    const texto = campo.value.trim();
    const archivo = _adjuntoSoporte;
    if (!texto && !archivo) return; // ni mensaje ni adjunto: nada que enviar
    const boton = document.querySelector('#form-soporte button[type="submit"]');
    if (boton) boton.disabled = true;
    try {
        await soporteEnviar(_soporteOperador.id, texto, archivo || null);
        campo.value = '';
        quitarAdjuntoSoporte();
        await pintarSoporteMensajes();
    } catch (e) {
        avisar((e && e.message) || 'No se pudo enviar el mensaje.', 'error');
    } finally {
        if (boton) boton.disabled = false;
    }
}

/* ============ LLAMADAS DE SOPORTE (WebRTC, solo las inicia el admin) ============
   Flujo: el admin crea la llamada (fila en llamadas_soporte: el SERVIDOR
   valida que sea admin) → el destinatario recibe el aviso por Realtime y
   acepta → intercambian oferta/respuesta/ICE por un canal de señalización.
   Controles: silenciar micrófono (track.enabled) y altavoz (audio.muted). */
const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
let _llamada = null; // { id, pc, stream, canal, soyIniciador, entrante }

async function obtenerMicrofono() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        avisar('Este navegador no permite llamadas (sin acceso al micrófono).', 'error');
        throw new Error('sin getUserMedia');
    }
    try {
        // Cancelación de eco, supresión de ruido y control de ganancia del
        // navegador ACTIVADOS: evita el eco repetitivo ("hola-a-a") y el ruido.
        return await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });
    } catch (e) {
        avisar('El portal necesita permiso del MICRÓFONO para la llamada. ' +
            'Haz clic en el candado de la barra del navegador, permite el micrófono y vuelve a intentar.', 'error');
        throw e;
    }
}

function _prepararConexion(llamadaId, stream, soyIniciador) {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    stream.getTracks().forEach(t => pc.addTrack(t, stream));
    const audio = document.getElementById('llamada-audio-remoto');
    pc.ontrack = (e) => { audio.srcObject = e.streams[0]; ponerEstadoLlamada('En llamada.'); };
    const canal = canalSenalizacion(llamadaId, async (m) => {
        if (!_llamada || _llamada.id !== llamadaId) return;
        try {
            if (m.t === 'listo' && soyIniciador) {
                const oferta = await pc.createOffer();
                await pc.setLocalDescription(oferta);
                canal.enviar({ t: 'oferta', sdp: oferta });
            } else if (m.t === 'oferta' && !soyIniciador) {
                await pc.setRemoteDescription(m.sdp);
                const respuesta = await pc.createAnswer();
                await pc.setLocalDescription(respuesta);
                canal.enviar({ t: 'respuesta', sdp: respuesta });
            } else if (m.t === 'respuesta' && soyIniciador) {
                if (!pc.currentRemoteDescription) await pc.setRemoteDescription(m.sdp);
            } else if (m.t === 'ice' && m.c) {
                await pc.addIceCandidate(m.c).catch(() => {});
            } else if (m.t === 'colgar') {
                terminarLlamada(false);
                avisar('La otra persona colgó la llamada.');
            }
        } catch (e) { /* fallos puntuales de señalización no tumban la llamada */ }
    });
    pc.onicecandidate = (e) => { if (e.candidate) canal.enviar({ t: 'ice', c: e.candidate }); };
    return { pc, canal };
}

function ponerEstadoLlamada(texto) {
    const el = document.getElementById('llamada-estado');
    if (el) el.textContent = texto;
}

function _mostrarModalLlamada(titulo, esEntrante) {
    pintarBotonesLlamada();   // botones limpios (sin silenciar) al iniciar
    document.getElementById('llamada-titulo').textContent = titulo;
    document.getElementById('llamada-aceptar').hidden = !esEntrante;
    document.getElementById('llamada-mic').hidden = esEntrante;
    document.getElementById('llamada-altavoz').hidden = esEntrante;
    document.getElementById('llamada-minimizar').hidden = esEntrante;
    document.getElementById('modal-llamada').hidden = false;
}

/* El admin llama al operador del hilo abierto (o a quien se indique) */
async function iniciarLlamadaSoporte() {
    if (!ES_ADMIN || !_soporteOperador) return; // el servidor vuelve a validar
    try {
        const id = await llamadaCrear(_soporteOperador.id);
        const stream = await obtenerMicrofono();
        const { pc, canal } = _prepararConexion(id, stream, true);
        _llamada = { id, pc, stream, canal, soyIniciador: true };
        _mostrarModalLlamada('Llamando a ' + _soporteOperador.nombre + '…', false);
        ponerEstadoLlamada('Esperando a que conteste…');
        registrarActividad('llamada-soporte', _soporteOperador.nombre);
    } catch (e) {
        if (_llamada) terminarLlamada(true);
        else avisar((e && e.message) || 'No se pudo iniciar la llamada.', 'error');
    }
}

/* Aviso de llamada entrante (operador/cliente/acreedor) */
let _llamadaEntrante = null;
function recibirLlamada(fila) {
    if (_llamada) return; // ya en llamada: se ignora
    _llamadaEntrante = fila;
    sonarAviso(); setTimeout(sonarAviso, 700); setTimeout(sonarAviso, 1400);
    _mostrarModalLlamada('Llamada de la administración', true);
    ponerEstadoLlamada('La administración te está llamando.');
}

async function aceptarLlamada() {
    if (!_llamadaEntrante) return;
    const fila = _llamadaEntrante;
    _llamadaEntrante = null;
    try {
        const stream = await obtenerMicrofono();
        const { pc, canal } = _prepararConexion(fila.id, stream, false);
        _llamada = { id: fila.id, pc, stream, canal, soyIniciador: false };
        document.getElementById('llamada-aceptar').hidden = true;
        document.getElementById('llamada-mic').hidden = false;
        document.getElementById('llamada-minimizar').hidden = false;
        document.getElementById('llamada-altavoz').hidden = false;
        ponerEstadoLlamada('Conectando…');
        await llamadaActualizar(fila.id, 'aceptada').catch(() => {});
        // avisa al iniciador que ya puede mandar la oferta
        canal.enviar({ t: 'listo' });
        // el iniciador también muestra sus controles al conectar
        document.getElementById('llamada-mic').hidden = false;
        document.getElementById('llamada-minimizar').hidden = false;
        document.getElementById('llamada-altavoz').hidden = false;
    } catch (e) {
        await llamadaActualizar(fila.id, 'rechazada').catch(() => {});
        document.getElementById('modal-llamada').hidden = true;
    document.getElementById('llamada-mini').hidden = true;
    }
}

/* Minimizar la llamada: queda una barra flotante y se puede navegar por el
   portal (carpetas, estados…) sin cortar la comunicación. Colgar la termina. */
function minimizarLlamada() {
    if (!_llamada) return;
    document.getElementById('modal-llamada').hidden = true;
    document.getElementById('llamada-mini').hidden = false;
    document.getElementById('llamada-mini-texto').textContent =
        document.getElementById('llamada-estado').textContent || 'En llamada';
}

function restaurarLlamada() {
    document.getElementById('llamada-mini').hidden = true;
    if (_llamada) document.getElementById('modal-llamada').hidden = false;
}

/* Estado visual de los botones de llamada (modal Y barra minimizada):
   silenciado → icono con raya encima y botón marcado en ROJO. */
function pintarBotonesLlamada() {
    const pista = _llamada && _llamada.stream ? _llamada.stream.getAudioTracks()[0] : null;
    const micMudo = pista ? !pista.enabled : false;
    const audio = document.getElementById('llamada-audio-remoto');
    const altavozMudo = !!audio.muted;

    const mic = document.getElementById('llamada-mic');
    const micMini = document.getElementById('llamada-mic-mini');
    const alt = document.getElementById('llamada-altavoz');
    const altMini = document.getElementById('llamada-altavoz-mini');

    if (mic) {
        mic.innerHTML = icono(micMudo ? 'microfono-mudo' : 'microfono', 17) +
            (micMudo ? ' Activar micrófono' : ' Silenciar micrófono');
        mic.classList.toggle('pt-boton-llamada--activo', micMudo);
    }
    if (micMini) {
        micMini.innerHTML = icono(micMudo ? 'microfono-mudo' : 'microfono', 16);
        micMini.classList.toggle('pt-boton-llamada--activo', micMudo);
        micMini.title = micMudo ? 'Activar micrófono' : 'Silenciar micrófono';
    }
    if (alt) {
        alt.innerHTML = icono(altavozMudo ? 'altavoz-mudo' : 'altavoz', 17) +
            (altavozMudo ? ' Activar altavoz' : ' Silenciar altavoz');
        alt.classList.toggle('pt-boton-llamada--activo', altavozMudo);
    }
    if (altMini) {
        altMini.innerHTML = icono(altavozMudo ? 'altavoz-mudo' : 'altavoz', 16);
        altMini.classList.toggle('pt-boton-llamada--activo', altavozMudo);
        altMini.title = altavozMudo ? 'Activar altavoz' : 'Silenciar altavoz';
    }
}

function alternarMicrofono() {
    if (!_llamada || !_llamada.stream) return;
    const pista = _llamada.stream.getAudioTracks()[0];
    if (!pista) return;
    pista.enabled = !pista.enabled;
    pintarBotonesLlamada();
}

function alternarAltavoz() {
    const audio = document.getElementById('llamada-audio-remoto');
    audio.muted = !audio.muted;
    pintarBotonesLlamada();
}

async function terminarLlamada(avisarAlOtro) {
    // Rechazo de una llamada entrante que no se aceptó
    if (_llamadaEntrante) {
        const fila = _llamadaEntrante; _llamadaEntrante = null;
        await llamadaActualizar(fila.id, 'rechazada').catch(() => {});
        const canal = canalSenalizacion(fila.id, () => {});
        canal.enviar({ t: 'colgar' }); setTimeout(() => canal.cerrar(), 500);
        document.getElementById('modal-llamada').hidden = true;
    document.getElementById('llamada-mini').hidden = true;
        return;
    }
    if (!_llamada) { document.getElementById('modal-llamada').hidden = true; return; }
    const ll = _llamada; _llamada = null;
    try { if (avisarAlOtro !== false) ll.canal.enviar({ t: 'colgar' }); } catch (e) {}
    try { ll.pc.close(); } catch (e) {}
    try { ll.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
    setTimeout(() => ll.canal.cerrar(), 500);
    await llamadaActualizar(ll.id, 'terminada').catch(() => {});
    const audio = document.getElementById('llamada-audio-remoto');
    audio.srcObject = null; audio.muted = false;
    document.getElementById('modal-llamada').hidden = true;
    document.getElementById('llamada-mini').hidden = true;
}

/* ============ CAMPANA DE NOTIFICACIONES (todos los roles) ============
   Consume la tabla notificaciones (RLS: cada quien SOLO las suyas; el
   administrador también solo las suyas). El admin, al refrescar, dispara
   además la generación de avisos de procesos vencidos (una vez por proceso). */
let _notifCache = [];

const ICONO_NOTIF = {
    'mensaje-nuevo': 'chat', 'archivo-nuevo': 'subir', 'soporte': 'campana',
    'proceso-estado': 'estado', 'proceso-semaforo': 'estado', 'proceso-vencido': 'alerta',
    'tramite-pausado': 'desactivar', 'tramite-reactivado': 'activar',
    'tramite-finalizado': 'activar', 'tramite-prorroga': 'estado',
    'tramite-fin': 'activar', 'ingreso-propio': 'ingreso', 'solicitud-clave': 'usuario'
};

/* Registra el ingreso del admin como notificación en su campana (fecha/hora),
   estilo aviso de "nuevo inicio de sesión". Luego refresca el contador. */
async function avisarIngresoEnCampana() {
    if (!ES_ADMIN) return;
    // Un F5 / recarga NO cuenta como ingreso nuevo: se registra una sola vez por
    // sesión del navegador (sessionStorage se borra al cerrar la pestaña). Solo
    // al cerrar y volver a entrar más tarde se contará otro ingreso.
    try {
        if (sessionStorage.getItem('sesion_notificada')) { await refrescarCampana(); return; }
        await notificarMiIngreso();
        sessionStorage.setItem('sesion_notificada', 'true');
        await refrescarCampana();
    } catch (e) { /* silencioso */ }
}

async function iniciarCampana() {
    await refrescarCampana();
    suscribirNotificaciones(async () => {
        sonarAviso();
        const b = document.querySelector('.pt-campana');
        if (b) { b.classList.add('pt-campana--alerta'); setTimeout(() => b.classList.remove('pt-campana--alerta'), 6000); }
        await refrescarCampana();
    });
}

async function refrescarCampana() {
    try {
        if (ES_ADMIN) await notificacionesGenerarVencidos().catch(() => {});
        _notifCache = await notificacionesListar();
    } catch (e) { return; }
    const noLeidas = _notifCache.filter(n => !n.leido).length;
    const cont = document.getElementById('campana-contador');
    if (cont) { cont.hidden = noLeidas === 0; cont.textContent = noLeidas > 99 ? '99+' : String(noLeidas); }
    if (!document.getElementById('campana-dropdown').hidden) pintarCampanaLista();
}

function pintarCampanaLista() {
    const lista = document.getElementById('campana-lista');
    if (!lista) return;
    // Cada notificación es clickeable: lleva a su lugar de origen (deep link)
    lista.innerHTML = _notifCache.length === 0
        ? '<p class="pt-nota" style="padding:1.2rem;">No tienes notificaciones.</p>'
        : _notifCache.map(n =>
            '<div class="pt-campana-item' + (n.leido ? '' : ' pt-campana-item--nueva') + '"' +
                ' data-accion="notif-abrir" data-tipo="' + escaparHtml(n.tipo) + '"' +
                ' data-mensaje="' + escaparHtml(n.mensaje || '') + '"' +
                (n.carpetaId ? ' data-id="' + n.carpetaId + '"' : '') + ' style="cursor:pointer;">' +
                icono(ICONO_NOTIF[n.tipo] || 'campana', 16) +
                '<div>' + escaparHtml(n.mensaje) +
                '<span class="pt-nota">' + formatoFecha(n.fecha) + '</span></div>' +
                '<button class="pt-campana-x" data-accion="notif-eliminar" data-notif="' + n.id + '"' +
                    ' title="Eliminar notificación" aria-label="Eliminar notificación">' +
                    icono('cerrar', 13) + '</button>' +
            '</div>').join('');
}

async function alternarCampana() {
    const dd = document.getElementById('campana-dropdown');
    if (!dd.hidden) { dd.hidden = true; return; }
    dd.hidden = false;
    await refrescarCampana();
    pintarCampanaLista();   // se pintan resaltadas las nuevas…
    // …y al abrir el panel quedan automáticamente LEÍDAS (el contador se apaga)
    if (_notifCache.some(n => !n.leido)) {
        notificacionesMarcarLeidas(null).then(() => {
            for (const n of _notifCache) n.leido = true;
            const cont = document.getElementById('campana-contador');
            if (cont) cont.hidden = true;
        }).catch(() => {});
    }
}

/* Deep link: abre el lugar de origen de la notificación */
async function abrirDesdeNotificacion(tipo, carpetaId, mensaje) {
    document.getElementById('campana-dropdown').hidden = true;
    if (tipo === 'soporte') { abrirSoporte(); return; }
    // Solicitud de restablecimiento de clave → abre la ficha del usuario
    if (tipo === 'solicitud-clave' && ES_ADMIN) {
        const m = /«([^»]+)»/.exec(mensaje || '');
        if (m) {
            const objetivo = await dbObtener('usuarios', m[1]);
            if (objetivo) {
                await mostrarVistaUsuarios();
                abrirModalUsuario(objetivo);
                return;
            }
        }
        await mostrarVistaUsuarios();
        return;
    }
    const esDeEstados = ['proceso-estado', 'proceso-semaforo', 'proceso-vencido',
        'tramite-pausado', 'tramite-reactivado', 'tramite-finalizado', 'tramite-prorroga', 'tramite-fin'].includes(tipo);
    if (esDeEstados && (ES_PERSONAL || ES_MONITOR)) {
        await mostrarVistaEstados();
        if (carpetaId && ES_SUPERVISION) abrirDetalleTramite(carpetaId);
        return;
    }
    if (carpetaId) { abrirCarpeta(carpetaId); return; }
    // sin origen conocido: no se navega
}

/* Elimina UNA notificación tras confirmar; la quita del DOM sin recargar */
async function eliminarNotificacion(id, elemento) {
    if (!await confirmarPortal('¿Estás seguro de que deseas eliminar esta notificación de manera permanente?', 'Eliminar notificación')) return;
    try {
        await notificacionEliminar(Number(id));
        _notifCache = _notifCache.filter(n => String(n.id) !== String(id));
        if (elemento) elemento.remove();
        // actualizar el contador de no leídas
        const noLeidas = _notifCache.filter(n => !n.leido).length;
        const cont = document.getElementById('campana-contador');
        if (cont) { cont.hidden = noLeidas === 0; cont.textContent = noLeidas > 99 ? '99+' : String(noLeidas); }
        if (_notifCache.length === 0) pintarCampanaLista();
    } catch (e) {
        avisar((e && e.message) || 'No se pudo eliminar la notificación.', 'error');
    }
}

async function marcarCampanaLeidas() {
    try {
        await notificacionesMarcarLeidas(null);
        await refrescarCampana();
        pintarCampanaLista();
    } catch (e) {
        avisar((e && e.message) || 'No se pudieron marcar las notificaciones.', 'error');
    }
}

/* ============ CONFIRMACIÓN PROPIA DEL PORTAL (reemplaza window.confirm) ============ */
let _confirmarResolver = null;

function confirmarPortal(mensaje, titulo) {
    return new Promise((resolver) => {
        _confirmarResolver = resolver;
        document.getElementById('confirmar-titulo').textContent = titulo || 'Confirmar';
        document.getElementById('confirmar-mensaje').textContent = mensaje || '¿Continuar?';
        document.getElementById('modal-confirmar').hidden = false;
        document.getElementById('confirmar-si').focus();
    });
}

function _responderConfirmacion(valor) {
    document.getElementById('modal-confirmar').hidden = true;
    if (_confirmarResolver) { _confirmarResolver(valor); _confirmarResolver = null; }
}

/* ============ CONSENTIMIENTO DE DATOS (primer ingreso cliente/acreedor) ============
   Modal BLOQUEANTE: no se puede usar el portal hasta aceptar. */
async function verificarConsentimiento() {
    if (!ES_CLIENTE && !ES_ACREEDOR) return;
    let perfil = null;
    try { perfil = await perfilPropio(); } catch (e) { return; }
    if (perfil && perfil.primerLogin) {
        document.getElementById('consentimiento-acepto').checked = false;
        document.getElementById('modal-consentimiento').hidden = false;
    }
}

async function aceptarConsentimientoAccion() {
    if (!document.getElementById('consentimiento-acepto').checked) {
        avisar('Debes marcar la casilla de autorización para continuar.', 'error');
        return;
    }
    try {
        await consentimientoAceptar('1.0');
        registrarActividad('consentimiento', 'Aceptó la política de datos v1.0');
        document.getElementById('modal-consentimiento').hidden = true;
        avisar('Gracias. Autorización registrada.');
    } catch (e) {
        avisar((e && e.message) || 'No se pudo registrar la autorización.', 'error');
    }
}

/* ---- Pestaña Consentimientos dentro de Usuarios (solo admin) ---- */
async function cambiarPanelUsuarios(panel) {
    const gestion = document.getElementById('panel-usuarios-gestion');
    const consent = document.getElementById('panel-consentimientos');
    document.querySelectorAll('#sub-pestanas-usuarios button').forEach(b =>
        b.classList.toggle('activa', b.dataset.panel === panel));
    gestion.hidden = (panel !== 'gestion');
    consent.hidden = (panel !== 'consentimientos');
    if (panel === 'consentimientos') {
        let lista = [];
        try { lista = await consentimientosListar(); } catch (e) {
            avisar((e && e.message) || 'No se pudieron cargar los consentimientos.', 'error');
            return;
        }
        _consentimientosCache = lista;
        document.getElementById('lista-consentimientos').innerHTML = lista.map((c, i) =>
            '<tr><td><code>' + escaparHtml(c.usuario) + '</code></td>' +
            '<td>' + escaparHtml(c.nombre) + '</td>' +
            '<td><span class="pt-insignia pt-insignia--rol">' + escaparHtml(ETIQUETAS_ROL[c.rol] || c.rol) + '</span></td>' +
            '<td>' + formatoFecha(c.fecha) + '</td>' +
            '<td>' + escaparHtml(c.version) + '</td>' +
            '<td><div class="pt-celda-acciones">' +
                '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="consentimiento-ver" data-id="' + i + '">Ver</button> ' +
                '<button class="pt-boton pt-boton--primario pt-boton--mini" data-accion="consentimiento-descargar" data-id="' + i + '">' +
                    icono('descargar', 14) + ' Descargar (PDF)</button>' +
            '</div></td></tr>').join('');
        document.getElementById('consentimientos-vacio').hidden = lista.length > 0;
    }
}
let _consentimientosCache = [];

/* Texto oficial de la autorización (el mismo del modal del primer ingreso) */
const TEXTO_POLITICA_DATOS =
    'AUTORIZACIÓN DE MANEJO DE DATOS PERSONALES\n\n' +
    'De conformidad con la Ley 1581 de 2012 (protección de datos personales en Colombia), ' +
    'el titular AUTORIZA a la Fundación de insolvencia y conciliaciones el tratamiento de sus ' +
    'datos personales y de los documentos de su trámite. Los datos se usan únicamente para la ' +
    'gestión de su proceso de insolvencia/conciliación, se comparten solo con las partes ' +
    'autorizadas del trámite y el titular puede ejercer sus derechos de consulta y reclamo ' +
    'escribiendo a la Fundación.';

/* Muestra el documento de aceptación (texto + datos del titular) */
function verConsentimiento(indice) {
    const c = _consentimientosCache[indice];
    if (!c) return;
    confirmarPortal(
        TEXTO_POLITICA_DATOS + '\n\n' +
        'Titular: ' + c.nombre + ' (' + c.usuario + ') · Rol: ' + (ETIQUETAS_ROL[c.rol] || c.rol) + '\n' +
        'Fecha de aceptación: ' + formatoFecha(c.fecha) + '\n' +
        'Versión de la política: ' + c.version,
        'Constancia de autorización de datos');
}

/* Genera y descarga la constancia en PDF (pdf-lib, ya usado en el expediente) */
async function descargarConstanciaConsentimiento(indice) {
    const c = _consentimientosCache[indice];
    if (!c) return;
    try {
        const PDFLib = await cargarPdfLib();
        const doc = await PDFLib.PDFDocument.create();
        const pagina = doc.addPage([612, 792]); // carta
        const fuente = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
        const fuenteNegrita = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold);

        // texto sin tildes problemáticas para la fuente estándar (WinAnsi las soporta)
        const lineas = [];
        const envolver = (texto, max) => {
            for (const parrafo of texto.split('\n')) {
                let linea = '';
                for (const palabra of parrafo.split(' ')) {
                    if ((linea + ' ' + palabra).trim().length > max) { lineas.push(linea.trim()); linea = palabra; }
                    else linea += ' ' + palabra;
                }
                lineas.push(linea.trim());
            }
        };
        envolver(TEXTO_POLITICA_DATOS, 90);
        lineas.push('');
        lineas.push('Titular: ' + c.nombre + ' (' + c.usuario + ')');
        lineas.push('Rol en el portal: ' + (ETIQUETAS_ROL[c.rol] || c.rol));
        lineas.push('Fecha y hora de aceptacion: ' + formatoFecha(c.fecha));
        lineas.push('Version de la politica aceptada: ' + c.version);
        lineas.push('');
        lineas.push('La aceptacion quedo registrada electronicamente en el Portal Documental');
        lineas.push('al primer ingreso del titular (tabla consentimientos).');

        pagina.drawText('Portal Documental', { x: 50, y: 742, size: 16, font: fuenteNegrita });
        pagina.drawText('Constancia de autorizacion de manejo de datos', { x: 50, y: 720, size: 12, font: fuenteNegrita });
        let y = 690;
        for (const l of lineas) {
            pagina.drawText(l, { x: 50, y, size: 10, font: fuente });
            y -= 15;
        }

        const bytes = await doc.save();
        const blob = new Blob([bytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const enlace = document.createElement('a');
        enlace.href = url;
        enlace.download = 'consentimiento_' + nombreArchivoSeguro(c.usuario) + '.pdf';
        document.body.appendChild(enlace);
        enlace.click();
        enlace.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) {
        avisar((e && e.message) || 'No se pudo generar la constancia.', 'error');
    }
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
    document.getElementById('detalle-descripcion').textContent = texto || 'Sin notas internas todavía.';
    registrarActividad('actualizar-notas', carpetaAbierta.nombre, carpetaAbierta.id);
    ocultarEditorDescripcion();
    avisar('Notas internas actualizadas.');
}

/* ============ SUB-PESTAÑAS DE LA CARPETA ============
   La pestaña "Deudor" (deudores_info) se ELIMINÓ de la interfaz; la tabla y
   sus políticas RLS siguen intactas en la base de datos por si se retoma. */
let _subPanelCarpeta = 'archivos';

function montarSubPestanasCarpeta(carpeta) {
    const barra = document.getElementById('sub-pestanas-carpeta');
    if (!barra) return;

    const tab = (panel, ic, etiqueta) =>
        '<button class="' + (_subPanelCarpeta === panel ? 'activa' : '') + '" data-accion="sub-carpeta" data-panel="' + panel + '">' +
            icono(ic, 17) + ' ' + etiqueta + '</button>';

    const pestañas =
        tab('archivos', 'carpeta', 'Archivos') +
        // Herramientas del personal de la carpeta (admin / operador responsable)
        (puedeGestionarCarpeta(carpeta)
            ? tab('audiencias', 'calendario', 'Audiencias') +
              tab('recordatorios', 'campana', 'Recordatorios')
            : '') +
        // Notificaciones de la carpeta: también el monitor (solo lectura)
        ((puedeGestionarCarpeta(carpeta) || ES_MONITOR)
            ? tab('notificaciones', 'ingreso', 'Notificaciones')
            : '');

    // Con una sola pestaña (cliente/acreedor) la barra no hace falta
    const varias = (pestañas.match(/<button/g) || []).length > 1;
    barra.hidden = !varias;
    barra.innerHTML = varias ? pestañas : '';

    pintarPanelDeCarpeta(_subPanelCarpeta, carpeta);
    mostrarSubPanelCarpeta(_subPanelCarpeta);
}

const PANELES_CARPETA = ['archivos', 'audiencias', 'recordatorios', 'notificaciones'];

function mostrarSubPanelCarpeta(panel) {
    document.getElementById('panel-archivos').hidden = (panel !== 'archivos');
    for (const p of ['audiencias', 'recordatorios', 'notificaciones']) {
        const el = document.getElementById('panel-' + (p === 'notificaciones' ? 'notif-carpeta' : p));
        if (el) el.hidden = (panel !== p);
    }
}

/* Pinta el contenido del panel elegido (los que se construyen dinámicamente) */
function pintarPanelDeCarpeta(panel, carpeta) {
    if (panel === 'audiencias') pintarAudiencias(carpeta);
    else if (panel === 'recordatorios') pintarRecordatorios(carpeta);
    else if (panel === 'notificaciones') pintarNotifCarpeta(carpeta);
}

function cambiarSubPestanaCarpeta(panel) {
    if (!PANELES_CARPETA.includes(panel)) return;
    // Paneles del personal: exigen poder gestionar la carpeta
    if (['audiencias', 'recordatorios'].includes(panel) &&
        (!carpetaAbierta || !puedeGestionarCarpeta(carpetaAbierta))) return;
    // Notificaciones de la carpeta: personal o monitor (lectura)
    if (panel === 'notificaciones' &&
        (!carpetaAbierta || !(puedeGestionarCarpeta(carpetaAbierta) || ES_MONITOR))) return;
    _subPanelCarpeta = panel;
    document.querySelectorAll('#sub-pestanas-carpeta button').forEach(b =>
        b.classList.toggle('activa', b.dataset.panel === panel));
    pintarPanelDeCarpeta(panel, carpetaAbierta);
    mostrarSubPanelCarpeta(panel);
}

/* Orden de los documentos: primero el orden manual ('orden' ascendente,
   definido en "Editar documentos") y los que no lo tienen, por fecha
   (más reciente primero). */
function ordenarArchivos(archivos) {
    return archivos.sort((a, b) => {
        const oa = (a.orden === null || a.orden === undefined) ? Infinity : a.orden;
        const ob = (b.orden === null || b.orden === undefined) ? Infinity : b.orden;
        if (oa !== ob) return oa - ob;
        return b.fecha - a.fecha;
    });
}

let _editandoOrden = false;   // modo "Editar documentos" (reordenar la tabla)
let _archivosCache = [];      // archivos de la carpeta abierta, ya ordenados

async function pintarArchivos() {
    if (!carpetaAbierta) return;
    const archivos = await dbArchivosDeCarpeta(carpetaAbierta.id);
    _archivosCache = ordenarArchivos(archivos);

    // Botón "Editar documentos" sobre la tabla (solo personal de la carpeta)
    const barraArchivos = document.getElementById('barra-editar-documentos');
    if (barraArchivos) barraArchivos.remove();
    if (puedeGestionarCarpeta(carpetaAbierta) && archivos.length > 1) {
        const envoltura = document.querySelector('#panel-archivos .pt-tabla-envoltura');
        const barra = document.createElement('div');
        barra.id = 'barra-editar-documentos';
        barra.className = 'pt-barra-editar-docs';
        barra.innerHTML = _editandoOrden
            ? '<span class="pt-nota">Arrastra las filas o usa las flechas para reorganizar. El orden se usa en la tabla y en el expediente.</span>' +
              '<button class="pt-boton pt-boton--primario pt-boton--mini" data-accion="guardar-orden">Guardar orden</button>' +
              '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="cancelar-orden">Cancelar</button>'
            : '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="editar-documentos">' +
              icono('editar', 15) + ' Editar documentos</button>';
        envoltura.parentNode.insertBefore(barra, envoltura);
    }

    // La columna "Descarga" (interruptores) solo la ve el personal de la carpeta
    const thDescarga = document.getElementById('th-descarga');
    if (thDescarga) thDescarga.hidden = !puedeGestionarCarpeta(carpetaAbierta);

    // "Subido por" es información interna: el cliente y el acreedor no la ven
    const thSubidoPor = document.getElementById('th-subido-por');
    if (thSubidoPor) thSubidoPor.hidden = (ES_CLIENTE || ES_ACREEDOR);

    const cuerpo = document.getElementById('lista-archivos');
    cuerpo.innerHTML = _archivosCache.map(filaArchivo).join('');
    document.getElementById('archivos-vacio').hidden = archivos.length > 0;
    if (_editandoOrden) activarArrastreOrden();
}

function filaArchivo(a) {
    const ext = extensionDe(a.nombre);
    const gestiona = !!(carpetaAbierta && puedeGestionarCarpeta(carpetaAbierta));
    const descargable = a.descargablePartes !== false;
    let acciones = '';
    if (_editandoOrden) {
        acciones =
            '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="orden-subir" data-id="' + a.id + '" title="Subir">' + icono('flecha-arriba', 14) + '</button> ' +
            '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="orden-bajar" data-id="' + a.id + '" title="Bajar">' + icono('flecha-abajo', 14) + '</button>';
    } else {
        // Ver siempre está disponible; la descarga es la que se restringe
        if (EXTENSIONES_VISTA.includes(ext)) {
            acciones += '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="ver-archivo" data-id="' + a.id + '">Ver</button> ';
        }
        if ((ES_CLIENTE || ES_ACREEDOR) && !descargable) {
            acciones += '<span class="pt-nota" title="El operador no habilitó la descarga de este documento">Solo lectura</span>';
        } else {
            acciones += '<button class="pt-boton pt-boton--primario pt-boton--mini" data-accion="descargar-archivo" data-id="' + a.id + '">Descargar</button>';
        }
        if (gestiona) {
            acciones += ' <button class="pt-boton pt-boton--peligro pt-boton--mini" data-accion="eliminar-archivo" data-id="' + a.id + '">Eliminar</button>';
        }
    }

    // Columna "Descarga": interruptor que decide si las partes pueden bajarlo
    const celdaDescarga = gestiona
        ? '<td><button type="button" class="pt-switch' + (descargable ? ' pt-switch--si' : '') + '"' +
              ' role="switch" aria-checked="' + (descargable ? 'true' : 'false') + '"' +
              ' data-accion="alternar-descarga-partes" data-id="' + a.id + '"' +
              ' title="' + (descargable ? 'Las partes pueden descargar este archivo' : 'Las partes no pueden descargar este archivo') + '">' +
              '<span class="pt-switch__bola"></span></button></td>'
        : '';

    return '<tr data-archivo-id="' + a.id + '"' + (_editandoOrden ? ' draggable="true" class="pt-fila-arrastrable"' : '') + '>' +
        '<td>' + (_editandoOrden ? '<span class="pt-asa-arrastre" title="Arrastrar">' + icono('arrastre', 14) + '</span>' : '') +
            '<span class="pt-icono-archivo">' + iconoArchivo(ext) + '</span>' + escaparHtml(a.nombre) + '</td>' +
        '<td>' + formatoTamano(a.tamano) + '</td>' +
        ((ES_CLIENTE || ES_ACREEDOR) ? '' : '<td>' + escaparHtml(a.subidoPor) + '</td>') +
        '<td>' + formatoFecha(a.fecha) + '</td>' +
        celdaDescarga +
        '<td><div class="pt-celda-acciones">' + acciones + '</div></td>' +
        '</tr>';
}

/* ---- "Editar documentos": reorganizar arrastrando o con flechas ---- */
function empezarEdicionOrden() {
    if (!carpetaAbierta || !puedeGestionarCarpeta(carpetaAbierta)) return;
    _editandoOrden = true;
    pintarArchivos();
}

async function cancelarEdicionOrden() {
    _editandoOrden = false;
    await pintarArchivos();
}

function moverArchivoEnOrden(id, delta) {
    const i = _archivosCache.findIndex(a => a.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= _archivosCache.length) return;
    const [fila] = _archivosCache.splice(i, 1);
    _archivosCache.splice(j, 0, fila);
    repintarFilasOrden();
}

function repintarFilasOrden() {
    document.getElementById('lista-archivos').innerHTML = _archivosCache.map(filaArchivo).join('');
    activarArrastreOrden();
}

async function guardarOrdenDocumentos() {
    if (!carpetaAbierta || !puedeGestionarCarpeta(carpetaAbierta)) return;
    try {
        await actualizarOrdenArchivos(carpetaAbierta.id, _archivosCache.map(a => a.id));
        registrarActividad('ordenar-documentos', carpetaAbierta.nombre, carpetaAbierta.id);
        avisar('Orden de los documentos guardado.');
    } catch (e) {
        avisar((e && e.message) || 'No se pudo guardar el orden.', 'error');
    }
    _editandoOrden = false;
    await pintarArchivos();
}

/* Arrastrar y soltar filas de la tabla en modo edición */
let _filaArrastrada = null;
function activarArrastreOrden() {
    const cuerpo = document.getElementById('lista-archivos');
    cuerpo.querySelectorAll('tr[draggable="true"]').forEach(tr => {
        tr.addEventListener('dragstart', () => { _filaArrastrada = tr; tr.classList.add('arrastrando'); });
        tr.addEventListener('dragend', () => { tr.classList.remove('arrastrando'); _filaArrastrada = null; });
        tr.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (!_filaArrastrada || _filaArrastrada === tr) return;
            const caja = tr.getBoundingClientRect();
            const despues = e.clientY > caja.top + caja.height / 2;
            tr.parentNode.insertBefore(_filaArrastrada, despues ? tr.nextSibling : tr);
        });
        tr.addEventListener('drop', (e) => {
            e.preventDefault();
            // sincroniza la caché con el nuevo orden visual de las filas
            const ids = [...cuerpo.querySelectorAll('tr[data-archivo-id]')].map(f => Number(f.dataset.archivoId));
            _archivosCache.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
        });
    });
}

/* ============ AUDIENCIAS: CALENDARIO Y NOTIFICACIÓN (admin/operador) ============
   El operador marca las fechas de audiencia en el calendario de la carpeta y
   puede notificar por correo (mailto: se abre SU correo con el mensaje listo)
   a los deudores y acreedores seleccionados. */
let _mesCalendario = null;      // primer día del mes mostrado
let _audienciasCache = [];      // audiencias de la carpeta abierta
let _asignadosCache = [];       // asignados (con correo) de la carpeta abierta

async function pintarAudiencias(carpeta) {
    const panel = document.getElementById('panel-audiencias');
    if (!panel || !carpeta || !puedeGestionarCarpeta(carpeta)) return;
    panel.innerHTML = '<p class="pt-nota" style="padding:1rem 0;">Cargando audiencias…</p>';
    try {
        _audienciasCache = await audienciasListar(carpeta.id);
    } catch (e) {
        panel.innerHTML = '<div class="pt-vacio">' + escaparHtml((e && e.message) || 'No se pudieron cargar las audiencias.') + '</div>';
        return;
    }
    if (!_mesCalendario) { const hoy = new Date(); _mesCalendario = new Date(hoy.getFullYear(), hoy.getMonth(), 1); }

    const lista = _audienciasCache.map(a =>
        '<div class="pt-audiencia">' +
            '<span class="pt-audiencia__ic">' + icono('calendario', 17) + '</span>' +
            '<div class="pt-audiencia__txt"><strong>' + escaparHtml(a.titulo || 'Audiencia') + '</strong>' +
                '<span>' + formatoFechaDia(a.fecha) + (a.hora ? ' · ' + escaparHtml(a.hora) : '') + '</span>' +
                (a.enlace ? '<a href="' + escaparHtml(a.enlace) + '" target="_blank" rel="noopener noreferrer">Abrir enlace de la reunión</a>' : '') +
                (a.descripcion ? '<span class="pt-nota">' + escaparHtml(a.descripcion) + '</span>' : '') +
            '</div>' +
            '<div class="pt-celda-acciones">' +
                '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="notificar-audiencia-existente" data-id="' + a.id + '">' + icono('correo', 14) + ' Notificar</button>' +
                '<button class="pt-boton pt-boton--peligro pt-boton--mini" data-accion="eliminar-audiencia" data-id="' + a.id + '">Eliminar</button>' +
            '</div>' +
        '</div>').join('');

    panel.innerHTML =
        '<div class="pt-audiencias-cab">' +
            '<h3>' + icono('calendario', 18) + ' Audiencias del proceso</h3>' +
            '<button class="pt-boton pt-boton--primario pt-boton--mini" data-accion="notificar-audiencia">' +
                icono('campana', 15) + ' Notificar audiencia</button>' +
        '</div>' +
        '<p class="pt-nota">Las fechas quedan marcadas en el calendario de la derecha. ' +
            'Con «Notificar audiencia» se envía el aviso por correo a las partes.</p>' +
        '<div class="pt-audiencias-lista">' +
            (lista || '<p class="pt-nota">Todavía no hay audiencias marcadas.</p>') +
        '</div>';
    pintarCalendario(); // el calendario vive en la columna derecha, siempre al día
}

/* Columna derecha: muestra el calendario al abrir la carpeta. Lo ven TODOS
   los de la carpeta (el deudor y los acreedores en solo lectura, para conocer
   las fechas de su trámite); marcar o notificar solo puede el personal. */
async function prepararCalendarioLateral(carpeta) {
    const aside = document.getElementById('pt-lateral-cal');
    if (!aside) return;
    aside.hidden = false;
    const cont = document.getElementById('calendario-audiencias');
    if (cont) cont.innerHTML = '';
    const hoy = new Date();
    _mesCalendario = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
    try {
        _audienciasCache = await audienciasListar(carpeta.id);
    } catch (e) {
        _audienciasCache = [];
    }
    // Rangos de los estados del trámite: SOLO personal y monitor.
    // El cliente y el acreedor ven ÚNICAMENTE las audiencias marcadas.
    _procesosCalLateral = [];
    if (ES_PERSONAL || ES_MONITOR) {
        try { _procesosCalLateral = await procesosListar(carpeta.id); } catch (e) { _procesosCalLateral = []; }
    }
    pintarCalendario();
}
let _procesosCalLateral = [];   // procesos de la carpeta abierta (rangos del calendario)

const MESES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];

function pintarCalendario() {
    const cont = document.getElementById('calendario-audiencias');
    if (!cont || !_mesCalendario) return;
    // El personal marca días; el deudor y los acreedores solo consultan
    const editable = carpetaAbierta && puedeGestionarCarpeta(carpetaAbierta);
    const anio = _mesCalendario.getFullYear();
    const mes = _mesCalendario.getMonth();
    const hoyISO = fechaISOLocal(new Date());
    const conAudiencia = {};
    for (const a of _audienciasCache) {
        (conAudiencia[a.fecha] = conAudiencia[a.fecha] || []).push(a.titulo || 'Audiencia');
    }

    // Rango de fechas de cada estado del trámite (inicio → vencimiento),
    // SOLO para personal/monitor (a cliente/acreedor nunca les llega nada
    // en _procesosCalLateral). Ej.: "Entrega de documentos: 2 al 5 de agosto".
    const enRango = {};   // iso → [nombres de proceso]
    for (const p of (_procesosCalLateral || [])) {
        if (p.completado || !p.fechaInicio || !p.fechaVencimiento) continue;
        const d = _aFecha(p.fechaInicio);
        const fin = _aFecha(p.fechaVencimiento);
        while (d <= fin) {
            const iso = _aISO(d);
            (enRango[iso] = enRango[iso] || []).push(p.nombre);
            d.setDate(d.getDate() + 1);
        }
    }

    // lunes = 0 … domingo = 6
    const primerDia = (new Date(anio, mes, 1).getDay() + 6) % 7;
    const diasMes = new Date(anio, mes + 1, 0).getDate();

    let celdas = '';
    for (let i = 0; i < primerDia; i++) celdas += '<span class="pt-cal__dia pt-cal__dia--vacio"></span>';
    for (let d = 1; d <= diasMes; d++) {
        const iso = anio + '-' + String(mes + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
        const marcas = conAudiencia[iso];
        const rangos = enRango[iso];
        const titulo = []
            .concat(marcas || [])
            .concat((rangos || []).map(n => 'Plazo: ' + n))
            .join(' · ');
        const clases = 'pt-cal__dia' +
            (rangos ? ' pt-cal__dia--rango' : '') +
            (marcas ? ' pt-cal__dia--audiencia' : '') +
            (iso === hoyISO ? ' pt-cal__dia--hoy' : '');
        if (editable) {
            celdas += '<button type="button" class="' + clases + '"' +
                ' data-accion="dia-calendario" data-fecha="' + iso + '"' +
                ' title="' + (titulo ? escaparHtml(titulo) : 'Marcar audiencia este día') + '"' +
                '>' + d + '</button>';
        } else {
            celdas += '<span class="' + clases + ' pt-cal__dia--solo"' +
                (titulo ? ' title="' + escaparHtml(titulo) + '"' : '') +
                '>' + d + '</span>';
        }
    }

    // Próximas audiencias (máx. 3), debajo del calendario: útiles para todos
    const proximas = _audienciasCache
        .filter(a => a.fecha >= hoyISO)
        .slice(0, 3)
        .map(a =>
            '<div class="pt-cal-prox__item">' +
                '<strong>' + escaparHtml(a.titulo || 'Audiencia') + '</strong>' +
                '<span>' + formatoFechaDia(a.fecha) + (a.hora ? ' · ' + escaparHtml(a.hora) : '') + '</span>' +
                (a.enlace ? '<a href="' + escaparHtml(a.enlace) + '" target="_blank" rel="noopener noreferrer">Enlace de la reunión</a>' : '') +
                (a.descripcion ? '<span class="pt-nota">' + escaparHtml(a.descripcion) + '</span>' : '') +
            '</div>').join('');

    cont.innerHTML =
        '<div class="pt-cal__barra">' +
            '<button type="button" class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="cal-mes" data-delta="-1" aria-label="Mes anterior">‹</button>' +
            '<strong>' + MESES[mes].charAt(0).toUpperCase() + MESES[mes].slice(1) + ' ' + anio + '</strong>' +
            '<button type="button" class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="cal-mes" data-delta="1" aria-label="Mes siguiente">›</button>' +
        '</div>' +
        '<div class="pt-cal__semana"><span>L</span><span>M</span><span>X</span><span>J</span><span>V</span><span>S</span><span>D</span></div>' +
        '<div class="pt-cal__rejilla">' + celdas + '</div>' +
        // Leyenda compacta: azul = Audiencias, naranja = Estados
        '<p class="pt-nota pt-cal__pie"><span class="pt-cal__punto"></span> Audiencias' +
            ((ES_PERSONAL || ES_MONITOR) ? ' · <span class="pt-cal__cuadro-rango"></span> Estados' : '') + '</p>' +
        (proximas
            ? '<div class="pt-cal-prox"><h4>Próximas audiencias</h4>' + proximas + '</div>'
            : '');
}

function cambiarMesCalendario(delta) {
    if (!_mesCalendario) return;
    _mesCalendario = new Date(_mesCalendario.getFullYear(), _mesCalendario.getMonth() + Number(delta || 0), 1);
    pintarCalendario();
}

function formatoFechaDia(iso) {
    // 'AAAA-MM-DD' → 'lunes, 20 de agosto de 2026' (sin correr el día por zona horaria)
    const [a, m, d] = String(iso).split('-').map(Number);
    if (!a || !m || !d) return String(iso);
    const t = new Date(a, m - 1, d).toLocaleDateString('es-CO', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
    return t.charAt(0).toUpperCase() + t.slice(1);
}

async function eliminarAudiencia(id) {
    if (!carpetaAbierta || !puedeGestionarCarpeta(carpetaAbierta)) return;
    if (!await confirmarPortal('¿Quitar esta audiencia del calendario?')) return;
    try {
        await audienciaEliminar(id);
        avisar('Audiencia eliminada del calendario.');
        await pintarAudiencias(carpetaAbierta);
    } catch (e) {
        avisar((e && e.message) || 'No se pudo eliminar la audiencia.', 'error');
    }
}

/* ---- Modal "Notificar audiencia" ---- */
let _audienciaExistenteId = null;   // si se notifica una ya marcada, no se duplica

async function abrirModalAudiencia(prefijado) {
    if (!carpetaAbierta || !puedeGestionarCarpeta(carpetaAbierta)) return;
    _audienciaExistenteId = (prefijado && prefijado.id) || null;
    const cont = document.getElementById('audiencia-destinatarios');
    cont.innerHTML = '<p class="pt-nota">Cargando personas del trámite…</p>';
    document.getElementById('audiencia-titulo').value = (prefijado && prefijado.titulo) || '';
    document.getElementById('audiencia-fecha').value = (prefijado && prefijado.fecha) || '';
    document.getElementById('audiencia-hora').value = (prefijado && prefijado.hora) || '';
    document.getElementById('audiencia-enlace').value = (prefijado && prefijado.enlace) || '';
    document.getElementById('audiencia-descripcion').value = (prefijado && prefijado.descripcion) || '';
    document.getElementById('modal-audiencia').hidden = false;

    try {
        _asignadosCache = await asignadosDeCarpeta(carpetaAbierta.id);
    } catch (e) {
        cont.innerHTML = '<p class="pt-nota">' + escaparHtml((e && e.message) || 'No se pudieron cargar los asignados.') + '</p>';
        return;
    }
    if (_asignadosCache.length === 0) {
        cont.innerHTML = '<p class="pt-nota">Esta carpeta no tiene deudores ni acreedores asignados.</p>';
        return;
    }
    cont.innerHTML = _asignadosCache.map(p =>
        '<label><input type="checkbox" value="' + escaparHtml(p.usuario) + '"' + (p.correo ? '' : ' disabled') + '> ' +
        escaparHtml(p.nombre) + ' <span class="pt-nota">(' + escaparHtml(ETIQUETAS_ROL[p.rol] || p.rol) + ' · ' +
        (p.correo ? escaparHtml(p.correo) : 'sin correo registrado') + ')</span></label>').join('');
}

function cerrarModalAudiencia() {
    document.getElementById('modal-audiencia').hidden = true;
    _audienciaExistenteId = null;
}

async function enviarNotificacionAudiencia(evento) {
    evento.preventDefault();
    if (!carpetaAbierta || !puedeGestionarCarpeta(carpetaAbierta)) return;
    const titulo = document.getElementById('audiencia-titulo').value.trim();
    const fecha = document.getElementById('audiencia-fecha').value;
    const hora = document.getElementById('audiencia-hora').value;
    const enlace = document.getElementById('audiencia-enlace').value.trim();
    const descripcionAud = document.getElementById('audiencia-descripcion').value.trim();
    const marcados = [...document.querySelectorAll('#audiencia-destinatarios input:checked')].map(c => c.value);
    const destinatarios = _asignadosCache.filter(p => marcados.includes(p.usuario) && p.correo);

    if (!titulo || !fecha || !hora) { avisar('Completa el nombre, la fecha y la hora de la audiencia.', 'error'); return; }
    if (destinatarios.length === 0) { avisar('Selecciona al menos un destinatario con correo registrado.', 'error'); return; }

    // 1) Se marca en el calendario (si no venía de una audiencia ya marcada)
    try {
        if (!_audienciaExistenteId) {
            await audienciaGuardar(carpetaAbierta.id, { titulo, fecha, hora, enlace, descripcion: descripcionAud });
        }
    } catch (e) {
        avisar((e && e.message) || 'No se pudo guardar la audiencia.', 'error');
        return;
    }

    // 2) Se abre el correo del operador con el mensaje listo para enviar
    const asunto = 'Citación a audiencia — ' + titulo;
    const cuerpo =
        'Cordial saludo,\n\n' +
        'La fundación le informa que se ha programado la siguiente audiencia dentro de su trámite:\n\n' +
        'Reunión: ' + titulo + '\n' +
        'Fecha: ' + formatoFechaDia(fecha) + '\n' +
        'Hora: ' + hora + '\n' +
        (enlace ? 'Enlace de la reunión (Meet): ' + enlace + '\n' : '') +
        (descripcionAud ? 'Detalles: ' + descripcionAud + '\n' : '') +
        '\nProceso: ' + carpetaAbierta.nombre + '\n\n' +
        'Por favor conéctese puntualmente. Si tiene inquietudes, responda este correo.\n\n' +
        'Atentamente,\n' + (sesion.nombre || sesion.usuario) + '\nFundación de insolvencia y conciliaciones.';
    const enlaceCorreo = document.createElement('a');
    enlaceCorreo.href = 'mailto:' + destinatarios.map(p => encodeURIComponent(p.correo)).join(',') +
        '?subject=' + encodeURIComponent(asunto) + '&body=' + encodeURIComponent(cuerpo);
    document.body.appendChild(enlaceCorreo);
    enlaceCorreo.click();
    enlaceCorreo.remove();

    registrarActividad('notificar-audiencia', titulo + ' (' + fecha + ' ' + hora + ') · ' +
        carpetaAbierta.nombre + ' · ' + destinatarios.length + ' destinatario(s)', carpetaAbierta.id);
    avisar('Se abrió tu correo con la notificación lista para ' + destinatarios.length + ' destinatario(s).');
    cerrarModalAudiencia();
    await refrescarAudiencias();
}

/* Recarga las audiencias y repinta el calendario (y el panel, si está abierto) */
async function refrescarAudiencias() {
    if (!carpetaAbierta || !puedeGestionarCarpeta(carpetaAbierta)) return;
    if (_subPanelCarpeta === 'audiencias') {
        await pintarAudiencias(carpetaAbierta);   // ya recarga la caché y el calendario
        return;
    }
    try {
        _audienciasCache = await audienciasListar(carpetaAbierta.id);
        pintarCalendario();
    } catch (e) { /* el calendario se actualizará al volver a la pestaña */ }
}

/* ============ RECORDATORIOS PERSONALES (privados del operador) ============ */
let _recordatorioEditandoId = null;

async function pintarRecordatorios(carpeta) {
    const panel = document.getElementById('panel-recordatorios');
    if (!panel || !carpeta || !puedeGestionarCarpeta(carpeta)) return;
    panel.innerHTML = '<p class="pt-nota" style="padding:1rem 0;">Cargando recordatorios…</p>';
    let lista = [];
    try {
        lista = await recordatoriosListar(carpeta.id);
    } catch (e) {
        panel.innerHTML = '<div class="pt-vacio">' + escaparHtml((e && e.message) || 'No se pudieron cargar los recordatorios.') + '</div>';
        return;
    }
    const hoy = fechaISOLocal(new Date());
    const filas = lista.map(r => {
        const vigente = r.fechaInicio <= hoy && hoy <= r.fechaFin;
        return '<div class="pt-recordatorio' + (vigente ? ' pt-recordatorio--vigente' : '') + '">' +
            '<span class="pt-recordatorio__ic">' + icono('campana', 17) + '</span>' +
            '<div class="pt-recordatorio__txt">' +
                '<p>' + escaparHtml(r.mensaje) + '</p>' +
                '<span class="pt-nota">Del ' + formatoFechaDia(r.fechaInicio) + ' al ' + formatoFechaDia(r.fechaFin) +
                (vigente ? ' · <strong>vigente</strong>' : '') + '</span>' +
            '</div>' +
            '<div class="pt-celda-acciones">' +
                '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="editar-recordatorio" data-id="' + r.id + '">Editar</button>' +
                '<button class="pt-boton pt-boton--peligro pt-boton--mini" data-accion="eliminar-recordatorio" data-id="' + r.id + '">Eliminar</button>' +
            '</div>' +
        '</div>';
    }).join('');

    panel.innerHTML =
        '<div class="pt-audiencias-cab">' +
            '<h3>' + icono('campana', 18) + ' Mis recordatorios de esta carpeta</h3>' +
            '<button class="pt-boton pt-boton--primario pt-boton--mini" data-accion="nuevo-recordatorio">+ Nuevo recordatorio</button>' +
        '</div>' +
        '<p class="pt-nota">Son privados: solo tú los ves. Mientras estén vigentes, aparecen en una ' +
            'ventana emergente cada vez que ingresas al portal.</p>' +
        (filas || '<p class="pt-nota" style="padding:.6rem 0;">No tienes recordatorios en esta carpeta.</p>');
    _recordatoriosPanelCache = lista;
}
let _recordatoriosPanelCache = [];

function abrirModalRecordatorio(recordatorio) {
    if (!carpetaAbierta || !puedeGestionarCarpeta(carpetaAbierta)) return;
    _recordatorioEditandoId = (recordatorio && recordatorio.id) || null;
    document.getElementById('modal-recordatorio-titulo').innerHTML =
        icono('campana', 18) + (recordatorio ? ' Editar recordatorio' : ' Nuevo recordatorio');
    document.getElementById('recordatorio-mensaje').value = (recordatorio && recordatorio.mensaje) || '';
    document.getElementById('recordatorio-desde').value = (recordatorio && recordatorio.fechaInicio) || '';
    document.getElementById('recordatorio-hasta').value = (recordatorio && recordatorio.fechaFin) || '';
    document.getElementById('modal-recordatorio').hidden = false;
    document.getElementById('recordatorio-mensaje').focus();
}

function cerrarModalRecordatorio() {
    document.getElementById('modal-recordatorio').hidden = true;
    _recordatorioEditandoId = null;
}

async function guardarRecordatorio(evento) {
    evento.preventDefault();
    if (!carpetaAbierta || !puedeGestionarCarpeta(carpetaAbierta)) return;
    const mensaje = document.getElementById('recordatorio-mensaje').value.trim();
    const fechaInicio = document.getElementById('recordatorio-desde').value;
    const fechaFin = document.getElementById('recordatorio-hasta').value;
    if (!mensaje || !fechaInicio || !fechaFin) { avisar('Completa el mensaje y el rango de fechas.', 'error'); return; }
    if (fechaFin < fechaInicio) { avisar('La fecha final no puede ser anterior a la inicial.', 'error'); return; }
    try {
        await recordatorioGuardar({
            id: _recordatorioEditandoId, carpetaId: carpetaAbierta.id,
            mensaje, fechaInicio, fechaFin
        });
        avisar(_recordatorioEditandoId ? 'Recordatorio actualizado.' : 'Recordatorio creado.');
    } catch (e) {
        avisar((e && e.message) || 'No se pudo guardar el recordatorio.', 'error');
        return;
    }
    cerrarModalRecordatorio();
    await pintarRecordatorios(carpetaAbierta);
}

async function eliminarRecordatorio(id) {
    if (!await confirmarPortal('¿Eliminar este recordatorio?')) return;
    try {
        await recordatorioEliminar(id);
        avisar('Recordatorio eliminado.');
        if (carpetaAbierta) await pintarRecordatorios(carpetaAbierta);
    } catch (e) {
        avisar((e && e.message) || 'No se pudo eliminar el recordatorio.', 'error');
    }
}

/* Ventana emergente (esquina) con los recordatorios vigentes al ingresar.
   APILADOS: se muestra UNA tarjeta a la vez ("1 de N"); al cerrarla se
   revela la siguiente, sin saturar la pantalla con una columna larga. */
let _pilaRecordatorios = [];

async function mostrarRecordatoriosVigentes() {
    if (!ES_PERSONAL) return;
    try { _pilaRecordatorios = (await recordatoriosVigentes()) || []; } catch (e) { return; }
    pintarPilaRecordatorios();
}

function pintarPilaRecordatorios() {
    const popup = document.getElementById('popup-recordatorios');
    if (!popup) return;
    if (_pilaRecordatorios.length === 0) { popup.hidden = true; return; }
    const r = _pilaRecordatorios[0];
    const detras = Math.min(_pilaRecordatorios.length - 1, 2); // hasta 2 "sombras" detrás
    let sombras = '';
    for (let i = detras; i >= 1; i--) {
        sombras += '<div class="pt-pila-sombra" style="transform:translate(' + (i * 6) + 'px,' + (i * 6) + 'px);"></div>';
    }
    document.getElementById('popup-recordatorios-lista').innerHTML =
        '<div class="pt-pila">' + sombras +
        '<div class="pt-popup-recordatorios__item pt-pila-frente">' +
            '<p>' + escaparHtml(r.mensaje) + '</p>' +
            '<span class="pt-nota">' + escaparHtml(r.carpetaNombre || '') +
                ' · hasta el ' + formatoFechaDia(r.fechaFin) + '</span>' +
            '<span class="pt-nota"><strong>1 de ' + _pilaRecordatorios.length + '</strong>' +
                (_pilaRecordatorios.length > 1 ? ' · al cerrar verás el siguiente' : '') + '</span>' +
        '</div></div>';
    popup.hidden = false;
}

/* Cierra el recordatorio visible y revela el siguiente de la pila */
function cerrarRecordatorioVisible() {
    _pilaRecordatorios.shift();
    pintarPilaRecordatorios();
}

/* ============ NOTIFICACIONES DE LA CARPETA (operador/admin) ============
   Solo la actividad de ESTA carpeta hecha por las partes del trámite
   (deudor/cliente y acreedores): entradas, vistas y descargas. */
// Acciones de las PARTES que quedan como constancia dentro de la carpeta:
// entradas al portal y a la carpeta, vistas, descargas y descarga del ZIP.
const ACCIONES_NOTIF_CARPETA = ['ingreso', 'abrir-carpeta', 'ver-archivo', 'descargar-archivo', 'descargar-zip'];
let _notifCarpetaCache = [];        // actividad de la carpeta abierta (partes)
let _rolNotifCarpeta = 'cliente';   // sección activa: 'cliente' (deudor) | 'acreedor'
let _acreedorNotifSel = '';         // acreedor elegido en la pestaña Acreedores ('' = todos)

async function pintarNotifCarpeta(carpeta) {
    const panel = document.getElementById('panel-notif-carpeta');
    if (!panel || !carpeta || !(puedeGestionarCarpeta(carpeta) || ES_MONITOR)) return;
    panel.innerHTML = '<p class="pt-nota" style="padding:1rem 0;">Cargando actividad de la carpeta…</p>';
    let eventos = [];
    try {
        eventos = await listarActividadDeCarpeta(carpeta.id);
    } catch (e) {
        panel.innerHTML = '<div class="pt-vacio">' + escaparHtml((e && e.message) || 'No se pudo cargar la actividad.') + '</div>';
        return;
    }
    _notifCarpetaCache = eventos.filter(e =>
        ['cliente', 'acreedor'].includes(e.rol) && ACCIONES_NOTIF_CARPETA.includes(e.accion));

    const deudor = _notifCarpetaCache.filter(e => e.rol === 'cliente').length;
    const acreedores = _notifCarpetaCache.filter(e => e.rol === 'acreedor').length;

    panel.innerHTML =
        '<div class="pt-audiencias-cab">' +
            '<h3>' + icono('ingreso', 18) + ' Notificaciones de esta carpeta</h3>' +
            '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="refrescar-notif-carpeta">' +
                icono('refrescar', 14) + ' Actualizar</button>' +
        '</div>' +
        '<p class="pt-nota">Entradas, vistas y descargas de las partes de este trámite, separadas por tipo:</p>' +
        // Secciones separadas: actividad del deudor y de los acreedores
        '<div class="pt-sub-pestanas" id="sub-pestanas-notif-carpeta">' +
            '<button class="' + (_rolNotifCarpeta === 'cliente' ? 'activa' : '') + '" data-accion="notif-carpeta-rol" data-rol="cliente">' +
                icono('usuario', 17) + ' Deudor (' + deudor + ')</button>' +
            '<button class="' + (_rolNotifCarpeta === 'acreedor' ? 'activa' : '') + '" data-accion="notif-carpeta-rol" data-rol="acreedor">' +
                icono('banco', 17) + ' Acreedores (' + acreedores + ')</button>' +
        '</div>' +
        // La barra de acreedores (selector + constancia) la pinta pintarListaNotifCarpeta
        // SOLO cuando la pestaña activa es "Acreedores".
        '<div id="barra-acreedores-notif"></div>' +
        '<div id="lista-notif-carpeta"></div>';
    pintarListaNotifCarpeta();
}

/* Constancia en PDF de que los acreedores ingresaron a la carpeta, vieron o
   descargaron documentos. El operador elige TODOS los acreedores o uno. */
async function descargarConstanciaAcreedores() {
    if (!carpetaAbierta) return;
    const sel = document.getElementById('constancia-acreedor');
    const usuarioElegido = sel ? sel.value : '';
    const eventos = _notifCarpetaCache.filter(e =>
        e.rol === 'acreedor' && (!usuarioElegido || e.usuario === usuarioElegido));
    if (eventos.length === 0) {
        avisar('No hay actividad de ' + (usuarioElegido ? 'ese acreedor' : 'acreedores') + ' para la constancia.', 'error');
        return;
    }
    try {
        const PDFLib = await cargarPdfLib();
        const doc = await PDFLib.PDFDocument.create();
        const fuente = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
        const fuenteNegrita = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold);

        let pagina = doc.addPage([612, 792]);
        let y = 742;
        const nuevaLinea = (texto, negrita, tam) => {
            if (y < 60) { pagina = doc.addPage([612, 792]); y = 742; }
            pagina.drawText(texto, { x: 50, y, size: tam || 10, font: negrita ? fuenteNegrita : fuente });
            y -= (tam ? tam + 6 : 15);
        };

        nuevaLinea('Portal Documental', true, 16);
        nuevaLinea('Constancia de actividad de acreedores en el tramite', true, 12);
        nuevaLinea('');
        nuevaLinea('Tramite: ' + carpetaAbierta.nombre, true);
        nuevaLinea('Alcance: ' + (usuarioElegido ? 'acreedor ' + nombreDe(usuarioElegido) + ' (' + usuarioElegido + ')' : 'todos los acreedores'));
        nuevaLinea('Generada: ' + formatoFecha(Date.now()) + ' por ' + (sesion.nombre || sesion.usuario));
        nuevaLinea('Total de eventos: ' + eventos.length);
        nuevaLinea('');
        for (const e of eventos) {
            const info = VERBOS_ACCION[e.accion] || { verbo: e.accion };
            nuevaLinea('- ' + formatoFecha(e.fecha) + ' | ' + (e.nombre || e.usuario) + ' ' + info.verbo +
                (e.objetivo ? ' "' + e.objetivo + '"' : ''));
        }

        const bytes = await doc.save();
        const blob = new Blob([bytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const enlace = document.createElement('a');
        enlace.href = url;
        enlace.download = 'constancia_acreedores_' + nombreArchivoSeguro(carpetaAbierta.nombre) + '.pdf';
        document.body.appendChild(enlace);
        enlace.click();
        enlace.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        registrarActividad('constancia-acreedores', carpetaAbierta.nombre +
            (usuarioElegido ? ' · ' + usuarioElegido : ' · todos'), carpetaAbierta.id);
        avisar('Constancia descargada: ' + eventos.length + ' evento(s).');
    } catch (e) {
        avisar((e && e.message) || 'No se pudo generar la constancia.', 'error');
    }
}

function cambiarRolNotifCarpeta(rol) {
    if (rol !== 'cliente' && rol !== 'acreedor') return;
    _rolNotifCarpeta = rol;
    _acreedorNotifSel = '';   // al cambiar de pestaña, se vuelve a "todos"
    document.querySelectorAll('#sub-pestanas-notif-carpeta button').forEach(b =>
        b.classList.toggle('activa', b.dataset.rol === rol));
    pintarListaNotifCarpeta();
}

function cambiarAcreedorNotif(usuario) {
    _acreedorNotifSel = usuario || '';
    pintarListaNotifCarpeta();
}

function pintarListaNotifCarpeta() {
    const lista = document.getElementById('lista-notif-carpeta');
    if (!lista) return;

    // Barra de acreedores: SOLO en la pestaña "Acreedores" (el deudor es único
    // por carpeta, así que allí no hay selector). Al elegir un acreedor, la
    // lista de abajo muestra SOLO sus notificaciones y la constancia también.
    const barra = document.getElementById('barra-acreedores-notif');
    if (barra) {
        if (_rolNotifCarpeta === 'acreedor') {
            const acreedores = [...new Set(_notifCarpetaCache.filter(e => e.rol === 'acreedor').map(e => e.usuario))];
            barra.hidden = false;
            barra.innerHTML = '<div class="pt-calv-filtros">' +
                '<label class="pt-nota">Acreedor: <select id="constancia-acreedor">' +
                    '<option value="">Todos los acreedores</option>' +
                    acreedores.map(u => '<option value="' + escaparHtml(u) + '"' +
                        (_acreedorNotifSel === u ? ' selected' : '') + '>' + escaparHtml(nombreDe(u)) + '</option>').join('') +
                '</select></label> ' +
                '<button class="pt-boton pt-boton--primario pt-boton--mini" data-accion="descargar-constancia-acreedores">' +
                    icono('descargar', 14) + ' Descargar constancia (PDF)' +
                    (_acreedorNotifSel ? ' de ' + escaparHtml(nombreDe(_acreedorNotifSel)) : '') + '</button>' +
                '</div>';
            const sel = document.getElementById('constancia-acreedor');
            if (sel) sel.addEventListener('change', (e) => cambiarAcreedorNotif(e.target.value));
        } else {
            barra.hidden = true;
            barra.innerHTML = '';
        }
    }

    let eventos = _notifCarpetaCache.filter(e => e.rol === _rolNotifCarpeta);
    // filtro por acreedor elegido
    if (_rolNotifCarpeta === 'acreedor' && _acreedorNotifSel) {
        eventos = eventos.filter(e => e.usuario === _acreedorNotifSel);
    }
    if (eventos.length === 0) {
        lista.innerHTML = '<p class="pt-nota" style="padding:.8rem 0;">Todavía no hay actividad ' +
            (_rolNotifCarpeta === 'cliente' ? 'del deudor'
                : (_acreedorNotifSel ? 'de ' + escaparHtml(nombreDe(_acreedorNotifSel)) : 'de los acreedores')) +
            ' en esta carpeta.</p>';
        return;
    }
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
                '<p><strong>' + escaparHtml(e.nombre || e.usuario) + '</strong>' +
                ' <span class="pt-insignia pt-insignia--rol">' + escaparHtml(ETIQUETAS_ROL[e.rol] || e.rol) + '</span> ' +
                escaparHtml(info.verbo) +
                (e.objetivo ? ' <span class="pt-notif__objetivo">«' + escaparHtml(e.objetivo) + '»</span>' : '') + '</p>' +
                '<p class="pt-notif__hora">' + hora + '</p>' +
            '</div>' +
        '</div>';
    }
    lista.innerHTML = html;
}

/* ============ GENERAR EXPEDIENTE (PDF unificado, admin/operador) ============
   El operador marca documentos uno por uno; el orden de selección es el orden
   del PDF final (y puede ajustarse arrastrando o con las flechas). Se unen
   PDF e imágenes (PNG/JPG); Word, Excel, audio y video no se pueden fusionar. */
const EXTENSIONES_EXPEDIENTE = ['pdf', 'png', 'jpg', 'jpeg'];
let _seleccionExpediente = [];   // ids en el ORDEN de selección

let _promesaPdfLib = null;
function cargarPdfLib() {
    if (window.PDFLib) return Promise.resolve(window.PDFLib);
    if (_promesaPdfLib) return _promesaPdfLib;
    _promesaPdfLib = new Promise((resolver, rechazar) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';
        script.onload = () => window.PDFLib
            ? resolver(window.PDFLib)
            : rechazar(new Error('No se pudo cargar el generador de PDF.'));
        script.onerror = () => {
            _promesaPdfLib = null;
            rechazar(new Error('Sin conexión para cargar el generador de PDF. Intenta de nuevo.'));
        };
        document.head.appendChild(script);
    });
    return _promesaPdfLib;
}

async function abrirModalExpediente() {
    if (!carpetaAbierta || !puedeGestionarCarpeta(carpetaAbierta)) return;
    _seleccionExpediente = [];
    document.getElementById('modal-expediente').hidden = false;
    const lista = document.getElementById('expediente-lista');
    lista.innerHTML = '<p class="pt-nota">Cargando documentos…</p>';
    const archivos = ordenarArchivos(await dbArchivosDeCarpeta(carpetaAbierta.id));
    _archivosCache = archivos;
    if (archivos.length === 0) {
        lista.innerHTML = '<p class="pt-nota">Esta carpeta no tiene documentos.</p>';
        document.getElementById('expediente-aviso').textContent = '';
        pintarBotonExpediente();
        return;
    }
    lista.innerHTML = archivos.map(a => {
        const ext = extensionDe(a.nombre);
        const fusionable = EXTENSIONES_EXPEDIENTE.includes(ext);
        return '<label class="pt-expediente-item' + (fusionable ? '' : ' pt-expediente-item--no') + '" data-id="' + a.id + '">' +
            '<span class="pt-expediente-item__num" data-num></span>' +
            '<input type="checkbox" data-accion-cambio="chequeo-expediente" value="' + a.id + '"' + (fusionable ? '' : ' disabled') + '>' +
            '<span class="pt-icono-archivo">' + iconoArchivo(ext) + '</span>' +
            '<span class="pt-expediente-item__nombre">' + escaparHtml(a.nombre) +
                (fusionable ? '' : ' <span class="pt-nota">(no se puede unir al PDF)</span>') + '</span>' +
            '<span class="pt-celda-acciones" data-flechas hidden>' +
                '<button type="button" class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="expediente-subir" data-id="' + a.id + '" title="Subir en el orden">' + icono('flecha-arriba', 14) + '</button>' +
                '<button type="button" class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="expediente-bajar" data-id="' + a.id + '" title="Bajar en el orden">' + icono('flecha-abajo', 14) + '</button>' +
            '</span>' +
        '</label>';
    }).join('');
    document.getElementById('expediente-aviso').textContent =
        'Solo se unen PDF e imágenes (PNG/JPG). Word, Excel, audio y video no pueden fusionarse en un PDF.';
    pintarBotonExpediente();
}

function cerrarModalExpediente() {
    document.getElementById('modal-expediente').hidden = true;
    _seleccionExpediente = [];
}

function alternarSeleccionExpediente(id, marcado) {
    if (marcado) {
        if (!_seleccionExpediente.includes(id)) _seleccionExpediente.push(id);
    } else {
        _seleccionExpediente = _seleccionExpediente.filter(x => x !== id);
    }
    pintarNumerosExpediente();
}

function moverSeleccionExpediente(id, delta) {
    const i = _seleccionExpediente.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= _seleccionExpediente.length) return;
    [_seleccionExpediente[i], _seleccionExpediente[j]] = [_seleccionExpediente[j], _seleccionExpediente[i]];
    pintarNumerosExpediente();
}

function pintarNumerosExpediente() {
    document.querySelectorAll('#expediente-lista .pt-expediente-item').forEach(item => {
        const id = Number(item.dataset.id);
        const pos = _seleccionExpediente.indexOf(id);
        const num = item.querySelector('[data-num]');
        const flechas = item.querySelector('[data-flechas]');
        num.textContent = pos >= 0 ? String(pos + 1) : '';
        item.classList.toggle('pt-expediente-item--elegido', pos >= 0);
        if (flechas) flechas.hidden = pos < 0;
    });
    pintarBotonExpediente();
}

function pintarBotonExpediente() {
    const boton = document.getElementById('boton-crear-expediente');
    boton.disabled = _seleccionExpediente.length === 0;
    boton.textContent = _seleccionExpediente.length > 0
        ? 'Generar PDF (' + _seleccionExpediente.length + ' documento' + (_seleccionExpediente.length === 1 ? '' : 's') + ')'
        : 'Generar PDF';
}

async function crearExpediente() {
    if (!carpetaAbierta || !puedeGestionarCarpeta(carpetaAbierta) || _seleccionExpediente.length === 0) return;
    const boton = document.getElementById('boton-crear-expediente');
    const textoOriginal = boton.textContent;
    boton.disabled = true;
    try {
        boton.textContent = 'Preparando…';
        const PDFLib = await cargarPdfLib();
        const expediente = await PDFLib.PDFDocument.create();
        let hechos = 0;

        for (const id of _seleccionExpediente) {
            hechos++;
            boton.textContent = 'Uniendo ' + hechos + '/' + _seleccionExpediente.length + '…';
            const archivo = await dbObtener('archivos', id);   // trae el contenido (blob)
            if (!archivo || !archivo.blob) continue;
            const ext = extensionDe(archivo.nombre);
            const bytes = await archivo.blob.arrayBuffer();

            if (ext === 'pdf') {
                const doc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
                const paginas = await expediente.copyPages(doc, doc.getPageIndices());
                for (const p of paginas) expediente.addPage(p);
            } else if (['png', 'jpg', 'jpeg'].includes(ext)) {
                const img = ext === 'png' ? await expediente.embedPng(bytes) : await expediente.embedJpg(bytes);
                // la imagen se ajusta a una página tamaño carta con margen
                const [anchoPag, altoPag] = [612, 792];
                const margen = 36;
                const escala = Math.min((anchoPag - margen * 2) / img.width, (altoPag - margen * 2) / img.height, 1);
                const pagina = expediente.addPage([anchoPag, altoPag]);
                pagina.drawImage(img, {
                    x: (anchoPag - img.width * escala) / 2,
                    y: (altoPag - img.height * escala) / 2,
                    width: img.width * escala,
                    height: img.height * escala
                });
            }
        }

        if (expediente.getPageCount() === 0) {
            avisar('Ninguno de los documentos seleccionados se pudo unir.', 'error');
            return;
        }
        boton.textContent = 'Generando PDF…';
        const bytesPdf = await expediente.save();
        const blob = new Blob([bytesPdf], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const enlace = document.createElement('a');
        enlace.href = url;
        enlace.download = nombreArchivoSeguro(carpetaAbierta.nombre) + '_expediente.pdf';
        document.body.appendChild(enlace);
        enlace.click();
        enlace.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);

        registrarActividad('generar-expediente',
            carpetaAbierta.nombre + ' (' + _seleccionExpediente.length + ' documentos)', carpetaAbierta.id);
        avisar('Expediente generado: ' + expediente.getPageCount() + ' página(s) en un solo PDF.');
        cerrarModalExpediente();
    } catch (e) {
        avisar((e && e.message) || 'No se pudo generar el expediente.', 'error');
    } finally {
        boton.disabled = false;
        boton.textContent = textoOriginal;
    }
}

/* ============ SUBIDA DE ARCHIVOS ============ */
async function subirArchivos(listaArchivos) {
    // Solo admin u operador responsable de ESTA carpeta
    if (!carpetaAbierta || !puedeGestionarCarpeta(carpetaAbierta)) return;
    const rechazados = [];
    const validos = [];

    for (const archivo of listaArchivos) {
        const ext = extensionDe(archivo.name);
        if (!EXTENSIONES_PERMITIDAS.includes(ext)) {
            rechazados.push(archivo.name + ' (tipo no permitido)');
        } else if (archivo.size > TAMANO_MAXIMO) {
            rechazados.push(archivo.name + ' (supera 50 MB)');
        } else {
            validos.push(archivo);
        }
    }

    // El operador decide si las partes pueden descargar lo que sube ahora
    const casillaDescarga = document.getElementById('subida-descargable');
    const descargablePartes = casillaDescarga ? casillaDescarga.checked : true;

    // Las subidas van EN PARALELO (antes eran una por una: con varios
    // archivos grandes la espera se multiplicaba)
    let subidos = 0;
    await Promise.all(validos.map(async (archivo) => {
        try {
            await dbAgregar('archivos', {
                carpetaId: carpetaAbierta.id,
                nombre: archivo.name,
                tipo: archivo.type || 'application/octet-stream',
                tamano: archivo.size,
                blob: archivo,
                descargablePartes: descargablePartes,
                subidoPor: sesion.nombre || sesion.usuario,
                fecha: Date.now()
            });
            registrarActividad('subir-archivo', archivo.name + ' · ' + carpetaAbierta.nombre, carpetaAbierta.id);
            subidos++;
        } catch (e) {
            rechazados.push(archivo.name + ' (' + ((e && e.message) || 'error al subir') + ')');
        }
    }));

    if (subidos > 0) avisar(subidos + ' archivo(s) subido(s) correctamente.');
    if (rechazados.length > 0) avisar('No se subió: ' + rechazados.join(', '), 'error');
    await pintarArchivos();
}

/* Cambia si el cliente/acreedor puede descargar un archivo (solo personal) */
async function alternarDescargaPartes(id) {
    if (!carpetaAbierta || !puedeGestionarCarpeta(carpetaAbierta)) return;
    const archivo = (_archivosCache || []).find(a => String(a.id) === String(id));
    const permitir = !(archivo && archivo.descargablePartes !== false);
    try {
        await fijarDescargaPartes(id, permitir);
        avisar(permitir ? 'Las partes ya pueden descargar este archivo.' : 'Las partes ya no pueden descargar este archivo.');
        await pintarArchivos();
    } catch (e) {
        avisar((e && e.message) || 'No se pudo cambiar la descarga del archivo.', 'error');
    }
}

async function descargarArchivo(id) {
    // El cliente y el acreedor solo bajan los documentos habilitados
    if (ES_CLIENTE || ES_ACREEDOR) {
        const enLista = (_archivosCache || []).find(a => String(a.id) === String(id));
        if (enLista && enLista.descargablePartes === false) {
            avisar('Este documento es de solo lectura: puedes verlo, pero no descargarlo.', 'error');
            return;
        }
    }
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
    registrarActividad('descargar-archivo', archivo.nombre + (carpetaAbierta ? ' · ' + carpetaAbierta.nombre : ''), archivo.carpetaId);
}

async function verArchivo(id) {
    const archivo = await dbObtener('archivos', id);
    if (!archivo) return;
    const ext = extensionDe(archivo.nombre);
    registrarActividad('ver-archivo', archivo.nombre + (carpetaAbierta ? ' · ' + carpetaAbierta.nombre : ''), archivo.carpetaId);

    // Word y Excel se renderizan DENTRO del portal (visor propio)
    if (['doc', 'docx'].includes(ext)) { verDocumentoWord(archivo); return; }
    if (['xls', 'xlsx'].includes(ext)) { verDocumentoExcel(archivo); return; }

    // PDF, imágenes, audio y video: visor nativo del navegador
    const url = URL.createObjectURL(archivo.blob);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/* ---- Visor de Office en un modal (docx-preview y SheetJS por CDN) ---- */
function abrirModalVisor(titulo) {
    document.getElementById('visor-titulo').textContent = titulo;
    document.getElementById('visor-cuerpo').innerHTML =
        '<p class="pt-nota" style="padding:2rem;">Cargando vista previa…</p>';
    document.getElementById('modal-visor').hidden = false;
}
function cerrarModalVisor() {
    document.getElementById('modal-visor').hidden = true;
    document.getElementById('visor-cuerpo').innerHTML = '';
}

let _promesaDocx = null;
function cargarDocxPreview() {
    if (window.docx && window.docx.renderAsync) return Promise.resolve(window.docx);
    if (_promesaDocx) return _promesaDocx;
    _promesaDocx = new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/docx-preview@0.3.3/dist/docx-preview.min.js';
        s.onload = () => window.docx ? res(window.docx) : rej(new Error('No se pudo cargar el visor de Word.'));
        s.onerror = () => { _promesaDocx = null; rej(new Error('Sin conexión para cargar el visor de Word.')); };
        document.head.appendChild(s);
    });
    return _promesaDocx;
}
let _promesaXLSX = null;
function cargarSheetJS() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (_promesaXLSX) return _promesaXLSX;
    _promesaXLSX = new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
        s.onload = () => window.XLSX ? res(window.XLSX) : rej(new Error('No se pudo cargar el visor de Excel.'));
        s.onerror = () => { _promesaXLSX = null; rej(new Error('Sin conexión para cargar el visor de Excel.')); };
        document.head.appendChild(s);
    });
    return _promesaXLSX;
}

async function verDocumentoWord(archivo) {
    abrirModalVisor(archivo.nombre);
    try {
        const docx = await cargarDocxPreview();
        const cont = document.getElementById('visor-cuerpo');
        cont.innerHTML = '';
        await docx.renderAsync(archivo.blob, cont, null, { className: 'pt-docx', inWrapper: false });
    } catch (e) {
        document.getElementById('visor-cuerpo').innerHTML =
            '<div class="pt-vacio">' + escaparHtml((e && e.message) || 'No se pudo mostrar el documento.') +
            ' Puedes descargarlo para abrirlo en Word.</div>';
    }
}

async function verDocumentoExcel(archivo) {
    abrirModalVisor(archivo.nombre);
    try {
        const XLSX = await cargarSheetJS();
        const buffer = await archivo.blob.arrayBuffer();
        const libro = XLSX.read(buffer, { type: 'array' });
        let html = '';
        libro.SheetNames.forEach((nombre, i) => {
            html += '<h3 class="pt-visor-hoja">' + icono('hoja', 16) + ' ' + escaparHtml(nombre) + '</h3>' +
                '<div class="pt-tabla-envoltura">' +
                XLSX.utils.sheet_to_html(libro.Sheets[nombre], { editable: false }) + '</div>';
        });
        document.getElementById('visor-cuerpo').innerHTML = html || '<div class="pt-vacio">La hoja está vacía.</div>';
    } catch (e) {
        document.getElementById('visor-cuerpo').innerHTML =
            '<div class="pt-vacio">' + escaparHtml((e && e.message) || 'No se pudo mostrar la hoja.') +
            ' Puedes descargarla para abrirla en Excel.</div>';
    }
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
    // Se guarda el HTML (no el texto): el botón contiene un icono SVG que
    // se perdería si al final se restaurara con textContent.
    const contenidoOriginal = boton.innerHTML;
    boton.disabled = true;
    try {
        boton.textContent = 'Recopilando archivos…';
        const archivos = await descargarBlobsDeCarpeta(carpetaAbierta.id, (hechos, total) => {
            boton.textContent = 'Descargando ' + hechos + '/' + total + '…';
        });
        // El personal se lleva la carpeta completa; las partes, solo lo permitido
        if (archivos.length === 0) {
            avisar((ES_CLIENTE || ES_ACREEDOR)
                ? 'Ningún documento de esta carpeta está disponible para descarga.'
                : 'Esta carpeta no tiene documentos para descargar.', 'error');
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
        registrarActividad('descargar-zip', carpetaAbierta.nombre + ' (' + archivos.length + ' archivos)', carpetaAbierta.id);
        avisar('Carpeta descargada: ' + archivos.length + ' archivo(s) en un ZIP.');
    } catch (e) {
        avisar((e && e.message) || 'No se pudo crear el ZIP.', 'error');
    } finally {
        boton.disabled = false;
        boton.innerHTML = contenidoOriginal;
    }
}

async function eliminarArchivo(id) {
    // Solo admin u operador responsable de la carpeta abierta
    if (!carpetaAbierta || !puedeGestionarCarpeta(carpetaAbierta)) return;
    const archivo = await dbObtener('archivos', id);
    if (!archivo) return;
    if (!await confirmarPortal('¿Eliminar el archivo "' + archivo.nombre + '"? Esta acción no se puede deshacer.')) return;
    await dbEliminar('archivos', id);
    registrarActividad('eliminar-archivo', archivo.nombre + ' · ' + carpetaAbierta.nombre, carpetaAbierta.id);
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

    // Listas SEPARADAS por rol (pestañas Operadores / Clientes / Acreedores)
    const operadores = usuarios.filter(u => u.rol === 'operador');
    const operadoresMarcados = carpeta ? (carpeta.operadores || []) : [];
    document.getElementById('carpeta-operadores').innerHTML = operadores.length === 0
        ? '<p class="pt-nota">No hay operadores creados todavía.</p>'
        : operadores.map(u => filaCheque(u, operadoresMarcados)).join('');

    const marcados = carpeta ? (carpeta.asignados || []) : [];
    const clientes = usuarios.filter(u => u.rol === 'cliente');
    document.getElementById('carpeta-clientes').innerHTML = clientes.length === 0
        ? '<p class="pt-nota">No hay clientes creados todavía.</p>'
        : clientes.map(u => filaCheque(u, marcados)).join('');
    const acreedores = usuarios.filter(u => u.rol === 'acreedor');
    document.getElementById('carpeta-acreedores').innerHTML = acreedores.length === 0
        ? '<p class="pt-nota">No hay acreedores creados todavía.</p>'
        : acreedores.map(u => filaCheque(u, marcados)).join('');

    cambiarTabRolCarpeta('operadores');
    document.getElementById('modal-carpeta').hidden = false;
}

function cambiarTabRolCarpeta(grupo) {
    if (!['operadores', 'clientes', 'acreedores'].includes(grupo)) return;
    document.querySelectorAll('#carpeta-tabs-roles button').forEach(b =>
        b.classList.toggle('activa', b.dataset.grupo === grupo));
    for (const g of ['operadores', 'clientes', 'acreedores']) {
        document.getElementById('grupo-' + g).hidden = (g !== grupo);
    }
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
    const asignados = [
        ...document.querySelectorAll('#carpeta-clientes input:checked'),
        ...document.querySelectorAll('#carpeta-acreedores input:checked')
    ].map(c => c.value);

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
    if (!await confirmarPortal('¿Eliminar la carpeta "' + carpeta.nombre + '" y TODOS sus archivos? Esta acción no se puede deshacer.')) return;
    await dbEliminarArchivosDeCarpeta(id);
    await dbEliminar('carpetas', id);
    registrarActividad('eliminar-carpeta', carpeta.nombre);
    avisar('Carpeta eliminada.');
    await mostrarVistaCarpetas();
}

/* ============ VISTA: USUARIOS (administrador) ============ */
let _usuariosCache = [];        // todos los usuarios (para filtrar sin recargar)
let _filtroRolUsuarios = '';    // '' = todos los roles
let _busquedaUsuarios = '';     // texto del buscador

async function mostrarVistaUsuarios() {
    if (!ES_ADMIN) return;
    mostrarVista('vista-usuarios');
    _usuariosCache = await dbTodos('usuarios');
    _usuariosCache.sort((a, b) => a.usuario.localeCompare(b.usuario));
    pintarListaUsuarios();
}

const ORDEN_ROLES_USUARIOS = ['administrador', 'monitor', 'operador', 'cliente', 'acreedor'];

function pintarListaUsuarios() {
    const q = _busquedaUsuarios.trim().toLowerCase();
    let usuarios = _usuariosCache.filter(u =>
        (!_filtroRolUsuarios || u.rol === _filtroRolUsuarios) &&
        (!q || (u.usuario || '').toLowerCase().includes(q) ||
               (u.nombre || '').toLowerCase().includes(q) ||
               (u.correo || '').toLowerCase().includes(q)));
    // Ordenar por rol (según jerarquía) y luego por nombre
    usuarios.sort((a, b) =>
        (ORDEN_ROLES_USUARIOS.indexOf(a.rol) - ORDEN_ROLES_USUARIOS.indexOf(b.rol)) ||
        (a.nombre || '').localeCompare(b.nombre || ''));

    const cuerpo = document.getElementById('lista-usuarios');
    const vacio = document.getElementById('usuarios-vacio');
    if (vacio) vacio.hidden = usuarios.length > 0;

    let html = '';
    let rolActual = null;
    for (const u of usuarios) {
        // Encabezado de grupo por rol (solo cuando NO hay filtro de un rol único)
        if (!_filtroRolUsuarios && u.rol !== rolActual) {
            rolActual = u.rol;
            const cuantos = usuarios.filter(x => x.rol === rolActual).length;
            html += '<tr class="pt-fila-grupo-rol"><td colspan="8">' +
                escaparHtml(ETIQUETAS_ROL[rolActual] || rolActual) + 's · ' + cuantos + '</td></tr>';
        }
        const activo = u.activo !== false;
        const estado = activo
            ? '<span class="pt-insignia pt-insignia--activa">Activo</span>'
            : '<span class="pt-insignia pt-insignia--inactiva">Desactivado</span>';
        const uEsc = escaparHtml(u.usuario);
        let acciones = '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="editar-usuario" data-usuario="' + uEsc + '">Editar</button>';
        if (u.usuario === sesion.usuario) {
            acciones += ' <span class="pt-nota">(tú)</span>';
        } else {
            acciones += ' <button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="alternar-usuario" data-usuario="' + uEsc + '">' + (activo ? 'Desactivar' : 'Activar') + '</button>' +
                ' <button class="pt-boton pt-boton--peligro pt-boton--mini" data-accion="eliminar-usuario" data-usuario="' + uEsc + '">Eliminar</button>';
        }
        html += '<tr>' +
            '<td><code>' + escaparHtml(u.usuario) + '</code></td>' +
            '<td>' + escaparHtml(u.nombre) + '</td>' +
            '<td><span class="pt-insignia pt-insignia--rol">' + escaparHtml(ETIQUETAS_ROL[u.rol] || u.rol) + '</span></td>' +
            '<td>' + estado + '</td>' +
            '<td>' + puntoConexion(u.usuario) + '</td>' +
            '<td>' + (u.ultimaConexion ? formatoFecha(u.ultimaConexion) : '<span class="pt-nota">nunca</span>') + '</td>' +
            '<td>' + formatoFecha(u.creado) + '</td>' +
            '<td><div class="pt-celda-acciones">' + acciones + '</div></td>' +
            '</tr>';
    }
    cuerpo.innerHTML = html;
}

function cambiarFiltroRolUsuario(rol) {
    _filtroRolUsuarios = rol || '';
    document.querySelectorAll('#filtro-rol-usuarios button').forEach(b =>
        b.classList.toggle('activa', (b.dataset.rol || '') === _filtroRolUsuarios));
    pintarListaUsuarios();
}

/* Exporta los usuarios a Excel con UNA PESTAÑA POR ROL. Nota importante:
   las contraseñas NO se pueden incluir — viven cifradas (bcrypt) en Supabase
   Auth y ni el portal ni el administrador pueden leerlas. La columna queda
   vacía; para dar una clave nueva se usa "Editar → restablecer contraseña". */
async function exportarUsuariosExcel() {
    if (!ES_ADMIN) return;
    try {
        const XLSX = await cargarSheetJS();
        const libro = XLSX.utils.book_new();
        const roles = [
            ['administrador', 'Administradores'],
            ['acreedor', 'Acreedores'],
            ['cliente', 'Deudores'],
            ['operador', 'Operadores'],
            ['monitor', 'Monitores']
        ];
        for (const [rol, tituloHoja] of roles) {
            const filas = _usuariosCache.filter(u => u.rol === rol).map(u => ({
                Usuario: u.usuario,
                Nombre: u.nombre,
                Rol: ETIQUETAS_ROL[u.rol] || u.rol,
                Correo: u.correo || '',
                'Contraseña': '',   // no recuperable (cifrada en el servidor)
                Estado: u.activo === false ? 'Desactivado' : 'Activo',
                'Última conexión': u.ultimaConexion ? new Date(u.ultimaConexion).toLocaleString('es-CO') : ''
            }));
            // Aunque no haya usuarios de ese rol, se crea la hoja con encabezados
            const hoja = XLSX.utils.json_to_sheet(filas.length ? filas :
                [{ Usuario: '', Nombre: '', Rol: '', Correo: '', 'Contraseña': '', Estado: '', 'Última conexión': '' }]);
            XLSX.utils.book_append_sheet(libro, hoja, tituloHoja);
        }
        XLSX.writeFile(libro, 'usuarios_portal_mascaribe.xlsx');
        registrarActividad('exportar-usuarios', 'Excel de usuarios');
        avisar('Excel descargado. La columna Contraseña va vacía: las claves están cifradas y no se pueden leer.');
    } catch (e) {
        avisar((e && e.message) || 'No se pudo generar el Excel.', 'error');
    }
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
    'actualizar-estado':  { ic: 'estado',         verbo: 'actualizó la etapa de' },
    'actualizar-notas':   { ic: 'editar',         verbo: 'actualizó las notas de' },
    'actualizar-deudor':  { ic: 'usuario',        verbo: 'actualizó los datos del deudor de' },
    'mensaje-chat':       { ic: 'chat',           verbo: 'escribió en el chat' },
    'notificar-audiencia':{ ic: 'campana',        verbo: 'notificó la audiencia' },
    'generar-expediente': { ic: 'expediente',     verbo: 'generó el expediente de' },
    'ordenar-documentos': { ic: 'editar',         verbo: 'reorganizó los documentos de' },
    'crear-proceso':      { ic: 'estado',         verbo: 'creó el proceso' },
    'completar-proceso':  { ic: 'activar',        verbo: 'completó el proceso' },
    'eliminar-proceso':   { ic: 'eliminar',       verbo: 'eliminó el proceso' },
    'pausar-tramite':     { ic: 'desactivar',     verbo: 'pausó el trámite' },
    'iniciar-tramite':    { ic: 'estado',         verbo: 'inició el conteo (60 días) de' },
    'prorroga-tramite':   { ic: 'estado',         verbo: 'aplicó la prórroga (90 días) a' },
    'llamada-soporte':    { ic: 'chat',           verbo: 'llamó por soporte a' },
    'fin-tramite':        { ic: 'activar',        verbo: 'dio fin al trámite' },
    'consentimiento':     { ic: 'documento',      verbo: 'aceptó la política de datos' },
    'constancia-acreedores': { ic: 'descargar',   verbo: 'descargó la constancia de acreedores de' },
    'reactivar-tramite':  { ic: 'activar',        verbo: 'reactivó el trámite' },
    'corregir-proceso':   { ic: 'editar',         verbo: 'corrigió el proceso' }
};
const ROLES_NOTIF = ['cliente', 'acreedor', 'operador', 'monitor'];
let _actividadCache = [];
let _rolNotifActivo = 'cliente';
let _filtroNotifCarpeta = '';   // '' = toda la actividad; id = solo esa carpeta

async function mostrarVistaNotificaciones() {
    if (!ES_SUPERVISION) return; // administrador y monitor (solo lectura)
    mostrarVista('vista-notificaciones');
    document.getElementById('lista-notificaciones').innerHTML =
        '<p class="pt-nota" style="padding:2rem;">Cargando actividad…</p>';
    const [actividad, carpetas] = await Promise.all([listarActividad(), dbTodos('carpetas')]);
    _actividadCache = actividad;

    // Filtro por carpeta: al elegir una, las pestañas muestran SOLO el
    // operador, cliente y acreedores de esa carpeta
    const zona = document.getElementById('filtro-notif-carpeta-zona');
    if (zona) {
        zona.innerHTML = '<label class="pt-nota">' + icono('buscar', 14) + ' Carpeta: ' +
            '<select id="filtro-notif-carpeta">' +
            '<option value="">Todas las carpetas</option>' +
            carpetas.sort((a, b) => a.nombre.localeCompare(b.nombre)).map(c =>
                '<option value="' + c.id + '"' + (String(_filtroNotifCarpeta) === String(c.id) ? ' selected' : '') + '>' +
                escaparHtml(c.nombre) + '</option>').join('') +
            '</select></label>';
        document.getElementById('filtro-notif-carpeta').addEventListener('change', (e) => {
            _filtroNotifCarpeta = e.target.value;
            pintarNotificaciones();
        });
    }
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
    // Muestra TODA la actividad del rol: ingresos al portal, entradas a la
    // carpeta, vistas y descargas de documentos, descarga de la carpeta (ZIP),
    // notificaciones de audiencia por correo, etc. Al filtrar por carpeta, los
    // ingresos al portal (que no están atados a carpeta) siguen apareciendo.
    const eventos = _actividadCache.filter(e =>
        e.rol === _rolNotifActivo &&
        (!_filtroNotifCarpeta || String(e.carpetaId) === String(_filtroNotifCarpeta) || e.accion === 'ingreso'));
    const lista = document.getElementById('lista-notificaciones');
    const vacio = document.getElementById('notificaciones-vacio');

    if (eventos.length === 0) {
        lista.innerHTML = '';
        vacio.hidden = false;
        vacio.textContent = 'Todavía no hay actividad registrada de ' + ETIQUETAS_ROL[_rolNotifActivo].toLowerCase() + 's' +
            (_filtroNotifCarpeta ? ' en esa carpeta.' : '.');
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
    const correo = document.getElementById('nuevo-correo').value.trim();

    if (!usuario || !nombre || clave.length < 8 || !ROLES_VALIDOS.includes(rol)) {
        avisar('Revisa los datos: la contraseña necesita mínimo 8 caracteres.', 'error');
        return;
    }
    // El correo es obligatorio: se usa para avisos y notificaciones del trámite
    if (!correo || !esCorreoValido(correo)) {
        avisar('Registra un correo de contacto válido para el usuario.', 'error');
        return;
    }
    const existente = await dbObtener('usuarios', usuario);
    if (existente) {
        avisar('Ya existe un usuario con ese nombre.', 'error');
        return;
    }
    try {
        const aviso = await crearUsuarioDatos(usuario, nombre, rol, clave, correo);
        avisar(aviso || ('Usuario "' + usuario + '" creado.'), aviso ? 'error' : undefined);
    } catch (e) {
        avisar(e.message || 'No se pudo crear el usuario.', 'error');
        return;
    }
    document.getElementById('form-usuario').reset();
    await mostrarVistaUsuarios();
}

function esCorreoValido(c) {
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(c || ''));
}

/* ============ EDITAR USUARIO (nombre, rol y restablecer contraseña) ============
   No se puede VER la contraseña anterior (se guarda cifrada); el administrador
   pone una NUEVA y se la entrega al usuario que la olvidó. */
let usuarioEditando = null;

function abrirModalUsuario(usuario) {
    if (!ES_ADMIN || !usuario) return;
    usuarioEditando = usuario;
    document.getElementById('editar-usuario-id').value = usuario.usuario;
    document.getElementById('editar-nombre').value = usuario.nombre || '';
    document.getElementById('editar-correo').value = usuario.correo || '';
    document.getElementById('editar-clave').value = '';
    document.getElementById('editar-notificar').checked = false;
    document.getElementById('modal-usuario').hidden = false;
    document.getElementById('editar-nombre').focus();
}

function cerrarModalUsuario() {
    document.getElementById('modal-usuario').hidden = true;
    usuarioEditando = null;
}

async function guardarEdicionUsuario(evento) {
    evento.preventDefault();
    if (!ES_ADMIN || !usuarioEditando) return;

    const nombre = document.getElementById('editar-nombre').value.trim();
    const correo = document.getElementById('editar-correo').value.trim();
    const clave = document.getElementById('editar-clave').value;
    const notificar = document.getElementById('editar-notificar').checked;

    if (!nombre) { avisar('El nombre no puede quedar vacío.', 'error'); return; }
    if (correo && !esCorreoValido(correo)) { avisar('El correo de contacto no tiene un formato válido.', 'error'); return; }
    if (clave && clave.length < 8) { avisar('La contraseña nueva necesita mínimo 8 caracteres.', 'error'); return; }
    if (notificar && !clave) { avisar('Marca «notificar» solo cuando pongas una contraseña nueva.', 'error'); return; }
    if (notificar && !correo) { avisar('Para notificar, el usuario debe tener un correo de contacto.', 'error'); return; }

    try {
        await dbGuardar('usuarios', { ...usuarioEditando, nombre, correo });
        if (clave) {
            await restablecerClave(usuarioEditando, clave);
            // Si el usuario tenía una solicitud de restablecimiento pendiente,
            // se marca como resuelta automáticamente.
            try {
                const pendientes = await solicitudesClaveListar();
                const suya = pendientes.find(s => s.usuario === usuarioEditando.usuario);
                if (suya) await solicitudClaveResolver(suya.id);
            } catch (e) { /* no bloquea el cambio de clave */ }
        }
        avisar('Usuario actualizado' + (clave ? ', contraseña restablecida.' : '.'));
        if (notificar && clave && correo) {
            notificarClavePorCorreo({ nombre, usuario: usuarioEditando.usuario, correo, clave });
        }
    } catch (e) {
        avisar((e && e.message) || 'No se pudo actualizar el usuario.', 'error');
        return;
    }
    cerrarModalUsuario();
    await mostrarVistaUsuarios();
}

/* Abre el correo del administrador con el aviso ya redactado (mailto):
   no se envía solo, el administrador solo confirma el envío. */
function notificarClavePorCorreo(datos) {
    const asunto = 'Portal Documental — tu contraseña fue restablecida';
    const cuerpo =
        'Hola ' + datos.nombre + ',\n\n' +
        'El administrador restableció tu contraseña del Portal Documental.\n\n' +
        'Usuario: ' + datos.usuario + '\n' +
        'Nueva contraseña: ' + datos.clave + '\n\n' +
        'Ingresa y, por seguridad, cámbiala cuando puedas.\n\n' +
        'Fundación de insolvencia y conciliaciones.';
    const enlace = document.createElement('a');
    enlace.href = 'mailto:' + encodeURIComponent(datos.correo) +
        '?subject=' + encodeURIComponent(asunto) +
        '&body=' + encodeURIComponent(cuerpo);
    document.body.appendChild(enlace);
    enlace.click();
    enlace.remove();
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
    if (!await confirmarPortal('¿Eliminar al usuario "' + nombreUsuario + '"?')) return;
    await dbEliminar('usuarios', nombreUsuario);
    avisar('Usuario eliminado.');
    await mostrarVistaUsuarios();
}

/* ============ EVENTOS ============ */
function conectarEventos() {
    // Delegación: un solo escuchador para todos los botones con data-accion
    document.addEventListener('click', (evento) => {
        // La campana se cierra al hacer clic fuera de ella
        const dd = document.getElementById('campana-dropdown');
        if (dd && !dd.hidden && !evento.target.closest('.pt-campana-envoltura')) dd.hidden = true;

        const boton = evento.target.closest('[data-accion]');
        if (!boton) return;
        const id = Number(boton.dataset.id);

        switch (boton.dataset.accion) {
            case 'salir':             confirmarSalida(); break;
            case 'salir-sitio':       confirmarSalida('../index.html'); break; // volver al sitio cierra la sesión
            case 'ver-carpetas':      mostrarVistaCarpetas(); break;

            // Estados de los trámites (semáforos) y calendario de vencimientos
            case 'ver-estados':          mostrarVistaEstados(); break;
            case 'refrescar-estados':    cargarYPintarEstados(); break;
            case 'ver-calendario-vencimientos': mostrarVistaCalendarioVenc(); break;
            case 'refrescar-calendario': mostrarVistaCalendarioVenc(); break;
            case 'nuevo-proceso':        abrirModalProceso(id); break;
            case 'cerrar-modal-proceso': cerrarModalProceso(); break;
            case 'completar-proceso':    completarProcesoAccion(id); break;
            case 'eliminar-proceso':     eliminarProcesoAccion(id); break;
            case 'pausar-tramite':       pausarTramiteAccion(id); break;
            case 'reactivar-tramite':    reactivarTramiteAccion(id); break;
            case 'iniciar-tramite':      iniciarTramiteAccion(id); break;
            case 'prorroga-tramite':     prorrogaTramiteAccion(id); break;
            case 'filtro-estados':       cambiarFiltroEstados(boton.dataset.filtro); break;

            // Chat de soporte flotante y llamadas
            case 'soporte-abrir':        abrirSoporte(); break;
            case 'soporte-minimizar':
                // el clic en un botón interno de la cabecera no minimiza dos veces
                minimizarSoporte(); break;
            case 'soporte-volver':       evento.stopPropagation(); pintarSoporteLista(); break;
            case 'soporte-elegir':
                abrirHiloSoporte({ id: boton.dataset.uuid, nombre: boton.dataset.nombre }); break;
            case 'soporte-llamar':       evento.stopPropagation(); iniciarLlamadaSoporte(); break;
            case 'quitar-adjunto-soporte': quitarAdjuntoSoporte(); break;
            case 'descargar-adjunto-soporte': descargarAdjuntoDeSoporte(id); break;
            case 'llamada-aceptar':      aceptarLlamada(); break;
            case 'llamada-colgar':       terminarLlamada(true); break;
            case 'llamada-mic':          alternarMicrofono(); break;
            case 'llamada-altavoz':      alternarAltavoz(); break;

            // Campana de notificaciones
            case 'campana-abrir':        alternarCampana(); break;
            case 'campana-leidas':       marcarCampanaLeidas(); break;

            // Usuarios: filtro por rol y exportar Excel
            case 'filtro-rol-usuario':   cambiarFiltroRolUsuario(boton.dataset.rol); break;
            case 'exportar-usuarios-excel': exportarUsuariosExcel(); break;

            // Confirmación propia, consentimiento y panel de consentimientos
            case 'confirmar-si':         _responderConfirmacion(true); break;
            case 'confirmar-no':         _responderConfirmacion(false); break;
            case 'consentimiento-aceptar': aceptarConsentimientoAccion(); break;
            case 'usuarios-panel':       cambiarPanelUsuarios(boton.dataset.panel); break;

            // Backlog: credenciales, fin de trámite, deep links, chat flotante y llamada mini
            case 'generar-credenciales': generarCredenciales(); break;
            case 'generar-clave-editar': generarClaveEditar(); break;
            case 'finalizar-tramite':    finalizarTramiteAccion(id); break;
            case 'notif-abrir':          abrirDesdeNotificacion(boton.dataset.tipo, id || null, boton.dataset.mensaje); break;
            case 'notif-eliminar':       evento.stopPropagation(); eliminarNotificacion(boton.dataset.notif, boton.closest('.pt-campana-item')); break;
            case 'carpeta-tab-rol':      cambiarTabRolCarpeta(boton.dataset.grupo); break;
            case 'chat-carpeta-abrir':   abrirChatCarpeta(); break;
            case 'chat-carpeta-minimizar': minimizarChatCarpeta(); break;
            case 'llamada-minimizar':    minimizarLlamada(); break;
            case 'llamada-restaurar':    restaurarLlamada(); break;
            case 'llamada-mic-mini':     alternarMicrofono(); break;
            case 'llamada-altavoz-mini': alternarAltavoz(); break;
            case 'editar-proceso':       abrirModalEditarProceso(id); break;
            case 'cerrar-modal-editar-proceso': cerrarModalEditarProceso(); break;
            case 'detalle-tramite':
                // si el clic fue en un botón interno de la fila, ese botón manda
                if (evento.target.closest('button') && evento.target.closest('button').dataset.accion !== 'detalle-tramite') break;
                abrirDetalleTramite(id); break;
            case 'cerrar-modal-detalle-tramite': cerrarDetalleTramite(); break;
            case 'cerrar-modal-visor':   cerrarModalVisor(); break;
            case 'cal-venc-mes':         cambiarMesCalVenc(boton.dataset.delta); break;
            case 'cal-venc-dia':         _diaCalVencSel = boton.dataset.fecha; pintarCalendarioVenc(); break;
            case 'cal-venc-limpiar':
                _filtroCalOperador = ''; _filtroCalTramite = ''; _diaCalVencSel = null;
                pintarCalendarioVenc(); break;

            // Constancias descargables (consentimientos y actividad de acreedores)
            case 'consentimiento-ver':       verConsentimiento(id); break;
            case 'consentimiento-descargar': descargarConstanciaConsentimiento(id); break;
            case 'descargar-constancia-acreedores': descargarConstanciaAcreedores(); break;

            case 'filtro-carpetas':   cambiarFiltroCarpetas(boton.dataset.filtro); break;
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
            case 'alternar-descarga-partes': alternarDescargaPartes(id); break;
            case 'eliminar-archivo':  eliminarArchivo(id); break;
            case 'alternar-usuario':  alternarUsuario(boton.dataset.usuario); break;
            case 'eliminar-usuario':  eliminarUsuario(boton.dataset.usuario); break;
            case 'editar-usuario':    dbObtener('usuarios', boton.dataset.usuario).then(u => u && abrirModalUsuario(u)); break;
            case 'cerrar-modal-usuario': cerrarModalUsuario(); break;
            case 'editar-descripcion':   mostrarEditorDescripcion(); break;
            case 'cancelar-descripcion': ocultarEditorDescripcion(); break;
            case 'sub-carpeta':          cambiarSubPestanaCarpeta(boton.dataset.panel); break;
            case 'descargar-zip':        descargarCarpetaZip(); break;
            case 'chat-canal':           cambiarCanal(boton.dataset.canal); break;
            case 'descargar-adjunto':    descargarAdjuntoDeChat(id); break;
            case 'quitar-adjunto-chat':  quitarAdjuntoChat(); break;

            // Audiencias (calendario + notificación por correo)
            case 'cal-mes':              cambiarMesCalendario(boton.dataset.delta); break;
            case 'dia-calendario':       abrirModalAudiencia({ fecha: boton.dataset.fecha }); break;
            case 'notificar-audiencia':  abrirModalAudiencia(null); break;
            case 'notificar-audiencia-existente': {
                const a = _audienciasCache.find(x => x.id === id);
                if (a) abrirModalAudiencia(a);
                break;
            }
            case 'eliminar-audiencia':   eliminarAudiencia(id); break;
            case 'cerrar-modal-audiencia': cerrarModalAudiencia(); break;

            // Recordatorios personales
            case 'nuevo-recordatorio':   abrirModalRecordatorio(null); break;
            case 'editar-recordatorio': {
                const r = _recordatoriosPanelCache.find(x => x.id === id);
                if (r) abrirModalRecordatorio(r);
                break;
            }
            case 'eliminar-recordatorio': eliminarRecordatorio(id); break;
            case 'cerrar-modal-recordatorio': cerrarModalRecordatorio(); break;
            case 'cerrar-popup-recordatorios': cerrarRecordatorioVisible(); break;

            // Notificaciones de la carpeta (operador)
            case 'refrescar-notif-carpeta': pintarNotifCarpeta(carpetaAbierta); break;
            case 'notif-carpeta-rol':       cambiarRolNotifCarpeta(boton.dataset.rol); break;

            // Editar documentos (orden manual)
            case 'editar-documentos':    empezarEdicionOrden(); break;
            case 'guardar-orden':        guardarOrdenDocumentos(); break;
            case 'cancelar-orden':       cancelarEdicionOrden(); break;
            case 'orden-subir':          moverArchivoEnOrden(id, -1); break;
            case 'orden-bajar':          moverArchivoEnOrden(id, 1); break;

            // Generar expediente (PDF unificado)
            case 'generar-expediente':   abrirModalExpediente(); break;
            case 'cerrar-modal-expediente': cerrarModalExpediente(); break;
            case 'crear-expediente':     crearExpediente(); break;
            case 'expediente-subir':     moverSeleccionExpediente(id, -1); break;
            case 'expediente-bajar':     moverSeleccionExpediente(id, 1); break;
        }
    });

    // Checkbox del expediente: el orden en que se marcan define el orden del PDF
    document.addEventListener('change', (e) => {
        if (e.target.dataset && e.target.dataset.accionCambio === 'chequeo-expediente') {
            alternarSeleccionExpediente(Number(e.target.value), e.target.checked);
        }
    });

    document.getElementById('form-carpeta').addEventListener('submit', guardarCarpeta);
    document.getElementById('form-usuario').addEventListener('submit', crearUsuario);
    document.getElementById('form-editar-usuario').addEventListener('submit', guardarEdicionUsuario);
    document.getElementById('form-descripcion').addEventListener('submit', guardarDescripcion);
    document.getElementById('form-mensaje').addEventListener('submit', enviarMensaje);
    document.getElementById('form-audiencia').addEventListener('submit', enviarNotificacionAudiencia);
    document.getElementById('form-recordatorio').addEventListener('submit', guardarRecordatorio);
    document.getElementById('form-proceso').addEventListener('submit', crearProcesoDesdeModal);
    document.getElementById('form-editar-proceso').addEventListener('submit', guardarEdicionProceso);
    document.getElementById('form-soporte').addEventListener('submit', enviarSoporte);

    // Adjuntos del chat de soporte: por clip y por arrastrar-soltar
    const soporteAdjunto = document.getElementById('soporte-adjunto');
    if (soporteAdjunto) {
        soporteAdjunto.addEventListener('change', () => {
            if (soporteAdjunto.files && soporteAdjunto.files[0]) ponerAdjuntoSoporte(soporteAdjunto.files[0]);
        });
    }
    const soportePanel = document.getElementById('soporte-panel');
    if (soportePanel) {
        soportePanel.addEventListener('dragover', (e) => { e.preventDefault(); soportePanel.classList.add('pt-arrastrando'); });
        soportePanel.addEventListener('dragleave', (e) => {
            if (!soportePanel.contains(e.relatedTarget)) soportePanel.classList.remove('pt-arrastrando');
        });
        soportePanel.addEventListener('drop', (e) => {
            e.preventDefault();
            soportePanel.classList.remove('pt-arrastrando');
            if (document.getElementById('form-soporte').hidden) return; // sin hilo abierto no se adjunta
            if (e.dataTransfer && e.dataTransfer.files.length > 0) ponerAdjuntoSoporte(e.dataTransfer.files[0]);
        });
    }

    // Buscadores (carpetas y estados): filtran al escribir
    const buscadorCarpetas = document.getElementById('buscador-carpetas');
    if (buscadorCarpetas) buscadorCarpetas.addEventListener('input', () => {
        _busquedaCarpetas = buscadorCarpetas.value;
        pintarCarpetasSegunFiltro();
    });
    const buscadorEstados = document.getElementById('buscador-estados');
    if (buscadorEstados) buscadorEstados.addEventListener('input', () => {
        _busquedaEstados = buscadorEstados.value;
        pintarEstados();
    });
    const buscadorUsuarios = document.getElementById('buscador-usuarios');
    if (buscadorUsuarios) buscadorUsuarios.addEventListener('input', () => {
        _busquedaUsuarios = buscadorUsuarios.value;
        pintarListaUsuarios();
    });

    // Vista previa del vencimiento al escribir el plazo del proceso nuevo
    document.getElementById('proceso-dias').addEventListener('input', () => {
        const dias = Math.floor(Number(document.getElementById('proceso-dias').value));
        document.getElementById('proceso-venc-previo').textContent =
            (dias && dias > 0)
                ? 'Si se crea hoy, vence el ' + formatoVencimiento(calcularVencimientoHabil(new Date(), dias)) + '.'
                : '';
    });

    // Adjuntar archivo en el chat (todos los participantes del canal)
    const adjuntoChat = document.getElementById('chat-adjunto');
    if (adjuntoChat) {
        adjuntoChat.addEventListener('change', () => {
            if (adjuntoChat.files && adjuntoChat.files[0]) ponerAdjuntoChat(adjuntoChat.files[0]);
        });
    }

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

    // Cerrar los modales al hacer clic fuera de la caja
    document.getElementById('modal-carpeta').addEventListener('click', (e) => {
        if (e.target.id === 'modal-carpeta') cerrarModalCarpeta();
    });
    document.getElementById('modal-usuario').addEventListener('click', (e) => {
        if (e.target.id === 'modal-usuario') cerrarModalUsuario();
    });
    document.getElementById('modal-audiencia').addEventListener('click', (e) => {
        if (e.target.id === 'modal-audiencia') cerrarModalAudiencia();
    });
    document.getElementById('modal-recordatorio').addEventListener('click', (e) => {
        if (e.target.id === 'modal-recordatorio') cerrarModalRecordatorio();
    });
    document.getElementById('modal-expediente').addEventListener('click', (e) => {
        if (e.target.id === 'modal-expediente') cerrarModalExpediente();
    });
    document.getElementById('modal-proceso').addEventListener('click', (e) => {
        if (e.target.id === 'modal-proceso') cerrarModalProceso();
    });
    document.getElementById('modal-editar-proceso').addEventListener('click', (e) => {
        if (e.target.id === 'modal-editar-proceso') cerrarModalEditarProceso();
    });
    document.getElementById('modal-detalle-tramite').addEventListener('click', (e) => {
        if (e.target.id === 'modal-detalle-tramite') cerrarDetalleTramite();
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

