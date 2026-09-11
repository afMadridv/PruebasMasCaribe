-- ============================================================
-- MIGRACIÓN: el almacenamiento se mide, no se escribe a mano
-- ============================================================
-- Idempotente: se puede correr varias veces sin romper nada.
--
-- EL PROBLEMA
--   La barra de almacenamiento llevaba el tope escrito en el código
--   (50 MB, que además era el límite POR ARCHIVO, no el total). Un
--   número a mano miente el día que se cambia de disco o de plan.
--
-- POR QUÉ NO SE PUEDE LEER EL DISCO DIRECTAMENTE
--   El navegador no ve el disco del servidor, y Postgres tampoco:
--   sabe cuánto pesa su base, pero no cuánto queda libre en el
--   sistema de archivos. Quien sí lo sabe es el propio servidor.
--
-- LA SOLUCIÓN
--   Una tarea del sistema corre `df` cada pocos minutos y escribe una
--   fila aquí. El portal la lee por la API de siempre, con su RLS.
--   Sin servicios nuevos, sin puertos nuevos, sin agentes.
--
--   Si la tabla está vacía (por ejemplo en Supabase Cloud, donde no
--   hay tarea que la llene), el portal cae de vuelta al valor de
--   config.js. Así el mismo código sirve en los dos sitios.
-- ============================================================

create table if not exists public.almacenamiento (
    id          int primary key default 1 check (id = 1),  -- una sola fila
    total_mb    numeric not null default 0,
    usado_mb    numeric not null default 0,
    libre_mb    numeric not null default 0,
    -- Lo que ocupan los expedientes, aparte del sistema y la base
    docs_mb     numeric not null default 0,
    actualizado timestamptz not null default now()
);

insert into public.almacenamiento (id) values (1) on conflict (id) do nothing;

alter table public.almacenamiento enable row level security;

-- Cualquiera con sesión puede leerla: es un dato de capacidad, no
-- contiene nada de ningún expediente. La escribe la tarea del sistema
-- conectándose directo a Postgres, así que no hace falta política de
-- escritura por API.
drop policy if exists "ver almacenamiento" on public.almacenamiento;
create policy "ver almacenamiento" on public.almacenamiento
    for select using (public.rol_actual() is not null);


-- Registrar la medición. La llama la tarea del sistema por psql, no
-- el portal: por eso queda fuera del alcance de anon y authenticated.
create or replace function public.almacenamiento_registrar(
    p_total_mb numeric, p_usado_mb numeric, p_libre_mb numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_docs numeric;
begin
    -- El peso de los expedientes ya viene cacheado por carpeta
    select coalesce(sum(peso_total_mb), 0) into v_docs from public.carpetas;

    insert into public.almacenamiento (id, total_mb, usado_mb, libre_mb, docs_mb, actualizado)
    values (1, p_total_mb, p_usado_mb, p_libre_mb, v_docs, now())
    on conflict (id) do update
        set total_mb = excluded.total_mb,
            usado_mb = excluded.usado_mb,
            libre_mb = excluded.libre_mb,
            docs_mb  = excluded.docs_mb,
            actualizado = now();
end;
$$;

do $$
declare f record;
begin
    for f in
        select p.oid::regprocedure as firma
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'almacenamiento_registrar'
    loop
        execute format('revoke execute on function %s from public, anon, authenticated', f.firma);
    end loop;
end $$;
