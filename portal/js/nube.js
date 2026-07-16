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
        if (m.includes('Signups not allowed') || m.includes('signup_disabled')) return 'El registro de usuarios está desactivado en Supabase. Actívalo en Authentication → Sign In / Providers → "Allow new users to sign up" para poder crear operadores, clientes y acreedores.';
        if (m.includes('rate limit') || m.includes('For security purposes') || m.includes('over_email_send')) return 'Supabase limitó temporalmente los registros. Espera un momento y vuelve a intentarlo.';
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
            activo: p.activo, correo: p.correo || '', creado: Date.parse(p.creado), _id: p.id,
            primerLogin: p.primer_login !== false,
            ultimaConexion: p.ultima_conexion ? Date.parse(p.ultima_conexion) : null
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
            ['administrador', 'monitor'].includes(ses.rol)
                ? nube.from('perfiles').select('id, usuario')
                : Promise.resolve({ data: null, error: null })
        ]);
        if (rCarpetas.error) fallar(rCarpetas.error);
        if (rAsignados.error) fallar(rAsignados.error);
        if (rOperadores.error) fallar(rOperadores.error);
        const usuarioPorId = _mapaUsuarios(ses, rPerfiles.data);

        return rCarpetas.data.map(c => ({
            id: c.id, nombre: c.nombre, descripcion: c.descripcion,
            estadoProceso: c.estado_proceso, // >>> SIN USO: nadie lee ya este campo (timeline eliminado) — eliminar junto con la columna estado_proceso <<<
            pausado: !!c.pausado, fechaPausa: c.fecha_pausa || null,
            fechaReactivacion: c.fecha_reactivacion || null,
            fechaInicioTramite: c.fecha_inicio_tramite || null,
            diasHabilesTramite: c.dias_habiles_tramite || 60,
            tieneProrroga: !!c.tiene_prorroga,
            fechaVencimientoTramite: c.fecha_vencimiento_tramite || null,
            pesoTotalMb: Number(c.peso_total_mb || 0),
            totalArchivos: Number(c.total_archivos || 0),
            finalizado: !!c.finalizado,
            fechaFinTramite: c.fecha_fin_tramite || null,
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
            ['administrador', 'monitor'].includes(ses.rol)
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
            estadoProceso: c.estado_proceso, // >>> SIN USO: nadie lee ya este campo (timeline eliminado) — eliminar junto con la columna estado_proceso <<<
            pausado: !!c.pausado, fechaPausa: c.fecha_pausa || null,
            fechaReactivacion: c.fecha_reactivacion || null,
            fechaInicioTramite: c.fecha_inicio_tramite || null,
            diasHabilesTramite: c.dias_habiles_tramite || 60,
            tieneProrroga: !!c.tiene_prorroga,
            fechaVencimientoTramite: c.fecha_vencimiento_tramite || null,
            pesoTotalMb: Number(c.peso_total_mb || 0),
            totalArchivos: Number(c.total_archivos || 0),
            finalizado: !!c.finalizado,
            fechaFinTramite: c.fecha_fin_tramite || null,
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
                activo: data.activo, correo: data.correo || '', creado: Date.parse(data.creado), _id: data.id
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
                nombre: valor.nombre, rol: valor.rol, activo: valor.activo !== false,
                correo: valor.correo || null
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
            .select('id, carpeta_id, nombre, tipo, tamano, subido_por_usuario, fecha, orden')
            .eq('carpeta_id', carpetaId);
        if (error) fallar(error);
        return data.map(a => ({
            id: a.id, carpetaId: a.carpeta_id, nombre: a.nombre, tipo: a.tipo,
            tamano: a.tamano, subidoPor: a.subido_por_usuario,
            fecha: Date.parse(a.fecha), orden: a.orden
        }));
    };

    /* Orden manual de los documentos: solo la columna 'orden', validado en
       el servidor (admin u operador responsable). */
    window.actualizarOrdenArchivos = async (carpetaId, ids) => {
        const { error } = await nube.rpc('actualizar_orden_archivos', {
            carpeta: carpetaId, ids
        });
        if (error) fallar(error);
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
    window.registrarActividad = async (accion, objetivo, carpetaId) => {
        try {
            await nube.rpc('registrar_actividad', {
                p_accion: accion, p_objetivo: objetivo || '',
                p_carpeta: carpetaId || null
            });
        } catch (e) { /* la auditoría nunca rompe la acción principal */ }
    };

    window.listarActividad = async () => {
        const { data, error } = await nube.from('actividad')
            .select('usuario, nombre, rol, accion, objetivo, fecha, carpeta_id')
            .order('fecha', { ascending: false })
            .limit(300);
        if (error) fallar(error);
        return (data || []).map(a => ({
            usuario: a.usuario, nombre: a.nombre, rol: a.rol,
            accion: a.accion, objetivo: a.objetivo, fecha: Date.parse(a.fecha),
            carpetaId: a.carpeta_id || null
        }));
    };

    /* Actividad de UNA carpeta: RLS deja leerla al admin y al operador
       responsable (notificaciones del trámite dentro de la carpeta). */
    window.listarActividadDeCarpeta = async (carpetaId) => {
        const { data, error } = await nube.from('actividad')
            .select('usuario, nombre, rol, accion, objetivo, fecha')
            .eq('carpeta_id', carpetaId)
            .order('fecha', { ascending: false })
            .limit(200);
        if (error) fallar(error);
        return (data || []).map(a => ({
            usuario: a.usuario, nombre: a.nombre, rol: a.rol,
            accion: a.accion, objetivo: a.objetivo, fecha: Date.parse(a.fecha)
        }));
    };

    /* ============ AUDIENCIAS (calendario de la carpeta, modo nube) ============ */
    window.audienciasListar = async (carpetaId) => {
        const { data, error } = await nube.from('audiencias')
            .select('id, carpeta_id, titulo, fecha, hora, enlace, descripcion, creado')
            .eq('carpeta_id', carpetaId)
            .order('fecha', { ascending: true });
        if (error) fallar(error);
        return (data || []).map(a => ({
            id: a.id, carpetaId: a.carpeta_id, titulo: a.titulo,
            fecha: a.fecha, hora: a.hora, enlace: a.enlace, creado: Date.parse(a.creado)
        }));
    };
    window.audienciaGuardar = async (carpetaId, datos) => {
        const ses = sesionNube();
        const { error } = await nube.from('audiencias').insert({
            carpeta_id: carpetaId,
            titulo: datos.titulo || '',
            fecha: datos.fecha,
            hora: datos.hora || '',
            enlace: datos.enlace || '',
            descripcion: datos.descripcion || '',
            creado_por: ses._id || null
        });
        if (error) fallar(error);
    };
    window.audienciaEliminar = async (id) => {
        const { error } = await nube.from('audiencias').delete().eq('id', id);
        if (error) fallar(error);
    };

    /* ============ RECORDATORIOS PERSONALES (modo nube) ============
       RLS garantiza que cada quien vea/edite SOLO los suyos. */
    const _mapRecordatorio = (r) => ({
        id: r.id, carpetaId: r.carpeta_id, mensaje: r.mensaje,
        fechaInicio: r.fecha_inicio, fechaFin: r.fecha_fin,
        carpetaNombre: (r.carpetas && r.carpetas.nombre) || ''
    });
    window.recordatoriosListar = async (carpetaId) => {
        const { data, error } = await nube.from('recordatorios')
            .select('id, carpeta_id, mensaje, fecha_inicio, fecha_fin')
            .eq('carpeta_id', carpetaId)
            .order('fecha_inicio', { ascending: true });
        if (error) fallar(error);
        return (data || []).map(_mapRecordatorio);
    };
    window.recordatorioGuardar = async (datos) => {
        const ses = sesionNube();
        if (datos.id) {
            const { error } = await nube.from('recordatorios').update({
                mensaje: datos.mensaje, fecha_inicio: datos.fechaInicio, fecha_fin: datos.fechaFin
            }).eq('id', datos.id);
            if (error) fallar(error);
            return;
        }
        const { error } = await nube.from('recordatorios').insert({
            perfil_id: ses._id, carpeta_id: datos.carpetaId,
            mensaje: datos.mensaje || '',
            fecha_inicio: datos.fechaInicio, fecha_fin: datos.fechaFin
        });
        if (error) fallar(error);
    };
    window.recordatorioEliminar = async (id) => {
        const { error } = await nube.from('recordatorios').delete().eq('id', id);
        if (error) fallar(error);
    };
    /* TODOS mis recordatorios (para el calendario general del operador);
       RLS ya limita a los propios. */
    window.recordatoriosMios = async () => {
        const { data, error } = await nube.from('recordatorios')
            .select('id, carpeta_id, mensaje, fecha_inicio, fecha_fin, carpetas(nombre)')
            .order('fecha_inicio', { ascending: true });
        if (error) fallar(error);
        return (data || []).map(_mapRecordatorio);
    };
    window.recordatoriosVigentes = async () => {
        const hoy = fechaISOLocal(new Date());
        const { data, error } = await nube.from('recordatorios')
            .select('id, carpeta_id, mensaje, fecha_inicio, fecha_fin, carpetas(nombre)')
            .lte('fecha_inicio', hoy)
            .gte('fecha_fin', hoy);
        if (error) fallar(error);
        return (data || []).map(_mapRecordatorio);
    };

    /* Asignados de la carpeta con su correo (para notificar audiencias);
       el servidor valida que quien pregunta sea el personal de la carpeta. */
    window.asignadosDeCarpeta = async (carpetaId) => {
        const { data, error } = await nube.rpc('asignados_de_carpeta', { carpeta: carpetaId });
        if (error) fallar(error);
        return (data || []).map(p => ({
            id: p.id, usuario: p.usuario, nombre: p.nombre, rol: p.rol, correo: p.correo || ''
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

    /* ============ MENSAJERÍA DEL TRÁMITE (modo nube) ============
       RLS valida el canal: el cliente solo ve/escribe en 'cliente', el
       acreedor solo en 'acreedor'; operador responsable y admin, en ambos. */
    window.mensajesListar = async (carpetaId, canal) => {
        const { data, error } = await nube.from('mensajes')
            .select('id, perfil_id, destinatario_id, autor_usuario, autor_nombre, rol, texto, fecha, archivo_nombre, archivo_tamano')
            .eq('carpeta_id', carpetaId)
            .eq('canal', canal)
            .order('fecha', { ascending: true })
            .limit(500);
        if (error) fallar(error);
        return (data || []).map(m => ({
            id: m.id,
            perfilId: m.perfil_id || null,
            destinatarioId: m.destinatario_id || null,
            autorUsuario: m.autor_usuario, autorNombre: m.autor_nombre,
            rol: m.rol, texto: m.texto, fecha: Date.parse(m.fecha),
            archivoNombre: m.archivo_nombre || '', archivoTamano: m.archivo_tamano || 0
        }));
    };
    /* destinatarioId (opcional, solo personal en canal 'acreedor'):
       uuid del acreedor al que va dirigido; null = para todos */
    window.mensajesGuardar = async (carpetaId, canal, texto, archivo, destinatarioId) => {
        const ses = sesionNube();
        // Adjunto opcional: primero sube el archivo a Storage bajo
        // 'chat/<carpeta>/<canal>/...' (RLS puede_chat valida el canal) y
        // luego inserta el mensaje con sus metadatos.
        let ruta = '', nombre = '', tamano = 0, tipo = '';
        if (archivo) {
            ruta = 'chat/' + carpetaId + '/' + canal + '/' + Date.now() + '_' + limpiarNombre(archivo.name);
            const { error: errorSube } = await nube.storage.from('documentos')
                .upload(ruta, archivo, { contentType: archivo.type || 'application/octet-stream' });
            if (errorSube) fallar(errorSube);
            nombre = archivo.name; tamano = archivo.size; tipo = archivo.type || '';
        }
        const { error } = await nube.from('mensajes').insert({
            carpeta_id: carpetaId, canal, perfil_id: ses._id || null,
            destinatario_id: destinatarioId || null,
            autor_usuario: ses.usuario || '', autor_nombre: ses.nombre || ses.usuario || '',
            rol: ses.rol || '', texto: texto || '',
            archivo_nombre: nombre, archivo_ruta: ruta,
            archivo_tamano: tamano, archivo_tipo: tipo
        });
        if (error) fallar(error);
    };

    /* Adjunto de un mensaje de chat: se busca la ruta por id (RLS deja ver
       solo mensajes de canales propios) y se descarga desde Storage. */
    window.descargarAdjuntoChat = async (mensajeId) => {
        const { data, error } = await nube.from('mensajes')
            .select('archivo_ruta, archivo_nombre')
            .eq('id', mensajeId).maybeSingle();
        if (error) fallar(error);
        if (!data || !data.archivo_ruta) throw new Error('El mensaje no tiene adjunto.');
        const { data: blob, error: errorBlob } = await nube.storage
            .from('documentos').download(data.archivo_ruta);
        if (errorBlob) fallar(errorBlob);
        return { nombre: data.archivo_nombre, blob };
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

    /* ============================================================
       >>> SIN USO — REVISAR Y ELIMINAR MANUALMENTE <<<
       El timeline de 9 etapas se reemplazó por los procesos con
       semáforo: ya NADIE llama actualizarEstadoProceso (ni la RPC
       actualizar_estado_proceso del esquema).
       ============================================================ */
    window.actualizarEstadoProceso = async (carpetaId, estado) => {
        const { error } = await nube.rpc('actualizar_estado_proceso', {
            carpeta: carpetaId,
            nuevo_estado: estado
        });
        if (error) fallar(error);
    };
    /* >>> FIN SIN USO <<< */

    /* ============================================================
       >>> SIN USO — REVISAR Y ELIMINAR MANUALMENTE <<<
       La pestaña "Deudor" se eliminó de la interfaz: ya NADIE llama
       cargarInfoDeudor / guardarInfoDeudor. (La tabla deudores_info
       y sus políticas RLS se conservan a propósito en Supabase.)
       ============================================================ */
    window.cargarInfoDeudor = async (carpetaId) => {
        const { data, error } = await nube.from('deudores_info')
            .select('*').eq('carpeta_id', carpetaId).maybeSingle();
        if (error) fallar(error);
        if (!data) return null;
        return {
            nombre: data.nombre, cedula: data.cedula, actividad: data.actividad,
            empleador: data.empleador, estadoCivil: data.estado_civil, correo: data.correo,
            apoderadoNombre: data.apoderado_nombre, apoderadoCedula: data.apoderado_cedula,
            apoderadoTp: data.apoderado_tp, apoderadoCorreo: data.apoderado_correo,
            actualizado: Date.parse(data.actualizado)
        };
    };
    window.guardarInfoDeudor = async (carpetaId, datos) => {
        const { error } = await nube.from('deudores_info').upsert({
            carpeta_id: carpetaId,
            nombre: datos.nombre || '', cedula: datos.cedula || '',
            actividad: datos.actividad || '', empleador: datos.empleador || '',
            estado_civil: datos.estadoCivil || '', correo: datos.correo || '',
            apoderado_nombre: datos.apoderadoNombre || '', apoderado_cedula: datos.apoderadoCedula || '',
            apoderado_tp: datos.apoderadoTp || '', apoderado_correo: datos.apoderadoCorreo || ''
            // 'actualizado' lo fija el servidor (trigger deudores_tocar_actualizado)
        }, { onConflict: 'carpeta_id' });
        if (error) fallar(error);
    };
    /* >>> FIN SIN USO <<< */

    /* Crear usuario: llama a la Edge Function "crear-usuario" (la clave
       service_role vive SOLO en el servidor, que verifica que quien llama
       sea un administrador activo). Así el registro público de Supabase
       ("Allow new users to sign up") puede quedar APAGADO: nadie de
       internet puede crearse una cuenta. */
    window.crearUsuarioDatos = async (usuario, nombre, rol, clave, correo) => {
        const { data, error } = await nube.functions.invoke('crear-usuario', {
            body: { usuario, nombre, rol, clave, correo, dominio: cfg.DOMINIO_USUARIOS }
        });
        if (error) {
            let detalle = '';
            try { const r = await error.context.json(); detalle = r && r.error; } catch (_) { /* sin cuerpo */ }
            throw new Error(detalle ||
                'No se pudo crear el usuario. Verifica que la Edge Function "crear-usuario" esté desplegada (ver portal/supabase/INSTRUCCIONES.md).');
        }
        if (data && data.error) throw new Error(data.error);
        return '';
    };

    /* Restablecer la contraseña de OTRO usuario: el navegador no puede hacerlo
       con la clave pública (sería inseguro), así que llama a la Edge Function
       "restablecer-clave", que usa la clave service_role SOLO en el servidor y
       verifica que quien llama sea administrador. */
    window.restablecerClave = async (usuario, nuevaClave) => {
        if (sesionNube().rol !== 'administrador') {
            throw new Error('Solo el administrador puede restablecer contraseñas.');
        }
        if (!usuario || !usuario._id) throw new Error('No se encontró el identificador del usuario.');
        const { data, error } = await nube.functions.invoke('restablecer-clave', {
            body: { user_id: usuario._id, password: nuevaClave }
        });
        if (error) {
            let detalle = '';
            try { const r = await error.context.json(); detalle = r && r.error; } catch (_) { /* sin cuerpo */ }
            throw new Error(detalle ||
                'No se pudo restablecer la contraseña. Verifica que la Edge Function "restablecer-clave" esté desplegada (ver portal/supabase/INSTRUCCIONES.md).');
        }
        if (data && data.error) throw new Error(data.error);
    };

    /* ============ SEMÁFOROS: PROCESOS DEL TRÁMITE (modo nube) ============
       El COLOR del semáforo y los días hábiles restantes vienen YA calculados
       del servidor (función listar_procesos → calcular_semaforo): el navegador
       solo pinta. Toda ESCRITURA pasa por funciones del servidor que validan
       permisos y plazos (no hay update directo). */
    const _mapProceso = (p) => ({
        id: p.id, carpetaId: p.carpeta_id, nombre: p.nombre,
        dias: p.dias_habiles_limite, orden: p.orden,
        completado: p.completado,
        fechaInicio: p.fecha_inicio_proceso,
        fechaInicioHabil: p.fecha_inicio_proceso_habil,
        fechaVencimiento: p.fecha_vencimiento_habil,
        fechaCompletado: p.fecha_completado,
        pausado: p.pausado,
        diasRestantesAlPausar: p.dias_restantes_al_pausar,
        semaforoManual: p.semaforo_manual || null,
        semaforo: p.semaforo,                 // color calculado en el servidor
        diasRestantes: (p.dias_restantes === null || p.dias_restantes === undefined) ? null : p.dias_restantes,
        creado: Date.parse(p.creado)
    });
    window.procesosListar = async (carpetaId) => {
        const { data, error } = await nube.rpc('listar_procesos', { carpeta: carpetaId });
        if (error) fallar(error);
        return (data || []).map(_mapProceso);
    };
    window.procesosTodos = async () => {
        const { data, error } = await nube.rpc('listar_procesos', { carpeta: null });
        if (error) fallar(error);
        return (data || []).map(_mapProceso);
    };
    window.procesoCrear = async (carpetaId, datos) => {
        const { data, error } = await nube.rpc('crear_proceso_tramite', {
            carpeta: carpetaId, p_nombre: datos.nombre,
            p_dias: datos.dias, p_orden: datos.orden || null
        });
        if (error) fallar(error);
        return data;
    };
    window.procesoCompletar = async (procesoId) => {
        const { error } = await nube.rpc('completar_proceso', { proceso: procesoId });
        if (error) fallar(error);
    };
    window.procesoEliminar = async (procesoId) => {
        const { error } = await nube.rpc('eliminar_proceso', { proceso: procesoId });
        if (error) fallar(error);
    };
    window.tramitePausar = async (carpetaId) => {
        const { error } = await nube.rpc('pausar_tramite', { carpeta: carpetaId });
        if (error) fallar(error);
    };
    window.tramiteReactivar = async (carpetaId) => {
        const { error } = await nube.rpc('reactivar_tramite', { carpeta: carpetaId });
        if (error) fallar(error);
    };
    /* Conteo del trámite completo: 60 días hábiles (90 con prórroga) */
    window.tramiteIniciar = async (carpetaId, fecha) => {
        const { error } = await nube.rpc('iniciar_tramite', {
            carpeta: carpetaId, p_fecha: fecha || null
        });
        if (error) fallar(error);
    };
    window.tramiteProrroga = async (carpetaId) => {
        const { error } = await nube.rpc('aplicar_prorroga', { carpeta: carpetaId });
        if (error) fallar(error);
    };
    /* Fin de trámite: SOLO administrador (validado en el servidor) */
    window.tramiteFinalizar = async (carpetaId) => {
        const { error } = await nube.rpc('finalizar_tramite', { carpeta: carpetaId });
        if (error) fallar(error);
    };

    /* ============ PRESENCIA Y ÚLTIMA CONEXIÓN (modo nube) ============ */
    window.registrarConexion = async () => {
        try { await nube.rpc('registrar_conexion'); } catch (e) { /* no rompe nada */ }
    };
    /* Presencia en tiempo real: alCambiar(setDeUsuariosEnLinea) cada vez que
       alguien entra o sale. Cada sesión anuncia su propio usuario. */
    window.presenciaIniciar = (alCambiar) => {
        const ses = sesionNube();
        if (!ses.usuario) return null;
        try {
            const canal = nube.channel('portal-presencia', {
                config: { presence: { key: ses.usuario } }
            });
            const avisar = () => {
                const estado = canal.presenceState();
                alCambiar(new Set(Object.keys(estado)));
            };
            canal.on('presence', { event: 'sync' }, avisar)
                 .on('presence', { event: 'join' }, avisar)
                 .on('presence', { event: 'leave' }, avisar)
                 .subscribe(async (st) => {
                     if (st === 'SUBSCRIBED') await canal.track({ en: Date.now() });
                 });
            return canal;
        } catch (e) { return null; }
    };
    /* Corrección del administrador: en 'cambios' van solo los campos a tocar
       (nombre, dias, vencimiento 'AAAA-MM-DD', completado, semaforo — '' = automático) */
    window.procesoEditarAdmin = async (procesoId, cambios) => {
        const { error } = await nube.rpc('editar_proceso_admin', {
            proceso: procesoId,
            p_nombre: cambios.nombre ?? null,
            p_dias: cambios.dias ?? null,
            p_vencimiento: cambios.vencimiento ?? null,
            p_completado: (typeof cambios.completado === 'boolean') ? cambios.completado : null,
            p_semaforo: cambios.semaforo ?? null
        });
        if (error) fallar(error);
    };

    /* ============ CHAT DE SOPORTE (admin ↔ operador, modo nube) ============
       Un hilo por operador; cualquier administrador lo atiende. RLS valida
       todo en el servidor (puede_soporte). */
    window.soporteOperadores = async () => {
        const { data, error } = await nube.from('perfiles')
            .select('id, usuario, nombre, rol, activo')
            .eq('rol', 'operador').eq('activo', true)
            .order('nombre');
        if (error) fallar(error);
        return (data || []).map(p => ({ _id: p.id, usuario: p.usuario, nombre: p.nombre }));
    };
    window.soporteMensajes = async (operadorId) => {
        const { data, error } = await nube.from('mensajes_soporte')
            .select('id, operador_id, autor_id, autor_nombre, rol, texto, leido, fecha, archivo_nombre, archivo_tamano')
            .eq('operador_id', operadorId)
            .order('fecha', { ascending: true })
            .limit(500);
        if (error) fallar(error);
        return (data || []).map(m => ({
            id: m.id, operadorId: m.operador_id, autorId: m.autor_id,
            autorNombre: m.autor_nombre, rol: m.rol, texto: m.texto,
            leido: m.leido, fecha: Date.parse(m.fecha),
            archivoNombre: m.archivo_nombre || '', archivoTamano: m.archivo_tamano || 0
        }));
    };
    /* Adjunto opcional: el contenido va a Storage bajo 'soporte/<operador>/...'
       (RLS puede_soporte valida el hilo); aquí solo los metadatos. */
    window.soporteEnviar = async (operadorId, texto, archivo) => {
        const ses = sesionNube();
        let ruta = '', nombre = '', tamano = 0, tipo = '';
        if (archivo) {
            ruta = 'soporte/' + operadorId + '/' + Date.now() + '_' + limpiarNombre(archivo.name);
            const { error: errorSube } = await nube.storage.from('documentos')
                .upload(ruta, archivo, { contentType: archivo.type || 'application/octet-stream' });
            if (errorSube) fallar(errorSube);
            nombre = archivo.name; tamano = archivo.size; tipo = archivo.type || '';
        }
        const { error } = await nube.from('mensajes_soporte').insert({
            operador_id: operadorId, autor_id: ses._id,
            autor_nombre: ses.nombre || ses.usuario || '',
            rol: ses.rol || '', texto: texto || '',
            archivo_nombre: nombre, archivo_ruta: ruta,
            archivo_tamano: tamano, archivo_tipo: tipo
        });
        if (error) fallar(error);
    };
    /* Descarga el adjunto de un mensaje de soporte (RLS valida el hilo) */
    window.descargarAdjuntoSoporte = async (mensajeId) => {
        const { data, error } = await nube.from('mensajes_soporte')
            .select('archivo_ruta, archivo_nombre').eq('id', mensajeId).maybeSingle();
        if (error) fallar(error);
        if (!data || !data.archivo_ruta) throw new Error('El mensaje no tiene adjunto.');
        const { data: blob, error: errorBlob } = await nube.storage
            .from('documentos').download(data.archivo_ruta);
        if (errorBlob) fallar(errorBlob);
        return { nombre: data.archivo_nombre, blob };
    };
    window.marcarLeidosSoporte = async (operadorId) => {
        const { error } = await nube.rpc('marcar_leidos_soporte', { operador: operadorId });
        if (error) fallar(error);
    };
    window.marcarLeidosCanal = async (carpetaId, canal) => {
        const { error } = await nube.rpc('marcar_leidos_de_canal', { carpeta: carpetaId, canal_chat: canal });
        if (error) fallar(error);
    };
    window.chatsNoLeidos = async () => {
        const { data, error } = await nube.rpc('no_leidos_chats');
        if (error) fallar(error);
        return (data || []).map(f => ({ carpetaId: f.carpeta_id, canal: f.canal, noLeidos: Number(f.no_leidos) }));
    };
    window.soporteNoLeidos = async () => {
        const { data, error } = await nube.rpc('no_leidos_soporte');
        if (error) fallar(error);
        return (data || []).map(f => ({ operadorId: f.operador_id, noLeidos: Number(f.no_leidos) }));
    };

    /* Tiempo real: avisa cuando entra un mensaje nuevo (de carpeta o de
       soporte). Realtime respeta la RLS: cada quien recibe solo lo suyo. */
    window.suscribirMensajesNuevos = (alLlegar) => {
        try {
            return nube.channel('portal-mensajes')
                .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'mensajes' },
                    (x) => alLlegar('carpeta', x.new))
                .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'mensajes_soporte' },
                    (x) => alLlegar('soporte', x.new))
                .subscribe();
        } catch (e) { return null; }
    };

    /* ============ LLAMADAS DE SOPORTE (WebRTC, modo nube) ============
       SOLO el administrador puede crear la llamada (la RLS lo exige en el
       servidor). La señalización viaja por un canal Realtime broadcast. */
    window.llamadaCrear = async (destinoId) => {
        const ses = sesionNube();
        const { data, error } = await nube.from('llamadas_soporte').insert({
            iniciador: ses._id, destino: destinoId
        }).select('id').single();
        if (error) fallar(error);
        return data.id;
    };
    window.llamadaActualizar = async (llamadaId, estado) => {
        const { error } = await nube.from('llamadas_soporte')
            .update({ estado }).eq('id', llamadaId);
        if (error) fallar(error);
    };
    window.suscribirLlamadasEntrantes = (alSonar) => {
        const ses = sesionNube();
        if (!ses._id) return null;
        try {
            return nube.channel('portal-llamadas')
                .on('postgres_changes', {
                    event: 'INSERT', schema: 'public', table: 'llamadas_soporte',
                    filter: 'destino=eq.' + ses._id
                }, (x) => alSonar(x.new))
                .subscribe();
        } catch (e) { return null; }
    };
    /* Canal de señalización WebRTC de UNA llamada (broadcast efímero) */
    window.canalSenalizacion = (llamadaId, alRecibir) => {
        const canal = nube.channel('llamada-' + llamadaId, { config: { broadcast: { self: false } } });
        canal.on('broadcast', { event: 'sdp' }, (m) => alRecibir(m.payload)).subscribe();
        return {
            enviar: (payload) => canal.send({ type: 'broadcast', event: 'sdp', payload }),
            cerrar: () => { try { nube.removeChannel(canal); } catch (e) {} }
        };
    };

    /* ============ NOTIFICACIONES (campana, modo nube) ============
       RLS: cada quien lee y marca SOLO las suyas. */
    window.notificacionesListar = async () => {
        const { data, error } = await nube.from('notificaciones')
            .select('id, tipo, mensaje, carpeta_id, referencia_id, leido, fecha')
            .order('fecha', { ascending: false })
            .limit(50);
        if (error) fallar(error);
        return (data || []).map(n => ({
            id: n.id, tipo: n.tipo, mensaje: n.mensaje,
            carpetaId: n.carpeta_id, referenciaId: n.referencia_id,
            leido: n.leido, fecha: Date.parse(n.fecha)
        }));
    };
    window.notificacionesMarcarLeidas = async (ids) => {
        const { error } = await nube.rpc('marcar_notificaciones_leidas', { ids: ids || null });
        if (error) fallar(error);
    };
    /* Elimina UNA notificación propia (RLS: destinatario_id = auth.uid()) */
    window.notificacionEliminar = async (id) => {
        const { error } = await nube.from('notificaciones').delete().eq('id', id);
        if (error) fallar(error);
    };
    /* Solo el admin: genera (una vez por proceso) los avisos de vencidos */
    window.notificacionesGenerarVencidos = async () => {
        const { error } = await nube.rpc('generar_notificaciones_vencidos');
        if (error) fallar(error);
    };
    /* Aviso de ingreso propio en la campana (solo admins; el servidor decide) */
    window.notificarMiIngreso = async () => {
        try { await nube.rpc('notificar_mi_ingreso'); } catch (e) { /* no rompe el ingreso */ }
    };
    /* Olvidé mi contraseña: cualquiera (incluso sin sesión) deja la solicitud;
       el servidor valida en silencio y avisa a los administradores. */
    window.solicitarRestablecimiento = async (usuario) => {
        const { error } = await nube.rpc('solicitar_restablecimiento', { p_usuario: usuario });
        if (error) fallar(error);
    };
    /* Solicitudes pendientes (solo las ve el admin, por RLS) */
    window.solicitudesClaveListar = async () => {
        const { data, error } = await nube.from('solicitudes_clave')
            .select('id, usuario, estado, fecha')
            .eq('estado', 'pendiente')
            .order('fecha', { ascending: false });
        if (error) fallar(error);
        return (data || []).map(s => ({ id: s.id, usuario: s.usuario, fecha: Date.parse(s.fecha) }));
    };
    window.solicitudClaveResolver = async (id) => {
        const { error } = await nube.rpc('resolver_solicitud_clave', { solicitud: id });
        if (error) fallar(error);
    };
    window.suscribirNotificaciones = (alLlegar) => {
        const ses = sesionNube();
        if (!ses._id) return null;
        try {
            return nube.channel('portal-notificaciones')
                .on('postgres_changes', {
                    event: 'INSERT', schema: 'public', table: 'notificaciones',
                    filter: 'destinatario_id=eq.' + ses._id
                }, (x) => alLlegar(x.new))
                .subscribe();
        } catch (e) { return null; }
    };

    /* ============ CONSENTIMIENTO DE DATOS (modo nube) ============ */
    window.perfilPropio = async () => {
        const ses = sesionNube();
        if (!ses._id) return null;
        const { data, error } = await nube.from('perfiles')
            .select('usuario, nombre, rol, primer_login').eq('id', ses._id).maybeSingle();
        if (error) fallar(error);
        return data ? {
            usuario: data.usuario, nombre: data.nombre, rol: data.rol,
            primerLogin: data.primer_login !== false
        } : null;
    };
    window.consentimientoAceptar = async (version) => {
        const { error } = await nube.rpc('aceptar_consentimiento', { p_version: version || '1.0' });
        if (error) fallar(error);
    };
    window.consentimientosListar = async () => {
        const { data, error } = await nube.rpc('listar_consentimientos');
        if (error) fallar(error);
        return (data || []).map(c => ({
            usuario: c.usuario, nombre: c.nombre, rol: c.rol,
            fecha: Date.parse(c.fecha_aceptacion), version: c.version_politica
        }));
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
