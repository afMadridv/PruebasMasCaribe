#!/bin/bash
# ============================================================
# REVISIÓN DEL SERVIDOR
# ============================================================
# Solo LEE. No cambia nada, no reinicia nada, no borra nada.
# Se puede correr cuando se quiera.
#
#   cd /srv/portal && git pull -q && bash portal/supabase/servidor/revision.sh
#
# Cada línea sale con OK, AVISO o FALLA. Lo que salga en FALLA hay que
# mirarlo; los AVISO son cosas que conviene revisar pero no rompen nada.
# ============================================================

ok=0; av=0; fa=0
OK()    { echo "  [OK]    $1"; ok=$((ok+1)); }
AVISO() { echo "  [AVISO] $1"; av=$((av+1)); }
FALLA() { echo "  [FALLA] $1"; fa=$((fa+1)); }
psql()  { docker exec -i supabase-db psql -U supabase_admin -d postgres -At -c "$1" 2>/dev/null; }

echo "=============================================="
echo " REVISIÓN — $(date '+%Y-%m-%d %H:%M')"
echo "=============================================="

echo
echo "-- Contenedores --"
total=$(docker ps --format '{{.Names}}' | wc -l)
sanos=$(docker ps --filter health=healthy --format '{{.Names}}' | wc -l)
malos=$(docker ps --filter health=unhealthy --format '{{.Names}}')
[ "$total" -ge 11 ] && OK "$total contenedores en marcha" || FALLA "solo $total contenedores (deberían ser 11)"
[ -z "$malos" ] && OK "ninguno en mal estado ($sanos sanos)" || FALLA "en mal estado: $malos"

echo
echo "-- Disco --"
pct=$(df --output=pcent / | tail -1 | tr -dc '0-9')
lib=$(df -h --output=avail / | tail -1 | tr -d ' ')
if   [ "$pct" -ge 92 ]; then FALLA "disco al $pct% — un disco lleno tumba Postgres"
elif [ "$pct" -ge 80 ]; then AVISO "disco al $pct%, quedan $lib"
else OK "disco al $pct%, quedan $lib libres"; fi
echo "          documentos: $(du -sh /root/supabase/volumes/storage 2>/dev/null | cut -f1)   respaldos: $(du -sh /root/respaldos 2>/dev/null | cut -f1)"

echo
echo "-- Memoria y swap --"
sw=$(free -m | awk '/Swap:/{print $2}')
[ "$sw" -gt 0 ] && OK "swap de ${sw} MB activa" || FALLA "sin swap: un pico de memoria mata Postgres"
echo "          RAM: $(free -h | awk '/Mem:/{print $3\" de \"$2\" en uso\"}')"

echo
echo "-- Base de datos --"
if [ -n "$(psql 'select 1')" ]; then
    OK "Postgres responde"
    echo "          $(psql 'select count(*) from public.carpetas') carpetas, $(psql 'select count(*) from public.archivos') archivos, $(psql 'select count(*) from public.perfiles') perfiles"
    # Lo que la carpeta dice que pesa contra lo que de verdad suman sus archivos
    desc=$(psql "select count(*) from public.carpetas c where c.total_archivos <> (select count(*) from public.archivos a where a.carpeta_id = c.id)")
    [ "$desc" = "0" ] && OK "los contadores de cada carpeta cuadran" || FALLA "$desc carpetas con el contador descuadrado (correr recalcular_peso_carpeta)"
    # Binarios sin fila: ocupan disco y el portal no los puede nombrar
    hue=$(psql "select count(*) from storage.objects o left join public.archivos a on a.ruta_storage = o.name where o.bucket_id='documentos' and a.id is null")
    [ "$hue" = "0" ] && OK "sin archivos huérfanos" || AVISO "$hue binarios sin fila (correr mantenimiento_huerfanos.sql)"
    # Filas sin binario: se listan y al abrirlas dan error
    sin=$(psql "select count(*) from public.archivos a left join storage.objects o on o.name = a.ruta_storage and o.bucket_id='documentos' where o.id is null")
    [ "$sin" = "0" ] && OK "todo archivo listado tiene su binario" || FALLA "$sin archivos sin binario: se listan y al abrirlos fallan"
    # El tope del bucket tiene que ser el mismo que TAMANO_MAXIMO en app.js
    lim=$(psql "select file_size_limit from storage.buckets where id='documentos'")
    [ "$lim" = "524288000" ] && OK "tope por archivo en 500 MB" || AVISO "tope del bucket en $lim bytes (app.js espera 524288000)"
else
    FALLA "Postgres no responde"
fi

echo
echo "-- Tarea diaria de plazos --"
act=$(psql "select count(*) from cron.job where active")
[ "${act:-0}" -gt 0 ] && OK "$act tarea(s) de pg_cron activas" || FALLA "sin tareas activas: los avisos de plazo no salen y nadie se entera"
tz=$(psql 'show timezone')
[ "$tz" = "UTC" ] && OK "zona horaria en UTC" || AVISO "zona horaria en $tz (se esperaba UTC)"

echo
echo "-- Medición del disco --"
med=$(psql "select extract(epoch from now() - actualizado)::int from public.almacenamiento where id=1")
if   [ -z "$med" ];        then FALLA "la tabla almacenamiento está vacía"
elif [ "$med" -lt 600 ];   then OK "medido hace ${med}s"
else AVISO "última medición hace $((med/60)) min: revisar /etc/cron.d/medir-disco"; fi

echo
echo "-- Respaldos --"
ult=$(ls -t /root/respaldos/base_*.sql.gz 2>/dev/null | head -1)
if [ -z "$ult" ]; then FALLA "no hay ningún volcado de la base"
else
    h=$(( ($(date +%s) - $(stat -c %Y "$ult")) / 3600 ))
    [ "$h" -lt 30 ] && OK "último volcado hace ${h}h ($(basename "$ult"))" || FALLA "último volcado hace ${h}h: la tarea de las 3:30 no está corriendo"
fi
[ -d /root/respaldos/storage-espejo ] && OK "espejo de documentos montado" || AVISO "sin espejo: el respaldo todavía usa tar (14 copias completas)"
# Lo que de verdad importa y sigue faltando
AVISO "los respaldos viven en el MISMO disco que la base: si el disco muere, mueren los dos"

echo
echo "-- Cortafuegos --"
if ufw status 2>/dev/null | grep -q "Status: active"; then
    OK "ufw activo: $(ufw status | grep -cE '^[0-9]+/(tcp|udp)') puertos abiertos"
    for p in 5432 8000; do
        ufw status | grep -q "^$p" && FALLA "el puerto $p está abierto al público" || OK "puerto $p cerrado"
    done
else FALLA "ufw inactivo"; fi

echo
echo "-- Web y certificado --"
systemctl is-active --quiet caddy && OK "Caddy corriendo" || FALLA "Caddy caído"
cod=$(curl -s -o /dev/null -w '%{http_code}' https://144.172.108.56.sslip.io/portal/)
[ "$cod" = "200" ] && OK "el portal responde 200" || FALLA "el portal responde $cod"
for r in /.git/config /portal/supabase/esquema.sql; do
    c=$(curl -s -o /dev/null -w '%{http_code}' "https://144.172.108.56.sslip.io$r")
    [ "$c" = "404" ] && OK "$r bloqueado" || FALLA "$r responde $c: está expuesto"
done
dias=$(( ($(date -d "$(echo | openssl s_client -connect 144.172.108.56.sslip.io:443 -servername 144.172.108.56.sslip.io 2>/dev/null | openssl x509 -noout -enddate | cut -d= -f2)" +%s) - $(date +%s)) / 86400 ))
[ "$dias" -gt 20 ] && OK "certificado válido $dias días más" || AVISO "el certificado vence en $dias días"

echo
echo "-- Parches --"
systemctl is-enabled --quiet unattended-upgrades && OK "parches de seguridad automáticos" || AVISO "unattended-upgrades apagado"
[ -f /var/run/reboot-required ] && AVISO "hay un reinicio pendiente (kernel nuevo)" || OK "sin reinicios pendientes"

echo
echo "=============================================="
echo " $ok en orden · $av avisos · $fa fallas"
echo "=============================================="
[ "$fa" -eq 0 ] && echo " Nada roto." || echo " Hay $fa cosa(s) que mirar."
