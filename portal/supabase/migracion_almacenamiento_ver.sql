-- ============================================================
-- MIGRACIÓN: el portal consulta el disco por una función propia
-- ============================================================
-- Idempotente: se puede correr varias veces sin romper nada.
--
-- POR QUÉ NO SE LEE LA TABLA DIRECTAMENTE
--   La primera versión leía `public.almacenamiento` por la API con su
--   política RLS. Para que eso funcione tienen que acertar a la vez el
--   grant de tabla a `authenticated`, la política, y el EXECUTE sobre
--   `es_admin()` que la política llama. Falló, y falló CALLADA: la
--   consulta devolvía cero filas sin error, el portal lo tomaba por
--   «aquí no hay medición» y pintaba el tope de config.js. La barra
--   decía 1 GB donde había 231, y nada en pantalla decía por qué.
--
--   Una función SECURITY DEFINER con la comprobación adentro deja un
--   solo permiso que acertar. Y el portal distingue «no eres admin»
--   de «no se pudo leer», en vez de inventarse un número.
--
-- QUÉ DEVUELVE
--   El disco en bytes, tal como lo midió la tarea `medir-disco` con
--   `df`, más CUÁNDO lo midió, para que el portal pueda decir si el
--   dato está fresco o lleva rato sin actualizarse.
--
--   El peso de los expedientes NO sale de esa medición: se suma en el
--   momento desde `carpetas.peso_total_bytes`, que los disparadores
--   mantienen al día. Así esa cifra es exacta al segundo aunque la
--   tarea del sistema solo corra cada pocos minutos.
--
--   A quien no es administrador le devuelve cero filas, sin error: la
--   ocupación del servidor no es asunto de las partes ni del operador,
--   y un error en la consola de todos los demás sería ruido.
-- ============================================================

create or replace function public.almacenamiento_ver()
returns table (
    total_bytes bigint,
    usado_bytes bigint,
    libre_bytes bigint,
    docs_bytes  bigint,
    medido      timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
    if not public.es_admin() then
        return;   -- cero filas, sin error
    end if;

    return query
    select (a.total_mb * 1048576)::bigint,
           (a.usado_mb * 1048576)::bigint,
           (a.libre_mb * 1048576)::bigint,
           coalesce((select sum(c.peso_total_bytes) from public.carpetas c), 0)::bigint,
           a.actualizado
      from public.almacenamiento a
     where a.id = 1;
end;
$$;

-- El grant explícito, y solo a quien ha iniciado sesión. Revocar de
-- `public` es imprescindible: Postgres concede EXECUTE a ese pseudo-rol
-- en toda función nueva, y revocar solo de `anon` no quita nada.
revoke execute on function public.almacenamiento_ver() from public, anon;
grant  execute on function public.almacenamiento_ver() to authenticated;

-- `almacenamiento_registrar` la llama la tarea del sistema por psql, no
-- el portal. El endurecimiento concede EXECUTE a `authenticated` sobre
-- toda función SECURITY DEFINER que no esté en su lista de internas, y
-- esta se le colaba. Se vuelve a cerrar aquí.
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

-- Comprobación: tiene que decir que authenticated SÍ puede ejecutar
-- almacenamiento_ver, y que NO puede ejecutar almacenamiento_registrar.
select p.proname,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_puede,
       has_function_privilege('anon',          p.oid, 'execute') as anon_puede
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('almacenamiento_ver', 'almacenamiento_registrar')
 order by p.proname;
