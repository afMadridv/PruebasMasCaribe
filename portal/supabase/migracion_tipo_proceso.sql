-- ============================================================
-- MIGRACIÓN: el tipo de proceso de la carpeta
-- ============================================================
-- Idempotente: se puede correr varias veces sin romper nada.
--
-- POR QUÉ EXISTE ESTE ARCHIVO
--   La columna `carpetas.tipo_proceso` se creó a mano en el panel de
--   Supabase y nunca quedó escrita en una migración. El proyecto de la
--   nube la tenía; el repositorio, no. Mientras hubo un solo servidor
--   la diferencia no se notó.
--
--   Se notó al instalar el portal en un servidor propio siguiendo los
--   SQL del repositorio: la base nació sin la columna y guardar una
--   carpeta fallaba con
--
--     PGRST204: Could not find the 'tipo_proceso' column of 'carpetas'
--               in the schema cache
--
--   Este archivo cierra esa diferencia. Correrlo en la nube no cambia
--   nada, porque la columna ya está.
-- ============================================================

alter table public.carpetas add column if not exists tipo_proceso text;

-- Los dos regímenes que maneja el portal (TIPOS_PROCESO en app.js).
-- Se admite null: las carpetas viejas se crearon antes de que el campo
-- existiera y la tarjeta simplemente no muestra la etiqueta.
alter table public.carpetas drop constraint if exists carpetas_tipo_proceso_check;
alter table public.carpetas add constraint carpetas_tipo_proceso_check
    check (tipo_proceso is null
           or tipo_proceso in ('natural_no_comerciante', 'pequeno_comerciante'));

-- PostgREST guarda el mapa de columnas en memoria. Sin este aviso sigue
-- respondiendo que la columna no existe hasta que alguien lo reinicie.
notify pgrst, 'reload schema';
