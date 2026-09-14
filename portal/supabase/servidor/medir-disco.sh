#!/bin/sh
# ============================================================
# MEDIR EL DISCO
# ============================================================
# Va en /usr/local/bin/medir-disco y lo dispara
# /etc/cron.d/medir-disco cada dos minutos.
#
# POR QUÉ HACE FALTA
#   El navegador no ve el disco del servidor, y Postgres tampoco:
#   sabe cuánto pesa su base, pero no cuánto queda libre en el
#   sistema de archivos. Quien lo sabe es el propio servidor, así
#   que lo mide aquí y lo deja escrito en una tabla. El portal lo
#   lee por la API de siempre, con `almacenamiento_ver()`.
#
#   Sin servicios nuevos, sin puertos nuevos, sin agentes.
#
# SI ESTO DEJA DE CORRER
#   El portal no se inventa un número: la sección Almacenamiento
#   muestra la antigüedad de la medición al lado de la cifra. Si
#   dice «hace 3 h», esta tarea está caída.
# ============================================================
set -eu

# df en megas, una sola línea: tamaño, usado, disponible
L=$(df -BM --output=size,used,avail / | tail -1)
T=$(echo "$L" | awk '{gsub(/M/,"",$1); print $1}')
U=$(echo "$L" | awk '{gsub(/M/,"",$2); print $2}')
A=$(echo "$L" | awk '{gsub(/M/,"",$3); print $3}')

docker exec -i supabase-db psql -U supabase_admin -d postgres -q \
    -c "select public.almacenamiento_registrar($T, $U, $A);"
