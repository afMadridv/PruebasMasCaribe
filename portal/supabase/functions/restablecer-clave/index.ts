// ============================================================
// Edge Function: restablecer-clave
// Permite que UN ADMINISTRADOR del portal restablezca la
// contraseña de otro usuario, de forma segura:
//   - La clave `service_role` vive SOLO aquí (en el servidor),
//     nunca en el navegador. Supabase la inyecta como variable
//     de entorno SUPABASE_SERVICE_ROLE_KEY.
//   - Se verifica con el token del que llama que sea un
//     administrador ACTIVO antes de hacer cualquier cambio.
//
// Despliegue (una sola vez):
//   supabase functions deploy restablecer-clave
// (No requiere configurar secretos: las variables SUPABASE_* ya
//  están disponibles dentro de las Edge Functions.)
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
      return json({ error: 'Solo un administrador activo puede restablecer contraseñas.' }, 403);
    }

    // 4) Validar entrada
    const body = await req.json().catch(() => ({}));
    const targetId = String(body?.user_id || '').trim();
    const newPassword = String(body?.password || '');
    if (!targetId) return json({ error: 'Falta el usuario objetivo.' }, 400);
    if (newPassword.length < 8) {
      return json({ error: 'La contraseña debe tener al menos 8 caracteres.' }, 400);
    }

    // 5) Restablecer la contraseña con el Admin API
    const { error: updErr } = await admin.auth.admin.updateUserById(targetId, {
      password: newPassword,
    });
    if (updErr) return json({ error: updErr.message }, 400);

    return json({ ok: true });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
