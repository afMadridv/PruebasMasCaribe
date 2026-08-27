-- ============================================================
-- MIGRACIÓN: festivos 2028-2030 y tarea diaria de plazos
-- ============================================================
-- Idempotente: se puede correr varias veces sin romper nada.
--
-- 1) FESTIVOS hasta 2030. Antes solo llegaban a 2027: a partir de
--    2028 el semáforo habría calculado plazos legales mal, en
--    silencio. Las fechas se generaron con el algoritmo de Pascua
--    gregoriana + traslado al lunes (Ley 51 de 1983), validado
--    reproduciendo exactamente 2024-2027 antes de usarlo.
--    OJO: la MISMA lista vive en portal/js/diasHabiles.js. Si se
--    agrega un año aquí, agregarlo allá (y viceversa).
--
-- 2) TAREA DIARIA. Dos procesos del portal no corrían solos:
--      generar_notificaciones_vencidos()  solo hacía algo cuando
--        un ADMINISTRADOR tenía el portal abierto (guard es_admin).
--      aplicar_desactivaciones_automaticas()  solo se disparaba
--        cuando alguien iniciaba sesión.
--    cron_plazos_diario() hace ambas cosas sin guard de sesión y
--    la dispara pg_cron todos los días.
-- ============================================================


-- ------------------------------------------------------------
-- 1) Festivos oficiales de Colombia 2028-2030
-- ------------------------------------------------------------
insert into public.festivos_colombia (fecha, nombre) values
    ('2028-01-01','Año Nuevo'),
    ('2028-01-10','Reyes Magos'),
    ('2028-03-20','San José'),
    ('2028-04-13','Jueves Santo'),
    ('2028-04-14','Viernes Santo'),
    ('2028-05-01','Día del Trabajo'),
    ('2028-05-29','Ascensión del Señor'),
    ('2028-06-19','Corpus Christi'),
    ('2028-06-26','Sagrado Corazón'),
    ('2028-07-03','San Pedro y San Pablo'),
    ('2028-07-20','Independencia de Colombia'),
    ('2028-08-07','Batalla de Boyacá'),
    ('2028-08-21','Asunción de la Virgen'),
    ('2028-10-16','Día de la Raza'),
    ('2028-11-06','Todos los Santos'),
    ('2028-11-13','Independencia de Cartagena'),
    ('2028-12-08','Inmaculada Concepción'),
    ('2028-12-25','Navidad'),
    ('2029-01-01','Año Nuevo'),
    ('2029-01-08','Reyes Magos'),
    ('2029-03-19','San José'),
    ('2029-03-29','Jueves Santo'),
    ('2029-03-30','Viernes Santo'),
    ('2029-05-01','Día del Trabajo'),
    ('2029-05-14','Ascensión del Señor'),
    ('2029-06-04','Corpus Christi'),
    ('2029-06-11','Sagrado Corazón'),
    ('2029-07-02','San Pedro y San Pablo'),
    ('2029-07-20','Independencia de Colombia'),
    ('2029-08-07','Batalla de Boyacá'),
    ('2029-08-20','Asunción de la Virgen'),
    ('2029-10-15','Día de la Raza'),
    ('2029-11-05','Todos los Santos'),
    ('2029-11-12','Independencia de Cartagena'),
    ('2029-12-08','Inmaculada Concepción'),
    ('2029-12-25','Navidad'),
    ('2030-01-01','Año Nuevo'),
    ('2030-01-07','Reyes Magos'),
    ('2030-03-25','San José'),
    ('2030-04-18','Jueves Santo'),
    ('2030-04-19','Viernes Santo'),
    ('2030-05-01','Día del Trabajo'),
    ('2030-06-03','Ascensión del Señor'),
    ('2030-06-24','Corpus Christi'),
    ('2030-07-01','Sagrado Corazón / San Pedro y San Pablo'),
    ('2030-07-20','Independencia de Colombia'),
    ('2030-08-07','Batalla de Boyacá'),
    ('2030-08-19','Asunción de la Virgen'),
    ('2030-10-14','Día de la Raza'),
    ('2030-11-04','Todos los Santos'),
    ('2030-11-11','Independencia de Cartagena'),
    ('2030-12-08','Inmaculada Concepción'),
    ('2030-12-25','Navidad')
on conflict (fecha) do nothing;


-- ------------------------------------------------------------
-- 2) Tarea diaria de plazos
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
        'carpetas_desactivadas', n_desactivadas
    );
end;
$$;

-- Solo la llama el programador. Nadie por HTTP.
do $$
declare f record;
begin
    for f in
        select p.oid::regprocedure as firma
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname='cron_plazos_diario'
    loop
        execute format('revoke execute on function %s from public, anon, authenticated', f.firma);
    end loop;
end $$;


-- ------------------------------------------------------------
-- 3) Programación diaria (pg_cron)
-- ------------------------------------------------------------
-- 12:00 UTC = 07:00 en Colombia (UTC-5, sin horario de verano).
-- La propia función descarta fines de semana y festivos.
create extension if not exists pg_cron with schema pg_catalog;

select cron.unschedule('plazos-diario') where exists (
    select 1 from cron.job where jobname = 'plazos-diario'
);

select cron.schedule(
    'plazos-diario',
    '0 12 * * *',
    $$ select public.cron_plazos_diario(); $$
);
