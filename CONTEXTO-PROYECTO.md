# Contexto del proyecto: Portal Documental de la Fundación MASCaribe

## 1. Qué es

Dos aplicaciones web estáticas para una fundación colombiana dedicada a la
insolvencia de persona natural no comerciante.

| App | Archivo | Público | Función |
| --- | --- | --- | --- |
| Diagnóstico | `portal/diagnostico.html` | Abierto a internet | Calculadora que le dice a una persona si cumple los requisitos legales de insolvencia, y captura sus datos de contacto |
| Portal Documental | `portal/app.html` | Con sesión | Gestión del trámite: carpetas, documentos, plazos, chats, audiencias y notificaciones |

El `index.html` de la raíz solo redirige a `portal/diagnostico.html`, así que la
puerta de entrada pública es el diagnóstico.

El backend es Supabase (proyecto `hheyihgktcswvxiscvdm`): PostgreSQL con RLS,
Auth, Storage y Edge Functions. No hay servidor propio.

Dos convenciones que conviene respetar. Todo está en español: nombres de tablas,
funciones SQL, variables de JavaScript, comentarios e interfaz. Y los comentarios
del código explican la intención legal, no solo la técnica; son valiosos, no los
borres al refactorizar.

Las librerías pesadas (`pdf-lib`, `JSZip`, `docx-preview` y SheetJS) se cargan
desde CDN solo cuando hacen falta.

## 2. Estructura de archivos

```
PruebasMascaribe\
├── index.html                      redirección a portal/diagnostico.html
├── 404.html                        página de error, autocontenida
├── CONTEXTO-PROYECTO.md            este documento
├── AUDITORIA-SEGURIDAD.md          seguridad: corregido y pendiente
└── portal\
    ├── diagnostico.html            sitio público: diagnóstico y pie legal
    ├── index.html                  pantalla de ingreso
    ├── app.html                    shell del portal, vistas en <section hidden>
    ├── privacidad.html             política de tratamiento de datos
    ├── terminos.html               términos de uso
    ├── css\
    │   ├── portal.css              base del portal: tokens y componentes
    │   ├── diseno.css              rediseño de pantallas: estructura y densidad
    │   ├── style.css               base del sitio público
    │   ├── sitio.css               el sitio con el lenguaje del portal
    │   └── legal.css               páginas legales
    ├── js\
    │   ├── config.js               URL y clave publishable de Supabase, MODO
    │   ├── auth.js                 sesión en localStorage, 8 horas
    │   ├── login.js                pantalla de ingreso
    │   ├── db.js                   capa de datos en modo 'local' (IndexedDB)
    │   ├── nube.js                 capa de datos en modo 'nube' (Supabase)
    │   ├── app.js                  toda la lógica del portal
    │   ├── diasHabiles.js          días hábiles colombianos, festivos 2024-2030
    │   ├── iconos.js               SVGs en línea
    │   ├── tema.js                 claro y oscuro del portal
    │   └── legal.js                claro y oscuro de las páginas legales
    └── supabase\
        ├── esquema.sql              esquema completo, idempotente
        ├── migracion_cierre_y_descargas.sql
        ├── migracion_seguridad_2026_08.sql
        ├── migracion_festivos_y_cron.sql
        └── migracion_subcarpetas.sql
```

No hay proceso de compilación. Se abren los `.html` con cualquier servidor
estático, sin `npm install` ni dependencias que instalar.

Un detalle que sorprende: `db.js` no es opcional aunque el modo sea 'nube'.
Define `fechaISOLocal`, que usan `app.js` y `nube.js`. Además sirve el modo de
práctica (`MODO: 'local'`), que corre sin internet contra IndexedDB.

## 3. Modelo de dominio

La pieza central es la carpeta, que representa un trámite de insolvencia
completo. Dentro viven los documentos, los plazos, los chats, las audiencias y
la información del deudor.

### Roles

| Rol | Alcance |
| --- | --- |
| `administrador` | Control total. El único que crea usuarios, finaliza trámites y aplica prórrogas |
| `monitor` | Ve todo en modo lectura, menos la pestaña de usuarios. No crea ni edita nada |
| `operador` | Solo ve las carpetas donde aparece en `carpeta_operadores`. Sube archivos y gestiona plazos ahí |
| `cliente` | El deudor. Ve y lee su carpeta activa asignada |
| `acreedor` | Ve y lee la carpeta asignada. Nunca accede a `deudores_info`, ni en lectura |

Los usuarios no usan un correo real como identidad. Se inicia sesión con un
nombre de usuario que internamente se convierte en `usuario@portal.fundacion`
(`PORTAL_CONFIG.DOMINIO_USUARIOS`). El campo `perfiles.correo` es solo un correo
de contacto opcional.

### Tablas principales

| Tabla | Qué guarda |
| --- | --- |
| `perfiles` | Complemento de `auth.users`: usuario, nombre, rol, activo, correo, `primer_login` |
| `carpetas` | El trámite: nombre, descripción, activa, pausado, finalizado, fechas y plazos |
| `subcarpetas` | Agrupan los documentos dentro de una carpeta. Un solo nivel |
| `carpeta_asignados` | Qué cliente o acreedor ve qué carpeta |
| `carpeta_operadores` | Qué operador es responsable de qué carpeta |
| `archivos` | Metadatos de documentos. El binario vive en el bucket `documentos`. Tiene `orden` manual, `descargable_partes` y `subcarpeta_id` |
| `procesos_tramite` | Etapas con plazo en días hábiles y semáforo |
| `festivos_colombia` | Festivos oficiales 2024-2030, según la Ley 51 de 1983 |
| `mensajes` | Chat por carpeta, canal `cliente` o `acreedor`, con adjuntos |
| `mensajes_soporte` | Chat entre administrador y operador, un hilo por operador |
| `llamadas_soporte` | Señalización de llamadas WebRTC. Solo las inicia el administrador |
| `audiencias` | Fechas de audiencia con hora y enlace de reunión |
| `recordatorios` | Notas personales por carpeta. Solo las ve quien las crea |
| `notificaciones` | Campana del portal, por destinatario |
| `actividad` | Bitácora de auditoría: ingresos, vistas, descargas y cambios |
| `deudores_info` | Datos del deudor y su apoderado, según la Ley 2445 de 2025. Una fila por carpeta |
| `consentimientos` | Aceptación del tratamiento de datos, con versión de política |
| `solicitudes_clave` | "Olvidé mi contraseña". El administrador las resuelve a mano |

### Storage

Un solo bucket, `documentos`, con tres convenciones de ruta de las que dependen
las políticas de acceso:

```
<id-carpeta>/<archivo>                    documentos del trámite
<id-carpeta>/<id-subcarpeta>/<archivo>    documentos dentro de una subcarpeta
chat/<id-carpeta>/<canal>/...             adjuntos de chat
soporte/<uuid-operador>/...               adjuntos de soporte
```

La función `carpeta_de_ruta()` lee el primer segmento, y de ella dependen todas
las políticas del bucket. Por eso las subcarpetas pudieron añadirse sin tocar
ninguna regla de seguridad: el primer segmento sigue siendo el id de la carpeta.

Límite de 50 MB por archivo, que es el `file_size_limit` del bucket.

Las extensiones se reparten en dos grupos y el destino decide cuál acepta. Los
documentos (`pdf, doc, docx, xls, xlsx, png, jpg, jpeg`) van en la raíz de la
carpeta y en cualquier subcarpeta que no sea de audiencias. Los medios (`mp3,
mp4, m4a, wav, ogg, mov, webm`) solo entran en la subcarpeta de audiencias,
que se reconoce porque su nombre contiene «audiencia», sin distinguir
mayúsculas ni tildes. La regla vive en `destinoAdmiteExtension()` y se aplica
tanto al subir como al mover entre subcarpetas.

## 4. Las reglas de negocio que hay que entender

### Semáforo por días hábiles colombianos

Cada proceso tiene un plazo en días hábiles. El color lo calcula solo el
servidor, con `calcular_semaforo`, expuesto a través de la RPC `listar_procesos`.
El navegador pinta lo que recibe y no recalcula nada.

| Color | Condición |
| --- | --- |
| `verde` | Completado, o faltan dos días hábiles o más |
| `naranja` | Hoy es el último día hábil, o falta uno |
| `rojo` | Vencido sin completar |
| `pausado` | El trámite está en pausa y el reloj se detiene |

El administrador puede forzar el color con `semaforo_manual`.

Cuidado con esto: la lista de festivos está duplicada en `js/diasHabiles.js`
(la constante `FESTIVOS_COLOMBIA`) y en la tabla `festivos_colombia`. Si se
agrega un año en un lado hay que agregarlo en el otro, o el navegador y el
servidor calcularán plazos legales distintos. Están cargados hasta 2030.

### Ciclo de vida del trámite

```
crear carpeta
  └─ iniciar_tramite()      fija la fecha de inicio y el vencimiento (60 o 90 días hábiles)
       ├─ crear_proceso_tramite() / completar_proceso()   etapas con semáforo
       ├─ pausar_tramite() / reactivar_tramite()          congela y reanuda todos los relojes
       ├─ aplicar_prorroga()                              solo una vez (tiene_prorroga)
       └─ finalizar_tramite()   [solo administrador]
            └─ 30 días hábiles de gracia para descargar   (dias_gracia_cierre())
                 └─ cron_plazos_diario() desactiva la carpeta
```

### Notificaciones

Se insertan solo desde triggers de PostgreSQL: `notif_mensaje_nuevo`,
`notif_archivo_nuevo`, `notif_soporte_nuevo`, `notif_proceso_cambio`,
`notif_carpeta_cambio` y `notif_fin_tramite`.

Hay una regla explícita: el administrador nunca recibe notificación de los chats
entre cliente y operador ni entre acreedor y operador. El filtro vive en
`notif_mensaje_nuevo`.

Realtime está habilitado en `mensajes`, `mensajes_soporte`, `llamadas_soporte` y
`notificaciones`.

### Tarea diaria de plazos

`cron_plazos_diario()` corre todos los días a las 12:00 UTC, que son las 7:00 en
Colombia, disparada por `pg_cron`. Avisa a los administradores de los procesos
vencidos y desactiva las carpetas cuyo plazo de descarga ya se cumplió. Solo
actúa en días hábiles y es idempotente.

Existe porque las dos funciones originales dependían de que alguien abriera el
portal: `generar_notificaciones_vencidos()` solo hacía algo con un administrador
conectado, y `aplicar_desactivaciones_automaticas()` solo se disparaba cuando
alguien iniciaba sesión.

## 5. Seguridad

RLS está activo en las 20 tablas. Las funciones auxiliares `es_admin()`,
`es_monitor()`, `es_personal()`, `es_operador_de()`, `puede_ver_carpeta()`,
`puede_subir_a_carpeta()` y `puede_chat()` son la base del modelo.

Las escrituras sensibles no tienen política de UPDATE. Se hacen solo por
funciones `security definer` que validan permisos por dentro: `procesos_tramite`
no permite un `update` directo, únicamente `completar_proceso`,
`editar_proceso_admin` y las demás.

No hay registro público. `auth.signUp` se reemplazó por la Edge Function
`crear-usuario`, que verifica que quien llama sea administrador activo antes de
usar `service_role`. La opción "Allow new users to sign up" debe estar apagada en
Supabase.

Dos triggers protegen la integridad del acceso. `crear_perfil_nuevo` impide que
alguien se auto-nombre administrador, aunque el primer usuario del sistema sí
queda como tal. `proteger_ultimo_admin` impide desactivar o eliminar al último
administrador activo.

Los mensajes y archivos guardan una copia del nombre del autor
(`autor_usuario`, `subido_por_usuario`) para mostrarlo sin exponer la tabla
`perfiles`.

La `SUPABASE_KEY` de `config.js` es la clave publishable, pública por diseño. La
seguridad real la ponen las reglas de RLS.

### Marco legal que implementa el código

- Régimen de insolvencia de persona natural no comerciante, en los criterios del
  diagnóstico
- Ley 2445 de 2025, en la tabla `deudores_info`
- Ley 1581 de 2012 sobre habeas data y Decreto 0042 de 2026, en los
  consentimientos, la bitácora de actividad, la constancia en PDF y la
  confirmación al cerrar sesión
- Ley 1712 de 2014 sobre transparencia
- Ley 51 de 1983, la Ley Emiliani, en los festivos que se trasladan al lunes

## 6. Funcionalidades del portal

| Vista o módulo | Notas |
| --- | --- |
| Lista de carpetas | Buscador, filtro de activas y desactivadas, franja de panorama y filas con menú de acciones |
| Detalle de carpeta | Subcarpetas, documentos, procesos, chats, información del deudor y actividad |
| Estados de los trámites | Tablero por urgencia con el reloj 60/90 como anillo. La tabla anterior sigue disponible |
| Calendario de vencimientos | Vista mensual con columna de agenda |
| Chats del trámite | Cliente con operador y acreedor con operador, con adjuntos y realtime |
| Chat de soporte flotante | Administrador con operadores |
| Llamadas de soporte | WebRTC con señalización por Supabase Realtime. Solo las inicia el administrador |
| Campana de notificaciones | Todos los roles |
| Consentimiento de datos | Modal en el primer ingreso de cliente y acreedor, más constancia en PDF |
| Audiencias | Calendario y citación por correo |
| Recordatorios personales | Privados, con ventana emergente por rango de fechas |
| Generar expediente | Une los documentos en un solo PDF con `pdf-lib`, respetando el orden manual |
| Descargar carpeta completa | ZIP con `JSZip` |
| Constancia de acreedores | PDF que certifica que los acreedores ingresaron, vieron y descargaron |
| Gestión de usuarios | Alta en panel lateral, generador de credenciales, edición de rol y restablecimiento de clave |
| Actividad del portal | Bitácora completa para el administrador |
| Menú de leyes de insolvencia | Referencia legal embebida |

## 7. Cómo se ejecuta

Es un sitio estático: no hay compilación ni dependencias. Basta servir la carpeta
con cualquier servidor. Con la extensión Live Server de VS Code, ya configurada
en el puerto 5501, o con:

```bash
python -m http.server 5501
```

y abrir `http://localhost:5501/portal/index.html`.

`portal/js/config.js` controla el modo. Con `MODO: 'nube'` los datos son reales
y viven en Supabase, que es el estado actual. Con `MODO: 'local'` se trabaja
contra datos de práctica en IndexedDB, sin internet, útil para probar sin tocar
producción.

Para desplegar las Edge Functions:

```bash
supabase functions deploy crear-usuario
```

El esquema es idempotente (`create ... if not exists`, `create or replace`,
`add column if not exists`), así que se puede pegar completo en el SQL Editor y
volver a correr sin romper nada.

## 8. Puntos débiles conocidos

| # | Punto | Detalle |
| --- | --- | --- |
| 1 | Los leads del diagnóstico no se guardan | `diagnostico.html` abre un compose de Gmail. Si la persona no le da enviar, el lead se pierde. No hay tabla ni CRM |
| 2 | Cero correos automáticos | Todo aviso al exterior es un `mailto:`, tanto para audiencias como para credenciales restablecidas. Una persona tiene que confirmar el envío desde su cliente de correo |
| 3 | Sin respaldos automáticos | Ni de la base ni del bucket `documentos` |
| 4 | Perfiles activos sin correo de contacto | Son 6. No se les puede notificar nada |
| 5 | Fuentes y librerías desde CDN | Google Fonts y jsDelivr reciben la IP del visitante. Conviene autohospedarlas antes de producción |
| 6 | `app.js` monolítico | Más de 230 KB en un solo archivo |
| 7 | Datos financieros | Se guardan montos adeudados y días de mora, así que puede aplicar la Ley 1266 de 2008 sobre habeas data financiero. Verificar con abogado |

Para el detalle de lo ya corregido en materia de seguridad y lo que sigue
abierto, ver [AUDITORIA-SEGURIDAD.md](AUDITORIA-SEGURIDAD.md).
