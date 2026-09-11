-- ============================================================
-- LIMPIEZA: deja el portal como recién instalado
-- ============================================================
-- NO es una migración: es una herramienta de puesta a punto. Se corre
-- a mano, cuando se quiere entregar el portal vacío a una notaría
-- nueva o empezar de cero tras las pruebas.
--
-- QUÉ CONSERVA
--   Los administradores y los 124 festivos colombianos. Nada más.
--
-- QUÉ BORRA
--   Carpetas, procesos, archivos, subcarpetas, conversaciones (chat de
--   carpeta, chat interno y soporte), llamadas, notificaciones,
--   actividad, audiencias, recordatorios, consentimientos, solicitudes
--   de clave, notarías, y todos los usuarios que no son administradores.
--
-- ADVERTENCIA: esto no se puede deshacer. El paso 0 hace un respaldo
-- completo dentro de la misma base. No lo saltes.
--
-- LOS ARCHIVOS DEL BUCKET NO SE BORRAN AQUÍ
--   Supabase lo impide a propósito (storage.protect_delete) para que
--   nadie deje objetos huérfanos. Hay que vaciar el bucket desde el
--   panel (Storage → documentos → seleccionar todo → borrar) o por la
--   Storage API. Si no se hace, quedan los bytes ocupando espacio pero
--   invisibles para el portal, porque la tabla archivos ya está vacía.
-- ============================================================


-- ------------------------------------------------------------
-- 0) Respaldo. Cambia la fecha del esquema en cada uso.
-- ------------------------------------------------------------
create schema if not exists respaldo_20260911;

do $$
declare
    t text;
    tablas constant text[] := array[
        'notarias','carpetas','procesos_tramite','archivos','subcarpetas',
        'mensajes','chat_mensajes','mensajes_soporte','llamadas_soporte',
        'notificaciones','actividad','audiencias','recordatorios',
        'hoja_trabajo','deudores_info','consentimientos','solicitudes_clave',
        'perfil_notarias','carpeta_asignados','carpeta_operadores','perfiles'
    ];
begin
    foreach t in array tablas loop
        execute format(
            'drop table if exists respaldo_20260911.%I; create table respaldo_20260911.%I as select * from public.%I',
            t, t, t);
    end loop;
end $$;

-- Los usuarios de autenticación aparte: sin ellos los perfiles no se
-- pueden restaurar, porque perfiles.id referencia auth.users(id)
drop table if exists respaldo_20260911.auth_users;
create table respaldo_20260911.auth_users as select * from auth.users;

drop table if exists respaldo_20260911.storage_objects;
create table respaldo_20260911.storage_objects as
    select * from storage.objects where bucket_id = 'documentos';

revoke all on schema respaldo_20260911 from public, anon, authenticated;


-- ------------------------------------------------------------
-- 1) Contenido de las carpetas, de lo más hondo a lo más alto
-- ------------------------------------------------------------
delete from public.actividad;
delete from public.notificaciones;
delete from public.recordatorios;
delete from public.audiencias;
delete from public.hoja_trabajo;
delete from public.deudores_info;
delete from public.mensajes;
delete from public.chat_mensajes;
delete from public.archivos;
delete from public.subcarpetas;
delete from public.procesos_tramite;
delete from public.carpeta_asignados;
delete from public.carpeta_operadores;
delete from public.carpetas;


-- ------------------------------------------------------------
-- 2) Conversaciones de soporte, llamadas y solicitudes
-- ------------------------------------------------------------
delete from public.mensajes_soporte;
delete from public.llamadas_soporte;
delete from public.solicitudes_clave;
delete from public.consentimientos;
delete from public.perfil_notarias;


-- ------------------------------------------------------------
-- 3) Los usuarios que no son administradores
-- ------------------------------------------------------------
-- Se borran de auth.users, que arrastra el perfil en cascada. Borrar
-- solo el perfil dejaría la cuenta pudiendo autenticarse, y entraría a
-- un portal donde no tiene ficha.
--
-- El trigger proteger_ultimo_admin impide quedarse sin ninguno, así
-- que esto es seguro incluso si se ejecuta por error con un solo
-- administrador: fallaría antes de dejar el portal inaccesible.
delete from auth.users u
 where exists (select 1 from public.perfiles p
                where p.id = u.id and p.rol <> 'administrador')
    or not exists (select 1 from public.perfiles p where p.id = u.id);


-- ------------------------------------------------------------
-- 4) Las notarías
-- ------------------------------------------------------------
-- ORDEN IMPORTANTE: este update va DESPUÉS de borrar los usuarios. Al
-- revés, tocar un operador antiguo sin correo dispara la restricción
-- perfiles_correo_obligatorio y la limpieza entera se cae.
--
-- Un administrador sin notaría asignada es global, que es lo que
-- corresponde en un portal recién instalado.
update public.perfiles set notaria_id = null where rol = 'administrador';

delete from public.notarias;


-- ------------------------------------------------------------
-- 5) Los contadores vuelven a empezar en 1
-- ------------------------------------------------------------
-- Para que la primera carpeta del portal limpio sea la 1 y no la 5.
-- Solo las columnas que de verdad son de identidad: llamadas_soporte,
-- por ejemplo, no lo es, y un ALTER a ciegas se cae ahí.
do $$
declare c record;
begin
    for c in
        select table_name, column_name
          from information_schema.columns
         where table_schema = 'public'
           and is_identity = 'YES'
           and table_name <> 'festivos_colombia'
    loop
        execute format('alter table public.%I alter column %I restart with 1',
                       c.table_name, c.column_name);
    end loop;
end $$;


-- ------------------------------------------------------------
-- 6) Comprobar que los administradores siguen entrando
-- ------------------------------------------------------------
do $$
declare u record; n int; r text := ''; fallo boolean := false;
begin
    for u in select id, usuario, rol from public.perfiles order by usuario loop
        perform set_config('request.jwt.claims',
                 json_build_object('sub', u.id::text, 'role', 'authenticated')::text, true);
        perform set_config('role', 'authenticated', true);
        begin
            select count(*) into n from public.perfiles;
            r := r || format('%s(%s):ve %s perfiles ', u.usuario, u.rol, n);
        exception when others then
            fallo := true; r := r || format('%s ERROR:%s ', u.usuario, SQLERRM);
        end;
        perform set_config('role', 'postgres', true);
    end loop;

    if fallo then raise exception 'ADMINISTRADORES SIN ACCESO: %', r; end if;
    raise notice 'Limpieza correcta. %', r;
end $$;


-- ------------------------------------------------------------
-- 7) Cuando todo esté probado, el respaldo se tira
-- ------------------------------------------------------------
-- drop schema respaldo_20260911 cascade;
