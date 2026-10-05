# Asistente de agendamiento con IA

Asistente que atiende pacientes de una clínica por mensajes de texto: responde preguntas con base en los documentos de la clínica y agenda citas. Prueba técnica de WeKall, Desarrollador Fullstack Semi-senior.

El razonamiento detrás de cada decisión está en [`DECISIONS.md`](DECISIONS.md). El detalle técnico está en [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md) y [`docs/ADR-001-cola-en-produccion.md`](docs/ADR-001-cola-en-produccion.md). El diseño para producción en AWS, con costos, está en [`docs/AWS.md`](docs/AWS.md).

## Cómo ejecutarlo

Requisitos: Docker con Compose y una clave de OpenAI.

```bash
cp .env.example .env        # y escribir OPENAI_API_KEY en .env
docker compose up --build
```

Eso levanta PostgreSQL (con pgvector), MongoDB, la preparación de la base (esquema, datos de ejemplo y documentos), la API y el worker. La interfaz queda en <http://localhost:3000>.

Para enviar un mensaje sin la interfaz:

```bash
curl -X POST http://localhost:3000/webhooks/messages \
  -H 'Content-Type: application/json' \
  -d "{\"message_id\":\"prueba-1\",\"from\":\"+573001112233\",\"text\":\"Cuanto ayuno necesito para el perfil lipidico?\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
```

El comando anterior es para Bash (Linux, macOS, Git Bash o WSL). En PowerShell, el equivalente es:

```powershell
$cuerpo = @{
  "message_id" = "prueba-1"
  "from"       = "+573001112233"
  "text"       = "Cuanto ayuno necesito para el perfil lipidico?"
  "timestamp"  = (Get-Date).ToUniversalTime().ToString("s") + "Z"
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:3000/webhooks/messages -ContentType "application/json; charset=utf-8" -Body $cuerpo
```

La respuesta se ve en la interfaz, o en `GET /api/conversaciones` y `GET /api/conversaciones/:id`.

Dos detalles del ejemplo:

- El `timestamp` es la hora actual: define qué día es "hoy" para el paciente. Con una hora fija, como la del ejemplo del enunciado, "mañana" termina siendo una fecha que ya pasó.
- El texto va sin tildes para que funcione igual en cualquier terminal. El cuerpo debe llegar en UTF-8, y `curl` en algunas terminales de Windows (Git Bash, por ejemplo) lo envía en otra codificación: la API lo rechaza con 400. La interfaz no tiene ese problema.

Sin `OPENAI_API_KEY`, las bases, la API y la interfaz arrancan igual, pero el worker no: los mensajes quedan en cola y nadie los responde.

### Mensajes para probar los casos borde

Desde el simulador de la interfaz, con un teléfono distinto para cada caso. El texto de cada respuesta lo escribe el código; qué herramienta usar lo decide el modelo, así que lo descrito es lo observado con `gpt-4o-mini`.

| Mensaje | Qué debe pasar |
|---|---|
| `¿Cuánto cuesta una resonancia magnética?` | Busca en los documentos, no encuentra respaldo y responde que no tiene esa información. No inventa un precio |
| `Hola, ¿tienen cita con dermatología mañana en la tarde?` y luego `2` | Ofrece horarios numerados del día siguiente, en hora de Colombia y solo desde el mediodía. Con `2` agenda exactamente la segunda opción de esa lista |
| `¿Tienen cita de dermatología el sábado en la tarde?` | El sábado solo se atiende en la mañana: responde que no hay horarios en la tarde y ofrece buscar en otro momento |
| `Quiero una cita de medicina general mañana`, luego `mejor otro día` y luego `el 5` | Tras la oferta pregunta la fecha. `el 5` se toma como fecha, no como la opción 5 de la lista anterior |
| `Quiero hablar con una persona` | Escala la conversación: queda en estado "Escalada" y los mensajes siguientes reciben una respuesta fija |

Para la idempotencia, envíe dos veces el mismo cuerpo al webhook (el ejemplo de arriba): las dos responden 202 y el mensaje se procesa una sola vez. El mismo `message_id` con otro texto responde 409.

## Tests

No usan el modelo real ni Mongo. Usan PostgreSQL real, con el mismo esquema y las mismas sentencias SQL que la aplicación.

```bash
docker compose up -d postgres      # crea también la base asistente_test
npm install
npm test
```

Los tests se conectan a `localhost:5432`. Si en el equipo ya hay otro PostgreSQL en ese puerto, responde ese y no el de Docker: en ese caso indique la base de pruebas con `POSTGRES_URL_PRUEBAS`.

Para probar además el almacén de trazas contra un MongoDB real:

```bash
docker compose up -d mongo
MONGO_URL_PRUEBAS=mongodb://localhost:27017 npm test
```

La capa de base de datos tiene su propio verificador, independiente del código de la aplicación (concurrencia, restricciones, planes de consulta):

```bash
pip install psycopg2-binary
python3 verificacion/verificar.py --dsn "host=localhost port=5432 user=postgres password=postgres"
```

## El recorrido de un mensaje

1. **Webhook** (`src/http/servidor.ts`, `src/aplicacion/webhook.ts`). Valida el cuerpo, guarda el mensaje en PostgreSQL y responde 202. No llama al modelo. Repetir el mismo `message_id` no crea nada nuevo.
2. **Cola** (tabla `mensajes_entrantes`). El mensaje guardado es a la vez el registro de idempotencia y el trabajo pendiente.
3. **Worker** (`src/aplicacion/worker.ts`). Reclama el mensaje más antiguo de una conversación libre, le pone un candado de 120 s y un número de intento. Antes de llamar al modelo decide si hace falta: conversación ya escalada, cita ya creada por un intento anterior, o intentos agotados se resuelven sin modelo.
4. **Ciclo con el modelo** (`src/aplicacion/motor.ts`, `src/aplicacion/herramientas.ts`). El modelo pide herramientas; el código valida los argumentos y las ejecuta. El turno solo termina con `responder` o `escalar_a_humano`.
5. **Texto de la respuesta** (`src/dominio/plantillas.ts`). Lo escribe el código con plantillas, o son líneas literales de un documento. El modelo nunca redacta lo que recibe el paciente.
6. **Cierre** (en `worker.ts`). Una transacción guarda la respuesta, el estado de la conversación y la traza, solo si el intento sigue siendo el vigente.
7. **Relevo** (`src/aplicacion/relevo.ts`). Copia las trazas de PostgreSQL a MongoDB. Si Mongo está caído, esperan en PostgreSQL.

## Estructura

| Carpeta | Contenido |
|---|---|
| `sql/` | Esquema y migraciones, que se aplican en orden (`001_esquema.sql`, `002_oferta_slots.sql`), y todas las sentencias SQL, con nombre (`consultas.sql`, `ingestion.sql`, `seed.sql`). El código no contiene SQL: lo carga de aquí |
| `src/dominio/` | Reglas puras, sin dependencias: fechas, estados, plantillas, categorías de error |
| `src/aplicacion/` | Webhook, worker, ciclo del asistente, herramientas, relevo, ingestión, lecturas |
| `src/infraestructura/` | PostgreSQL, MongoDB, OpenAI, y las versiones falsas que usan los tests |
| `src/http/` | Rutas y esquemas de la API |
| `conocimiento/` | Los 8 documentos de la clínica de ejemplo |
| `web/` | Interfaz en React: bandeja, detalle con trazabilidad, simulador |
| `tests/` | Tests de la aplicación |
| `verificacion/` | Verificador de la capa de PostgreSQL y sus resultados |
| `docs/` | Arquitectura, decisión sobre la cola y diseño en AWS |
| `infra/terraform/` | Terraform de la base del diseño en AWS (red, PostgreSQL, cola de envío, secretos, logs). No está desplegado; su README explica cómo validarlo sin una cuenta de AWS |

## API

| Endpoint | Uso |
|---|---|
| `POST /webhooks/messages` | Recibe `{message_id, from, text, timestamp}`. 202 aceptado o duplicado; 400 inválido; 409 mismo `message_id` con otro contenido; 429 más de 20 mensajes por minuto del mismo teléfono; 503 base no disponible |
| `GET /api/conversaciones?estado=` | Bandeja. `estado` opcional: `en_curso`, `resuelta_por_ia`, `cita_agendada`, `escalada` |
| `GET /api/conversaciones/:id` | Mensajes, respuestas y trazas de cada intento |
| `GET /health/live` | El proceso está vivo |
| `GET /health/ready` | Depende solo de PostgreSQL; informa el estado de Mongo sin que afecte el resultado |

## Datos de ejemplo

Clínica Valle Salud, con 2 sedes (Norte y Sur), 3 especialidades (Medicina general, Pediatría, Dermatología), 5 profesionales y 14 días de agenda desde la fecha en que se prepara la base: lunes a viernes de 8:00 a 12:00 y de 14:00 a 17:00, sábados de 8:00 a 12:00, en citas de 30 minutos.

## Qué está probado y qué no

| Parte | Estado |
|---|---|
| Esquema, cola, bloqueos, concurrencia, citas, outbox, búsqueda vectorial | Probado por `verificacion/verificar.py` contra PostgreSQL 16 con pgvector: 159 de 159 comprobaciones. La salida completa está en `verificacion/resultado.txt` |
| Webhook, worker, herramientas, fechas, plantillas, ingestión, relevo, API | Probado por `npm test` contra PostgreSQL real, con modelo y embeddings falsos: 181 tests |
| Adaptador de OpenAI | Probado sin red: qué envía y cómo clasifica los errores. Ejecutado contra la API real con `gpt-4o-mini` y `text-embedding-3-small`. Los errores del proveedor (429, 5xx, clave inválida) no se han provocado contra la API real |
| Comportamiento del modelo real con el prompt y las herramientas | Probado a mano con `gpt-4o-mini`, en pocas conversaciones: pregunta con y sin respuesta en los documentos, agendamiento por opción, cambio de fecha después de una oferta, pregunta intercalada entre la oferta y la elección, nueva oferta cuando otro paciente toma un horario, y escalamiento. No hay un conjunto de evaluación ni se ha probado otro modelo. Lo observado, con dos fallos que se corrigieron, está en `DECISIONS.md`, sección 5 |
| Umbral de similitud (`UMBRAL_SIMILITUD`, 0,3) | Sin calibrar. Con embeddings reales solo hay unas pocas búsquedas observadas (`DECISIONS.md`, sección 3.8) |
| Almacén de trazas en MongoDB | Probado contra MongoDB 7 real (`tests/mongo.test.ts`, con `MONGO_URL_PRUEBAS`). En ejecución, las trazas de las conversaciones reales llegaron a Mongo por el relevo; con Mongo detenido, el paciente recibió su respuesta, la traza se vio desde PostgreSQL y pasó a Mongo al volver |
| Dependencias | `npm audit` sin vulnerabilidades conocidas, en el servidor y en la interfaz (4 de octubre de 2026) |
| `docker compose up --build` | Ejecutado desde volúmenes vacíos y sobre una base ya preparada: construye la imagen (servidor e interfaz), aplica las migraciones, carga los documentos con embeddings reales y arranca la API y el worker |
| Interfaz web | Compila, y se revisó a mano contra la API con datos de prueba |

## Dónde el código precisa o se aparta de `docs/ARQUITECTURA.md`

Son decisiones tomadas al implementar. Están aquí para revisarlas y, si se mantienen, pasarlas al documento de arquitectura.

| Tema | Lo que hace el código | Motivo |
|---|---|---|
| Cita creada y turno que no termina bien | Si en el intento se creó una cita, el paciente recibe la confirmación aunque se agoten las iteraciones, el plazo o el tamaño. Después de agendar, el código rechaza `escalar_a_humano` y cualquier `responder` que no sea `confirmacion_cita` | Sin esto, un paciente podía quedar con una cita de la que nadie le habló y con la conversación escalada |
| Motivo de `escalar_a_humano` | Lista cerrada de cuatro motivos, no texto libre | El motivo se guarda y se muestra al coordinador: no debe ser texto escrito por el modelo |
| Oferta de horarios | Solo horarios de una misma especialidad | La plantilla nombra una especialidad |
| Contenido canónico | Las marcas de Markdown (`## `, `- `) no forman parte de la línea guardada | El paciente recibe "Sede Norte", no "## Sede Norte" |
| Huella del documento | Incluye la lista de fragmentos | Las mismas líneas con otra estructura producen otros fragmentos |
| Fragmentos de documentos en el prompt | Van como resultado de herramienta (rol propio, JSON), no con las marcas `<mensaje_paciente>` | La separación la da el rol; las marcas son para el texto del paciente |
| Preparación sin clave de OpenAI | Crea esquema y agenda, avisa y termina bien; no carga documentos | Para que las bases, la API y la interfaz arranquen sin clave |
| Lecturas de Mongo | Tras un fallo, no se reintenta durante 5 s; la sonda de salud le da 300 ms | La pantalla de detalle consulta cada 1,5 s y Mongo caído tarda 3 s en fallar |
| Error 400 de OpenAI | Fallo lógico: el turno se escala sin reintentar (`solicitud_rechazada`) | El proveedor rechazó esa entrada; repetirla daría lo mismo |
| Errores 401, 403 y 404 de OpenAI | Se reintentan como infraestructura y generan una alerta de configuración en el log | Son del despliegue, no del mensaje. Escalar es irreversible: un error corregido en segundos no debe dejar escaladas todas las conversaciones que llegaron mientras tanto |
| Búsqueda de conocimiento | Una sola sentencia trae fragmentos, documento y líneas (`conocimiento_buscar_con_texto`). Al responder se exige que existan todas las líneas elegidas | Una reingestión simultánea no puede producir un "no hay información" falso ni una respuesta incompleta |
| `sin_informacion` | Solo se acepta si en ese intento se usó `buscar_conocimiento` | "No tengo esa información" es una afirmación sobre los documentos: no puede salir sin haberlos consultado |
| Elección sobre una oferta anterior | La oferta se guarda con el mensaje (`sql/002_oferta_slots.sql`). `opcion` debe coincidir con la posición extraída del mensaje completo y se resuelve contra esa oferta | El modelo no puede traducir una hora en número, contradecir al paciente ni remapear una posición tras consultar de nuevo |
| Elección descrita por hora, sede o profesional | `atributos` busca en la oferta guardada y produce otra oferta persistida y numerada, incluso con una sola coincidencia. Nunca crea una cita | La cita requiere una selección posicional en un mensaje posterior; los atributos añadidos por el modelo no autorizan una reserva |
| Etiquetas `H` y `F` | Valen dentro del intento y su numeración continúa entre consultas del mismo turno; nunca se reutilizan | Permite ofrecer horarios de dos fechas en un turno, y en la traza una etiqueta nombra siempre un solo dato |
| Sentencias SQL nuevas | `bandeja_todas`, `detalle_conversacion`, `contexto_clinica`, `contexto_sedes`, `contexto_especialidades`, `conocimiento_buscar_con_texto`; `cita_de_mensaje` trae también los nombres | Las necesitaba la aplicación. El verificador las ejecuta |
| Parámetros de fecha | El cargador de SQL los envía como `CAST($n AS timestamptz)` | Postgres no puede deducir el tipo en expresiones como `:ahora - interval '1 minute'` |
| Día de la semana | `dia_semana` se acepta con tilde o mayúsculas (`miércoles`, `Sábado`) y se normaliza antes de validar | Con el modelo real, un `miércoles` rechazado terminó en `dias_desde_hoy` contado por el modelo, y ofreció el martes |

El tope de conversaciones por clínica y la exigencia de `READ COMMITTED` se prueban en `verificacion/verificar.py`, con 20 conexiones simultáneas; los tests de la aplicación no los repiten.

## Límites conocidos de esta versión

- El webhook no tiene autenticación ni verificación de firma. En producción se valida la firma del proveedor.
- Todos los mensajes del webhook pertenecen a una sola clínica, la de `CLINICA_ID`. En producción la clínica sale del número que recibe el mensaje.
- La respuesta del asistente se guarda y se muestra en la interfaz; no se envía a WhatsApp.
- No hay cancelación ni consulta de citas existentes.
- La API de consulta no tiene autenticación.

### Selección necesaria para reservar

Una cita nueva requiere que el paciente responda a la última oferta con una posición explícita: `1`, `la 2`, `opción 3`, `el número 4`, `el primero` o `la segunda` (hasta 8). Se acepta un punto o signo de exclamación final. El código extrae la posición del mensaje completo y exige que el argumento `opcion` coincida. Las etiquetas H solo sirven para mostrar horarios.

Las referencias por hora, sede o profesional (`atributos`) producen una nueva oferta numerada; incluso una coincidencia única necesita otra respuesta por número. Se pierde la reserva inmediata por «mañana a las 8», «ese», «el último», frases con condiciones o negaciones y fórmulas fuera de esta gramática. Ante duda no se reserva: se vuelve a mostrar la lista, solo con los horarios de la oferta que siguen libres y renumerada, y se pide el número. Esa lista se guarda como una oferta nueva. Las reservas idempotentes ya creadas se recuperan sin pedir otra selección.

Una posición solo vale mientras el asistente espera la elección de esa oferta. Ese estado se deriva del tipo de las respuestas ya guardadas, sin columnas nuevas: después de la oferta solo puede haber respuestas documentales o «no tengo esa información». Una pregunta al paciente (fecha, sede, especialidad), un «no hay horarios», una confirmación, un escalamiento o un respaldo la anulan, y otra oferta la reemplaza. Así, «el 5» contestado a «¿para qué día desea la cita?» no reserva la opción 5 de una lista anterior. Límite: un «el 5» enviado justo después de la oferta se toma como la opción 5.

Una oferta puede autorizar como máximo una cita nueva. El consumo se deriva de la cita persistida y de la secuencia de su mensaje de origen, incluso antes de guardar la confirmación y aunque después se cancele. El contexto conserva la identidad, secuencia y slots de la última oferta del historial; nunca retrocede a una oferta anterior si la última fue consumida. Bajo el bloqueo de conversación, el INSERT revalida esa misma oferta como la última de la conversación, sin consumir, y comprueba posición, slot, clínica y futuro. La recuperación de una cita propia tiene prioridad. Para otra cita se necesita una oferta posterior y otra selección en otro mensaje. Se mantiene la ventana de historial existente.
