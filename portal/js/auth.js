/* ============================================
   PORTAL DOCUMENTAL - Autenticación y permisos
   ============================================ */
const CLAVE_SESION = 'portal_sesion';
const DURACION_SESION = 8 * 60 * 60 * 1000; // 8 horas

const ETIQUETAS_ROL = {
    administrador: 'Administrador',
    monitor:       'Monitor',
    operador:      'Operador',
    cliente:       'Cliente',
    acreedor:      'Acreedor'
};

/* Guarda la contraseña como hash SHA-256 (nunca en texto plano si el
   navegador lo permite). En producción esto lo hace el servidor con bcrypt. */
async function protegerClave(texto) {
    try {
        const datos = new TextEncoder().encode(texto);
        const hash = await crypto.subtle.digest('SHA-256', datos);
        const hex = [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
        return 'sha256:' + hex;
    } catch (e) {
        return 'plano:' + texto;
    }
}

async function verificarClave(guardada, ingresada) {
    if (typeof guardada !== 'string') return false;
    if (guardada.startsWith('plano:')) return guardada === 'plano:' + ingresada;
    return guardada === await protegerClave(ingresada);
}

function sesionActual() {
    try {
        const sesion = JSON.parse(localStorage.getItem(CLAVE_SESION));
        if (!sesion || !sesion.usuario) return null;
        if (Date.now() - sesion.ts > DURACION_SESION) {
            localStorage.removeItem(CLAVE_SESION);
            return null;
        }
        return sesion;
    } catch (e) {
        return null;
    }
}

function guardarSesion(u) {
    localStorage.setItem(CLAVE_SESION, JSON.stringify({
        usuario: u.usuario,
        nombre: u.nombre,
        rol: u.rol,
        ts: Date.now()
    }));
}

function cerrarSesion(destino) {
    localStorage.removeItem(CLAVE_SESION);
    location.href = destino || 'index.html';
}

async function iniciarSesion(usuario, clave) {
    const nombreUsuario = String(usuario || '').trim().toLowerCase();
    if (!nombreUsuario || !clave) {
        return { error: 'Escribe el usuario y la contraseña.' };
    }
    const registro = await dbObtener('usuarios', nombreUsuario);
    if (!registro || !(await verificarClave(registro.clave, clave))) {
        return { error: 'Usuario o contraseña incorrectos.' };
    }
    if (registro.activo === false) {
        return { error: 'Tu usuario está desactivado. Comunícate con la fundación.' };
    }
    guardarSesion(registro);
    return { usuario: registro };
}
