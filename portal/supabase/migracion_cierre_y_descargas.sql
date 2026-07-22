-- ============================================================
-- MIGRACIÓN: cierre del trámite + descarga por archivo
-- ============================================================
-- Pégalo completo en el SQL Editor de Supabase y ejecútalo.
-- Es idempotente: se puede correr varias veces sin romper nada
-- (usa "add column if not exists" y "create or replace"), y no
-- borra datos existentes.
--
-- Incluye:
--   14) Fin de trámite con 30 días hábiles de gracia y
--       desactivación automática de la carpeta.
--   15) Interruptor de descarga por archivo para las partes.
-- ============================================================

-- ============================================================
-- 14) CIERRE DEL TRÁMITE: 30 días hábiles para descargar
-- ============================================================
-- Al dar fin al trámite la carpeta sigue accesible 30 días hábiles para que
-- las partes descarguen sus documentos. Cumplido el plazo se desactiva sola;
-- el administrador puede volver a activarla y ya no se vuelve a desactivar.

alter table public.carpetas add column if not exists fecha_desactivacion_programada date;
alter table public.carpetas add column if not exists desactivacion_auto_aplicada boolean not null default false;

-- Días hábiles de gracia tras el fin del trámite
create or replace function public.dias_gracia_cierre()
returns int language sql immutable as $$ select 30 $$;

create or replace function public.finalizar_tramite(carpeta bigint)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    c record;
begin
    if not public.es_admin() then
        raise exception 'Solo el administrador puede dar fin al trámite';
    end if;
    select * into c from public.carpetas where id = carpeta for update;
    if not found then raise exception 'Carpeta no encontrada'; end if;
    if c.finalizado then raise exception 'El trámite ya estaba finalizado'; end if;
    update public.carpetas
       set finalizado = true,
           fecha_fin_tramite = current_date,
           fecha_desactivacion_programada =
               public.sumar_dias_habiles(current_date, public.dias_gracia_cierre()),
           desactivacion_auto_aplicada = false
     where id = carpeta;
end;
$$;

-- Avisa a admins, al operador responsable y a las partes (cliente y acreedores)
create or replace function public.notif_fin_tramite()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
    d record;
    aviso text;
begin
    if new.finalizado and not old.finalizado then
        perform public._notificar_admins('tramite-fin',
            'Se dio FIN al trámite «' || new.nombre || '»', new.id, null);

        aviso := 'El trámite «' || new.nombre || '» finalizó. Tienes ' ||
                 public.dias_gracia_cierre() || ' días hábiles (hasta el ' ||
                 to_char(coalesce(new.fecha_desactivacion_programada,
                     public.sumar_dias_habiles(current_date, public.dias_gracia_cierre())), 'DD/MM/YYYY') ||
                 ') para descargar los documentos de la carpeta. Después de esa fecha ' ||
                 'deberás solicitarlos escribiendo al correo de la fundación.';

        for d in
            select p.id from public.carpeta_asignados a
            join public.perfiles p on p.id = a.perfil_id
            where a.carpeta_id = new.id and p.activo
            union
            select p.id from public.carpeta_operadores o
            join public.perfiles p on p.id = o.perfil_id
            where o.carpeta_id = new.id and p.activo
        loop
            perform public._notificar(d.id, 'tramite-cierre-descarga', aviso, new.id, null);
        end loop;
    end if;
    return new;
end;
$$;
drop trigger if exists notif_fin on public.carpetas;
create trigger notif_fin after update on public.carpetas
    for each row execute function public.notif_fin_tramite();

-- Desactivación automática al cumplirse el plazo. Se ejecuta sola cada vez que
-- alguien consulta sus avisos, así no hace falta un programador de tareas.
create or replace function public.aplicar_desactivaciones_automaticas()
returns void
language plpgsql security definer set search_path = public
as $$
begin
    update public.carpetas
       set activa = false, desactivacion_auto_aplicada = true
     where finalizado
       and activa
       and not desactivacion_auto_aplicada
       and fecha_desactivacion_programada is not null
       and fecha_desactivacion_programada <= current_date;
end;
$$;

-- Carpetas finalizadas que el usuario todavía puede ver, con los días hábiles
-- que le quedan para descargar. Alimenta el aviso de cada ingreso y el modal.
create or replace function public.avisos_fin_tramite()
returns table (
    carpeta_id bigint,
    nombre text,
    fecha_fin date,
    fecha_desactivacion date,
    dias_habiles_restantes int,
    activa boolean
)
language plpgsql stable security definer set search_path = public
as $$
begin
    return query
        select c.id, c.nombre, c.fecha_fin_tramite, c.fecha_desactivacion_programada,
               greatest(public.contar_dias_habiles(current_date, c.fecha_desactivacion_programada), 0),
               c.activa
        from public.carpetas c
        where c.finalizado
          and c.fecha_desactivacion_programada is not null
          and public.puede_ver_carpeta(c.id)
        order by c.fecha_desactivacion_programada;
end;
$$;

-- ============================================================
-- 15) DESCARGA POR ARCHIVO: el operador decide qué se puede bajar
-- ============================================================
-- Cada documento lleva una marca "descargable por las partes". El cliente y el
-- acreedor SIEMPRE pueden abrir y leer los documentos de su carpeta; la marca
-- solo decide si además pueden descargarlos (botón "Descargar" y ZIP).
-- Por eso Storage sigue permitiendo la lectura a quien ya tiene acceso a la
-- carpeta: sin leer los bytes no se puede mostrar el documento en pantalla.

alter table public.archivos add column if not exists descargable_partes boolean not null default true;

-- Lectura de documentos: quien tiene acceso a la carpeta puede abrirlos
drop policy if exists "descarga segun carpeta asignada" on storage.objects;
create policy "descarga segun carpeta asignada" on storage.objects
    for select using (
        bucket_id = 'documentos'
        and public.puede_ver_carpeta(public.carpeta_de_ruta(name))
    );

-- Ya no se usa: la marca se aplica en el portal, no en Storage
drop function if exists public.puede_descargar_archivo(text);

-- El operador responsable (o el admin) cambia la disponibilidad de un archivo
create or replace function public.fijar_descarga_partes(archivo bigint, permitir boolean)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    c bigint;
begin
    select carpeta_id into c from public.archivos where id = archivo;
    if c is null then raise exception 'Archivo no encontrado'; end if;
    if not public.puede_subir_a_carpeta(c) then
        raise exception 'Sin permiso para cambiar la descarga de este archivo';
    end if;
    update public.archivos set descargable_partes = permitir where id = archivo;
end;
$$;
