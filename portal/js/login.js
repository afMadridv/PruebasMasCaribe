/* ============================================
   PORTAL DOCUMENTAL - Página de inicio de sesión
   ============================================ */
document.addEventListener('DOMContentLoaded', async () => {
    const formulario = document.getElementById('form-login');
    const mensajeError = document.getElementById('mensaje-error');
    const botonEntrar = document.getElementById('boton-entrar');

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
