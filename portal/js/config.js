/* ============================================
   PORTAL DOCUMENTAL - Configuración
   MODO 'nube'  → datos reales en Supabase (se ven desde
                  cualquier computador)
   MODO 'local' → datos de práctica solo en este navegador
   La clave "publishable" es pública por diseño: la seguridad
   real la ponen las reglas RLS del esquema.sql.
   ============================================ */
const PORTAL_CONFIG = {
    MODO: 'nube',
    SUPABASE_URL: 'https://hheyihgktcswvxiscvdm.supabase.co',
    SUPABASE_KEY: 'sb_publishable_FwVlPfASE1h6_tSpyXi6zw_NxEOmlj5',
    // El usuario 'ana' inicia sesión internamente como ana@portal.fundacion
    DOMINIO_USUARIOS: 'portal.fundacion'
};
