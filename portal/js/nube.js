/* ============================================
   PORTAL DOCUMENTAL - Conexión a Supabase (nube)
   Si PORTAL_CONFIG.MODO === 'nube', este archivo reemplaza
   las funciones de datos locales (IndexedDB) por llamadas a
   Supabase: Auth (sesiones), Postgres (tablas) y Storage
   (archivos). La interfaz (app.js / login.js) no cambia.
   ============================================ */
(() => {
    const cfg = (typeof PORTAL_CONFIG !== 'undefined') ? PORTAL_CONFIG : null;
    if (!cfg || cfg.MODO !== 'nube' || !cfg.SUPABASE_URL) return;
    if (!window.supabase || !window.supabase.createClient) {
        console.warn('No cargó supabase-js; el portal sigue en modo local.');
        return;
    }

    const nube = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY);
    // Cliente aparte SOLO para registrar usuarios nuevos, para que al
    // crearlos no se reemplace la sesión del administrador.
    const nubeRegistro = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, storageKey: 'portal_registro' }
    });

    console.info('Portal Documental: conectado a Supabase (' + cfg.SUPABASE_URL + ')');

    /* ============ UTILIDADES ============ */
    function aEmail(usuario) {
        return usuario.includes('@') ? usuario : (usuario + '@' + cfg.DOMINIO_USUARIOS);
    }

    // marcas de acento que NFD separa (U+0300 a U+036F)
    const MARCAS_ACENTO = new RegExp('[' + String.fromCharCode(0x300) + '-' + String.fromCharCode(0x36f) + ']', 'g');

    function limpiarNombre(nombre) {
        return String(nombre)
            .normalize('NFD').replace(MARCAS_ACENTO, '') // sin tildes
            .replace(/[^a-zA-Z0-9._-]/g, '_');
    }

    function errorLegible(e) {
        const m = String((e && (e.message || e.error_description)) || e || '');
        if (m.includes('Invalid login credentials')) return 'Usuario o contraseña incorrectos.';
        if (m.includes('Email not confirmed')) return 'El usuario existe pero su correo no está confirmado. En Supabase: Authentication → Sign In / Providers → Email → desactivar "Confirm email".';
        if (m.includes('User already registered')) return 'Ya existe un usuario con ese nombre.';
        if (m.includes('Password should be')) return 'La contraseña no cumple el mínimo configurado en Supabase.';
        if (m.includes('schema cache') || m.includes('does not exist')) return 'La base de datos aún no tiene las tablas: ejecuta portal/supabase/esquema.sql en el SQL Editor de Supabase.';
        if (m.includes('Failed to fetch') || m.includes('NetworkError')) return 'Sin conexión con Supabase. Revisa tu internet.';
        if (m.includes('row-level security')) return 'Tu rol no tiene permiso para esa acción.';
        return m || 'Error de conexión con la base de datos.';
    }

    function fallar(e) { throw new Error(errorLegible(e)); }

    function sesionNube() { return sesionActual() || {}; }

    /* ============ AUTENTICACIÓN ============ */
    window.iniciarSesion = async (usuario, clave) => {
        const nombreUsuario = String(usuario || '').trim().toLowerCase();
        if (!nombreUsuario || !clave) return { error: 'Escribe el usuario y la contraseña.' };

        const { data, error } = await nube.auth.signInWithPassword({
            email: aEmail(nombreUsuario), password: clave
        });
        if (error) return { error: errorLegible(error) };

        const { data: perfil, error: errorPerfil } = await nube
            .from('perfiles').select('*').eq('id', data.user.id).maybeSingle();
        if (errorPerfil) { await nube.auth.signOut(); return { error: errorLegible(errorPerfil) }; }
        if (!perfil) {
            await nube.auth.signOut();
            return { error: 'Tu cuenta no tiene perfil en el portal (¿se ejecutó esquema.sql antes de crear los usuarios?).' };
        }
        if (perfil.activo === false) {
            await nube.auth.signOut();
            return { error: 'Tu usuario está desactivado. Comunícate con la fundación.' };
        }

        localStorage.setItem(CLAVE_SESION, JSON.stringify({
            usuario: perfil.usuario, nombre: perfil.nombre, rol: perfil.rol,
            _id: perfil.id, ts: Date.now()
        }));
        return { usuario: perfil };
    };

    window.cerrarSesion = (destino) => {
        localStorage.removeItem(CLAVE_SESION);
        // pase lo que pase con la red, se navega al destino indicado
        nube.auth.signOut().catch(() => {}).finally(() => { location.href = destino || 'index.html'; });
    };

    // En la nube no se siembran datos de demostración
    window.sembrarDatosIniciales = async () => {};

    /* ============ ADAPTADORES DE DATOS ============ */
    async function listarPerfiles() {
        const { data, error } = await nube.from('perfiles').select('*').order('usuario');
        if (error) fallar(error);
        return data.map(p => ({
            usuario: p.usuario, nombre: p.nombre, rol: p.rol,
            activo: p.activo, creado: Date.parse(p.creado), _id: p.id
        }));
    }

    /* Convierte uuid → usuario; solo el administrador puede leer todos
       los perfiles, los demás al menos se reconocen a sí mismos */
    function _mapaUsuarios(ses, perfiles) {
        const usuarioPorId = {};
        (perfiles || []).forEach(p => { usuarioPorId[p.id] = p.usuario; });
        if (ses._id) usuarioPorId[ses._id] = ses.usuario;
        return usuarioPorId;
    }

    async function listarCarpetas() {
        const ses = sesionNube();
        // RLS ya filtra: el operador solo recibe SUS carpetas y el
        // cliente/acreedor solo sus carpetas activas.
        // Las 4 consultas van EN PARALELO (una sola ida y vuelta de red).
        const [rCarpetas, rAsignados, rOperadores, rPerfiles] = await Promise.all([
            nube.from('carpetas').select('*'),
            nube.from('carpeta_asignados').select('carpeta_id, perfil_id'),
            nube.from('carpeta_operadores').select('carpeta_id, perfil_id'),
            ses.rol === 'administrador'
                ? nube.from('perfiles').select('id, usuario')
                : Promise.resolve({ data: null, error: null })
        ]);
        if (rCarpetas.error) fallar(rCarpetas.error);
        if (rAsignados.error) fallar(rAsignados.error);
        if (rOperadores.error) fallar(rOperadores.error);
        const usuarioPorId = _mapaUsuarios(ses, rPerfiles.data);

        return rCarpetas.data.map(c => ({
            id: c.id, nombre: c.nombre, descripcion: c.descripcion,
            activa: c.activa, creadaPor: c.creada_por, fecha: Date.parse(c.fecha),
            asignados: (rAsignados.data || [])
                .filter(a => a.carpeta_id === c.id)
                .map(a => usuarioPorId[a.perfil_id] || a.perfil_id),
            operadores: (rOperadores.data || [])
                .filter(o => o.carpeta_id === c.id)
                .map(o => usuarioPorId[o.perfil_id] || o.perfil_id)
        }));
    }

    /* Trae UNA carpeta con sus vínculos (sin listar todas) */
    async function obtenerCarpeta(clave) {
        const ses = sesionNube();
        const [rC, rA, rO, rPerfiles] = await Promise.all([
            nube.from('carpetas').select('*').eq('id', clave).maybeSingle(),
            nube.from('carpeta_asignados').select('perfil_id').eq('carpeta_id', clave),
            nube.from('carpeta_operadores').select('perfil_id').eq('carpeta_id', clave),
            ses.rol === 'administrador'
                ? nube.from('perfiles').select('id, usuario')
                : Promise.resolve({ data: null, error: null })
        ]);
        if (rC.error) fallar(rC.error);
        if (!rC.data) return undefined;
        if (rA.error) fallar(rA.error);
        if (rO.error) fallar(rO.error);
        const usuarioPorId = _mapaUsuarios(ses, rPerfiles.data);
        const c = rC.data;
        return {
            id: c.id, nombre: c.nombre, descripcion: c.descripcion,
            activa: c.activa, creadaPor: c.creada_por, fecha: Date.parse(c.fecha),
            asignados: (rA.data || []).map(a => usuarioPorId[a.perfil_id] || a.perfil_id),
            operadores: (rO.data || []).map(o => usuarioPorId[o.perfil_id] || o.perfil_id)
        };
    }

    /* Reemplaza asignados y operadores de una carpeta con UNA sola
       lectura de perfiles y escrituras en paralelo */
    async function guardarTodosVinculos(carpetaId, asignados, operadores) {
        const { data: perfiles, error } = await nube.from('perfiles').select('id, usuario');
        if (error) fallar(error);
        const idPorUsuario = {};
        (perfiles || []).forEach(p => { idPorUsuario[p.usuario] = p.id; });

        const reemplazar = async (tabla, usuarios) => {
            const { error: errorBorra } = await nube.from(tabla)
                .delete().eq('carpeta_id', carpetaId);
            if (errorBorra) fallar(errorBorra);
            const filas = (usuarios || [])
                .map(u => idPorUsuario[u]).filter(Boolean)
                .map(perfilId => ({ carpeta_id: carpetaId, perfil_id: perfilId }));
            if (filas.length > 0) {
                const { error: errorInserta } = await nube.from(tabla).insert(filas);
                if (errorInserta) fallar(errorInserta);
            }
        };
        await Promise.all([
            reemplazar('carpeta_asignados', asignados),
            reemplazar('carpeta_operadores', operadores)
        ]);
    }

    window.dbTodos = async (almacen) => {
        if (almacen === 'usuarios') return listarPerfiles();
        if (almacen === 'carpetas') return listarCarpetas();
        if (almacen === 'archivos') {
            const { data, error } = await nube.from('archivos').select('id, carpeta_id');
            if (error) fallar(error);
            return data.map(a => ({ id: a.id, carpetaId: a.carpeta_id }));
        }
        return [];
    };

    window.dbObtener = async (almacen, clave) => {
        if (almacen === 'usuarios') {
            const { data, error } = await nube.from('perfiles')
                .select('*').eq('usuario', clave).maybeSingle();
            if (error) fallar(error);
            if (!data) return undefined;
            return {
                usuario: data.usuario, nombre: data.nombre, rol: data.rol,
                activo: data.activo, creado: Date.parse(data.creado), _id: data.id
            };
        }
        if (almacen === 'carpetas') {
            return obtenerCarpeta(clave);
        }
        if (almacen === 'archivos') {
            const { data, error } = await nube.from('archivos')
                .select('*').eq('id', clave).maybeSingle();
            if (error) fallar(error);
            if (!data) return undefined;
            const { data: blob, error: errorBlob } = await nube.storage
                .from('documentos').download(data.ruta_storage);
            if (errorBlob) fallar(errorBlob);
            return {
                id: data.id, carpetaId: data.carpeta_id, nombre: data.nombre,
                tipo: data.tipo, tamano: data.tamano, blob,
                subidoPor: data.subido_por_usuario, fecha: Date.parse(data.fecha)
            };
        }
        return undefined;
    };

    window.dbAgregar = async (almacen, valor) => {
        const ses = sesionNube();
        if (almacen === 'carpetas') {
            const { data, error } = await nube.from('carpetas').insert({
                nombre: valor.nombre,
                descripcion: valor.descripcion || '',
                activa: !!valor.activa,
                creada_por: ses._id || null
            }).select('id').single();
            if (error) fallar(error);
            await guardarTodosVinculos(data.id, valor.asignados, valor.operadores);
            return data.id;
        }
        if (almacen === 'archivos') {
            const ruta = valor.carpetaId + '/' + Date.now() + '_' + limpiarNombre(valor.nombre);
            const { error: errorSube } = await nube.storage.from('documentos')
                .upload(ruta, valor.blob, { contentType: valor.tipo || 'application/octet-stream' });
            if (errorSube) fallar(errorSube);
            const { error: errorFila } = await nube.from('archivos').insert({
                carpeta_id: valor.carpetaId, nombre: valor.nombre,
                tipo: valor.tipo || '', tamano: valor.tamano || 0,
                ruta_storage: ruta,
                // se guarda el NOMBRE visible (la identidad real va en subido_por)
                subido_por: ses._id || null, subido_por_usuario: ses.nombre || ses.usuario || ''
            });
            if (errorFila) fallar(errorFila);
            return;
        }
        throw new Error('Operación no disponible en la nube: agregar en ' + almacen);
    };

    window.dbGuardar = async (almacen, valor) => {
        if (almacen === 'carpetas') {
            const { error } = await nube.from('carpetas').update({
                nombre: valor.nombre,
                descripcion: valor.descripcion || '',
                activa: !!valor.activa
            }).eq('id', valor.id);
            if (error) fallar(error);
            if (valor.asignados || valor.operadores) {
                await guardarTodosVinculos(valor.id, valor.asignados || [], valor.operadores || []);
            }
            return;
        }
        if (almacen === 'usuarios') {
            const { error } = await nube.from('perfiles').update({
                nombre: valor.nombre, rol: valor.rol, activo: valor.activo !== false
            }).eq(valor._id ? 'id' : 'usuario', valor._id || valor.usuario);
            if (error) fallar(error);
            return;
        }
        throw new Error('Operación no disponible en la nube: guardar en ' + almacen);
    };

    window.dbEliminar = async (almacen, clave) => {
        if (almacen === 'carpetas') {
            const { error } = await nube.from('carpetas').delete().eq('id', clave);
            if (error) fallar(error);
            return;
        }
        if (almacen === 'archivos') {
            const { data, error } = await nube.from('archivos')
                .select('ruta_storage').eq('id', clave).maybeSingle();
            if (error) fallar(error);
            if (data) await nube.storage.from('documentos').remove([data.ruta_storage]);
            const { error: errorFila } = await nube.from('archivos').delete().eq('id', clave);
            if (errorFila) fallar(errorFila);
            return;
        }
        if (almacen === 'usuarios') {
            // Quita el perfil (pierde todo acceso). La cuenta de correo se
            // elimina del todo desde el panel de Supabase si se desea.
            const { error } = await nube.from('perfiles').delete().eq('usuario', clave);
            if (error) fallar(error);
            return;
        }
    };

    window.dbArchivosDeCarpeta = async (carpetaId) => {
        const { data, error } = await nube.from('archivos')
            .select('id, carpeta_id, nombre, tipo, tamano, subido_por_usuario, fecha')
            .eq('carpeta_id', carpetaId);
        if (error) fallar(error);
        return data.map(a => ({
            id: a.id, carpetaId: a.carpeta_id, nombre: a.nombre, tipo: a.tipo,
            tamano: a.tamano, subidoPor: a.subido_por_usuario, fecha: Date.parse(a.fecha)
        }));
    };

    window.dbEliminarArchivosDeCarpeta = async (carpetaId) => {
        const { data, error } = await nube.from('archivos')
            .select('id, ruta_storage').eq('carpeta_id', carpetaId);
        if (error) fallar(error);
        const rutas = (data || []).map(a => a.ruta_storage);
        if (rutas.length > 0) await nube.storage.from('documentos').remove(rutas);
        const { error: errorFilas } = await nube.from('archivos')
            .delete().eq('carpeta_id', carpetaId);
        if (errorFilas) fallar(errorFilas);
    };

    /* Bitácora: registrar acción (el servidor pone el actor real) y
       listarla (RLS deja leerla solo al administrador) */
    window.registrarActividad = async (accion, objetivo) => {
        try {
            await nube.rpc('registrar_actividad', {
                p_accion: accion, p_objetivo: objetivo || ''
            });
        } catch (e) { /* la auditoría nunca rompe la acción principal */ }
    };

    window.listarActividad = async () => {
        const { data, error } = await nube.from('actividad')
            .select('usuario, nombre, rol, accion, objetivo, fecha')
            .order('fecha', { ascending: false })
            .limit(300);
        if (error) fallar(error);
        return (data || []).map(a => ({
            usuario: a.usuario, nombre: a.nombre, rol: a.rol,
            accion: a.accion, objetivo: a.objetivo, fecha: Date.parse(a.fecha)
        }));
    };

    /* Archivos de una carpeta CON contenido, para el ZIP. Las descargas
       van en paralelo; RLS valida el acceso archivo por archivo. */
    window.descargarBlobsDeCarpeta = async (carpetaId, alProgresar) => {
        const { data, error } = await nube.from('archivos')
            .select('nombre, ruta_storage').eq('carpeta_id', carpetaId);
        if (error) fallar(error);
        const total = (data || []).length;
        let hechos = 0;
        return Promise.all((data || []).map(async (fila) => {
            const { data: blob, error: errorBlob } = await nube.storage
                .from('documentos').download(fila.ruta_storage);
            if (errorBlob) fallar(errorBlob);
            hechos++;
            if (alProgresar) alProgresar(hechos, total);
            return { nombre: fila.nombre, blob };
        }));
    };

    /* Actualizar solo la descripción (estado del trámite): el servidor
       valida que sea el admin o el operador responsable de la carpeta */
    window.actualizarDescripcionCarpeta = async (carpetaId, descripcion) => {
        const { error } = await nube.rpc('actualizar_descripcion', {
            carpeta: carpetaId,
            nueva_descripcion: descripcion
        });
        if (error) fallar(error);
    };

    /* Crear usuario: lo registra con el cliente secundario (la sesión del
       administrador no se toca). El servidor lo crea como 'cliente' por
       seguridad y aquí el administrador le asigna su rol real. */
    window.crearUsuarioDatos = async (usuario, nombre, rol, clave) => {
        const { data, error } = await nubeRegistro.auth.signUp({
            email: aEmail(usuario),
            password: clave,
            options: { data: { usuario, nombre } }
        });
        if (error) throw new Error(errorLegible(error));
        const id = data.user && data.user.id;
        if (!id) throw new Error('Supabase no devolvió el usuario creado.');

        if (rol !== 'cliente') {
            const { error: errorRol } = await nube.from('perfiles')
                .update({ rol }).eq('id', id);
            if (errorRol) throw new Error('Usuario creado, pero no se pudo asignar el rol: ' + errorLegible(errorRol));
        }
        const pideConfirmar = !data.session && !data.user.confirmed_at && !data.user.email_confirmed_at;
        // El cliente secundario queda logueado como el usuario recién creado;
        // se cierra para que la siguiente creación parta limpia.
        await nubeRegistro.auth.signOut().catch(() => {});
        if (pideConfirmar) {
            return 'Usuario creado, pero Supabase pide confirmar correo: desactiva "Confirm email" en Authentication para que pueda ingresar.';
        }
        return '';
    };

    /* ============ AVISOS EN LA PÁGINA DE INGRESO ============ */
    document.addEventListener('DOMContentLoaded', async () => {
        const caja = document.getElementById('caja-credenciales');
        if (caja) {
            const ic = (n) => (typeof icono === 'function' ? icono(n, 16) : '');
            caja.innerHTML = '<span class="pt-credenciales-linea">' + ic('nube') +
                ' <strong>Conectado a la nube (Supabase).</strong></span> ' +
                'Ingresa con el usuario y la contraseña que te entregó la fundación.';
            // ¿Ya se ejecutó el esquema? Avisar si falta.
            const { error } = await nube.from('perfiles').select('id').limit(1);
            if (error && String(error.message).includes('schema cache')) {
                caja.innerHTML += '<br><br><span class="pt-credenciales-linea">' + ic('alerta') +
                    ' <strong>Falta un paso:</strong></span> la base de datos aún no tiene ' +
                    'las tablas. Ejecuta <code>portal/supabase/esquema.sql</code> en el SQL Editor de Supabase.';
            }
        } else if (sesionActual()) {
            // En la aplicación: si el espejo de sesión quedó huérfano
            // (Supabase ya cerró la sesión real), volver al ingreso.
            const { data } = await nube.auth.getSession();
            if (!data.session) {
                localStorage.removeItem(CLAVE_SESION);
                location.replace('index.html');
            }
        }
    });
})();
