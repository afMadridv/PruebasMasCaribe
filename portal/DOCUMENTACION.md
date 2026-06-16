# Portal Documental — Documentación

**Fundación de insolvencia y conciliaciones**
Sistema web para que clientes y acreedores consulten y descarguen los
documentos de su proceso, mientras operadores y administradores los
gestionan de forma controlada.

---

## 1. Qué es y para qué sirve

Un portal privado con inicio de sesión donde:

- Los **clientes** y **acreedores** ven y descargan los documentos de su
  propio proceso (PDF, Word, Excel, imágenes, audio y video).
- Los **operadores** suben, descargan y eliminan los archivos de los
  procesos a su cargo y actualizan el **estado del trámite**.
- El **administrador** controla todo: crea carpetas, asigna operadores y
  personas, gestiona usuarios y consulta la bitácora de actividad.

No reemplaza a SICAAC (el sistema obligatorio del Ministerio de Justicia);
lo complementa: SICAAC registra el caso ante el Estado, este portal entrega
los documentos al cliente y a los acreedores.

---

## 2. Roles y permisos

| Acción | Administrador | Operador | Cliente | Acreedor |
|---|:---:|:---:|:---:|:---:|
| Iniciar sesión | ✅ | ✅ | ✅ | ✅ |
| Ver TODAS las carpetas | ✅ | — | — | — |
| Ver SUS carpetas asignadas | ✅ | ✅ (donde es responsable) | ✅ (activas) | ✅ (activas) |
| Descargar archivos / ZIP | ✅ | ✅ (en las suyas) | ✅ | ✅ |
| Subir archivos | ✅ | ✅ (en las suyas) | — | — |
| Eliminar archivos | ✅ | ✅ (en las suyas) | — | — |
| Actualizar estado del trámite | ✅ | ✅ (en las suyas) | — | — |
| Crear / editar / activar / desactivar / eliminar carpetas | ✅ | — | — | — |
| Crear / activar / desactivar / eliminar usuarios | ✅ | — | — | — |
| Centro de notificaciones (bitácora) | ✅ | — | — | — |

Reglas clave:

- Una carpeta **desactivada** desaparece para clientes y acreedores; el
  administrador y el operador responsable la siguen viendo.
- Un usuario **desactivado** no puede iniciar sesión.
- El **último administrador activo** no se puede desactivar ni eliminar
  (protegido en la interfaz **y en el servidor** mediante un trigger).
- Contraseña mínima: **8 caracteres**.
- Tipos permitidos: PDF, DOC/DOCX, XLS/XLSX, PNG, JPG, MP3, MP4 — **máx. 50 MB** c/u.

---

## 3. Pantallas

### Inicio de sesión (`index.html`)
Usuario + contraseña. En modo nube se escribe solo el usuario (ej. `pedro`);
el sistema lo convierte internamente a `pedro@portal.fundacion`.

### Carpetas
Tarjetas con el nombre del proceso, su estado, el número de documentos y
(para el administrador) el operador responsable. Botón **Abrir**; para el
administrador también Editar, Activar/Desactivar y Eliminar.

### Detalle de una carpeta
- **Estado del trámite**: texto editable por el administrador y el operador
  responsable (botón ✏️). Lo ven los clientes/acreedores de la carpeta.
- **Descargar carpeta (ZIP)**: comprime y descarga todos los documentos.
- **Zona de subida** (admin/operador): arrastrar y soltar o seleccionar.
- **Tabla de archivos**: ver, descargar y (admin/operador) eliminar; muestra
  quién subió cada archivo y cuándo.

### Usuarios (solo administrador)
Crear usuarios (usuario, nombre, contraseña, rol), activarlos/desactivarlos
y eliminarlos.

### Notificaciones (solo administrador)
Bitácora de ingresos y de toda acción sobre carpetas y archivos, con fecha y
hora, en 3 secciones: **Clientes**, **Acreedores** y **Operadores**.

---

## 4. Los dos modos de funcionamiento

Se elige en `js/config.js` con el campo `MODO`:

- **`nube`** (producción): los datos viven en **Supabase** y se ven desde
  cualquier computador. Es el modo real.
- **`local`** (práctica): los datos viven solo en el navegador (IndexedDB),
  con usuarios de demostración. No requiere internet ni cuenta.

Usuarios de práctica (modo local), contraseña = usuario + `123`:
`administrador`, `operador`, `cliente`, `acreedor`.

---

## 5. Estructura de archivos

```
portal/
├── index.html          Inicio de sesión
├── app.html            Aplicación (carpetas, archivos, usuarios, notificaciones)
├── css/portal.css      Estilos del portal
├── js/
│   ├── config.js       MODO (nube/local) y claves de Supabase
│   ├── db.js           Datos en modo local (IndexedDB) + datos demo
│   ├── nube.js         Datos en modo nube (Supabase: Auth + tablas + Storage)
│   ├── auth.js         Sesión, contraseñas y roles (modo local)
│   ├── login.js        Lógica de la página de ingreso
│   └── app.js          Lógica de la aplicación (igual en ambos modos)
├── supabase/
│   ├── esquema.sql     Base de datos de producción (pegar en Supabase)
│   └── INSTRUCCIONES.md Pasos del panel de Supabase
├── DOCUMENTACION.md    Este documento
└── LEEME.md            Resumen rápido
```

El portal está enlazado desde la navegación del sitio principal
(**Portal Documental**); no modifica el resto del sitio.

---

## 6. Arquitectura y seguridad (modo nube)

Base de datos PostgreSQL en Supabase con **seguridad por filas (RLS)**: cada
permiso se valida **en el servidor**, no en el navegador. Manipular el código
del navegador no da acceso a nada.

Tablas: `perfiles` (usuario, nombre, rol, activo), `carpetas`,
`carpeta_asignados` (clientes/acreedores por carpeta), `carpeta_operadores`
(operador responsable por carpeta), `archivos` (metadatos) y `actividad`
(bitácora). Los archivos físicos viven en un **bucket privado** (`documentos`)
con descargas validadas por carpeta.

Garantías:
- El **rol nunca viene del registro**: el primer usuario creado es
  administrador; los demás nacen como cliente y el administrador les asigna
  su rol. Nadie puede auto-nombrarse administrador.
- La **bitácora la escribe el servidor** con el actor real (no se puede
  falsificar quién hizo qué) y solo el administrador puede leerla.
- El estado del trámite se actualiza por una función que **solo** toca esa
  columna.
- La clave `sb_publishable_…` del frontend es pública por diseño.
  **Nunca** se publican la *Database password* ni la clave `service_role`.

---

## 7. Puesta en marcha (modo nube)

Ver el paso a paso en [supabase/INSTRUCCIONES.md](supabase/INSTRUCCIONES.md).
Resumen:

1. **SQL Editor → New query →** pegar todo `supabase/esquema.sql` → **Run**.
   (Repetir cada vez que el esquema cambie; es seguro.)
2. **Authentication → Sign In/Providers → Email →** desactivar *Confirm email*.
3. **Authentication → Users → Add user** (con *Auto Confirm*): el primero será
   el administrador.
4. Publicar la carpeta `portal/` en un hosting con **HTTPS**.

A partir de ahí, el administrador crea a todos los demás usuarios desde la
pestaña **Usuarios** del propio portal.

---

## 8. Mantenimiento y límites

- **Backups**: activar las copias de seguridad del proyecto en Supabase.
- **Datos personales**: el portal maneja información de procesos de personas;
  tener presente la **Ley 1581 de 2012** (habeas data, Colombia).
- **Escala**: las listas se limitan a registros recientes; pensado para el
  volumen de una fundación, no para millones de archivos.
- **Eliminar usuario** borra su perfil y acceso; la cuenta de correo queda en
  Authentication → Users del panel por si se desea borrarla del todo.

---

## 9. Estado actual (al 13 de junio de 2026)

- Esquema ejecutado en Supabase: tablas y bitácora presentes. ✅
- Confirmación de correo desactivada. ✅
- **Pendiente:** crear el primer usuario administrador (aún hay 0 usuarios) y
  re-ejecutar `esquema.sql` para incorporar los últimos ajustes de funciones.
- **Pendiente:** publicar en un hosting con HTTPS.
