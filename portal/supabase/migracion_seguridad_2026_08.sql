-- ============================================================
-- CORRECCIONES DE SEGURIDAD Y SALUD — auditoría de 2026-08
-- ============================================================
-- Idempotente: se puede correr varias veces sin romper nada.
--
-- Este archivo NO depende de n8n. Recoge lo que salió de la
-- auditoría de ingreso, sesión, verificación de rol y límites
-- de uso, más el saneamiento de índices y search_path.
--
-- Contenido:
--   1) Quitar el permiso de ejecución de PUBLIC/anon en las
--      funciones internas (era el hueco más grave).
--   2) Impedir la suplantación de autor en chat_mensajes.
--   3) Límite de uso en "olvidé mi contraseña".
--   4) Índices en las claves foráneas.
--   5) search_path fijo en las utilidades.
-- ============================================================


-- ============================================================
-- 1) PERMISOS DE EJECUCIÓN
-- ============================================================
-- En PostgreSQL toda función nace con EXECUTE concedido a PUBLIC,
-- y Supabase además concede EXECUTE a anon y authenticated por
-- defecto en cada función nueva del esquema public. Un
-- "revoke ... from anon" NO basta: hay que revocar de los tres.
--
-- Sin esto, cualquiera SIN SESIÓN podía llamar por HTTP a
--   POST /rest/v1/rpc/_notificar
-- e insertar avisos falsos en la campana de cualquier usuario
-- del portal (vector de phishing con la apariencia del sitio).
--
-- Las funciones de trigger tampoco necesitan permiso: las
-- dispara PostgreSQL, que las ejecuta como su dueño.
do $$
declare
    f record;
    internas text[] := array[
        '_notificar', '_notificar_admins',
        'crear_perfil_nuevo', 'proteger_ultimo_admin',
        'fijar_autor_mensaje', 'fijar_autor_archivo', 'fijar_autor_chat',
        'notif_mensaje_nuevo', 'notif_archivo_nuevo', 'notif_soporte_nuevo',
        'notif_proceso_cambio', 'notif_carpeta_cambio', 'notif_fin_tramite',
        'actualizar_peso_carpeta', 'tocar_actualizado',
        'generar_notificaciones_vencidos', 'aplicar_desactivaciones_automaticas',
        'rls_auto_enable', 'archivo_descargable_partes'
    ];
begin
    for f in
        select p.oid::regprocedure as firma
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = any(internas)
    loop
        execute format('revoke execute on function %s from public, anon, authenticated', f.firma);
    end loop;
end $$;

-- Estas dos las invoca el portal desde la sesión del administrador
grant execute on function public.generar_notificaciones_vencidos() to authenticated;
grant execute on function public.aplicar_desactivaciones_automaticas() to authenticated;


-- ============================================================
-- 2) chat_mensajes: impedir que se falsifique el autor
-- ============================================================
-- La política de INSERT solo pedía puede_ver_carpeta(carpeta_id),
-- sin verificar quién dice ser el autor. Un cliente o un acreedor
-- podía insertar un mensaje con rol = 'administrador', el nombre
-- de la fundación y es_ia = true. En un expediente de insolvencia
-- eso es suplantación dentro de una pieza del proceso.
--
-- Mismo patrón que ya usa la tabla 'mensajes': el servidor
-- sobrescribe los campos de autoría con los datos reales.
create or replace function public.fijar_autor_chat()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
    p record;
begin
    -- auth.uid() es null cuando escribe un proceso del servidor:
    -- en ese caso se respeta lo enviado.
    if auth.uid() is null then return new; end if;

    select usuario, nombre, rol into p from public.perfiles where id = auth.uid();
    if not found then
        raise exception 'Sin perfil activo: no se puede escribir en el chat';
    end if;
    new.perfil_id      := auth.uid();
    new.autor_usuario  := p.usuario;
    new.autor_nombre   := p.nombre;
    new.rol            := p.rol;
    -- Un humano nunca puede marcar su mensaje como respuesta de la IA
    new.es_ia          := false;
    return new;
end;
$$;
revoke execute on function public.fijar_autor_chat() from public, anon, authenticated;

drop trigger if exists autor_chat on public.chat_mensajes;
create trigger autor_chat before insert on public.chat_mensajes
    for each row execute function public.fijar_autor_chat();

-- Y además en la política, para que quede en dos capas
drop policy if exists "escribir chat en la carpeta" on public.chat_mensajes;
create policy "escribir chat en la carpeta" on public.chat_mensajes
    for insert with check (
        public.puede_ver_carpeta(carpeta_id)
        and perfil_id = auth.uid()
    );


-- ============================================================
-- 3) LÍMITE DE USO en "olvidé mi contraseña"
-- ============================================================
-- solicitar_restablecimiento se llama SIN sesión (es su razón de
-- ser). Ya no repetía solicitudes del mismo usuario, pero nada
-- impedía recorrer una lista de nombres y llenar la campana del
-- administrador con cientos de avisos.
--
-- Se devuelve lo mismo pase lo que pase: no se revela si el
-- usuario existe, ni si se alcanzó el tope.
create or replace function public.solicitar_restablecimiento(p_usuario text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    u text := lower(trim(coalesce(p_usuario, '')));
    recientes int;
    TOPE_POR_VENTANA constant int := 10;   -- solicitudes nuevas
    VENTANA constant interval := interval '15 minutes';
begin
    if u = '' or length(u) > 30 then return; end if;

    -- Tope global: frena el recorrido de nombres de usuario
    select count(*) into recientes
    from public.solicitudes_clave
    where fecha > now() - VENTANA;
    if recientes >= TOPE_POR_VENTANA then return; end if;

    if not exists (select 1 from public.perfiles where usuario = u and activo) then return; end if;
    if exists (select 1 from public.solicitudes_clave where usuario = u and estado = 'pendiente') then return; end if;

    insert into public.solicitudes_clave (usuario) values (u);
    perform public._notificar_admins('solicitud-clave',
        'El usuario «' || u || '» olvidó su contraseña y solicita restablecerla', null, null);
end;
$$;

-- Esta sí debe poder llamarla quien no tiene sesión: es el
-- "olvidé mi contraseña" de la pantalla de ingreso.
grant execute on function public.solicitar_restablecimiento(text) to anon, authenticated;


-- ============================================================
-- 4) ÍNDICES EN LAS CLAVES FORÁNEAS
-- ============================================================
-- Una clave foránea sin índice obliga a recorrer la tabla entera
-- cada vez que se borra o actualiza la fila referenciada. Con
-- 'on delete cascade' en casi todas, borrar una carpeta o un
-- perfil recorría varias tablas completas.
-- Crear índices no cambia ningún comportamiento: solo acelera.
create index if not exists idx_actividad_perfil          on public.actividad (perfil_id);
create index if not exists idx_archivos_subido_por       on public.archivos (subido_por);
create index if not exists idx_audiencias_creado_por     on public.audiencias (creado_por);
create index if not exists idx_carpetas_creada_por       on public.carpetas (creada_por);
create index if not exists idx_chat_mensajes_perfil      on public.chat_mensajes (perfil_id);
create index if not exists idx_hoja_trabajo_actualizado  on public.hoja_trabajo (actualizado_por);
create index if not exists idx_llamadas_iniciador        on public.llamadas_soporte (iniciador);
create index if not exists idx_mensajes_destinatario     on public.mensajes (destinatario_id);
create index if not exists idx_mensajes_perfil           on public.mensajes (perfil_id);
create index if not exists idx_soporte_autor             on public.mensajes_soporte (autor_id);
create index if not exists idx_notificaciones_carpeta    on public.notificaciones (carpeta_id);
create index if not exists idx_procesos_completado_por   on public.procesos_tramite (completado_por);
create index if not exists idx_procesos_creado_por       on public.procesos_tramite (creado_por);
create index if not exists idx_procesos_editado_por      on public.procesos_tramite (editado_por);
create index if not exists idx_recordatorios_carpeta     on public.recordatorios (carpeta_id);
create index if not exists idx_solicitudes_resuelta_por  on public.solicitudes_clave (resuelta_por);


-- ============================================================
-- 5) search_path FIJO EN LAS UTILIDADES
-- ============================================================
-- Sin 'set search_path', el camino de búsqueda lo decide quien
-- llama. Las cuatro primeras se usan DENTRO de las reglas de
-- Storage (deciden a qué carpeta pertenece un archivo), así que
-- su comportamiento no debe depender de la sesión que las invoca.
-- Solo usan funciones nativas: fijar el camino no cambia lo que
-- devuelven.
create or replace function public.carpeta_de_ruta(ruta text)
returns bigint language plpgsql immutable set search_path = pg_catalog, public
as $$
begin
    return ((string_to_array(ruta, '/'))[1])::bigint;
exception when others then
    return null;
end;
$$;

create or replace function public.chat_carpeta_de_ruta(ruta text)
returns bigint language plpgsql immutable set search_path = pg_catalog, public
as $$
begin
    return (split_part(ruta, '/', 2))::bigint;
exception when others then
    return null;
end;
$$;

create or replace function public.chat_canal_de_ruta(ruta text)
returns text language plpgsql immutable set search_path = pg_catalog, public
as $$
begin
    return split_part(ruta, '/', 3);
exception when others then
    return null;
end;
$$;

create or replace function public.soporte_operador_de_ruta(ruta text)
returns uuid language plpgsql immutable set search_path = pg_catalog, public
as $$
begin
    return (split_part(ruta, '/', 2))::uuid;
exception when others then return null;
end;
$$;

create or replace function public.dias_gracia_cierre()
returns int language sql immutable set search_path = pg_catalog, public
as $$ select 30 $$;

create or replace function public.tocar_actualizado()
returns trigger language plpgsql set search_path = pg_catalog, public
as $$
begin
    new.actualizado := now();
    return new;
end;
$$;
revoke execute on function public.tocar_actualizado() from public, anon, authenticated;


-- ============================================================
-- PENDIENTE (no se aplica aquí)
-- ============================================================
-- a) Activar "Leaked Password Protection" en el panel de Supabase
--    (Authentication → Policies). Es un interruptor, no código.
--
-- b) 21 políticas RLS re-evalúan auth.uid() por fila. La receta de
--    Supabase es envolverlo en (select auth.uid()). Da mejora real
--    A ESCALA, pero implica reescribir 21 reglas de control de
--    acceso a mano, y un error ahí no da un fallo visible: abre un
--    permiso. Hacerlo con pruebas de acceso por rol, no de corrido.
--
-- c) El bucket 'documentos' acepta cualquier tipo de archivo
--    (allowed_mime_types = null). La lista blanca vive solo en el
--    navegador. Fijarla en el servidor requiere revisar antes que
--    ningún archivo ya subido quede fuera.
