# Portal Documental

Software de gestión documental para una fundación de insolvencia y conciliaciones.

Tiene **dos modos**, elegibles en `js/config.js`:

- `MODO: 'nube'` (actual) → los datos viven en **Supabase** y se ven desde
  cualquier computador. Requiere los pasos de [supabase/INSTRUCCIONES.md](supabase/INSTRUCCIONES.md).
- `MODO: 'local'` → práctica sin internet: los datos viven solo en este navegador.

## Cómo entrar

Abre `portal/index.html` (o usa el enlace **Portal Documental** de la barra de
navegación del sitio).

- En modo **nube**: entra con el usuario y contraseña creados en Supabase
  (el primer usuario creado es el administrador).
- En modo **local**: usuarios de demostración:

| Usuario         | Contraseña         | Qué puede hacer                                                        |
|-----------------|--------------------|------------------------------------------------------------------------|
| `administrador` | `administrador123` | **Control total**: crear/editar carpetas, activarlas/desactivarlas, subir y eliminar archivos, crear/activar/desactivar/eliminar usuarios |
| `operador`      | `operador123`      | Ver, subir y **eliminar** archivos SOLO en sus carpetas, y actualizar el **estado del trámite** (descripción) |
| `cliente`       | `cliente123`       | Ver y descargar documentos de SUS carpetas activas                      |
| `acreedor`      | `acreedor123`      | Ver y descargar documentos de SUS carpetas activas                      |

## Reglas del sistema

- Tipos de archivo permitidos: PDF, DOC/DOCX, XLS/XLSX, PNG, JPG, MP3, MP4 (máx. 50 MB c/u).
- Al crear o editar una carpeta, el administrador elige el **operador
  responsable** del proceso y los **clientes/acreedores** que pueden verla.
  El operador solo ve las carpetas de SUS procesos.
- La **descripción funciona como estado del trámite**: el operador (o el
  administrador) la actualiza desde el botón "✏️ Actualizar estado del
  trámite" dentro de la carpeta, y los clientes/acreedores la ven en su
  tarjeta. En pantalla siempre se muestra el **nombre** de las personas,
  no su usuario.
- Una carpeta **desactivada** deja de ser visible para clientes y acreedores,
  pero el administrador y su operador responsable la siguen viendo (en amarillo).
- Un usuario **desactivado** no puede iniciar sesión hasta que el administrador
  lo active de nuevo. El último administrador activo no se puede desactivar ni eliminar.
- Cada archivo registra quién lo subió y cuándo.
- Dentro de una carpeta, el botón **"⬇️ Descargar carpeta (ZIP)"** baja todos
  sus documentos comprimidos en un solo archivo (disponible para todos los
  roles con acceso a esa carpeta).
- El administrador tiene un **Centro de notificaciones** (pestaña
  "Notificaciones") que registra los ingresos al portal y toda acción sobre
  carpetas y archivos (abrir, ver, descargar, subir, eliminar, etc.) con
  fecha y hora, clasificado en 3 secciones: Clientes, Acreedores y Operadores.
- Las carpetas se asignan a clientes/acreedores específicos: cada cliente solo ve lo suyo.

## Estructura

```
portal/
├── index.html      → inicio de sesión
├── app.html        → aplicación (carpetas, archivos, usuarios)
├── css/portal.css  → estilos propios del portal
├── js/
│   ├── config.js   → MODO (nube/local) y claves de Supabase
│   ├── db.js       → datos en modo local (IndexedDB) + datos de demostración
│   ├── nube.js     → datos en modo nube (Supabase: Auth + tablas + Storage)
│   ├── auth.js     → sesión, contraseñas y roles (modo local)
│   ├── login.js    → lógica de la página de ingreso
│   └── app.js      → lógica de carpetas, archivos y usuarios (igual en ambos modos)
└── supabase/
    ├── esquema.sql      → base de datos real lista para pegar en Supabase
    └── INSTRUCCIONES.md → pasos pendientes en el panel de Supabase
```

## Importante: límites de esta versión de práctica

Los datos (usuarios, carpetas y archivos) viven en **IndexedDB**, la base de
datos interna del navegador. Eso significa:

- Cada navegador/computador tiene su propia copia: lo que subes en tu PC
  **no** lo ve el cliente desde su casa.
- Si se borran los datos de navegación, se borra todo.
- La seguridad es solo demostrativa: el código corre en el navegador del usuario.

## Versión real con Supabase

En la carpeta [supabase/](supabase/INSTRUCCIONES.md) está lista la base de
datos de producción: tablas de perfiles (con roles y activación de usuarios),
carpetas, asignaciones y archivos, más las reglas de seguridad (RLS) que
validan cada permiso EN EL SERVIDOR, y el bucket privado de documentos.
Sigue las instrucciones de esa carpeta para crearla en supabase.com (gratis).

En producción además: HTTPS obligatorio, copias de seguridad y cumplimiento
de la Ley 1581 de 2012 (protección de datos personales en Colombia).
