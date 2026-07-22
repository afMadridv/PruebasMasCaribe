-- ============================================================
-- PORTAL DOCUMENTAL — Base de datos PostgreSQL

-- TABLAS
-- ============================================================

-- Perfil de cada usuario (complementa auth.users de Supabase)
create table if not exists public.perfiles (
    id      uuid primary key references auth.users (id) on delete cascade,
    usuario text not null unique,
    nombre  text not null,
    rol     text not null default 'cliente'
            check (rol in ('administrador', 'operador', 'cliente', 'acreedor')),
    activo  boolean not null default true,
    correo  text,                          -- correo de contacto (opcional), para avisos
    creado  timestamptz not null default now()
);

-- (por si la tabla ya existía de una versión anterior del esquema)
alter table public.perfiles add column if not exists correo text;

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

-- Orden manual de los documentos dentro de la carpeta ("Editar documentos"
-- y "Generar expediente"): menor número = más arriba. NULL = sin ordenar
-- (se muestra por fecha). Solo se cambia por la función
-- actualizar_orden_archivos (más abajo), nunca por update directo.
alter table public.archivos add column if not exists orden integer;

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

-- Carpeta a la que pertenece la acción (si aplica): permite que el operador
-- vea las notificaciones de SU carpeta (ingresos, vistas y descargas de las
-- partes del trámite) sin acceder a la bitácora global del administrador.
alter table public.actividad add column if not exists carpeta_id bigint references public.carpetas (id) on delete set null;

-- Mensajería del trámite por carpeta. Dos canales:
--   'cliente'  → conversación cliente ↔ operador
--   'acreedor' → conversación acreedor ↔ operador
-- El administrador ve y escribe en ambos; el cliente solo en el suyo y el
-- acreedor solo en el suyo (validado por RLS más abajo).
create table if not exists public.mensajes (
    id            bigint generated always as identity primary key,
    carpeta_id    bigint not null references public.carpetas (id) on delete cascade,
    canal         text not null check (canal in ('cliente', 'acreedor')),
    perfil_id     uuid references public.perfiles (id) on delete set null,
    autor_usuario text not null default '',   -- snapshot del actor
    autor_nombre  text not null default '',
    rol           text not null default '',
    texto         text not null,
    fecha         timestamptz not null default now()
);

-- Adjuntos en el chat: un mensaje puede llevar un archivo (el contenido vive
-- en Storage bajo 'chat/<id-carpeta>/<canal>/...'; aquí solo los metadatos).
-- (por si la tabla ya existía de una versión anterior del esquema)
alter table public.mensajes add column if not exists archivo_nombre text not null default '';
alter table public.mensajes add column if not exists archivo_ruta   text not null default '';
alter table public.mensajes add column if not exists archivo_tamano bigint not null default 0;
alter table public.mensajes add column if not exists archivo_tipo   text not null default '';

-- Audiencias del proceso: fechas marcadas por el operador en el calendario
-- de la carpeta. Las gestionan el administrador y el operador responsable;
-- las VEN también el deudor y los acreedores de la carpeta (calendario del
-- trámite) y además se pueden notificar por correo.
create table if not exists public.audiencias (
    id         bigint generated always as identity primary key,
    carpeta_id bigint not null references public.carpetas (id) on delete cascade,
    titulo     text not null default '',
    fecha      date not null,
    hora       text not null default '',   -- 'HH:MM' (texto simple, lo pone el operador)
    enlace     text not null default '',   -- link de Meet (opcional)
    creado_por uuid references public.perfiles (id) on delete set null,
    creado     timestamptz not null default now()
);

-- Recordatorios personales por carpeta: SOLO los ve quien los crea.
-- Mientras la fecha de hoy esté dentro del rango, el portal muestra la
-- ventana emergente al ingresar.
create table if not exists public.recordatorios (
    id           bigint generated always as identity primary key,
    perfil_id    uuid not null references public.perfiles (id) on delete cascade,
    carpeta_id   bigint not null references public.carpetas (id) on delete cascade,
    mensaje      text not null,
    fecha_inicio date not null,
    fecha_fin    date not null,
    creado       timestamptz not null default now()
);

-- Información del deudor y su apoderado (INF. DEUDOR, Ley 2445 de 2025).
-- Una sola fila por carpeta. Acceso por dos capas (ver RLS más abajo):
-- admin y operador responsable leen/escriben; el cliente asignado SOLO lee
-- la suya; el acreedor NO accede bajo ninguna circunstancia (ni lectura).
create table if not exists public.deudores_info (
    id           bigint generated always as identity primary key,
    carpeta_id   bigint not null references public.carpetas (id) on delete cascade unique,
    nombre       text not null default '',
    cedula       text not null default '',
    actividad    text not null default '',
    empleador    text not null default '',
    estado_civil text not null default '',
    correo       text not null default '',
    apoderado_nombre text not null default '',
    apoderado_cedula text not null default '',
    apoderado_tp     text not null default '',
    apoderado_correo text not null default '',
    actualizado  timestamptz not null default now()
);

create index if not exists idx_archivos_carpeta on public.archivos (carpeta_id);
create index if not exists idx_asignados_perfil on public.carpeta_asignados (perfil_id);
create index if not exists idx_operadores_perfil on public.carpeta_operadores (perfil_id);
create index if not exists idx_actividad_fecha on public.actividad (fecha desc);
create index if not exists idx_actividad_rol on public.actividad (rol);
create index if not exists idx_mensajes_carpeta on public.mensajes (carpeta_id, canal, fecha);
create index if not exists idx_actividad_carpeta on public.actividad (carpeta_id, fecha desc);
create index if not exists idx_audiencias_carpeta on public.audiencias (carpeta_id, fecha);
create index if not exists idx_recordatorios_perfil on public.recordatorios (perfil_id, fecha_fin);

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

-- ¿El usuario conectado está asignado a esta carpeta ACTIVA con alguno de
-- estos roles? (sirve para los chats: cliente o acreedor de la carpeta)
create or replace function public.es_asignado_de(carpeta bigint, roles text[])
returns boolean
language sql stable security definer set search_path = public
as $$
    select public.rol_actual() = any(roles)
       and exists (
            select 1
            from public.carpeta_asignados a
            join public.carpetas c on c.id = a.carpeta_id
            where a.carpeta_id = carpeta
              and a.perfil_id = auth.uid()
              and c.activa
       );
$$;

-- ¿Puede el usuario conectado ver/escribir en este canal de chat de la carpeta?
--   admin            → ambos canales
--   operador resp.   → ambos canales
--   cliente asignado → solo el canal 'cliente'
--   acreedor asignado→ solo el canal 'acreedor'
create or replace function public.puede_chat(carpeta bigint, canal_chat text)
returns boolean
language sql stable security definer set search_path = public
as $$
    select public.es_admin()
        or public.es_operador_de(carpeta)
        or (canal_chat = 'cliente'  and public.es_asignado_de(carpeta, array['cliente']))
        or (canal_chat = 'acreedor' and public.es_asignado_de(carpeta, array['acreedor']));
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
-- p_carpeta (opcional) vincula la acción a una carpeta, para que el operador
-- responsable pueda ver la actividad de SUS procesos.
-- (se elimina la firma anterior de 2 parámetros para que la llamada RPC no sea ambigua)
drop function if exists public.registrar_actividad(text, text);
create or replace function public.registrar_actividad(p_accion text, p_objetivo text, p_carpeta bigint default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    perfil record;
begin
    select usuario, nombre, rol into perfil
    from public.perfiles where id = auth.uid() and activo;
    if not found then return; end if;
    insert into public.actividad (perfil_id, usuario, nombre, rol, accion, objetivo, carpeta_id)
    values (auth.uid(), perfil.usuario, perfil.nombre, perfil.rol,
            left(coalesce(p_accion, ''), 40), left(coalesce(p_objetivo, ''), 300), p_carpeta);
end;
$$;

-- Guarda el orden manual de los documentos de una carpeta. Recibe los ids
-- en el orden deseado y numera desde 1. SOLO toca la columna 'orden' y SOLO
-- de archivos de esa carpeta; la puede usar el admin o el operador responsable.
create or replace function public.actualizar_orden_archivos(carpeta bigint, ids bigint[])
returns void
language plpgsql security definer set search_path = public
as $$
begin
    if not public.puede_subir_a_carpeta(carpeta) then
        raise exception 'Sin permiso para ordenar los documentos de esta carpeta';
    end if;
    update public.archivos a
       set orden = pos.n
      from unnest(ids) with ordinality as pos(id_archivo, n)
     where a.id = pos.id_archivo
       and a.carpeta_id = carpeta;
end;
$$;

-- Devuelve las personas asignadas a una carpeta (deudor/cliente y acreedores)
-- con su id y correo de contacto: para la notificación de audiencias y para
-- dirigir mensajes a UN acreedor. Solo la usa el personal de la carpeta.
-- (el DROP es necesario: una versión anterior devolvía otras columnas y
--  Postgres no permite cambiar el tipo de retorno con create or replace)
drop function if exists public.asignados_de_carpeta(bigint);
create or replace function public.asignados_de_carpeta(carpeta bigint)
returns table (id uuid, usuario text, nombre text, rol text, correo text)
language plpgsql stable security definer set search_path = public
as $$
begin
    if not public.puede_subir_a_carpeta(carpeta) then
        raise exception 'Sin permiso para consultar los asignados de esta carpeta';
    end if;
    return query
        select p.id, p.usuario, p.nombre, p.rol, coalesce(p.correo, '')
        from public.carpeta_asignados a
        join public.perfiles p on p.id = a.perfil_id
        where a.carpeta_id = carpeta and p.activo
        order by p.rol, p.nombre;
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

-- Rutas de adjuntos de chat: 'chat/<id-carpeta>/<canal>/archivo.pdf'
create or replace function public.chat_carpeta_de_ruta(ruta text)
returns bigint
language plpgsql immutable
as $$
begin
    return (split_part(ruta, '/', 2))::bigint;
exception when others then
    return null;
end;
$$;

create or replace function public.chat_canal_de_ruta(ruta text)
returns text
language plpgsql immutable
as $$
begin
    return split_part(ruta, '/', 3);
exception when others then
    return null;
end;
$$;

-- El servidor fija la fecha de actualización de deudores_info (no se confía
-- en la hora del navegador).
create or replace function public.tocar_actualizado()
returns trigger
language plpgsql
as $$
begin
    new.actualizado := now();
    return new;
end;
$$;

drop trigger if exists deudores_tocar_actualizado on public.deudores_info;
create trigger deudores_tocar_actualizado
    before update on public.deudores_info
    for each row execute function public.tocar_actualizado();

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
alter table public.mensajes           enable row level security;
alter table public.deudores_info      enable row level security;
alter table public.audiencias         enable row level security;
alter table public.recordatorios      enable row level security;

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

-- ACTIVIDAD (bitácora): el administrador lee todo; el operador SOLO la
-- actividad vinculada a sus carpetas (notificaciones del trámite). Se escribe
-- únicamente por la función registrar_actividad (no hay política de insert directo).
drop policy if exists "admin ve actividad" on public.actividad;
create policy "admin ve actividad" on public.actividad
    for select using (public.es_admin());

drop policy if exists "operador ve actividad de sus carpetas" on public.actividad;
create policy "operador ve actividad de sus carpetas" on public.actividad
    for select using (carpeta_id is not null and public.es_operador_de(carpeta_id));

-- AUDIENCIAS: las VEN todos los de la carpeta (deudor y acreedores incluidos,
-- para el calendario del trámite); solo el personal (admin u operador
-- responsable) las crea, edita o elimina.
drop policy if exists "personal ve audiencias" on public.audiencias;
drop policy if exists "ven audiencias los de la carpeta" on public.audiencias;
create policy "ven audiencias los de la carpeta" on public.audiencias
    for select using (public.puede_ver_carpeta(carpeta_id));

drop policy if exists "personal gestiona audiencias" on public.audiencias;
create policy "personal gestiona audiencias" on public.audiencias
    for all using (public.puede_subir_a_carpeta(carpeta_id))
        with check (public.puede_subir_a_carpeta(carpeta_id));

-- RECORDATORIOS: privados. Cada quien ve, crea, edita y borra SOLO los suyos
-- (y debe ser personal con acceso de gestión a la carpeta al crearlos).
drop policy if exists "recordatorios propios" on public.recordatorios;
create policy "recordatorios propios" on public.recordatorios
    for select using (perfil_id = auth.uid());

drop policy if exists "crear recordatorio propio" on public.recordatorios;
create policy "crear recordatorio propio" on public.recordatorios
    for insert with check (perfil_id = auth.uid() and public.puede_subir_a_carpeta(carpeta_id));

drop policy if exists "editar recordatorio propio" on public.recordatorios;
create policy "editar recordatorio propio" on public.recordatorios
    for update using (perfil_id = auth.uid()) with check (perfil_id = auth.uid());

drop policy if exists "borrar recordatorio propio" on public.recordatorios;
create policy "borrar recordatorio propio" on public.recordatorios
    for delete using (perfil_id = auth.uid());

-- MENSAJES (chats del trámite): cada quien ve y escribe SOLO en el canal que
-- le corresponde (cliente o acreedor); el operador responsable y el
-- administrador acceden a ambos. Todo validado EN EL SERVIDOR.
drop policy if exists "ver mensajes del canal" on public.mensajes;
create policy "ver mensajes del canal" on public.mensajes
    for select using (public.puede_chat(carpeta_id, canal));

drop policy if exists "escribir mensajes del canal" on public.mensajes;
create policy "escribir mensajes del canal" on public.mensajes
    for insert with check (public.puede_chat(carpeta_id, canal));

drop policy if exists "admin borra mensajes" on public.mensajes;
create policy "admin borra mensajes" on public.mensajes
    for delete using (public.es_admin());

-- INFO DEUDOR (deudores_info): dos capas de acceso. OJO: NO se usa
-- puede_ver_carpeta porque esa función también deja pasar al acreedor.
--   admin                 → lee y escribe todo
--   operador responsable  → lee y escribe la de su carpeta
--   cliente asignado      → SOLO lee la de su propia carpeta
--   acreedor              → SIN acceso (ni lectura): no aparece en ninguna regla
drop policy if exists "ver info deudor" on public.deudores_info;
create policy "ver info deudor" on public.deudores_info
    for select using (
        public.es_admin()
        or public.es_operador_de(carpeta_id)
        or public.es_asignado_de(carpeta_id, array['cliente'])
    );

drop policy if exists "crea info deudor admin u operador" on public.deudores_info;
create policy "crea info deudor admin u operador" on public.deudores_info
    for insert with check (public.puede_subir_a_carpeta(carpeta_id));

drop policy if exists "edita info deudor admin u operador" on public.deudores_info;
create policy "edita info deudor admin u operador" on public.deudores_info
    for update using (public.puede_subir_a_carpeta(carpeta_id))
            with check (public.puede_subir_a_carpeta(carpeta_id));

drop policy if exists "admin borra info deudor" on public.deudores_info;
create policy "admin borra info deudor" on public.deudores_info
    for delete using (public.es_admin());

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

-- ADJUNTOS DE CHAT ('chat/<id-carpeta>/<canal>/...'): puede subir y descargar
-- quien puede escribir en ese canal (cliente en el suyo, acreedor en el suyo,
-- operador responsable y admin en ambos) — misma regla puede_chat que los
-- mensajes. carpeta_de_ruta devuelve null para 'chat/...', así que las
-- políticas de documentos de carpeta no aplican a estas rutas.
drop policy if exists "chat sube adjuntos" on storage.objects;
create policy "chat sube adjuntos" on storage.objects
    for insert with check (
        bucket_id = 'documentos'
        and name like 'chat/%'
        and public.puede_chat(public.chat_carpeta_de_ruta(name), public.chat_canal_de_ruta(name))
    );

drop policy if exists "chat descarga adjuntos" on storage.objects;
create policy "chat descarga adjuntos" on storage.objects
    for select using (
        bucket_id = 'documentos'
        and name like 'chat/%'
        and public.puede_chat(public.chat_carpeta_de_ruta(name), public.chat_canal_de_ruta(name))
    );

drop policy if exists "admin borra adjuntos de chat" on storage.objects;
create policy "admin borra adjuntos de chat" on storage.objects
    for delete using (
        bucket_id = 'documentos'
        and name like 'chat/%'
        and public.es_admin()
    );

-- ============================================================
-- 6) ROL MONITOR (solo lectura global)
--    Igual al administrador pero SIN editar ni eliminar nada y
--    SIN acceso a la pestaña de usuarios del portal (aunque sí
--    lee los perfiles para mostrar nombres en las vistas).
-- ============================================================
alter table public.perfiles drop constraint if exists perfiles_rol_check;
alter table public.perfiles add constraint perfiles_rol_check
    check (rol in ('administrador', 'monitor', 'operador', 'cliente', 'acreedor'));

create or replace function public.es_monitor()
returns boolean
language sql stable security definer set search_path = public
as $$
    select public.rol_actual() = 'monitor';
$$;

-- El monitor entra a TODO en modo lectura: se agrega a puede_ver_carpeta
-- (cubre archivos, audiencias y descargas de Storage por las reglas ya creadas).
create or replace function public.puede_ver_carpeta(carpeta bigint)
returns boolean
language sql stable security definer set search_path = public
as $$
    select public.es_admin()
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
        );
$$;

drop policy if exists "monitor ve todos los perfiles" on public.perfiles;
create policy "monitor ve todos los perfiles" on public.perfiles
    for select using (public.es_monitor());

drop policy if exists "monitor ve todas las carpetas" on public.carpetas;
create policy "monitor ve todas las carpetas" on public.carpetas
    for select using (public.es_monitor());

drop policy if exists "monitor ve asignaciones" on public.carpeta_asignados;
create policy "monitor ve asignaciones" on public.carpeta_asignados
    for select using (public.es_monitor());

drop policy if exists "monitor ve operadores" on public.carpeta_operadores;
create policy "monitor ve operadores" on public.carpeta_operadores
    for select using (public.es_monitor());

drop policy if exists "monitor ve actividad" on public.actividad;
create policy "monitor ve actividad" on public.actividad
    for select using (public.es_monitor());

drop policy if exists "monitor ve mensajes" on public.mensajes;
create policy "monitor ve mensajes" on public.mensajes
    for select using (public.es_monitor());

drop policy if exists "monitor ve info deudor" on public.deudores_info;
create policy "monitor ve info deudor" on public.deudores_info
    for select using (public.es_monitor());

drop policy if exists "monitor descarga adjuntos de chat" on storage.objects;
create policy "monitor descarga adjuntos de chat" on storage.objects
    for select using (
        bucket_id = 'documentos'
        and name like 'chat/%'
        and public.es_monitor()
    );

-- ============================================================
-- 7) SEMÁFOROS DE PROCESOS POR DÍAS HÁBILES COLOMBIANOS
--    Cada carpeta (trámite) tiene procesos con plazo en días
--    hábiles (lun–vie sin festivos de Colombia). El semáforo:
--      verde   → completado o faltan 2+ días hábiles
--      naranja → hoy es el último día hábil o falta 1
--      rojo    → vencido sin completar
--      pausado → el trámite está en pausa (el reloj se detiene)
--    La MISMA lista de festivos vive en js/diasHabiles.js:
--    si se agrega un año aquí, agregarlo allá.
-- ============================================================

-- Festivos oficiales de Colombia (Ley 51 de 1983)
create table if not exists public.festivos_colombia (
    id     bigint generated always as identity primary key,
    fecha  date not null unique,
    nombre text not null default '',
    anio   int generated always as (extract(year from fecha)::int) stored
);

insert into public.festivos_colombia (fecha, nombre) values
    -- 2024
    ('2024-01-01','Año Nuevo'),('2024-01-08','Reyes Magos'),('2024-03-25','San José'),
    ('2024-03-28','Jueves Santo'),('2024-03-29','Viernes Santo'),('2024-05-01','Día del Trabajo'),
    ('2024-05-13','Ascensión del Señor'),('2024-06-03','Corpus Christi'),('2024-06-10','Sagrado Corazón'),
    ('2024-07-01','San Pedro y San Pablo'),('2024-07-20','Independencia de Colombia'),('2024-08-07','Batalla de Boyacá'),
    ('2024-08-19','Asunción de la Virgen'),('2024-10-14','Día de la Raza'),('2024-11-04','Todos los Santos'),
    ('2024-11-11','Independencia de Cartagena'),('2024-12-08','Inmaculada Concepción'),('2024-12-25','Navidad'),
    -- 2025
    ('2025-01-01','Año Nuevo'),('2025-01-06','Reyes Magos'),('2025-03-24','San José'),
    ('2025-04-17','Jueves Santo'),('2025-04-18','Viernes Santo'),('2025-05-01','Día del Trabajo'),
    ('2025-06-02','Ascensión del Señor'),('2025-06-23','Corpus Christi'),('2025-06-30','Sagrado Corazón / San Pedro y San Pablo'),
    ('2025-07-20','Independencia de Colombia'),('2025-08-07','Batalla de Boyacá'),('2025-08-18','Asunción de la Virgen'),
    ('2025-10-13','Día de la Raza'),('2025-11-03','Todos los Santos'),('2025-11-17','Independencia de Cartagena'),
    ('2025-12-08','Inmaculada Concepción'),('2025-12-25','Navidad'),
    -- 2026
    ('2026-01-01','Año Nuevo'),('2026-01-12','Reyes Magos'),('2026-03-23','San José'),
    ('2026-04-02','Jueves Santo'),('2026-04-03','Viernes Santo'),('2026-05-01','Día del Trabajo'),
    ('2026-05-18','Ascensión del Señor'),('2026-06-08','Corpus Christi'),('2026-06-15','Sagrado Corazón'),
    ('2026-06-29','San Pedro y San Pablo'),('2026-07-20','Independencia de Colombia'),('2026-08-07','Batalla de Boyacá'),
    ('2026-08-17','Asunción de la Virgen'),('2026-10-12','Día de la Raza'),('2026-11-02','Todos los Santos'),
    ('2026-11-16','Independencia de Cartagena'),('2026-12-08','Inmaculada Concepción'),('2026-12-25','Navidad'),
    -- 2027
    ('2027-01-01','Año Nuevo'),('2027-01-11','Reyes Magos'),('2027-03-22','San José'),
    ('2027-03-25','Jueves Santo'),('2027-03-26','Viernes Santo'),('2027-05-01','Día del Trabajo'),
    ('2027-05-10','Ascensión del Señor'),('2027-05-31','Corpus Christi'),('2027-06-07','Sagrado Corazón'),
    ('2027-07-05','San Pedro y San Pablo'),('2027-07-20','Independencia de Colombia'),('2027-08-07','Batalla de Boyacá'),
    ('2027-08-16','Asunción de la Virgen'),('2027-10-18','Día de la Raza'),('2027-11-01','Todos los Santos'),
    ('2027-11-15','Independencia de Cartagena'),('2027-12-08','Inmaculada Concepción'),('2027-12-25','Navidad')
on conflict (fecha) do nothing;

alter table public.festivos_colombia enable row level security;

drop policy if exists "todos leen festivos" on public.festivos_colombia;
create policy "todos leen festivos" on public.festivos_colombia
    for select using (auth.uid() is not null);

drop policy if exists "admin gestiona festivos" on public.festivos_colombia;
create policy "admin gestiona festivos" on public.festivos_colombia
    for all using (public.es_admin()) with check (public.es_admin());

-- ---- Funciones de días hábiles (mismas reglas que js/diasHabiles.js) ----
create or replace function public.es_dia_habil(f date)
returns boolean
language sql stable security definer set search_path = public
as $$
    select extract(isodow from f) < 6
       and not exists (select 1 from public.festivos_colombia where fecha = f);
$$;

-- Suma N días hábiles (el conteo empieza DESPUÉS de la fecha dada)
create or replace function public.sumar_dias_habiles(f date, n int)
returns date
language plpgsql stable security definer set search_path = public
as $$
declare
    d date := f;
    faltan int := greatest(coalesce(n, 0), 0);
begin
    while faltan > 0 loop
        d := d + 1;
        if public.es_dia_habil(d) then faltan := faltan - 1; end if;
    end loop;
    return d;
end;
$$;

-- Días hábiles ENTRE dos fechas (excluye la inicial, incluye la final).
-- Negativo si fecha_fin < fecha_inicio (días hábiles de atraso).
create or replace function public.contar_dias_habiles(f_inicio date, f_fin date)
returns int
language plpgsql stable security definer set search_path = public
as $$
declare
    d date;
    tope date;
    cuenta int := 0;
    signo int := 1;
begin
    if f_fin < f_inicio then
        d := f_fin; tope := f_inicio; signo := -1;
    else
        d := f_inicio; tope := f_fin;
    end if;
    while d < tope loop
        d := d + 1;
        if public.es_dia_habil(d) then cuenta := cuenta + 1; end if;
    end loop;
    return cuenta * signo;
end;
$$;

-- Vencimiento de un plazo de N días hábiles contados desde f_inicio.
-- Si f_inicio no es hábil, el plazo corre desde el siguiente día hábil.
create or replace function public.calcular_vencimiento_habil(f_inicio date, dias int)
returns date
language plpgsql stable security definer set search_path = public
as $$
declare
    d date := f_inicio;
begin
    if not public.es_dia_habil(d) then
        while not public.es_dia_habil(d) loop d := d + 1; end loop;
        return public.sumar_dias_habiles(d, greatest(dias, 1) - 1);
    end if;
    return public.sumar_dias_habiles(d, greatest(dias, 1));
end;
$$;

-- ---- Pausa del trámite a nivel de carpeta ----
alter table public.carpetas add column if not exists pausado boolean not null default false;
alter table public.carpetas add column if not exists fecha_pausa date;
alter table public.carpetas add column if not exists fecha_reactivacion date;

-- ---- Procesos del trámite (semáforo por días hábiles) ----
create table if not exists public.procesos_tramite (
    id                        bigint generated always as identity primary key,
    carpeta_id                bigint not null references public.carpetas (id) on delete cascade,
    nombre                    text not null,                 -- "Aceptación", "Litigación", ...
    dias_habiles_limite       int not null check (dias_habiles_limite > 0),
    orden                     int not null default 1,
    completado                boolean not null default false,
    fecha_inicio_proceso      date not null default current_date,
    fecha_inicio_proceso_habil date,                         -- primer día hábil del plazo
    fecha_vencimiento_habil   date not null,
    fecha_completado          date,
    completado_por            uuid references public.perfiles (id) on delete set null,
    pausado                   boolean not null default false,
    fecha_pausa               date,
    dias_restantes_al_pausar  int,
    fecha_reactivacion        date,
    -- El administrador puede fijar el semáforo a mano (null = automático)
    semaforo_manual           text check (semaforo_manual is null or semaforo_manual in ('verde', 'naranja', 'rojo')),
    editado_por               uuid references public.perfiles (id) on delete set null,
    editado                   timestamptz,
    creado_por                uuid references public.perfiles (id) on delete set null,
    creado                    timestamptz not null default now()
);

create index if not exists idx_procesos_carpeta on public.procesos_tramite (carpeta_id, orden);
create index if not exists idx_procesos_vencimiento on public.procesos_tramite (fecha_vencimiento_habil) where not completado;

alter table public.procesos_tramite enable row level security;

-- Los VEN todos los de la carpeta (y el monitor); se escriben ÚNICAMENTE
-- por las funciones de abajo (no hay políticas de escritura directa).
drop policy if exists "ver procesos de la carpeta" on public.procesos_tramite;
create policy "ver procesos de la carpeta" on public.procesos_tramite
    for select using (public.puede_ver_carpeta(carpeta_id));

-- Crea un proceso dentro del trámite (admin u operador responsable).
create or replace function public.crear_proceso_tramite(carpeta bigint, p_nombre text, p_dias int, p_orden int default null)
returns bigint
language plpgsql security definer set search_path = public
as $$
declare
    en_pausa boolean;
    nuevo_id bigint;
    inicio_habil date;
begin
    if not public.puede_subir_a_carpeta(carpeta) then
        raise exception 'Sin permiso para crear procesos en esta carpeta';
    end if;
    if p_nombre is null or trim(p_nombre) = '' then
        raise exception 'El proceso necesita un nombre';
    end if;
    if p_dias is null or p_dias <= 0 then
        raise exception 'El plazo en días hábiles debe ser mayor que cero';
    end if;
    select pausado into en_pausa from public.carpetas where id = carpeta;
    if en_pausa then
        raise exception 'El trámite está pausado: reactívalo antes de crear procesos';
    end if;
    inicio_habil := current_date;
    while not public.es_dia_habil(inicio_habil) loop inicio_habil := inicio_habil + 1; end loop;
    insert into public.procesos_tramite
        (carpeta_id, nombre, dias_habiles_limite, orden,
         fecha_inicio_proceso, fecha_inicio_proceso_habil, fecha_vencimiento_habil, creado_por)
    values
        (carpeta, left(trim(p_nombre), 120), p_dias,
         coalesce(p_orden, (select coalesce(max(orden), 0) + 1 from public.procesos_tramite where carpeta_id = carpeta)),
         current_date, inicio_habil,
         public.calcular_vencimiento_habil(current_date, p_dias), auth.uid())
    returning id into nuevo_id;
    return nuevo_id;
end;
$$;

-- Marca un proceso como completado. El operador NO puede completar un
-- proceso ya vencido (solo el administrador puede corregirlo).
create or replace function public.completar_proceso(proceso bigint)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    p record;
begin
    select * into p from public.procesos_tramite where id = proceso;
    if not found then raise exception 'Proceso no encontrado'; end if;
    if not public.puede_subir_a_carpeta(p.carpeta_id) then
        raise exception 'Sin permiso para actualizar este proceso';
    end if;
    if p.completado then raise exception 'Este proceso ya estaba completado'; end if;
    if p.pausado then raise exception 'El trámite está pausado: reactívalo primero'; end if;
    if current_date > p.fecha_vencimiento_habil and not public.es_admin() then
        raise exception 'El plazo ya venció: solo el administrador puede marcarlo como completado';
    end if;
    update public.procesos_tramite
       set completado = true, fecha_completado = current_date,
           completado_por = auth.uid(), semaforo_manual = null
     where id = proceso;
end;
$$;

-- Corrección del administrador: puede ajustar nombre, plazo, vencimiento,
-- estado de completado y fijar el semáforo a mano ('' = volver a automático).
-- Queda registrado quién editó y cuándo.
create or replace function public.editar_proceso_admin(
    proceso bigint,
    p_nombre text default null,
    p_dias int default null,
    p_vencimiento date default null,
    p_completado boolean default null,
    p_semaforo text default null
)
returns void
language plpgsql security definer set search_path = public
as $$
begin
    if not public.es_admin() then
        raise exception 'Solo el administrador puede corregir procesos';
    end if;
    if p_dias is not null and p_dias <= 0 then
        raise exception 'El plazo en días hábiles debe ser mayor que cero';
    end if;
    if p_semaforo is not null and p_semaforo not in ('', 'verde', 'naranja', 'rojo') then
        raise exception 'Semáforo no válido';
    end if;
    update public.procesos_tramite set
        nombre = coalesce(left(trim(p_nombre), 120), nombre),
        dias_habiles_limite = coalesce(p_dias, dias_habiles_limite),
        fecha_vencimiento_habil = coalesce(p_vencimiento, fecha_vencimiento_habil),
        completado = coalesce(p_completado, completado),
        fecha_completado = case
            when p_completado is true then coalesce(fecha_completado, current_date)
            when p_completado is false then null
            else fecha_completado end,
        semaforo_manual = case
            when p_semaforo is null then semaforo_manual
            when p_semaforo = '' then null
            else p_semaforo end,
        editado_por = auth.uid(),
        editado = now()
    where id = proceso;
    if not found then raise exception 'Proceso no encontrado'; end if;
end;
$$;

-- Elimina un proceso (admin u operador responsable de la carpeta)
create or replace function public.eliminar_proceso(proceso bigint)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    carpeta bigint;
begin
    select carpeta_id into carpeta from public.procesos_tramite where id = proceso;
    if not found then raise exception 'Proceso no encontrado'; end if;
    if not public.puede_subir_a_carpeta(carpeta) then
        raise exception 'Sin permiso para eliminar este proceso';
    end if;
    delete from public.procesos_tramite where id = proceso;
end;
$$;

-- ============================================================
-- 8) SEMÁFORO CENTRALIZADO (única fuente de verdad) Y CONTEO
--    DEL TRÁMITE COMPLETO: 60 días hábiles (90 con prórroga)
-- ============================================================

-- El color del semáforo se calcula SOLO aquí (el navegador únicamente
-- pinta lo que recibe de listar_procesos):
--   pausado → 'pausado' · completado → 'verde' · manual del admin manda
--   vencido (fecha < hoy) → 'rojo' · quedan 0–1 días hábiles → 'naranja'
--   quedan 2+ → 'verde'
create or replace function public.calcular_semaforo(
    p_completado boolean,
    p_pausado boolean,
    p_semaforo_manual text,
    p_vencimiento date
)
returns text
language plpgsql stable security definer set search_path = public
as $$
declare
    restantes int;
begin
    if p_pausado then return 'pausado'; end if;
    if p_completado then return 'verde'; end if;
    if p_semaforo_manual in ('verde', 'naranja', 'rojo') then return p_semaforo_manual; end if;
    if p_vencimiento is null then return 'verde'; end if;
    if p_vencimiento < current_date then return 'rojo'; end if;
    restantes := public.contar_dias_habiles(current_date, p_vencimiento);
    if restantes <= 1 then return 'naranja'; end if;
    return 'verde';
end;
$$;

-- Procesos de una carpeta (o de TODAS las visibles si carpeta es null)
-- con el semáforo y los días hábiles restantes YA calculados en el servidor.
create or replace function public.listar_procesos(carpeta bigint default null)
returns table (
    id bigint, carpeta_id bigint, nombre text, dias_habiles_limite int, orden int,
    completado boolean, fecha_inicio_proceso date, fecha_inicio_proceso_habil date,
    fecha_vencimiento_habil date, fecha_completado date, pausado boolean,
    dias_restantes_al_pausar int, fecha_reactivacion date, semaforo_manual text,
    creado timestamptz, semaforo text, dias_restantes int
)
language plpgsql stable security definer set search_path = public
as $$
begin
    if carpeta is not null and not public.puede_ver_carpeta(carpeta) then
        raise exception 'Sin permiso para ver los procesos de esta carpeta';
    end if;
    return query
    select p.id, p.carpeta_id, p.nombre, p.dias_habiles_limite, p.orden,
           p.completado, p.fecha_inicio_proceso, p.fecha_inicio_proceso_habil,
           p.fecha_vencimiento_habil, p.fecha_completado, p.pausado,
           p.dias_restantes_al_pausar, p.fecha_reactivacion, p.semaforo_manual,
           p.creado,
           public.calcular_semaforo(p.completado, p.pausado, p.semaforo_manual, p.fecha_vencimiento_habil),
           case when p.completado or p.pausado then null
                else public.contar_dias_habiles(current_date, p.fecha_vencimiento_habil) end
    from public.procesos_tramite p
    where case when carpeta is null then public.puede_ver_carpeta(p.carpeta_id)
               else p.carpeta_id = carpeta end
    order by p.carpeta_id, p.orden, p.id;
end;
$$;

-- ---- Conteo del trámite completo (a nivel de carpeta) ----
alter table public.carpetas add column if not exists fecha_inicio_tramite date;
alter table public.carpetas add column if not exists dias_habiles_tramite int not null default 60;
alter table public.carpetas drop constraint if exists carpetas_dias_habiles_tramite_check;
alter table public.carpetas add constraint carpetas_dias_habiles_tramite_check
    check (dias_habiles_tramite in (60, 90));
alter table public.carpetas add column if not exists tiene_prorroga boolean not null default false;
alter table public.carpetas add column if not exists fecha_vencimiento_tramite date;
alter table public.carpetas add column if not exists dias_restantes_tramite_al_pausar int;

-- Pausa/reactivación AMPLIADAS: congelan y reanudan también el vencimiento
-- del trámite completo, igual que ya lo hacían con cada proceso.
create or replace function public.pausar_tramite(carpeta bigint)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    en_pausa boolean;
begin
    if not public.puede_subir_a_carpeta(carpeta) then
        raise exception 'Sin permiso para pausar este trámite';
    end if;
    select pausado into en_pausa from public.carpetas where id = carpeta for update;
    if en_pausa is null then raise exception 'Carpeta no encontrada'; end if;
    if en_pausa then raise exception 'El trámite ya estaba pausado'; end if;
    update public.carpetas
       set pausado = true, fecha_pausa = current_date, fecha_reactivacion = null,
           dias_restantes_tramite_al_pausar = case
               when fecha_vencimiento_tramite is null then null
               else greatest(public.contar_dias_habiles(current_date, fecha_vencimiento_tramite), 0) end
     where id = carpeta;
    update public.procesos_tramite
       set pausado = true, fecha_pausa = current_date,
           dias_restantes_al_pausar = greatest(public.contar_dias_habiles(current_date, fecha_vencimiento_habil), 0)
     where carpeta_id = carpeta and not completado;
end;
$$;

create or replace function public.reactivar_tramite(carpeta bigint)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    en_pausa boolean;
begin
    if not public.puede_subir_a_carpeta(carpeta) then
        raise exception 'Sin permiso para reactivar este trámite';
    end if;
    select pausado into en_pausa from public.carpetas where id = carpeta for update;
    if en_pausa is null then raise exception 'Carpeta no encontrada'; end if;
    if not en_pausa then raise exception 'El trámite no está pausado'; end if;
    update public.carpetas
       set pausado = false, fecha_reactivacion = current_date,
           fecha_vencimiento_tramite = case
               when dias_restantes_tramite_al_pausar is null then fecha_vencimiento_tramite
               else public.sumar_dias_habiles(current_date, dias_restantes_tramite_al_pausar) end,
           dias_restantes_tramite_al_pausar = null
     where id = carpeta;
    update public.procesos_tramite
       set pausado = false, fecha_reactivacion = current_date, fecha_pausa = null,
           fecha_vencimiento_habil = public.sumar_dias_habiles(current_date, coalesce(dias_restantes_al_pausar, 0))
     where carpeta_id = carpeta and not completado and pausado;
end;
$$;

-- ============================================================
-- 9) CHAT DE SOPORTE (admin ↔ operador), LEÍDO/NO LEÍDO,
--    LLAMADAS DE SOPORTE Y TIEMPO REAL
-- ============================================================

-- Un hilo de soporte por operador; cualquier administrador lo atiende.
create table if not exists public.mensajes_soporte (
    id           bigint generated always as identity primary key,
    operador_id  uuid not null references public.perfiles (id) on delete cascade, -- dueño del hilo
    autor_id     uuid not null references public.perfiles (id) on delete cascade, -- quién escribió
    autor_nombre text not null default '',   -- snapshot del actor
    rol          text not null default '',
    texto        text not null,
    leido        boolean not null default false,
    fecha_leido  timestamptz,
    fecha        timestamptz not null default now()
);
create index if not exists idx_msoporte_operador on public.mensajes_soporte (operador_id, fecha);

alter table public.mensajes_soporte enable row level security;

create or replace function public.puede_soporte(operador uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
    select public.es_admin()
        or (public.rol_actual() = 'operador' and operador = auth.uid());
$$;

drop policy if exists "ver soporte propio o admin" on public.mensajes_soporte;
create policy "ver soporte propio o admin" on public.mensajes_soporte
    for select using (public.puede_soporte(operador_id) or public.es_monitor());

drop policy if exists "escribir soporte" on public.mensajes_soporte;
create policy "escribir soporte" on public.mensajes_soporte
    for insert with check (public.puede_soporte(operador_id) and autor_id = auth.uid());

drop policy if exists "admin borra soporte" on public.mensajes_soporte;
create policy "admin borra soporte" on public.mensajes_soporte
    for delete using (public.es_admin());

-- Leído/no leído en los chats de carpeta
alter table public.mensajes add column if not exists leido boolean not null default false;
alter table public.mensajes add column if not exists fecha_leido timestamptz;

create or replace function public.marcar_leidos_de_canal(carpeta bigint, canal_chat text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
    if not public.puede_chat(carpeta, canal_chat) then
        raise exception 'Sin permiso sobre este chat';
    end if;
    update public.mensajes
       set leido = true, fecha_leido = now()
     where carpeta_id = carpeta and canal = canal_chat
       and not leido
       and (perfil_id is distinct from auth.uid());
end;
$$;

create or replace function public.marcar_leidos_soporte(operador uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
    if not public.puede_soporte(operador) then
        raise exception 'Sin permiso sobre este chat de soporte';
    end if;
    update public.mensajes_soporte
       set leido = true, fecha_leido = now()
     where operador_id = operador
       and not leido
       and autor_id <> auth.uid();
end;
$$;

-- Contadores de no leídos (solo mensajes AJENOS) para el usuario conectado
create or replace function public.no_leidos_chats()
returns table (carpeta_id bigint, canal text, no_leidos bigint)
language plpgsql stable security definer set search_path = public
as $$
begin
    return query
    select m.carpeta_id, m.canal, count(*)
    from public.mensajes m
    where not m.leido
      and (m.perfil_id is distinct from auth.uid())
      and public.puede_chat(m.carpeta_id, m.canal)
    group by m.carpeta_id, m.canal;
end;
$$;

create or replace function public.no_leidos_soporte()
returns table (operador_id uuid, no_leidos bigint)
language plpgsql stable security definer set search_path = public
as $$
begin
    return query
    select m.operador_id, count(*)
    from public.mensajes_soporte m
    where not m.leido
      and m.autor_id <> auth.uid()
      and public.puede_soporte(m.operador_id)
    group by m.operador_id;
end;
$$;

-- LLAMADAS: solo el administrador crea la fila (el servidor lo exige);
-- la señalización WebRTC viaja por Supabase Realtime broadcast y el
-- destinatario solo se une si existe una llamada dirigida a él.
create table if not exists public.llamadas_soporte (
    id         uuid primary key default gen_random_uuid(),
    iniciador  uuid not null references public.perfiles (id) on delete cascade,
    destino    uuid not null references public.perfiles (id) on delete cascade,
    estado     text not null default 'sonando'
               check (estado in ('sonando', 'aceptada', 'rechazada', 'terminada', 'perdida')),
    creado     timestamptz not null default now()
);
create index if not exists idx_llamadas_destino on public.llamadas_soporte (destino, creado desc);

alter table public.llamadas_soporte enable row level security;

drop policy if exists "participantes ven la llamada" on public.llamadas_soporte;
create policy "participantes ven la llamada" on public.llamadas_soporte
    for select using (iniciador = auth.uid() or destino = auth.uid());

drop policy if exists "solo admin inicia llamadas" on public.llamadas_soporte;
create policy "solo admin inicia llamadas" on public.llamadas_soporte
    for insert with check (
        public.es_admin()
        and iniciador = auth.uid()
        and exists (select 1 from public.perfiles p
                    where p.id = destino and p.activo
                      and p.rol in ('operador', 'cliente', 'acreedor'))
    );

drop policy if exists "participantes actualizan estado" on public.llamadas_soporte;
create policy "participantes actualizan estado" on public.llamadas_soporte
    for update using (iniciador = auth.uid() or destino = auth.uid())
        with check (iniciador = auth.uid() or destino = auth.uid());

-- Tiempo real: la publicación supabase_realtime estaba vacía; se publican
-- las tablas de chat para recibir mensajes al instante en el navegador.
do $$
begin
    begin
        alter publication supabase_realtime add table public.mensajes;
    exception when duplicate_object then null;
    end;
    begin
        alter publication supabase_realtime add table public.mensajes_soporte;
    exception when duplicate_object then null;
    end;
    begin
        alter publication supabase_realtime add table public.llamadas_soporte;
    exception when duplicate_object then null;
    end;
end $$;

-- ============================================================
-- 10) NOTIFICACIONES por destinatario (campana del portal)
--     Cada quien ve SOLO las suyas (el admin también solo las suyas).
--     Se insertan únicamente desde los triggers de abajo.
--     El admin NUNCA recibe notificación de los chats cliente-operador
--     ni acreedor-operador: el filtro vive en notif_mensaje_nuevo.
-- ============================================================
create table if not exists public.notificaciones (
    id              bigint generated always as identity primary key,
    destinatario_id uuid not null references public.perfiles (id) on delete cascade,
    tipo            text not null,
    mensaje         text not null default '',
    carpeta_id      bigint references public.carpetas (id) on delete cascade,
    referencia_id   bigint,
    leido           boolean not null default false,
    fecha           timestamptz not null default now()
);
create index if not exists idx_notif_destinatario on public.notificaciones (destinatario_id, leido, fecha desc);

alter table public.notificaciones enable row level security;

drop policy if exists "ver mis notificaciones" on public.notificaciones;
create policy "ver mis notificaciones" on public.notificaciones
    for select using (destinatario_id = auth.uid());

drop policy if exists "marcar mis notificaciones" on public.notificaciones;
create policy "marcar mis notificaciones" on public.notificaciones
    for update using (destinatario_id = auth.uid())
        with check (destinatario_id = auth.uid());

drop policy if exists "borrar mis notificaciones" on public.notificaciones;
create policy "borrar mis notificaciones" on public.notificaciones
    for delete using (destinatario_id = auth.uid());

create or replace function public._notificar(destino uuid, p_tipo text, p_mensaje text, p_carpeta bigint default null, p_ref bigint default null)
returns void
language plpgsql security definer set search_path = public
as $$
begin
    if destino is null then return; end if;
    insert into public.notificaciones (destinatario_id, tipo, mensaje, carpeta_id, referencia_id)
    values (destino, left(coalesce(p_tipo, ''), 40), left(coalesce(p_mensaje, ''), 300), p_carpeta, p_ref);
end;
$$;

create or replace function public._notificar_admins(p_tipo text, p_mensaje text, p_carpeta bigint default null, p_ref bigint default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    a record;
begin
    for a in select id from public.perfiles where rol = 'administrador' and activo and id is distinct from auth.uid()
    loop
        perform public._notificar(a.id, p_tipo, p_mensaje, p_carpeta, p_ref);
    end loop;
end;
$$;

-- Mensaje del personal → SOLO al cliente/acreedor del canal (nunca al admin)
create or replace function public.notif_mensaje_nuevo()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
    d record;
    nom text;
begin
    if new.rol in ('operador', 'administrador') then
        select nombre into nom from public.carpetas where id = new.carpeta_id;
        for d in
            select p.id from public.carpeta_asignados a
            join public.perfiles p on p.id = a.perfil_id
            where a.carpeta_id = new.carpeta_id and p.activo
              and p.rol = new.canal
              and p.id is distinct from new.perfil_id
        loop
            perform public._notificar(d.id, 'mensaje-nuevo',
                'Nuevo mensaje del operador en tu trámite «' || coalesce(nom, '') || '»',
                new.carpeta_id, new.id);
        end loop;
    end if;
    return new;
end;
$$;
drop trigger if exists notif_mensaje on public.mensajes;
create trigger notif_mensaje after insert on public.mensajes
    for each row execute function public.notif_mensaje_nuevo();

-- Archivo nuevo → clientes/acreedores asignados
create or replace function public.notif_archivo_nuevo()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
    d record;
    nom text;
begin
    select nombre into nom from public.carpetas where id = new.carpeta_id;
    for d in
        select p.id from public.carpeta_asignados a
        join public.perfiles p on p.id = a.perfil_id
        where a.carpeta_id = new.carpeta_id and p.activo
          and p.rol in ('cliente', 'acreedor')
    loop
        perform public._notificar(d.id, 'archivo-nuevo',
            'Nuevo documento «' || new.nombre || '» en tu trámite «' || coalesce(nom, '') || '»',
            new.carpeta_id, new.id);
    end loop;
    return new;
end;
$$;
drop trigger if exists notif_archivo on public.archivos;
create trigger notif_archivo after insert on public.archivos
    for each row execute function public.notif_archivo_nuevo();

-- Operador escribe en soporte → aviso a administradores
create or replace function public.notif_soporte_nuevo()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
    if new.rol = 'operador' then
        perform public._notificar_admins('soporte',
            coalesce(new.autor_nombre, 'Un operador') || ' pide soporte: «' || left(new.texto, 120) || '»',
            null, new.id);
    end if;
    return new;
end;
$$;
drop trigger if exists notif_soporte on public.mensajes_soporte;
create trigger notif_soporte after insert on public.mensajes_soporte
    for each row execute function public.notif_soporte_nuevo();

-- Cambios de procesos (completado/semáforo) y trámite finalizado → admins
create or replace function public.notif_proceso_cambio()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
    nom text;
    pendientes int;
begin
    select nombre into nom from public.carpetas where id = new.carpeta_id;
    if new.completado is distinct from old.completado then
        perform public._notificar_admins('proceso-estado',
            'El proceso «' || new.nombre || '» de «' || coalesce(nom, '') || '» ' ||
            case when new.completado then 'fue completado' else 'volvió a pendiente' end,
            new.carpeta_id, new.id);
        if new.completado then
            select count(*) into pendientes from public.procesos_tramite
            where carpeta_id = new.carpeta_id and not completado;
            if pendientes = 0 then
                perform public._notificar_admins('tramite-finalizado',
                    'Todos los procesos de «' || coalesce(nom, '') || '» quedaron completados',
                    new.carpeta_id, null);
            end if;
        end if;
    end if;
    if new.semaforo_manual is distinct from old.semaforo_manual then
        perform public._notificar_admins('proceso-semaforo',
            'El semáforo del proceso «' || new.nombre || '» de «' || coalesce(nom, '') || '» cambió a ' ||
            coalesce(new.semaforo_manual, 'automático'),
            new.carpeta_id, new.id);
    end if;
    return new;
end;
$$;
drop trigger if exists notif_proceso on public.procesos_tramite;
create trigger notif_proceso after update on public.procesos_tramite
    for each row execute function public.notif_proceso_cambio();

-- Pausa / reactivación / prórroga → admins
create or replace function public.notif_carpeta_cambio()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
    if new.pausado is distinct from old.pausado then
        perform public._notificar_admins(case when new.pausado then 'tramite-pausado' else 'tramite-reactivado' end,
            'El trámite «' || new.nombre || '» fue ' || case when new.pausado then 'pausado' else 'reactivado' end,
            new.id, null);
    end if;
    if new.tiene_prorroga and not old.tiene_prorroga then
        perform public._notificar_admins('tramite-prorroga',
            'Se aplicó la prórroga (90 días hábiles) al trámite «' || new.nombre || '»',
            new.id, null);
    end if;
    return new;
end;
$$;
drop trigger if exists notif_carpeta on public.carpetas;
create trigger notif_carpeta after update on public.carpetas
    for each row execute function public.notif_carpeta_cambio();

-- Plazos vencidos (sin tarea nocturna): el portal del ADMIN la llama al
-- refrescar la campana; genera la notificación UNA sola vez por proceso.
create or replace function public.generar_notificaciones_vencidos()
returns void
language plpgsql security definer set search_path = public
as $$
declare
    p record;
    nom text;
begin
    if not public.es_admin() then return; end if;
    for p in
        select pt.id, pt.nombre, pt.carpeta_id
        from public.procesos_tramite pt
        where not pt.completado and not pt.pausado
          and pt.fecha_vencimiento_habil < current_date
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
        from public.perfiles a where a.rol = 'administrador' and a.activo;
    end loop;
end;
$$;

create or replace function public.marcar_notificaciones_leidas(ids bigint[] default null)
returns void
language plpgsql security definer set search_path = public
as $$
begin
    update public.notificaciones
       set leido = true
     where destinatario_id = auth.uid()
       and not leido
       and (ids is null or id = any(ids));
end;
$$;

do $$
begin
    begin
        alter publication supabase_realtime add table public.notificaciones;
    exception when duplicate_object then null;
    end;
end $$;

-- ============================================================
-- 11) CONSENTIMIENTO DE DATOS Y PESO CACHEADO POR CARPETA
-- ============================================================
alter table public.perfiles add column if not exists primer_login boolean not null default true;

create table if not exists public.consentimientos (
    id               bigint generated always as identity primary key,
    perfil_id        uuid not null references public.perfiles (id) on delete cascade,
    fecha_aceptacion timestamptz not null default now(),
    version_politica text not null default '1.0'
);
create index if not exists idx_consent_perfil on public.consentimientos (perfil_id);

alter table public.consentimientos enable row level security;

drop policy if exists "admin ve consentimientos" on public.consentimientos;
create policy "admin ve consentimientos" on public.consentimientos
    for select using (public.es_admin() or perfil_id = auth.uid());

create or replace function public.aceptar_consentimiento(p_version text default '1.0')
returns void
language plpgsql security definer set search_path = public
as $$
begin
    if auth.uid() is null then raise exception 'No autenticado'; end if;
    insert into public.consentimientos (perfil_id, version_politica)
    values (auth.uid(), left(coalesce(p_version, '1.0'), 20));
    update public.perfiles set primer_login = false where id = auth.uid();
end;
$$;

create or replace function public.listar_consentimientos()
returns table (usuario text, nombre text, rol text, fecha_aceptacion timestamptz, version_politica text)
language plpgsql stable security definer set search_path = public
as $$
begin
    if not (public.es_admin() or public.es_monitor()) then
        raise exception 'Solo la administración puede ver los consentimientos';
    end if;
    return query
    select p.usuario, p.nombre, p.rol, c.fecha_aceptacion, c.version_politica
    from public.consentimientos c
    join public.perfiles p on p.id = c.perfil_id
    order by c.fecha_aceptacion desc;
end;
$$;

-- Peso total (MB) y nº de documentos por carpeta, cacheados y mantenidos por
-- trigger (cubre TODAS las vías de subida/eliminación/edición de archivos).
alter table public.carpetas add column if not exists peso_total_mb numeric(12,2) not null default 0;
alter table public.carpetas add column if not exists total_archivos int not null default 0;

create or replace function public.actualizar_peso_carpeta()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
    objetivo bigint := coalesce(new.carpeta_id, old.carpeta_id);
begin
    update public.carpetas c
       set peso_total_mb = coalesce((select round(sum(a.tamano) / 1048576.0, 2)
                                     from public.archivos a where a.carpeta_id = objetivo), 0),
           total_archivos = coalesce((select count(*) from public.archivos a
                                      where a.carpeta_id = objetivo), 0)
     where c.id = objetivo;
    if tg_op = 'UPDATE' and new.carpeta_id is distinct from old.carpeta_id then
        update public.carpetas c
           set peso_total_mb = coalesce((select round(sum(a.tamano) / 1048576.0, 2)
                                         from public.archivos a where a.carpeta_id = old.carpeta_id), 0),
               total_archivos = coalesce((select count(*) from public.archivos a
                                          where a.carpeta_id = old.carpeta_id), 0)
         where c.id = old.carpeta_id;
    end if;
    return null;
end;
$$;

drop trigger if exists peso_carpeta on public.archivos;
create trigger peso_carpeta after insert or update or delete on public.archivos
    for each row execute function public.actualizar_peso_carpeta();

update public.carpetas c
   set peso_total_mb = coalesce((select round(sum(a.tamano) / 1048576.0, 2)
                                 from public.archivos a where a.carpeta_id = c.id), 0),
       total_archivos = coalesce((select count(*) from public.archivos a
                                  where a.carpeta_id = c.id), 0);

-- ============================================================
-- 12) BACKLOG: última conexión, detalle de audiencias, fin de
--     trámite, prórroga para operadores e hilos por acreedor
-- ============================================================

-- Última conexión (la marca cada usuario al entrar al portal)
alter table public.perfiles add column if not exists ultima_conexion timestamptz;

create or replace function public.registrar_conexion()
returns void
language plpgsql security definer set search_path = public
as $$
begin
    if auth.uid() is null then return; end if;
    update public.perfiles set ultima_conexion = now() where id = auth.uid();
end;
$$;

-- Detalle libre en cada audiencia del calendario
alter table public.audiencias add column if not exists descripcion text not null default '';

-- Fin de trámite: EXCLUSIVO del administrador
alter table public.carpetas add column if not exists finalizado boolean not null default false;
alter table public.carpetas add column if not exists fecha_fin_tramite date;

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
       set finalizado = true, fecha_fin_tramite = current_date
     where id = carpeta;
end;
$$;

create or replace function public.notif_fin_tramite()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
    if new.finalizado and not old.finalizado then
        perform public._notificar_admins('tramite-fin',
            'El administrador dio FIN al trámite «' || new.nombre || '»', new.id, null);
    end if;
    return new;
end;
$$;
drop trigger if exists notif_fin on public.carpetas;
create trigger notif_fin after update on public.carpetas
    for each row execute function public.notif_fin_tramite();

-- La prórroga ahora la puede aplicar también el OPERADOR responsable, y ni
-- la prórroga ni el inicio del conteo corren sobre un trámite finalizado.
create or replace function public.aplicar_prorroga(carpeta bigint)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    c record;
begin
    if not public.puede_subir_a_carpeta(carpeta) then
        raise exception 'Sin permiso para aplicar la prórroga a este trámite';
    end if;
    select * into c from public.carpetas where id = carpeta for update;
    if not found then raise exception 'Carpeta no encontrada'; end if;
    if c.finalizado then raise exception 'El trámite ya está finalizado'; end if;
    if c.fecha_inicio_tramite is null then
        raise exception 'El trámite aún no tiene conteo iniciado: usa iniciar_tramite primero';
    end if;
    if c.tiene_prorroga then raise exception 'El trámite ya tiene la prórroga aplicada'; end if;
    if c.pausado then raise exception 'El trámite está pausado: reactívalo antes de aplicar la prórroga'; end if;
    update public.carpetas
       set dias_habiles_tramite = 90,
           tiene_prorroga = true,
           fecha_vencimiento_tramite = public.calcular_vencimiento_habil(c.fecha_inicio_tramite, 90)
     where id = carpeta;
end;
$$;

create or replace function public.iniciar_tramite(carpeta bigint, p_fecha date default current_date)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    c record;
    f date := coalesce(p_fecha, current_date);
begin
    if not public.puede_subir_a_carpeta(carpeta) then
        raise exception 'Sin permiso para iniciar el conteo de este trámite';
    end if;
    select * into c from public.carpetas where id = carpeta for update;
    if not found then raise exception 'Carpeta no encontrada'; end if;
    if c.finalizado then raise exception 'El trámite ya está finalizado'; end if;
    if c.pausado then raise exception 'El trámite está pausado: reactívalo antes de iniciar el conteo'; end if;
    if c.fecha_inicio_tramite is not null then
        raise exception 'El conteo del trámite ya fue iniciado el %', c.fecha_inicio_tramite;
    end if;
    update public.carpetas
       set fecha_inicio_tramite = f,
           dias_habiles_tramite = 60,
           tiene_prorroga = false,
           fecha_vencimiento_tramite = public.calcular_vencimiento_habil(f, 60),
           dias_restantes_tramite_al_pausar = null
     where id = carpeta;
end;
$$;

-- Hilos por acreedor en el canal 'acreedor':
--   acreedor escribe → destinatario_id null (va al personal)
--   personal escribe → destinatario_id = acreedor elegido, o null = TODOS
-- Cada acreedor SOLO ve su propio hilo (y los avisos "para todos").
alter table public.mensajes add column if not exists destinatario_id uuid references public.perfiles (id) on delete set null;

create or replace function public.es_personal_de_chat(carpeta bigint)
returns boolean
language sql stable security definer set search_path = public
as $$
    select public.es_admin() or public.es_operador_de(carpeta);
$$;

drop policy if exists "ver mensajes del canal" on public.mensajes;
create policy "ver mensajes del canal" on public.mensajes
    for select using (
        public.puede_chat(carpeta_id, canal)
        and (
            canal = 'cliente'
            or public.rol_actual() <> 'acreedor'
            or perfil_id = auth.uid()
            or destinatario_id = auth.uid()
            or (destinatario_id is null and rol in ('operador', 'administrador'))
        )
    );

drop policy if exists "escribir mensajes del canal" on public.mensajes;
create policy "escribir mensajes del canal" on public.mensajes
    for insert with check (
        public.puede_chat(carpeta_id, canal)
        and (public.es_personal_de_chat(carpeta_id) or destinatario_id is null)
    );

-- ============================================================
-- 13) PRE-DESPLIEGUE: integridad de autor y avisos de ingreso
-- ============================================================

-- Storage: límite por archivo subido a 100 MB
update storage.buckets set file_size_limit = 104857600 where id = 'documentos';

-- Nadie puede firmar como otro: el autor de mensajes/archivos DEBE ser el
-- usuario conectado, y un trigger sobreescribe los snapshots con los datos
-- reales del perfil (aunque el navegador mande otros).
drop policy if exists "escribir mensajes del canal" on public.mensajes;
create policy "escribir mensajes del canal" on public.mensajes
    for insert with check (
        public.puede_chat(carpeta_id, canal)
        and perfil_id = auth.uid()
        and (public.es_personal_de_chat(carpeta_id) or destinatario_id is null)
    );

drop policy if exists "sube admin u operador de la carpeta" on public.archivos;
create policy "sube admin u operador de la carpeta" on public.archivos
    for insert with check (
        public.puede_subir_a_carpeta(carpeta_id)
        and subido_por = auth.uid()
    );

create or replace function public.fijar_autor_mensaje()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
    p record;
begin
    select usuario, nombre, rol into p from public.perfiles where id = auth.uid();
    if found then
        new.perfil_id := auth.uid();
        new.autor_usuario := p.usuario;
        new.autor_nombre := p.nombre;
        new.rol := p.rol;
    end if;
    return new;
end;
$$;
drop trigger if exists autor_mensaje on public.mensajes;
create trigger autor_mensaje before insert on public.mensajes
    for each row execute function public.fijar_autor_mensaje();

create or replace function public.fijar_autor_archivo()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
    p record;
begin
    select nombre into p from public.perfiles where id = auth.uid();
    if found then
        new.subido_por := auth.uid();
        new.subido_por_usuario := p.nombre;
    end if;
    return new;
end;
$$;
drop trigger if exists autor_archivo on public.archivos;
create trigger autor_archivo before insert on public.archivos
    for each row execute function public.fijar_autor_archivo();

-- Aviso de ingreso propio en la campana del administrador (fecha/hora),
-- estilo "nuevo inicio de sesión". Lo llama el portal al ingresar.
create or replace function public.notificar_mi_ingreso()
returns void
language plpgsql security definer set search_path = public
as $$
declare
    p record;
begin
    select nombre, rol into p from public.perfiles where id = auth.uid() and activo;
    if not found then return; end if;
    if p.rol <> 'administrador' then return; end if;
    insert into public.notificaciones (destinatario_id, tipo, mensaje, carpeta_id, referencia_id)
    values (auth.uid(), 'ingreso-propio',
            'Ingreso al portal el ' || to_char(now() at time zone 'America/Bogota', 'DD/MM/YYYY') ||
            ' a las ' || to_char(now() at time zone 'America/Bogota', 'HH12:MI AM'),
            null, null);
end;
$$;

-- ============================================================
-- 14) OLVIDÉ MI CONTRASEÑA Y ADJUNTOS DE SOPORTE
-- ============================================================
create table if not exists public.solicitudes_clave (
    id           bigint generated always as identity primary key,
    usuario      text not null,
    estado       text not null default 'pendiente' check (estado in ('pendiente','resuelta')),
    fecha        timestamptz not null default now(),
    resuelta_por uuid references public.perfiles (id) on delete set null,
    fecha_resuelta timestamptz
);
create index if not exists idx_solicitudes_estado on public.solicitudes_clave (estado, fecha desc);
alter table public.solicitudes_clave enable row level security;

drop policy if exists "admin ve solicitudes de clave" on public.solicitudes_clave;
create policy "admin ve solicitudes de clave" on public.solicitudes_clave
    for select using (public.es_admin());
drop policy if exists "admin resuelve solicitudes de clave" on public.solicitudes_clave;
create policy "admin resuelve solicitudes de clave" on public.solicitudes_clave
    for update using (public.es_admin()) with check (public.es_admin());

-- La llama quien olvidó su clave (SIN sesión). Silencio si no existe (no
-- revela usuarios) y no duplica pendientes; avisa a los administradores.
create or replace function public.solicitar_restablecimiento(p_usuario text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    u text := lower(trim(coalesce(p_usuario, '')));
begin
    if u = '' or length(u) > 30 then return; end if;
    if not exists (select 1 from public.perfiles where usuario = u and activo) then return; end if;
    if exists (select 1 from public.solicitudes_clave where usuario = u and estado = 'pendiente') then return; end if;
    insert into public.solicitudes_clave (usuario) values (u);
    perform public._notificar_admins('solicitud-clave',
        'El usuario «' || u || '» olvidó su contraseña y solicita restablecerla', null, null);
end;
$$;

create or replace function public.resolver_solicitud_clave(solicitud bigint)
returns void
language plpgsql security definer set search_path = public
as $$
begin
    if not public.es_admin() then raise exception 'Solo el administrador puede resolver solicitudes'; end if;
    update public.solicitudes_clave
       set estado = 'resuelta', resuelta_por = auth.uid(), fecha_resuelta = now()
     where id = solicitud and estado = 'pendiente';
end;
$$;

-- Adjuntos del chat de soporte ('soporte/<uuid-operador>/...')
alter table public.mensajes_soporte add column if not exists archivo_nombre text not null default '';
alter table public.mensajes_soporte add column if not exists archivo_ruta   text not null default '';
alter table public.mensajes_soporte add column if not exists archivo_tamano bigint not null default 0;
alter table public.mensajes_soporte add column if not exists archivo_tipo   text not null default '';

create or replace function public.soporte_operador_de_ruta(ruta text)
returns uuid language plpgsql immutable as $$
begin
    return (split_part(ruta, '/', 2))::uuid;
exception when others then return null;
end; $$;

drop policy if exists "soporte sube adjuntos" on storage.objects;
create policy "soporte sube adjuntos" on storage.objects
    for insert with check (bucket_id = 'documentos' and name like 'soporte/%'
        and public.puede_soporte(public.soporte_operador_de_ruta(name)));
drop policy if exists "soporte descarga adjuntos" on storage.objects;
create policy "soporte descarga adjuntos" on storage.objects
    for select using (bucket_id = 'documentos' and name like 'soporte/%'
        and public.puede_soporte(public.soporte_operador_de_ruta(name)));
drop policy if exists "admin borra adjuntos de soporte" on storage.objects;
create policy "admin borra adjuntos de soporte" on storage.objects
    for delete using (bucket_id = 'documentos' and name like 'soporte/%' and public.es_admin());

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
-- 15) DESCARGA POR ARCHIVO: el operador decide qué ven las partes
-- ============================================================
-- Cada documento lleva una marca "descargable por las partes". El personal
-- (admin, operador, monitor) siempre descarga todo; el cliente y el acreedor
-- solo descargan los archivos marcados como disponibles. La regla se aplica en
-- Storage, no solo en la interfaz.

alter table public.archivos add column if not exists descargable_partes boolean not null default true;

-- ¿El usuario actual puede descargar el objeto de Storage en esta ruta?
create or replace function public.puede_descargar_archivo(ruta text)
returns boolean
language sql stable security definer set search_path = public
as $$
    select public.puede_ver_carpeta(public.carpeta_de_ruta(ruta))
       and (
           public.rol_actual() in ('administrador', 'operador', 'monitor')
           or coalesce(
               (select a.descargable_partes from public.archivos a where a.ruta_storage = ruta limit 1),
               true)
       );
$$;

-- La descarga de documentos pasa a respetar la marca por archivo
drop policy if exists "descarga segun carpeta asignada" on storage.objects;
create policy "descarga segun carpeta asignada" on storage.objects
    for select using (
        bucket_id = 'documentos'
        and public.puede_descargar_archivo(name)
    );

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
