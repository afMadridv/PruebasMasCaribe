# Auditoría de seguridad del Portal Documental

Revisión de agosto de 2026. Cubre el ingreso, el manejo de sesión, la
verificación de rol, los límites de uso y la configuración de la base y el
almacenamiento. Los hallazgos se comprobaron consultando la base en vivo, no
solo leyendo el código.

## Resumen

El modelo de fondo es correcto: la verificación de rol ocurre en el servidor,
no en el navegador. La revisión encontró cuatro problemas reales, todos
corregidos, y dejó dos puntos abiertos que dependen de una decisión.

| Gravedad | Hallazgo | Estado |
| --- | --- | --- |
| Alta | Funciones internas ejecutables sin sesión | Corregido |
| Media alta | Suplantación de autor en `chat_mensajes` | Corregido |
| Media | Sin límite de uso en "olvidé mi contraseña" | Corregido |
| Media | `search_path` variable en funciones de Storage | Corregido |
| Baja | Storage acepta cualquier tipo de archivo | Abierto |
| Baja | Bloqueo de cuenta tras intentos fallidos | Abierto |

## 1. Dónde se verifica el rol

En el servidor. La cadena es esta:

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

`app.js` calcula `ES_ADMIN` leyendo `localStorage`, y eso solo decide qué
botones se dibujan. La autorización real la hace PostgreSQL:

```sql
create or replace function public.rol_actual()
returns text language sql stable security definer
as $$ select rol from public.perfiles where id = auth.uid() and activo; $$;
```

`auth.uid()` sale del JWT que firma Supabase, no de algo que el navegador pueda
escribir.

Si alguien edita `localStorage` y se pone `rol: "administrador"`, verá botones
de administrador en su pantalla, pero no podrá crear carpetas (el INSERT de
`carpetas` exige `es_admin()`), ni ver carpetas ajenas (`puede_ver_carpeta()`
consulta la base), ni cambiarse el rol: el UPDATE de `perfiles` exige
`es_admin()` y no existe ninguna política que deje a nadie editar su propio
perfil. La escalada de privilegios por esa vía está cerrada, confirmado leyendo
las políticas en vivo.

Queda una mejora cosmética, no un hueco: la interfaz podría dibujar los
controles a partir de una consulta a `perfiles` al arrancar en vez de fiarse de
`localStorage`. Hoy un usuario curioso ve botones que no funcionan, lo que
confunde sin comprometer nada.

## 2. Funciones internas ejecutables sin sesión

Corregido. Era el hallazgo más grave.

Varias funciones internas quedaban invocables por HTTP sin ninguna sesión. El
motivo es una trampa de PostgreSQL: toda función nace con `EXECUTE` concedido a
`PUBLIC`, y `anon` hereda ese permiso. Revocar solo de `anon` no sirve de nada.
El ACL lo delataba:

```
cron_diario: =X/postgres | postgres=X/postgres | service_role=X/postgres
             ↑
             ese "=X" sin nombre delante es PUBLIC
```

Encima, Supabase concede `EXECUTE` a `anon` y `authenticated` por defecto en
cada función nueva del esquema `public`. Hay que revocar de los tres.

Lo que se podía hacer sin sesión:

| Función | Consecuencia |
| --- | --- |
| `_notificar`, `_notificar_admins` | Insertar avisos falsos en la campana de cualquier usuario. Sirve para phishing: "Su trámite fue cancelado, llame al 300…" con la apariencia del portal |
| `cron_diario` y sus ayudantes | Disparar la tarea de plazos a voluntad, incluida la desactivación de carpetas |

`_notificar` y `_notificar_admins` venían abiertas desde el `esquema.sql`
original.

La corrección revocó `public`, `anon` y `authenticated` en las 23 funciones
internas (ayudantes de la tarea diaria y funciones de trigger). Después se
verificó que la tarea diaria sigue corriendo y que los triggers siguen
disparando: la cadena `security definer` se ejecuta como el dueño de la
función, no como quien la llama.

Tres funciones siguen abiertas a `anon` a propósito, porque verifican la sesión
por dentro:

| Función | Por qué es correcta |
| --- | --- |
| `solicitar_restablecimiento` | Es el "olvidé mi contraseña": tiene que funcionar sin sesión |
| `listar_procesos` | Filtra por `puede_ver_carpeta()`, así que a un anónimo le devuelve vacío |
| `registrar_actividad` | Busca el perfil por `auth.uid()` y no hace nada si no lo encuentra |

## 3. Suplantación de autor en `chat_mensajes`

Corregido.

La tabla `mensajes` está bien protegida: su política exige
`perfil_id = auth.uid()` y además un trigger (`fijar_autor_mensaje`) sobrescribe
los datos de autoría con los reales.

`chat_mensajes` no tenía ninguna de las dos cosas. Su política era solo:

```sql
with check (puede_ver_carpeta(carpeta_id))
```

Nada verificaba quién decía ser el autor, y la tabla tiene columnas
`perfil_id`, `autor_usuario`, `autor_nombre`, `rol` y `es_ia`. Un cliente o un
acreedor con acceso a la carpeta podía insertar un mensaje declarando
`rol: 'administrador'`, el nombre de la fundación y `es_ia: true`. En un
expediente de insolvencia eso es suplantación dentro de una pieza del proceso.

La corrección aplica el mismo patrón de `mensajes`: un trigger
`fijar_autor_chat` que sobrescribe la autoría desde `auth.uid()` y fuerza
`es_ia = false` para los humanos, más la condición `perfil_id = auth.uid()` en
la política.

Conviene revisar un detalle: `chat_mensajes` tiene 18 filas reales pero no
aparece referenciada en el código del portal. Viene de otro despliegue. No se
borró porque no era una decisión de la auditoría, pero vale la pena confirmar de
dónde salieron esos datos.

## 4. Límites de uso

### Olvidé mi contraseña

`solicitar_restablecimiento` se llama sin sesión, que es su razón de ser. Ya
evitaba repetir solicitudes del mismo usuario, pero nada impedía recorrer una
lista de nombres y llenar la campana del administrador con cientos de avisos.

Se agregó un tope global de 10 solicitudes nuevas cada 15 minutos. La función
sigue devolviendo siempre lo mismo, exista o no el usuario y se haya alcanzado o
no el tope, así que no revela información.

### Ingreso al portal

Abierto, es una recomendación.

Supabase Auth trae sus propios límites por IP en `signInWithPassword`. Lo que no
hay es bloqueo por cuenta tras N intentos fallidos. Para un portal con datos de
insolvencia vale la pena revisar los límites en Supabase (Authentication, Rate
Limits), considerar un bloqueo temporal de cuenta tras unos 10 fallos y exigir
contraseñas de más de 8 caracteres.

No se implementó porque requiere una Edge Function que intercepte el ingreso, y
eso es un cambio de arquitectura que conviene decidir antes de asumir.

## 5. Sesión y token

Hay dos cosas guardadas y conviene no confundirlas:

| Qué | Dónde | Para qué | Si se manipula |
| --- | --- | --- | --- |
| `portal_sesion` | `localStorage` | Caché de interfaz: nombre, rol, 8 h | Solo cambia los botones que se dibujan |
| Token JWT | `localStorage` (`sb-…-auth-token`) | La sesión real | Lo firma Supabase: no se puede falsificar |

`supabase-js` maneja el JWT: lo renueva solo y lo manda en cada petición.
`cerrarSesion()` llama a `signOut()` además de limpiar `localStorage`, así que
la sesión se invalida de verdad en el servidor.

El JWT vive en `localStorage`, que es el comportamiento por defecto de
`supabase-js`. Eso significa que un XSS podría robarlo, y por eso la revisión
de XSS de la sección 6 importa tanto.

Un detalle que suele confundir: la caducidad de 8 horas de `portal_sesion` es
solo de la caché de interfaz. El JWT tiene su propia caducidad, una hora por
defecto con renovación automática. Si alguien borra `portal_sesion` pero
conserva el JWT, sigue teniendo acceso real a los datos hasta que el JWT expire.
No es un hueco, porque ese acceso está autorizado, pero explica por qué cerrar
sesión tiene que llamar a `signOut()` y no limpiar `localStorage` nada más. El
código ya lo hace bien.

## 6. XSS

Revisado, sin hallazgos.

En un portal donde clientes y acreedores escriben en chats compartidos, un XSS
almacenado sería grave: robaría el JWT de quien lea el mensaje.

`app.js` tiene 120 usos de `escaparHtml()`, que escapa `& < > " '`
correctamente. Los puntos de entrada de datos de usuario están cubiertos:

| Punto | Estado |
| --- | --- |
| Texto de mensajes de chat | Escapado |
| Nombres de autor | Escapado |
| Nombres de hoja de Excel | Escapado |
| Nombres de carpeta y archivo en diálogos | `textContent`, no `innerHTML` |
| Mensajes de error | Escapado |

Un punto que se revisó y no resultó ser un hallazgo: `XLSX.utils.sheet_to_html()`
vuelca un Excel subido dentro de `innerHTML`. SheetJS escapa el contenido de las
celdas, así que no hay inyección. Queda anotado por si algún día se cambia de
librería.

## 7. Storage y base de datos

Lo que está bien:

| Control | Estado |
| --- | --- |
| Bucket `documentos` | Privado |
| Políticas de Storage | Por ruta: `<carpeta>/`, `chat/`, `soporte/` |
| Sobrescritura de archivos | Imposible, no hay política de UPDATE |
| RLS | Activo en las 20 tablas |
| RLS en tablas nuevas | Automático, hay un event trigger `rls_auto_enable` |
| Escrituras sensibles | Sin política de UPDATE, solo por funciones que validan permiso |
| Último administrador | Protegido por trigger contra borrado y desactivación |
| Registro público | Desactivado, los usuarios solo se crean por Edge Function que verifica admin |

### Tipos de archivo

Abierto.

El bucket tiene `allowed_mime_types: null`, así que acepta cualquier tipo. La
lista blanca (`pdf, doc, docx, xls, xlsx, png, jpg, jpeg, mp3, mp4`) vive solo
en el navegador y se puede saltar llamando a la API directo.

El riesgo es real pero acotado: el bucket es privado y el visor no renderiza
`.html`, así que no hay ejecución directa. Aun así conviene fijar la lista en el
servidor:

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

No se aplicó porque si algún archivo ya subido tiene un MIME distinto podría
estorbar. Requiere revisar antes qué hay en el bucket.

### search_path fijo

Corregido.

Siete funciones no fijaban su camino de búsqueda. Cuatro de ellas
(`carpeta_de_ruta`, `chat_carpeta_de_ruta`, `chat_canal_de_ruta` y
`soporte_operador_de_ruta`) se usan dentro de las reglas de Storage: son las que
deciden a qué carpeta pertenece un archivo. Que su comportamiento dependa de la
sesión que las llama es una superficie que no vale la pena dejar abierta.

Todas usan solo funciones nativas de PostgreSQL, así que fijar el camino no
cambia lo que devuelven. Se guardaron los valores de referencia antes del cambio
y se compararon después: idénticos, incluida la ruta inválida que debe devolver
`null`.

### Avisos de Supabase

Los *advisors* pasaron de 106 a 97 avisos de seguridad. Los 96 que quedan son
casi todos de una misma categoría: Supabase marca toda función `security
definer` alcanzable por `anon` o `authenticated`, sin mirar si verifica permisos
por dentro. Se revisaron una por una.

Cuarenta de cuarenta y ocho verifican por dentro con `es_admin()`,
`puede_ver_carpeta()` o `auth.uid()`, así que no son huecos. Ocho no verifican
nada, pero son aritmética de fechas sin acceso a datos: `es_dia_habil`,
`sumar_dias_habiles`, `contar_dias_habiles`, `calcular_vencimiento_habil` y
`calcular_semaforo`. Dos sí se cerraron: `rls_auto_enable`, que es un event
trigger del sistema y nadie debe invocar por HTTP, y
`archivo_descargable_partes`, que revelaba si una ruta de Storage existe y es
descargable.

Queda un aviso que solo se puede resolver desde el panel de Supabase, en
Authentication, Policies: activar Leaked Password Protection, que compara las
contraseñas nuevas contra HaveIBeenPwned. Es un interruptor, no requiere código.

### Rendimiento

De los 88 avisos de rendimiento se corrigió lo que no tiene riesgo:

| Hallazgo | Cantidad | Acción |
| --- | --- | --- |
| Claves foráneas sin índice | 18 | Corregido, 18 índices nuevos |
| `auth.uid()` re-evaluado por fila en RLS | 21 | Sin tocar, ver abajo |
| Políticas permisivas múltiples | 45 | Sin tocar, ver abajo |
| Índices sin uso | 4 | Ignorado, recién creados |

Las claves foráneas sin índice sí importaban: casi todas las tablas usan
`on delete cascade`, así que borrar una carpeta o un perfil obligaba a recorrer
varias tablas completas.

Los 21 avisos de `auth_rls_initplan` se arreglan envolviendo `auth.uid()` en
`(select auth.uid())` dentro de cada política. Es la receta estándar de Supabase
y mejora el rendimiento a escala, pero implica reescribir 21 políticas de
control de acceso a mano, y un error de tipeo ahí no produce un fallo visible:
abre un permiso. Con tres carpetas y nueve perfiles la ganancia hoy es nula.
Consolidar las 45 políticas permisivas múltiples tiene el mismo problema, porque
cambia la semántica de quién ve qué.

Las dos quedan como tarea aparte, para hacerlas con pruebas de acceso por rol.
Cambiar reglas de autorización para ganar un rendimiento que todavía no hace
falta es mal negocio.

### Integridad de los datos

Limpia.

| Revisión | Resultado |
| --- | --- |
| Perfiles sin usuario de Auth | 0 |
| Archivos sin carpeta | 0 |
| Notificaciones a perfiles inexistentes | 0 |
| Procesos huérfanos | 0 |
| Carpetas sin operador o sin cliente | 0 |

Queda una nota operativa, no una falla: hay 6 perfiles activos sin correo de
contacto. Cuando se active el envío por correo, a esos usuarios no se les podrá
avisar nada.

## 8. Alcance de la revisión

Dos cosas quedaron fuera y conviene saberlo.

No se probó la escalada de privilegios con una sesión real de cliente. Las
políticas se verificaron leyéndolas en vivo, que es sólido, pero no equivale a
un intento real de explotación con un JWT de cliente.

No se revisó el código del portal línea por línea. `app.js` tiene más de 230 KB.
La revisión se concentró en los caminos que importan para la pregunta: ingreso,
sesión, autorización y los puntos de entrada de datos de usuario.

## 9. Cambios aplicados

Todo vive en `portal/supabase/migracion_seguridad_2026_08.sql`, que es
idempotente:

- 23 funciones internas cerradas a `public`, `anon` y `authenticated`
- Trigger `fijar_autor_chat` y política endurecida en `chat_mensajes`
- Tope de uso en `solicitar_restablecimiento`
- 16 índices en claves foráneas
- `search_path` fijo en las utilidades de ruta

Después de aplicarlos se verificó que la tarea diaria sigue corriendo, que los
triggers siguen disparando y que las funciones de ruta devuelven exactamente lo
mismo que antes.
