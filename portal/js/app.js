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

// Grabaciones de audiencias y documentos del expediente se guardan
// aparte: los medios solo entran en la subcarpeta de audiencias y los
// documentos solo fuera de ella. Ver destinoAdmiteExtension().
const EXTENSIONES_MEDIA = ['mp3', 'mp4', 'm4a', 'wav', 'ogg', 'mov', 'webm'];
const EXTENSIONES_DOCUMENTO = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'png', 'jpg', 'jpeg'];
const EXTENSIONES_PERMITIDAS = EXTENSIONES_DOCUMENTO.concat(EXTENSIONES_MEDIA);
// Vista dentro del portal: PDF/imágenes/audio/video en visor nativo; Word y
// Excel se renderizan con librerías (docx-preview y SheetJS), ver verArchivo.
const EXTENSIONES_VISTA = EXTENSIONES_PERMITIDAS.slice();
// 50 MB: es el file_size_limit del bucket 'documentos' en esquema.sql.
// Estaba en 100 MB, así que un archivo de 60 MB pasaba la validación del
// navegador y lo rechazaba Storage al subirlo.
const TAMANO_MAXIMO = 50 * 1024 * 1024;

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

/* Nombre visible de un usuario. El propio sale de la sesión; el de
   los demás del mapa que se llena al cargar los perfiles. Si no está,
   se muestra el nombre de usuario en crudo. */
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

/* Arranque de la aplicación. Pinta el encabezado, conecta los
   escuchadores de eventos y abre la vista de carpetas. Sin sesión
   válida no hace nada: de eso ya se encargó la comprobación de arriba. */
let _arranqueHecho = false;

async function iniciar() {
    if (!SESION_VALIDA) return;
    pintarEncabezado();
    conectarEventos();
    pintarLeyes();

    // Con dos o más notarías hay que preguntar antes de pintar nada:
    // no tiene sentido cargar carpetas de una oficina que quizá no sea
    // la que el usuario quiere abrir.
    const listo = await prepararNotarias();
    if (!listo) return;

    _arranqueHecho = true;
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

/* Cierra la sesión previa confirmación. El destino permite volver al
   sitio principal en vez de a la pantalla de ingreso. */
async function confirmarSalida(destino) {
    if (!await confirmarPortal(
        'Estás a punto de finalizar tu sesión segura bajo los lineamientos del ' +
        'Decreto 0042 de 2026. ¿Deseas confirmar y salir del portal?',
        'Cerrar sesión')) return;
    _cerrandoSesion = true;   // salida intencional: no dispares el aviso del navegador
    cerrarSesion(destino);    // limpia los tokens de Supabase y redirige al login
}

/* Avisa antes de cerrar la pestaña con la sesión abierta, para que no
   se pierda trabajo sin querer. No se dispara cuando la salida es
   intencional (botón de cerrar sesión). */
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

/* Punto de color con el estado de conexión de un usuario. El atributo
   data-usuario-conexion permite refrescarlo sin repintar la fila entera. */
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

/* Rellena el formulario de alta con un usuario y una clave al azar.
   Usa crypto.getRandomValues, no Math.random: la clave inicial no debe
   ser adivinable a partir del momento en que se generó. */
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

/* Lista de leyes de insolvencia con enlace al texto oficial. Abre en
   pestaña nueva con rel="noopener" para que la página destino no pueda
   manipular la del portal. */
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

/* Iniciales para el avatar de la barra lateral: «Oscar Prieto» → OP */
function inicialesDe(nombre) {
    const partes = String(nombre || '').trim().split(/\s+/).filter(Boolean);
    if (!partes.length) return '—';
    return (partes[0][0] + (partes.length > 1 ? partes[partes.length - 1][0] : '')).toUpperCase();
}

/* Nombre y rol del usuario en la barra superior, avatar con iniciales y
   las pestañas que le corresponden a su rol. Las que no le tocan quedan
   ocultas aquí; el permiso real lo aplica el servidor. */
function pintarEncabezado() {
    const chip = document.getElementById('chip-usuario');
    if (chip) {
        chip.innerHTML = escaparHtml(sesion.nombre) +
            ' <span class="pt-insignia pt-insignia--rol">' + escaparHtml(ETIQUETAS_ROL[sesion.rol] || sesion.rol) + '</span>';
    }
    // Persona conectada, al pie de la barra lateral
    const avatar = document.getElementById('mi-avatar');
    const nombre = document.getElementById('mi-nombre');
    const rol = document.getElementById('mi-rol');
    if (avatar) avatar.textContent = inicialesDe(sesion.nombre || sesion.usuario);
    if (nombre) nombre.textContent = sesion.nombre || sesion.usuario;
    if (rol) rol.textContent = ETIQUETAS_ROL[sesion.rol] || sesion.rol;
    // Estados: personal (operador gestiona los suyos) y supervisión (admin/monitor ven todo)
    document.getElementById('pestana-estados').hidden = !(ES_PERSONAL || ES_MONITOR);
    // Calendario: supervisión (todo) y operador (sus carpetas + recordatorios)
    document.getElementById('pestana-calendario').hidden = !(ES_SUPERVISION || ES_OPERADOR);
    document.getElementById('pestana-usuarios').hidden = !ES_ADMIN; // el monitor NUNCA la ve
    document.getElementById('pestana-notificaciones').hidden = !ES_SUPERVISION;
    document.getElementById('boton-nueva-carpeta').hidden = !ES_ADMIN;
}

/* ============ BARRA LATERAL ============
   Debajo de 900 px la columna se sale de pantalla y se abre por
   encima del contenido, con una tapa que la cierra al tocarla.
   En escritorio se pliega para ganar ancho, sobre todo dentro de
   una carpeta, y la elección se recuerda entre sesiones. */
function alternarLateral(abrir) {
    const lateral = document.getElementById('lateral');
    const tapa = document.getElementById('lateral-tapa');
    if (!lateral || !tapa) return;
    const visible = abrir === undefined ? !lateral.classList.contains('abierta') : abrir;
    lateral.classList.toggle('abierta', visible);
    tapa.hidden = !visible;
}

const LATERAL_PLEGADO = 'portal_lateral_plegado';

/* Pliega o despliega la barra lateral en escritorio y recuerda la
   elección entre sesiones. */
function plegarLateral(plegar) {
    const marco = document.querySelector('.pt-marco');
    if (!marco) return;
    const oculto = plegar === undefined
        ? !marco.classList.contains('pt-marco--plegado')
        : plegar;
    marco.classList.toggle('pt-marco--plegado', oculto);
    // Al desplegar se cierra también el cajón de móvil, para no dejar
    // las dos formas de la barra activas a la vez
    if (!oculto) alternarLateral(false);
    try { localStorage.setItem(LATERAL_PLEGADO, oculto ? '1' : '0'); } catch (e) {}
}

/* El botón ☰ sirve para las dos formas de la barra: cajón en móvil,
   despliegue en escritorio. */
function mostrarLateral() {
    if (window.matchMedia('(max-width: 900px)').matches) alternarLateral(true);
    else plegarLateral(false);
}

// Estado guardado, antes de que el usuario vea la pantalla
try {
    if (localStorage.getItem(LATERAL_PLEGADO) === '1') {
        document.addEventListener('DOMContentLoaded', () => plegarLateral(true));
    }
} catch (e) {}

/* Menú «⋯» de una fila: solo uno abierto a la vez. Se cierra al
   hacer clic fuera (ver el listener de cierre más abajo). */
function alternarMenuFila(idLista) {
    const lista = document.getElementById(idLista);
    if (!lista) return;
    const abrir = lista.hidden;
    document.querySelectorAll('.pt-menu__lista').forEach(m => {
        m.hidden = true;
        m.classList.remove('pt-menu__lista--arriba');
    });
    lista.hidden = !abrir;
    if (!abrir) return;
    // Si no cabe debajo, se abre hacia arriba
    const caja = lista.getBoundingClientRect();
    if (caja.bottom > window.innerHeight - 8) {
        lista.classList.add('pt-menu__lista--arriba');
    }
}

/* Cierra todos los menús «...» abiertos. Solo puede haber uno abierto
   a la vez, y un clic fuera los cierra. */
function cerrarMenusFila() {
    document.querySelectorAll('.pt-menu__lista').forEach(m => { m.hidden = true; });
}

/* Panel lateral de alta de usuario */
function alternarCajonUsuario(abrir) {
    const cajon = document.getElementById('cajon-usuario');
    const tapa = document.getElementById('cajon-usuario-tapa');
    if (!cajon || !tapa) return;
    const visible = abrir === undefined ? !cajon.classList.contains('abierto') : abrir;
    cajon.classList.toggle('abierto', visible);
    tapa.hidden = !visible;
    if (visible) {
        const primero = document.getElementById('nuevo-usuario');
        if (primero) primero.focus();
        // Las casillas de notaría dependen del rol elegido, así que se
        // pintan al abrir y se repintan cuando el rol cambia
        cargarCatalogoNotarias().then(() => pintarNotariasDeFormulario([]));
    }
}

/* ============ CACHÉ DE NAVEGACIÓN ============
   Cada clic en el menú volvía a pedir al servidor los mismos
   conjuntos (carpetas, procesos, perfiles), así que volver a una
   sección ya vista costaba otra vuelta completa de red y la pantalla
   se quedaba en blanco mientras tanto.

   Ahora se pinta al instante con lo último que se vio y la consulta
   sigue por detrás; si el servidor trae algo distinto, se repinta.
   La copia guardada nunca se usa sola: en cada navegación se
   revalida, así que como mucho se ve el estado anterior el tiempo
   que tarde la respuesta. */
const _cacheDatos = new Map();

/* Devuelve la copia guardada de un conjunto, o undefined si no hay. */
function cacheLeer(clave) {
    const e = _cacheDatos.get(clave);
    return e ? e.valor : undefined;
}

/* Pide al servidor, guarda y dice si el resultado cambió.
   La comparación es por JSON: los conjuntos son planos y salen
   siempre del mismo mapeador, así que el orden de claves es estable. */
async function cacheRefrescar(clave, traer) {
    const valor = await traer();
    const texto = JSON.stringify(valor);
    const antes = _cacheDatos.get(clave);
    const cambio = !antes || antes.texto !== texto;
    _cacheDatos.set(clave, { valor, texto });
    return { valor, cambio };
}

/* Descarta toda la caché de navegación. */
function cacheOlvidar() { _cacheDatos.clear(); }

/* Toda acción que no sea de lectura cambia los datos, así que tira la
   caché. Se envuelve registrarActividad porque ya se llama en cada
   punto que escribe; envolverla evita tener que acordarse de
   invalidar en treinta sitios distintos. */
const ACCIONES_DE_LECTURA = new Set([
    'ingreso', 'abrir-carpeta', 'ver-archivo', 'descargar-archivo',
    'descargar-zip', 'exportar-estados', 'exportar-usuarios',
    'generar-expediente', 'constancia-acreedores', 'llamada-soporte'
]);
if (typeof window.registrarActividad === 'function') {
    const _registrarOriginal = window.registrarActividad;
    window.registrarActividad = function (accion, objetivo, carpetaId) {
        if (!ACCIONES_DE_LECTURA.has(accion)) cacheOlvidar();
        return _registrarOriginal(accion, objetivo, carpetaId);
    };
}

/* ============ NOTARÍAS ============
   El portal atiende varias oficinas. Cada carpeta vive en una y cada
   usuario trabaja en una o varias.

   Una sola regla gobierna toda la interfaz: con dos o más notarías el
   usuario elige al entrar, con una entra directo. No hay condiciones
   por rol. Un operador de una sola ciudad no nota ningún cambio.

   Dos conceptos que NO son lo mismo y conviene no mezclar:

     - Notarías permitidas: seguridad. Las decide la base de datos, en
       notarias_del_usuario(), y de ahí cuelga puede_ver_carpeta().
     - Notaría activa: preferencia de pantalla. Vive en localStorage y
       solo filtra lo que se muestra.

   Si la activa fallara, lo peor que pasa es que se vea de más dentro
   de lo que el usuario ya tenía permitido. Nunca de otra oficina. */

const NOTARIA_ACTIVA = 'portal_notaria';
let _notariasDisponibles = [];   // donde puede entrar quien tiene la sesión
let _notariaActiva = null;       // id de la que está abierta; null = todas

/* Datos de la notaría abierta, o null si se está viendo todo */
function notariaActual() {
    if (_notariaActiva === null) return null;
    return _notariasDisponibles.find(n => String(n.id) === String(_notariaActiva)) || null;
}

/* ¿Una carpeta pertenece a la notaría abierta?
   Con "todas las notarías" pasa cualquiera. */
function esDeNotariaActiva(carpeta) {
    if (_notariaActiva === null) return true;
    return String(carpeta.notariaId) === String(_notariaActiva);
}

/* Deja solo las carpetas de la notaría abierta. Es un filtro de vista,
   no de seguridad: lo que llega ya viene filtrado por la base. */
function filtrarPorNotaria(carpetas) {
    return (carpetas || []).filter(esDeNotariaActiva);
}

/* ¿Trabaja este usuario en la notaría indicada?
   Los usuarios de cada oficina son distintos: un cliente de Santa Marta
   no aparece en Medellín. La excepción es el operador al que se le
   dieron varias, y el administrador, que está en todas.

   Con notaria en null se está mirando "Todas las notarías" y pasan
   todos. */
function usuarioEnNotaria(u, notaria) {
    if (notaria === null || notaria === undefined) return true;
    if (!u) return false;
    if (u.rol === 'administrador') return true;
    const suyas = (u.notarias && u.notarias.length)
        ? u.notarias
        : (u.notariaId ? [u.notariaId] : []);
    // Sin notarías configuradas todavía (antes de la migración) no se
    // filtra nada: el portal se comporta como una sola oficina
    if (!suyas.length) return !_notariasDisponibles.length;
    return suyas.some(n => String(n) === String(notaria));
}

/* Carga las notarías del usuario y decide si hay que preguntar.
   Devuelve true si el portal puede arrancar, false si se quedó en la
   pantalla de selección esperando respuesta. */
async function prepararNotarias() {
    try {
        _notariasDisponibles = await misNotarias();
    } catch (e) {
        _notariasDisponibles = [];
    }

    // Sin notarías configuradas el portal funciona como antes, en una
    // sola oficina. Es lo que pasa antes de aplicar la migración.
    if (!_notariasDisponibles.length) {
        _notariaActiva = null;
        pintarNotariaActiva();
        return true;
    }

    // Una sola: se entra directo, sin preguntar nada
    if (_notariasDisponibles.length === 1 && !ES_ADMIN) {
        _notariaActiva = _notariasDisponibles[0].id;
        guardarNotariaActiva();
        pintarNotariaActiva();
        return true;
    }

    // Si ya había elegido antes y la elección sigue siendo válida, se respeta
    let guardada = null;
    try { guardada = localStorage.getItem(NOTARIA_ACTIVA); } catch (e) {}
    if (guardada === 'todas' && ES_ADMIN) {
        _notariaActiva = null;
        pintarNotariaActiva();
        return true;
    }
    if (guardada && _notariasDisponibles.some(n => String(n.id) === String(guardada))) {
        _notariaActiva = Number(guardada);
        pintarNotariaActiva();
        return true;
    }

    mostrarPantallaNotarias();
    return false;
}

/* Oficina marcada en la pantalla, todavía sin confirmar. Se separa de
   _notariaActiva porque marcar no es entrar: el usuario puede mirar las
   cifras de varias antes de decidir. */
let _notariaMarcada = null;

/* Pantalla de selección. La ve quien tiene dos o más oficinas, y el
   administrador siempre, porque es donde las administra. */
function mostrarPantallaNotarias() {
    const pantalla = document.getElementById('pt-elegir');
    const lista = document.getElementById('pt-elegir-lista');
    if (!pantalla || !lista) return;

    // Se parte de la que ya esté abierta, o de la primera
    _notariaMarcada = (_notariaActiva !== null)
        ? String(_notariaActiva)
        : (ES_ADMIN && _notariasDisponibles.length > 1 ? 'todas'
           : (_notariasDisponibles[0] ? String(_notariasDisponibles[0].id) : null));

    lista.innerHTML = _notariasDisponibles.map(n => tarjetaNotaria(n)).join('') +
        // El administrador puede además mirar todo junto, para el
        // panorama general en Estados y Calendario
        (ES_ADMIN && _notariasDisponibles.length > 1 ? tarjetaTodasLasNotarias() : '');

    // Quién está conectado, en el panel de la izquierda
    const avatar = document.getElementById('elegir-avatar');
    if (avatar) avatar.textContent = inicialesDe(sesion.nombre || sesion.usuario);
    const nom = document.getElementById('elegir-nombre');
    if (nom) nom.textContent = sesion.nombre || sesion.usuario;
    const rol = document.getElementById('elegir-rol');
    if (rol) rol.textContent = (ETIQUETAS_ROL[sesion.rol] || sesion.rol).toUpperCase();

    const estado = document.getElementById('elegir-estado');
    if (estado) {
        const activas = _notariasDisponibles.length;
        estado.innerHTML = '<i></i>' + activas +
            (activas === 1 ? ' oficina activa' : ' oficinas activas');
    }

    pantalla.hidden = false;
    document.querySelector('.pt-marco').hidden = true;

    // "Volver al portal" solo si ya había una oficina abierta. Al entrar
    // por primera vez todavía no hay a dónde volver.
    const volver = document.getElementById('boton-volver-portal');
    if (volver) volver.hidden = !_arranqueHecho;

    pintarSeleccionNotaria();
    pintarGestionNotarias();
}

/* Una oficina, con las cifras que permiten decidir sin entrar */
function tarjetaNotaria(n) {
    return '<button class="pt-oficina" data-accion="marcar-notaria" data-notaria="' + n.id + '">' +
        '<span class="pt-oficina__cab">' +
            '<span class="pt-oficina__ciudad">' + escaparHtml(n.ciudad) + '</span>' +
            '<span class="pt-oficina__tic" aria-hidden="true"></span>' +
        '</span>' +
        '<span class="pt-oficina__nombre">' + escaparHtml(n.nombre) + '</span>' +
        '<span class="pt-oficina__cifras">' +
            '<span class="pt-oficina__cifra">' +
                '<b>' + n.carpetas + '</b><small>carpetas activas</small></span>' +
            '<span class="pt-oficina__cifra' + (n.porVencer ? ' pt-oficina__cifra--alerta' : '') + '">' +
                '<b>' + (n.porVencer || '—') + '</b><small>por vencer</small></span>' +
        '</span>' +
    '</button>';
}

function tarjetaTodasLasNotarias() {
    const carpetas = _notariasDisponibles.reduce((t, n) => t + n.carpetas, 0);
    return '<button class="pt-oficina pt-oficina--todas" data-accion="marcar-notaria" data-notaria="todas">' +
        '<span class="pt-oficina__cab">' +
            '<span class="pt-oficina__ciudad">Todas las notarías</span>' +
            '<span class="pt-oficina__tic" aria-hidden="true"></span>' +
        '</span>' +
        '<span class="pt-oficina__nombre">Panorama general</span>' +
        '<span class="pt-oficina__cifras pt-oficina__cifras--texto">' +
            carpetas + ' carpetas activas en ' + _notariasDisponibles.length + ' oficinas' +
            '<br>Solo lectura consolidada' +
        '</span>' +
    '</button>';
}

/* Marca una oficina sin entrar todavía */
function marcarNotaria(valor) {
    _notariaMarcada = String(valor);
    pintarSeleccionNotaria();
}

/* Refleja la marca en las tarjetas y en el botón de entrar */
function pintarSeleccionNotaria() {
    document.querySelectorAll('#pt-elegir-lista .pt-oficina').forEach(b =>
        b.classList.toggle('activa', b.dataset.notaria === _notariaMarcada));

    const boton = document.getElementById('boton-entrar-notaria');
    if (!boton) return;
    if (!_notariaMarcada) {
        boton.disabled = true;
        boton.textContent = 'Entrar';
        return;
    }
    boton.disabled = false;
    const n = _notariasDisponibles.find(x => String(x.id) === _notariaMarcada);
    boton.textContent = n ? 'Entrar a ' + n.ciudad : 'Ver todas las notarías';
}

/* Confirma la oficina marcada */
async function entrarNotariaMarcada() {
    if (!_notariaMarcada) return;
    await elegirNotaria(_notariaMarcada);
}

function guardarNotariaActiva() {
    try {
        localStorage.setItem(NOTARIA_ACTIVA,
            _notariaActiva === null ? 'todas' : String(_notariaActiva));
    } catch (e) {}
}

/* Arranca lo que quedó pendiente cuando el portal esperó a que el
   usuario eligiera oficina */
async function completarArranque() {
    if (_arranqueHecho) return;
    _arranqueHecho = true;
    await mostrarVistaCarpetas();
    mostrarRecordatoriosVigentes();
    iniciarSoporte();
    iniciarCampana();
    verificarConsentimiento();
    avisarCierresPendientes();
    registrarConexion();
    presenciaIniciar((enLinea) => {
        _usuariosEnLinea = enLinea || new Set();
        pintarEstadoConexion();
    });
}

/* Elegir notaría desde la pantalla de selección o desde el selector */
async function elegirNotaria(valor) {
    _notariaActiva = (valor === 'todas') ? null : Number(valor);
    guardarNotariaActiva();

    const pantalla = document.getElementById('pt-elegir');
    if (pantalla) pantalla.hidden = true;
    const marco = document.querySelector('.pt-marco');
    if (marco) marco.hidden = false;

    pintarNotariaActiva();
    // Lo que se ve cambia por completo: la caché de la oficina anterior
    // no sirve
    cacheOlvidar();
    if (!_arranqueHecho) { await completarArranque(); return; }
    await mostrarVistaCarpetas();
}

/* Resumen de cuántas cuentas hay en la oficina abierta. Se recalcula
   sobre lo que de verdad se ve, no sobre el total del sistema. */
function resumenUsuariosDeNotaria() {
    const enOficina = _usuariosCache.filter(u => usuarioEnNotaria(u, _notariaActiva));
    const activas = enOficina.filter(u => u.activo !== false).length;
    const n = notariaActual();
    return activas + (activas === 1 ? ' cuenta activa' : ' cuentas activas') +
           ' de ' + enOficina.length + (n ? ' en ' + n.ciudad : '');
}

/* Vuelve a la pantalla de selección sin cerrar sesión */
function cambiarNotaria() {
    // El administrador entra siempre, aunque haya una sola oficina:
    // esa pantalla es donde crea las demás.
    if (!ES_ADMIN && _notariasDisponibles.length < 2) return;
    mostrarPantallaNotarias();
}

/* La ciudad junto al nombre del portal, en la barra lateral y en el
   título de la pestaña. Con varias oficinas es un botón; con una sola
   es una etiqueta, porque no hay a dónde cambiar. */
function pintarNotariaActiva() {
    const caja = document.getElementById('pt-notaria');
    if (!caja) return;

    if (!_notariasDisponibles.length) { caja.hidden = true; return; }

    const n = notariaActual();
    const ciudad = n ? n.ciudad : 'Todas las notarías';
    const detalle = n ? n.nombre : 'Panorama general';
    // El administrador siempre puede volver a la pantalla de oficinas,
    // porque es desde donde las administra
    const puedeCambiar = ES_ADMIN || _notariasDisponibles.length > 1;

    caja.innerHTML = puedeCambiar
        ? '<button class="pt-notaria__boton" data-accion="cambiar-notaria" ' +
              'title="Cambiar de notaría">' +
              '<span class="pt-notaria__ciudad">' + escaparHtml(ciudad) + '</span>' +
              '<span class="pt-notaria__nombre">' + escaparHtml(detalle) + '</span>' +
          '</button>'
        : '<div class="pt-notaria__fijo">' +
              '<span class="pt-notaria__ciudad">' + escaparHtml(ciudad) + '</span>' +
              '<span class="pt-notaria__nombre">' + escaparHtml(detalle) + '</span>' +
          '</div>';
    caja.hidden = false;

    document.title = 'Portal Documental' + (n ? ' ' + n.ciudad : '') + ' | Carpetas';
}

/* ---- Casillas de notaría en el formulario de usuario ----
   El operador puede marcar varias; los demás roles una sola, así que
   las casillas se comportan como botones de opción. El administrador
   no necesita ninguna: las tiene todas por su rol. */
let _notariasFormulario = [];   // catálogo completo, para el administrador

async function cargarCatalogoNotarias() {
    try { _notariasFormulario = await notariasListar(); }
    catch (e) { _notariasFormulario = []; }
}

function notariasMarcadasEnFormulario() {
    return [...document.querySelectorAll('#nuevas-notarias input:checked')]
        .map(x => Number(x.value));
}

/* Dibuja las casillas según el rol elegido y marca las que ya tenga */
function pintarNotariasDeFormulario(marcadas) {
    const caja = document.getElementById('nuevas-notarias');
    const campo = document.getElementById('campo-nuevas-notarias');
    const etiqueta = document.getElementById('etiqueta-nuevas-notarias');
    if (!caja || !campo) return;

    const rol = (document.getElementById('nuevo-rol') || {}).value || 'cliente';
    const activas = _notariasFormulario.filter(n => n.activa);

    // Sin notarías configuradas, o siendo administrador, no hay nada que elegir
    if (!activas.length || rol === 'administrador') {
        campo.hidden = true;
        caja.innerHTML = '';
        return;
    }
    campo.hidden = false;

    const varias = rol === 'operador';
    etiqueta.textContent = varias
        ? 'Notarías donde puede trabajar (puede marcar varias)'
        : 'Notaría';

    const yaMarcadas = (marcadas || []).map(String);
    caja.innerHTML = activas.map(n =>
        '<label class="pt-notaria-casilla">' +
            '<input type="' + (varias ? 'checkbox' : 'radio') + '" ' +
                   'name="notaria-usuario" value="' + n.id + '"' +
                   (yaMarcadas.includes(String(n.id)) ? ' checked' : '') + '>' +
            '<span><b>' + escaparHtml(n.ciudad) + '</b> · ' + escaparHtml(n.nombre) + '</span>' +
        '</label>').join('');
}

/* ---- Gestión de oficinas, dentro de la pantalla de selección ----
   Administrar la red de notarías es una tarea distinta de trabajar
   dentro de una, así que vive fuera del portal: en la misma pantalla
   donde se elige a cuál entrar. */
async function pintarGestionNotarias() {
    const caja = document.getElementById('pt-elegir-admin');
    const lista = document.getElementById('pt-elegir-admin-lista');
    if (!caja || !lista) return;
    if (!ES_ADMIN) { caja.hidden = true; return; }

    await cargarCatalogoNotarias();
    caja.hidden = false;

    if (!_notariasFormulario.length) {
        lista.innerHTML = '<p class="pt-elegir__admin-vacio">Todavía no hay oficinas. ' +
            'Crea la primera para empezar a repartir las carpetas.</p>';
        return;
    }

    lista.innerHTML = _notariasFormulario.map(n =>
        '<div class="pt-elegir__admin-fila' + (n.activa ? '' : ' apagada') + '">' +
            '<span class="pt-elegir__admin-txt">' +
                '<b>' + escaparHtml(n.ciudad) + '</b> · ' + escaparHtml(n.nombre) +
                (n.activa ? '' : ' <em>desactivada</em>') +
            '</span>' +
            '<span class="pt-elegir__admin-acc">' +
                '<button data-accion="editar-notaria" data-id="' + n.id + '">Editar</button>' +
                '<button data-accion="alternar-notaria" data-id="' + n.id + '" ' +
                        'title="' + (n.activa ? 'Desactivar' : 'Activar') + '">' +
                    (n.activa ? 'Desactivar' : 'Activar') + '</button>' +
            '</span>' +
        '</div>').join('');
}

/* Vuelve al portal sin cambiar de oficina. Solo tiene sentido si ya
   había una abierta: al entrar por primera vez no hay a dónde volver. */
function volverAlPortal() {
    if (_notariaActiva === null && !ES_ADMIN) return;
    const pantalla = document.getElementById('pt-elegir');
    const marco = document.querySelector('.pt-marco');
    if (pantalla) pantalla.hidden = true;
    if (marco) marco.hidden = false;
}

/* ---- Alta y edición de notarías ----
   Un solo formulario con ciudad, nombre y si está activa. Antes eran
   dos preguntas encadenadas, que no dejaban corregir la primera al
   llegar a la segunda ni cambiar el estado sin pasar por otro menú. */
let _notariaEditando = null;

function abrirModalNotaria(notaria) {
    if (!ES_ADMIN) return;
    _notariaEditando = notaria || null;
    document.getElementById('modal-notaria-titulo').textContent =
        notaria ? 'Editar notaría' : 'Nueva notaría';
    document.getElementById('notaria-ciudad').value = notaria ? notaria.ciudad : '';
    document.getElementById('notaria-nombre').value = notaria ? notaria.nombre : '';
    document.getElementById('notaria-activa').checked = notaria ? notaria.activa !== false : true;

    // Al desactivar una oficina con carpetas conviene decir qué implica
    const aviso = document.getElementById('notaria-aviso');
    if (aviso) {
        const abierta = notaria && String(_notariaActiva) === String(notaria.id);
        aviso.hidden = !abierta;
        aviso.textContent = abierta
            ? 'Esta es la oficina que tienes abierta. Si la desactivas tendrás que elegir otra.'
            : '';
    }
    document.getElementById('modal-notaria').hidden = false;
    document.getElementById('notaria-ciudad').focus();
}

function cerrarModalNotaria() {
    document.getElementById('modal-notaria').hidden = true;
    _notariaEditando = null;
}

async function guardarNotaria(evento) {
    evento.preventDefault();
    if (!ES_ADMIN) return;
    const ciudad = document.getElementById('notaria-ciudad').value.trim();
    const nombre = document.getElementById('notaria-nombre').value.trim();
    const activa = document.getElementById('notaria-activa').checked;
    if (!ciudad || !nombre) {
        avisar('La notaría necesita ciudad y nombre.', 'error');
        return;
    }
    try {
        if (_notariaEditando) {
            await notariaEditar(_notariaEditando.id, nombre, ciudad, activa);
            registrarActividad('editar-notaria', ciudad + ' · ' + nombre);
        } else {
            const id = await notariaCrear(nombre, ciudad);
            registrarActividad('crear-notaria', ciudad + ' · ' + nombre);
            if (!activa) await notariaEditar(id, null, null, false);
        }
    } catch (e) {
        avisar((e && e.message) || 'No se pudo guardar la notaría.', 'error');
        return;
    }
    cerrarModalNotaria();

    // Si se desactivó la oficina abierta hay que soltarla: seguir dentro
    // de una notaría apagada dejaría el portal en un estado imposible
    const era = _notariaEditando;
    _notariasDisponibles = await misNotarias();
    if (era && !activa && String(_notariaActiva) === String(era.id)) {
        _notariaActiva = null;
        guardarNotariaActiva();
    }
    pintarNotariaActiva();
    mostrarPantallaNotarias();
    avisar('Notaría «' + ciudad + ' · ' + nombre + '» guardada.');
}

function nuevaNotariaAccion() { abrirModalNotaria(null); }

function editarNotariaAccion(id) {
    const n = _notariasFormulario.find(x => String(x.id) === String(id));
    if (n) abrirModalNotaria(n);
}

/* Desactivar en vez de borrar: una notaría con expedientes no se elimina,
   se saca de circulación. Borrarla dejaría carpetas sin oficina. */
async function alternarNotariaAccion(id) {
    if (!ES_ADMIN) return;
    const n = _notariasFormulario.find(x => String(x.id) === String(id));
    if (!n) return;
    if (n.activa && !await confirmarPortal(
        'Al desactivar «' + n.ciudad + ' · ' + n.nombre + '» deja de aparecer al entrar. ' +
        'Sus carpetas no se borran, pero nadie podrá abrirlas hasta reactivarla. ¿Continuar?',
        'Desactivar notaría')) return;
    try {
        await notariaEditar(n.id, null, null, !n.activa);
        _notariasDisponibles = await misNotarias();
        // Si se apagó la oficina abierta hay que soltarla
        if (n.activa && String(_notariaActiva) === String(n.id)) {
            _notariaActiva = null;
            guardarNotariaActiva();
        }
        pintarNotariaActiva();
        mostrarPantallaNotarias();
        avisar(n.activa ? 'Notaría desactivada.' : 'Notaría activada.');
    } catch (e) {
        avisar((e && e.message) || 'No se pudo cambiar la notaría.', 'error');
    }
}

/* ============ NAVEGACIÓN ENTRE VISTAS ============ */
function mostrarVista(idVista) {
    // Al cambiar de sección en móvil, la barra lateral se cierra sola
    alternarLateral(false);
    alternarCajonUsuario(false);
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

    // Primero con lo guardado, para que la sección aparezca ya
    const cTodas = cacheLeer('carpetas'), cProc = cacheLeer('procesos');
    const hayCopia = !!(cTodas && cProc);
    if (hayCopia) aplicarCarpetas(cTodas, cProc, cacheLeer('usuarios'));
    else document.getElementById('lista-carpetas').innerHTML = esqueletoFilas(4);

    // El nº de documentos y el peso YA vienen cacheados en cada carpeta
    // (columnas total_archivos / peso_total_mb, actualizadas por trigger
    // al subir/eliminar): ya no se descargan TODOS los metadatos de
    // archivos solo para contar.
    const [rTodas, rProc, rUsu] = await Promise.all([
        cacheRefrescar('carpetas', () => dbTodos('carpetas')),
        cacheRefrescar('procesos', () => procesosTodos().catch(() => [])),
        ES_SUPERVISION
            ? cacheRefrescar('usuarios', () => dbTodos('usuarios'))
            : Promise.resolve({ valor: null, cambio: false })
    ]);
    if (!hayCopia || rTodas.cambio || rProc.cambio || rUsu.cambio) {
        aplicarCarpetas(rTodas.valor, rProc.valor, rUsu.valor);
    }
}

/* Vuelca un conjunto de datos en la vista de carpetas. Se usa dos
   veces por navegación: con la copia guardada y con la del servidor. */
function aplicarCarpetas(todas, procesos, usuarios) {
    if (usuarios) {
        nombrePorUsuario = {};
        for (const u of usuarios) nombrePorUsuario[u.usuario] = u.nombre;
    }
    // Doble filtro: permiso (lo real, ya viene de la base) y notaría
    // abierta (preferencia de pantalla)
    const visibles = filtrarPorNotaria(todas.filter(puedeVerCarpeta));
    visibles.sort((a, b) => b.fecha - a.fecha);

    _conteoArchivos = {};
    for (const c of visibles) _conteoArchivos[c.id] = c.totalArchivos || 0;
    _procesosPorCarpeta = {};
    for (const p of procesos) (_procesosPorCarpeta[p.carpetaId] = _procesosPorCarpeta[p.carpetaId] || []).push(p);
    _carpetasVisibles = visibles;

    pintarLateral(visibles, procesos);
    pintarCarpetasSegunFiltro();
}

/* Filas grises mientras llega la primera respuesta: la sección
   aparece con su forma en vez de quedarse vacía. */
function esqueletoFilas(n) {
    return '<div class="pt-esqueleto">' +
        Array.from({ length: n }, () => '<div class="pt-esqueleto__fila"></div>').join('') +
        '</div>';
}

/* Contadores de la barra lateral y barra de almacenamiento.
   Todo sale de datos que ya se descargaron: no hay consultas extra. */
const ALMACEN_TOPE_MB = 50;   // cupo del bucket 'documentos'

/* Contadores de la barra lateral y barra de almacenamiento. Todo sale
   de datos que ya se descargaron: no hay consultas extra. */
function pintarLateral(carpetas, procesos) {
    const activas = carpetas.filter(c => c.activa);
    const num = (id, valor) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.textContent = valor;
        el.hidden = !valor;
    };
    num('nav-num-carpetas', activas.length);

    // Estados: procesos sin completar que ya vencieron o vencen hoy/mañana
    const porAtender = (procesos || []).filter(p =>
        !p.completado && !p.pausado && (p.semaforo === 'rojo' || p.semaforo === 'naranja')).length;
    num('nav-num-estados', porAtender);

    // Almacenamiento: suma del peso cacheado de cada carpeta visible
    const caja = document.getElementById('almacen-caja');
    if (!caja) return;
    if (!ES_SUPERVISION) { caja.hidden = true; return; }
    const usadoMb = carpetas.reduce((s, c) => s + (Number(c.pesoTotalMb) || 0), 0);
    const pct = Math.min(100, Math.round((usadoMb / ALMACEN_TOPE_MB) * 100));
    caja.hidden = false;
    document.getElementById('almacen-barra').style.width = pct + '%';
    document.getElementById('almacen-txt').textContent =
        usadoMb.toFixed(1) + ' MB de ' + ALMACEN_TOPE_MB + ' MB';
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

    pintarPanoramaCarpetas(mostradas);
    lista.innerHTML = mostradas.length
        ? '<div class="pt-filas__cab">' +
              '<span>Carpeta</span><span>Proceso</span>' +
              (ES_SUPERVISION ? '<span>Operador</span>' : '<span></span>') +
              '<span>Contenido</span><span></span>' +
          '</div>' +
          mostradas.map(c => filaCarpeta(c, _conteoArchivos[c.id] || 0)).join('')
        : '';
    vacio.hidden = mostradas.length > 0;
    vacio.textContent = ES_SUPERVISION
        ? (_filtroCarpetas === 'desactivadas'
            ? 'No hay carpetas desactivadas.'
            : 'No hay carpetas activas. Crea una con el botón "+ Nueva carpeta".')
        : (ES_OPERADOR
            ? 'No tienes carpetas asignadas como operador. El administrador debe asignarte a un proceso.'
            : 'Todavía no tienes carpetas asignadas. Comunícate con la fundación.');
}

/* Cambia entre carpetas activas y desactivadas (solo administrador). */
function cambiarFiltroCarpetas(filtro) {
    if (filtro !== 'activas' && filtro !== 'desactivadas') return;
    _filtroCarpetas = filtro;
    pintarCarpetasSegunFiltro();
}

/* Panorama de la lista: cuatro cifras que resumen el estado general.
   Todo sale de datos ya cargados; no hay consultas extra. */
function pintarPanoramaCarpetas(mostradas) {
    const caja = document.getElementById('panorama-carpetas');
    if (!caja) return;
    if (!mostradas.length) { caja.hidden = true; return; }

    const sinProcesos = mostradas.filter(c => !(_procesosPorCarpeta[c.id] || []).length).length;
    const docs = mostradas.reduce((n, c) => n + (_conteoArchivos[c.id] || 0), 0);
    const mb = mostradas.reduce((n, c) => n + (Number(c.pesoTotalMb) || 0), 0);
    const personas = mostradas.reduce((n, c) => n + (c.asignados || []).length, 0);

    // Procesos por vencer o vencidos entre las carpetas mostradas
    let porVencer = 0, vencidos = 0, proxima = null;
    for (const c of mostradas) {
        for (const p of (_procesosPorCarpeta[c.id] || [])) {
            if (p.completado || p.pausado || c.pausado) continue;
            if (p.semaforo === 'rojo') vencidos++;
            else if (p.semaforo === 'naranja') porVencer++;
            if (p.fechaVencimientoHabil && (!proxima || p.fechaVencimientoHabil < proxima)) {
                proxima = p.fechaVencimientoHabil;
            }
        }
    }

    const caja1 = (tit, num, pie, clase) =>
        '<div class="pt-panorama__caja">' +
            '<div class="pt-panorama__tit">' + tit + '</div>' +
            '<div class="pt-panorama__num' + (clase ? ' ' + clase : '') + '">' + num + '</div>' +
            '<div class="pt-panorama__pie">' + pie + '</div>' +
        '</div>';

    caja.hidden = false;
    caja.innerHTML =
        caja1('Carpetas', mostradas.length,
              sinProcesos ? sinProcesos + ' sin procesos definidos' : 'todas con trámite definido') +
        caja1('Por vencer', porVencer + vencidos,
              proxima ? 'próximo: ' + escaparHtml(formatoFechaDia(proxima)) : 'sin vencimientos cercanos',
              vencidos ? 'pt-panorama__num--alerta' : (porVencer ? 'pt-panorama__num--aviso' : '')) +
        caja1('Documentos', docs,
              ES_SUPERVISION ? mb.toFixed(1) + ' MB en total' : 'en tus carpetas') +
        caja1('Personas asignadas', personas, 'clientes y acreedores');
}

/* Una carpeta = una fila escaneable. La acción primaria («Abrir») queda
   siempre visible; las de administración se repliegan en el menú «⋯». */
function filaCarpeta(c, totalArchivos) {
    const operadores = c.operadores || [];
    const asignados = (c.asignados || []).length;

    const estado = c.activa ? '' :
        ' <span class="pt-insignia pt-insignia--inactiva">Desactivada</span>';

    let menu = '';
    if (ES_ADMIN) {
        menu =
            '<div class="pt-menu">' +
                '<button class="pt-menu__boton" data-accion="menu-carpeta" data-id="' + c.id + '" ' +
                        'aria-label="Más acciones" title="Más acciones">⋯</button>' +
                '<div class="pt-menu__lista" id="menu-carpeta-' + c.id + '" hidden>' +
                    '<button data-accion="editar-carpeta" data-id="' + c.id + '">Editar carpeta</button>' +
                    '<button data-accion="alternar-carpeta" data-id="' + c.id + '">' +
                        (c.activa ? 'Desactivar' : 'Activar') + '</button>' +
                    '<button class="pt-menu__peligro" data-accion="eliminar-carpeta" data-id="' + c.id + '">Eliminar</button>' +
                '</div>' +
            '</div>';
    }

    return '<div class="pt-fila-carpeta' + (c.activa ? '' : ' pt-fila-carpeta--inactiva') + '">' +
        '<div>' +
            '<div class="pt-fila__nombre">' + escaparHtml(c.nombre) + estado + '</div>' +
            ((ES_PERSONAL || ES_MONITOR) && c.descripcion
                ? '<div class="pt-fila__sub">' + escaparHtml(c.descripcion) + '</div>'
                : '<div class="pt-fila__sub">creada ' + escaparHtml(formatoFecha(c.fecha)) + '</div>') +
        '</div>' +
        '<div class="pt-fila__col">' + resumenSemaforoCarpeta(c, _procesosPorCarpeta[c.id] || []) + '</div>' +
        '<div class="pt-fila__col">' +
            (ES_SUPERVISION
                ? (operadores.length ? escaparHtml(operadores.map(o => nombreDe(o)).join(', ')) : 'sin asignar')
                : '') +
        '</div>' +
        '<div class="pt-fila__col">' +
            '<b>' + totalArchivos + ' doc' + (totalArchivos === 1 ? '' : 's') + '</b>' +
            (ES_SUPERVISION ? (c.pesoTotalMb || 0).toFixed(2) + ' MB · ' : '') +
            ((ES_PERSONAL || ES_MONITOR) ? asignados + ' persona' + (asignados === 1 ? '' : 's') : '') +
        '</div>' +
        '<div class="pt-fila__acciones">' +
            '<button class="pt-boton pt-boton--primario pt-boton--mini" data-accion="abrir-carpeta" data-id="' + c.id + '">Abrir</button>' +
            menu +
        '</div>' +
    '</div>';
}

/* ============ SEMÁFORO: HELPERS COMPARTIDOS ============ */
const NOMBRE_SEMAFORO = { verde: 'Al día', naranja: 'Por vencer', rojo: 'Vencido', pausado: 'Pausado' };

/* Punto de color del semáforo, en el tamaño que se pida. */
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
    // Cada carpeta se abre por su raíz, no por la subcarpeta de la anterior
    _subcarpetaAbierta = null;
    _subcarpetas = [];
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
    // La zona de carga arranca replegada: los documentos son la pantalla,
    // no el formulario de subida. El boton solo aparece a quien puede subir.
    const puedeSubir = puedeGestionarCarpeta(carpeta);
    document.getElementById('zona-subida').hidden = true;
    const botonSubir = document.getElementById('boton-subir');
    if (botonSubir) {
        botonSubir.hidden = !puedeSubir;
        botonSubir.textContent = '+ Subir archivos';
    }
    document.getElementById('migas-carpeta').textContent = carpeta.nombre;
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
    prepararCalendarioLateral(carpeta); // datos del calendario de audiencias
    quitarAdjuntoChat(); // adjunto pendiente de otra carpeta no debe arrastrarse
    _chatCarpetaMin = true;   // el chat flotante arranca minimizado en cada carpeta
    _acreedorDestino = '';

    await pintarArchivos();
    await pintarChats();
}

/* Cuatro cifras del expediente, bajo el titulo de la carpeta.
   Se llaman despues de cargar los archivos, que es cuando ya se
   conocen el numero de documentos y el peso. */
function pintarCifrasDetalle(carpeta, archivos) {
    const caja = document.getElementById('detalle-cifras');
    if (!caja || !carpeta) return;

    const docs = (archivos || []).length;
    const mb = (archivos || []).reduce(function (n, a) { return n + (Number(a.tamano) || 0); }, 0) / 1048576;
    const personas = (carpeta.asignados || []).length + (carpeta.operadores || []).length;

    // Dias habiles restantes del proceso actual (el mismo dato del semaforo)
    const procesos = _procesosPorCarpeta[carpeta.id] || [];
    const actual = procesoActualDe(procesos);
    let plazoNum = '—', plazoTit = 'Sin plazo activo', clase = '';
    if (actual && !carpeta.pausado) {
        const s = semaforoEfectivo(actual, carpeta.pausado);
        if (s.diasRestantes !== null) {
            if (s.diasRestantes < 0) {
                plazoNum = Math.abs(s.diasRestantes);
                plazoTit = 'Dias habiles de atraso';
                clase = 'pt-cifra__num--alerta';
            } else {
                plazoNum = s.diasRestantes;
                plazoTit = s.diasRestantes === 1 ? 'Dia habil restante' : 'Dias habiles restantes';
                clase = s.diasRestantes <= 1 ? 'pt-cifra__num--aviso' : '';
            }
        }
    } else if (carpeta.pausado) {
        plazoTit = 'Tramite en pausa';
    } else if (carpeta.finalizado) {
        plazoTit = 'Tramite finalizado';
    }

    const cifra = function (num, tit, cl) {
        return '<div>' +
            '<div class="pt-cifra__num' + (cl ? ' ' + cl : '') + '">' + num + '</div>' +
            '<div class="pt-cifra__tit">' + tit + '</div>' +
        '</div>';
    };

    caja.hidden = false;
    caja.innerHTML =
        cifra(docs, docs === 1 ? 'Documento' : 'Documentos') +
        cifra(mb.toFixed(2), 'MB') +
        cifra(personas, personas === 1 ? 'Persona' : 'Personas') +
        cifra(plazoNum, plazoTit, clase);
}

/* Muestra u oculta la zona de carga (boton "+ Subir archivos") */
function alternarZonaSubida() {
    const zona = document.getElementById('zona-subida');
    const boton = document.getElementById('boton-subir');
    if (!zona) return;
    zona.hidden = !zona.hidden;
    if (boton) boton.textContent = zona.hidden ? '+ Subir archivos' : 'Cerrar zona de carga';
    if (!zona.hidden) zona.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
let _vistaEstados = 'tablero';    // 'tablero' por urgencia | 'tabla' clasica

/* Detiene el refresco automático del tablero. Se llama al salir de la
   vista para no seguir consultando en segundo plano. */
function detenerAutoRefrescoEstados() {
    if (_autoRefrescoEstados) { clearInterval(_autoRefrescoEstados); _autoRefrescoEstados = null; }
}

/* Abre el tablero de estados y programa su refresco cada cinco minutos
   mientras la vista siga abierta. */
async function mostrarVistaEstados() {
    if (!ES_PERSONAL && !ES_MONITOR) return;
    mostrarVista('vista-estados');
    document.getElementById('estados-nota').textContent = ES_SUPERVISION
        ? 'Semáforos de todos los trámites por días hábiles colombianos (lun–vie, sin festivos). ' +
          (ES_ADMIN ? 'Puedes corregir tiempos y estados: la corrección queda registrada.' : 'Vista de solo lectura.')
        : 'Aquí controlas la etapa de los trámites que tienes a cargo. Los plazos corren en días hábiles colombianos (lun–vie, sin festivos).';
    if (!cacheLeer('carpetas')) {
        document.getElementById('contenido-estados').innerHTML = esqueletoFilas(4);
    }
    await cargarYPintarEstados();
    detenerAutoRefrescoEstados();
    _autoRefrescoEstados = setInterval(() => {
        if (!document.getElementById('vista-estados').hidden) cargarYPintarEstados();
    }, 5 * 60 * 1000);
}

/* Vuelca carpetas y procesos en las variables de la vista Estados */
function aplicarEstados(carpetas, procesos) {
    _estadosCarpetas = filtrarPorNotaria(carpetas.filter(puedeVerCarpeta))
        .sort((a, b) => b.fecha - a.fecha);
    _estadosProcesos = {};
    for (const p of procesos) (_estadosProcesos[p.carpetaId] = _estadosProcesos[p.carpetaId] || []).push(p);
}

/* Carga carpetas y procesos y pinta el tablero. Pinta primero con la
   copia guardada y corrige cuando llega la respuesta del servidor. */
async function cargarYPintarEstados() {
    // Copia guardada primero: el tablero aparece sin esperar a la red
    const cCarp = cacheLeer('carpetas'), cProc = cacheLeer('procesos');
    const hayCopia = !!(cCarp && cProc);
    if (hayCopia) { aplicarEstados(cCarp, cProc); pintarEstados(); }

    try {
        const [rCarp, rProc] = await Promise.all([
            cacheRefrescar('carpetas', () => dbTodos('carpetas')),
            cacheRefrescar('procesos', () => procesosTodos())
        ]);
        // Si el servidor trae lo mismo, no se repinta: repintar hace
        // perder el menú abierto y la posición de la página
        if (hayCopia && !rCarp.cambio && !rProc.cambio) return;
        aplicarEstados(rCarp.valor, rProc.valor);
    } catch (e) {
        // Con una copia ya pintada no se borra la pantalla: se avisa y
        // se deja lo último que se sabe, que es mejor que nada
        if (hayCopia) { avisar('No se pudo actualizar: se muestra lo último que se cargó.', 'error'); return; }
        document.getElementById('contenido-estados').innerHTML =
            '<div class="pt-vacio">' + escaparHtml((e && e.message) || 'No se pudieron cargar los estados.') + '</div>';
        return;
    }
    pintarEstados();
}

let _filtroEstados = 'activos'; // sub-pestaña del admin/monitor: 'activos' | 'desactivados'

/* Cambia entre trámites activos y desactivados en el tablero. */
function cambiarFiltroEstados(filtro) {
    if (filtro !== 'activos' && filtro !== 'desactivados') return;
    _filtroEstados = filtro;
    pintarEstados();
}

/* Dibuja la vista de estados según el rol: el operador ve tarjetas de
   sus trámites; el administrador y el monitor ven el tablero o la tabla
   de todos, con las sub-pestañas de activos y desactivados. */
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
        ? (_vistaEstados === 'tabla'
            ? tablaEstadosGlobal(lista) + pieTablero(activos, desactivados)
            : tableroEstados(lista) + pieTablero(activos, desactivados))
        : '<div class="pt-vacio">' + (_busquedaEstados
            ? 'Sin resultados para la búsqueda.'
            : (_filtroEstados === 'desactivados'
                ? 'No hay trámites desactivados.' : 'No hay trámites activos.')) + '</div>');
}

/* ---- Tablero por urgencia (administrador y monitor) ----
   Cada tramite cae en el grupo que le corresponde segun el semaforo
   que YA calculo el servidor. Aqui no se recalcula nada: solo se
   agrupa y se pinta. */

/* Grupo al que pertenece un tramite */
function grupoDeTramite(c) {
    const procesos = _estadosProcesos[c.id] || [];
    if (c.finalizado) return 'completados';
    if (c.pausado) return 'pausados';
    const actual = procesoActualDe(procesos);
    if (!actual) return procesos.length ? 'completados' : 'encurso';
    const s = semaforoEfectivo(actual, c.pausado);
    if (s.color === 'rojo') return 'vencidos';
    if (s.color === 'naranja') return 'porvencer';
    return 'encurso';
}

/* Anillo del conteo 60/90 del tramite completo. Devuelve el SVG.
   Los dias habiles transcurridos se calculan con la misma aritmetica
   del resto del portal (diasHabiles.js). */
function anilloTramite(c) {
    const total = c.diasHabilesTramite || 60;
    let usados = null;
    if (c.fechaInicioTramite) {
        try { usados = contarDiasHabiles(c.fechaInicioTramite, fechaISOLocalHabil()); } catch (e) { usados = null; }
    }
    let color = 'gris', etiqueta = '-/' + total, frac = 0;
    if (usados !== null) {
        usados = Math.max(0, Math.min(usados, total));
        frac = total ? usados / total : 0;
        etiqueta = usados + '/' + total;
        color = c.finalizado ? 'verde' : c.pausado ? 'gris'
              : frac >= 1 ? 'rojo' : frac >= 0.85 ? 'naranja' : 'verde';
    }
    const R = 22, C = 2 * Math.PI * R;
    const offset = C * (1 - frac);
    return '<div class="pt-anillo" title="' + etiqueta + ' dias habiles del tramite">' +
        '<svg width="52" height="52" viewBox="0 0 52 52" aria-hidden="true">' +
            '<circle class="pt-anillo__pista" cx="26" cy="26" r="' + R + '" fill="none" stroke-width="5"></circle>' +
            '<circle class="pt-anillo__arco pt-anillo__arco--' + color + '" cx="26" cy="26" r="' + R + '" fill="none" ' +
                'stroke-width="5" stroke-linecap="round" stroke-dasharray="' + C.toFixed(1) + '" ' +
                'stroke-dashoffset="' + offset.toFixed(1) + '"></circle>' +
        '</svg>' +
        '<span class="pt-anillo__txt">' + etiqueta + '</span>' +
    '</div>';
}

/* Una tarjeta de tramite dentro del tablero.
   Nombre y anillo arriba, operador debajo, una linea separadora y
   luego el detalle del plazo. Las acciones van al pie. */
function tarjetaTramiteTablero(c) {
    const procesos = _estadosProcesos[c.id] || [];
    const actual = procesoActualDe(procesos);
    const operadores = (c.operadores || []).map(o => nombreDe(o)).join(', ');

    const lineas = [];
    if (c.finalizado) {
        lineas.push('Todos los procesos completados');
        lineas.push('Finalizado' +
            (c.fechaFinTramite ? ' ' + escaparHtml(formatoFechaDia(c.fechaFinTramite)) : ''));
    } else if (c.pausado) {
        lineas.push('Tramite en pausa: el reloj esta detenido');
    } else if (!actual) {
        lineas.push(procesos.length ? 'Todos los procesos completados' : 'En espera');
        lineas.push('Sin procesos definidos todavia');
    } else {
        const st = semaforoEfectivo(actual, c.pausado);
        const d = st.diasRestantes;
        lineas.push('Vence <strong>' + escaparHtml(formatoVencimiento(actual.fechaVencimiento)) + '</strong>' +
            (d === null ? '' : ' · ' + (d < 0
                ? Math.abs(d) + ' dia(s) habil(es) de atraso'
                : d + ' dia(s) habil(es)')));
        lineas.push('Proceso: ' + escaparHtml(actual.nombre));
    }

    // El menu solo aparece donde hay algo que gestionar
    const conMenu = !c.finalizado && puedeGestionarCarpeta(c);
    const etiqueta = c.finalizado ? 'Ver expediente' : 'Ver detalle';

    return '<article class="pt-tramite">' +
        '<div class="pt-tramite__cab">' +
            '<div>' +
                '<div class="pt-tramite__nombre">' + escaparHtml(c.nombre) + '</div>' +
                (operadores ? '<div class="pt-tramite__op">' + escaparHtml(operadores) + '</div>' : '') +
            '</div>' +
            anilloTramite(c) +
        '</div>' +
        '<div class="pt-tramite__cuerpo">' +
            lineas.map(l => '<div class="pt-tramite__linea">' + l + '</div>').join('') +
        '</div>' +
        '<div class="pt-tramite__acciones">' +
            '<button class="pt-boton pt-boton--fantasma pt-boton--mini pt-tramite__ver" ' +
                'data-accion="abrir-carpeta" data-id="' + c.id + '">' + etiqueta + '</button>' +
            (conMenu
                ? '<div class="pt-menu">' +
                    '<button class="pt-menu__boton" data-accion="menu-tramite" data-id="' + c.id + '" ' +
                            'aria-label="Más acciones" title="Más acciones">⋯</button>' +
                    '<div class="pt-menu__lista" id="menu-tramite-' + c.id + '" hidden>' +
                        '<button data-accion="abrir-carpeta" data-id="' + c.id + '">Abrir la carpeta</button>' +
                        (c.pausado
                            ? '<button data-accion="reactivar-tramite" data-id="' + c.id + '">Reactivar el tramite</button>'
                            : '<button data-accion="pausar-tramite" data-id="' + c.id + '">Pausar el tramite</button>') +
                    '</div>' +
                  '</div>'
                : '') +
        '</div>' +
    '</article>';
}

/* El tablero: una columna por grupo, en orden de urgencia.
   Las columnas se ven siempre, incluso vacias: parte del valor de
   la pantalla es poder decir "no hay ninguno vencido". */
function tableroEstados(carpetas) {
    const grupos = { vencidos: [], porvencer: [], encurso: [], pausados: [], completados: [] };
    for (const c of carpetas) grupos[grupoDeTramite(c)].push(c);

    const def = [
        ['vencidos',    'Vencidos',    'rojo',    'Ningun tramite vencido sin completar'],
        ['porvencer',   'Por vencer',  'naranja', 'Nada por vencer en los proximos dias habiles'],
        ['encurso',     'En curso',    'cian',    'Sin tramites en curso'],
        ['pausados',    'Pausados',    'gris',    'Ningun tramite en pausa'],
        ['completados', 'Completados', 'verde',   'Todavia no hay tramites completados']
    ];

    // La columna de pausados solo aparece si hay alguno: en la mayoria
    // de los dias esta vacia y solo robaria ancho a las demas.
    const visibles = def.filter(d => d[0] !== 'pausados' || grupos.pausados.length);

    const columnas = visibles.map(function (d) {
        const clave = d[0], titulo = d[1], color = d[2], vacio = d[3];
        const lista = grupos[clave];
        const puedeCrear = clave === 'encurso' && lista.some(c => !(_estadosProcesos[c.id] || []).length);

        return '<section class="pt-columna pt-columna--' + color + '">' +
            '<div class="pt-columna__cab">' +
                '<span class="pt-grupo__punto pt-grupo__punto--' + color + '"></span>' +
                '<span class="pt-columna__tit">' + titulo + '</span>' +
                '<span class="pt-columna__num">' + lista.length + '</span>' +
            '</div>' +
            '<div class="pt-columna__lista">' +
                (lista.length
                    ? lista.map(tarjetaTramiteTablero).join('')
                    : '<div class="pt-columna__vacio">' + vacio + '</div>') +
                (puedeCrear
                    ? '<button class="pt-columna__crear" data-accion="ver-carpetas">' +
                      '+ Anadir proceso a una carpeta sin tramites definidos</button>'
                    : '') +
            '</div>' +
        '</section>';
    }).join('');

    return '<div class="pt-tablero" style="--pt-columnas:' + visibles.length + ';">' + columnas + '</div>';
}

/* Exporta el tablero a Excel: una fila por tramite con su grupo,
   el proceso en curso y los dias que quedan. Lo mismo que se ve en
   pantalla, para poder repartirlo por fuera del portal. */
async function exportarEstadosExcel() {
    try {
        const XLSX = await cargarSheetJS();
        const ETIQ = {
            vencidos: 'Vencido', porvencer: 'Por vencer', encurso: 'En curso',
            pausados: 'Pausado', completados: 'Completado'
        };
        const filas = _estadosCarpetas.map(function (c) {
            const actual = procesoActualDe(_estadosProcesos[c.id] || []);
            const st = actual ? semaforoEfectivo(actual, c.pausado) : null;
            const d = st ? st.diasRestantes : null;
            return {
                'Carpeta': c.nombre,
                'Estado': ETIQ[grupoDeTramite(c)] || '',
                'Operador(es)': (c.operadores || []).map(o => nombreDe(o)).join(', '),
                'Proceso en curso': actual ? actual.nombre : '',
                'Vence': actual && actual.fechaVencimiento ? formatoFechaDia(actual.fechaVencimiento) : '',
                'Dias habiles': d === null ? '' : d,
                'Activa': c.activa ? 'Si' : 'No'
            };
        });
        const hoja = XLSX.utils.json_to_sheet(filas.length ? filas : [{
            'Carpeta': '', 'Estado': '', 'Operador(es)': '', 'Proceso en curso': '',
            'Vence': '', 'Dias habiles': '', 'Activa': ''
        }]);
        const libro = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(libro, hoja, 'Estados');
        XLSX.writeFile(libro, 'estados_tramites_mascaribe.xlsx');
        registrarActividad('exportar-estados', 'Excel del tablero de estados');
        avisar('Excel descargado.');
    } catch (e) {
        avisar((e && e.message) || 'No se pudo generar el Excel.', 'error');
    }
}

/* Pie del tablero: resumen y conmutador tablero/tabla */
function pieTablero(activos, desactivados) {
    return '<div class="pt-tablero__pie">' +
        '<span>' + activos.length + ' tramite(s) activo(s) · ' + desactivados.length + ' desactivado(s)</span>' +
        '<span class="pt-acciones">' +
            '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="alternar-vista-estados">' +
                (_vistaEstados === 'tabla' ? 'Ver como tablero' : 'Ver como tabla') +
            '</button>' +
            '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="exportar-estados">' +
                'Exportar Excel</button>' +
        '</span>' +
    '</div>';
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

/* Abre el formulario para añadir un proceso al trámite de una carpeta. */
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

/* Cierra el formulario de nuevo proceso. */
function cerrarModalProceso() {
    document.getElementById('modal-proceso').hidden = true;
    _carpetaProcesoNuevo = null;
}

/* Crea el proceso con el nombre y los días hábiles indicados. La fecha
   de vencimiento la calcula el servidor, no el navegador. */
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

/* Marca un proceso como completado. El servidor registra la fecha y
   recalcula el semáforo del trámite. */
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

/* Elimina un proceso previa confirmación. */
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

/* Pausa el trámite: el reloj de días hábiles se detiene hasta que se
   reactive. */
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

/* Reactiva un trámite pausado y vuelve a correr el reloj. */
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

/* Aplica la prórroga del trámite. Es única por trámite y el servidor
   la rechaza si ya se usó. */
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

/* Nombre de un proceso a partir de su id, buscándolo en la caché de la
   vista de estados. */
function nombreProceso(procesoId) {
    for (const lista of Object.values(_estadosProcesos)) {
        const p = lista.find(x => x.id === procesoId);
        if (p) return p.nombre;
    }
    return String(procesoId);
}

/* ---- Corrección del administrador (modal editar proceso) ---- */
let _procesoEditandoId = null;

/* Abre la corrección de un proceso (solo administrador). Toda
   corrección queda registrada en la actividad. */
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

/* Cierra el formulario de corrección de proceso. */
function cerrarModalEditarProceso() {
    document.getElementById('modal-editar-proceso').hidden = true;
    _procesoEditandoId = null;
}

/* Guarda la corrección del proceso: nombre, días de plazo y estado. */
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

/* Cierra la ventana de detalle del trámite. */
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

/* Abre el calendario de vencimientos. Dibuja el mes con la copia
   guardada y lo corrige cuando responde el servidor. */
async function mostrarVistaCalendarioVenc() {
    if (!ES_SUPERVISION && !ES_OPERADOR) return;
    mostrarVista('vista-calendario');
    // El mes se dibuja ya con lo guardado y se corrige cuando llegue el servidor
    const cCarp = cacheLeer('carpetas'), cProc = cacheLeer('procesos');
    const hayCopia = !!(cCarp && cProc);
    if (hayCopia) {
        _estadosCarpetas = filtrarPorNotaria(cCarp.filter(puedeVerCarpeta));
        _estadosProcesos = {};
        for (const p of cProc) (_estadosProcesos[p.carpetaId] = _estadosProcesos[p.carpetaId] || []).push(p);
        _recordatoriosCalCache = cacheLeer('recordatorios') || [];
        if (!_mesCalVenc) { const h = new Date(); _mesCalVenc = new Date(h.getFullYear(), h.getMonth(), 1); }
        pintarCalendarioVenc();
    } else {
        document.getElementById('contenido-calendario-venc').innerHTML = esqueletoFilas(3);
    }

    try {
        const [rCarp, rProc, rRec] = await Promise.all([
            cacheRefrescar('carpetas', () => dbTodos('carpetas')),
            cacheRefrescar('procesos', () => procesosTodos()),
            ES_OPERADOR
                ? cacheRefrescar('recordatorios', () => recordatoriosMios().catch(() => []))
                : Promise.resolve({ valor: [], cambio: false })
        ]);
        if (hayCopia && !rCarp.cambio && !rProc.cambio && !rRec.cambio) return;
        _estadosCarpetas = filtrarPorNotaria(rCarp.valor.filter(puedeVerCarpeta));
        _estadosProcesos = {};
        for (const p of rProc.valor) (_estadosProcesos[p.carpetaId] = _estadosProcesos[p.carpetaId] || []).push(p);
        _recordatoriosCalCache = rRec.valor || [];
    } catch (e) {
        if (hayCopia) { avisar('No se pudo actualizar: se muestra lo último que se cargó.', 'error'); return; }
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

/* Columna derecha del calendario. Tres cajas que responden, en orden,
   «cómo va el mes», «qué sigue» y «qué hago ahora». Todo sale de los
   datos ya cargados: no se consulta nada extra. */
function agendaProximos(carpetas, resumen) {
    const hoy = fechaISOLocalHabil();
    const items = [];

    for (const c of (carpetas || [])) {
        if (c.pausado || c.finalizado) continue;
        for (const p of (_estadosProcesos[c.id] || [])) {
            if (p.completado || p.pausado || !p.fechaVencimiento) continue;
            const st = semaforoEfectivo(p, c.pausado);
            items.push({
                fecha: p.fechaVencimiento,
                que: p.nombre,
                carpeta: c.nombre,
                carpetaId: c.id,
                operadores: (c.operadores || []).map(function (o) { return nombreDe(o); }).join(', '),
                color: st.color,
                dias: st.diasRestantes
            });
        }
    }
    items.sort(function (a, b) { return a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0; });

    // ---- Caja 1: resumen del mes ----
    const filaResumen = (color, texto, n) =>
        '<div class="pt-agenda__cifra">' + puntoSemaforo(color, 9) +
            '<span>' + texto + '</span><strong>' + n + '</strong></div>';
    const cajaResumen =
        '<div class="pt-agenda__caja">' +
            '<div class="pt-agenda__tit">Resumen del mes</div>' +
            filaResumen('rojo',    'Vencidos sin completar', resumen.rojos) +
            filaResumen('naranja', 'Por vencer (0–1 día hábil)', resumen.naranjas) +
            filaResumen('verde',   'Completados a tiempo', resumen.verdes) +
        '</div>';

    // ---- Caja 2: agenda de los próximos diez días ----
    // El corte es por días de calendario, que es como se lee una agenda.
    const limite = new Date(hoy + 'T12:00:00');
    limite.setDate(limite.getDate() + 10);
    const limiteISO = fechaISOLocal(limite);
    const proximos = items.filter(it => it.fecha <= limiteISO).slice(0, 6);

    const MES_CORTO = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
    const filas = proximos.map(function (it) {
        const partes = String(it.fecha).split('-');
        const dia = partes[2] || '--';
        const mes = MES_CORTO[Number(partes[1]) - 1] || '';
        let plazo = '', clase = '';
        if (it.dias !== null && it.dias !== undefined) {
            if (it.dias < 0) { plazo = Math.abs(it.dias) + ' d. de atraso'; clase = ' pt-agenda__plazo--rojo'; }
            else if (it.dias <= 1) { plazo = it.dias + ' día hábil'; clase = ' pt-agenda__plazo--naranja'; }
            else { plazo = it.dias + ' días hábiles'; }
        }
        return '<div class="pt-agenda__item">' +
            '<div class="pt-agenda__fecha">' +
                '<div class="pt-agenda__dia">' + dia + '</div>' +
                '<div class="pt-agenda__mes">' + mes + '</div>' +
            '</div>' +
            '<div>' +
                '<div class="pt-agenda__que">' + escaparHtml(it.que) + '</div>' +
                '<div class="pt-agenda__det">' + escaparHtml(it.carpeta) +
                    (it.operadores ? ' · ' + escaparHtml(it.operadores) : '') + '</div>' +
                (plazo ? '<span class="pt-agenda__plazo' + clase + '">' + plazo + '</span>' : '') +
            '</div>' +
        '</div>';
    }).join('');
    const cajaAgenda =
        '<div class="pt-agenda__caja">' +
            '<div class="pt-agenda__tit">Agenda · próximos 10 días</div>' +
            (filas || '<div class="pt-agenda__vacio">Nada vence en los próximos diez días.</div>') +
        '</div>';

    // ---- Caja 3: acción sugerida ----
    // Solo aparece si hay algo realmente urgente: vencido o a un día
    // hábil. Los dos botones llevan a acciones que ya existen.
    const urgente = items.find(it => it.dias !== null && it.dias !== undefined && it.dias <= 1);
    let cajaAccion = '';
    if (urgente) {
        cajaAccion =
            '<div class="pt-agenda__caja pt-agenda__caja--accion">' +
                '<div class="pt-agenda__tit">Acción sugerida</div>' +
                '<div class="pt-agenda__accion-que">' + escaparHtml(urgente.que) + '</div>' +
                '<div class="pt-agenda__accion-det">' + escaparHtml(urgente.carpeta) + ' · ' +
                    (urgente.dias < 0
                        ? Math.abs(urgente.dias) + ' día(s) hábil(es) de atraso'
                        : 'vence en ' + urgente.dias + ' día(s) hábil(es)') + '</div>' +
                '<div class="pt-agenda__accion-btns">' +
                    '<button class="pt-boton pt-boton--mini" data-accion="abrir-carpeta" data-id="' +
                        urgente.carpetaId + '">Abrir la carpeta</button>' +
                    '<button class="pt-boton pt-boton--mini pt-boton--fantasma" data-accion="pausar-tramite" data-id="' +
                        urgente.carpetaId + '">Pausar el trámite</button>' +
                '</div>' +
            '</div>';
    }

    return '<aside class="pt-agenda">' + cajaResumen + cajaAgenda + cajaAccion + '</aside>';
}

/* Dibuja el mes completo: marca cada día con lo que vence, tiñe el día
   según la marca más urgente y arma el panel derecho con el resumen,
   la agenda y la acción sugerida. */
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
        // Etiqueta corta por marca: se lee el mes sin tener que abrir el día.
        // Caben dos; el resto se cuenta.
        const etiquetaMarca = (m) => m.tipo === 'proceso' ? m.p.nombre
            : m.tipo === 'tramite' ? 'Vence ' + m.c.nombre
            : m.r.mensaje;
        const chips = marcas.slice(0, 2).map(m =>
            '<span class="pt-calv__chip pt-calv__chip--' + colorMarca(m) + '">' +
                escaparHtml(etiquetaMarca(m)) + '</span>').join('') +
            (marcas.length > 2 ? '<span class="pt-calv__mas">+' + (marcas.length - 2) + ' más</span>' : '');
        // El día se tiñe con la marca más urgente que tenga
        const ORDEN = ['rojo', 'naranja', 'verde', 'pausado'];
        let tinte = '';
        for (const col of ORDEN) { if (marcas.some(m => colorMarca(m) === col)) { tinte = col; break; } }
        celdas += '<button type="button" class="pt-calv__dia' +
            (noHabil ? ' pt-calv__dia--nohabil' : '') +
            (tinte ? ' pt-calv__dia--marca-' + tinte : '') +
            (iso === hoyISO ? ' pt-calv__dia--hoy' : '') +
            (iso === _diaCalVencSel ? ' pt-calv__dia--sel' : '') + '"' +
            ' data-accion="cal-venc-dia" data-fecha="' + iso + '"' +
            (marcas.length ? ' title="' + marcas.length + ' vencimiento(s)"' : (noHabil ? ' title="Día no hábil"' : '')) +
            '><span class="pt-calv__num">' + d + '</span>' +
            '<span class="pt-calv__chips">' + chips + '</span></button>';
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
        filtros =
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
                ? ' <button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="cal-venc-limpiar">Quitar filtros</button>' : '');
    }
    // Los filtros viven en la cabecera de la sección, junto a «Actualizar»
    const cajaFiltros = document.getElementById('cal-venc-filtros');
    if (cajaFiltros) cajaFiltros.innerHTML = filtros;

    const leyenda =
        '<div class="pt-calv-leyenda">' +
            '<span>' + puntoSemaforo('rojo', 8) + ' Vencido</span>' +
            '<span>' + puntoSemaforo('naranja', 8) + ' Por vencer</span>' +
            '<span>' + puntoSemaforo('verde', 8) + ' Completado</span>' +
            '<span>' + puntoSemaforo('pausado', 8) + ' Recordatorio</span>' +
        '</div>';

    cont.innerHTML =
        '<div class="pt-cal-marco">' +
            '<div class="pt-calv-tarjeta">' +
                '<div class="pt-calv-tarjeta__cab">' +
                    '<div class="pt-cal__barra">' +
                        '<button type="button" class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="cal-venc-mes" data-delta="-1" aria-label="Mes anterior">‹</button>' +
                        '<strong>' + MESES[mes].charAt(0).toUpperCase() + MESES[mes].slice(1) + ' ' + anio + '</strong>' +
                        '<button type="button" class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="cal-venc-mes" data-delta="1" aria-label="Mes siguiente">›</button>' +
                    '</div>' +
                    leyenda +
                '</div>' +
                '<div class="pt-calv__semana"><span>L</span><span>M</span><span>X</span><span>J</span><span>V</span><span>S</span><span>D</span></div>' +
                '<div class="pt-calv__rejilla">' + celdas + '</div>' +
                '<p class="pt-nota" style="margin-top:1rem;">Los días grises son fines de semana o festivos colombianos. Haz clic en un día para ver sus vencimientos.</p>' +
                listaDia +
            '</div>' +
            agendaProximos(carpetasCal, { rojos: rojos, naranjas: naranjas, verdes: verdes }) +
        '</div>';

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

/* Avanza o retrocede un mes en el calendario de vencimientos. */
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

/* Canales de chat que puede abrir el usuario según su rol. El monitor
   los ve todos pero solo lee. */
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

/* Decide si se ve el panel del chat, la burbuja o nada. El chat solo
   existe dentro de una carpeta abierta. */
function pintarVisibilidadChatCarpeta(hayCanales) {
    const seccion = document.getElementById('pt-chats');
    const burbuja = document.getElementById('chat-carpeta-burbuja');
    const enCarpeta = carpetaAbierta && !document.getElementById('vista-carpeta').hidden;
    if (!hayCanales || !enCarpeta) { seccion.hidden = true; burbuja.hidden = true; return; }
    seccion.hidden = _chatCarpetaMin;
    burbuja.hidden = !_chatCarpetaMin;
}

/* Despliega el panel del chat del trámite. */
function abrirChatCarpeta() {
    _chatCarpetaMin = false;
    pintarVisibilidadChatCarpeta(canalesAccesibles().length > 0);
    pintarMensajes();
}

/* Repliega el chat a su burbuja de la esquina. */
function minimizarChatCarpeta() {
    _chatCarpetaMin = true;
    pintarVisibilidadChatCarpeta(canalesAccesibles().length > 0);
}

/* Arma las pestañas de canales del chat y pinta el que esté activo. */
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

/* Cambia de canal de chat. El adjunto pendiente se descarta para que
   no se envíe al canal equivocado. */
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

/* Pinta los mensajes del canal activo y marca como leídos los que se
   acaban de mostrar. */
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

/* Una burbuja de mensaje, con su adjunto si lo tiene. */
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

/* Guarda el archivo elegido como adjunto pendiente del chat, tras
   comprobar tipo y tamaño. */
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

/* Descarta el adjunto pendiente del chat. */
function quitarAdjuntoChat() {
    _adjuntoChat = null;
    const entrada = document.getElementById('chat-adjunto');
    if (entrada) entrada.value = '';
    const chip = document.getElementById('chat-adjunto-chip');
    if (chip) chip.hidden = true;
}

/* Envía el mensaje del canal activo, con su adjunto si lo hay. El
   monitor no puede escribir. */
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

/* El soporte interno es solo para administrador y operadores. */
function soporteDisponible() { return ES_ADMIN || ES_OPERADOR; }

/* Muestra la burbuja de soporte y arranca el conteo de no leídos. */
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

/* Hace parpadear la burbuja cuando llega algo sin leer. */
function parpadearBurbuja() {
    const b = document.getElementById('soporte-burbuja');
    if (!b || b.hidden) return;
    b.classList.add('pt-soporte-burbuja--alerta');
    setTimeout(() => b.classList.remove('pt-soporte-burbuja--alerta'), 6000);
}

/* Actualiza los contadores de mensajes sin leer del chat y del soporte. */
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

/* Cuántos mensajes sin leer tiene un hilo concreto. */
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

/* Abre el panel de soporte con la lista de hilos. */
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

/* Repliega el panel de soporte a su burbuja. */
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

/* Abre un hilo de soporte y marca sus mensajes como leídos. */
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

/* Pinta los mensajes del hilo de soporte abierto. */
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

/* Guarda el archivo elegido como adjunto pendiente del soporte. */
function ponerAdjuntoSoporte(archivo) {
    if (!archivo) return;
    const ext = extensionDe(archivo.name);
    if (!EXTENSIONES_PERMITIDAS.includes(ext)) { avisar('Tipo de archivo no permitido: ' + archivo.name, 'error'); return; }
    if (archivo.size > TAMANO_MAXIMO) { avisar('El archivo supera 100 MB: ' + archivo.name, 'error'); return; }
    _adjuntoSoporte = archivo;
    document.getElementById('soporte-adjunto-nombre').textContent = archivo.name + ' (' + formatoTamano(archivo.size) + ')';
    document.getElementById('soporte-adjunto-chip').hidden = false;
}

/* Descarta el adjunto pendiente del soporte. */
function quitarAdjuntoSoporte() {
    _adjuntoSoporte = null;
    const entrada = document.getElementById('soporte-adjunto');
    if (entrada) entrada.value = '';
    const chip = document.getElementById('soporte-adjunto-chip');
    if (chip) chip.hidden = true;
}

/* Descarga un adjunto de un mensaje de soporte. */
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

/* Envía el mensaje de soporte, con adjunto si lo hay. */
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

/* Pide acceso al micrófono. Si el navegador lo niega, la llamada no
   puede empezar. */
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

/* Prepara la conexión de voz entre los dos extremos y engancha el
   audio remoto cuando llega. */
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

/* Texto de estado de la llamada (llamando, en curso, finalizada). */
function ponerEstadoLlamada(texto) {
    const el = document.getElementById('llamada-estado');
    if (el) el.textContent = texto;
}

/* Muestra la ventana de llamada en el modo que corresponda. */
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
/* Atiende una llamada entrante y muestra el aviso al destinatario. */
function recibirLlamada(fila) {
    if (_llamada) return; // ya en llamada: se ignora
    _llamadaEntrante = fila;
    sonarAviso(); setTimeout(sonarAviso, 700); setTimeout(sonarAviso, 1400);
    _mostrarModalLlamada('Llamada de la administración', true);
    ponerEstadoLlamada('La administración te está llamando.');
}

/* Acepta la llamada entrante y abre el audio en los dos sentidos. */
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

/* Devuelve la ventana de llamada a su tamaño tras minimizarla. */
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

/* Silencia o reactiva el micrófono propio. */
function alternarMicrofono() {
    if (!_llamada || !_llamada.stream) return;
    const pista = _llamada.stream.getAudioTracks()[0];
    if (!pista) return;
    pista.enabled = !pista.enabled;
    pintarBotonesLlamada();
}

/* Silencia o reactiva el audio que llega del otro extremo. */
function alternarAltavoz() {
    const audio = document.getElementById('llamada-audio-remoto');
    audio.muted = !audio.muted;
    pintarBotonesLlamada();
}

/* Cuelga, libera el micrófono y cierra la conexión. */
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

/* Arranca la campana y su consulta periódica de no leídos. */
async function iniciarCampana() {
    await refrescarCampana();
    suscribirNotificaciones(async () => {
        sonarAviso();
        const b = document.querySelector('.pt-campana');
        if (b) { b.classList.add('pt-campana--alerta'); setTimeout(() => b.classList.remove('pt-campana--alerta'), 6000); }
        await refrescarCampana();
    });
}

/* Vuelve a contar las notificaciones sin leer y actualiza la insignia. */
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

/* Pinta el desplegable con las últimas notificaciones. */
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

/* Abre o cierra el desplegable de la campana. */
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

/* Marca todas las notificaciones como leídas. */
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

/* Confirmación con el diseño del portal, en vez de confirm() del
   navegador, que se puede bloquear y no sigue el tema. Devuelve una
   promesa que resuelve a true o false. */
function confirmarPortal(mensaje, titulo) {
    return new Promise((resolver) => {
        _confirmarResolver = resolver;
        document.getElementById('confirmar-titulo').textContent = titulo || 'Confirmar';
        document.getElementById('confirmar-mensaje').textContent = mensaje || '¿Continuar?';
        document.getElementById('modal-confirmar').hidden = false;
        document.getElementById('confirmar-si').focus();
    });
}

/* Pide un texto corto con el mismo modal del portal (nunca prompt(),
   que el navegador puede bloquear y no sigue el tema). */
let _textoResolver = null;

/* Pide un texto al usuario con el diseño del portal, en vez de
   prompt(). Devuelve el texto o null si se cancela. */
function pedirTextoPortal(titulo, ayuda, valorInicial) {
    return new Promise((resolver) => {
        _textoResolver = resolver;
        document.getElementById('texto-titulo').textContent = titulo || 'Escribe un nombre';
        const cajaAyuda = document.getElementById('texto-ayuda');
        cajaAyuda.textContent = ayuda || '';
        cajaAyuda.hidden = !ayuda;
        const campo = document.getElementById('texto-valor');
        campo.value = valorInicial || '';
        document.getElementById('modal-texto').hidden = false;
        campo.focus();
        campo.select();
    });
}

/* Resuelve la promesa del diálogo de texto y lo cierra. */
function _responderTexto(valor) {
    document.getElementById('modal-texto').hidden = true;
    if (_textoResolver) { _textoResolver(valor); _textoResolver = null; }
}

/* Resuelve la promesa del diálogo de confirmación y lo cierra. */
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

/* Registra la aceptación del tratamiento de datos por parte del
   usuario. Queda con fecha y hora en la base. */
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

/* Cierra el editor de notas internas de la carpeta. */
function ocultarEditorDescripcion() {
    document.getElementById('form-descripcion').hidden = true;
    if (carpetaAbierta) {
        document.getElementById('boton-editar-descripcion').hidden = !puedeGestionarCarpeta(carpetaAbierta);
    }
}

/* Guarda las notas internas de la carpeta. */
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

/* Arma las pestañas del detalle de la carpeta según lo que el usuario
   pueda ver. Con una sola pestaña la barra no se dibuja. */
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
            : '') +
        // El calendario lo ve todo el que entra a la carpeta; el deudor y
        // los acreedores en solo lectura
        tab('calendario', 'calendario', 'Calendario');

    // Con una sola pestaña (cliente/acreedor) la barra no hace falta
    const varias = (pestañas.match(/<button/g) || []).length > 1;
    barra.hidden = !varias;
    barra.innerHTML = varias ? pestañas : '';

    pintarPanelDeCarpeta(_subPanelCarpeta, carpeta);
    mostrarSubPanelCarpeta(_subPanelCarpeta);
}

const PANELES_CARPETA = ['archivos', 'audiencias', 'recordatorios', 'notificaciones', 'calendario'];

/* Muestra el panel de la pestaña elegida y oculta los demás. */
function mostrarSubPanelCarpeta(panel) {
    document.getElementById('panel-archivos').hidden = (panel !== 'archivos');
    for (const p of ['audiencias', 'recordatorios', 'notificaciones', 'calendario']) {
        const el = document.getElementById('panel-' + (p === 'notificaciones' ? 'notif-carpeta' : p));
        if (el) el.hidden = (panel !== p);
    }
}

/* Pinta el contenido del panel elegido (los que se construyen dinámicamente) */
function pintarPanelDeCarpeta(panel, carpeta) {
    if (panel === 'audiencias') pintarAudiencias(carpeta);
    else if (panel === 'recordatorios') pintarRecordatorios(carpeta);
    else if (panel === 'notificaciones') pintarNotifCarpeta(carpeta);
    else if (panel === 'calendario') pintarCalendario();
}

/* Cambia de pestaña dentro de la carpeta, comprobando antes que el rol
   tenga acceso a ese panel. */
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

let _editandoOrden = false;
let _subcarpetas = [];        // subcarpetas de la carpeta abierta
let _subcarpetaAbierta = null; // null = raíz de la carpeta   // modo "Editar documentos" (reordenar la tabla)
let _archivosCache = [];      // archivos de la carpeta abierta, ya ordenados

/* Pinta la tabla de documentos de la carpeta: carga las subcarpetas,
   filtra por la que esté abierta y actualiza las cifras del expediente. */
async function pintarArchivos() {
    if (!carpetaAbierta) return;
    const archivos = await dbArchivosDeCarpeta(carpetaAbierta.id);
    _archivosCache = ordenarArchivos(archivos);

    // Subcarpetas de la carpeta y fichas de navegación
    await cargarSubcarpetas();
    // Si la subcarpeta abierta ya no existe, se vuelve a la raíz
    if (_subcarpetaAbierta !== null &&
        !_subcarpetas.some(x => String(x.id) === String(_subcarpetaAbierta))) {
        _subcarpetaAbierta = null;
    }
    pintarSubcarpetas();
    // A partir de aquí se trabaja SOLO con lo que se está viendo
    const visibles = archivosDeVistaActual();

    // Botón "Editar documentos" sobre la tabla (solo personal de la carpeta)
    const barraArchivos = document.getElementById('barra-editar-documentos');
    if (barraArchivos) barraArchivos.remove();
    if (puedeGestionarCarpeta(carpetaAbierta) && visibles.length > 1) {
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
    cuerpo.innerHTML = visibles.map(filaArchivo).join('');
    document.getElementById('archivos-vacio').hidden = visibles.length > 0;
    const vacio = document.getElementById('archivos-vacio');
    if (vacio && !visibles.length) {
        vacio.textContent = _subcarpetaAbierta === null
            ? 'Todavía no hay documentos en esta carpeta.'
            : 'La subcarpeta «' + nombreSubcarpeta(_subcarpetaAbierta) + '» está vacía.';
    }
    if (_editandoOrden) activarArrastreOrden();

    // Las cifras del expediente cuentan TODOS los documentos, no solo los visibles
    pintarCifrasDetalle(carpetaAbierta, _archivosCache);
    const resumen = document.getElementById('archivos-resumen');
    if (resumen) {
        const donde = _subcarpetaAbierta === null
            ? '' : ' en «' + nombreSubcarpeta(_subcarpetaAbierta) + '»';
        resumen.textContent = visibles.length
            ? visibles.length + (visibles.length === 1 ? ' documento' : ' documentos') + donde
            : '';
    }
}

/* ============ SUBCARPETAS DE LA CARPETA ============
   Un solo nivel. La carpeta sigue siendo el trámite; la subcarpeta
   agrupa sus documentos («Audiencias», «Notificaciones»…).
   Se navegan como fichas: con pocas subcarpetas un árbol estorba. */

/* La subcarpeta de audiencias guarda las grabaciones; el resto de la
   carpeta guarda el expediente escrito. Se reconoce por el nombre
   porque las subcarpetas las crea el operador con el que quiera, sin
   distinguir mayúsculas ni tildes: «Audiencias», «audiencia»… */
function esSubcarpetaDeMedios(nombre) {
    return /audiencia/i.test(String(nombre || '').normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
}

/* ¿Admite este destino un archivo con esta extensión?
   destino: id de subcarpeta, o null para la raíz («Documentos»). */
function destinoAdmiteExtension(destino, ext) {
    const esMedia = EXTENSIONES_MEDIA.includes(ext);
    return destinoEsDeMedios(destino) ? esMedia : !esMedia;
}

/* Dice si un destino es la subcarpeta de audiencias, donde van las
   grabaciones. */
function destinoEsDeMedios(destino) {
    if (destino === null || destino === undefined || destino === '') return false;
    return esSubcarpetaDeMedios(nombreSubcarpeta(destino));
}

/* Motivo del rechazo, en las palabras del portal */
function motivoRechazo(destino, nombreArchivo) {
    return nombreArchivo + (destinoEsDeMedios(destino)
        ? ' (en audiencias solo entran audio y video)'
        : ' (el audio y el video van en la subcarpeta de audiencias)');
}

/* Nombre de una subcarpeta a partir de su id. */
function nombreSubcarpeta(id) {
    const s = _subcarpetas.find(x => String(x.id) === String(id));
    return s ? s.nombre : '';
}

/* Documentos que se ven ahora: los de la subcarpeta abierta, o los
   de la raíz si no hay ninguna abierta. */
function archivosDeVistaActual() {
    if (_subcarpetaAbierta === null) {
        return _archivosCache.filter(a => !a.subcarpetaId);
    }
    return _archivosCache.filter(a => String(a.subcarpetaId) === String(_subcarpetaAbierta));
}

/* Dibuja las fichas de navegación de subcarpetas con el conteo de
   documentos de cada una. */
function pintarSubcarpetas() {
    const caja = document.getElementById('barra-subcarpetas');
    if (!caja || !carpetaAbierta) return;

    const gestiona = puedeGestionarCarpeta(carpetaAbierta);
    const enRaiz = _archivosCache.filter(a => !a.subcarpetaId).length;

    let html = '<button class="pt-subcarpeta' + (_subcarpetaAbierta === null ? ' activa' : '') + '" ' +
        'data-accion="abrir-subcarpeta" data-sub="">' +
        icono('carpeta', 15) + ' Documentos' +
        '<span class="pt-subcarpeta__num">' + enRaiz + '</span></button>';

    for (const sub of _subcarpetas) {
        const n = _archivosCache.filter(a => String(a.subcarpetaId) === String(sub.id)).length;
        html += '<button class="pt-subcarpeta' + (String(_subcarpetaAbierta) === String(sub.id) ? ' activa' : '') + '" ' +
            'data-accion="abrir-subcarpeta" data-sub="' + sub.id + '">' +
            icono('carpeta', 15) + ' ' + escaparHtml(sub.nombre) +
            '<span class="pt-subcarpeta__num">' + n + '</span></button>';
    }

    if (gestiona) {
        html += '<button class="pt-subcarpeta pt-subcarpeta--nueva" data-accion="nueva-subcarpeta">' +
            '+ Nueva subcarpeta</button>';
        if (_subcarpetaAbierta !== null) {
            html += '<span class="pt-subcarpeta-barra">' +
                '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="renombrar-subcarpeta">Renombrar</button>' +
                '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="eliminar-subcarpeta">Eliminar</button>' +
                '</span>';
        }
    }

    caja.innerHTML = html;
    caja.hidden = false;
    ajustarZonaSubida();
}

/* El selector de archivos y la nota se ajustan al destino abierto:
   el filtro del navegador evita que el operador escoja algo que el
   portal va a rechazar después. */
function ajustarZonaSubida() {
    const entrada = document.getElementById('entrada-archivos');
    const nota = document.getElementById('subida-nota');
    const medios = destinoEsDeMedios(_subcarpetaAbierta);
    const lista = medios ? EXTENSIONES_MEDIA : EXTENSIONES_DOCUMENTO;
    if (entrada) entrada.accept = lista.map(e => '.' + e).join(',');
    if (nota) {
        nota.textContent = (medios
            ? 'Solo audio y video: ' + lista.join(', ').toUpperCase()
            : 'Permitidos: PDF, Word, Excel, PNG, JPG. El audio y el video van en la subcarpeta de audiencias') +
            ' · máximo 50 MB por archivo';
    }
}

/* Trae las subcarpetas de la carpeta abierta. Si falla, deja la lista
   vacía en vez de romper la vista. */
async function cargarSubcarpetas() {
    if (!carpetaAbierta || typeof subcarpetasListar !== 'function') { _subcarpetas = []; return; }
    try { _subcarpetas = await subcarpetasListar(carpetaAbierta.id); }
    catch (e) { _subcarpetas = []; }
}

/* Abre una subcarpeta, o la raíz de la carpeta si no se pasa ninguna. */
function abrirSubcarpeta(id) {
    _subcarpetaAbierta = (id === '' || id === undefined || id === null) ? null : Number(id);
    _editandoOrden = false;
    pintarArchivos();
}

/* Crea una subcarpeta y la deja abierta. */
async function nuevaSubcarpetaAccion() {
    if (!carpetaAbierta) return;
    const nombre = await pedirTextoPortal('Nombre de la subcarpeta',
        'Por ejemplo: Audiencias, Notificaciones, Soportes.', '');
    if (!nombre) return;
    try {
        const id = await subcarpetaCrear(carpetaAbierta.id, nombre);
        registrarActividad('crear-subcarpeta', nombre + ' · ' + carpetaAbierta.nombre, carpetaAbierta.id);
        await cargarSubcarpetas();
        _subcarpetaAbierta = Number(id);
        await pintarArchivos();
        avisar('Subcarpeta «' + nombre + '» creada.');
    } catch (e) {
        avisar((e && e.message) || 'No se pudo crear la subcarpeta.', 'error');
    }
}

/* Renombra la subcarpeta abierta. */
async function renombrarSubcarpetaAccion() {
    if (_subcarpetaAbierta === null) return;
    const actual = nombreSubcarpeta(_subcarpetaAbierta);
    const nombre = await pedirTextoPortal('Renombrar subcarpeta', '', actual);
    if (!nombre || nombre === actual) return;
    try {
        await subcarpetaRenombrar(_subcarpetaAbierta, nombre);
        registrarActividad('renombrar-subcarpeta', actual + ' → ' + nombre, carpetaAbierta.id);
        await cargarSubcarpetas();
        await pintarArchivos();
        avisar('Subcarpeta renombrada.');
    } catch (e) {
        avisar((e && e.message) || 'No se pudo renombrar.', 'error');
    }
}

/* Elimina la subcarpeta abierta. Los documentos no se borran: vuelven
   a la raíz de la carpeta, y la confirmación lo advierte. */
async function eliminarSubcarpetaAccion() {
    if (_subcarpetaAbierta === null) return;
    const nombre = nombreSubcarpeta(_subcarpetaAbierta);
    const dentro = _archivosCache.filter(a => String(a.subcarpetaId) === String(_subcarpetaAbierta)).length;
    const aviso = dentro
        ? 'La subcarpeta «' + nombre + '» tiene ' + dentro + ' documento(s).\n\n' +
          'Los documentos NO se eliminan: vuelven a la raíz de la carpeta.\n\n¿Eliminar la subcarpeta?'
        : '¿Eliminar la subcarpeta «' + nombre + '»?';
    if (!await confirmarPortal(aviso)) return;
    try {
        await subcarpetaEliminar(_subcarpetaAbierta);
        registrarActividad('eliminar-subcarpeta', nombre + ' · ' + carpetaAbierta.nombre, carpetaAbierta.id);
        _subcarpetaAbierta = null;
        await cargarSubcarpetas();
        await pintarArchivos();
        avisar('Subcarpeta eliminada. Sus documentos quedaron en la carpeta.');
    } catch (e) {
        avisar((e && e.message) || 'No se pudo eliminar la subcarpeta.', 'error');
    }
}

/* Mueve un documento a otra subcarpeta, comprobando antes que el
   destino admita ese tipo de archivo. */
async function moverArchivoAccion(archivoId, destino) {
    // Mover no puede saltarse la regla de la subida
    const arch = _archivosCache.find(x => String(x.id) === String(archivoId));
    const dest = destino === '' ? null : Number(destino);
    if (arch && !destinoAdmiteExtension(dest, extensionDe(arch.nombre))) {
        avisar('No se movió: ' + motivoRechazo(dest, arch.nombre), 'error');
        pintarArchivos();   // devuelve el selector a su valor real
        return;
    }
    try {
        await archivoMover(archivoId, destino === '' ? null : Number(destino));
        const a = _archivosCache.find(x => String(x.id) === String(archivoId));
        registrarActividad('mover-archivo',
            (a ? a.nombre : '') + ' → ' + (destino === '' ? 'raíz' : nombreSubcarpeta(destino)),
            carpetaAbierta.id);
        await pintarArchivos();
        avisar('Documento movido.');
    } catch (e) {
        avisar((e && e.message) || 'No se pudo mover el documento.', 'error');
    }
}

/* Una fila de la tabla de documentos, con sus acciones según el rol. */
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
            // Mover entre subcarpetas: solo se ofrece si la carpeta tiene alguna
            if (_subcarpetas.length) {
                // Solo se ofrecen los destinos que admiten este tipo de archivo
                const destinos = (destinoAdmiteExtension(null, ext)
                        ? [['', 'Documentos']]
                        : [])
                    .concat(_subcarpetas
                        .filter(sub => destinoAdmiteExtension(sub.id, ext))
                        .map(sub => [String(sub.id), sub.nombre]));
                // Con un solo destino posible el selector no mueve nada
                if (destinos.length > 1) {
                    const actual = a.subcarpetaId ? String(a.subcarpetaId) : '';
                    acciones += ' <select class="pt-mover" data-accion-cambio="mover-archivo" data-id="' + a.id + '"' +
                        ' title="Mover a otra subcarpeta">' +
                        destinos.map(d => '<option value="' + d[0] + '"' +
                            (d[0] === actual ? ' selected' : '') + '>' +
                            escaparHtml(d[1]) + '</option>').join('') +
                        '</select>';
                }
            }
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

/* Sale del modo de reordenar documentos sin guardar. */
async function cancelarEdicionOrden() {
    _editandoOrden = false;
    await pintarArchivos();
}

/* Sube o baja un documento una posición mientras se reordena. */
function moverArchivoEnOrden(id, delta) {
    const i = _archivosCache.findIndex(a => a.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= _archivosCache.length) return;
    const [fila] = _archivosCache.splice(i, 1);
    _archivosCache.splice(j, 0, fila);
    repintarFilasOrden();
}

/* Vuelve a dibujar la tabla durante el reordenamiento. */
function repintarFilasOrden() {
    document.getElementById('lista-archivos').innerHTML = _archivosCache.map(filaArchivo).join('');
    activarArrastreOrden();
}

/* Guarda el orden manual de los documentos en el servidor. */
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
/* Habilita arrastrar y soltar filas para reordenar. */
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

/* Lista las audiencias marcadas de la carpeta. */
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
    pintarCalendario(); // el mes queda al día aunque se esté viendo otra pestaña
}

/* Carga los datos del calendario de audiencias al abrir la carpeta. Lo ven
   TODOS los de la carpeta (el deudor y los acreedores en solo lectura, para
   conocer las fechas de su trámite); marcar o notificar solo puede el
   personal. Quién lo muestra es la pestaña, no esta función. */
async function prepararCalendarioLateral(carpeta) {
    const cont = document.getElementById('calendario-audiencias');
    if (!cont) return;
    cont.innerHTML = '';
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

/* Dibuja el mes del calendario de audiencias, con los rangos de los
   procesos si el usuario es personal o monitor. */
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

/* Avanza o retrocede un mes en el calendario de audiencias. */
function cambiarMesCalendario(delta) {
    if (!_mesCalendario) return;
    _mesCalendario = new Date(_mesCalendario.getFullYear(), _mesCalendario.getMonth() + Number(delta || 0), 1);
    pintarCalendario();
}

/* Fecha en formato largo en español, a partir de una cadena ISO. */
function formatoFechaDia(iso) {
    // 'AAAA-MM-DD' → 'lunes, 20 de agosto de 2026' (sin correr el día por zona horaria)
    const [a, m, d] = String(iso).split('-').map(Number);
    if (!a || !m || !d) return String(iso);
    const t = new Date(a, m - 1, d).toLocaleDateString('es-CO', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
    return t.charAt(0).toUpperCase() + t.slice(1);
}

/* Quita una audiencia marcada del calendario. */
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

/* Abre el formulario para notificar una audiencia a las partes. */
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

/* Cierra el formulario de audiencia. */
function cerrarModalAudiencia() {
    document.getElementById('modal-audiencia').hidden = true;
    _audienciaExistenteId = null;
}

/* Marca la audiencia y notifica a las partes de la carpeta. */
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

/* Lista los recordatorios privados del operador para esta carpeta. */
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

/* Abre el formulario de recordatorio. */
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

/* Cierra el formulario de recordatorio. */
function cerrarModalRecordatorio() {
    document.getElementById('modal-recordatorio').hidden = true;
    _recordatorioEditandoId = null;
}

/* Guarda el recordatorio privado del operador. */
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

/* Elimina un recordatorio previa confirmación. */
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

/* Muestra al entrar los recordatorios cuya fecha ya llegó. */
async function mostrarRecordatoriosVigentes() {
    if (!ES_PERSONAL) return;
    try { _pilaRecordatorios = (await recordatoriosVigentes()) || []; } catch (e) { return; }
    pintarPilaRecordatorios();
}

/* Dibuja la pila de avisos de recordatorio en la esquina. */
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

/* Pinta el panel de notificaciones de la carpeta con sus filtros. */
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

/* Filtra las notificaciones de la carpeta por rol destinatario. */
function cambiarRolNotifCarpeta(rol) {
    if (rol !== 'cliente' && rol !== 'acreedor') return;
    _rolNotifCarpeta = rol;
    _acreedorNotifSel = '';   // al cambiar de pestaña, se vuelve a "todos"
    document.querySelectorAll('#sub-pestanas-notif-carpeta button').forEach(b =>
        b.classList.toggle('activa', b.dataset.rol === rol));
    pintarListaNotifCarpeta();
}

/* Filtra las notificaciones por acreedor concreto. */
function cambiarAcreedorNotif(usuario) {
    _acreedorNotifSel = usuario || '';
    pintarListaNotifCarpeta();
}

/* Dibuja la lista ya filtrada de notificaciones de la carpeta. */
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
/* Carga pdf-lib desde CDN la primera vez que hace falta. La promesa se
   guarda para no cargar la librería dos veces. */
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

/* Abre el selector de documentos del expediente unificado. */
/* pdf.js (el motor de PDF de Firefox) se usa solo como red de
   seguridad del expediente: abre archivos que pdf-lib rechaza. Se
   carga bajo demanda, igual que las demás librerías pesadas. */
let _promesaPdfJs = null;
function cargarPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (_promesaPdfJs) return _promesaPdfJs;
    _promesaPdfJs = new Promise((resolver, rechazar) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js';
        script.onload = () => {
            if (!window.pdfjsLib) return rechazar(new Error('No se pudo cargar el lector de PDF.'));
            // El worker hace el trabajo pesado fuera del hilo de la interfaz
            window.pdfjsLib.GlobalWorkerOptions.workerSrc =
                'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
            resolver(window.pdfjsLib);
        };
        script.onerror = () => {
            _promesaPdfJs = null;
            rechazar(new Error('Sin conexión para cargar el lector de PDF.'));
        };
        document.head.appendChild(script);
    });
    return _promesaPdfJs;
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

/* Cierra el selector y limpia la selección. */
function cerrarModalExpediente() {
    document.getElementById('modal-expediente').hidden = true;
    _seleccionExpediente = [];
}

/* Marca o desmarca un documento. El orden de marcado es el orden del
   PDF final. */
function alternarSeleccionExpediente(id, marcado) {
    if (marcado) {
        if (!_seleccionExpediente.includes(id)) _seleccionExpediente.push(id);
    } else {
        _seleccionExpediente = _seleccionExpediente.filter(x => x !== id);
    }
    pintarNumerosExpediente();
}

/* Sube o baja un documento dentro del orden del expediente. */
function moverSeleccionExpediente(id, delta) {
    const i = _seleccionExpediente.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= _seleccionExpediente.length) return;
    [_seleccionExpediente[i], _seleccionExpediente[j]] = [_seleccionExpediente[j], _seleccionExpediente[i]];
    pintarNumerosExpediente();
}

/* Renumera las fichas del selector tras cada cambio de orden. */
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

/* Actualiza el botón con el número de documentos seleccionados. */
function pintarBotonExpediente() {
    const boton = document.getElementById('boton-crear-expediente');
    boton.disabled = _seleccionExpediente.length === 0;
    boton.textContent = _seleccionExpediente.length > 0
        ? 'Generar PDF (' + _seleccionExpediente.length + ' documento' + (_seleccionExpediente.length === 1 ? '' : 's') + ')'
        : 'Generar PDF';
}

/* ---- Reparación de PDF a nivel de bytes ----
   Antes de rendirse con un archivo, se intenta arreglarlo.

   Los dos daños que de verdad aparecen en los PDF que llegan de
   juzgados, escáneres y correos reenviados son:

     a) El catálogo apunta a un árbol de páginas que no existe. El
        archivo tiene todas sus páginas, pero la puerta de entrada
        está rota, así que ninguna librería las encuentra.
     b) El archivo viene cortado y se quedó sin tabla de referencias
        ni trailer, de modo que no hay por dónde empezar a leerlo.

   La reparación busca los objetos reales recorriendo los bytes y
   reescribe la puerta de entrada para que apunte a lo que sí está.

   Regla de oro: los reemplazos se hacen SIN cambiar la longitud del
   archivo, rellenando con espacios. Las posiciones de la tabla de
   referencias son desplazamientos en bytes; si el archivo se corre un
   solo byte, se rompe todo lo demás. */

/* Un byte por unidad de código, ida y vuelta sin pérdida. TextDecoder
   no sirve aquí: 'latin1' se resuelve a windows-1252, que no es una
   correspondencia uno a uno y estropea el contenido binario. */
function bytesATexto(bytes) {
    const u = new Uint8Array(bytes);
    let salida = '';
    // Por trozos: pasar un array de millones de elementos a
    // String.fromCharCode de una vez desborda la pila
    for (let i = 0; i < u.length; i += 8192) {
        salida += String.fromCharCode.apply(null, u.subarray(i, i + 8192));
    }
    return salida;
}

function textoABytes(texto) {
    const u = new Uint8Array(texto.length);
    for (let i = 0; i < texto.length; i++) u[i] = texto.charCodeAt(i) & 0xff;
    return u;
}

/* Intenta reparar el PDF. Devuelve bytes nuevos, o null si no había
   nada que arreglar o no se pudo. */
function repararPdf(bytes) {
    let t = bytesATexto(bytes);
    let tocado = false;

    // Todos los objetos que existen de verdad en el archivo
    const objetos = new Map();   // número -> posición del encabezado
    const reObj = /(\d+)\s+0\s+obj\b/g;
    let m;
    while ((m = reObj.exec(t)) !== null) objetos.set(Number(m[1]), m.index);
    if (objetos.size === 0) return null;   // no hay nada que rescatar

    // El cuerpo de un objeto, para poder mirar su tipo
    const cuerpoDe = (num) => {
        const ini = objetos.get(num);
        if (ini === undefined) return '';
        const fin = t.indexOf('endobj', ini);
        return t.slice(ini, fin === -1 ? Math.min(ini + 2048, t.length) : fin);
    };

    // El árbol de páginas real: el /Type /Pages que tenga /Kids
    let raizPaginas = null;
    for (const num of objetos.keys()) {
        const c = cuerpoDe(num);
        if (/\/Type\s*\/Pages\b/.test(c) && /\/Kids/.test(c)) { raizPaginas = num; break; }
    }
    // El catálogo real
    let catalogo = null;
    for (const num of objetos.keys()) {
        if (/\/Type\s*\/Catalog\b/.test(cuerpoDe(num))) { catalogo = num; break; }
    }

    /* Reescribe una referencia dejando el archivo del mismo largo.
       Devuelve el texto nuevo, o null si el número no cabe. */
    const reescribir = (texto, desde, largo, clave, numero) => {
        const nuevo = '/' + clave + ' ' + numero + ' 0 R';
        if (nuevo.length > largo) return null;
        return texto.slice(0, desde) + nuevo + ' '.repeat(largo - nuevo.length) +
               texto.slice(desde + largo);
    };

    // a) Catálogo apuntando a un árbol de páginas inexistente
    if (catalogo !== null && raizPaginas !== null) {
        const c = cuerpoDe(catalogo);
        const ref = /\/Pages\s+(\d+)\s*0\s*R/.exec(c);
        if (ref && !objetos.has(Number(ref[1])) && Number(ref[1]) !== raizPaginas) {
            const desde = objetos.get(catalogo) + ref.index;
            const arreglado = reescribir(t, desde, ref[0].length, 'Pages', raizPaginas);
            if (arreglado) { t = arreglado; tocado = true; }
        }
    }

    // b) Trailer cuyo /Root no lleva a ningún sitio
    if (catalogo !== null) {
        const posTrailer = t.lastIndexOf('trailer');
        if (posTrailer !== -1) {
            const cola = t.slice(posTrailer);
            const ref = /\/Root\s+(\d+)\s*0\s*R/.exec(cola);
            if (ref && !objetos.has(Number(ref[1]))) {
                const desde = posTrailer + ref.index;
                const arreglado = reescribir(t, desde, ref[0].length, 'Root', catalogo);
                if (arreglado) { t = arreglado; tocado = true; }
            }
        } else {
            // Sin trailer: archivo cortado. Se le pega uno al final para
            // que el lector tenga por dónde entrar. Aquí sí cambia la
            // longitud, pero da igual: ya no hay tabla que respetar.
            const mayor = Math.max(...objetos.keys());
            t += '\ntrailer\n<< /Size ' + (mayor + 1) + ' /Root ' + catalogo +
                 ' 0 R >>\nstartxref\n0\n%%EOF\n';
            tocado = true;
        }
    }

    return tocado ? textoABytes(t).buffer : null;
}

/* ---- Reconstrucción completa del PDF ----
   Para archivos que llegaron cortados: se quedaron sin tabla de
   referencias, sin trailer y con parte de sus páginas ausentes.
   Reparar la puerta de entrada no basta, porque el árbol de páginas
   sigue nombrando folios que ya no están en el archivo.

   Aquí se arma un PDF nuevo con lo que sí sobrevivió:

     1. Se recogen los objetos que están completos, es decir, los que
        tienen su «endobj». El último objeto de un archivo cortado
        casi siempre está a medias y se descarta.
     2. Se identifican el catálogo, el árbol de páginas y las páginas
        que quedaron.
     3. Se reescribe el árbol de páginas para que nombre solo esas.
     4. Se emite el archivo con una tabla de referencias nueva,
        calculada sobre las posiciones reales de este archivo.

   Lo que falta no se puede inventar: si el archivo perdió dos folios,
   entran los diez que quedaron. Diez folios valen más que ninguno. */
function reconstruirPdf(bytes) {
    const t = bytesATexto(bytes);

    // 1) Objetos completos, con su texto tal cual
    const objetos = new Map();   // número -> texto del cuerpo (sin encabezado)
    const re = /(\d+)\s+0\s+obj\b/g;
    let m;
    while ((m = re.exec(t)) !== null) {
        const fin = t.indexOf('endobj', m.index);
        if (fin === -1) continue;                    // objeto a medias
        const num = Number(m[1]);
        const cuerpo = t.slice(m.index + m[0].length, fin);
        objetos.set(num, cuerpo);                    // el último gana, como manda el formato
    }
    if (objetos.size === 0) return null;

    // 2) Catálogo, árbol de páginas y páginas supervivientes
    let catalogo = null, raiz = null;
    const paginas = [];
    for (const [num, cuerpo] of objetos) {
        if (catalogo === null && /\/Type\s*\/Catalog\b/.test(cuerpo)) catalogo = num;
        else if (raiz === null && /\/Type\s*\/Pages\b/.test(cuerpo)) raiz = num;
        else if (/\/Type\s*\/Page\b/.test(cuerpo)) paginas.push(num);
    }
    if (!paginas.length) return null;                // sin páginas no hay nada que salvar
    paginas.sort((a, b) => a - b);

    // 3) Árbol de páginas y catálogo, escritos de nuevo desde cero
    if (raiz === null) { raiz = Math.max(...objetos.keys()) + 1; }
    objetos.set(raiz, '\n<< /Type /Pages /Kids [' +
        paginas.map(n => ' ' + n + ' 0 R').join('') +
        ' ] /Count ' + paginas.length + ' >>\n');
    if (catalogo === null) { catalogo = raiz + 1; }
    objetos.set(catalogo, '\n<< /Type /Catalog /Pages ' + raiz + ' 0 R >>\n');

    // Cada página tiene que colgar del árbol que acabamos de escribir
    for (const n of paginas) {
        let c = objetos.get(n);
        c = /\/Parent\s+\d+\s*0\s*R/.test(c)
            ? c.replace(/\/Parent\s+\d+\s*0\s*R/, '/Parent ' + raiz + ' 0 R')
            : c.replace('<<', '<< /Parent ' + raiz + ' 0 R');
        objetos.set(n, c);
    }

    // 4) Archivo nuevo, anotando dónde queda cada objeto
    const numeros = [...objetos.keys()].sort((a, b) => a - b);
    const mayor = numeros[numeros.length - 1];
    let salida = '%PDF-1.7\n';
    const posicion = new Map();
    for (const n of numeros) {
        posicion.set(n, salida.length);
        salida += n + ' 0 obj' + objetos.get(n) + 'endobj\n';
    }

    // Tabla de referencias: entradas de 20 bytes exactos, sin excepción
    const inicioXref = salida.length;
    salida += 'xref\n0 ' + (mayor + 1) + '\n';
    salida += '0000000000 65535 f \n';
    for (let n = 1; n <= mayor; n++) {
        salida += posicion.has(n)
            ? String(posicion.get(n)).padStart(10, '0') + ' 00000 n \n'
            : '0000000000 65535 f \n';     // hueco: objeto que no sobrevivió
    }
    salida += 'trailer\n<< /Size ' + (mayor + 1) + ' /Root ' + catalogo + ' 0 R >>\n' +
              'startxref\n' + inicioXref + '\n%%EOF\n';

    return textoABytes(salida).buffer;
}

/* ---- Rescate: rasterizar el PDF con pdf.js ----
   Último recurso para archivos que pdf-lib no puede copiar. pdf.js es
   el motor que usa Firefox: reconstruye lo que puede y dibuja el
   resto, así que abre prácticamente cualquier PDF que un visor abra.

   Cada página se dibuja en un lienzo y se pega en el expediente como
   imagen. Se pierde el texto seleccionable, pero el documento QUEDA
   DENTRO del expediente, que es lo que importa: un expediente al que
   le falta un folio no sirve.

   La resolución objetivo son 150 puntos por pulgada, suficiente para
   leer e imprimir un escaneo sin disparar el peso del archivo. */
async function rasterizarPdfAlExpediente(expediente, bytes) {
    const pdfjs = await cargarPdfJs();
    // pdf.js transfiere el buffer al worker y lo deja inservible aquí,
    // por eso recibe siempre una copia propia
    const abrir = () => pdfjs.getDocument({
        // pdf.js transfiere el buffer al worker y lo deja inservible aquí,
        // por eso cada intento recibe una copia propia
        data: new Uint8Array(bytes.slice(0)),
        stopAtErrors: false,          // sigue aunque una página falle
        isEvalSupported: false,       // no ejecuta JavaScript embebido
        disableAutoFetch: true
    }).promise;

    // El worker de pdf.js es compartido y se cierra cuando se destruye el
    // último documento. Abrir otro justo en ese momento falla con un error
    // que no tiene que ver con el archivo, así que se reintenta una vez.
    let doc;
    try {
        doc = await abrir();
    } catch (e) {
        await new Promise(r => setTimeout(r, 120));
        doc = await abrir();
    }
    const total = doc.numPages;
    let puestas = 0;

    const lienzo = document.createElement('canvas');
    const ctx = lienzo.getContext('2d');

    for (let n = 1; n <= total; n++) {
        try {
            const pagina = await doc.getPage(n);
            const base = pagina.getViewport({ scale: 1 });
            // 150 ppp sobre los 72 puntos por pulgada del PDF, con tope
            // para que una página enorme no reviente la memoria
            const escala = Math.min(150 / 72, 4000 / Math.max(base.width, base.height));
            const vista = pagina.getViewport({ scale: escala });
            lienzo.width = Math.floor(vista.width);
            lienzo.height = Math.floor(vista.height);
            // Fondo blanco: el PDF puede no pintarlo y el JPEG no tiene
            // transparencia, quedaría negro
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, lienzo.width, lienzo.height);
            // intent 'print' no es cosmético: con él pdf.js encadena el
            // dibujo con microtareas en vez de requestAnimationFrame. Con
            // rAF, una pestaña en segundo plano congela el render y el
            // expediente se queda a medias hasta que el usuario vuelve.
            await pagina.render({
                canvasContext: ctx,
                viewport: vista,
                intent: 'print'
            }).promise;

            const dataUrl = lienzo.toDataURL('image/jpeg', 0.75);
            const img = await expediente.embedJpg(dataUrl);
            // La página del expediente conserva el tamaño real del original
            const hoja = expediente.addPage([base.width, base.height]);
            hoja.drawImage(img, { x: 0, y: 0, width: base.width, height: base.height });
            puestas++;
            pagina.cleanup();
        } catch (e) {
            console.warn('Expediente: no se pudo rasterizar la página ' + n, e);
        }
    }
    try { await doc.destroy(); } catch (e) {}
    if (puestas === 0) throw new Error('no se pudo dibujar ninguna página');
    return { total, puestas, rasterizado: true };
}

/* ---- Unir un PDF de origen al expediente ----
   Devuelve { total, puestas, rasterizado }: cuántas páginas tenía el
   documento, cuántas entraron y si hubo que dibujarlas como imagen.

   Se intentan cinco caminos, del mejor al más tolerante, y solo se
   pasa al siguiente si el anterior no logró meter todas las páginas:

     1. Copia en bloque con pdf-lib. Rápida y conserva el texto.
     2. Copia página por página con pdf-lib. Salva las páginas sanas de
        un documento que falla como conjunto.
     3. Reparar la puerta de entrada a nivel de bytes y reintentar con
        pdf-lib. Conserva el texto en archivos cuya única avería es esa.
     4. Rehacer el archivo con los objetos que sobrevivieron, para los
        que llegaron cortados.
     5. Rasterizado con pdf.js. Dibuja lo que los otros cuatro rechazan.

   El origen del archivo no importa: si un visor lo abre, entra en el
   expediente. */
async function unirPdfAlExpediente(expediente, PDFLib, bytes) {
    let total = 0;
    // Páginas que el camino 2 sí logró copiar. Se guardan por si los
    // caminos siguientes tampoco funcionan: es preferible un documento
    // al que le faltan folios que ningún documento.
    let salvadasPorPagina = [];

    try {
        const doc = await PDFLib.PDFDocument.load(bytes.slice(0), {
            ignoreEncryption: true,      // PDF con permisos de solo lectura
            throwOnInvalidObject: false, // referencias colgantes: se ignoran
            updateMetadata: false        // no reescribir el productor del original
        });
        const indices = doc.getPageIndices();
        total = indices.length;

        // 1) Todas las páginas de una vez
        try {
            const paginas = await expediente.copyPages(doc, indices);
            for (const pagina of paginas) expediente.addPage(pagina);
            return { total, puestas: paginas.length, rasterizado: false };
        } catch (e) { /* sigue por el camino 2 */ }

        // 2) Una por una: se aíslan las páginas problemáticas
        const copiadas = [];
        for (const i of indices) {
            try {
                const [pagina] = await expediente.copyPages(doc, [i]);
                copiadas.push(pagina);
            } catch (e) { copiadas.push(null); }
        }
        salvadasPorPagina = copiadas.filter(Boolean);
        if (salvadasPorPagina.length === total && total > 0) {
            for (const pagina of salvadasPorPagina) expediente.addPage(pagina);
            return { total, puestas: total, rasterizado: false };
        }
        // Faltan páginas. Se intenta reparar el archivo para recuperarlas
        // todas; si no se logra, al final se usan estas.
    } catch (e) { /* ni siquiera se pudo leer: va directo al camino 3 */ }

    // 3) Reparar la estructura y volver a intentarlo con pdf-lib, que
    //    conserva el texto. Muchos archivos solo tienen rota la puerta
    //    de entrada, no el contenido.
    let reparados = null;
    try { reparados = repararPdf(bytes); } catch (e) { reparados = null; }
    if (reparados) {
        try {
            const doc = await PDFLib.PDFDocument.load(reparados.slice(0), {
                ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false
            });
            const indices = doc.getPageIndices();
            if (indices.length) {
                const paginas = await expediente.copyPages(doc, indices);
                for (const pagina of paginas) expediente.addPage(pagina);
                return { total: indices.length, puestas: paginas.length, rasterizado: false };
            }
        } catch (e) { /* sigue al camino 4 */ }
    }

    // 4) Reconstruir el archivo con los objetos que sobrevivieron y
    //    reintentar con pdf-lib
    let rearmados = null;
    try { rearmados = reconstruirPdf(bytes); } catch (e) { rearmados = null; }
    if (rearmados) {
        try {
            const doc = await PDFLib.PDFDocument.load(rearmados.slice(0), {
                ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false
            });
            const indices = doc.getPageIndices();
            if (indices.length) {
                const paginas = await expediente.copyPages(doc, indices);
                for (const pagina of paginas) expediente.addPage(pagina);
                return { total: total || indices.length, puestas: paginas.length, rasterizado: false };
            }
        } catch (e) { /* sigue al camino 5 */ }
    }

    // 5) Red de seguridad: dibujarlo con pdf.js, sobre la mejor versión
    //    del archivo que se haya conseguido
    try {
        const r = await rasterizarPdfAlExpediente(expediente, rearmados || reparados || bytes);
        return { total: r.total || total, puestas: r.puestas, rasterizado: true };
    } catch (e) {
        // Ni pdf.js pudo. Si el camino 2 había rescatado algunas páginas,
        // entran esas antes que dejar el documento fuera del expediente.
        if (salvadasPorPagina.length) {
            for (const pagina of salvadasPorPagina) expediente.addPage(pagina);
            return { total, puestas: salvadasPorPagina.length, rasterizado: false };
        }
        throw e;
    }
}

/* ---- Unir una imagen al expediente ----
   La imagen se centra en una página tamaño carta con margen, sin
   ampliarla por encima de su tamaño real (de ahí el tope de 1 en la
   escala): estirar un escaneo de baja resolución solo lo emborrona. */
async function unirImagenAlExpediente(expediente, bytes, ext) {
    const img = ext === 'png'
        ? await expediente.embedPng(bytes)
        : await expediente.embedJpg(bytes);
    const anchoPag = 612, altoPag = 792;   // carta, en puntos PostScript
    const margen = 36;                      // media pulgada
    const escala = Math.min(
        (anchoPag - margen * 2) / img.width,
        (altoPag - margen * 2) / img.height,
        1
    );
    const pagina = expediente.addPage([anchoPag, altoPag]);
    pagina.drawImage(img, {
        x: (anchoPag - img.width * escala) / 2,
        y: (altoPag - img.height * escala) / 2,
        width: img.width * escala,
        height: img.height * escala
    });
}

/* Une los documentos seleccionados en un solo PDF y lo descarga. */
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

        // Cada documento va en su propio try. Antes un solo archivo
        // ilegible tumbaba el lote entero y el operador perdía los
        // otros veinticinco; ahora se salta, se anota y se sigue.
        const fallidos = [];    // ni pdf.js pudo abrirlos
        const parciales = [];   // entraron, pero les faltan páginas
        const rescatados = [];  // entraron dibujados como imagen

        for (const id of _seleccionExpediente) {
            hechos++;
            boton.textContent = 'Uniendo ' + hechos + '/' + _seleccionExpediente.length + '…';
            let nombre = 'documento ' + hechos;
            try {
                const archivo = await dbObtener('archivos', id);   // trae el contenido (blob)
                // El nombre se toma en cuanto se conoce: si la descarga
                // vino vacía, el aviso debe decir cuál archivo fue
                if (archivo && archivo.nombre) nombre = archivo.nombre;
                if (!archivo || !archivo.blob) { fallidos.push(nombre); continue; }
                const ext = extensionDe(nombre);
                const bytes = await archivo.blob.arrayBuffer();

                if (ext === 'pdf') {
                    boton.textContent = 'Uniendo ' + hechos + '/' + _seleccionExpediente.length + '…';
                    const r = await unirPdfAlExpediente(expediente, PDFLib, bytes);
                    if (r.rasterizado) rescatados.push(nombre);
                    if (r.puestas < r.total) {
                        parciales.push(nombre + ' (' + r.puestas + ' de ' + r.total + ' páginas)');
                    }
                } else if (['png', 'jpg', 'jpeg'].includes(ext)) {
                    await unirImagenAlExpediente(expediente, bytes, ext);
                } else {
                    fallidos.push(nombre);   // tipo que no se puede fusionar
                }
            } catch (e) {
                // Se anota y se continúa: el resto del expediente se salva
                console.warn('Expediente: no se pudo unir «' + nombre + '»', e);
                fallidos.push(nombre);
            }
        }

        if (expediente.getPageCount() === 0) {
            avisar('Ninguno de los documentos seleccionados se pudo unir. ' +
                   'Revisa que sean PDF o imágenes y que no estén dañados.', 'error');
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

        const unidos = _seleccionExpediente.length - fallidos.length;
        registrarActividad('generar-expediente',
            carpetaAbierta.nombre + ' (' + unidos + ' de ' + _seleccionExpediente.length + ' documentos)',
            carpetaAbierta.id);

        // El aviso dice exactamente qué quedó fuera y por qué, en vez de
        // dar por bueno un expediente al que le faltan documentos
        avisar('Expediente generado: ' + expediente.getPageCount() + ' página(s) en un solo PDF.');
        if (rescatados.length) {
            // No es un error: el documento SÍ entró. Se avisa porque esas
            // páginas van como imagen y no se les puede buscar texto.
            avisar(rescatados.length + ' documento(s) se unieron como imagen ' +
                   'porque venían dañados: ' + rescatados.join(', ') +
                   '. Se ven igual, pero no se les puede buscar texto.');
        }
        if (fallidos.length) {
            avisar('No se pudo unir ' + fallidos.length + ' documento(s): ' +
                   fallidos.join(', ') + '. Puede que estén protegidos con ' +
                   'contraseña o que el archivo esté incompleto.', 'error');
        }
        if (parciales.length) {
            avisar('Se unieron parcialmente: ' + parciales.join('; ') + '.', 'error');
        }
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
        } else if (!destinoAdmiteExtension(_subcarpetaAbierta, ext)) {
            rechazados.push(motivoRechazo(_subcarpetaAbierta, archivo.name));
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
                // Se sube a la subcarpeta que está abierta (null = raíz)
                subcarpetaId: _subcarpetaAbierta,
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

/* Descarga un documento, si el rol tiene permitido descargarlo. */
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

/* Abre un documento en el visor. Word y Excel se renderizan dentro del
   portal; el resto va al visor nativo del navegador. */
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
/* Cierra el visor de Office y libera su contenido. */
function cerrarModalVisor() {
    document.getElementById('modal-visor').hidden = true;
    document.getElementById('visor-cuerpo').innerHTML = '';
}

let _promesaDocx = null;
/* Carga docx-preview desde CDN la primera vez que se abre un Word. */
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
/* Carga SheetJS desde CDN la primera vez que se abre un Excel o se
   exporta a xlsx. */
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

/* Renderiza un documento de Word dentro del portal. */
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

/* Renderiza una hoja de cálculo dentro del portal, con una pestaña por
   hoja del libro. */
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
/* Convierte un nombre en algo que cualquier sistema de archivos acepte:
   sin tildes, sin espacios y sin caracteres reservados. */
function nombreArchivoSeguro(texto) {
    return String(texto)
        .normalize('NFD').replace(MARCAS_ACENTO_ZIP, '')
        .replace(/[^a-zA-Z0-9._-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 60) || 'carpeta';
}

/* Descarga toda la carpeta en un ZIP, respetando los permisos de
   descarga de cada documento. */
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

/* Elimina un documento previa confirmación. Borra el metadato y el
   binario del almacenamiento. */
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

    // Listas para asignar: operadores responsables y clientes/acreedores.
    // Solo sale la gente de la notaría de la carpeta: asignar un cliente
    // de Medellín a un expediente de Santa Marta rompería el aislamiento
    // entre oficinas. Al editar manda la notaría de la carpeta, no la que
    // esté abierta, por si se llegó desde "Todas las notarías".
    const notariaDeLaCarpeta = carpeta ? (carpeta.notariaId ?? null) : _notariaActiva;
    const usuarios = (await dbTodos('usuarios'))
        .filter(u => usuarioEnNotaria(u, notariaDeLaCarpeta));
    const filaCheque = (u, marcados) =>
        '<label><input type="checkbox" value="' + escaparHtml(u.usuario) + '"' +
        (marcados.includes(u.usuario) ? ' checked' : '') + '> ' +
        escaparHtml(u.nombre) + ' <span class="pt-nota">(' + escaparHtml(ETIQUETAS_ROL[u.rol]) +
        (u.activo === false ? ' · desactivado' : '') + ')</span></label>';

    // Listas SEPARADAS por rol (pestañas Operadores / Clientes / Acreedores)
    const operadores = usuarios.filter(u => u.rol === 'operador');
    const operadoresMarcados = carpeta ? (carpeta.operadores || []) : [];
    document.getElementById('carpeta-operadores').innerHTML = operadores.length === 0
        ? '<p class="pt-nota">No hay operadores en esta notaría. Créalos desde Usuarios, o dale acceso a esta oficina a alguien que ya exista.</p>'
        : operadores.map(u => filaCheque(u, operadoresMarcados)).join('');

    const marcados = carpeta ? (carpeta.asignados || []) : [];
    const clientes = usuarios.filter(u => u.rol === 'cliente');
    document.getElementById('carpeta-clientes').innerHTML = clientes.length === 0
        ? '<p class="pt-nota">No hay clientes en esta notaría. Créalos desde Usuarios, o dale acceso a esta oficina a alguien que ya exista.</p>'
        : clientes.map(u => filaCheque(u, marcados)).join('');
    const acreedores = usuarios.filter(u => u.rol === 'acreedor');
    document.getElementById('carpeta-acreedores').innerHTML = acreedores.length === 0
        ? '<p class="pt-nota">No hay acreedores en esta notaría. Créalos desde Usuarios, o dale acceso a esta oficina a alguien que ya exista.</p>'
        : acreedores.map(u => filaCheque(u, marcados)).join('');

    cambiarTabRolCarpeta('operadores');
    document.getElementById('modal-carpeta').hidden = false;
}

/* Cambia entre las pestañas de roles al asignar personas a la carpeta. */
function cambiarTabRolCarpeta(grupo) {
    if (!['operadores', 'clientes', 'acreedores'].includes(grupo)) return;
    document.querySelectorAll('#carpeta-tabs-roles button').forEach(b =>
        b.classList.toggle('activa', b.dataset.grupo === grupo));
    for (const g of ['operadores', 'clientes', 'acreedores']) {
        document.getElementById('grupo-' + g).hidden = (g !== grupo);
    }
}

/* Cierra el formulario de carpeta. */
function cerrarModalCarpeta() {
    document.getElementById('modal-carpeta').hidden = true;
    carpetaEditando = null;
}

/* Crea o actualiza la carpeta con sus personas asignadas. */
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
        // La carpeta nace en la notaría que esté abierta. Con "todas las
        // notarías" no hay una sola a la que asignarla, así que se pide
        // elegir antes: una carpeta sin oficina no la vería nadie.
        if (_notariasDisponibles.length && _notariaActiva === null) {
            avisar('Abre una notaría concreta para crear la carpeta. ' +
                   'Desde "Todas las notarías" no se sabe a cuál pertenece.', 'error');
            return;
        }
        await dbAgregar('carpetas', {
            nombre, descripcion, activa, asignados, operadores,
            notariaId: _notariaActiva,
            creadaPor: sesion.usuario,
            fecha: Date.now()
        });
        registrarActividad('crear-carpeta', nombre);
        avisar('Carpeta creada.');
    }
    cerrarModalCarpeta();
    await mostrarVistaCarpetas();
}

/* Activa o desactiva una carpeta. Desactivar no borra nada: la saca de
   la vista de trabajo diario. */
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

/* Elimina la carpeta con todos sus documentos, previa confirmación. */
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

/* Abre la vista de usuarios (solo administrador). Pinta con la copia
   guardada y corrige cuando responde el servidor. */
async function mostrarVistaUsuarios() {
    if (!ES_ADMIN) return;
    mostrarVista('vista-usuarios');

    const guardados = cacheLeer('usuarios');
    if (guardados) aplicarUsuarios(guardados);
    else document.getElementById('lista-usuarios').innerHTML = esqueletoFilas(5);

    const { valor, cambio } = await cacheRefrescar('usuarios', () => dbTodos('usuarios'));
    if (!guardados || cambio) aplicarUsuarios(valor);
}

/* Vuelca la lista de usuarios en la vista y actualiza el resumen de
   cuentas activas. */
function aplicarUsuarios(usuarios) {
    // slice(): ordenar in situ mutaría la copia guardada en la caché
    _usuariosCache = usuarios.slice().sort((a, b) => a.usuario.localeCompare(b.usuario));
    const resumen = document.getElementById('usuarios-resumen');
    if (resumen) resumen.textContent = resumenUsuariosDeNotaria();
    pintarListaUsuarios();
}

const ORDEN_ROLES_USUARIOS = ['administrador', 'monitor', 'operador', 'cliente', 'acreedor'];

/* Dibuja las tarjetas de usuario ya filtradas por rol y búsqueda. */
function pintarListaUsuarios() {
    const q = _busquedaUsuarios.trim().toLowerCase();
    let usuarios = _usuariosCache.filter(u =>
        // Cada oficina tiene su propia gente. Solo el operador con varias
        // asignadas, y el administrador, aparecen en más de una.
        usuarioEnNotaria(u, _notariaActiva) &&
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

/* Filtra la lista de usuarios por rol. */
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

/* Abre el registro de actividad del portal (administrador y monitor). */
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

/* Filtra el registro de actividad por rol. */
function cambiarRolNotif(rol) {
    if (!ROLES_NOTIF.includes(rol)) return;
    _rolNotifActivo = rol;
    document.querySelectorAll('#sub-pestanas-notif button').forEach(b =>
        b.classList.toggle('activa', b.dataset.rol === rol));
    pintarNotificaciones();
}

/* Dibuja el registro de actividad ya filtrado. */
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

/* Da de alta un usuario. La cuenta la crea una función de servidor con
   la clave de servicio: el navegador nunca la ve. */
async function crearUsuario(evento) {
    evento.preventDefault();
    if (!ES_ADMIN) return;

    const usuario = document.getElementById('nuevo-usuario').value.trim().toLowerCase();
    const nombre = document.getElementById('nuevo-nombre').value.trim();
    const clave = document.getElementById('nueva-clave').value;
    const rol = document.getElementById('nuevo-rol').value;
    const correo = document.getElementById('nuevo-correo').value.trim();
    const notarias = notariasMarcadasEnFormulario();

    // El administrador ve todas las oficinas por su rol; a los demás hay
    // que decirles en cuál trabajan
    if (rol !== 'administrador' && _notariasDisponibles.length && !notarias.length) {
        avisar('Elige la notaría donde va a trabajar este usuario.', 'error');
        return;
    }
    if (rol !== 'administrador' && rol !== 'operador' && notarias.length > 1) {
        avisar('Este rol trabaja en una sola notaría.', 'error');
        return;
    }

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
        const aviso = await crearUsuarioDatos(usuario, nombre, rol, clave, correo, notarias);
        avisar(aviso || ('Usuario "' + usuario + '" creado.'), aviso ? 'error' : undefined);
    } catch (e) {
        avisar(e.message || 'No se pudo crear el usuario.', 'error');
        return;
    }
    document.getElementById('form-usuario').reset();
    alternarCajonUsuario(false);
    await mostrarVistaUsuarios();
}

/* Comprobación básica de formato de correo. */
function esCorreoValido(c) {
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(c || ''));
}

/* ============ EDITAR USUARIO (nombre, rol y restablecer contraseña) ============
   No se puede VER la contraseña anterior (se guarda cifrada); el administrador
   pone una NUEVA y se la entrega al usuario que la olvidó. */
let usuarioEditando = null;

/* Abre la edición de un usuario existente. */
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
    // Las notarías se traen aparte: son otra tabla
    pintarNotariasDeEdicion(usuario);
}

/* Casillas de notaría del usuario que se está editando. Aquí es donde
   a un operador se le añaden ciudades, o a un cliente se le cambia de
   oficina. Las carpetas no se mueven con él: pertenecen a la notaría
   donde se abrieron, no a la persona. */
async function pintarNotariasDeEdicion(usuario) {
    const campo = document.getElementById('campo-editar-notarias');
    const caja = document.getElementById('editar-notarias');
    const etiqueta = document.getElementById('etiqueta-editar-notarias');
    if (!campo || !caja) return;

    await cargarCatalogoNotarias();
    const activas = _notariasFormulario.filter(n => n.activa);
    // El administrador las tiene todas por su rol: no hay nada que marcar
    if (!activas.length || usuario.rol === 'administrador') {
        campo.hidden = true; caja.innerHTML = ''; return;
    }
    campo.hidden = false;

    let suyas = [];
    try { suyas = (await notariasDePerfil(usuario.usuario)).map(String); }
    catch (e) { suyas = []; }

    const varias = usuario.rol === 'operador';
    etiqueta.textContent = varias
        ? 'Notarías donde puede trabajar (puede marcar varias)'
        : 'Notaría';
    caja.innerHTML = activas.map(n =>
        '<label class="pt-notaria-casilla">' +
            '<input type="' + (varias ? 'checkbox' : 'radio') + '" ' +
                   'name="notaria-editar" value="' + n.id + '"' +
                   (suyas.includes(String(n.id)) ? ' checked' : '') + '>' +
            '<span><b>' + escaparHtml(n.ciudad) + '</b> · ' + escaparHtml(n.nombre) + '</span>' +
        '</label>').join('');
}

/* Cierra el formulario de edición de usuario. */
function cerrarModalUsuario() {
    document.getElementById('modal-usuario').hidden = true;
    usuarioEditando = null;
}

/* Guarda los cambios del usuario. La contraseña, si se cambia, la
   restablece una función de servidor. */
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

        // Notarías: se guardan aparte porque viven en otra tabla
        const campoNot = document.getElementById('campo-editar-notarias');
        if (campoNot && !campoNot.hidden) {
            const marcadas = [...document.querySelectorAll('#editar-notarias input:checked')]
                .map(x => Number(x.value));
            if (!marcadas.length) {
                avisar('El usuario necesita al menos una notaría.', 'error');
                return;
            }
            await perfilNotariasFijar(usuarioEditando.usuario, marcadas);
        }

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

/* Activa o desactiva una cuenta sin borrarla. */
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

/* Elimina una cuenta previa confirmación. */
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

        // Un clic fuera de un menú «⋯» lo cierra
        if (!evento.target.closest('.pt-menu')) cerrarMenusFila();

        const boton = evento.target.closest('[data-accion]');
        if (!boton) return;
        const id = Number(boton.dataset.id);

        // Elegir una opción del menú «⋯» también lo cierra
        if (boton.closest('.pt-menu__lista')) cerrarMenusFila();

        switch (boton.dataset.accion) {
            case 'salir':             confirmarSalida(); break;
            case 'salir-sitio':       confirmarSalida('../index.html'); break; // volver al sitio cierra la sesión
            case 'ver-carpetas':      mostrarVistaCarpetas(); break;
            case 'alternar-subida':   alternarZonaSubida(); break;

            // Subcarpetas dentro de la carpeta
            case 'abrir-subcarpeta':     abrirSubcarpeta(boton.dataset.sub); break;
            case 'nueva-subcarpeta':     nuevaSubcarpetaAccion(); break;
            case 'renombrar-subcarpeta': renombrarSubcarpetaAccion(); break;
            case 'eliminar-subcarpeta':  eliminarSubcarpetaAccion(); break;
            case 'texto-cancelar':       _responderTexto(null); break;
            case 'abrir-cajon-usuario':  alternarCajonUsuario(true); break;
            case 'cerrar-cajon-usuario': alternarCajonUsuario(false); break;

            // Barra lateral en pantallas angostas
            case 'abrir-lateral':     mostrarLateral(); break;
            case 'plegar-lateral':    plegarLateral(true); break;

            // Notarías
            case 'elegir-notaria':    elegirNotaria(boton.dataset.notaria); break;
            case 'marcar-notaria':    marcarNotaria(boton.dataset.notaria); break;
            case 'entrar-notaria':    entrarNotariaMarcada(); break;
            case 'cerrar-modal-notaria': cerrarModalNotaria(); break;
            case 'cambiar-notaria':   cambiarNotaria(); break;
            case 'volver-al-portal':  volverAlPortal(); break;
            case 'nueva-notaria':     nuevaNotariaAccion(); break;
            case 'editar-notaria':    editarNotariaAccion(id); break;
            case 'alternar-notaria':  alternarNotariaAccion(id); break;
            case 'cerrar-lateral':    alternarLateral(false); break;

            // Menú «⋯» de acciones secundarias de una carpeta
            case 'menu-carpeta':      alternarMenuFila('menu-carpeta-' + id); break;
            case 'menu-tramite':      alternarMenuFila('menu-tramite-' + id); break;

            // Estados de los trámites (semáforos) y calendario de vencimientos
            case 'ver-estados':          mostrarVistaEstados(); break;
            case 'refrescar-estados':    cargarYPintarEstados(); break;
            case 'alternar-vista-estados':
                _vistaEstados = (_vistaEstados === 'tabla' ? 'tablero' : 'tabla');
                pintarEstados();
                break;
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
            case 'exportar-estados':  exportarEstadosExcel(); break;

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
        // Mover un documento a otra subcarpeta
        if (e.target.dataset && e.target.dataset.accionCambio === 'mover-archivo') {
            moverArchivoAccion(Number(e.target.dataset.id), e.target.value);
        }
    });

    document.getElementById('form-carpeta').addEventListener('submit', guardarCarpeta);
    document.getElementById('form-usuario').addEventListener('submit', crearUsuario);
    const formNotaria = document.getElementById('form-notaria');
    if (formNotaria) formNotaria.addEventListener('submit', guardarNotaria);
    // El rol decide si se puede marcar una notaría o varias
    const selRol = document.getElementById('nuevo-rol');
    if (selRol) selRol.addEventListener('change', () => pintarNotariasDeFormulario(notariasMarcadasEnFormulario()));
    // Modal de texto (nombre de subcarpeta y similares)
    const formTexto = document.getElementById('form-texto');
    if (formTexto) {
        formTexto.addEventListener('submit', (e) => {
            e.preventDefault();
            _responderTexto(document.getElementById('texto-valor').value.trim());
        });
    }
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

/* Extensión de un nombre de archivo, en minúsculas y sin el punto. */
function extensionDe(nombre) {
    const partes = String(nombre).toLowerCase().split('.');
    return partes.length > 1 ? partes.pop() : '';
}

/* Icono que corresponde a un tipo de archivo. */
function iconoArchivo(ext) {
    if (ext === 'pdf' || ext === 'doc' || ext === 'docx') return icono('documento');
    if (ext === 'xls' || ext === 'xlsx') return icono('hoja');
    if (ext === 'png' || ext === 'jpg' || ext === 'jpeg') return icono('imagen');
    if (ext === 'mp3') return icono('audio');
    if (ext === 'mp4') return icono('video');
    return icono('adjunto');
}

/* Tamaño en bytes expresado en KB o MB. */
function formatoTamano(bytes) {
    if (!bytes && bytes !== 0) return '—';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
}

/* Fecha y hora en formato local colombiano. */
function formatoFecha(marca) {
    if (!marca) return '—';
    return new Date(marca).toLocaleString('es-CO', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });
}

let toastTemporizador = null;
/* Muestra un aviso flotante. El tipo error lo pinta en rojo y lo deja
   más tiempo en pantalla. */
function avisar(mensaje, tipo) {
    const toast = document.getElementById('toast');
    if (!toast) { console.warn('Aviso (sin toast):', mensaje); return; }
    toast.textContent = mensaje;
    toast.className = 'pt-toast visible' + (tipo === 'error' ? ' pt-toast--error' : '');
    clearTimeout(toastTemporizador);
    toastTemporizador = setTimeout(() => toast.classList.remove('visible'), 4000);
}

