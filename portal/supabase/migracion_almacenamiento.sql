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

-- EL PERMISO DE TABLA, EXPLÍCITO
--   En Supabase Cloud las tablas nuevas heredan los grants por las
--   default privileges del proyecto. En autohospedado esa herencia no
--   está configurada igual, así que una tabla creada por `postgres`
--   nace sin permisos para `authenticated` y la consulta devuelve
--   vacío sin dar error: el portal cree que no hay medición y cae al
--   valor de config.js. Se concede a mano para que no dependa de eso.
grant select on public.almacenamiento to authenticated;

-- Solo administradores. La ocupación del disco dice cuánta carga lleva
-- la notaría, y eso no es asunto de clientes, acreedores ni operadores.
-- Coincide con la barra del portal, que solo se le pinta al admin.
drop policy if exists "ver almacenamiento" on public.almacenamiento;
create policy "ver almacenamiento" on public.almacenamiento
    for select using (public.es_admin());


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
