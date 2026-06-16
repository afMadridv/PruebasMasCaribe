# Base de datos del portal en Supabase

El proyecto ya existe (`https://hheyihgktcswvxiscvdm.supabase.co`) y el portal
**ya está conectado** a él (ver `portal/js/config.js`). Faltan 3 pasos en el
panel de Supabase para que todo funcione:

## Paso 1 — Ejecutar el esquema (crea TODA la base de datos) ⚠️ PENDIENTE

1. En <https://supabase.com/dashboard> abre tu proyecto.
2. Menú izquierdo: **SQL Editor** → **New query**.
3. Abre [esquema.sql](esquema.sql), copia **todo** el contenido, pégalo y **Run**.
   Debe decir `Success. No rows returned`.
4. Si ya lo habías ejecutado antes, vuelve a ejecutarlo: el archivo es seguro
   de repetir y trae mejoras. **Importante**: cada vez que el esquema cambie
   hay que volver a ejecutarlo. Últimas novedades: la función
   `actualizar_descripcion` (el operador actualiza el estado del trámite de
   SUS carpetas) y el ajuste de `es_operador_de` para que, **cuando el
   administrador desactive una carpeta, el operador deje de verla, subir,
   eliminar o editar su estado** hasta que se reactive (sin re-ejecutar, esa
   restricción no se aplicará en el servidor).

Esto crea:

| Qué | Para qué |
|---|---|
| Tabla `perfiles` | usuario, nombre, **rol** y estado **activo/desactivado** de cada persona |
| Tabla `carpetas` | carpetas de procesos, con su estado activa/desactivada |
| Tabla `carpeta_asignados` | qué cliente/acreedor ve qué carpeta |
| Tabla `carpeta_operadores` | qué operador es responsable de qué carpeta |
| Tabla `actividad` | bitácora del centro de notificaciones (ingresos y acciones) |
| Tabla `archivos` | ficha de cada documento (quién lo subió, cuándo, en qué carpeta) |
| Bucket `documentos` | almacenamiento privado de los archivos físicos |
| Reglas **RLS** | la seguridad: cada rol solo puede hacer lo suyo, validado EN EL SERVIDOR |

Seguridad incluida: **nadie puede auto-nombrarse administrador** al
registrarse. El **primer usuario creado** queda como administrador
automáticamente; todos los demás nacen como `cliente` y el administrador
les asigna su rol (el portal lo hace solo al crearlos desde la pestaña Usuarios).

Permisos que quedan configurados:

- **administrador** → control total: carpetas, archivos, usuarios y asignaciones
- **operador** → ve y sube archivos SOLO en las carpetas donde es operador responsable
- **cliente / acreedor** → solo ve y descarga archivos de SUS carpetas activas
- usuario **desactivado** → no puede ver nada, aunque conozca su contraseña

## Paso 1b — Subir la contraseña mínima a 8 (recomendado)

En **Authentication → Policies** (o *Sign In / Providers → Password*), sube el
**mínimo de caracteres de contraseña a 8**. El portal ya lo exige en pantalla;
esto hace que el servidor también lo obligue.

## Paso 2 — Desactivar la confirmación por correo ⚠️ PENDIENTE

Los usuarios del portal usan correos internos (ej.: `ana@portal.fundacion`)
que no reciben correo real, así que la confirmación debe estar apagada:

1. Menú **Authentication** → **Sign In / Providers** (o "Providers").
2. En **Email**, desactiva **"Confirm email"** y guarda.

## Paso 3 — Crear el PRIMER usuario (será el administrador)

1. Menú **Authentication** → **Users** → **Add user** → *Create new user*.
2. Email: por ejemplo `administrador@portal.fundacion` · contraseña segura.
3. Marca **Auto Confirm User** y crea.
4. Como es el primero, su perfil nace con rol **administrador**.

Listo: entra al portal con usuario `administrador` y esa contraseña.
**Los demás usuarios se crean desde el portal** (pestaña Usuarios) y ahí
mismo se activan/desactivan.

## Cómo inicia sesión la gente

En el portal se escribe solo el **usuario** (ej.: `pedro`); el sistema lo
convierte internamente a `pedro@portal.fundacion`. También se puede escribir
un correo completo si el usuario fue creado con correo real.

## Cambiar entre nube y práctica local

En `portal/js/config.js`:

- `MODO: 'nube'` → datos reales en Supabase (lo normal).
- `MODO: 'local'` → vuelve a la práctica con datos en el navegador
  (usuarios demo `administrador/administrador123`, etc.).

## Notas

- **Eliminar usuario** desde el portal borra su perfil y todo su acceso;
  la cuenta de correo queda en Authentication → Users por si quieres
  borrarla del todo desde el panel.
- La clave que usa el portal (`sb_publishable_...`) es pública por diseño;
  la seguridad la ponen las reglas RLS.
- **Nunca compartas** la *Database password* ni la clave `service_role`
  (esa se salta toda la seguridad y no debe ir en ninguna página web).
