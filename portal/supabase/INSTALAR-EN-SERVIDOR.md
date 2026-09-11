# Instalar el portal en un servidor propio

Guía para montar Supabase autohospedado en un VPS y dejar el portal
corriendo. Escrita para el servidor de Cloudzy (Ubuntu 24.04, 8 GB),
pero sirve para cualquier Linux con Docker.

---

## Antes de empezar: no hay datos que migrar

La base de Supabase Cloud está prácticamente vacía tras la limpieza:
**3 usuarios, 2 notarías, 0 carpetas, 0 archivos, 16 MB.**

Eso cambia el plan por completo. La parte difícil de una migración es
el esquema `auth`: los identificadores UUID de los usuarios aparecen en
media docena de tablas, y si cambian, los permisos quedan mal **sin dar
ningún error** — alguien deja de ver su expediente, o empieza a ver el
ajeno.

Con tres usuarios ese problema desaparece: **no se migra nada, se crea
de cero.** Quince minutos en vez de dos horas, y cero riesgo.

Lo único que hay que llevar es el esquema, que son los 10 archivos SQL
de esta carpeta.

> Si algún día hay que mover un portal **con** datos, ahí sí aplica el
> runbook completo: `F:\Cloudzy-Runbook-de-Migracion.pdf`.

---

## Orden de los archivos SQL

El orden importa: cada uno asume el anterior. El de endurecimiento va
**último**, porque revoca y vuelve a conceder permisos sobre funciones
que tienen que existir ya.

| # | Archivo | Qué trae |
|---|---------|----------|
| 1 | `esquema.sql` | Las 20 tablas, funciones, políticas, el bucket y la publicación de Realtime |
| 2 | `migracion_cierre_y_descargas.sql` | Cierre de trámite y control de descargas |
| 3 | `migracion_subcarpetas.sql` | Subcarpetas |
| 4 | `migracion_seguridad_2026_08.sql` | Endurecimiento de permisos |
| 5 | `migracion_festivos_y_cron.sql` | Festivos hasta 2030 y la tarea diaria |
| 6 | `migracion_notarias.sql` | Multi-notaría: reescribe `puede_ver_carpeta` |
| 7 | `migracion_avisos_plazo.sql` | Avisos del plazo a 4, 3, 2, 1 semanas, 1 día y el mismo día |
| 8 | `migracion_notificaciones_por_notaria.sql` | Los avisos no se mezclan entre oficinas, y el correo obligatorio por rol |
| 9 | `migracion_credenciales.sql` | Las contraseñas asignadas, para el Excel |
| 10 | `migracion_tipo_proceso.sql` | El régimen de la carpeta. Faltaba: se había creado a mano en el panel |
| 11 | `migracion_almacenamiento.sql` | La barra de espacio lee el disco de verdad |
| 12 | `migracion_tope_archivo.sql` | 200 MB por archivo, para las grabaciones de audiencias |
| 13 | `migracion_endurecimiento_2026_09.sql` | Cierra el acceso anónimo. **Va al final** |

`limpieza_portal.sql` no entra aquí: es una herramienta aparte, para
vaciar un portal que ya está en uso.

---

## Fase 1. Entrar y asegurar

```bash
ssh root@TU_IP
cd /opt/supabase/docker      # si no está ahí: find / -name docker-compose.yml 2>/dev/null
```

### Los secretos, antes que nada

```bash
grep -E 'JWT_SECRET|ANON_KEY|SERVICE_ROLE_KEY|SECRET_KEY' .env
grep -E 'PUBLISHABLE|POSTGRES_PASSWORD|DASHBOARD' .env
```

**Si aparece alguno de estos, son claves públicas de GitHub y hay que
cambiarlas todas antes de exponer la máquina:**

- `your-super-secret-and-long-postgres-password`
- `your-super-secret-jwt-token-with-at-least-32-characters-long`
- una clave que empiece con `eyJ` y contenga `c3VwYWJhc2UtZGVtbw`

Con esas claves cualquiera fabrica un token `service_role`, que **salta
toda la seguridad RLS** y lee todos los expedientes.

```bash
openssl rand -base64 40          # JWT_SECRET
openssl rand -base64 32          # POSTGRES_PASSWORD
openssl rand -base64 24          # DASHBOARD_PASSWORD
# Las dos claves de API se derivan del JWT_SECRET:
#   https://supabase.com/docs/guides/self-hosting#api-keys
docker compose down && docker compose up -d
```

Guarda todo eso en un gestor de contraseñas. **El `.env` nunca va en un
respaldo junto a la base**: quien robe ese respaldo tendría los datos y
las llaves.

### Cortafuegos

```bash
ufw default deny incoming
ufw allow 22 && ufw allow 80 && ufw allow 443
ufw enable
```

`5432` (Postgres) y `8000` (la puerta de la API) **nunca** públicos.

### Comprobar el stack

```bash
docker ps --format '{{.Names}}\t{{.Status}}'
```

Tienen que salir, como mínimo: `supabase-db`, `supabase-auth`,
`supabase-rest`, `supabase-realtime`, `supabase-storage`,
`supabase-edge-functions`, `supabase-studio`.

---

## Fase 2. Las extensiones

Antes de cargar el esquema. Son las cinco que usa el portal:

```bash
docker exec -i supabase-db psql -U postgres -d postgres <<'SQL'
create extension if not exists "uuid-ossp";
create extension if not exists pgcrypto;
create extension if not exists pg_stat_statements;
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists supabase_vault;
select extname, extversion from pg_extension order by extname;
SQL
```

---

## Fase 3. El esquema

Copia la carpeta `portal/supabase` al servidor y ejecuta los trece en
orden. `ON_ERROR_STOP=1` corta a la primera: si uno falla, hay que
resolverlo antes de seguir, no acumular fallos.

```bash
cd /opt/portal-sql
for a in esquema.sql \
         migracion_cierre_y_descargas.sql \
         migracion_subcarpetas.sql \
         migracion_seguridad_2026_08.sql \
         migracion_festivos_y_cron.sql \
         migracion_notarias.sql \
         migracion_avisos_plazo.sql \
         migracion_notificaciones_por_notaria.sql \
         migracion_credenciales.sql \
         migracion_tipo_proceso.sql \
         migracion_almacenamiento.sql \
         migracion_tope_archivo.sql \
         migracion_endurecimiento_2026_09.sql; do
  echo "=== $a"
  docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 < "$a" || break
done
```

El último archivo termina simulando la sesión de cada usuario para
comprobar que nadie se quedó sin acceso. Si dice
`HAY USUARIOS SIN ACCESO`, falta un `grant` y hay que resolverlo
**antes** de dejar entrar a nadie.

### La tarea programada

`pg_cron` en autohospedado necesita saber sobre qué base trabajar. Sin
esto la tarea figura programada y **nunca corre**: los avisos de plazo
no salen y nadie se entera.

```bash
docker exec -i supabase-db psql -U postgres -c "show cron.database_name;"
docker exec -i supabase-db psql -U postgres -c "select jobname, schedule, active from cron.job;"
```

Si `cron.database_name` sale vacío, añade a `postgresql.conf` del
contenedor `cron.database_name = 'postgres'` y reinicia.

Comprueba también la zona horaria: la tarea corre a las 12:00 UTC, que
son las 7:00 en Colombia. Si el contenedor quedara en otra zona,
`current_date` y `es_dia_habil()` deciden mal en la frontera de la
medianoche, y eso se ve como un plazo con un día de diferencia.

```bash
docker exec -i supabase-db psql -U postgres -c "show timezone;"   # UTC
```

---

## Fase 4. Las Edge Functions

No hay despliegue: el contenedor sirve lo que encuentre en una carpeta.

```bash
cd /opt/supabase/docker
mkdir -p volumes/functions/crear-usuario volumes/functions/restablecer-clave
# copia aquí los dos index.ts de portal/supabase/functions/
docker compose restart edge-runtime
docker compose logs --tail=40 edge-runtime
```

Las tres variables que leen (`SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`) las pasa el compose solo. No hay secretos
que configurar.

Las dos funciones importan `supabase-js` desde `esm.sh`, así que el
servidor necesita salida a internet.

---

## Fase 5. El primer administrador

Aquí hay un huevo y una gallina: el portal solo deja crear usuarios a un
administrador, y todavía no hay ninguno. Se crea a mano, una vez.

1. Studio → **Authentication** → **Add user**, con
   `usuario@portal.fundacion` y una contraseña. Marca *Auto Confirm*.
2. El trigger `crear_perfil_nuevo` le hace el perfil como `cliente`.
   Súbelo a administrador:

```bash
docker exec -i supabase-db psql -U postgres -d postgres <<'SQL'
update public.perfiles
   set rol = 'administrador', nombre = 'Tu Nombre', correo = 'tu@correo.com'
 where usuario = 'tu_usuario';
select usuario, rol, activo from public.perfiles;
SQL
```

Desde ahí ya entras al portal y creas las notarías y el resto de
usuarios por la interfaz, con las contraseñas quedando anotadas en la
tabla `credenciales`.

**Apaga el registro público** en Studio → Authentication → Sign In /
Providers → *Allow new users to sign up*. Las cuentas las crea la Edge
Function, nadie más.

Y enciende la **protección de contraseñas filtradas** (compara contra
HaveIBeenPwned) en esa misma pantalla, o con
`GOTRUE_PASSWORD_HIBP_ENABLED=true` en el `.env`.

---

## Fase 6. Dominio, HTTPS y Cloudflare

El orden importa: Caddy necesita alcanzar internet **sin** el proxy de
Cloudflare en medio para pedir su primer certificado.

1. En Cloudflare, registro **A** de `api.tudominio.com` a la IP del
   servidor, con el proxy **desactivado** (nube gris).
2. Instala Caddy y escribe el `Caddyfile`.
3. Comprueba que `https://api.tudominio.com` responde con certificado
   válido.
4. **Ahora sí**, activa el proxy (nube naranja).
5. SSL/TLS en modo **Full (strict)**.

```caddyfile
# /etc/caddy/Caddyfile
api.tudominio.com {
    reverse_proxy localhost:8000
}
```

Caddy pasa los encabezados de WebSocket sin configuración extra, así
que Realtime funciona tal cual.

**Nunca el modo Flexible de Cloudflare.** En Flexible el tramo entre
Cloudflare y tu servidor viaja sin cifrar: cualquiera en esa ruta lee
los tokens de sesión y el contenido de los expedientes.

---

## Fase 7. Apuntar el portal

Tres sitios, ni uno más:

| Archivo | Línea | Qué cambiar |
|---------|-------|-------------|
| `portal/js/config.js` | 11-12 | `SUPABASE_URL` y `SUPABASE_KEY` |
| `portal/index.html` | 11 | el `<link rel="preconnect">` |
| `portal/app.html` | 11 | el `<link rel="preconnect">` |

```js
const PORTAL_CONFIG = {
    MODO: 'nube',
    SUPABASE_URL: 'https://api.tudominio.com',
    SUPABASE_KEY: '<la clave pública que salga de TU .env>',
    DOMINIO_USUARIOS: 'portal.fundacion'
};
```

Toma la clave de tu propio `.env`, no supongas el formato: según la
versión del stack puede ser `sb_publishable_...` o el JWT antiguo que
empieza con `eyJ`. Las dos sirven; tiene que ser la que emitió **tu**
servidor.

El portal sigue en Vercel. Solo se muda el backend.

---

## Fase 8. Dejarlo fino

Esto es lo que separa un servidor que aguanta de uno que te despierta
de madrugada.

### Que se levante solo

```bash
systemctl enable docker
grep -c "unless-stopped" docker-compose.yml    # casi todos lo traen
```

**Swap de 4 GB.** Evita la caída más traicionera: cuando la RAM se
agota, el kernel mata el proceso más gordo, y ese siempre es Postgres.

```bash
fallocate -l 4G /swapfile && chmod 600 /swapfile
mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

**Parches de seguridad automáticos.**

```bash
apt install -y unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades
```

**SSH solo con llave.** Sube tu llave desde el panel de Cloudzy y
después:

```bash
sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh
```

Comprueba que entras con la llave **antes** de cerrar la sesión actual.
Si te equivocas aquí, te quedas fuera del servidor.

**fail2ban**, contra el goteo de intentos de SSH:

```bash
apt install -y fail2ban && systemctl enable --now fail2ban
```

**Limpieza de disco.** Disco lleno es la causa número uno de "se cayó la
base": Postgres se niega a escribir y todo se detiene.

```bash
cat > /etc/cron.weekly/limpieza <<'SH'
#!/bin/sh
docker system prune -af --filter "until=168h"
journalctl --vacuum-time=14d
find /var/respaldos -name '*.gz' -mtime +14 -delete
SH
chmod +x /etc/cron.weekly/limpieza
```

### Respaldos

Cloudzy los cobra aparte ($6.35/mes) y solo guarda **3 copias**. Esto
sale gratis, guarda 14 días, va cifrado y queda **fuera** de la máquina.

Necesitas una cuenta de Backblaze B2 o Cloudflare R2 (10 GB gratis) y
una *application key*.

```bash
curl https://rclone.org/install.sh | bash
rclone config          # tipo b2, nombre: b2
openssl rand -base64 32 > /root/.clave-respaldo
chmod 600 /root/.clave-respaldo
```

**Guarda esa clave en el gestor de contraseñas ahora mismo.** Sin ella
los respaldos no se pueden abrir, ni por ti.

```bash
cat > /usr/local/bin/respaldo-portal <<'SH'
#!/bin/sh
set -eu
D=$(date +%F)
DIR=/var/respaldos
mkdir -p "$DIR"

# Base COMPLETA: incluye los esquemas auth y storage, que son justo los
# que no viajan en un volcado de solo public
docker exec supabase-db pg_dump -U postgres -d postgres \
  --clean --if-exists --quote-all-identifiers \
  | gzip -9 > "$DIR/base-$D.sql.gz"

tar czf "$DIR/archivos-$D.tar.gz" -C /opt/supabase/docker/volumes storage

# Cifrar ANTES de que salga del servidor
for f in "$DIR/base-$D.sql.gz" "$DIR/archivos-$D.tar.gz"; do
  gpg --batch --yes --symmetric --cipher-algo AES256 \
      --passphrase-file /root/.clave-respaldo "$f"
  rm -f "$f"
done

rclone copy "$DIR" b2:portal-respaldos/ --include "*-$D.*.gpg"
find "$DIR" -name '*.gpg' -mtime +14 -delete
curl -fsS -m 10 https://hc-ping.com/TU-UUID > /dev/null
SH
chmod +x /usr/local/bin/respaldo-portal
echo '0 1 * * * root /usr/local/bin/respaldo-portal' > /etc/cron.d/respaldo-portal
```

El cifrado no es opcional: son expedientes judiciales saliendo hacia un
tercero.

**Prueba la restauración una vez**, en una máquina de prueba. Un
respaldo que nunca se restauró no es un respaldo.

### Que te enteres

**Healthchecks.io** (gratis, 20 revisiones). Es un interruptor de
hombre muerto: si dejan de llegar los pings, te avisa.

```bash
echo '*/5 * * * * root curl -fsS -m 10 https://hc-ping.com/OTRO-UUID > /dev/null' \
  > /etc/cron.d/latido
```

Ponle otro a la tarea diaria de plazos. Hoy tienes un hueco real: si
`pg_cron` se cae, los avisos dejan de salir **en silencio**.

**Diagnóstico en un comando.** Guárdalo: con una línea sabes casi todo.

```bash
cat > /root/diag.sh <<'SH'
#!/bin/sh
echo "=== DISCO";   df -h / | tail -1
echo "=== MEMORIA"; free -h | head -2
echo "=== OOM";     dmesg 2>/dev/null | grep -i "out of memory" | tail -3
echo "=== CONTENEDORES"
docker ps -a --format '{{.Names}}\t{{.Status}}' | sort
echo "=== ERRORES RECIENTES"
docker compose -f /opt/supabase/docker/docker-compose.yml logs --tail=25 2>&1 \
  | grep -iE "error|fatal|panic" | tail -12
echo "=== POSTGRES RESPONDE?"
docker exec supabase-db pg_isready -U postgres
SH
chmod +x /root/diag.sh
```

### Rendimiento

Con 150 usuarios el pool de PostgREST por defecto (10 conexiones) se
queda corto:

```
PGRST_DB_POOL=25
```

en el `.env`, y `docker compose up -d`.

---

## Verificación final

Con un usuario real de cada rol, en este orden. Si algo falla, párate
ahí.

| # | Prueba | Qué confirma |
|---|--------|--------------|
| 1 | Iniciar sesión como administrador | Auth |
| 2 | Crear una notaría | `notaria_crear` y el panel de oficinas |
| 3 | Crear un operador con correo y notaría | La Edge Function `crear-usuario` |
| 4 | Descargar el Excel de usuarios | La tabla `credenciales` y la RLS de administrador |
| 5 | Entrar como ese operador y contar lo que ve | **La prueba más importante**: nadie gana ni pierde acceso |
| 6 | Crear una carpeta y subir un archivo de ~10 MB | Storage de escritura |
| 7 | Subir uno de 45 MB | Los tres límites de tamaño alineados |
| 8 | Restablecer una clave desde el portal | La Edge Function `restablecer-clave` |
| 9 | Chat con dos navegadores abiertos | Realtime y la publicación |
| 10 | Iniciar el plazo de una carpeta | `calcular_vencimiento_habil` y los festivos |
| 11 | Forzar la tarea diaria | `pg_cron` y los avisos de plazo |

```bash
# Prueba 11
docker exec -i supabase-db psql -U postgres -d postgres \
  -c "select public.cron_plazos_diario();"
```

---

## Los tres límites de tamaño

Tienen que coincidir. Si se separan, el rechazo ocurre en un sitio
distinto del que dice el mensaje y nadie entiende por qué.

| Dónde | Qué |
|-------|-----|
| `app.js`, constante `TAMANO_MAXIMO` | lo que valida el navegador |
| `storage.buckets.file_size_limit` | lo que acepta el bucket |
| `FILE_SIZE_LIMIT` del `.env` | el tope global del stack |

Hoy los tres están en **50 MB**. Cloudflare en plan gratuito corta en
100 MB, así que queda por debajo.
