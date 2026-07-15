/* ============================================
   PORTAL DOCUMENTAL - Página de inicio de sesión
   ============================================ */
document.addEventListener('DOMContentLoaded', async () => {
    const formulario = document.getElementById('form-login');
    const mensajeError = document.getElementById('mensaje-error');
    const botonEntrar = document.getElementById('boton-entrar');

    // ¿Olvidaste tu contraseña? → <dialog> nativo; la solicitud queda en
    // solicitudes_clave y el administrador la ve en su campana (Realtime).
    const botonOlvide = document.getElementById('olvide-clave');
    const dialogo = document.getElementById('dialogo-olvide');
    if (botonOlvide && dialogo) {
        const campo = document.getElementById('olvide-usuario');
        const mensaje = document.getElementById('olvide-mensaje');
        botonOlvide.addEventListener('click', () => {
            campo.value = document.getElementById('campo-usuario').value.trim().toLowerCase();
            mensaje.hidden = true;
            dialogo.showModal();
            campo.focus();
        });
        document.getElementById('olvide-cancelar').addEventListener('click', () => dialogo.close());
        document.getElementById('olvide-enviar').addEventListener('click', async () => {
            const usuario = campo.value.trim().toLowerCase();
            if (!usuario) { campo.focus(); return; }
            const boton = document.getElementById('olvide-enviar');
            boton.disabled = true;
            try {
                if (typeof solicitarRestablecimiento === 'function') {
                    await solicitarRestablecimiento(usuario);
                }
            } catch (e) { /* misma respuesta siempre: no se revela nada */ }
            boton.disabled = false;
            // Mensaje único, exista o no el usuario (no se regala información)
            mensaje.textContent = 'Solicitud enviada. Si el usuario existe, la administración ' +
                'te asignará una contraseña nueva y te la hará llegar.';
            mensaje.hidden = false;
            campo.value = '';
            setTimeout(() => dialogo.close(), 3500);
        });
    }

    // Mostrar / ocultar contraseña
    const campoClave = document.getElementById('campo-clave');
    const botonVerClave = document.getElementById('ver-clave');
    if (botonVerClave && campoClave) {
        botonVerClave.addEventListener('click', () => {
            const oculta = campoClave.type === 'password';
            campoClave.type = oculta ? 'text' : 'password';
            botonVerClave.innerHTML = icono(oculta ? 'ojo-cerrado' : 'ver');
            botonVerClave.setAttribute('aria-pressed', String(oculta));
            botonVerClave.setAttribute('aria-label', oculta ? 'Ocultar contraseña' : 'Mostrar contraseña');
            campoClave.focus();
        });
    }

    // El formulario se conecta primero: aunque la siembra de datos
    // fallara, el ingreso debe seguir funcionando.
    formulario.addEventListener('submit', async (evento) => {
        evento.preventDefault();
        mensajeError.hidden = true;
        botonEntrar.disabled = true;
        botonEntrar.textContent = 'Verificando…';

        try {
            const usuario = document.getElementById('campo-usuario').value;
            const clave = document.getElementById('campo-clave').value;
            const resultado = await iniciarSesion(usuario, clave);

            if (resultado.error) {
                mensajeError.textContent = resultado.error;
                mensajeError.hidden = false;
                return;
            }
            // Registrar el ingreso ANTES de redirigir (si no, se perdería)
            if (typeof registrarActividad === 'function') {
                await registrarActividad('ingreso', '').catch(() => {});
            }
            location.href = 'app.html';
        } catch (e) {
            mensajeError.textContent = 'Ocurrió un error inesperado. Intenta de nuevo.';
            mensajeError.hidden = false;
        } finally {
            botonEntrar.disabled = false;
            botonEntrar.textContent = 'Ingresar';
        }
    });

    try {
        await sembrarDatosIniciales();
    } catch (e) {
        // Si dos pestañas siembran a la vez puede chocar una inserción;
        // no es grave: los datos ya existen.
        console.warn('Siembra de datos:', e);
    }

    // Si ya hay una sesión válida, entrar directo
    if (sesionActual()) {
        location.replace('app.html');
    }
});
