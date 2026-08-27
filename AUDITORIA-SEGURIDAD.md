# Auditoría de seguridad — Portal Documental

> Revisión de 2026-08-19. Alcance: ingreso, sesión, verificación de rol,
> límites de uso, y seguridad del programa y del servidor.
> Hallazgos verificados contra la base **en vivo**, no solo contra el código.

---

## Veredicto

El modelo de seguridad de fondo **es correcto**: la verificación de rol vive en
el servidor, no en el navegador. Pero se encontraron **tres huecos reales** —
uno de ellos introducido por mí en la Fase 3 — y todos quedaron corregidos.

| Gravedad | Hallazgo | Estado |
| --- | --- | --- |
| 🔴 Alta | Funciones internas ejecutables **sin sesión** | Corregido |
| 🟠 Media-alta | Suplantación de autor en `chat_mensajes` | Corregido |
| 🟠 Media | Sin límite de uso en "olvidé mi contraseña" | Corregido |
| 🟠 Media | Sin límite de uso en el formulario público | Corregido |
| 🟡 Baja | Storage acepta cualquier tipo de archivo | Pendiente (decisión tuya) |
| 🟡 Baja | Tablas en la base que no están en `esquema.sql` | Pendiente |

---

## 1. La pregunta central: ¿el rol se verifica en el cliente o en el servidor?

**En el servidor.** Verificado en tres capas:

```
navegador                    servidor
─────────                    ────────
localStorage                 JWT de Supabase
'portal_sesion'      →       auth.uid()
{rol: 'cliente'}                  │
      │                           ▼
      │                    rol_actual()
      │                    SELECT rol FROM perfiles
      │                    WHERE id = auth.uid()
      ▼                           │
  solo la UI                      ▼
 (qué botones                RLS + funciones
  se dibujan)                security definer
```

`app.js` calcula `ES_ADMIN` leyendo `localStorage`. Eso **solo decide qué botones
se dibujan**. La autorización real la hace PostgreSQL:

```sql
create or replace function public.rol_actual()
returns text language sql stable security definer
as $$ select rol from public.perfiles where id = auth.uid() and activo; $$;
```

`auth.uid()` sale del JWT firmado por Supabase, no de nada que el navegador
pueda escribir.

### Prueba concreta

Si alguien edita `localStorage` y se pone `rol: "administrador"`:

- **Sí** verá botones de administrador dibujados en su pantalla
- **No** podrá crear carpetas → `carpetas` INSERT exige `es_admin()`
- **No** podrá ver otras carpetas → `puede_ver_carpeta()` consulta la base
- **No** podrá cambiar su propio rol → `perfiles` UPDATE exige `es_admin()`, y
  **no existe** ninguna política que permita a alguien editar su propio perfil

La escalada de privilegios por esta vía **está cerrada**. Confirmado leyendo las
políticas en vivo, no el archivo.

> Mejora cosmética recomendada (no es un hueco): que la UI no dibuje controles
> basándose en `localStorage`, sino en una consulta a `perfiles` al arrancar.
> Hoy un usuario curioso ve botones que no funcionan, lo cual confunde pero no
> compromete nada.

---

## 2. 🔴 Funciones internas ejecutables sin sesión — CORREGIDO

**Este lo introduje yo en la Fase 3.** En la migración escribí:

```sql
revoke execute on function public.cron_diario(boolean) from anon, authenticated;
```

Y di por hecho que quedaba cerrado. No quedó. En PostgreSQL **toda función nace
con `EXECUTE` concedido a `PUBLIC`**, y `anon` hereda de `PUBLIC`. Revocar de
`anon` no quita el permiso de `PUBLIC`. El ACL lo mostraba:

```
cron_diario: =X/postgres | postgres=X/postgres | service_role=X/postgres
             ↑
             este "=X" sin nombre delante es PUBLIC
```

Encima, Supabase concede `EXECUTE` a `anon` y `authenticated` **por defecto en
cada función nueva** del esquema `public`. Hay que revocar de los tres.

### Qué se podía hacer sin sesión

| Función | Consecuencia |
| --- | --- |
| `_notificar`, `_notificar_admins`, `_notificar_una_vez` | Insertar avisos falsos en la campana de **cualquier** usuario. Vector de phishing: *«Su trámite fue cancelado, llame al 300…»* con la apariencia del portal |
| `_encolar_salida` | Inyectar filas en la bandeja de salida. Cuando exista el correo institucional, esas filas **se enviarían por correo** |
| `cron_diario` | Disparar el cron a voluntad, incluida la desactivación de carpetas |

`_notificar` y `_notificar_admins` **ya estaban abiertas desde antes** de mi
trabajo: vienen del `esquema.sql` original.

### Corrección aplicada

Revocado de `public`, `anon` y `authenticated` en las 23 funciones internas
(ayudantes del cron y funciones de trigger), con `grant` explícito a
`service_role` donde n8n lo necesita.

**Verificado después:** `cron_diario` sigue funcionando para n8n y las funciones
de trigger siguen disparando (la cadena `security definer` corre como el dueño,
no como quien llama).

Las tres que quedan abiertas a `anon` lo están **a propósito** y verifican la
sesión por dentro:

| Función | Por qué es correcta |
| --- | --- |
| `solicitar_restablecimiento` | Es el "olvidé mi contraseña": tiene que funcionar sin sesión |
| `listar_procesos` | Filtra por `puede_ver_carpeta()`; a un anónimo le devuelve vacío |
| `registrar_actividad` | Busca el perfil por `auth.uid()` y sale sin hacer nada si no hay |

---

## 3. 🟠 Suplantación de autor en `chat_mensajes` — CORREGIDO

La tabla `mensajes` está bien protegida: su política exige `perfil_id = auth.uid()`
**y** un trigger (`fijar_autor_mensaje`) sobrescribe los datos de autoría con los
reales.

`chat_mensajes` no tenía ninguna de las dos cosas. Su política era:

```sql
with check (puede_ver_carpeta(carpeta_id))
```

Sin verificar quién dice ser el autor. Y la tabla tiene columnas
`perfil_id`, `autor_usuario`, `autor_nombre`, `rol`, `es_ia`.

**Consecuencia:** un cliente o un acreedor con acceso a la carpeta podía insertar
un mensaje declarando `rol: 'administrador'`, el nombre de la fundación y
`es_ia: true`. En un expediente de insolvencia eso es suplantación dentro de una
pieza del proceso.

### Corrección aplicada

Mismo patrón que `mensajes`: trigger `fijar_autor_chat` que sobrescribe autoría
desde `auth.uid()` y fuerza `es_ia = false` para humanos, más la condición
`perfil_id = auth.uid()` en la política. Dos capas.

> **Dato que conviene revisar:** `chat_mensajes` tiene **18 filas reales** pero
> no está referenciada en el código de ninguna de las dos copias del proyecto.
> Viene de otro despliegue. No la borré — no es mi decisión. Vale la pena
> confirmar de dónde salen esos datos.

---

## 4. 🟠 Límites de uso (rate limiting) — CORREGIDO

### 4.1 "Olvidé mi contraseña"

`solicitar_restablecimiento` se llama **sin sesión** (es su razón de ser). Ya
evitaba repetir solicitudes del mismo usuario, pero nada impedía recorrer una
lista de nombres y llenar la campana del administrador con cientos de avisos.

Agregado un tope global: **10 solicitudes nuevas cada 15 minutos**. Sigue
devolviendo siempre lo mismo, exista o no el usuario y se haya alcanzado o no el
tope — no se revela información.

### 4.2 Formulario público del diagnóstico

El webhook de n8n no tenía ningún límite. Cualquiera podía inundar la tabla
`leads`.

Ahora n8n llama a `registrar_lead()` en vez de insertar directo, y **el tope vive
en el servidor**, no en el workflow:

| Tope | Valor |
| --- | --- |
| Por origen | 5 solicitudes / 10 minutos |
| Global | 60 solicitudes / 10 minutos |

**Probado:** corta exactamente en el 6º intento desde el mismo origen.

Sobre el origen: se guarda un **hash con sal** de la IP, nunca la IP. La IP es
dato personal bajo la **Ley 1581 de 2012**, y para contar repeticiones basta la
huella.

### 4.3 Ingreso al portal — recomendación, no corregido

Supabase Auth trae sus propios límites por IP en `signInWithPassword`. Lo que
**no** hay es bloqueo por cuenta tras N intentos fallidos. Para un portal con
datos de insolvencia vale la pena:

- Revisar los límites en Supabase → Authentication → Rate Limits
- Considerar bloqueo temporal de cuenta tras ~10 fallos
- Exigir contraseñas de más de 8 caracteres (hoy el mínimo lo pone Supabase)

No lo implementé porque requiere una Edge Function que intercepte el ingreso —
es un cambio de arquitectura que conviene decidir, no asumir.

---

## 5. Sesión y token — cómo funciona realmente

Hay **dos** cosas guardadas, y conviene no confundirlas:

| Qué | Dónde | Para qué | Si se manipula |
| --- | --- | --- | --- |
| `portal_sesion` | `localStorage` | Caché de UI: nombre, rol, 8 h | Solo cambia botones dibujados |
| Token JWT | `localStorage` (`sb-…-auth-token`) | **La sesión real** | Firmado por Supabase: no se puede falsificar |

El JWT lo maneja `supabase-js`: lo renueva solo y lo manda en cada petición.
`cerrarSesion()` hace `signOut()` además de limpiar `localStorage`, así que la
sesión se invalida de verdad en el servidor.

### Lo que sí conviene saber

El JWT vive en `localStorage`, que es el comportamiento por defecto de
`supabase-js`. Eso significa que **un XSS podría robarlo**. La defensa es que no
haya XSS — y eso lo revisé (sección 6).

Detalle menor: la caducidad de 8 h de `portal_sesion` es solo de la caché de UI.
El JWT tiene su propia caducidad (1 h por defecto, con renovación automática).
Si alguien borra `portal_sesion` pero conserva el JWT, sigue teniendo acceso
real a los datos hasta que el JWT expire. No es un hueco — el acceso está
autorizado — pero explica por qué "cerrar sesión" debe hacer `signOut()` y no
solo limpiar `localStorage`. **Ya lo hace correctamente.**

---

## 6. XSS — revisado, sin hallazgos

En un portal donde clientes y acreedores escriben en chats compartidos, un XSS
almacenado sería grave: robaría el JWT de quien lea el mensaje.

Revisado: `app.js` tiene **120 usos** de `escaparHtml()`, que escapa
`& < > " '` correctamente. Los puntos de entrada de datos de usuario están
cubiertos:

| Punto | Estado |
| --- | --- |
| Texto de mensajes de chat | Escapado |
| Nombres de autor | Escapado |
| Nombres de hoja de Excel | Escapado |
| Nombres de carpeta/archivo en diálogos | `textContent`, no `innerHTML` |
| Mensajes de error | Escapado |

Un punto que revisé y **no** es un hallazgo: `XLSX.utils.sheet_to_html()` vuelca
un Excel subido dentro de `innerHTML`. SheetJS escapa el contenido de las celdas,
así que no hay inyección. Queda anotado por si se cambia de librería.

---

## 7. Storage y base — estado

### Bien

| Control | Estado |
| --- | --- |
| Bucket `documentos` | **Privado** (no público) |
| Políticas de Storage | Por ruta: `<carpeta>/`, `chat/`, `soporte/` |
| Sobrescritura de archivos | Imposible: no hay política de UPDATE |
| RLS | Activo en **las 21 tablas** |
| RLS en tablas nuevas | Automático: hay un event trigger `rls_auto_enable` |
| Escrituras sensibles | Sin política de UPDATE; solo por funciones que validan permiso |
| Último administrador | Protegido por trigger contra borrado/desactivación |
| Registro público | Desactivado; usuarios solo por Edge Function que verifica admin |

### 🟡 Pendiente: tipos de archivo

El bucket tiene `allowed_mime_types: null` — **acepta cualquier tipo**. La lista
blanca (`pdf, doc, docx, xls, xlsx, png, jpg, jpeg, mp3, mp4`) vive **solo en el
navegador**, así que se puede saltar llamando a la API directo.

Riesgo real pero acotado: el bucket es privado y el visor no renderiza `.html`,
así que no hay ejecución directa. Aun así conviene fijar la lista en el servidor:

```sql
update storage.buckets
   set allowed_mime_types = array[
     'application/pdf',
     'application/msword',
     'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
     'application/vnd.ms-excel',
     'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
     'image/png','image/jpeg','audio/mpeg','video/mp4'
   ]
 where id = 'documentos';
```

No lo apliqué: si algún archivo ya subido tiene un MIME distinto, podría
estorbar. Decisión tuya.

### 🟡 Pendiente: desfase entre la base y `esquema.sql`

`chat_mensajes` y `hoja_trabajo` existen en la base pero **no están en
`esquema.sql`**. Eso rompe la premisa de que el archivo es la fuente de verdad
re-ejecutable: correrlo en un proyecto nuevo produciría una base distinta a la
de producción. Conviene volcarlas al archivo.

---

## 8. n8n — postura de seguridad

| Punto | Estado |
| --- | --- |
| Clave `service_role` | Solo en la credencial cifrada de n8n; nunca en el código ni en git |
| Acceso a n8n | Local (`localhost:5678`), no expuesto a internet |
| Workflows en git | Solo referencian la credencial por nombre, no su valor |
| Webhook público | Honeypot + validación + límite de uso |

### Antes de producción

1. **`allowedOrigins: "*"`** en el webhook → restringir al dominio real
2. **`N8N.URL`** en `diagnostico.html` apunta a `localhost` → URL pública
3. **n8n corre en tu PC** → mover a un servidor siempre encendido, con HTTPS
4. **`service_role` ignora RLS por completo.** Conviene un rol `n8n_bot` con
   `EXECUTE` solo sobre las funciones que necesita, en vez de la llave maestra

---

## 8-bis. Segunda vuelta: revisión de la base (2026-08-20)

Con Docker de vuelta se corrieron los *advisors* de Supabase y se revisó la
integridad de los datos.

### Avisos de seguridad

| | Antes | Ahora |
| --- | --- | --- |
| `function_search_path_mutable` | 7 | **0** |
| `anon_security_definer_function_executable` | 48 | 46 |
| `authenticated_security_definer_function_executable` | 50 | 50 |
| `auth_leaked_password_protection` | 1 | 1 |
| **Total** | 106 | **97** |

Sobre los 46 + 50 que quedan: Supabase marca **toda** función
`security definer` alcanzable por `anon` o `authenticated`, sin mirar si
verifica permisos por dentro. Se revisaron una por una:

- **40 de 48 verifican por dentro** (`es_admin()`, `puede_ver_carpeta()`,
  `auth.uid()`…). No son huecos.
- **8 no verifican**, y son aritmética de fechas sin acceso a datos:
  `es_dia_habil`, `sumar_dias_habiles`, `contar_dias_habiles`,
  `calcular_vencimiento_habil`, `calcular_semaforo`. Inofensivas.
- **2 sí se cerraron**: `rls_auto_enable` (es un *event trigger* del sistema:
  nadie debe invocarlo por HTTP) y `archivo_descargable_partes` (revelaba si
  una ruta de Storage existe y es descargable).

Queda **1 pendiente que solo puedes activar tú**, desde el panel:

> Supabase → Authentication → Policies → **Leaked Password Protection**
>
> Compara las contraseñas nuevas contra HaveIBeenPwned. Es un interruptor,
> no requiere código.

### `search_path` fijo — corregido

7 funciones no fijaban su camino de búsqueda. Cuatro de ellas
(`carpeta_de_ruta`, `chat_carpeta_de_ruta`, `chat_canal_de_ruta`,
`soporte_operador_de_ruta`) se usan **dentro de las reglas de Storage**: son las
que deciden a qué carpeta pertenece un archivo. Que su comportamiento dependa
de la sesión que las llama es una superficie que no vale la pena dejar abierta.

Todas usan solo funciones nativas de PostgreSQL, así que fijar el camino no
cambia lo que devuelven. **Comprobado**: se guardaron los valores de referencia
antes del cambio y se verificaron después — idénticos, incluida la ruta
inválida que debe devolver `null`.

### Rendimiento

88 avisos. Se corrigió lo que no tiene riesgo:

| Hallazgo | Cantidad | Acción |
| --- | --- | --- |
| Claves foráneas sin índice | 18 | **Corregido**: 18 índices nuevos |
| `auth.uid()` re-evaluado por fila en RLS | 21 | **No tocado** — ver abajo |
| Políticas permisivas múltiples | 45 | **No tocado** — ver abajo |
| Índices sin uso | 4 | Ignorado (recién creados) |

Las claves foráneas sin índice sí importaban: casi todas las tablas usan
`on delete cascade`, así que borrar una carpeta o un perfil obligaba a recorrer
varias tablas completas.

**Lo que decidí NO tocar, y por qué:**

Los 21 avisos de `auth_rls_initplan` se arreglan envolviendo `auth.uid()` en
`(select auth.uid())` dentro de cada política. Es la receta estándar de
Supabase y da una mejora real **a escala**. Pero implica reescribir 21 políticas
de control de acceso a mano, y un error de tipeo ahí no da un error visible:
abre un permiso. Con 3 carpetas y 9 perfiles la ganancia hoy es cero.

Lo mismo con las 45 políticas permisivas múltiples: consolidarlas cambia la
semántica de quién ve qué.

Las dejo documentadas como tarea aparte, para hacerlas con pruebas de acceso
por rol. Cambiar reglas de autorización para ganar rendimiento que todavía no
se necesita es mal negocio.

### Integridad de los datos — limpia

| Revisión | Resultado |
| --- | --- |
| Perfiles sin usuario de Auth | 0 |
| Archivos sin carpeta | 0 |
| Notificaciones a perfiles inexistentes | 0 |
| Procesos huérfanos | 0 |
| Carpetas sin operador o sin cliente | 0 |

Tres notas operativas, no fallas:

1. **Hay un solo administrador activo.** El trigger `proteger_ultimo_admin`
   impide borrarlo, pero si se pierde el acceso a esa cuenta no hay otra.
   Conviene un segundo administrador.
2. **6 perfiles activos sin correo de contacto.** Cuando entre el envío por
   correo, a esos usuarios no se les podrá avisar nada.
3. **Festivos cargados hasta 2027.** En 2028 el semáforo empieza a calcular
   plazos legales mal, en silencio.

### El workflow de leads — ahora sí probado

Quedaba sin verificar. Al probarlo falló:

```
Error: Module 'crypto' is disallowed
```

El nodo Code de n8n corre en un sandbox que bloquea los módulos de Node.
Se habilitó **solo** `crypto` (`NODE_FUNCTION_ALLOW_BUILTIN=crypto` en
`docker-compose.yml`), que es lo que convierte la IP en hash para no guardarla.

> El fallo fue **cerrado**: no se insertó ningún lead. Es el comportamiento
> correcto, pero el formulario habría mandado a todos al respaldo de Gmail.

Segundo problema: `registrar_lead` devolvía un escalar, y la forma en que el
cliente HTTP envuelve un escalar no es predecible. Se cambió a que devuelva una
**fila** (`returns table (id bigint)`), así PostgREST responde `[{"id": 11}]` y
n8n siempre lee `$json.id`. Cuando el tope frena, devuelve `[{"id": null}]`.

**Probado punta a punta:**

| Prueba | Resultado |
| --- | --- |
| Honeypot | HTTP 400 |
| Correo inválido | HTTP 400 |
| Leads 1–4 | `{"ok":true,"id":…}` |
| Lead 5 y 6 (mismo origen) | `{"ok":false,"error":"limite"}` |
| Hash de origen guardado | sí, la IP no |
| Cron de Fase 3 tras los cambios | `status: success` |

Filas de prueba borradas.

---

## 9. Lo que NO pude verificar

Honestidad sobre el alcance:

- ~~El cambio del workflow de leads está sin probar.~~ **Resuelto en la segunda
  vuelta** (sección 8-bis): probado punta a punta, incluidos dos fallos que
  aparecieron solo al ejecutarlo.
- **No probé la escalada de privilegios con una sesión real de cliente.** Verifiqué
  las políticas leyéndolas en vivo, que es sólido, pero no equivale a un intento
  real de explotación con un JWT de cliente.
- **No revisé el código del portal línea por línea.** `app.js` tiene 229 KB. Me
  concentré en los caminos que importan para lo que preguntaste: ingreso, sesión,
  autorización, y los puntos de entrada de datos de usuario.

---

## 10. Resumen de cambios aplicados

| Archivo | Qué |
| --- | --- |
| `portal/supabase/migracion_seguridad_2026_08.sql` | Migración con las correcciones |
| `n8n/workflows/fase1-lead-diagnostico.json` | Usa `registrar_lead()` + huella de origen *(sin probar)* |

**En la base:**

- 23 funciones internas cerradas a `anon`/`authenticated`/`public`
- Trigger `fijar_autor_chat` + política endurecida en `chat_mensajes`
- Tope de uso en `solicitar_restablecimiento`
- Función `registrar_lead()` con topes por origen y global
- Columna `leads.huella` (hash con sal, nunca la IP)

**Verificado tras los cambios:** el cron sigue corriendo, los triggers siguen
disparando, y el tope de leads corta donde debe.
