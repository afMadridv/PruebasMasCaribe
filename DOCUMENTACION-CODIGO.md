# Documentación del código

Portal Documental de la Fundación MASCaribe. Este documento explica cómo está
armado el software por dentro: qué hace cada archivo, cómo se hablan entre sí y
qué hay que saber antes de tocar algo.

Para el contexto del proyecto y el estado de la base de datos, ver
[CONTEXTO-PROYECTO.md](CONTEXTO-PROYECTO.md). Para el modelo de seguridad y la
auditoría, ver [AUDITORIA-SEGURIDAD.md](AUDITORIA-SEGURIDAD.md).

## Lo primero que hay que entender

No hay compilación. No hay `package.json`, ni bundler, ni framework. Son
archivos HTML, CSS y JavaScript que el navegador carga tal cual. Se edita un
archivo, se recarga la página y ya está.

Esto es deliberado. El portal lo va a mantener gente que rota, y un proyecto sin
cadena de construcción no se rompe porque una dependencia cambió de versión dos
años después.

La consecuencia es que no hay módulos ES. Todos los archivos comparten el mismo
ámbito global y el orden de carga importa.

## Mapa de archivos

```
index.html                    redirección al diagnóstico
404.html                      página de error, con su CSS embebido a propósito
portal/
  index.html                  ingreso
  app.html                    la aplicación entera, en una sola página
  diagnostico.html            cuestionario público de insolvencia
  privacidad.html             política de tratamiento de datos
  terminos.html               términos de uso
  css/
    portal.css                base: tokens de color, tipografía, componentes
    diseno.css                capa de rediseño, se carga después de portal.css
    sitio.css                 sitio público
    style.css                 diagnóstico
    legal.css                 páginas legales
  js/
    db.js                     capa de datos, modo práctica (IndexedDB)
    auth.js                   sesión, roles y contraseñas del modo práctica
    config.js                 URL y clave pública de Supabase, y el modo
    iconos.js                 catálogo de iconos SVG
    tema.js                   interruptor claro/oscuro
    nube.js                   capa de datos, modo nube (Supabase)
    app.js                    toda la lógica de la aplicación
    diasHabiles.js            calendario de días hábiles colombianos
    login.js                  pantalla de ingreso
    legal.js                  páginas legales
  supabase/
    esquema.sql               esquema completo, idempotente
    migracion_*.sql           cambios posteriores, cada uno aplicable solo
    functions/                funciones de servidor (Deno)
```

## Orden de carga y por qué es ese

En `app.html`, al final del `body`:

```
supabase-js (CDN)   el cliente de Supabase
db.js               define dbTodos, dbObtener y compañía sobre IndexedDB
auth.js             define sesionActual, iniciarSesion, ETIQUETAS_ROL
config.js           define PORTAL_CONFIG con el MODO
iconos.js           define icono()
tema.js             aplica el tema guardado
nube.js             si MODO es 'nube', SOBREESCRIBE lo que definió db.js
app.js              usa esos nombres sin saber cuál de los dos está activo
```

La pieza clave es que `nube.js` se carga después de `db.js` y reemplaza sus
funciones por las versiones que hablan con Supabase. `app.js` llama siempre a
`dbTodos('carpetas')` sin preguntar de dónde salen los datos.

Si `PORTAL_CONFIG.MODO` es `'local'`, `nube.js` no reemplaza nada y el portal
funciona entero contra IndexedDB, sin red. Eso es el modo práctica: sirve para
probar la interfaz y para capacitar sin tocar datos reales.

## Las dos capas de datos

`db.js` y `nube.js` implementan el mismo contrato: unas setenta funciones
globales con el mismo nombre y la misma firma. La lista completa está en
`nube.js`, todas asignadas como `window.<nombre>`.

Algunas funciones existen en `db.js` solo para que el contrato esté completo y
no hacen nada, porque no tienen sentido en un solo navegador:
`suscribirMensajesNuevos`, `suscribirNotificaciones`, `presenciaIniciar`,
`llamadaCrear`, `canalSenalizacion`. Devuelven una baja vacía o `null`.

Al tocar una de estas funciones hay que tocar las dos versiones, o el modo
práctica se desincroniza del real.

### Detalle que se pasa por alto

`db.js` no es solo el modo práctica. También define `fechaISOLocal`, que usan
`app.js` y `nube.js` en modo nube. Si alguien borra `db.js` pensando que sobra
porque el portal corre en la nube, rompe producción.

## El modelo de seguridad

Los permisos se aplican en la base de datos, no en el navegador.

En PostgreSQL, la función `rol_actual()` lee el rol del usuario desde la tabla
`perfiles` usando `auth.uid()`, que sale del token JWT firmado por Supabase. Las
78 políticas de seguridad a nivel de fila deciden qué puede leer y escribir cada
quien a partir de eso.

En el navegador, las constantes `ES_ADMIN`, `ES_OPERADOR`, `ES_MONITOR` y demás
salen de la sesión guardada en `localStorage`. Sirven **solo para decidir qué
botones se dibujan**. Alguien que edite ese `localStorage` verá botones que no le
tocan, y al pulsarlos la base de datos le dirá que no.

Esa separación es intencional y no debe difuminarse. Si aparece una regla de
negocio que solo vive en `app.js`, es un agujero.

### La trampa de los permisos PUBLIC

En PostgreSQL toda función nace con `EXECUTE` concedido a `PUBLIC`, y Supabase
además concede a `anon` y `authenticated`. Revocar de `anon` no basta: el rol
hereda de `PUBLIC`. Hay que revocar de los tres.

```sql
revoke execute on function public.mi_funcion(...) from public, anon, authenticated;
```

Esto ya está corregido en `migracion_seguridad_2026_08.sql`, que lo hace en un
bucle sobre todas las funciones internas. Cualquier función nueva tiene que
repetir el patrón.

### Rutas de Storage

El bucket `documentos` es privado. Las rutas siguen este formato:

```
<id-carpeta>/<archivo>                    documento en la raíz de la carpeta
<id-carpeta>/<id-subcarpeta>/<archivo>    documento dentro de una subcarpeta
chat/<id-carpeta>/<canal>/...             adjunto de chat
soporte/<uuid-operador>/...               adjunto de soporte
```

La función `carpeta_de_ruta()` mira **solo el primer segmento**, y de ella
dependen todas las políticas del bucket. Por eso las subcarpetas se pudieron
añadir sin tocar ninguna regla de seguridad.

## Reglas de negocio que hay que conocer

### Días hábiles colombianos

`diasHabiles.js` cuenta días hábiles saltando sábados, domingos y festivos. Los
festivos están cargados en la tabla `festivos_colombia` hasta 2030.

Colombia mueve varios festivos al lunes siguiente por la Ley 51 de 1983, y otros
dependen de la Pascua. El algoritmo reproduce exactamente los calendarios
oficiales de 2024 a 2027, que es como se verificó antes de confiar en él para
2028 a 2030.

Las fechas de vencimiento las calcula **el servidor**, no el navegador. El
navegador solo las muestra.

### Semáforos

Cada proceso de un trámite tiene un plazo en días hábiles. El color lo calcula
`calcular_semaforo()` en la base y llega ya resuelto al cliente.
`semaforoEfectivo()` en `app.js` solo lo lee, y devuelve gris si la carpeta
entera está en pausa.

Rojo es vencido sin completar. Naranja es cero o un día hábil restante. Verde es
todo lo demás, o completado a tiempo.

### Pausas y prórrogas

Pausar un trámite detiene el reloj. Al reactivarlo, los vencimientos se corren
tantos días hábiles como duró la pausa. La prórroga es única por trámite y el
servidor la rechaza si ya se usó.

### Aviso diario de vencimientos

`cron_plazos_diario()` corre todos los días a las 12:00 UTC mediante pg_cron y
genera notificaciones de los procesos por vencer.

Solo avisa del umbral más bajo que aplique (5, 3 o 1 día) y solo cuando se cruza
hacia abajo. Sin eso, un proceso a un día de vencer disparaba los tres avisos a
la vez todas las mañanas.

### Medios y documentos

La subcarpeta cuyo nombre contiene «audiencia» acepta solo audio y video. El
resto de la carpeta acepta solo documentos. La regla está en
`destinoAdmiteExtension()` y se aplica al subir y al mover.

Es una regla del cliente. No la respalda una restricción en la base, así que
alguien con el token podría saltársela llamando a Storage directamente.

## Cómo está organizado app.js

Son unas 5.800 líneas en un solo archivo, dividido en secciones marcadas con
comentarios de banda:

```
CONSTANTES Y SESIÓN          roles, extensiones permitidas, tamaño máximo
UTILIDADES                   escaparHtml, extensionDe, formatoFecha, avisar
BARRA LATERAL                cajón en móvil, plegado en escritorio
CACHÉ DE NAVEGACIÓN          copias en memoria de carpetas, procesos y perfiles
NAVEGACIÓN ENTRE VISTAS      mostrarVista y las cinco secciones
VISTA: CARPETAS              lista, panorama, filtros
VISTA: ESTADOS               tablero por urgencia, tabla, procesos del trámite
VISTA: CALENDARIO            vencimientos del despacho
CHAT DEL TRÁMITE             canales cliente y acreedor
SOPORTE                      hilos y llamada de voz
CAMPANA                      notificaciones
DIÁLOGOS PROPIOS             confirmarPortal y pedirTextoPortal
DETALLE DE CARPETA           pestañas, subcarpetas, documentos, audiencias
EXPEDIENTE                   unión de PDF e imágenes en un solo archivo
ARCHIVOS                     subida, descarga, visores, ZIP
USUARIOS                     alta, edición, roles
ACTIVIDAD                    registro y filtros
DESPACHADOR DE ACCIONES      el switch de data-accion
```

### El despachador de acciones

No hay `addEventListener` por botón. Hay un solo escuchador de `click` en
`document` que lee `data-accion` del elemento más cercano y entra en un `switch`
de 122 casos.

```html
<button data-accion="abrir-carpeta" data-id="12">Abrir</button>
```

Ventaja: el HTML generado dinámicamente funciona sin volver a conectar nada.
Consecuencia: para añadir una acción hay que tocar dos sitios, el HTML que la
emite y el `switch` que la atiende.

Los `<select>` usan `data-accion-cambio` y un escuchador de `change` aparte.

### La caché de navegación

Cada cambio de sección pedía otra vez al servidor los mismos conjuntos. Ahora
`cacheLeer` devuelve la copia guardada para pintar al instante, y
`cacheRefrescar` consulta y solo repinta si el JSON cambió.

La caché se descarta envolviendo `registrarActividad`: toda acción que no esté
en `ACCIONES_DE_LECTURA` la limpia. Se hizo así para no tener que acordarse de
invalidar en treinta sitios distintos.

## Convenciones

El código está en español, incluidos nombres de funciones y variables. Es
consistente en todo el proyecto y así debe seguir.

Las clases CSS llevan prefijo `pt-` y siguen BEM: `pt-bloque__elemento--variante`.

`portal.css` fija `html { font-size: 62.5% }`, es decir **1rem = 10px**. Todos
los valores en rem de `diseno.css` ya vienen convertidos a esa base. Un
`1.352rem` son 13,5 píxeles, no 21,6.

Las variables privadas de módulo empiezan con guion bajo: `_archivosCache`,
`_seleccionExpediente`.

Todo lo que venga del usuario pasa por `escaparHtml()` antes de entrar en un
`innerHTML`. Sin excepciones.

## Trampas conocidas

**`margin: 0 auto` sobre un elemento flex** cancela el estirado. Es lo que hacía
que las vistas se encogieran al ancho de su contenido dejando un hueco a la
derecha.

**`overflow: hidden` sobre un contenedor de filas** recorta los menús «...». Los
contenedores de tabla usan `overflow: visible` y el menú se voltea hacia arriba
cuando está cerca del borde inferior.

**pdf-lib con PDF de origen dudoso.** Los archivos que llegan de escáneres y
juzgados traen referencias internas colgantes. `PDFCatalog.Pages()` lanza
`Expected instance of ..., but got instance of undefined` al resolverlas.
`unirPdfAlExpediente()` carga con `throwOnInvalidObject: false` y, si la copia en
bloque falla, copia página por página. Cada documento va además en su propio
`try`, para que uno roto no tumbe el lote entero.

**Las bibliotecas pesadas se cargan bajo demanda.** pdf-lib, docx-preview y
SheetJS entran por CDN la primera vez que hacen falta, y la promesa se guarda
para no cargarlas dos veces. Si no hay conexión, la función avisa en vez de
fallar en silencio.

## Modo práctica para desarrollo

Para trabajar en la interfaz sin tocar Supabase, se copia `portal/app.html` y se
sustituye la etiqueta de `config.js` por:

```html
<script>const PORTAL_CONFIG={MODO:"local",SUPABASE_URL:"",SUPABASE_KEY:"",
DOMINIO_USUARIOS:"portal.fundacion"};</script>
```

Con eso `nube.js` no reemplaza nada y todo corre contra IndexedDB.
`sembrarDatosIniciales()` crea las cuentas y carpetas de prueba. La cuenta de
administrador de práctica es `administrador` / `administrador123`.

Subir `DB_VERSION` en `db.js` borra y recrea los almacenes de práctica. Son datos
de prueba: no hay nada que conservar.

## Despliegue

El sitio es estático y se publica en Vercel desde la rama `main`. No hay paso de
construcción.

Los cambios de base de datos van en archivos `migracion_*.sql` aplicables uno a
uno. `esquema.sql` es idempotente y describe el estado completo: sirve para
levantar el proyecto desde cero, no para actualizar uno existente.

Las funciones de servidor se despliegan con `supabase functions deploy <nombre>`.
Usan la clave de servicio, que vive solo ahí y nunca llega al navegador.
