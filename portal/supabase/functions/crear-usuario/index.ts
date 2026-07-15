// ============================================================
// Edge Function: crear-usuario
// Crea usuarios del portal SIN registro público:
//   - Antes el navegador usaba auth.signUp, lo que obligaba a
//     dejar "Allow new users to sign up" ABIERTO a internet.
//   - Ahora SOLO un administrador activo puede crear cuentas;
//     la clave `service_role` vive únicamente aquí (servidor)
//     y el signup público puede (y debe) apagarse en Supabase.
//
// Despliegue: supabase functions deploy crear-usuario
// Después: Authentication → Sign In / Providers → APAGAR
//          "Allow new users to sign up".
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

const ROLES_VALIDOS = ['administrador', 'monitor', 'operador', 'cliente', 'acreedor'];

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Método no permitido.' }, 405);

  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const authHeader = req.headers.get('Authorization') || '';
    if (!authHeader) return json({ error: 'No autenticado.' }, 401);

    // 1) Identificar a quien llama usando SU token
    const userClient = createClient(url, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json({ error: 'Sesión inválida.' }, 401);

    // 2) Cliente con privilegios de servidor (service_role, sin RLS)
    const admin = createClient(url, serviceKey);

    // 3) Verificar que quien llama sea ADMINISTRADOR ACTIVO
    const { data: perfil, error: perfilErr } = await admin
      .from('perfiles')
      .select('rol, activo')
      .eq('id', userData.user.id)
      .maybeSingle();
    if (perfilErr) return json({ error: 'No se pudo verificar el perfil.' }, 500);
    if (!perfil || perfil.rol !== 'administrador' || perfil.activo === false) {
      return json({ error: 'Solo un administrador activo puede crear usuarios.' }, 403);
    }

    // 4) Validar entrada
    const body = await req.json().catch(() => ({}));
    const usuario = String(body?.usuario || '').trim().toLowerCase();
    const nombre = String(body?.nombre || '').trim();
    const rol = String(body?.rol || 'cliente');
    const clave = String(body?.clave || '');
    const correo = String(body?.correo || '').trim();
    const dominio = String(body?.dominio || 'portal.fundacion');

    if (!/^[a-z0-9._-]{1,30}$/.test(usuario)) {
      return json({ error: 'El usuario solo admite minúsculas, números, punto, guion y guion bajo.' }, 400);
    }
    if (!nombre) return json({ error: 'Falta el nombre completo.' }, 400);
    if (!ROLES_VALIDOS.includes(rol)) return json({ error: 'Rol no válido.' }, 400);
    if (clave.length < 8) return json({ error: 'La contraseña debe tener al menos 8 caracteres.' }, 400);

    // 5) Crear la cuenta con el Admin API (correo confirmado: entra directo).
    //    El trigger crear_perfil_nuevo genera el perfil como 'cliente';
    //    después se fija el rol real y el correo de contacto.
    const email = usuario.includes('@') ? usuario : usuario + '@' + dominio;
    const { data: creado, error: crearErr } = await admin.auth.admin.createUser({
      email,
      password: clave,
      email_confirm: true,
      user_metadata: { usuario, nombre },
    });
    if (crearErr) {
      const msg = String(crearErr.message || '');
      if (msg.includes('already') || msg.includes('registered')) {
        return json({ error: 'Ya existe un usuario con ese nombre.' }, 400);
      }
      return json({ error: msg }, 400);
    }
    const id = creado?.user?.id;
    if (!id) return json({ error: 'Supabase no devolvió el usuario creado.' }, 500);

    const cambios: Record<string, unknown> = {};
    if (rol !== 'cliente') cambios.rol = rol;
    if (correo) cambios.correo = correo;
    if (Object.keys(cambios).length > 0) {
      const { error: updErr } = await admin.from('perfiles').update(cambios).eq('id', id);
      if (updErr) return json({ error: 'Usuario creado, pero no se pudo guardar el rol/correo: ' + updErr.message }, 500);
    }

    return json({ ok: true, id });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
