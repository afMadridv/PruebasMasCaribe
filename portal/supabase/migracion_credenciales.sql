-- ============================================================
-- MIGRACIÓN: credenciales asignadas
-- ============================================================
-- Idempotente: se puede correr varias veces sin romper nada.
--
-- POR QUÉ NO SE PUEDE "MOSTRAR LA CONTRASEÑA ACTUAL"
--   auth.users guarda la contraseña como hash bcrypt ($2a$10$...), que
--   es de una sola dirección. El texto original no está guardado en
--   ninguna parte: ni Supabase, ni el dueño de la base, ni nadie con la
--   service_role key puede leerlo, porque no existe. No es una
--   restricción que se pueda saltar; es cómo funciona un hash.
--
-- LO QUE SÍ SE PUEDE, Y RESUELVE EL MISMO PROBLEMA
--   En este portal NO hay cambio de contraseña por cuenta propia: no
--   existe ninguna pantalla donde el usuario se la cambie. TODAS las
--   contraseñas las pone el administrador, al crear la cuenta o al
--   restablecerla. Así que guardar lo que el administrador escribe no
--   recupera nada: anota lo que él mismo eligió. Y como nadie más la
--   cambia, ese valor coincide siempre con la contraseña vigente.
--
--   Resultado práctico: el Excel de usuarios sale con las credenciales
--   y no hay que restablecerle la clave a nadie cada vez que la olvida.
--
-- EL RIESGO, DICHO CLARO
--   Estas contraseñas quedan legibles para cualquiera con acceso de
--   administrador o con un volcado de la base, y son de clientes y
--   acreedores reales, que además suelen repetir contraseña en otros
--   sitios. Por eso van en tabla aparte con RLS de solo administrador,
--   y no como columna de perfiles: así no se escapan en un select *.
--
--   Las cuentas creadas ANTES de esta migración salen "(sin anotar)".
--   Para que aparezcan hay que restablecerles la clave una vez.
-- ============================================================

create table if not exists public.credenciales (
    perfil_id       uuid primary key references public.perfiles (id) on delete cascade,
    clave           text not null,
    actualizada     timestamptz not null default now(),
    actualizada_por uuid references public.perfiles (id) on delete set null
);

alter table public.credenciales enable row level security;

drop policy if exists "admin gestiona credenciales" on public.credenciales;
create policy "admin gestiona credenciales" on public.credenciales
    for all using (public.es_admin()) with check (public.es_admin());


-- Guardar la clave que el administrador acaba de asignar.
-- Recibe el usuario y no el uuid porque es lo que el cliente tiene a
-- mano después de crear la cuenta.
create or replace function public.credencial_fijar(p_usuario text, p_clave text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_id uuid;
begin
    if not public.es_admin() then
        raise exception 'Solo un administrador puede guardar credenciales';
    end if;
    if coalesce(p_clave, '') = '' then return; end if;

    -- Usuario inexistente: se sale en silencio, no se crea basura
    select id into v_id from public.perfiles where usuario = lower(trim(p_usuario));
    if v_id is null then return; end if;

    insert into public.credenciales (perfil_id, clave, actualizada, actualizada_por)
    values (v_id, p_clave, now(), auth.uid())
    on conflict (perfil_id) do update
        set clave = excluded.clave,
            actualizada = now(),
            actualizada_por = excluded.actualizada_por;
end;
$$;

revoke execute on function public.credencial_fijar(text, text) from public, anon;
grant execute on function public.credencial_fijar(text, text) to authenticated;
