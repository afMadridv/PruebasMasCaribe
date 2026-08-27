# Contexto del proyecto — Portal Documental / Fundación Mascaribe

> Documento de referencia para agentes y para quien retome el proyecto.
> Última revisión del código: 2026-08-12.

---

## 1. Qué es este proyecto

Dos aplicaciones web **estáticas** (HTML + CSS + JS de navegador, sin build, sin
framework, sin `package.json`) que apoyan a una fundación colombiana dedicada a
**insolvencia de persona natural no comerciante**:

| App | Archivo | Público | Función |
| --- | --- | --- | --- |
| **Diagnóstico** | `portal/diagnostico.html` | Abierto a internet | Calculadora que le dice a una persona si cumple los requisitos legales de insolvencia, y captura sus datos de contacto |
| **Portal Documental** | `portal/app.html` | Con sesión | Gestión completa del trámite: carpetas, documentos, plazos, chats, audiencias, notificaciones |

`index.html` en la raíz solo redirige (`meta refresh`) a `portal/diagnostico.html`,
así que **la puerta de entrada pública es el diagnóstico**.

El backend es **Supabase** (proyecto `hheyihgktcswvxiscvdm`): PostgreSQL con RLS,
Auth, Storage y Edge Functions. No hay servidor propio.

### Idioma y convenciones
- **Todo está en español**: nombres de tablas, funciones SQL, variables JS,
  comentarios y UI. Mantener esa convención.
- Comentarios en el código explican la *intención legal*, no solo la técnica.
  Son valiosos — no borrarlos al refactorizar.
- El código evita dependencias: `pdf-lib`, `JSZip`, `docx-preview` y `SheetJS`
  se cargan bajo demanda desde CDN.

---

## 2. Estructura de archivos

```
F:\PruebasMascaribe\
├── index.html                      redirección a portal/diagnostico.html
├── CLAUDE.md                       instrucciones de graphify para agentes
├── graphify-out/cache/             solo caché; NO hay graph.json todavía
└── portal\
    ├── diagnostico.html   (31 KB)  app pública de diagnóstico (HTML+JS en un archivo)
    ├── index.html          (4 KB)  pantalla de login
    ├── app.html           (46 KB)  shell del portal: todas las vistas en <section hidden>
    ├── css\
    │   ├── portal.css     (69 KB)  estilos del portal
    │   └── style.css      (11 KB)  estilos del diagnóstico
    ├── js\
    │   ├── config.js       (0.7 KB) URL y clave publishable de Supabase, MODO
    │   ├── auth.js         (2.5 KB) sesión en localStorage (8 h), hash SHA-256
    │   ├── login.js        (4.5 KB) pantalla de acceso
    │   ├── db.js          (28 KB)  capa de datos MODO 'local' (IndexedDB, práctica)
    │   ├── nube.js        (50 KB)  capa de datos MODO 'nube' (Supabase) — API real
    │   ├── app.js        (229 KB)  toda la lógica del portal
    │   ├── diasHabiles.js  (5 KB)  aritmética de días hábiles colombianos
    │   ├── iconos.js       (9 KB)  SVGs inline
    │   └── tema.js         (2 KB)  claro/oscuro
    └── supabase\
        ├── esquema.sql    (96 KB, 2179 líneas)  esquema completo, idempotente
        ├── migracion_cierre_y_descargas.sql     migración parcial (secciones 14–15)
        └── functions\
            ├── crear-usuario\index.ts        Edge Function (service_role)
            └── restablecer-clave\index.ts    Edge Function (service_role)
```

**Nota**: `.claude/launch.json` referencia un `portal-next/` (Next.js, puerto 3300)
que **no existe en el repositorio**. Es una configuración huérfana o de un
experimento futuro.

---

## 3. Modelo de dominio

### Concepto central: la **carpeta** = un trámite de insolvencia

Cada `carpeta` representa el proceso completo de un deudor. Dentro viven los
documentos, los plazos, los chats, las audiencias y la información del deudor.

### Roles (5)

| Rol | Alcance |
| --- | --- |
| `administrador` | Control total. Único que crea usuarios, finaliza trámites y aplica prórrogas |
| `monitor` | Ve **todo** en modo lectura (menos la pestaña de usuarios). No crea ni edita nada |
| `operador` | Solo ve las carpetas donde está en `carpeta_operadores`. Sube archivos y gestiona plazos ahí |
| `cliente` | El deudor. Ve y lee su carpeta activa asignada |
| `acreedor` | Ve y lee la carpeta asignada. **Nunca** accede a `deudores_info`, ni en lectura |

Los usuarios no tienen correo real como identidad: se inicia sesión con un nombre
de usuario que internamente se convierte en `usuario@portal.fundacion`
(`PORTAL_CONFIG.DOMINIO_USUARIOS`). El campo `perfiles.correo` es solo un correo
de contacto opcional.

### Tablas principales (`portal/supabase/esquema.sql`)

| Tabla | Qué guarda |
| --- | --- |
| `perfiles` | Complemento de `auth.users`: usuario, nombre, rol, activo, correo, `primer_login` |
| `carpetas` | El trámite: nombre, descripción, activa, pausado, finalizado, fechas y plazos |
| `carpeta_asignados` | Qué cliente/acreedor ve qué carpeta |
| `carpeta_operadores` | Qué operador es responsable de qué carpeta |
| `archivos` | Metadatos de documentos (el binario vive en Storage bucket `documentos`), con `orden` manual y `descargable_partes` |
| `procesos_tramite` | Etapas con plazo en días hábiles y semáforo |
| `festivos_colombia` | Festivos oficiales **2024–2027** (Ley 51 de 1983, "Ley Emiliani") |
| `mensajes` | Chat por carpeta, canal `cliente` o `acreedor`, con adjuntos |
| `mensajes_soporte` | Chat admin ↔ operador (un hilo por operador) |
| `llamadas_soporte` | Señalización de llamadas WebRTC (solo las inicia el admin) |
| `audiencias` | Fechas de audiencia con hora, enlace de Meet |
| `recordatorios` | Notas personales por carpeta, **solo las ve quien las crea** |
| `notificaciones` | Campana del portal, por destinatario |
| `actividad` | Bitácora de auditoría: ingresos, vistas, descargas, cambios |
| `deudores_info` | Datos del deudor y su apoderado (Ley 2445 de 2025). Una fila por carpeta |
| `consentimientos` | Aceptación de tratamiento de datos con versión de política |
| `solicitudes_clave` | "Olvidé mi contraseña": el admin las resuelve a mano |

### Storage
Bucket único `documentos` con tres convenciones de ruta, y las políticas RLS
dependen de esa forma:
- `<id-carpeta>/<archivo>` — documentos del trámite
- `chat/<id-carpeta>/<canal>/...` — adjuntos de chat
- `soporte/<uuid-operador>/...` — adjuntos de soporte

Límite de 100 MB por archivo. Extensiones permitidas: `pdf, doc, docx, xls, xlsx,
png, jpg, jpeg, mp3, mp4`.

---

## 4. Las tres reglas de negocio que hay que entender

### 4.1 Semáforo por días hábiles colombianos

Cada `procesos_tramite` tiene un plazo en días hábiles. El color lo calcula
**exclusivamente el servidor** (`calcular_semaforo`, expuesto vía la RPC
`listar_procesos`); el navegador solo pinta lo que recibe.

| Color | Condición |
| --- | --- |
| `verde` | Completado, o faltan 2+ días hábiles |
| `naranja` | Hoy es el último día hábil, o falta 1 |
| `rojo` | Vencido sin completar |
| `pausado` | El trámite está en pausa (el reloj se detiene) |

El administrador puede forzarlo con `semaforo_manual`.

> ⚠️ **La lista de festivos está duplicada**: en `js/diasHabiles.js`
> (constante `FESTIVOS_COLOMBIA`) y en la tabla `festivos_colombia`. Ambos
> comentarios lo advierten: si se agrega un año en un lado, hay que agregarlo en
> el otro. **Solo llegan hasta 2027.**

### 4.2 Ciclo de vida del trámite

```
crear carpeta
  └─ iniciar_tramite()      → fija fecha_inicio y vencimiento (60 o 90 días hábiles)
       ├─ crear_proceso_tramite() / completar_proceso()   ← etapas con semáforo
       ├─ pausar_tramite() / reactivar_tramite()          ← congela y reanuda TODOS los relojes
       ├─ aplicar_prorroga()                              ← solo una vez (tiene_prorroga)
       └─ finalizar_tramite()   [solo admin]
            └─ 30 días hábiles de gracia para descargar   (dias_gracia_cierre())
                 └─ aplicar_desactivaciones_automaticas() → carpeta.activa = false
```

### 4.3 Notificaciones

Se insertan **solo desde triggers** de PostgreSQL:
`notif_mensaje_nuevo`, `notif_archivo_nuevo`, `notif_soporte_nuevo`,
`notif_proceso_cambio`, `notif_carpeta_cambio`, `notif_fin_tramite`.

Regla explícita: **el administrador nunca recibe notificación de los chats
cliente↔operador ni acreedor↔operador** (el filtro vive en `notif_mensaje_nuevo`).

Realtime está habilitado en `mensajes`, `mensajes_soporte`, `llamadas_soporte`
y `notificaciones`.

---

## 5. Seguridad

- **RLS en todas las tablas.** Las funciones auxiliares `es_admin()`,
  `es_monitor()`, `es_personal()`, `es_operador_de()`, `puede_ver_carpeta()`,
  `puede_subir_a_carpeta()`, `puede_chat()` son el corazón del modelo.
- **Escrituras sensibles no tienen política de UPDATE**: se hacen solo por
  funciones `security definer` que validan permisos dentro (por ejemplo
  `procesos_tramite` no permite `update` directo, solo `completar_proceso`,
  `editar_proceso_admin`, etc.).
- **No hay registro público.** `auth.signUp` fue reemplazado por la Edge Function
  `crear-usuario`, que verifica que quien llama sea administrador activo antes de
  usar `service_role`. "Allow new users to sign up" debe estar **apagado** en
  Supabase.
- El trigger `crear_perfil_nuevo` fuerza que nadie pueda auto-nombrarse
  administrador; el primer usuario del sistema sí queda como admin.
- El trigger `proteger_ultimo_admin` impide desactivar o eliminar al último
  administrador activo.
- Los mensajes y archivos guardan un *snapshot* del autor
  (`autor_usuario`, `subido_por_usuario`) para mostrarlo sin exponer `perfiles`.
- `SUPABASE_KEY` en `config.js` es la clave **publishable**, pública por diseño.

### Marco legal que el código implementa
- **Ley de Insolvencia de Persona Natural No Comerciante** (criterios del diagnóstico)
- **Ley 2445 de 2025** → tabla `deudores_info`
- **Ley 1581 de 2012** (Habeas Data) y **Decreto 0042 de 2026** → consentimientos,
  bitácora de actividad, constancia en PDF, confirmación al cerrar sesión
- **Ley 1712 de 2014** (transparencia)
- **Ley 51 de 1983** (Ley Emiliani) → festivos trasladados al lunes

---

## 6. Funcionalidades del portal (`app.js`, por secciones)

| Vista / módulo | Notas |
| --- | --- |
| Lista de carpetas | Buscador, filtro activas/desactivadas, resumen de semáforo |
| Detalle de carpeta | Sub-pestañas: documentos, procesos, chats, info deudor, actividad |
| Estados de los trámites | Tablero global de semáforos (admin y monitor) |
| Calendario de vencimientos | Vista mensual de plazos y audiencias |
| Chats del trámite | Cliente↔operador y acreedor↔operador, con adjuntos y realtime |
| Chat de soporte flotante | Admin ↔ operadores |
| Llamadas de soporte | **WebRTC** con señalización por Supabase Realtime; solo las inicia el admin |
| Campana de notificaciones | Todos los roles |
| Consentimiento de datos | Modal en el primer ingreso de cliente/acreedor + constancia en PDF |
| Audiencias | Calendario + citación por correo |
| Recordatorios personales | Privados, con ventana emergente por rango de fechas |
| **Generar expediente** | Une todos los documentos en un solo PDF con `pdf-lib`, respetando el orden manual |
| Descargar carpeta completa | ZIP con `JSZip` |
| Constancia de acreedores | PDF que certifica que los acreedores ingresaron, vieron y descargaron |
| Gestión de usuarios | Generador de credenciales, editar rol, restablecer clave |
| Centro de notificaciones | Bitácora completa para el administrador |
| Menú de leyes de insolvencia | Referencia legal embebida |

---

## 7. Cómo se ejecuta

Es un sitio estático. `.claude/launch.json` define:

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File .claude\serve.ps1 -Puerto 8421
```

`portal/js/config.js` controla el modo:
- `MODO: 'nube'` → datos reales en Supabase (estado actual)
- `MODO: 'local'` → datos de práctica en IndexedDB, sin internet (`db.js`)

Despliegue de Edge Functions:

```bash
supabase functions deploy crear-usuario
```

El esquema es **idempotente** (`create ... if not exists`, `create or replace`,
`add column if not exists`): se puede pegar completo en el SQL Editor y volver a
correr sin romper nada.

---

## 8. Estado actual y puntos débiles conocidos

| # | Punto | Detalle |
| --- | --- | --- |
| 1 | **Los leads del diagnóstico no se guardan** | `diagnostico.html` abre un compose de Gmail (`btn-correo`) o copia al portapapeles. Si la persona no le da "enviar", el lead se pierde. No hay tabla, no hay CRM |
| 2 | **Cero correos automáticos** | Todo aviso al exterior es `mailto:` — audiencias (`app.js:2836`), credenciales restablecidas (`app.js:4075`). El humano debe confirmar el envío desde su cliente de correo |
| 3 | **No hay programador de tareas** | `generar_notificaciones_vencidos()` corre solo si un admin la invoca; `aplicar_desactivaciones_automaticas()` corre "cada vez que alguien consulta sus avisos". Si nadie entra al portal, nada pasa |
| 4 | **Festivos hard-coded hasta 2027, en dos lugares** | `js/diasHabiles.js` y tabla `festivos_colombia`. Se pueden desincronizar; en 2028 el semáforo empieza a calcular mal |
| 5 | **Sin respaldos automáticos** | Ni de la base ni del bucket `documentos` |
| 6 | **Sin reportes** | No hay resumen periódico de la cartera de trámites |
| 7 | **`portal-next/` fantasma** | Referenciado en `launch.json`, no existe |
| 8 | **Grafo de graphify incompleto** | `graphify-out/` solo tiene caché. `CLAUDE.md` asume un `graph.json` que no está: hay que correr `graphify .` para generarlo |
| 9 | **`app.js` monolítico** | 229 KB en un archivo, ~4400 líneas |

---

## 9. Reglas para trabajar en este proyecto

1. Mantener **español** en nombres y comentarios.
2. **No calcular semáforos ni permisos en el navegador**: la fuente de verdad es
   SQL. El front solo pinta.
3. Al tocar plazos o festivos, actualizar **los dos lados** (JS y SQL).
4. Toda escritura sensible va por función `security definer` que valide permisos,
   nunca por política de UPDATE abierta.
5. `esquema.sql` debe seguir siendo idempotente y re-ejecutable.
6. La clave `service_role` **solo** vive en Edge Functions o en el servidor de
   automatización. Nunca en el navegador.
7. Después de modificar código: `graphify update .`
