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
  -d '{"message_id":"prueba-1","from":"+573001112233","text":"¿Cuánto ayuno necesito para el perfil lipídico?","timestamp":"2026-10-06T03:40:00Z"}'
```

Sin `OPENAI_API_KEY`, las bases, la API y la interfaz arrancan igual, pero el worker no: los mensajes quedan en cola y nadie los responde.

## Tests

No usan el modelo real ni Mongo. Usan PostgreSQL real, con el mismo esquema y las mismas sentencias SQL que la aplicación.

```bash
docker compose up -d postgres      # crea también la base asistente_test
npm install
npm test
```

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
| `sql/` | Esquema (`001_esquema.sql`) y todas las sentencias SQL, con nombre (`consultas.sql`, `ingestion.sql`, `seed.sql`). El código no contiene SQL: lo carga de aquí |
| `src/dominio/` | Reglas puras, sin dependencias: fechas, estados, plantillas, categorías de error |
| `src/aplicacion/` | Webhook, worker, ciclo del asistente, herramientas, relevo, ingestión, lecturas |
| `src/infraestructura/` | PostgreSQL, MongoDB, OpenAI, y las versiones falsas que usan los tests |
| `src/http/` | Rutas y esquemas de la API |
| `conocimiento/` | Los 8 documentos de la clínica de ejemplo |
| `web/` | Interfaz en React: bandeja, detalle con trazabilidad, simulador |
| `tests/` | Tests de la aplicación |
| `verificacion/` | Verificador de la capa de PostgreSQL y sus resultados |
| `docs/` | Arquitectura, decisión sobre la cola y diseño en AWS |

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
| Esquema, cola, bloqueos, concurrencia, citas, outbox, búsqueda vectorial | Probado por `verificacion/verificar.py` contra PostgreSQL 16 con pgvector (ver `verificacion/resultado.txt`) |
| Webhook, worker, herramientas, fechas, plantillas, ingestión, relevo, API | Probado por `npm test` contra PostgreSQL real, con modelo y embeddings falsos |
| Adaptador de OpenAI | Probado sin red: qué envía y cómo clasifica los errores. No se ha ejecutado contra la API real |
| Comportamiento del modelo real con el prompt y las herramientas | Sin probar. Requiere una clave |
| Umbral de similitud (`UMBRAL_SIMILITUD`, 0,3) | Sin calibrar con embeddings reales |
| Almacén de trazas en MongoDB | Probado solo el caso de Mongo inalcanzable. El test contra un Mongo real existe (`tests/mongo.test.ts`) y no se ha ejecutado |
| Dependencias | `npm audit` sin vulnerabilidades conocidas, en el servidor y en la interfaz (4 de octubre de 2026) |
| `docker compose up` | La sintaxis del archivo es válida. La construcción de la imagen y el arranque completo no se han ejecutado |
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
| Etiquetas `H` y `F` | Valen dentro del intento y su numeración continúa entre consultas del mismo turno; nunca se reutilizan | Permite ofrecer horarios de dos fechas en un turno, y en la traza una etiqueta nombra siempre un solo dato |
| Sentencias SQL nuevas | `bandeja_todas`, `detalle_conversacion`, `contexto_clinica`, `contexto_sedes`, `contexto_especialidades`, `conocimiento_buscar_con_texto`; `cita_de_mensaje` trae también los nombres | Las necesitaba la aplicación. El verificador las ejecuta |
| Parámetros de fecha | El cargador de SQL los envía como `CAST($n AS timestamptz)` | Postgres no puede deducir el tipo en expresiones como `:ahora - interval '1 minute'` |

El tope de conversaciones por clínica y la exigencia de `READ COMMITTED` se prueban en `verificacion/verificar.py`, con 20 conexiones simultáneas; los tests de la aplicación no los repiten.

## Límites conocidos de esta versión

- El webhook no tiene autenticación ni verificación de firma. En producción se valida la firma del proveedor.
- Todos los mensajes del webhook pertenecen a una sola clínica, la de `CLINICA_ID`. En producción la clínica sale del número que recibe el mensaje.
- La respuesta del asistente se guarda y se muestra en la interfaz; no se envía a WhatsApp.
- No hay cancelación ni consulta de citas existentes.
- La API de consulta no tiene autenticación.
