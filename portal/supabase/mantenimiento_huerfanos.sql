-- ============================================================
-- MANTENIMIENTO: archivos que ocupan disco y nadie puede ver
-- ============================================================
-- SOLO LEE. No borra nada. Se puede correr cuando se quiera.
--
-- Esto NO es una migración: no entra en la lista de instalación.
--
-- QUÉ BUSCA
--   Un documento del portal vive en dos sitios a la vez: una fila en
--   `public.archivos` y un binario en el bucket `documentos`. Si los dos
--   se separan, aparece basura de una de estas dos formas:
--
--   HUÉRFANOS DE DISCO — binario sin fila.
--     Ocupan espacio y el portal no los nombra en ninguna parte: no se
--     abren, no se descargan, no salen en el ZIP. Es el caso feo,
--     porque el disco se llena con cosas que nadie puede ni mirar ni
--     borrar desde el portal.
--     Los producía el borrado en bloque: PostgREST devuelve como mucho
--     mil rutas por consulta, y el `delete` no tiene ese tope, así que
--     al vaciar un expediente de 1499 documentos se borraban las 1499
--     filas y solo las mil primeras rutas. Corregido, pero si ya pasó,
--     esto los encuentra.
--
--   HUÉRFANOS DE BASE — fila sin binario.
--     El portal los lista y al abrirlos dan error. No ocupan disco.
--     Salen si una subida se cortó entre el `upload` y el `insert`.
--
-- CÓMO SE LIMPIAN
--   No desde aquí. Borrar la fila de `storage.objects` a mano NO borra
--   el archivo del disco en autohospedado: el binario seguiría ahí y
--   encima se perdería el rastro de dónde está. Al final de este
--   archivo queda el procedimiento correcto.
-- ============================================================


\echo '=== 1) HUÉRFANOS DE DISCO: binarios sin fila en archivos ==='

select count(*)                                        as cuantos,
       pg_size_pretty(coalesce(sum((o.metadata->>'size')::bigint), 0)) as espacio_desperdiciado
  from storage.objects o
  left join public.archivos a on a.ruta_storage = o.name
 where o.bucket_id = 'documentos'
   and a.id is null;

-- Los primeros cincuenta, para poder mirarlos
select o.name                          as ruta,
       pg_size_pretty((o.metadata->>'size')::bigint) as peso,
       o.created_at                    as subido
  from storage.objects o
  left join public.archivos a on a.ruta_storage = o.name
 where o.bucket_id = 'documentos'
   and a.id is null
 order by (o.metadata->>'size')::bigint desc nulls last
 limit 50;


\echo '=== 2) HUÉRFANOS DE BASE: filas sin binario ==='

select count(*) as cuantos
  from public.archivos a
  left join storage.objects o
         on o.name = a.ruta_storage and o.bucket_id = 'documentos'
 where o.id is null;

select a.id, a.carpeta_id, a.nombre, a.ruta_storage, a.fecha
  from public.archivos a
  left join storage.objects o
         on o.name = a.ruta_storage and o.bucket_id = 'documentos'
 where o.id is null
 order by a.fecha desc
 limit 50;


\echo '=== 3) CUADRE GENERAL ==='

select (select count(*) from public.archivos)                                  as filas_en_la_base,
       (select count(*) from storage.objects where bucket_id = 'documentos')   as binarios_en_el_bucket,
       (select pg_size_pretty(coalesce(sum(peso_total_bytes), 0)) from public.carpetas) as peso_segun_las_carpetas,
       (select pg_size_pretty(coalesce(sum((metadata->>'size')::bigint), 0))
          from storage.objects where bucket_id = 'documentos')                 as peso_real_en_el_bucket;

-- Las dos primeras cifras deben coincidir, y las dos últimas también.
-- Si no coinciden, los apartados 1 y 2 dicen dónde está la diferencia.


-- ============================================================
-- CÓMO LIMPIAR LOS HUÉRFANOS DE DISCO (a mano, con cuidado)
-- ============================================================
-- En el servidor, NO aquí. Primero se mira, y solo después se borra.
--
-- 1) Sacar la lista de rutas sobrantes a un archivo:
--
--    docker exec -i supabase-db psql -U supabase_admin -d postgres -At <<'SQL' > /tmp/huerfanos.txt
--    select o.name from storage.objects o
--      left join public.archivos a on a.ruta_storage = o.name
--     where o.bucket_id = 'documentos' and a.id is null;
--    SQL
--
-- 2) MIRARLA antes de tocar nada:
--
--    wc -l /tmp/huerfanos.txt && head -20 /tmp/huerfanos.txt
--
-- 3) Comprobar que las rutas existen de verdad ANTES de borrar. Esto no
--    borra nada: cuenta cuántas encuentra y cuánto pesan.
--
--    BASE=/root/supabase/volumes/storage/stub/stub/documentos
--    total=0; faltan=0
--    while IFS= read -r r; do
--      if [ -f "$BASE/$r" ]; then total=$((total+$(stat -c%s "$BASE/$r")));
--      else echo "NO EXISTE: $r"; faltan=$((faltan+1)); fi
--    done < /tmp/huerfanos.txt
--    echo "faltan $faltan, total $((total/1048576)) MB"
--
--    La ruta lleva `stub/stub` porque el backend de ficheros de Supabase
--    guarda por inquilino y en autohospedado el inquilino se llama así.
--    Si cambia entre versiones, se vuelve a averiguar con:
--
--      find /root/supabase/volumes/storage -name '<un nombre de la lista>'
--
-- 4) Solo si el paso 3 encontró TODAS y no faltó ninguna, borrar los
--    binarios y después las filas:
--
--    BASE=/root/supabase/volumes/storage/stub/stub/documentos
--    while IFS= read -r r; do rm -f "$BASE/$r"; done < /tmp/huerfanos.txt
--
--    docker exec -i supabase-db psql -U supabase_admin -d postgres <<'SQL'
--    delete from storage.objects o
--     where o.bucket_id = 'documentos'
--       and not exists (select 1 from public.archivos a where a.ruta_storage = o.name);
--    SQL
--
--    El orden importa: primero el archivo y luego la fila. Al revés, si
--    algo falla en medio, se pierde la lista de qué había que borrar y
--    los binarios quedan en disco sin nada que los nombre.
--
-- 5) Volver a correr este archivo. El apartado 1 debe dar cero y las dos
--    primeras cifras del apartado 3 deben coincidir.
-- ============================================================
