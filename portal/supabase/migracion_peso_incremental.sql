-- ============================================================
-- MIGRACIÓN: el peso de la carpeta se suma, no se recalcula
-- ============================================================
-- Idempotente: se puede correr varias veces sin romper nada.
--
-- EL PROBLEMA
--   `peso_carpeta` es un disparador FOR EACH ROW sobre `archivos`, y en
--   cada fila volvía a recorrer TODOS los archivos de la carpeta para
--   sumarlos:
--
--     set peso_total_mb = (select sum(a.tamano) from archivos a
--                          where a.carpeta_id = objetivo)
--
--   Subir el archivo número N cuesta leer N filas, así que subir N
--   archivos cuesta N²/2 lecturas. Con 880 archivos ya en la carpeta,
--   subir 300 más son más de 300.000 lecturas, y cada una escribe la
--   MISMA fila de `carpetas`. Las subidas en paralelo se quedan
--   esperando ese bloqueo y Postgres las corta:
--
--     canceling statement due to statement timeout
--     The connection to the database timed out
--
--   No había ningún límite de archivos. Solo se ponía cuadráticamente
--   más lento hasta que dejaba de terminar a tiempo.
--
-- LA SOLUCIÓN
--   Sumar el delta en vez de recontar. Al insertar se suma el tamaño
--   del archivo nuevo; al borrar se resta; al mover se resta de una
--   carpeta y se suma a la otra. Coste constante, no importa cuántos
--   archivos haya.
--
-- POR QUÉ APARECE UNA COLUMNA NUEVA
--   `peso_total_mb` es numeric(12,2). Ir sumándole megas redondeados a
--   dos decimales acumula error: cada archivo puede desviar hasta
--   0,005 MB, y con miles de archivos la cifra deja de cuadrar con la
--   realidad. Se guarda el total exacto en BYTES y los MB se derivan
--   de ahí. `peso_total_mb` se mantiene al día para no tocar el portal
--   ni las consultas que ya la usan.
-- ============================================================

-- 1) El contador exacto, en bytes
alter table public.carpetas
    add column if not exists peso_total_bytes bigint not null default 0;

-- 2) Ponerlo al día con lo que ya hay (una sola pasada, no por fila)
update public.carpetas c
   set peso_total_bytes = coalesce((select sum(a.tamano)
                                    from public.archivos a
                                    where a.carpeta_id = c.id), 0);

-- 3) Recalcular desde cero una carpeta. No la usa el disparador: está
--    para reparar a mano si alguna vez hiciera falta, o después de una
--    carga masiva hecha por fuera del portal.
create or replace function public.recalcular_peso_carpeta(p_carpeta bigint)
returns void
language sql
security definer
set search_path = public
as $$
    update public.carpetas c
       set peso_total_bytes = coalesce((select sum(a.tamano) from public.archivos a
                                        where a.carpeta_id = p_carpeta), 0),
           peso_total_mb    = round(coalesce((select sum(a.tamano) from public.archivos a
                                        where a.carpeta_id = p_carpeta), 0) / 1048576.0, 2),
           total_archivos   = coalesce((select count(*) from public.archivos a
                                        where a.carpeta_id = p_carpeta), 0)
     where c.id = p_carpeta;
$$;

-- Solo para mantenimiento: nadie la llama desde el portal.
do $$
declare f record;
begin
    for f in
        select p.oid::regprocedure as firma
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'recalcular_peso_carpeta'
    loop
        execute format('revoke execute on function %s from public, anon, authenticated', f.firma);
    end loop;
end $$;


-- 4) El disparador, ahora incremental
create or replace function public.actualizar_peso_carpeta()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if tg_op = 'INSERT' then
        update public.carpetas
           set peso_total_bytes = peso_total_bytes + coalesce(new.tamano, 0),
               peso_total_mb    = round((peso_total_bytes + coalesce(new.tamano, 0)) / 1048576.0, 2),
               total_archivos   = total_archivos + 1
         where id = new.carpeta_id;

    elsif tg_op = 'DELETE' then
        -- greatest(...,0) por si un recuento quedara descuadrado en el
        -- pasado: nunca se muestra un peso negativo
        update public.carpetas
           set peso_total_bytes = greatest(peso_total_bytes - coalesce(old.tamano, 0), 0),
               peso_total_mb    = round(greatest(peso_total_bytes - coalesce(old.tamano, 0), 0) / 1048576.0, 2),
               total_archivos   = greatest(total_archivos - 1, 0)
         where id = old.carpeta_id;

    elsif tg_op = 'UPDATE' then
        if new.carpeta_id is distinct from old.carpeta_id then
            -- El archivo cambió de carpeta: sale de una y entra en otra
            update public.carpetas
               set peso_total_bytes = greatest(peso_total_bytes - coalesce(old.tamano, 0), 0),
                   peso_total_mb    = round(greatest(peso_total_bytes - coalesce(old.tamano, 0), 0) / 1048576.0, 2),
                   total_archivos   = greatest(total_archivos - 1, 0)
             where id = old.carpeta_id;

            update public.carpetas
               set peso_total_bytes = peso_total_bytes + coalesce(new.tamano, 0),
                   peso_total_mb    = round((peso_total_bytes + coalesce(new.tamano, 0)) / 1048576.0, 2),
                   total_archivos   = total_archivos + 1
             where id = new.carpeta_id;

        elsif new.tamano is distinct from old.tamano then
            -- Misma carpeta, cambió el tamaño: solo la diferencia
            update public.carpetas
               set peso_total_bytes = greatest(peso_total_bytes + coalesce(new.tamano, 0) - coalesce(old.tamano, 0), 0),
                   peso_total_mb    = round(greatest(peso_total_bytes + coalesce(new.tamano, 0) - coalesce(old.tamano, 0), 0) / 1048576.0, 2)
             where id = new.carpeta_id;
        end if;
        -- Mover un archivo de subcarpeta no cambia ningún total: se
        -- sale sin tocar la carpeta, que es el caso más frecuente.
    end if;

    return null;
end;
$$;

drop trigger if exists peso_carpeta on public.archivos;
create trigger peso_carpeta after insert or update or delete on public.archivos
    for each row execute function public.actualizar_peso_carpeta();


-- 5) Dejar los MB cuadrados con los bytes recién contados
update public.carpetas c
   set peso_total_mb  = round(c.peso_total_bytes / 1048576.0, 2),
       total_archivos = coalesce((select count(*) from public.archivos a
                                  where a.carpeta_id = c.id), 0);

-- Comprobación: las dos columnas tienen que dar lo mismo que la suma real
select c.id, c.nombre, c.total_archivos, c.peso_total_mb,
       (select count(*) from public.archivos a where a.carpeta_id = c.id) as archivos_reales,
       round(coalesce((select sum(a.tamano) from public.archivos a
                       where a.carpeta_id = c.id), 0) / 1048576.0, 2) as mb_reales
from public.carpetas c
order by c.id;
