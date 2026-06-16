-- ============================================================
-- PORTAL DOCUMENTAL — Base de datos para Supabase (PostgreSQL)
-- Fundación de insolvencia y conciliaciones
--
-- Cómo usar: Supabase → SQL Editor → New query → pegar TODO
-- este archivo → Run. (Ver INSTRUCCIONES.md)
--
-- Roles:
--   administrador → control total (carpetas, archivos, usuarios, bitácora)
--   operador      → SOLO sus carpetas asignadas: ve, sube y elimina
--                   archivos y actualiza el estado del trámite
--   cliente       → ve/descarga sus carpetas activas asignadas
--   acreedor      → ve/descarga sus carpetas activas asignadas
-- ============================================================

-- ============================================================
-- 1) TABLAS
-- ============================================================

-- Perfil de cada usuario (complementa auth.users de Supabase)
create table if not exists public.perfiles (
    id      uuid primary key references auth.users (id) on delete cascade,
    usuario text not null unique,
    nombre  text not null,
    rol     text not null default 'cliente'
            check (rol in ('administrador', 'operador', 'cliente', 'acreedor')),
    activo  boolean not null default true,
    creado  timestamptz not null default now()
);

-- Carpetas de procesos
create table if not exists public.carpetas (
    id          bigint generated always as identity primary key,
    nombre      text not null,
    descripcion text not null default '',
    activa      boolean not null default true,
    creada_por  uuid references public.perfiles (id) on delete set null,
    fecha       timestamptz not null default now()
);

-- Qué cliente/acreedor puede ver qué carpeta
create table if not exists public.carpeta_asignados (
    carpeta_id bigint not null references public.carpetas (id) on delete cascade,
    perfil_id  uuid   not null references public.perfiles (id) on delete cascade,
    primary key (carpeta_id, perfil_id)
);

-- Qué operador es responsable de qué carpeta (el operador SOLO
-- ve y trabaja las carpetas donde aparece aquí)
create table if not exists public.carpeta_operadores (
    carpeta_id bigint not null references public.carpetas (id) on delete cascade,
    perfil_id  uuid   not null references public.perfiles (id) on delete cascade,
    primary key (carpeta_id, perfil_id)
);

-- Metadatos de cada archivo (el archivo físico vive en Storage)
create table if not exists public.archivos (
    id                 bigint generated always as identity primary key,
    carpeta_id         bigint not null references public.carpetas (id) on delete cascade,
    nombre             text not null,
    tipo               text not null default '',
    tamano             bigint not null default 0,
    ruta_storage       text not null,      -- convención: <id-carpeta>/<nombre-archivo>
    subido_por         uuid references public.perfiles (id) on delete set null,
    subido_por_usuario text not null default '',  -- nombre visible del actor, para mostrarlo sin exponer perfiles
    fecha              timestamptz not null default now()
);

-- (por si la tabla ya existía de una versión anterior del esquema)
alter table public.archivos add column if not exists subido_por_usuario text not null default '';

-- Bitácora de actividad (centro de notificaciones del administrador):
-- registra ingresos y toda acción sobre carpetas y archivos.
create table if not exists public.actividad (
    id        bigint generated always as identity primary key,
    perfil_id uuid references public.perfiles (id) on delete set null,
    usuario   text not null default '',   -- snapshot del actor
    nombre    text not null default '',
    rol       text not null default '',
    accion    text not null,
    objetivo  text not null default '',
    fecha     timestamptz not null default now()
);

create index if not exists idx_archivos_carpeta on public.archivos (carpeta_id);
create index if not exists idx_asignados_perfil on public.carpeta_asignados (perfil_id);
create index if not exists idx_operadores_perfil on public.carpeta_operadores (perfil_id);
create index if not exists idx_actividad_fecha on public.actividad (fecha desc);
create index if not exists idx_actividad_rol on public.actividad (rol);

-- ============================================================
-- 2) PERFIL AUTOMÁTICO AL REGISTRAR UN USUARIO
--    Seguridad: el rol NUNCA viene del registro (nadie puede
--    auto-nombrarse administrador). El PRIMER usuario creado
--    queda como administrador; los demás nacen como 'cliente'
--    y el administrador les asigna su rol (el portal lo hace
--    automáticamente al crearlos).
-- ============================================================
create or replace function public.crear_perfil_nuevo()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
    total integer;
begin
    select count(*) into total from public.perfiles;
    insert into public.perfiles (id, usuario, nombre, rol)
    values (
        new.id,
        coalesce(new.raw_user_meta_data ->> 'usuario', split_part(new.email, '@', 1)),
        coalesce(new.raw_user_meta_data ->> 'nombre', split_part(new.email, '@', 1)),
        case when total = 0 then 'administrador' else 'cliente' end
    );
    return new;
end;
$$;

drop trigger if exists al_crear_usuario on auth.users;
create trigger al_crear_usuario
    after insert on auth.users
    for each row execute function public.crear_perfil_nuevo();

-- Protección en el servidor: nunca dejar el portal sin un administrador
-- activo. Bloquea eliminar, desactivar o quitarle el rol al último admin,
-- incluso si alguien lo intentara por API saltándose la interfaz.
create or replace function public.proteger_ultimo_admin()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
    otros_admins integer;
begin
    if OLD.rol = 'administrador' and OLD.activo
       and not (TG_OP = 'UPDATE' and NEW.rol = 'administrador' and NEW.activo) then
        select count(*) into otros_admins
        from public.perfiles
        where rol = 'administrador' and activo and id <> OLD.id;
        if otros_admins = 0 then
            raise exception 'No se puede dejar el portal sin ningún administrador activo';
        end if;
    end if;
    if TG_OP = 'DELETE' then return OLD; end if;
    return NEW;
end;
$$;

drop trigger if exists proteger_admin on public.perfiles;
create trigger proteger_admin
    before update or delete on public.perfiles
    for each row execute function public.proteger_ultimo_admin();

-- ============================================================
-- 3) FUNCIONES DE APOYO (qué rol tiene quien está conectado)
--    Un usuario DESACTIVADO no tiene rol → pierde todo acceso.
-- ============================================================
create or replace function public.rol_actual()
returns text
language sql stable security definer set search_path = public
as $$
    select rol from public.perfiles where id = auth.uid() and activo;
$$;

create or replace function public.es_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
    select public.rol_actual() = 'administrador';
$$;

create or replace function public.es_personal()
returns boolean
language sql stable security definer set search_path = public
as $$
    select public.rol_actual() in ('administrador', 'operador');
$$;

-- ¿Es el usuario conectado operador responsable de esta carpeta?
-- Solo cuenta si la carpeta está ACTIVA: si el administrador la desactiva,
-- el operador deja de verla, subir, eliminar y actualizar su estado, hasta
-- que se vuelva a activar.
create or replace function public.es_operador_de(carpeta bigint)
returns boolean
language sql stable security definer set search_path = public
as $$
    select public.rol_actual() = 'operador'
       and exists (
            select 1
            from public.carpeta_operadores o
            join public.carpetas c on c.id = o.carpeta_id
            where o.carpeta_id = carpeta
              and o.perfil_id = auth.uid()
              and c.activa
       );
$$;

-- ¿Puede el usuario conectado ver esta carpeta?
-- admin → todas · operador → solo las suyas · cliente/acreedor → asignadas y activas
create or replace function public.puede_ver_carpeta(carpeta bigint)
returns boolean
language sql stable security definer set search_path = public
as $$
    select public.es_admin()
        or public.es_operador_de(carpeta)
        or exists (
            select 1
            from public.carpetas c
            join public.carpeta_asignados a on a.carpeta_id = c.id
            where c.id = carpeta
              and c.activa
              and a.perfil_id = auth.uid()
              and public.rol_actual() is not null
        );
$$;

-- ¿Puede subir archivos a esta carpeta? (admin, o el operador responsable)
create or replace function public.puede_subir_a_carpeta(carpeta bigint)
returns boolean
language sql stable security definer set search_path = public
as $$
    select public.es_admin() or public.es_operador_de(carpeta);
$$;

-- Actualiza SOLO la descripción (estado del trámite) de una carpeta.
-- La puede usar el admin o el operador responsable; ninguna otra
-- columna se puede tocar por esta vía.
create or replace function public.actualizar_descripcion(carpeta bigint, nueva_descripcion text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
    if not public.puede_subir_a_carpeta(carpeta) then
        raise exception 'Sin permiso para actualizar esta carpeta';
    end if;
    update public.carpetas
       set descripcion = coalesce(nueva_descripcion, '')
     where id = carpeta;
end;
$$;

-- Registra una acción en la bitácora. El actor (usuario/nombre/rol) se
-- toma del servidor según auth.uid(), así NO se puede falsificar quién hizo qué.
create or replace function public.registrar_actividad(p_accion text, p_objetivo text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    perfil record;
begin
    select usuario, nombre, rol into perfil
    from public.perfiles where id = auth.uid() and activo;
    if not found then return; end if;
    insert into public.actividad (perfil_id, usuario, nombre, rol, accion, objetivo)
    values (auth.uid(), perfil.usuario, perfil.nombre, perfil.rol,
            left(coalesce(p_accion, ''), 40), left(coalesce(p_objetivo, ''), 300));
end;
$$;

-- Saca el id de carpeta de una ruta de Storage '<id-carpeta>/archivo.pdf'
create or replace function public.carpeta_de_ruta(ruta text)
returns bigint
language plpgsql immutable
as $$
begin
    return ((string_to_array(ruta, '/'))[1])::bigint;
exception when others then
    return null;
end;
$$;

-- ============================================================
-- 4) SEGURIDAD POR FILAS (RLS)
--    Cada consulta se filtra EN EL SERVIDOR según el rol;
--    nadie puede saltársela desde el navegador.
-- ============================================================
alter table public.perfiles           enable row level security;
alter table public.carpetas           enable row level security;
alter table public.carpeta_asignados  enable row level security;
alter table public.carpeta_operadores enable row level security;
alter table public.archivos           enable row level security;
alter table public.actividad          enable row level security;

-- Limpieza de reglas de versiones anteriores (cuando el operador veía todo)
drop policy if exists "personal ve todas las carpetas" on public.carpetas;
drop policy if exists "personal sube archivos" on public.archivos;
drop policy if exists "personal sube documentos" on storage.objects;

-- PERFILES
drop policy if exists "ver mi propio perfil" on public.perfiles;
create policy "ver mi propio perfil" on public.perfiles
    for select using (id = auth.uid());

drop policy if exists "admin ve todos los perfiles" on public.perfiles;
create policy "admin ve todos los perfiles" on public.perfiles
    for select using (public.es_admin());

drop policy if exists "admin actualiza perfiles" on public.perfiles;
create policy "admin actualiza perfiles" on public.perfiles
    for update using (public.es_admin()) with check (public.es_admin());

drop policy if exists "admin elimina perfiles" on public.perfiles;
create policy "admin elimina perfiles" on public.perfiles
    for delete using (public.es_admin());

-- CARPETAS
drop policy if exists "admin ve todas las carpetas" on public.carpetas;
create policy "admin ve todas las carpetas" on public.carpetas
    for select using (public.es_admin());

drop policy if exists "operador ve sus carpetas" on public.carpetas;
create policy "operador ve sus carpetas" on public.carpetas
    for select using (public.es_operador_de(id));

drop policy if exists "asignados ven sus carpetas activas" on public.carpetas;
create policy "asignados ven sus carpetas activas" on public.carpetas
    for select using (
        activa
        and public.rol_actual() is not null
        and exists (
            select 1 from public.carpeta_asignados a
            where a.carpeta_id = id and a.perfil_id = auth.uid()
        )
    );

drop policy if exists "admin crea carpetas" on public.carpetas;
create policy "admin crea carpetas" on public.carpetas
    for insert with check (public.es_admin());

drop policy if exists "admin edita carpetas" on public.carpetas;
create policy "admin edita carpetas" on public.carpetas
    for update using (public.es_admin()) with check (public.es_admin());

drop policy if exists "admin elimina carpetas" on public.carpetas;
create policy "admin elimina carpetas" on public.carpetas
    for delete using (public.es_admin());

-- ASIGNACIONES (clientes/acreedores que ven la carpeta)
drop policy if exists "ver asignaciones propias o del personal" on public.carpeta_asignados;
create policy "ver asignaciones propias o del personal" on public.carpeta_asignados
    for select using (
        public.es_admin()
        or perfil_id = auth.uid()
        or public.es_operador_de(carpeta_id)
    );

drop policy if exists "admin gestiona asignaciones" on public.carpeta_asignados;
create policy "admin gestiona asignaciones" on public.carpeta_asignados
    for all using (public.es_admin()) with check (public.es_admin());

-- OPERADORES RESPONSABLES de cada carpeta
drop policy if exists "ver operadores propios o admin" on public.carpeta_operadores;
create policy "ver operadores propios o admin" on public.carpeta_operadores
    for select using (public.es_admin() or perfil_id = auth.uid());

drop policy if exists "admin gestiona operadores" on public.carpeta_operadores;
create policy "admin gestiona operadores" on public.carpeta_operadores
    for all using (public.es_admin()) with check (public.es_admin());

-- ARCHIVOS (metadatos)
drop policy if exists "ver archivos segun carpeta" on public.archivos;
create policy "ver archivos segun carpeta" on public.archivos
    for select using (public.puede_ver_carpeta(carpeta_id));

drop policy if exists "sube admin u operador de la carpeta" on public.archivos;
create policy "sube admin u operador de la carpeta" on public.archivos
    for insert with check (public.puede_subir_a_carpeta(carpeta_id));

drop policy if exists "admin elimina archivos" on public.archivos;
drop policy if exists "elimina admin u operador de la carpeta" on public.archivos;
create policy "elimina admin u operador de la carpeta" on public.archivos
    for delete using (public.puede_subir_a_carpeta(carpeta_id));

-- ACTIVIDAD (bitácora): solo el administrador la lee; se escribe únicamente
-- por la función registrar_actividad (no hay política de insert directo).
drop policy if exists "admin ve actividad" on public.actividad;
create policy "admin ve actividad" on public.actividad
    for select using (public.es_admin());

-- ============================================================
-- 5) STORAGE: bucket privado para los documentos
--    Convención de rutas: <id-carpeta>/<nombre-archivo>
-- ============================================================
insert into storage.buckets (id, name, public)
values ('documentos', 'documentos', false)
on conflict (id) do nothing;

-- Límite de 50 MB por archivo (también lo valida el navegador)
update storage.buckets set file_size_limit = 52428800 where id = 'documentos';

drop policy if exists "sube documentos admin u operador" on storage.objects;
create policy "sube documentos admin u operador" on storage.objects
    for insert with check (
        bucket_id = 'documentos'
        and public.puede_subir_a_carpeta(public.carpeta_de_ruta(name))
    );

drop policy if exists "descarga segun carpeta asignada" on storage.objects;
create policy "descarga segun carpeta asignada" on storage.objects
    for select using (
        bucket_id = 'documentos'
        and public.puede_ver_carpeta(public.carpeta_de_ruta(name))
    );

drop policy if exists "admin borra documentos" on storage.objects;
drop policy if exists "borra documentos admin u operador" on storage.objects;
create policy "borra documentos admin u operador" on storage.objects
    for delete using (
        bucket_id = 'documentos'
        and public.puede_subir_a_carpeta(public.carpeta_de_ruta(name))
    );

-- ============================================================
-- Fin. Ahora crea los usuarios en Authentication → Users
-- y ajusta su rol en Table Editor → perfiles.
-- ============================================================
