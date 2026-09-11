-- ============================================================
-- MIGRACIÓN: las notificaciones no se mezclan entre notarías
-- ============================================================
-- Idempotente: se puede correr varias veces sin romper nada.
--
-- EL PROBLEMA
--   El reparto de notificaciones se escribió cuando había una sola
--   notaría, así que decía «a todos los administradores» sin más.
--   Con cuatro notarías, un administrador de Santa Marta recibía los
--   avisos de Medellín, Barranquilla y Bogotá. No es una fuga de datos
--   (la RLS de notificaciones siempre fue destinatario_id = auth.uid())
--   pero sí es ruido que hace inservible la campana: entre veinte avisos
--   ajenos se pierde el propio.
--
--   Cuatro sitios repartían sin filtrar:
--     _notificar_admins()                  pausa, prórroga, procesos
--     generar_notificaciones_vencidos()    procesos vencidos
--     cron_plazos_diario()                 procesos vencidos, tarea diaria
--     destinatarios_de_carpeta()           avisos del plazo del trámite
--
-- LA SOLUCIÓN, EN DOS CAPAS
--   1) REPARTO. Cada aviso va solo a quien alcanza esa notaría. Se
--      resuelve con perfil_alcanza_notaria().
--   2) VISTA. notificaciones gana la columna notaria_id, y la campana
--      del portal filtra por la notaría abierta. Así un administrador
--      con acceso a dos oficinas ve una campana por oficina en vez de
--      las dos revueltas.
--
-- EL ADMINISTRADOR GLOBAL
--   Un administrador SIN notaría asignada sigue recibiendo todo: es el
--   dueño del portal y así se comportaba antes. Uno CON notaría
--   asignada recibe solo la suya. La diferencia la marca tener o no
--   filas en perfil_notarias / perfiles.notaria_id, que es el mismo
--   criterio que ya usa notarias_del_usuario() para la seguridad.
-- ============================================================


-- ------------------------------------------------------------
-- 1) La columna de notaría en las notificaciones
-- ------------------------------------------------------------
-- Se guarda en la fila en vez de deducirla con un join contra carpetas
-- porque el cliente filtra por ella en cada refresco de la campana, y
-- porque hay avisos sin carpeta (soporte, ingreso, solicitud de clave)
-- que no pertenecen a ninguna oficina.
alter table public.notificaciones
    add column if not exists notaria_id bigint references public.notarias (id) on delete cascade;

-- El índice de la campana: mis avisos, de esta notaría, sin leer.
create index if not exists idx_notif_dest_notaria
    on public.notificaciones (destinatario_id, notaria_id, leido, fecha desc);

-- Las que ya existen: se deduce de su carpeta. Las que no tienen
-- carpeta se quedan en null a propósito y se ven siempre.
update public.notificaciones n
   set notaria_id = c.notaria_id
  from public.carpetas c
 where c.id = n.carpeta_id
   and n.notaria_id is null;


-- ------------------------------------------------------------
-- 2) ¿Este perfil alcanza esta notaría?
-- ------------------------------------------------------------
-- Sin notarías asignadas = administrador global, lo recibe todo.
-- Aviso sin notaría (soporte, ingreso) = lo recibe todo el mundo.
create or replace function public.perfil_alcanza_notaria(p_perfil uuid, p_notaria bigint)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select case
        when p_perfil is null then false
        when p_notaria is null then true
        when not exists (select 1 from public.notarias_de_perfil(p_perfil)) then true
        else p_notaria in (select public.notarias_de_perfil(p_perfil))
    end;
$$;

-- La llaman funciones internas, no el cliente.
do $$
declare f record;
begin
    for f in
        select p.oid::regprocedure as firma
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'perfil_alcanza_notaria'
    loop
        execute format('revoke execute on function %s from public, anon, authenticated', f.firma);
    end loop;
end $$;


-- ------------------------------------------------------------
-- 3) Al insertar el aviso, se sella la notaría
-- ------------------------------------------------------------
-- Un solo sitio la escribe, así que ninguna ruta se puede olvidar.
create or replace function public._notificar(destino uuid, p_tipo text, p_mensaje text,
                                             p_carpeta bigint default null,
                                             p_ref bigint default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    v_notaria bigint;
begin
    if destino is null then return; end if;
    if p_carpeta is not null then
        select notaria_id into v_notaria from public.carpetas where id = p_carpeta;
    end if;
    insert into public.notificaciones (destinatario_id, tipo, mensaje, carpeta_id,
                                       referencia_id, notaria_id)
    values (destino, left(coalesce(p_tipo, ''), 40), left(coalesce(p_mensaje, ''), 300),
            p_carpeta, p_ref, v_notaria);
end;
$$;


-- ------------------------------------------------------------
-- 4) A los administradores, solo los de esa notaría
-- ------------------------------------------------------------
create or replace function public._notificar_admins(p_tipo text, p_mensaje text,
                                                    p_carpeta bigint default null,
                                                    p_ref bigint default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    a record;
    v_notaria bigint;
begin
    -- Sin carpeta no hay notaría (soporte): va a todos, como antes.
    if p_carpeta is not null then
        select notaria_id into v_notaria from public.carpetas where id = p_carpeta;
    end if;

    for a in
        select p.id
          from public.perfiles p
         where p.rol = 'administrador'
           and p.activo
           and p.id is distinct from auth.uid()
           and public.perfil_alcanza_notaria(p.id, v_notaria)
    loop
        perform public._notificar(a.id, p_tipo, p_mensaje, p_carpeta, p_ref);
    end loop;
end;
$$;


-- ------------------------------------------------------------
-- 5) Procesos vencidos: mismo filtro
-- ------------------------------------------------------------
create or replace function public.generar_notificaciones_vencidos()
returns void
language plpgsql security definer set search_path = public
as $$
declare
    p record;
    nom text;
begin
    if not public.es_admin() then return; end if;
    for p in
        select pt.id, pt.nombre, pt.carpeta_id, c.notaria_id
        from public.procesos_tramite pt
        join public.carpetas c on c.id = pt.carpeta_id
        where not pt.completado and not pt.pausado
          and pt.fecha_vencimiento_habil < current_date
          and not exists (
              select 1 from public.notificaciones n
              where n.tipo = 'proceso-vencido' and n.referencia_id = pt.id
          )
    loop
        select nombre into nom from public.carpetas where id = p.carpeta_id;
        insert into public.notificaciones (destinatario_id, tipo, mensaje, carpeta_id,
                                           referencia_id, notaria_id)
        select a.id, 'proceso-vencido',
               'El proceso «' || p.nombre || '» de «' || coalesce(nom, '') || '» se pasó del plazo',
               p.carpeta_id, p.id, p.notaria_id
        from public.perfiles a
        where a.rol = 'administrador' and a.activo
          and public.perfil_alcanza_notaria(a.id, p.notaria_id);
    end loop;
end;
$$;


-- ------------------------------------------------------------
-- 6) Los avisos del plazo: el administrador se acota igual que el monitor
-- ------------------------------------------------------------
create or replace function public.destinatarios_de_carpeta(p_carpeta bigint)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
    -- Operadores responsables
    select o.perfil_id
      from public.carpeta_operadores o
      join public.perfiles p on p.id = o.perfil_id and p.activo
     where o.carpeta_id = p_carpeta
    union
    -- Partes: cliente y acreedores
    select a.perfil_id
      from public.carpeta_asignados a
      join public.perfiles p on p.id = a.perfil_id and p.activo
     where a.carpeta_id = p_carpeta
    union
    -- Administradores que alcanzan la notaría de la carpeta.
    -- Uno sin notaría asignada es global y sigue recibiendo todo.
    select p.id
      from public.perfiles p
      join public.carpetas c on c.id = p_carpeta
     where p.rol = 'administrador' and p.activo
       and public.perfil_alcanza_notaria(p.id, c.notaria_id)
    union
    -- Monitores: solo los de esa notaría, sin excepción de global
    select p.id
      from public.perfiles p
      join public.carpetas c on c.id = p_carpeta
     where p.rol = 'monitor' and p.activo
       and c.notaria_id is not null
       and c.notaria_id in (select public.notarias_de_perfil(p.id));
$$;

do $$
declare f record;
begin
    for f in
        select p.oid::regprocedure as firma
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'destinatarios_de_carpeta'
    loop
        execute format('revoke execute on function %s from public, anon, authenticated', f.firma);
    end loop;
end $$;


-- ------------------------------------------------------------
-- 7) La tarea diaria, con el mismo filtro en los vencidos
-- ------------------------------------------------------------
create or replace function public.cron_plazos_diario()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    hoy date := current_date;
    p record;
    nom text;
    n_avisos int := 0;
    n_desactivadas int := 0;
    n_plazos int := 0;
begin
    if not public.es_dia_habil(hoy) then
        return jsonb_build_object('ejecutado', false, 'fecha', hoy,
                                  'motivo', 'fin de semana o festivo colombiano');
    end if;

    -- Procesos ya vencidos, solo a los administradores de esa notaría
    for p in
        select pt.id, pt.nombre, pt.carpeta_id, c.notaria_id
        from public.procesos_tramite pt
        join public.carpetas c on c.id = pt.carpeta_id
        where not pt.completado and not pt.pausado and not c.pausado
          and pt.fecha_vencimiento_habil < hoy
          and not exists (
              select 1 from public.notificaciones n
              where n.tipo = 'proceso-vencido' and n.referencia_id = pt.id
          )
    loop
        select nombre into nom from public.carpetas where id = p.carpeta_id;
        insert into public.notificaciones (destinatario_id, tipo, mensaje, carpeta_id,
                                           referencia_id, notaria_id)
        select a.id, 'proceso-vencido',
               'El proceso «' || p.nombre || '» de «' || coalesce(nom, '') || '» se pasó del plazo',
               p.carpeta_id, p.id, p.notaria_id
        from public.perfiles a
        where a.rol = 'administrador' and a.activo
          and public.perfil_alcanza_notaria(a.id, p.notaria_id);
        n_avisos := n_avisos + 1;
    end loop;

    -- Avisos del plazo del trámite a todos los de la carpeta
    n_plazos := public.avisar_plazos_tramite();

    -- Cerrar las carpetas cuyo plazo de descarga ya se cumplió
    with apagadas as (
        update public.carpetas
           set activa = false, desactivacion_auto_aplicada = true
         where finalizado and activa
           and not desactivacion_auto_aplicada
           and fecha_desactivacion_programada is not null
           and fecha_desactivacion_programada <= hoy
        returning id
    )
    select count(*) into n_desactivadas from apagadas;

    return jsonb_build_object(
        'ejecutado', true,
        'fecha', hoy,
        'procesos_vencidos_avisados', n_avisos,
        'avisos_de_plazo', n_plazos,
        'carpetas_desactivadas', n_desactivadas
    );
end;
$$;

do $$
declare f record;
begin
    for f in
        select p.oid::regprocedure as firma
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'cron_plazos_diario'
    loop
        execute format('revoke execute on function %s from public, anon, authenticated', f.firma);
    end loop;
end $$;


-- ------------------------------------------------------------
-- 8) Correo obligatorio según el rol
-- ------------------------------------------------------------
-- El correo se usa para los avisos de audiencia y del trámite, así que
-- operador, cliente y acreedor lo necesitan. Administrador y monitor
-- entran al portal y ven la campana ahí mismo: para ellos es opcional.
--
-- POR QUÉ UN TRIGGER Y NO UNA RESTRICCIÓN CHECK
--   Se intentó primero con un CHECK y rompió la creación de usuarios
--   entera. El trigger crear_perfil_nuevo genera todo perfil como
--   'cliente' con correo nulo, y la Edge Function le pone el rol y el
--   correo un paso después: el CHECK se evalúa también al INSERTAR, así
--   que reventaba antes de que nadie tuviera ocasión de poner el correo.
--
--   Con un trigger BEFORE UPDATE el perfil puede NACER sin correo,
--   durante el instante que la Edge Function tarda en completarlo, pero
--   no se puede GUARDAR sin él. La regla se mantiene y la creación
--   funciona.
alter table public.perfiles drop constraint if exists perfiles_correo_obligatorio;

create or replace function public.exigir_correo_por_rol()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    -- Administrador y monitor entran al portal y ven la campana ahí
    -- mismo: para ellos el correo es opcional.
    if new.rol in ('administrador', 'monitor') then
        return new;
    end if;

    -- Operador, cliente y acreedor reciben por correo los avisos de
    -- audiencia y del trámite, así que sin correo no se guardan.
    if new.correo is null or btrim(new.correo) = '' then
        raise exception 'El rol «%» necesita un correo de contacto: por ahí le llegan los avisos del trámite.', new.rol
            using errcode = 'check_violation';
    end if;

    return new;
end;
$$;

drop trigger if exists exigir_correo on public.perfiles;
create trigger exigir_correo
    before update on public.perfiles
    for each row execute function public.exigir_correo_por_rol();
