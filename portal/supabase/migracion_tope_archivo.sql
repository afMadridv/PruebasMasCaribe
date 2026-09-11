-- ============================================================
-- MIGRACIÓN: 200 MB por archivo, para que quepan las audiencias
-- ============================================================
-- Idempotente: se puede correr varias veces sin romper nada.
--
-- EL PROBLEMA
--   El bucket aceptaba 50 MB por archivo. La subcarpeta de audiencias
--   existe para guardar grabaciones, y una hora de video no baja de
--   unos 300 MB en calidad alta ni de 100 en calidad normal. O sea que
--   el sitio hecho para videos rechazaba los videos.
--
-- POR QUÉ 200 Y NO MÁS
--   La subida va en una sola petición: no es reanudable. Si se corta a
--   la mitad hay que repetirla entera. A 200 MB eso todavía es un rato
--   molesto; a 2 GB es una tarde perdida. Para pasar de ahí habría que
--   implementar subida reanudable (TUS), que es otro trabajo.
--
-- HAY QUE CAMBIARLO EN TRES SITIOS, NO EN UNO
--   1. Aquí, el bucket (lo que Storage acepta).
--   2. `TAMANO_MAXIMO` en app.js (lo que el navegador deja escoger).
--   3. `FILE_SIZE_LIMIT` en el .env del servidor autohospedado, si está
--      puesto: manda sobre el del bucket. En Supabase Cloud no existe.
--   Si los tres no dicen lo mismo, el archivo viaja entero y lo rechazan
--   al final, o se prohíbe algo que sí cabía.
-- ============================================================

update storage.buckets
   set file_size_limit = 209715200          -- 200 MB
 where id = 'documentos';

-- Comprobación: tiene que decir 209715200
select id, file_size_limit from storage.buckets where id = 'documentos';
