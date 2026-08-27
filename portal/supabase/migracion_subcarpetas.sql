-- ============================================================
-- MIGRACIÓN: subcarpetas dentro de una carpeta
-- ============================================================
-- Idempotente: se puede correr varias veces sin romper nada.
--
-- Permite agrupar los documentos del trámite: «Audiencias»,
-- «Notificaciones», «Soportes»…  Es UN SOLO NIVEL: la carpeta
-- sigue siendo el trámite y la subcarpeta solo ordena lo que
-- hay dentro.
--
-- POR QUÉ NO CAMBIAN LAS REGLAS DE ACCESO
-- Las rutas de Storage pasan de
--     <id-carpeta>/<archivo>
-- a
--     <id-carpeta>/<id-subcarpeta>/<archivo>
-- El PRIMER segmento sigue siendo el id de la carpeta, y es lo
-- único que mira carpeta_de_ruta(), de la que dependen todas las
-- políticas del bucket. Verificado: '12/5/acta.pdf' resuelve a 12.
-- ============================================================

create table if not exists public.subcarpetas (
    id          bigint generated always as identity primary key,
    carpeta_id  bigint not null references public.carpetas (id) on delete cascade,
    nombre      text not null check (length(trim(nombre)) between 1 and 60),
    orden       int not null default 1,
    creado_por  uuid references public.perfiles (id) on delete set null,
    creado      timestamptz not null default now(),
    unique (carpeta_id, nombre)
);
create index if not exists idx_subcarpetas_carpeta on public.subcarpetas (carpeta_id, orden);
create index if not exists idx_subcarpetas_creado_por on public.subcarpetas (creado_por);

alter table public.subcarpetas enable row level security;

-- La ven todos los que ven la carpeta (incluye monitor y partes)
drop policy if exists "ver subcarpetas de la carpeta" on public.subcarpetas;
create policy "ver subcarpetas de la carpeta" on public.subcarpetas
    for select using (public.puede_ver_carpeta(carpeta_id));

-- Las gestiona quien puede subir a la carpeta (admin y operador responsable)
drop policy if exists "personal gestiona subcarpetas" on public.subcarpetas;
create policy "personal gestiona subcarpetas" on public.subcarpetas
    for all using (public.puede_subir_a_carpeta(carpeta_id))
        with check (public.puede_subir_a_carpeta(carpeta_id));

-- Un archivo está en una subcarpeta o en la raíz (null).
-- on delete set null: al borrar la subcarpeta los documentos NO se
-- pierden, vuelven a la raíz de la carpeta.
alter table public.archivos
    add column if not exists subcarpeta_id bigint
    references public.subcarpetas (id) on delete set null;
create index if not exists idx_archivos_subcarpeta on public.archivos (subcarpeta_id);
