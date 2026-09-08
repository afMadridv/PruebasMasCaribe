-- ============================================================
-- MIGRACIÓN: avisos del plazo del trámite (60/90 días hábiles)
-- ============================================================
-- Idempotente: se puede correr varias veces sin romper nada.
--
-- QUÉ FALTABA
--   El portal ya avisaba cuando un PROCESO se pasaba del plazo
--   ('proceso-vencido'), es decir, cuando ya era tarde y solo al
--   administrador. Del plazo del TRÁMITE completo (los 60 días
--   hábiles de la Ley 1564, o 90 con prórroga) no avisaba nada.
--
-- QUÉ HACE AHORA
--   Seis avisos, a todos los que están dentro de la carpeta:
--     4 semanas antes   (28 días de calendario)
--     3 semanas antes   (21)
--     2 semanas antes   (14)
--     1 semana antes    (7)
--     1 día antes       (1)
--     el mismo día      (0)
--
-- POR QUÉ DÍAS DE CALENDARIO Y NO HÁBILES
--   El aviso es un recordatorio, no un cómputo legal. "4 semanas
--   antes" significa cuatro semanas de calendario para quien lo
--   recibe. La fecha de vencimiento que se anuncia sí está
--   calculada en días hábiles: la calculó calcular_vencimiento_habil
--   al iniciar el trámite, saltando fines de semana y festivos.
--
-- SI EL DÍA EXACTO CAE EN FIN DE SEMANA O FESTIVO
--   La tarea diaria no corre esos días. El hito no se pierde: la
--   condición es "faltan N días o menos" y cada hito se manda una
--   sola vez, así que el lunes siguiente sale el aviso pendiente.
--   Nunca salen varios hitos atrasados de golpe: solo el más
--   cercano al vencimiento.
--
-- PRÓRROGA Y PAUSA
--   Ambas mueven la fecha de vencimiento hacia adelante. Los avisos
--   ya mandados quedarían bloqueando los nuevos, así que el trigger
--   de la carpeta los borra y la cuenta empieza otra vez con la
--   fecha nueva.
-- ============================================================


-- ------------------------------------------------------------
-- 1) Quién está "dentro" de una carpeta
-- ------------------------------------------------------------
-- Operadores responsables, partes asignadas (cliente y acreedores),
-- los administradores (ven todas las notarías) y los monitores de la
-- notaría de esa carpeta. Solo perfiles activos.
--
-- OJO: es security definer y devuelve ids de perfiles, así que NO se
-- expone a los usuarios: solo la llama la tarea diaria.
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
    -- Administradores: ven todas las notarías
    select p.id
      from public.perfiles p
     where p.rol = 'administrador' and p.activo
    union
    -- Monitores, solo los de la notaría de la carpeta
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
-- 2) Los avisos del plazo
-- ------------------------------------------------------------
-- Devuelve cuántos avisos generó (para el registro de la tarea).
create or replace function public.avisar_plazos_tramite()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
    -- De más lejos a más cerca. Días de CALENDARIO que faltan.
    -- Las variables van con prefijo v_ porque sin él "tipo" y
    -- "mensaje" chocan con las columnas de notificaciones y plpgsql
    -- aborta con "column reference is ambiguous".
    hitos constant int[] := array[28, 21, 14, 7, 1, 0];
    c          record;
    d          record;
    v_faltan   int;
    v_hito     int;
    v_tipo     text;
    v_cuando   text;
    v_mensaje  text;
    n_avisos   int := 0;
begin
    for c in
        select id, nombre, fecha_vencimiento_tramite
          from public.carpetas
         where activa
           and not finalizado
           and not pausado                        -- en pausa el reloj está detenido
           and fecha_vencimiento_tramite is not null
    loop
        v_faltan := c.fecha_vencimiento_tramite - current_date;

        -- Ya vencido: de eso avisa 'proceso-vencido', no este aviso
        if v_faltan < 0 then continue; end if;

        -- El hito más cercano al vencimiento que ya se alcanzó. Si
        -- faltan 26 días (el hito de 28 cayó en festivo), sale el de
        -- 4 semanas; si faltan 40, todavía no sale ninguno.
        select min(h) into v_hito from unnest(hitos) as h where v_faltan <= h;
        if v_hito is null then continue; end if;

        v_tipo := 'plazo-' || v_hito;

        -- Cada hito, una sola vez por carpeta
        if exists (
            select 1 from public.notificaciones n
             where n.tipo = v_tipo and n.referencia_id = c.id
        ) then continue; end if;

        v_cuando := case v_hito
            when 28 then 'Faltan 4 semanas'
            when 21 then 'Faltan 3 semanas'
            when 14 then 'Faltan 2 semanas'
            when  7 then 'Falta 1 semana'
            when  1 then 'Falta 1 día'
            else         'Hoy'
        end;

        v_mensaje := case
            when v_hito = 0 then
                'Hoy se cumple el plazo del trámite «' || c.nombre || '»'
            else
                v_cuando || ' para que se cumpla el plazo del trámite «' || c.nombre ||
                '»: vence el ' || to_char(c.fecha_vencimiento_tramite, 'DD/MM/YYYY')
        end;

        for d in select perfil from public.destinatarios_de_carpeta(c.id) as perfil loop
            perform public._notificar(d.perfil, v_tipo, v_mensaje, c.id, c.id);
            n_avisos := n_avisos + 1;
        end loop;
    end loop;

    return n_avisos;
end;
$$;

do $$
declare f record;
begin
    for f in
        select p.oid::regprocedure as firma
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'avisar_plazos_tramite'
    loop
        execute format('revoke execute on function %s from public, anon, authenticated', f.firma);
    end loop;
end $$;


-- ------------------------------------------------------------
-- 3) Prórroga y reactivación: la cuenta empieza de nuevo
-- ------------------------------------------------------------
-- Se reemplaza el trigger que ya existía, conservando lo que hacía
-- (avisar a los administradores de pausa, reactivación y prórroga) y
-- añadiendo el borrado de los avisos de plazo cuando la fecha de
-- vencimiento se mueve.
create or replace function public.notif_carpeta_cambio()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
    if new.pausado is distinct from old.pausado then
        perform public._notificar_admins(case when new.pausado then 'tramite-pausado' else 'tramite-reactivado' end,
            'El trámite «' || new.nombre || '» fue ' || case when new.pausado then 'pausado' else 'reactivado' end,
            new.id, null);
    end if;
    if new.tiene_prorroga and not old.tiene_prorroga then
        perform public._notificar_admins('tramite-prorroga',
            'Se aplicó la prórroga (90 días hábiles) al trámite «' || new.nombre || '»',
            new.id, null);
    end if;

    -- La fecha de vencimiento se movió (prórroga, o reactivación tras
    -- una pausa): los avisos viejos ya no valen y además bloquearían
    -- los nuevos, porque cada hito se manda una sola vez.
    if new.fecha_vencimiento_tramite is distinct from old.fecha_vencimiento_tramite then
        delete from public.notificaciones
         where referencia_id = new.id
           and tipo in ('plazo-28', 'plazo-21', 'plazo-14', 'plazo-7', 'plazo-1', 'plazo-0');
    end if;

    return new;
end;
$$;

drop trigger if exists notif_carpeta on public.carpetas;
create trigger notif_carpeta after update on public.carpetas
    for each row execute function public.notif_carpeta_cambio();


-- ------------------------------------------------------------
-- 4) Engancharlo a la tarea diaria
-- ------------------------------------------------------------
-- Misma tarea de siempre (fines de semana y festivos fuera), ahora
-- con los avisos del plazo del trámite.
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

    -- Avisar a los administradores de los procesos ya vencidos
    for p in
        select pt.id, pt.nombre, pt.carpeta_id
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
        insert into public.notificaciones (destinatario_id, tipo, mensaje, carpeta_id, referencia_id)
        select a.id, 'proceso-vencido',
               'El proceso «' || p.nombre || '» de «' || coalesce(nom, '') || '» se pasó del plazo',
               p.carpeta_id, p.id
        from public.perfiles a
        where a.rol = 'administrador' and a.activo;
        n_avisos := n_avisos + 1;
    end loop;

    -- Avisar del plazo del trámite a todos los de la carpeta
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
