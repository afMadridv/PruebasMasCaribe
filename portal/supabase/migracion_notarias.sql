-- ============================================================
-- MIGRACIÓN: varias notarías en un solo portal
-- ------------------------------------------------------------
-- El portal pasa de atender una sola oficina a atender varias.
-- Cada carpeta pertenece a una notaría y cada usuario tiene las
-- notarías donde puede trabajar.
--
-- Regla que gobierna toda la interfaz: si el usuario tiene dos o
-- más notarías, elige al entrar; si tiene una, entra directo y el
-- portal se ve igual que antes. No hay reglas por rol, sale del
-- conteo. Un operador de una sola ciudad no nota el cambio.
--
-- El administrador las ve todas por su rol, sin necesidad de
-- asignárselas una por una.
--
-- Es idempotente: se puede correr más de una vez.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Tablas
-- ------------------------------------------------------------
create table if not exists public.notarias (
    id     bigint generated always as identity primary key,
    nombre text not null check (length(trim(nombre)) between 1 and 80),
    ciudad text not null check (length(trim(ciudad)) between 1 and 60),
    activa boolean not null default true,
    creada timestamptz not null default now(),
    unique (nombre, ciudad)
);

comment on table public.notarias is
    'Oficinas que atiende el portal. La ciudad es lo que se muestra junto a "Portal Documental".';

-- Cada carpeta vive en una notaría
alter table public.carpetas
    add column if not exists notaria_id bigint references public.notarias (id);

-- Notaría de origen del usuario. Para monitor, cliente y acreedor es
-- la única donde trabajan. Para el operador es la primera, y las demás
-- salen de perfil_notarias.
alter table public.perfiles
    add column if not exists notaria_id bigint references public.notarias (id);

-- Operador que atiende varias ciudades: una fila por notaría
create table if not exists public.perfil_notarias (
    perfil_id  uuid   not null references public.perfiles (id) on delete cascade,
    notaria_id bigint not null references public.notarias (id) on delete cascade,
    primary key (perfil_id, notaria_id)
);

create index if not exists idx_carpetas_notaria on public.carpetas (notaria_id);
create index if not exists idx_perfiles_notaria on public.perfiles (notaria_id);
create index if not exists idx_perfil_notarias_perfil on public.perfil_notarias (perfil_id);

-- ------------------------------------------------------------
-- 2) Datos de partida
-- ------------------------------------------------------------
-- Las carpetas y los usuarios que ya existen necesitan una notaría.
-- Se crea una y se les asigna, para poder dejar la columna en
-- not null sin perder nada. El administrador puede renombrarla
-- después desde el portal.
insert into public.notarias (nombre, ciudad)
select 'Notaría principal', 'Barranquilla'
where not exists (select 1 from public.notarias);

update public.carpetas
   set notaria_id = (select min(id) from public.notarias)
 where notaria_id is null;

update public.perfiles
   set notaria_id = (select min(id) from public.notarias)
 where notaria_id is null;

-- Ya no puede haber carpetas sin notaría
alter table public.carpetas alter column notaria_id set not null;

-- Los operadores que ya existían quedan asignados a su notaría de origen
insert into public.perfil_notarias (perfil_id, notaria_id)
select p.id, p.notaria_id
  from public.perfiles p
 where p.rol = 'operador'
   and p.notaria_id is not null
on conflict do nothing;

-- ------------------------------------------------------------
-- 3) Quién puede ver qué notaría
-- ------------------------------------------------------------
-- Importante: esto es SEGURIDAD, no preferencia de pantalla. La
-- notaría que el usuario está mirando en este momento se guarda en
-- el navegador y solo filtra la vista. Lo que decide a qué tiene
-- derecho es esta función, que corre en la base.
create or replace function public.notarias_del_usuario()
returns setof bigint
language sql stable security definer set search_path = public
as $$
    -- El administrador las ve todas por su rol. El monitor NO: aunque
    -- lee todas las carpetas, se le asigna una oficina como a los
    -- demás, que es lo que se pidió.
    select n.id
      from public.notarias n
     where public.es_admin()
    union
    -- Los demás, la suya de origen
    select p.notaria_id
      from public.perfiles p
     where p.id = auth.uid()
       and p.activo
       and p.notaria_id is not null
    union
    -- Y el operador, las que le hayan asignado además
    select pn.notaria_id
      from public.perfil_notarias pn
      join public.perfiles p on p.id = pn.perfil_id
     where pn.perfil_id = auth.uid()
       and p.activo;
$$;

create or replace function public.puede_ver_notaria(notaria bigint)
returns boolean
language sql stable security definer set search_path = public
as $$
    select notaria is not null
       and notaria in (select public.notarias_del_usuario());
$$;

-- ------------------------------------------------------------
-- 4) El filtro de notaría entra en el punto único de verdad
-- ------------------------------------------------------------
-- puede_ver_carpeta() es de donde cuelgan las políticas y las
-- funciones que listan. Añadir aquí el filtro lo propaga a todo
-- sin tocar quince sitios.
create or replace function public.puede_ver_carpeta(carpeta bigint)
returns boolean
language sql stable security definer set search_path = public
as $$
    select
        -- La carpeta tiene que estar en una notaría del usuario.
        -- El administrador pasa siempre, porque las tiene todas.
        exists (
            select 1 from public.carpetas c
             where c.id = carpeta
               and public.puede_ver_notaria(c.notaria_id)
        )
        and (
            public.es_admin()
            -- El monitor ve todo en solo lectura. Estaba en la base pero
            -- no en esquema.sql: sin esta línea perdería el acceso.
            or public.es_monitor()
            or public.es_operador_de(carpeta)
            or exists (
                select 1
                  from public.carpetas c
                  join public.carpeta_asignados a on a.carpeta_id = c.id
                 where c.id = carpeta
                   and c.activa
                   and a.perfil_id = auth.uid()
                   and public.rol_actual() is not null
            )
        );
$$;

-- Las políticas de lectura de carpetas heredan el mismo filtro.
-- Se reescriben apoyándose en puede_ver_carpeta para que exista
-- un solo lugar donde cambiar las reglas.
drop policy if exists "admin ve todas las carpetas" on public.carpetas;
create policy "admin ve todas las carpetas" on public.carpetas
    for select using (public.es_admin() and public.puede_ver_notaria(notaria_id));

drop policy if exists "operador ve sus carpetas" on public.carpetas;
create policy "operador ve sus carpetas" on public.carpetas
    for select using (public.es_operador_de(id) and public.puede_ver_notaria(notaria_id));

drop policy if exists "asignados ven sus carpetas activas" on public.carpetas;
create policy "asignados ven sus carpetas activas" on public.carpetas
    for select using (
        activa
        and public.rol_actual() is not null
        and public.puede_ver_notaria(notaria_id)
        and exists (
            select 1 from public.carpeta_asignados a
            where a.carpeta_id = id and a.perfil_id = auth.uid()
        )
    );

drop policy if exists "monitor ve todas las carpetas" on public.carpetas;
create policy "monitor ve todas las carpetas" on public.carpetas
    for select using (public.es_monitor() and public.puede_ver_notaria(notaria_id));

-- ------------------------------------------------------------
-- 5) Seguridad de las tablas nuevas
-- ------------------------------------------------------------
alter table public.notarias        enable row level security;
alter table public.perfil_notarias enable row level security;

-- Cada quien ve las notarías donde puede trabajar. Sin esto, la
-- pantalla de selección le mostraría oficinas ajenas.
drop policy if exists "ver mis notarias" on public.notarias;
create policy "ver mis notarias" on public.notarias
    for select using (id in (select public.notarias_del_usuario()));

drop policy if exists "admin crea notarias" on public.notarias;
create policy "admin crea notarias" on public.notarias
    for insert with check (public.es_admin());

drop policy if exists "admin edita notarias" on public.notarias;
create policy "admin edita notarias" on public.notarias
    for update using (public.es_admin()) with check (public.es_admin());

-- No hay política de borrado a propósito: una notaría con carpetas
-- no se elimina, se desactiva. Borrarla dejaría expedientes huérfanos.

drop policy if exists "ver asignaciones de notaria" on public.perfil_notarias;
create policy "ver asignaciones de notaria" on public.perfil_notarias
    for select using (public.es_admin() or perfil_id = auth.uid());

drop policy if exists "admin asigna notarias" on public.perfil_notarias;
create policy "admin asigna notarias" on public.perfil_notarias
    for all using (public.es_admin()) with check (public.es_admin());

-- ------------------------------------------------------------
-- 6) Funciones que usa el portal
-- ------------------------------------------------------------

-- Notarías donde el usuario puede entrar, con el conteo de carpetas
-- activas de cada una. El conteo alimenta la pantalla de selección.
create or replace function public.mis_notarias()
returns table (id bigint, nombre text, ciudad text, activa boolean, carpetas bigint)
language sql stable security definer set search_path = public
as $$
    select n.id, n.nombre, n.ciudad, n.activa,
           (select count(*) from public.carpetas c
             where c.notaria_id = n.id and c.activa)
      from public.notarias n
     where n.id in (select public.notarias_del_usuario())
       and n.activa
     order by n.ciudad, n.nombre;
$$;

-- Alta de notaría (solo administrador)
create or replace function public.notaria_crear(p_nombre text, p_ciudad text)
returns bigint
language plpgsql security definer set search_path = public
as $$
declare
    nuevo bigint;
begin
    if not public.es_admin() then
        raise exception 'Solo un administrador puede crear notarías.';
    end if;
    insert into public.notarias (nombre, ciudad)
         values (trim(p_nombre), trim(p_ciudad))
      returning id into nuevo;
    return nuevo;
end;
$$;

-- Renombrar o activar/desactivar una notaría
create or replace function public.notaria_editar(
    p_id bigint, p_nombre text, p_ciudad text, p_activa boolean)
returns void
language plpgsql security definer set search_path = public
as $$
begin
    if not public.es_admin() then
        raise exception 'Solo un administrador puede editar notarías.';
    end if;
    update public.notarias
       set nombre = coalesce(nullif(trim(p_nombre), ''), nombre),
           ciudad = coalesce(nullif(trim(p_ciudad), ''), ciudad),
           activa = coalesce(p_activa, activa)
     where id = p_id;
end;
$$;

-- Fija en qué notarías puede trabajar un operador. Reemplaza la lista
-- completa: lo que no venga en el arreglo se le quita.
create or replace function public.perfil_notarias_fijar(
    p_perfil uuid, p_notarias bigint[])
returns void
language plpgsql security definer set search_path = public
as $$
declare
    rol_destino text;
begin
    if not public.es_admin() then
        raise exception 'Solo un administrador puede asignar notarías.';
    end if;

    select rol into rol_destino from public.perfiles where id = p_perfil;
    if rol_destino is null then
        raise exception 'El usuario no existe.';
    end if;

    -- El administrador las tiene todas por su rol: asignárselas una por
    -- una no aporta nada y confundiría al leer la tabla.
    if rol_destino = 'administrador' then
        delete from public.perfil_notarias where perfil_id = p_perfil;
        return;
    end if;

    -- Monitor, cliente y acreedor trabajan en una sola oficina. Se les
    -- fija como notaría de origen y no se les crean filas extra.
    if rol_destino <> 'operador' then
        if array_length(p_notarias, 1) is distinct from 1 then
            raise exception 'Este rol trabaja en una sola notaría.';
        end if;
        update public.perfiles set notaria_id = p_notarias[1] where id = p_perfil;
        delete from public.perfil_notarias where perfil_id = p_perfil;
        return;
    end if;

    -- Operador: puede tener varias
    if coalesce(array_length(p_notarias, 1), 0) = 0 then
        raise exception 'El operador necesita al menos una notaría.';
    end if;

    delete from public.perfil_notarias
     where perfil_id = p_perfil
       and notaria_id <> all (p_notarias);

    insert into public.perfil_notarias (perfil_id, notaria_id)
    select p_perfil, unnest(p_notarias)
    on conflict do nothing;

    -- La de origen queda como la primera de la lista, para que el
    -- portal tenga a dónde entrar si alguna vez queda con una sola
    update public.perfiles set notaria_id = p_notarias[1] where id = p_perfil;
end;
$$;

-- Notarías de un usuario concreto, para pintar las casillas al editarlo
create or replace function public.notarias_de_perfil(p_perfil uuid)
returns setof bigint
language sql stable security definer set search_path = public
as $$
    select notaria_id from public.perfil_notarias where perfil_id = p_perfil
    union
    select notaria_id from public.perfiles
     where id = p_perfil and notaria_id is not null;
$$;

-- ------------------------------------------------------------
-- 7) Crear carpeta dentro de una notaría
-- ------------------------------------------------------------
-- La carpeta nueva cae en la notaría que el portal tenga abierta. Se
-- valida que el usuario tenga derecho a esa oficina: si no, podría
-- crear expedientes en una notaría ajena.
create or replace function public.carpeta_fijar_notaria(
    p_carpeta bigint, p_notaria bigint)
returns void
language plpgsql security definer set search_path = public
as $$
begin
    if not public.es_admin() then
        raise exception 'Solo un administrador puede mover una carpeta de notaría.';
    end if;
    if not public.puede_ver_notaria(p_notaria) then
        raise exception 'Notaría no permitida.';
    end if;
    update public.carpetas set notaria_id = p_notaria where id = p_carpeta;
end;
$$;

-- ------------------------------------------------------------
-- 8) Permisos de ejecución
-- ------------------------------------------------------------
-- En PostgreSQL toda función nace con EXECUTE concedido a PUBLIC, y
-- Supabase además concede a anon y authenticated. Revocar solo de anon
-- no basta: el rol hereda de PUBLIC. Hay que revocar de los tres y
-- volver a conceder a quien de verdad lo necesita.
do $$
declare f record;
begin
    for f in
        select oid::regprocedure as firma
          from pg_proc
         where pronamespace = 'public'::regnamespace
           and proname in ('notarias_del_usuario', 'puede_ver_notaria', 'mis_notarias',
                           'notaria_crear', 'notaria_editar', 'perfil_notarias_fijar',
                           'notarias_de_perfil', 'carpeta_fijar_notaria')
    loop
        execute format('revoke execute on function %s from public, anon, authenticated', f.firma);
        execute format('grant  execute on function %s to authenticated', f.firma);
    end loop;
end $$;

-- notarias_del_usuario y puede_ver_notaria SÍ necesitan EXECUTE para
-- 'authenticated', aunque solo las llamen las políticas.
--
-- Las políticas RLS se evalúan con los privilegios de QUIEN CONSULTA,
-- no con los del dueño de la tabla. puede_ver_notaria aparece en las
-- cuatro políticas de lectura de carpetas y notarias_del_usuario en la
-- de notarias: sin este permiso, leer carpetas falla con
-- "permission denied for function puede_ver_notaria" para todos los
-- roles, y el portal se queda sin datos.
--
-- Exponerlas no filtra nada: ambas resuelven desde auth.uid(), así que
-- cada usuario solo obtiene lo suyo.
grant execute on function public.notarias_del_usuario()     to authenticated;
grant execute on function public.puede_ver_notaria(bigint)  to authenticated;
