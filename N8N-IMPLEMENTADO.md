# n8n en el Portal Documental — qué se construyó y cómo funciona

> ## ⚠️ DOCUMENTO HISTÓRICO — n8n fue retirado el 2026-08-20
>
> **Nada de lo descrito aquí sigue activo.** El portal volvió a su estado
> anterior a n8n:
>
> - `diagnostico.html` y `style.css` revertidos: el formulario vuelve a
>   enviarse solo por Gmail
> - Contenedor de n8n detenido y eliminado
> - Tablas `leads` y `salidas` eliminadas de la base
> - Funciones `cron_diario()`, `registrar_lead()` y sus ayudantes eliminadas
>
> Se conservan, porque **no dependían de n8n**, las correcciones de la
> auditoría de seguridad: ver
> [migracion_seguridad_2026_08.sql](portal/supabase/migracion_seguridad_2026_08.sql)
> y [AUDITORIA-SEGURIDAD.md](AUDITORIA-SEGURIDAD.md).
>
> Los datos que había en `leads` y `salidas` quedaron respaldados en
> [respaldo_leads_salidas_antes_de_quitar_n8n.json](portal/supabase/respaldo_leads_salidas_antes_de_quitar_n8n.json).
>
> El volumen `n8n_data` de Docker **no se borró**: si algún día se retoma,
> los workflows y la credencial siguen ahí. Ojo: los workflows guardados
> llaman a funciones que ya no existen, así que habría que rehacer las
> migraciones antes de reactivarlos.
>
> Lo que sigue se conserva como registro de lo que se construyó y por qué.

---

> Registro de lo implementado. Complementa:
> [CONTEXTO-PROYECTO.md](CONTEXTO-PROYECTO.md) (el proyecto) y
> [N8N-OPORTUNIDADES.md](N8N-OPORTUNIDADES.md) (el plan completo).
> Estado a 2026-08-12. Fases 1, 2 y 3 terminadas y probadas.

---

## 1. La idea en un párrafo

El portal estaba muy bien construido **hacia adentro** (RLS, triggers, funciones
`security definer`, semáforos calculados en el servidor) pero no tenía **ningún
brazo hacia afuera**: no mandaba correos, no corría nada por horario y perdía los
leads que capturaba. n8n es ese brazo. No reemplaza nada del portal: se le
enchufa por dos puntos y ejecuta lo que el portal no podía ejecutar solo.

```
                    ┌──────────────────────────────┐
   diagnóstico ────▶│  n8n  (Docker, puerto 5678)  │
   (navegador)      │                              │
                    │  ① Webhook: recibe leads     │
   reloj  ─────────▶│  ② Schedule: corre a las 7   │
   (L–V 7:00)       └──────────────┬───────────────┘
                                   │  clave service_role
                                   ▼
                          ┌─────────────────┐
                          │    Supabase     │
                          │  leads          │
                          │  salidas        │
                          │  cron_diario()  │
                          └─────────────────┘
```

---

## 2. Todo lo que se agregó

### Archivos nuevos

| Archivo | Qué es |
| --- | --- |
| `n8n/docker-compose.yml` | Cómo se levanta n8n |
| `n8n/README.md` | Manual de operación |
| `n8n/workflows/fase1-lead-diagnostico.json` | Workflow de captura de leads |
| `n8n/workflows/fase3-cron-plazos.json` | Workflow del cron diario |
| `portal/supabase/migracion_n8n_fase1.sql` | Tablas `salidas` y `leads` |
| `portal/supabase/migracion_n8n_fase3.sql` | Función `cron_diario()` y ayudantes |
| `CONTEXTO-PROYECTO.md` | Contexto del proyecto |
| `N8N-OPORTUNIDADES.md` | Plan de automatización completo |

### Archivos modificados

| Archivo | Cambio |
| --- | --- |
| `portal/diagnostico.html` | Constante `N8N`, honeypot, botón «Enviar solicitud», lógica de envío con respaldo |
| `portal/css/style.css` | Estilos `.trampa` (honeypot) y `.lead__estado` (mensajes) |

### Objetos nuevos en la base

**Tablas**

| Tabla | Para qué |
| --- | --- |
| `leads` | Solicitudes del diagnóstico público |
| `salidas` | Bandeja de salida: eventos que n8n debe entregar por fuera del portal |

**Funciones**

| Función | Para qué |
| --- | --- |
| `cron_diario(forzar)` | Punto de entrada del cron. Hace los 5 pasos y devuelve un resumen JSON |
| `_notificar_una_vez(...)` | Inserta una notificación solo si no existe ya. Da la idempotencia |
| `_encolar_salida(...)` | Apunta el evento en `salidas`, sin repetir |
| `_destinatarios_carpeta(carpeta, alcance)` | Quién debe enterarse: `'personal'` o `'partes'` |
| `_umbral_aplicable(restantes, umbrales)` | Qué escalón de aviso corresponde hoy |
| `_umbral_ya_avisado(prefijo, carpeta, ref)` | Cuál fue el escalón más bajo ya avisado |

Todas con `revoke execute ... from anon, authenticated`: **solo el rol de
servicio las puede llamar**. Nadie desde el navegador.

---

## 3. Cómo funciona n8n (para quien nunca lo ha usado)

n8n es un **encadenador de pasos**. Un *workflow* es una cadena de nodos donde
cada uno recibe datos del anterior, hace algo, y pasa el resultado al siguiente.

Tres tipos de nodo importan aquí:

| Tipo | Qué hace |
| --- | --- |
| **Trigger** | Arranca la cadena. `Webhook` = cuando llega una petición HTTP. `Schedule` = cuando da la hora |
| **Acción** | `HTTP Request` (llamar a Supabase), `Code` (JavaScript) |
| **Respuesta** | `Respond to Webhook` = qué contestarle al navegador |

Un workflow **inactivo** solo corre si le das «Execute» a mano. **Activo** corre
solo. Esto importa: un workflow importado queda inactivo hasta que lo actives.

Las **credenciales** viven aparte de los workflows, cifradas. Por eso el JSON del
workflow se puede versionar en git sin exponer la clave: el JSON solo dice *cuál*
credencial usar, no su contenido.

---

## 4. Dónde corre

Docker, contenedor `n8n`, puerto 5678.

```bash
docker compose -f n8n/docker-compose.yml up -d
```

Dos detalles del `docker-compose.yml` que no son decorativos:

- **`GENERIC_TIMEZONE=America/Bogota`** — sin esto un cron de las 7:00 a.m.
  correría a las 2:00 a.m. hora Colombia.
- **`restart: unless-stopped`** — el contenedor se levanta solo al prender el PC.

Los datos (workflows, credenciales cifradas, historial, **clave de cifrado**)
viven en el volumen `n8n_data`, no en el contenedor. Borrar y recrear el
contenedor no pierde nada; borrar el volumen sí.

### Una credencial, dos workflows

`Supabase service (apikey)` — tipo Header Auth, `apikey: <service_role>`.

> ⚠️ `service_role` **ignora RLS por completo**. Todo el modelo de permisos del
> portal deja de aplicar para quien la tenga. Por eso n8n es local y la clave
> nunca toca el código del navegador ni git.

---

## 5. Fases 1 y 2 — captura de leads

### El problema

`diagnostico.html` terminaba abriendo un compose de Gmail. Si la persona cerraba
la pestaña, **el lead se perdía**. Sin tabla, sin registro, sin forma de saber
cuántos se perdieron. Era la única puerta pública del sistema y goteaba.

### El flujo ahora

```
persona llena diagnóstico
        │
        ▼
[Enviar solicitud]  ──POST──▶  Webhook n8n
                                   │
                         ┌─────────▼─────────┐
                         │ Validar y limpiar │  honeypot + campos
                         └─────────┬─────────┘
                                   ▼
                              ¿es válido?
                          sí ──┤       ├── no ──▶ HTTP 400
                               ▼
                    Insertar en Supabase (leads)
                          ok ──┤       ├── falla ──▶ HTTP 502
                               ▼
                          HTTP 200 {ok, id}
```

### Las tres respuestas y qué ve la persona

| HTTP | Causa | Qué ve |
| --- | --- | --- |
| **200** | Lead guardado | Mensaje verde: «Un asesor te contactará al 300…» |
| **400** | Honeypot lleno o campos inválidos | (los bots no leen; a un humano no le pasa) |
| **502** | Supabase rechazó o está caído | Mensaje ámbar: «Usa Enviar por Gmail» |

**El punto clave del diseño:** si n8n está caído, el botón de Gmail sigue ahí.
La persona nunca se queda sin poder enviar sus datos. La automatización agrega
una vía, no reemplaza la que ya funcionaba.

### El honeypot

Campo `l-web` invisible (`position:absolute; left:-9999px`) y fuera del
tabulador (`tabindex="-1"`). Un humano nunca lo llena. Los bots que rellenan
todo, sí — y el servidor los descarta. Cuesta 4 líneas y filtra el spam básico.

### Contra el duplicado

`estado.leadId` guarda el id devuelto. Segundo clic → no reenvía. Si la persona
**corrige** sus datos después de enviar, `leadId` se limpia y el envío se
rehabilita: la versión corregida sí se guarda.

### El ciclo del lead

```
visitante → diagnóstico → LEAD (estado: 'nuevo')
                             │
                     asesor lo contacta → 'contactado'
                             │
                     si firma → 'en-tramite'
                             → se le crea usuario 'cliente'
                             → se le crea carpeta = TRÁMITE
```

El asesor gestiona `estado` desde Supabase → Table Editor → `leads`.

---

## 6. Fase 3 — cron diario de plazos

### Los dos bugs que arregla

1. `generar_notificaciones_vencidos()` arranca con
   `if not public.es_admin() then return`. Llamada por n8n (rol de servicio,
   `auth.uid()` es null) **se sale sin hacer nada**. Solo corría si un
   administrador la disparaba desde el portal.

2. `aplicar_desactivaciones_automaticas()` corría —según el comentario del propio
   esquema— «cada vez que alguien consulta sus avisos». Si nadie entraba al
   portal un lunes festivo, las carpetas que debían desactivarse seguían
   abiertas.

`cron_diario()` es la versión sin guard de sesión, pensada para el programador
de tareas.

### Decisión de diseño: la lógica vive en SQL

n8n **solo dispara**. Todo el cálculo está en `cron_diario()`. La razón: el
semáforo y la aritmética de días hábiles ya tienen una fuente de verdad en SQL, y
esa lógica ya está duplicada dos veces (`js/diasHabiles.js` y la tabla
`festivos_colombia`). Una tercera copia dentro de un nodo Code de n8n garantiza
que algún día el portal y los correos digan cosas distintas.

### Los cinco pasos de cada corrida

| # | Qué hace | A quién avisa |
| --- | --- | --- |
| 1 | Notifica procesos ya vencidos | Personal (admin + operador responsable) |
| 2 | Desactiva carpetas con el plazo de descarga cumplido | — |
| 3 | Avisa 5 / 3 / 1 día hábil antes de vencer un proceso | Personal |
| 4 | Avisa 10 / 5 / 1 día hábil antes de vencer el trámite | Personal |
| 5 | Recuerda 15 / 5 / 1 día hábil antes de cerrar la descarga | **Las partes** (cliente + acreedores) |

El paso 5 avisa a las partes a propósito: es su última ventana para bajar los
documentos antes de que la carpeta se cierre.

### La escalera de avisos (y el error que tuvo)

La primera versión usaba «avisa si quedan ≤ N días». Al probarla, un proceso al
que le quedaba 1 día disparó **tres notificaciones idénticas** de golpe (cumplía
≤5, ≤3 y ≤1). Ruido puro en la campana.

La corrección: se calcula **un solo escalón**, el más bajo que todavía cubre los
días restantes, y se avisa solo cuando el plazo **baja** de escalón.

```
Proceso con escalera 5/3/1:

 días restantes:  7    5    4    3    2    1
 escalón:         –    5    5    3    3    1
 ¿avisa?          no   SÍ   no   SÍ   no   SÍ
                       ▲         ▲         ▲
                    primero   bajó a 3   bajó a 1
```

Si el sistema estuvo apagado y el proceso pasó de 5 días a 1, llega **un solo**
aviso: el de «1 día». No los tres atrasados.

### Las cuatro reglas que respeta

| Regla | Cómo |
| --- | --- |
| **Solo días hábiles** | El Schedule corre L–V; los festivos colombianos los filtra `es_dia_habil()` dentro de la función |
| **Un aviso por escalón** | `_umbral_aplicable` + `_umbral_ya_avisado` |
| **Idempotente** | `_notificar_una_vez` — correrla diez veces el mismo día no duplica nada |
| **Respeta la pausa** | Un trámite pausado no genera ningún aviso: el reloj está detenido |

### El resumen que devuelve

```json
{
  "ejecutado": true,
  "fecha": "2026-08-12",
  "es_dia_habil": true,
  "notif_vencidos": 0,
  "carpetas_desactivadas": 0,
  "notif_proceso_por_vencer": 0,
  "notif_tramite_por_vencer": 0,
  "notif_cierre_descarga": 3,
  "salidas_encoladas": 1
}
```

Un nodo `Code` lo convierte en texto legible («Todo al día: nada que avisar»)
que queda en el historial de ejecuciones de n8n.

---

## 7. La bandeja de salida (`salidas`)

Cada aviso queda **también** en `public.salidas` con `estado = 'pendiente'`.

Hoy nadie la consume. Es el enganche listo para el día que exista el correo
institucional: un workflow nuevo lee las pendientes, envía, y marca `enviado`.
**Sin tocar nada de lo ya construido.**

Por qué una tabla en vez de que cada trigger llame a su propio webhook:

- Si n8n está caído, los eventos **se acumulan** en vez de perderse
- Un solo lugar para ver qué salió y qué falló
- La idempotencia se resuelve una vez, no en ocho triggers

```
evento → salidas (pendiente) → n8n lee → envía → salidas (enviado)
                                   │
                                   └─ si falla → estado 'error' + intentos++
```

---

## 8. Operación diaria

### Comandos

```bash
docker compose -f n8n/docker-compose.yml up -d
```

| Para | Comando |
| --- | --- |
| Ver la UI | http://localhost:5678 |
| Detener | `docker compose -f n8n/docker-compose.yml down` |
| Ver el registro | `docker compose -f n8n/docker-compose.yml logs -f` |
| Listar workflows | `docker exec n8n n8n list:workflow` |
| Ver activos | `docker exec n8n n8n list:workflow --active=true` |

### Correr el cron a mano

```bash
docker exec -e N8N_RUNNERS_BROKER_PORT=5690 n8n n8n execute --id=fase3CronPlazos1
```

El puerto alterno evita el choque con el broker de la instancia que ya corre.

O directo en el SQL Editor de Supabase (`true` se salta el filtro de día hábil):

```sql
select public.cron_diario(true);
```

### Importar un workflow modificado

La carpeta `workflows/` **no** está montada en el contenedor: el proyecto vive en
`F:`, que Docker Desktop no comparte (el montaje salía vacío, sin avisar).

```bash
docker cp n8n/workflows/fase3-cron-plazos.json n8n:/tmp/w.json
docker exec n8n n8n import:workflow --input=/tmp/w.json
```

Después activarlo **desde la UI** y reiniciar el contenedor.

> El comando `publish:workflow` de la CLI **alterna** el estado en vez de fijarlo:
> correrlo dos veces lo deja apagado. Por eso conviene la UI.

---

## 9. Qué falta y qué NO hay que hacer

### Pendiente

| # | Qué | Bloqueado por |
| --- | --- | --- |
| 1 | Envío real por correo (leads, audiencias, credenciales) | Falta la cuenta `contacto@fundacionmascaribe.org` |
| 2 | Respaldo automático de base y bucket | — |
| 3 | Reporte semanal a dirección | — |
| 4 | Sincronizar festivos colombianos (hard-coded hasta 2027, en dos lugares) | Antes de 2028 |
| 5 | Chats sin respuesta (SLA) | — |

### Antes de producción

- `N8N.URL` en `diagnostico.html` apunta a `localhost` → cambiar a la URL pública
- El webhook acepta `allowedOrigins: "*"` → restringir al dominio real
- n8n corre en el PC → mover a un servidor que esté siempre encendido
- Considerar un rol `n8n_bot` con permisos mínimos en vez de `service_role`

### Lo que NO conviene mover a n8n

- **El cálculo del semáforo.** Vive en `calcular_semaforo`. n8n debe *leerlo*
  vía `listar_procesos()`, nunca recalcularlo
- **Los permisos.** RLS y las funciones `security definer` son el modelo de
  seguridad; n8n con `service_role` los salta
- **La aritmética de días hábiles.** Usar `es_dia_habil()`,
  `contar_dias_habiles()`, `sumar_dias_habiles()` desde SQL
- **El chat en tiempo real y las llamadas WebRTC.** Ya funcionan con Supabase
  Realtime

---

## 10. Pruebas hechas

### Fases 1 y 2

| Prueba | Resultado |
| --- | --- |
| Flujo completo en navegador → diagnóstico apto | 4 criterios legales ✓ |
| Honeypot | invisible y fuera del tabulador ✓ |
| Lead válido | fila con los 14 campos correctos ✓ |
| Doble clic | sin duplicado ✓ |
| Editar datos tras enviar | botón se rehabilita ✓ |
| **n8n caído** | mensaje ámbar → remite a Gmail ✓ |
| Móvil 375 px | sin desborde horizontal ✓ |
| Consola | sin errores, sin CORS ✓ |

### Fase 3 (con carpeta temporal, borrada después)

| Prueba | Resultado |
| --- | --- |
| Proceso vencido | notifica ✓ |
| A 3 días / a 1 día | avisa el escalón correcto ✓ |
| Proceso completado | no alerta ✓ |
| Trámite pausado | silencio total ✓ |
| Desactivación automática | `activa=false` ✓ |
| 3 corridas seguidas | sin duplicados ✓ |
| Bajar de escalón (3→1) | avisa de nuevo ✓ |
| Festivos (17-ago, Navidad) | bloqueados ✓ |
| Desde n8n con credencial | `status: success` ✓ |

### Migración a Docker

| Prueba | Resultado |
| --- | --- |
| Workflow migrado | presente ✓ |
| Zona horaria | `-05` Colombia ✓ |
| Credencial descifra | lead insertado ✓ |
| Sobrevive `docker restart` | webhook activo ✓ |

**Hallazgo real durante las pruebas:** el cron detectó que la carpeta
Exp. 002-2026 cierra el 03/09 y quedaban exactamente 15 días hábiles. Avisó al
operador, al cliente y al acreedor. Esas 3 notificaciones son legítimas y se
dejaron.
