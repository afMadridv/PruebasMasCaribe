/* ============================================
   PORTAL DOCUMENTAL - Configuración
   MODO 'nube'  → datos reales en Supabase (se ven desde
                  cualquier computador)
   MODO 'local' → datos de práctica solo en este navegador
   La clave anónima es pública por diseño: la seguridad
   real la ponen las reglas RLS del esquema.sql.
   ============================================ */
const PORTAL_CONFIG = {
    MODO: 'nube',
    // El servidor propio. `sslip.io` es un DNS público que traduce
    // 144.172.108.56.sslip.io a esa misma IP, así que Let's Encrypt puede
    // emitir un certificado real sin tener un dominio comprado. Cuando
    // haya dominio, aquí va el nombre de verdad y en el servidor se
    // cambia la primera línea del Caddyfile.
    // El usuario 'ana' inicia sesión internamente como ana@portal.fundacion
    SUPABASE_URL: 'https://144.172.108.56.sslip.io',
    SUPABASE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzg5MTUxNjA4LCJleHAiOjIxMDQ1MTE2MDh9.2vRWrhUnd67wFdoWxT9-mcKNvpdfRpWIQ3E9PhTdAds',
    DOMINIO_USUARIOS: 'portal.fundacion'
};
