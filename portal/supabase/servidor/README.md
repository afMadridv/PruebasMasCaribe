# Scripts del servidor

Lo que corre en el VPS y no es SQL. Vivían solo en la máquina, que es
justo como se pierden las cosas: la columna `carpetas.tipo_proceso` se
había creado a mano en el panel, nunca quedó escrita, y una instalación
nueva nacía sin ella. Aquí están para que eso no vuelva a pasar.

| Archivo | Dónde va | Cada cuánto |
|---|---|---|
| `medir-disco.sh` | `/usr/local/bin/medir-disco` | cada 2 min |
| `respaldo.sh` | `/usr/local/bin/respaldo` | 3:30 a. m. |
| `Caddyfile` | `/etc/caddy/Caddyfile` | al cambiarlo |

## El Caddyfile se baja, no se pega

Un Caddyfile pegado a mano en la terminal se destroza: la indentación
con tabuladores dispara el autocompletado de bash en cada tabulador y
el archivo queda con listados de directorio metidos entre líneas. El
error que sale es engañoso:

    Error: adapting config using caddyfile: Unexpected next token
    after '{' on same line, at /etc/caddy/Caddyfile:2

```bash
curl -sL https://raw.githubusercontent.com/afMadridv/PruebasMasCaribe/main/portal/supabase/servidor/Caddyfile -o /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy
```

`caddy validate` comprueba antes de recargar: si el archivo llegara
mal, no se aplica y el sitio sigue en pie con la configuración vieja.

## Instalar los dos

```bash
curl -sL https://raw.githubusercontent.com/afMadridv/PruebasMasCaribe/main/portal/supabase/servidor/medir-disco.sh -o /usr/local/bin/medir-disco
curl -sL https://raw.githubusercontent.com/afMadridv/PruebasMasCaribe/main/portal/supabase/servidor/respaldo.sh   -o /usr/local/bin/respaldo
chmod +x /usr/local/bin/medir-disco /usr/local/bin/respaldo
```

Las tareas:

```bash
printf '*/2 * * * * root /usr/local/bin/medir-disco\n' > /etc/cron.d/medir-disco
printf '30 3 * * * root /usr/local/bin/respaldo >> /var/log/respaldo.log 2>&1\n' > /etc/cron.d/respaldo
chmod 644 /etc/cron.d/medir-disco /etc/cron.d/respaldo
```

`respaldo` necesita `rsync`:

```bash
command -v rsync >/dev/null || apt install -y rsync
```

## Comprobar que funcionan

```bash
/usr/local/bin/medir-disco && docker exec -i supabase-db psql -U supabase_admin -d postgres \
  -c "select total_mb, usado_mb, actualizado from public.almacenamiento;"
```

```bash
/usr/local/bin/respaldo
```

El de respaldo termina diciendo cuánto ocupa la carpeta y el espejo.

## Qué NO hay que hacer

**No cambiar el `-maxdepth 1` del `find` en `respaldo.sh`.** Sin él, la
caducidad de 14 días entra en `storage-espejo` y borra los documentos más
viejos de la única copia que hay.

**No añadir `--delete` al `rsync`.** Va sin él a propósito: si alguien
elimina un expediente por error, el espejo todavía lo tiene.

## Restaurar

La base:

```bash
zcat /root/respaldos/base_FECHA.sql.gz | docker exec -i supabase-db psql -U supabase_admin -d postgres
```

Los documentos:

```bash
rsync -a /root/respaldos/storage-espejo/ /root/supabase/volumes/storage/
```

El `.env` de esa misma fecha va aparte, y **nunca** en el mismo sitio que
el volcado: quien robe un respaldo que lleve las dos cosas tiene los
datos y las llaves para descifrarlos.
