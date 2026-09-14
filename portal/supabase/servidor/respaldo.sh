#!/bin/bash
# ============================================================
# RESPALDO DIARIO
# ============================================================
# Va en /usr/local/bin/respaldo y lo dispara /etc/cron.d/respaldo.
#
# DOS COSAS QUE SE RESPALDAN DISTINTO, PORQUE SON DISTINTAS
#
#   La base cambia a cada rato y pesa poco (decenas de KB
#   comprimida). Volcado completo cada noche, se guardan 14.
#
#   Los documentos NO cambian: una vez subido, un expediente es
#   inmutable. La primera versión hacía `tar czf` de la carpeta
#   entera cada noche y guardaba 14 copias. Con 4.8 GB de
#   expedientes eso son 67 GB de copias casi idénticas, y encima
#   el tar no comprime nada porque los .jpg y los .mp4 ya vienen
#   comprimidos. Ahora es un espejo con rsync: la primera vez
#   copia todo, después solo lo nuevo, y ocupa UNA copia.
#
# EL ESPEJO NO BORRA
#   `rsync` va sin --delete a propósito. Si alguien elimina un
#   expediente por error, el espejo todavía lo tiene. A cambio
#   crece de forma monótona, que para este uso es lo que se
#   quiere.
#
# EL -maxdepth 1 DEL find NO ES ADORNO
#   Sin él, la caducidad de 14 días entraría en el espejo y
#   borraría los documentos más viejos de la única copia que hay.
# ============================================================
set -euo pipefail

DIR=/root/respaldos
ESPEJO=$DIR/storage-espejo
mkdir -p "$DIR" "$ESPEJO"
chmod 700 "$DIR"
F=$(date +%Y-%m-%d_%H%M)

# 1) La base entera, roles incluidos
docker exec -i supabase-db pg_dumpall -U supabase_admin | gzip > "$DIR/base_$F.sql.gz"

# Comprobar que no quedó a medias. pg_dumpall siempre cierra con esa
# línea; si falta, el volcado se cortó y un respaldo trunco es peor que
# ninguno, porque parece que hay copia.
zcat "$DIR/base_$F.sql.gz" | tail -5 | grep -q 'dump complete' || {
    echo "ERROR: el volcado quedo incompleto"
    rm -f "$DIR/base_$F.sql.gz"
    exit 1
}

# 2) Las llaves. Sin el .env los tokens no sirven al restaurar.
cp /root/supabase/.env "$DIR/env_$F.txt" 2>/dev/null \
    || cp /root/supabase/docker/.env "$DIR/env_$F.txt"

# 3) Los documentos, al espejo
rsync -a /root/supabase/volumes/storage/ "$ESPEJO/"

# 4) Caducan los volcados y las llaves. El espejo NO: por eso maxdepth 1.
find "$DIR" -maxdepth 1 -type f -mtime +14 -delete

echo "OK $F"
du -sh "$DIR" "$ESPEJO"
