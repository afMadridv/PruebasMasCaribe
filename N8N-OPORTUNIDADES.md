# Dónde implementar n8n en el Portal Documental

> Complemento de [CONTEXTO-PROYECTO.md](CONTEXTO-PROYECTO.md).
> Análisis basado en el código a 2026-08-12.

---

## Resumen en una frase

El portal está **muy bien construido hacia adentro** (RLS, triggers, funciones
`security definer`, semáforos calculados en servidor) pero **no tiene ningún
brazo hacia afuera**: no manda correos, no manda WhatsApp, no corre nada por
horario y no guarda los leads que captura. Ese hueco completo es exactamente lo
que n8n llena, y se puede llenar **sin tocar la lógica existente**.

---

## Cómo conectar n8n con este proyecto

Hay tres vías, y conviene usar las tres según el caso:

### Vía A — Webhook desde la base (eventos en tiempo real)

Supabase Database Webhooks (o `pg_net` desde un trigger) → nodo **Webhook** de n8n.

Úsala para: mensaje nuevo, archivo subido, audiencia creada, trámite finalizado,
solicitud de clave.

```sql
-- Ejemplo: avisar a n8n cuando se crea una audiencia
create or replace function public.n8n_audiencia_nueva()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    perform net.http_post(
        url     := 'https://n8n.tudominio.org/webhook/audiencia-nueva',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'X-Portal-Token', current_setting('app.n8n_token', true)),
        body    := to_jsonb(new)
    );
    return new;
end;
$$;
```

> Poner un token compartido en el header y validarlo en n8n. Sin eso, cualquiera
> que descubra la URL puede disparar correos en nombre de la fundación.

### Vía B — Schedule + consulta (todo lo periódico)

Nodo **Schedule** de n8n → nodo **Postgres/Supabase** que consulta y actúa.

Úsala para: vencimientos, cierres, recordatorios, reportes, respaldos, festivos.

### Vía C — HTTP desde el navegador (el diagnóstico público)

`diagnostico.html` hace `fetch` a un webhook de n8n. Es la única app sin sesión,
así que aquí n8n hace de backend.

### Credenciales y seguridad — léelo antes de conectar nada

- n8n necesita `service_role` **o** un rol de Postgres dedicado. `service_role`
  **ignora RLS por completo**: todo el modelo de permisos del portal deja de
  aplicar. Recomendación: crear un rol `n8n_bot` con `SELECT` sobre las tablas
  que necesita y `EXECUTE` sobre funciones específicas, en vez de dar
  `service_role`.
- n8n debe estar **self-hosted en una instancia privada** o en n8n Cloud con
  acceso restringido. Va a mover datos personales de deudores: eso cae bajo
  **Ley 1581 de 2012 y Decreto 0042 de 2026**, los mismos que el portal ya
  respeta con la tabla `consentimientos`.
- No mandar el detalle financiero completo por WhatsApp. Avisar "tienes una
  novedad, entra al portal" y que el dato viva solo en el portal.

### Patrón recomendado: tabla `salidas` (outbox)

En vez de que 8 triggers llamen a 8 webhooks distintos, conviene una sola tabla
de salida. Es más simple de operar, sobrevive caídas de n8n y da idempotencia:

```sql
create table if not exists public.salidas (
    id          bigint generated always as identity primary key,
    tipo        text not null,           -- 'audiencia-nueva', 'proceso-vencido', ...
    carga       jsonb not null default '{}'::jsonb,
    carpeta_id  bigint references public.carpetas (id) on delete cascade,
    estado      text not null default 'pendiente'
                check (estado in ('pendiente','enviado','error')),
    intentos    int not null default 0,
    error       text,
    creado      timestamptz not null default now(),
    procesado   timestamptz
);
create index on public.salidas (estado, creado) where estado = 'pendiente';
alter table public.salidas enable row level security;
-- sin políticas: solo el rol de servicio la toca
```

Los triggers existentes insertan aquí; n8n lee `pendiente` cada minuto, actúa y
marca `enviado`. Si n8n estuvo caído, nada se pierde.

---

## Prioridad 1 — Lo que arregla una pérdida real hoy

### 1.1 Capturar y enrutar los leads del diagnóstico ⭐ el de mayor impacto

**Problema:** `diagnostico.html` termina abriendo un compose de Gmail. Si la
persona cierra la pestaña, **el lead se perdió**. No queda registro en ninguna
parte. Es la única puerta pública del sistema y está goteando.

**Flujo n8n:**

```
Webhook (POST desde diagnostico.html)
  → Validar payload + honeypot / rate limit
  → Supabase: insert en tabla `leads`
  → Switch por resultado del diagnóstico
      ├─ apto=true  → correo al asesor "LEAD CALIFICADO" + WhatsApp al de turno
      │               + tarjeta en el tablero (Trello/Notion/Google Sheets)
      └─ apto=false → secuencia de nutrición: correo con alternativas
                      (negociación directa, conciliación)
  → Correo automático de confirmación a la persona
  → Si en 48 h nadie marcó contactado → recordatorio al asesor
```

Requiere una tabla nueva y un cambio pequeño en `diagnostico.html`
(reemplazar el `window.open` de Gmail por un `fetch`, dejando el botón de Gmail
como respaldo). El payload ya existe armado: la función `plantilla(ev)` de
`diagnostico.html` genera el resumen completo, y `evaluar()` devuelve los cuatro
criterios legales con su resultado.

**Beneficio:** dejas de perder solicitudes y ganas trazabilidad de conversión
(cuántos diagnostican, cuántos califican, cuántos se vuelven trámite).

### 1.2 Cron de vencimientos y cierres

**Problema:** dos funciones críticas no corren solas.
- `generar_notificaciones_vencidos()` solo se ejecuta si un administrador la
  invoca desde el portal.
- `aplicar_desactivaciones_automaticas()` corre, según el propio comentario del
  esquema, "cada vez que alguien consulta sus avisos, así no hace falta un
  programador de tareas". Si nadie entra un lunes festivo, las carpetas que
  debían desactivarse siguen abiertas.

**Flujo n8n:** Schedule diario 7:00 a.m. (hora Colombia)

```
Schedule (L–V 07:00)
  → Postgres: select public.es_dia_habil(current_date)   ← respeta festivos
  → IF no es hábil → detener
  → Postgres: select public.generar_notificaciones_vencidos()
  → Postgres: select public.aplicar_desactivaciones_automaticas()
  → Postgres: consultar procesos en rojo y naranja de hoy
  → Agrupar por operador responsable
  → Correo/WhatsApp a cada operador con SU lista
  → Resumen consolidado al administrador
```

> Ojo: `generar_notificaciones_vencidos()` empieza con
> `if not public.es_admin() then return; end if;`. Con `service_role`
> `auth.uid()` es null y **la función se sale sin hacer nada**. Hay que crear una
> variante sin ese guard para uso interno, o que n8n llame con un JWT de admin.
> Este es el detalle que más fácil se pasa por alto al conectar.

### 1.3 Alertas escalonadas antes del vencimiento

Hoy el semáforo se pone naranja cuando falta **1 día hábil**. Para un plazo legal
eso es tardísimo.

```
Schedule diario (días hábiles)
  → Consultar procesos_tramite no completados, no pausados
  → Calcular con contar_dias_habiles(current_date, fecha_vencimiento_habil)
  → Ramas: faltan 5 / 3 / 1 día → aviso al operador
           faltan 10 días del trámite completo → aviso al administrador
  → Registrar en `salidas` para no repetir el mismo aviso dos veces
```

Igual para el **cierre**: el aviso de los 30 días hábiles de gracia se manda
**una sola vez** cuando se finaliza el trámite. Recordar a los 15, 5 y 1 día
hábil restante para que las partes alcancen a descargar sus documentos.

---

## Prioridad 2 — Automatizar lo que hoy es `mailto:`

### 2.1 Citación a audiencias

**Hoy** (`app.js:2836`): el operador llena el modal y el portal abre **su** cliente
de correo con el texto listo. Tiene que darle "enviar" a mano, desde su cuenta
personal, sin copia ni registro de envío real.

**Con n8n:**

```
Trigger: insert en `audiencias`
  → Consultar destinatarios (carpeta_asignados + carpeta_operadores con correo)
  → Enviar correo desde la cuenta institucional
  → Adjuntar invitación .ics + crear evento en Google Calendar con el enlace de Meet
  → WhatsApp con fecha, hora y enlace
  → Programar recordatorio 24 h y 1 h antes
  → Insertar en `actividad` el envío real (no solo "se abrió el correo")
```

Gana: envío verificable, calendario real y recordatorios. Legalmente importa
poder probar que se citó.

### 2.2 Entrega de credenciales y restablecimiento de clave

**Hoy** (`app.js:4075`): al restablecer una contraseña el portal abre el correo del
administrador con la clave **en texto plano en el cuerpo del mensaje**, y el admin
la envía a mano. Al crear un usuario, ni eso: la Edge Function `crear-usuario`
genera la cuenta pero nadie le avisa a la persona.

**Con n8n:**

```
Trigger: insert en `perfiles` (o webhook desde crear-usuario)
  → Correo de bienvenida institucional con usuario y enlace al portal
  → Clave por canal separado (WhatsApp), nunca en el mismo correo
  → A los 3 días sin primer_login → recordatorio
  → A los 7 días → aviso al administrador de que la persona no ha entrado
```

### 2.3 Solicitudes de "olvidé mi contraseña"

La tabla `solicitudes_clave` acumula pendientes y solo se ven en la campana del
portal. Si el admin no entra, la persona espera.

```
Trigger: insert en `solicitudes_clave`
  → WhatsApp/correo inmediato al administrador de turno
  → Si sigue 'pendiente' a las 4 horas → escalar
  → Si sigue 'pendiente' a las 24 horas → escalar a todos los admins
```

### 2.4 Chats sin respuesta

Un cliente escribe en el chat de su carpeta; si su operador no entra al portal,
el mensaje se queda ahí. No hay ningún SLA.

```
Schedule cada hora (horario laboral)
  → Mensajes con rol cliente/acreedor sin respuesta posterior del personal
  → > 4 h hábiles  → aviso al operador responsable
  → > 24 h hábiles → aviso al administrador
```

Mismo patrón para `llamadas_soporte` en estado `perdida`.

---

## Prioridad 3 — Lo que hoy simplemente no existe

### 3.1 Respaldo automático

No hay ninguno. Los documentos de un trámite de insolvencia son irremplazables.

```
Schedule diario 2:00 a.m.
  → pg_dump vía Supabase API o consulta por tablas → archivo
  → Listar bucket `documentos` → sincronizar nuevos a Google Drive / S3 / Backblaze
  → Verificar tamaño y conteo contra el día anterior
  → Correo de confirmación; alerta fuerte si falla
```

Recomendable: retención por 30 días diarios + 12 meses mensuales, y cifrado en
destino, porque son datos personales sensibles.

### 3.2 Reporte semanal de la cartera

```
Schedule lunes 8:00 a.m.
  → Consultar listar_procesos() para todas las carpetas
  → Componer: trámites activos, semáforos por color, vencidos, próximos a vencer,
    trámites pausados hace más de X días, carpetas sin movimiento en 15 días,
    audiencias de la semana, leads nuevos y tasa de conversión
  → Generar HTML/PDF → correo a dirección
  → Opcional: volcar a Google Sheets para tablero histórico
```

Con `monitor` ya existiendo como rol de solo lectura, este reporte es la versión
"push" de esa misma vista.

### 3.3 Sincronizar los festivos colombianos

Están escritos a mano hasta 2027, **en dos lugares** (`js/diasHabiles.js` y la
tabla `festivos_colombia`). En 2028 el semáforo empieza a calcular plazos legales
mal, en silencio.

```
Schedule 1 de diciembre, anual
  → Obtener festivos del año siguiente (API de festivos de Colombia o cálculo Emiliani)
  → Insertar en festivos_colombia (on conflict do nothing)
  → Comparar contra la constante del JS
  → Si difieren → alerta al equipo técnico con el bloque de código a pegar
```

Y un chequeo mensual barato: si `festivos_colombia` no tiene datos para
`año actual + 1`, alertar.

### 3.4 Verificación de documentos obligatorios

Cada tipo de trámite exige un conjunto de documentos. Hoy nadie verifica que
estén completos.

```
Trigger: insert en `archivos` (o schedule diario)
  → Comparar los archivos de la carpeta contra la lista requerida
  → Faltantes → recordatorio al cliente y al operador
  → Completo → notificar que el expediente está listo para radicar
```

Se puede subir un escalón con IA: nodo de Claude/OpenAI que lea el PDF recién
subido, clasifique qué documento es (cédula, certificado laboral, extracto
bancario, estado de cuenta) y lo compare con lo declarado en el diagnóstico.
Como el bucket ya guarda `tipo` y `nombre`, encaja sin cambiar el esquema.

### 3.5 Auditoría legal periódica

El portal ya registra todo en `actividad` y `consentimientos` (Decreto 0042 de
2026, Ley 1581 de 2012). Falta explotarlo:

```
Schedule mensual
  → Usuarios activos sin consentimiento registrado
  → Carpetas finalizadas cuyo plazo de descarga vence este mes
  → Accesos fuera de horario o descargas masivas (patrón anómalo)
  → Informe al oficial de datos
```

---

## Tabla de priorización

| # | Automatización | Impacto | Esfuerzo | Riesgo | Empezar por |
| --- | --- | --- | --- | --- | --- |
| 1.1 | Captura de leads del diagnóstico | 🔴 Alto | Bajo | Bajo | **Sí** |
| 1.2 | Cron de vencidos y cierres | 🔴 Alto | Bajo | Medio¹ | **Sí** |
| 1.3 | Alertas escalonadas de plazos | 🔴 Alto | Medio | Bajo | Sí |
| 3.1 | Respaldo automático | 🔴 Alto | Medio | Bajo | Sí |
| 2.1 | Citación a audiencias | 🟠 Medio | Medio | Bajo | Después |
| 2.3 | Solicitudes de clave | 🟠 Medio | Bajo | Bajo | Después |
| 2.2 | Credenciales y bienvenida | 🟠 Medio | Bajo | Medio² | Después |
| 2.4 | Chats sin respuesta | 🟠 Medio | Medio | Bajo | Después |
| 3.2 | Reporte semanal | 🟡 Medio | Medio | Bajo | Después |
| 3.3 | Sincronizar festivos | 🟡 Medio | Bajo | Bajo | Antes de 2027 |
| 3.4 | Documentos obligatorios | 🟢 Bajo | Alto | Medio³ | Fase 2 |
| 3.5 | Auditoría legal | 🟢 Bajo | Medio | Bajo | Fase 2 |

¹ Requiere resolver el guard `es_admin()` en `generar_notificaciones_vencidos()`.
² Manejo de contraseñas fuera del portal: usar canal separado, nunca correo con clave.
³ Si se usa IA, los documentos salen del entorno controlado — validar contra la política de datos.

---

## Ruta sugerida (4 semanas)

**Semana 1 — Infraestructura**
Levantar n8n self-hosted. Crear el rol `n8n_bot` con permisos mínimos. Crear la
tabla `salidas`. Configurar credenciales de correo institucional (SMTP o Resend)
y WhatsApp Business API. Un workflow de prueba punta a punta.

**Semana 2 — El lead** (1.1)
Tabla `leads`, cambio del `fetch` en `diagnostico.html`, workflow de captura y
enrutamiento, notificación al asesor, confirmación al usuario.

**Semana 3 — Los plazos** (1.2 y 1.3)
Resolver el guard `es_admin()`. Cron diario de vencidos y desactivaciones.
Alertas escalonadas 5/3/1. Recordatorios de cierre 15/5/1.

**Semana 4 — Respaldo y reporte** (3.1 y 3.2)
Respaldo diario con verificación. Reporte semanal a dirección.

Después, en orden: audiencias, solicitudes de clave, bienvenida, chats sin
respuesta, festivos.

---

## Lo que NO conviene mover a n8n

Para que quede claro el límite:

- **El cálculo del semáforo.** Vive en `calcular_semaforo` y es la fuente de
  verdad. n8n debe *leerlo* vía `listar_procesos()`, nunca recalcularlo. Duplicar
  esa lógica en un nodo Function es la forma más rápida de que el portal y los
  correos digan cosas distintas.
- **Los permisos.** RLS y las funciones `security definer` son el modelo de
  seguridad. n8n con `service_role` los salta; por eso solo debe hacer lecturas
  acotadas y llamar funciones existentes.
- **La aritmética de días hábiles.** Usar `es_dia_habil()`,
  `contar_dias_habiles()` y `sumar_dias_habiles()` desde SQL. No reimplementar
  el calendario colombiano en JavaScript dentro de n8n — ya está duplicado dos
  veces, no hace falta una tercera.
- **El chat en tiempo real y las llamadas WebRTC.** Ya funcionan con Supabase
  Realtime; n8n solo debe intervenir para el SLA (avisar de lo no respondido).
