-- ============================================================
-- MIGRACIÓN: endurecimiento tras la auditoría de septiembre 2026
-- ============================================================
-- Idempotente: se puede correr varias veces sin romper nada.
--
-- QUÉ ENCONTRÓ LA AUDITORÍA
--   46 funciones SECURITY DEFINER del portal se podían ejecutar SIN
--   iniciar sesión, vía /rest/v1/rpc/<nombre>. Ninguna hacía daño,
--   porque todas revisan permisos por dentro y con anon auth.uid() es
--   null, pero dejarlas expuestas significa que el día que a una se le
--   olvide la guardia, el agujero ya está abierto al público.
--
-- LA TRAMPA DE PUBLIC
--   `revoke execute ... from anon` no hace NADA por sí solo. El permiso
--   no viene del rol anon: viene de PUBLIC, el pseudo-rol al que
--   Postgres concede EXECUTE automáticamente en toda función nueva. Hay
--   que revocar de `public` Y de `anon`.
--
-- Y EL PELIGRO DE PASARSE
--   Las políticas RLS se evalúan con los privilegios de QUIEN CONSULTA,
--   no del dueño de la tabla. Si al revocar de PUBLIC se deja sin
--   EXECUTE a `authenticated` sobre puede_ver_carpeta(), TODOS los
--   usuarios dejan de ver sus carpetas. Por eso después de revocar hay
--   que volver a conceder a authenticated de forma explícita.
--   (Ya nos pasó una vez con puede_ver_notaria.)
-- ============================================================


-- ------------------------------------------------------------
-- 1) Cerrar el acceso anónimo, sin romper el de los usuarios
-- ------------------------------------------------------------
do $$
declare
    f record;
    -- Solo las llama la tarea programada, nadie por HTTP
    internas constant text[] := array[
        'cron_plazos_diario', 'avisar_plazos_tramite',
        'destinatarios_de_carpeta', 'perfil_alcanza_notaria'
    ];
begin
    for f in
        select p.oid::regprocedure as firma, p.proname as nombre
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.prosecdef
    loop
        execute format('revoke execute on function %s from public, anon', f.firma);

        if f.nombre = any(internas) then
            execute format('revoke execute on function %s from authenticated', f.firma);
        elsif f.nombre = 'solicitar_restablecimiento' then
            -- Anónima POR DISEÑO: quien olvidó la clave no ha entrado
            execute format('grant execute on function %s to anon, authenticated', f.firma);
        else
            execute format('grant execute on function %s to authenticated', f.firma);
        end if;
    end loop;
end $$;


-- ------------------------------------------------------------
-- 2) Índices que faltaban en claves foráneas
-- ------------------------------------------------------------
-- El índice de notificaciones empieza por destinatario_id, así que no
-- cubre una búsqueda por notaría sola: por ejemplo al borrar una
-- notaría, que arrastra sus avisos en cascada.
create index if not exists idx_notificaciones_notaria
    on public.notificaciones (notaria_id);
create index if not exists idx_perfil_notarias_notaria
    on public.perfil_notarias (notaria_id);


-- ------------------------------------------------------------
-- 3) El límite de tamaño, igual en los tres sitios
-- ------------------------------------------------------------
-- Producción tenía 100 MB y esquema.sql decía 50 MB: se habían
-- separado. El cliente corta en 50 (TAMANO_MAXIMO en app.js), así que
-- 50 es lo que los usuarios viven hoy y no cambia nada para ellos.
-- Para subirlo hay que tocar TRES sitios: este número, TAMANO_MAXIMO
-- en app.js, y FILE_SIZE_LIMIT del .env en el servidor autohospedado.
update storage.buckets set file_size_limit = 52428800 where id = 'documentos';


-- ------------------------------------------------------------
-- 4) Límite de solicitudes de clave, por usuario y no solo global
-- ------------------------------------------------------------
-- Antes: 10 cada 15 minutos EN TOTAL. Diez peticiones bastaban para
-- dejar sin restablecimiento a toda la notaría durante ese rato: una
-- denegación de servicio que cuesta diez clics.
-- Ahora: 3 por usuario y 40 en total. Corta el abuso sin que una
-- persona pueda bloquear a las demás.
create or replace function public.solicitar_restablecimiento(p_usuario text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    u text := lower(trim(coalesce(p_usuario, '')));
    recientes int;
    suyas int;
    TOPE_GLOBAL   constant int := 40;
    TOPE_USUARIO  constant int := 3;
    VENTANA       constant interval := interval '15 minutes';
begin
    if u = '' or length(u) > 30 then return; end if;

    select count(*) into recientes
      from public.solicitudes_clave
     where fecha > now() - VENTANA;
    if recientes >= TOPE_GLOBAL then return; end if;

    select count(*) into suyas
      from public.solicitudes_clave
     where usuario = u and fecha > now() - VENTANA;
    if suyas >= TOPE_USUARIO then return; end if;

    -- Se responde igual exista o no el usuario: lo contrario revelaría
    -- quién tiene cuenta en el portal
    if not exists (select 1 from public.perfiles where usuario = u and activo) then return; end if;
    if exists (select 1 from public.solicitudes_clave where usuario = u and estado = 'pendiente') then return; end if;

    insert into public.solicitudes_clave (usuario) values (u);
    perform public._notificar_admins('solicitud-clave',
        'El usuario «' || u || '» olvidó su contraseña y solicita restablecerla', null, null);
end;
$$;

revoke execute on function public.solicitar_restablecimiento(text) from public;
grant execute on function public.solicitar_restablecimiento(text) to anon, authenticated;


-- ------------------------------------------------------------
-- 5) Comprobación: nadie debería haber perdido acceso
-- ------------------------------------------------------------
-- Simula la sesión de cada usuario activo y cuenta lo que ve. Si al
-- correr esta migración en un servidor nuevo alguna fila dice ERROR,
-- falta un grant y hay que resolverlo ANTES de dejar entrar a nadie.
do $$
declare
    u record; n_c int; n_a int; r text := ''; fallo boolean := false;
begin
    for u in select id, usuario, rol from public.perfiles where activo order by rol, usuario loop
        perform set_config('request.jwt.claims',
                 json_build_object('sub', u.id::text, 'role', 'authenticated')::text, true);
        perform set_config('role', 'authenticated', true);
        begin
            select count(*) into n_c from public.carpetas;
            select count(*) into n_a from public.archivos;
            r := r || format('%s/%s:%s/%s ', u.rol, u.usuario, n_c, n_a);
        exception when others then
            fallo := true;
            r := r || format('%s/%s ERROR:%s ', u.rol, u.usuario, SQLERRM);
        end;
        perform set_config('role', 'postgres', true);
    end loop;

    if fallo then
        raise exception 'HAY USUARIOS SIN ACCESO: %', r;
    end if;
    raise notice 'Acceso verificado (rol/usuario:carpetas/archivos): %', r;
end $$;
