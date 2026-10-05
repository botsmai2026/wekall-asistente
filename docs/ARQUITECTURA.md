# Arquitectura completa: asistente de agendamiento con IA

Documento de revisión antes de construir. Reúne las siete decisiones ya cerradas (framework, cola, citas, historial y trazas, vectores, fechas, LLM) en un solo diseño, para buscar contradicciones entre partes. Será la base del `DECISIONS.md`.

El diseño en AWS, los costos y el frontend en detalle no están aquí: se trabajan después, sobre esta base.

## 0. Qué revisar primero

Al integrar las partes aparecieron cinco tensiones y cuatro decisiones que nunca se discutieron. Son lo más importante de este documento.

### Tensiones encontradas al integrar

**T1. Los dos relojes chocan con el mensaje de ejemplo del enunciado.** "Mañana" se interpreta con la hora del mensaje; "fecha pasada" se valida con el reloj real. Si un evaluador envía el ejemplo literal (`2026-10-06T03:40:00Z`) días después, "mañana" da 6 de octubre, que ya pasó, y el asistente responde que la fecha no es válida. Ese comportamiento es correcto para un mensaje viejo, pero puede parecer un fallo en la demo. Resolución:

- El caso del enunciado se demuestra en un test con reloj fijo en esa fecha.
- El simulador envía siempre la hora actual.
- Los ejemplos del README generan la hora actual, no una fecha fija.
- El seed crea la agenda a partir de la fecha en que se ejecuta.
- Queda anotado en el DECISIONS.md como ambigüedad resuelta.

**T2. Un worker tardío podía crear una cita.** El cierre estaba protegido por el número de intento, pero la cita, que se escribe a mitad del ciclo, no. Resolución: la transacción de la cita también verifica que el intento siga vigente. Un worker puede seguir ejecutando código después de perder su candado, pero no puede producir efectos de negocio ni cerrar el mensaje si su número de intento ya no es el actual.

**T3. Mongo estaba en el camino crítico (corregido en la revisión 2).** La respuesta del asistente solo vivía en la traza de Mongo, así que Mongo caído impedía responder, y tres fallos terminaban en una escalada de negocio causada por un problema de auditoría. Resolución, en dos partes:

- El texto de la respuesta válida se guarda en Postgres, en el mismo cierre del mensaje. La conversación completa (paciente y asistente) se lee de Postgres.
- Las trazas pasan por una tabla de salida en Postgres (`trazas_pendientes`), escrita en la misma transacción del cierre. Un relevo las inserta en Mongo y las borra. Si Mongo está caído, esperan ahí.

Consecuencia: Mongo queda fuera del camino crítico. Si se cae, el paciente recibe su respuesta, el estado es correcto y ninguna traza se pierde. Una caída de Mongo nunca provoca reintentos del LLM ni escaladas.

**T4. Reintentos agotados con una cita ya creada (resuelto por T3).** Con Mongo fuera del camino crítico, la recuperación de una cita existente solo necesita Postgres, así que se evalúa antes que el límite de intentos y siempre puede cerrar.

**T5. Mensajes huérfanos.** Si un worker muere, el mensaje queda en `procesando`. El reclamo debe tomar también esos mensajes cuando el candado de su conversación venció, no solo los `pendiente`.

### Decisiones nuevas, no discutidas antes

**N1. La clínica no viene en el webhook.** El formato del enunciado no trae identificador de clínica. En esta versión el webhook asigna la única clínica del seed; en producción saldría del número de WhatsApp que recibe el mensaje. Llevan `clinica_id` las tablas raíz de cada clínica: sedes, especialidades, conversaciones, documentos y fragmentos. Profesionales, horarios y citas lo derivan por sus claves foráneas (horario, profesional, sede, clínica). En producción se reforzaría con claves foráneas compuestas y seguridad a nivel de fila.

**N2. Drivers directos, sin ORM.** `pg` para Postgres y el driver oficial de Mongo, con SQL escrito a mano. El diseño depende de `FOR UPDATE SKIP LOCKED`, índices parciales y pgvector, que un ORM esconde o dificulta. Costo: sin tipos generados ni migraciones automáticas; las migraciones son archivos SQL numerados.

**N3. Sin autenticación en el webhook ni en la API interna.** El enunciado pide que se pueda probar con un `POST` simple. En producción el webhook verificaría la firma de Meta y la API tendría autenticación. Queda documentado, no construido.

**N4. El estado solo sube.** La precedencia de estados se implementa como una regla única: un estado nuevo se aplica solo si su rango es mayor que el actual. Un disparador en la base rechaza cualquier intento de bajarlo, venga del código que venga.

### Especificación ejecutable

El esquema y las consultas de este documento están escritos y verificados contra PostgreSQL 16. Los archivos SQL están en `sql/`; el verificador y sus resultados, en `verificacion/`:

- `001_esquema.sql`: las 12 tablas con sus restricciones, índices y disparadores.
- `002_oferta_slots.sql`: la columna que guarda, con cada oferta de horarios, cuáles se ofrecieron y en qué orden (sección 7.2).
- `consultas.sql`: única fuente de las sentencias SQL del asistente (webhook, worker, relevo y lecturas), como bloques con nombre (`-- name:`) y parámetros con nombre. El verificador y la aplicación cargan este mismo archivo; no hay copias del SQL en los tests ni en el código. En el código solo vive el orden en que cada transacción ejecuta las sentencias.
- `ingestion.sql`: las sentencias de la carga de conocimiento, en el mismo formato. Va aparte porque es otro proceso: en producción corre con un rol de base distinto, el único que puede escribir en las tablas de conocimiento.
- `verificar.py`: carga el esquema, las migraciones que lo acompañan, las consultas y la ingestión que se le indiquen (por defecto, los de `sql/`), imprime la ruta y la huella SHA-256 de cada archivo, y comprueba restricciones, orden, protección contra worker tardío, orden de bloqueos, idempotencia, concurrencia real y planes de ejecución con 200.000 conversaciones y un millón de mensajes. Informa cuántas sentencias de cada archivo ejecutó.
- `benchmark_vectorial.py` y `benchmark_vectorial.txt`: tiempo de la búsqueda vectorial según el tamaño de una clínica, y comparación con un índice aproximado.
- `resultado.txt`: la salida de la última ejecución, con las huellas de los archivos probados. El número de comprobaciones se lee ahí, no en este documento. Con pgvector instalado se ejecutan todas las sentencias de los dos archivos, incluida la búsqueda vectorial; sin pgvector, el verificador omite esa sección y lo dice.
- `planes.txt`: la salida de `EXPLAIN (ANALYZE, BUFFERS)` de cada consulta.

Dos hallazgos de esa verificación que el documento solo no habría mostrado:

- El índice de la cola se decidió midiendo, en tres pasos. Con solo el índice por conversación, el reclamo ordenaba la cola entera. Un segundo índice por secuencia lo resolvía cuando todos los mensajes estaban listos, pero se degradaba cuando muchos esperaban reintento, porque recorría los que aún no podían tomarse. El índice final ordena por el momento en que el mensaje quedó listo: el reclamo se mantiene por debajo de medio milisegundo con 20.000 mensajes atrasados, estén listos todos, la mitad o el 10 %. `verificar.py` reproduce la comparación y `planes.txt` guarda los valores.
- Límite conocido de ese índice: mensajes listos pero bloqueados porque el más antiguo de su conversación espera reintento. Con 10.000 en esa situación el reclamo tarda decenas de milisegundos (el valor de la última ejecución está en `resultado.txt`). Es aceptable frente a los segundos que tarda el modelo. Si en producción la cola pasa a SQS FIFO, eso no se resuelve solo: hay que diseñar el paso de Postgres a SQS, el orden de publicación por conversación, la reentrega y cómo se conserva la protección por intento. Queda para el diseño de AWS.
- Equidad entre clínicas: el reclamo no toma una conversación de una clínica que ya tiene su máximo de conversaciones en proceso. Así el atraso de una clínica no ocupa todos los workers. Ese filtro solo no garantizaba el tope: con 20 reclamos simultáneos y tope 2 se midieron 20 conversaciones tomadas de la misma clínica, porque cada sentencia ve una fotografía y todas veían el mismo conteo. La primera versión de este documento decía que el exceso era de uno como máximo; era falso. Ahora el reclamo toma un turno por clínica (bloqueo consultivo de transacción) y vuelve a contar antes de poner el candado: el tope es estricto y está probado con 20 workers simultáneos, sin rotación y con ella. Dos límites de esa garantía: cuenta candados vigentes, no procesos (un worker cuyo candado venció no cuenta), y el valor del tope es hoy un parámetro global, no una columna por clínica. Como una conversación en proceso hace una sola llamada al modelo a la vez, este tope es también el máximo de llamadas simultáneas al modelo por clínica. La decisión completa sobre la cola en producción, con sus alternativas, está en `ADR-001-cola-en-produccion.md`.
- Las mediciones tras actualizaciones masivas se hacen después de limpiar filas muertas, como haría autovacuum. Sin esa limpieza los tiempos suben varias veces: una tabla que funciona como cola necesita autovacuum bien configurado.
- Una inversión de bloqueos producía un deadlock real: el reclamo bloqueaba conversación y luego mensaje, y `agendar_cita` bloqueaba mensaje y luego conversación. Un worker tardío agendando mientras otro reclamaba la misma conversación terminaba con una de las dos transacciones abortada por Postgres. Se reprodujo, se fijó un orden global (conversación, mensaje, cita) y se probó con 15 carreras sin ningún deadlock.
- El límite por teléfono debe contar por la hora del servidor (`recibido_en`), no por la del mensaje, que la controla quien envía.

Alcance de esa verificación, en dos niveles que no deben confundirse:

- **Capa de PostgreSQL, verificada.** Esquema, restricciones, cola, bloqueos, concurrencia, citas, idempotencia, separación por clínica, outbox, ingestión, lecturas y la consulta de búsqueda vectorial con pgvector real: ordena por similitud, filtra por clínica y por modelo, y entrega las líneas literales del fragmento. Descartar los resultados bajo el umbral no es parte de esta capa: lo hace la aplicación, y lo ejercitan sus tests.
- **Lo que esa verificación no cubre.** La búsqueda se probó con embeddings de prueba deterministas, no con el modelo real: no mide calidad semántica ni calibra el umbral. Tampoco cubre el adaptador del LLM, el ciclo de herramientas, el prompt, Mongo y su relevo, la API ni el frontend. Eso lo cubren los tests de la aplicación (`npm test`) y, para el modelo real, las conversaciones de prueba que resume el README en "Qué está probado y qué no".

## 1. Principios

1. **El código responde por el resultado, no el modelo.** El modelo interpreta lenguaje y elige herramientas. El código valida, calcula fechas, ejecuta, y decide qué texto sale.
2. **Postgres dice qué es cierto ahora. Mongo dice qué ocurrió y cuánto costó.** Todo lo que el paciente recibió y todo estado vive en Postgres. Mongo es evidencia: ninguna operación necesita que Mongo esté disponible para ser correcta.
3. **Cada regla crítica tiene una barrera concreta en código o en la base** (sección 9).
4. **Todo mensaje aceptado termina eventualmente** en `procesado` o `fallido`, y genera una respuesta al paciente.

## 2. Componentes

| Componente | Tecnología | Responsabilidad |
|---|---|---|
| API | Node, TypeScript, Fastify, TypeBox | Webhook y endpoints de consulta. Nunca llama al LLM. |
| Worker | Mismo código, proceso aparte | Reclama mensajes y ejecuta el ciclo del asistente. |
| PostgreSQL con pgvector | Imagen `pgvector/pgvector` | Estado operativo, agenda, cola, conocimiento. |
| MongoDB | Imagen oficial | Trazas de intento. |
| Frontend | React | Bandeja, detalle, simulador. |

Estructura del código, en cuatro capas:

- `dominio`: reglas puras sin dependencias (fechas, estados, plantillas).
- `aplicacion`: worker, ciclo del asistente, herramientas.
- `infraestructura`: Postgres, Mongo, OpenAI, y sus versiones falsas.
- `http`: rutas y esquemas.

La integración con el LLM vive solo en `infraestructura`. La lógica de negocio vive en `dominio` y `aplicacion`, y no importa nada de OpenAI.

Tres dependencias son interfaces reemplazables en tests: `Reloj`, `ModeloLenguaje`, `GeneradorEmbeddings`.

## 3. Modelo de datos

### PostgreSQL

| Tabla | Campos clave | Restricciones e índices |
|---|---|---|
| `clinicas` | id, nombre, zona_horaria | |
| `sedes` | id, clinica_id, nombre | |
| `especialidades` | id, clinica_id, nombre | |
| `profesionales` | id, clinica_id, sede_id, especialidad_id, nombre | Claves foráneas compuestas: su sede y su especialidad son de su misma clínica |
| `slots` | id, clinica_id, profesional_id, inicia_en, termina_en | `UNIQUE(profesional_id, inicia_en)`; restricción de exclusión: un profesional no tiene horarios solapados; clave compuesta: el horario es de la clínica de su profesional |
| `citas` | id, clinica_id, slot_id, conversacion_id, source_message_id, estado | Único parcial en `slot_id` donde `estado IN ('agendada')`; `UNIQUE(source_message_id)`; clave foránea compuesta (mensaje, conversación): la cita solo puede estar en la conversación de su mensaje; claves compuestas con `clinica_id`: horario y conversación son de la misma clínica |
| `conversaciones` | id, clinica_id, telefono, estado, motivo_escalamiento, procesando_hasta, ultima_actividad | `UNIQUE(clinica_id, telefono)`; índice `(estado, ultima_actividad)` para la bandeja |
| `mensajes_entrantes` | message_id, conversacion_id, secuencia, texto, enviado_en, recibido_en, estado, intento_actual, intento_valido, proximo_intento_en, respuesta_tipo, respuesta_texto, oferta_slots | Clave primaria `message_id`; índice `(conversacion_id, secuencia)` para el historial; dos índices parciales donde `estado IN ('pendiente','procesando')` para la cola, uno por conversación y secuencia y otro por momento de quedar listo; disparador que impide modificar identidad, orden, texto y horas; índice `(conversacion_id, recibido_en)` para el límite por teléfono; `CHECK` entre columnas: un mensaje terminado tiene respuesta e intento válido, uno sin terminar no; `oferta_slots` (de 1 a 8 horarios, en el orden mostrado) solo existe en una respuesta de tipo `oferta_horarios` |
| `trazas_pendientes` | message_id, intento, documento (JSON), creado_en, intentos_envio, estado_envio, ultimo_error | `UNIQUE(message_id, intento)`; índice parcial por `creado_en` donde `estado_envio = 'pendiente'`. Outbox transaccional hacia Mongo; normalmente vacía |
| `documentos` | id, clinica_id, titulo, huella | La huella cubre título, contenido, modelo de embeddings y versión del fragmentador. No guarda el texto |
| `documento_lineas` | documento_id, numero, texto | Única copia del contenido canónico, una fila por línea. Máximo 500 caracteres por línea (`CHECK`). Un disparador impide editarlas: se reingiere el documento |
| `fragmentos_conocimiento` | id, documento_id, clinica_id, linea_encabezado, linea_inicial, linea_final, embedding, modelo_embedding | No guarda texto: apunta a líneas, con claves foráneas a `documento_lineas`. Clave compuesta (documento, clínica). Índice por `clinica_id`; sin índice vectorial |

Integridad en las migraciones, además de lo listado: todas las columnas son `NOT NULL` salvo las que nacen vacías (intento válido, respuesta, motivo de escalamiento, candado, último error); cada columna de estado tiene un `CHECK` con sus valores permitidos; los contadores de intento tienen `CHECK` de no negativos; y toda referencia entre tablas es una clave foránea explícita. Las barreras que afirma este documento deben existir en SQL, no solo en el código.

Los dos índices parciales de la cola y del outbox solo contienen filas sin terminar, así que se mantienen pequeños aunque el historial crezca.

Estados de una cita: `agendada`, `cancelada`. Regla de negocio: una cita agendada bloquea el horario; una cancelada lo libera.

Cancelar una cita no es una operación de esta versión: ninguna herramienta ni endpoint la ofrece. El estado `cancelada` existe para que el índice parcial tenga la semántica correcta y pueda probarse. Por eso la conversación nunca necesita bajar de `cita_agendada` aquí. Cuando exista cancelación, la regla "el estado solo sube" tendrá que revisarse junto con ella.

Todas las fechas se guardan en UTC (`timestamptz`).

### MongoDB

Una colección, `trazas_intento`. Un documento por ejecución del worker. Solo inserción, nunca se modifica.

| Campo | Contenido |
|---|---|
| `message_id`, `intento` | Identidad. Índice único compuesto. |
| `clinica_id`, `conversacion_id`, `creado_en` | Índice para el detalle. La clínica va en cada traza: ninguna consulta futura depende solo de un identificador global. |
| `tipo` | `llm`, `recuperacion_cita` o `respaldo` |
| `motivo` | Para respaldo: `reintentos_agotados` o `conversacion_escalada` |
| `texto_paciente`, `texto_asistente` | Entrada y salida del turno |
| `modelo`, `tokens_entrada`, `tokens_salida`, `latencia_ms` | Medición |
| `llamadas` | Lista: herramienta, argumentos, resultado o error, identificadores reales |
| `resultado` | Tipo de respuesta y estado en que quedó el turno |
| `resultado_procesamiento` | `completado`, `fallido` o `descartado_por_intento` |
| `error` | Si el intento falló |

Si la inserción se repite, el error de clave duplicada se trata como éxito.

Límite reconocido: la traza se escribe cuando el intento termina o aborta de forma controlada. Si el proceso muere de golpe a mitad de un intento, ese intento no deja detalle. Queda la evidencia de que existió: el contador de intentos en Postgres y el salto en la numeración de las trazas. Cerrarlo del todo exigiría registrar el inicio de cada intento además del final, y queda para producción.

Las trazas llegan a Mongo desde la tabla `trazas_pendientes` de Postgres (patrón outbox transaccional), con un retraso normal de milisegundos. La traza se confirma en Postgres junto con el cierre, y queda guardada ahí hasta que Mongo la acepta o pasa a revisión por un fallo permanente. La entrega es de al menos una vez.

No hace falta una transacción distribuida: Mongo puede recibir la misma traza varias veces, y el índice único en `message_id` e intento hace idempotente la publicación. Esto cubre el caso en que el relevo muere después de insertar en Mongo y antes de borrar la fila.

Funcionamiento del relevo:

- Una traza por transacción de Postgres, con esta secuencia: abre la transacción, toma una fila `pendiente` priorizando por `creado_en` con `FOR UPDATE SKIP LOCKED`, inserta en Mongo, borra la fila o registra el fallo, y confirma. Repite hasta 100 por ciclo. No hay orden global estricto entre trazas, ni se necesita.
- La inserción en Mongo ocurre con la transacción de Postgres abierta, pero no es parte de ella: no hay atomicidad entre las dos bases. Si Mongo confirma y el relevo muere antes de confirmar en Postgres, la traza se envía de nuevo y la unicidad en Mongo la absorbe.
- El límite real de la transacción lo pone el driver de Mongo: 3 s como máximo para seleccionar servidor, conectar y completar la operación. Como protección adicional, por si ese límite fallara, Postgres corta cualquier transacción del relevo que quede inactiva más de 10 s (`idle_in_transaction_session_timeout`). Si el relevo muere, Postgres libera la fila al cerrarse la conexión.
- La fila del outbox solo se borra después de una escritura reconocida por Mongo según el nivel de confirmación configurado para el despliegue (`w: "majority"`, `j: true`). Esa durabilidad es una propiedad del despliegue, no solo del código: con un conjunto de réplicas significa mayoría de nodos y registro en disco; con el Mongo de un solo nodo del entorno local significa ese nodo con registro en disco.
- Decisión y trade-off: el bloqueo de la transacción hace de candado, sin estados ni vencimientos propios. Cuesta una conexión de Postgres ocupada hasta 3 s por traza cuando Mongo está lento. La alternativa (reclamar, confirmar, escribir en Mongo, finalizar en otra transacción) no retiene conexiones, pero exige un estado `procesando`, un vencimiento y la recuperación de filas reclamadas por un relevo muerto. Para el worker principal sí se usa ese esquema, porque el LLM puede tardar 60 s. Para una escritura de 3 s no se justifica. Se cambiaría si el relevo necesitara mucho más caudal.
- Si Mongo no responde, el fallo es de todo el servicio, no de una fila: el relevo espera con un tiempo creciente (hasta 30 s) antes de volver a intentar. Las filas no se tocan.
- Si Mongo rechaza un documento concreto, se incrementa `intentos_envio` de esa fila y se guarda el motivo en `ultimo_error`. Tras 10 rechazos pasa a `estado_envio = requiere_revision`: el relevo deja de tomarla, no bloquea a las demás y la traza se conserva en Postgres.

Con este volumen, una columna JSON en Postgres bastaría para las trazas. Mongo es un requisito del enunciado, y se le da el papel donde mejor encaja: documentos anidados de forma variable, de solo inserción y crecimiento rápido, fuera del camino crítico.

### Glosario

| Término | Definición |
|---|---|
| Mensaje | Lo que escribió el paciente. Inmutable. Identificado por `message_id`. |
| Intento | Una ejecución del worker sobre un mensaje. Su número se incrementa al reclamar y nunca se reutiliza. |
| Turno | Interacción lógica identificada por `message_id`. Puede tener varios intentos; el válido es el que Postgres marca. |
| Candado de conversación | `procesando_hasta`. Impide procesar dos mensajes del mismo teléfono a la vez. Vence a los 120 s. |
| `source_message_id` | Mensaje que originó una cita. Clave de idempotencia del agendamiento. |

## 4. Estados

### Mensaje (interno de la cola)

| Estado | Significado | Quién lo escribe |
|---|---|---|
| `pendiente` | Espera ser procesado o reintentado | Webhook; worker tras un fallo transitorio |
| `procesando` | Un worker lo reclamó | Worker, al reclamar |
| `procesado` | Terminó con un intento válido | Worker, en el cierre |
| `fallido` | Se agotaron los intentos; no se resolvió automáticamente | Worker, en el respaldo |

### Conversación (lo que ve el coordinador)

El estado representa la situación más relevante para el coordinador, no el resultado del último mensaje. Solo sube de rango.

| Rango | Estado | Significado | Cuándo se escribe |
|---|---|---|---|
| 0 | `en_curso` | Abierta, sin resultado final todavía | Al crear la conversación |
| 1 | `resuelta_por_ia` | El asistente respondió con respaldo documental | Cierre de un turno `respuesta_documental` |
| 2 | `cita_agendada` | Tiene una cita activa | En la misma transacción que crea la cita |
| 3 | `escalada` | Un humano debe atender | Cierre de un turno escalado, o reintentos agotados |

Los turnos que terminan en oferta de horarios, pregunta aclaratoria, sin disponibilidad o sin información no cambian el estado.

`escalada` es terminal para el asistente. Los mensajes posteriores se registran y reciben una respuesta fija, sin LLM ni herramientas. Sacar una conversación de ese estado requiere un mecanismo externo que no forma parte de esta versión.

## 5. Flujo del webhook

`POST /webhooks/messages`

1. Valida el cuerpo con TypeBox: campos requeridos, fecha en formato ISO, texto de máximo 2.000 caracteres. Si falla, 400.
2. En una transacción: crea la conversación si no existe, e inserta el mensaje con `ON CONFLICT DO NOTHING`.
3. Si el mensaje ya existía, compara teléfono, texto y hora con lo guardado. Si es el mismo evento, responde 202: no genera trabajo ni consume el límite. Si el identificador llega con otro contenido, responde 409.
4. Si es nuevo, verifica el límite de mensajes por teléfono (20 por minuto). Si se excede, revierte la inserción y responde 429.
5. Responde 202.

No llama al LLM ni a Mongo. Si Postgres no responde, devuelve 503 y el emisor reintenta; el `message_id` hace seguro ese reintento.

## 6. Flujo del worker

Consulta la cola cada segundo.

### 6.1 Reclamo (transacción corta)

1. Busca una conversación con candado libre o vencido que tenga un mensaje `pendiente` con su espera cumplida, o un mensaje `procesando` huérfano. La bloquea con `FOR UPDATE SKIP LOCKED`.
2. Toma el mensaje no terminado de menor secuencia de esa conversación. La secuencia la asigna el servidor al recibir el mensaje.
3. Incrementa `intento_actual`, marca `procesando`, pone el candado a 120 s. Confirma.

### 6.2 Decisión previa (en orden)

| Condición | Camino |
|---|---|
| La conversación está `escalada` | Respaldo por `conversacion_escalada`. |
| Existe una cita con este `source_message_id` | Recuperación: sin LLM, confirmación con plantilla y datos reales. |
| El intento supera el máximo de 3 | Respaldo por `reintentos_agotados`. |
| Ninguna de las anteriores | Ciclo normal con el modelo. |

Los dos primeros caminos son deterministas y solo necesitan Postgres, por eso van antes del límite. El máximo de 3 se refiere a intentos de procesamiento normal con el modelo: una recuperación puede ocurrir en un intento número 4 sin llamar al LLM.

### 6.3 Ciclo del asistente

Presupuesto total: 60 s, como plazo real y no como suma de límites. Al reclamar el mensaje, el worker fija un plazo con un reloj monótono (no la hora del sistema, que puede saltar). Antes de cada operación externa (llamada al modelo, embeddings, consulta a la base) calcula el tiempo restante y usa como límite el menor entre el propio de esa operación y lo que queda. En Postgres se aplica con `statement_timeout` y `lock_timeout` por transacción, para que una espera de bloqueo tampoco pase del plazo. Sin esto, 5 llamadas de 20 s sumarían 100 s y el margen frente al candado de 120 s sería ficticio.

- Una operación que agota su propio límite: fallo de infraestructura, el intento se reintenta.
- El plazo total agotado tras varias operaciones correctas: fallo lógico del ciclo, se escala.

Detalle del ciclo en la sección 7.

### 6.4 Persistencia y cierre

Una sola transacción en Postgres:

1. Actualiza el mensaje solo si `intento_actual` sigue siendo el suyo: `procesado`, `intento_valido`, tipo y texto de la respuesta.
2. Si la actualización aplicó: sube el estado de la conversación si corresponde, guarda el motivo de escalamiento y libera el candado.
3. Inserta la traza en `trazas_pendientes` siempre, aplique o no el cierre, con su `resultado_procesamiento`: `completado`, `fallido` o `descartado_por_intento`. Si el cierre no aplicó, el estado no cambia, pero la evidencia y el costo del intento tardío se conservan y el coordinador ve qué pasó.

El turno termina con esa confirmación en Postgres. El worker no escribe en Mongo: su única responsabilidad con la traza es dejarla en el outbox dentro de la transacción. Publicarla es trabajo asíncrono del relevo, que es el único componente que escribe en Mongo.

El relevo es un módulo separado con su propio ciclo de consulta (cada segundo). En esta versión corre dentro del mismo proceso que el worker para no agregar un contenedor; en producción puede separarse sin cambiar código. La traza llega a Mongo hasta un segundo después, pero el detalle de la conversación la muestra desde el primer momento, porque también lee el outbox.

### 6.5 Cuando el intento falla

Una transacción condicionada al intento: mensaje a `pendiente` con espera creciente, candado liberado y traza con el error en `trazas_pendientes`. El siguiente reclamo decide si reintenta o va a respaldo.

### 6.6 Camino de respaldo

El mismo cierre de 6.4, con respuesta de plantilla: mensaje `fallido` si se agotaron los intentos o `procesado` si la conversación ya estaba escalada; conversación `escalada` con su motivo.

## 7. Motor del asistente

### 7.1 Prompt

- Reglas del asistente.
- Fecha y hora actuales en la zona de la clínica, calculadas por el código a partir de la hora del mensaje.
- Sedes y especialidades reales de la clínica.
- Últimos 10 turnos (configurable), en orden cronológico: solo texto de paciente y asistente, leídos de Postgres. La consulta ya los entrega ordenados.
- Si hay una oferta de horarios en espera de selección y si ya se usó (sección 7.2). Es una ayuda para el modelo: la decisión la toma el código al reservar.

La entrada al modelo está acotada pieza por pieza: mensaje de 2.000 caracteres como máximo, 10 turnos de historial, 4 fragmentos de tamaño máximo fijo, 8 horarios por consulta y 5 iteraciones. Antes de cada llamada el código comprueba el total en caracteres contra un máximo configurable; si se supera, es un fallo lógico y el turno se escala. El tope en caracteres es una barrera general y barata, no una cuenta exacta de tokens: el proveedor cuenta sobre lo que finalmente recibe el modelo, que incluye roles, definiciones de herramientas y marcas propias. Por eso el contrato tiene dos niveles:

- **Aplicación:** tope en caracteres, igual para cualquier proveedor.
- **Adaptador del modelo:** conoce la ventana de contexto del modelo configurado. Al arrancar comprueba que el tope en caracteres, más el máximo de salida y un margen, cabe con holgura en esa ventana; si no, no arranca.

Los tokens reales los informa el proveedor en cada respuesta y quedan en la traza. Si aun así el proveedor rechaza una entrada por exceder su contexto, no se reintenta: el turno se escala y se registra una alerta de error de configuración, porque significa que el contrato anterior está mal calculado.
- El mensaje actual, delimitado como dato.

Todo texto que no escribió el sistema es dato y nunca instrucción: el mensaje actual, los del historial y también los fragmentos de documentos que devuelve `buscar_conocimiento`. Un documento podría contener una frase que parezca una orden. Las reglas del asistente van en el mensaje de sistema; los textos del paciente van en su propio rol y delimitados. Esto reduce el riesgo, pero la protección real es que el modelo solo puede actuar a través de herramientas validadas y no redacta lo que recibe el paciente.

Los datos operativos nunca se confían al historial: se vuelven a consultar con herramientas.

### 7.2 Herramientas

| Herramienta | Argumentos | Devuelve |
|---|---|---|
| `buscar_conocimiento` | pregunta | Fragmentos como `F1`, `F2`…, con sus líneas numeradas (`F1.1`, `F1.2`…), o vacío si ninguno supera el umbral |
| `consultar_disponibilidad` | especialidad, sede (opcional), fecha, franja (opcional) | La fecha consultada y horarios como `H1`, `H2`…. El modelo usa nombres; tras validarlos, el código consulta la base por identificadores |
| `agendar_cita` | exactamente uno: `opcion` o `atributos` | `opcion` solo crea una cita si coincide con la posición extraída del mensaje completo mediante una gramática cerrada y existe en la última oferta persistida. `atributos` busca en esa oferta y produce una nueva oferta numerada, incluso con una sola coincidencia; nunca reserva. Las etiquetas H no autorizan reservas. |
| `escalar_a_humano` | motivo | Termina el turno. No escribe nada: devuelve la intención de escalar. El cierre del intento, protegido contra workers tardíos, guarda en una sola transacción el estado `escalada`, el motivo y la respuesta fija al paciente (tipo `escalamiento`) |
| `responder` | tipo y datos del tipo | Termina el turno |

El teléfono y la clínica nunca son argumentos: vienen del contexto del mensaje.

**Elección sobre una oferta anterior.** Cada oferta se guarda con su respuesta y con los slots en el orden mostrado (`oferta_slots`). La única autorización para una cita nueva es una selección posicional extraída del mensaje completo: números 1–8, «la 2», «opción 3», «el número 4» u ordinales primero/primera hasta octavo/octava, con artículo opcional. Se normalizan mayúsculas, tildes y espacios; se admite un punto o signo de exclamación final. No se aceptan frases compuestas, negaciones, condiciones, referencias por hora ni «ese» o «el último». El argumento `opcion` debe coincidir con lo extraído y no puede remapearse tras una consulta nueva. Si no se reconoce la selección, no se reserva: el turno termina con una oferta nueva, formada por los horarios de la oferta en espera que siguen libres según la agenda de ese momento, renumerados; si no queda ninguno, el modelo debe consultar de nuevo. Lo mismo ocurre si el modelo pide solo el horario con una oferta en espera. `atributos` solo busca y termina el turno con una nueva oferta: los candidatos se renumeran desde 1 y se persisten con esa respuesta, sin filtrar los ocupados para elegir otro por el paciente. La reserva requiere un mensaje posterior. Si la selección autorizada está ocupada, pasada o es inválida, el intento queda cerrado para agendar (`nueva_eleccion_requerida`); debe consultar de nuevo y ofrecer alternativas o informar que no hay horarios, incluyendo el aviso de la elección perdida. Se conservan las salidas por escalamiento y la recuperación de una cita propia sin LLM.

**Oferta en espera de selección.** Una posición solo autoriza una cita mientras el asistente espera la elección de esa oferta. El estado tiene dos valores, sin oferta o esperando la selección de una oferta concreta, y se deriva del `respuesta_tipo` de los turnos terminados, que es inmutable: `oferta_horarios` abre la espera con la oferta nueva; `respuesta_documental` y `sin_informacion` no la cambian; `pregunta_aclaratoria`, `sin_disponibilidad`, `confirmacion_cita`, `escalamiento` y `respaldo` la cierran. La condición está en `agendar_validar_oferta` y se repite dentro del `INSERT`, bajo el bloqueo de conversación; el worker la aplica antes para rechazar temprano. Por eso «el 5», contestado a la pregunta por la fecha, no puede reservar la opción 5 de una oferta anterior. No cubre un «el 5» enviado inmediatamente después de la oferta: ahí el asistente pidió un número y el mensaje es uno.

Una oferta puede autorizar como máximo una cita nueva. El consumo se deriva de la cita persistida y de la secuencia de su mensaje de origen, incluso antes de guardar la confirmación y aunque después se cancele. El contexto conserva la identidad, secuencia y slots de la última oferta del historial; nunca retrocede a una oferta anterior si la última fue consumida. Bajo el bloqueo de conversación, el INSERT revalida esa misma oferta como la última de la conversación, sin consumir, y comprueba posición, slot, clínica y futuro. La recuperación de una cita propia tiene prioridad. Para otra cita se necesita una oferta posterior y otra selección en otro mensaje. Se mantiene la ventana de historial existente.

Las etiquetas `F` y `H` valen solo dentro del intento: las de un mensaje anterior no existen en el siguiente. Dentro de un intento la numeración continúa entre consultas y nunca se reutiliza, de modo que una etiqueta nombra un solo dato; el slot elegido por posición se vuelve a validar en la transacción de agendamiento. El código guarda a qué identificador real corresponde cada una, y la traza registra los reales.

### 7.3 Fecha

El argumento de fecha acepta exactamente una de tres formas:

| Forma | Ejemplo del paciente | Quién calcula |
|---|---|---|
| `dias_desde_hoy` | "mañana" (1), "en tres días" (3) | El código |
| `dia_semana`, con `semana_siguiente` opcional | "el viernes"; "el viernes de la otra semana" | El código. Sin `semana_siguiente`: próxima ocurrencia sin contar hoy. Con `semana_siguiente`: ese día en la semana calendario siguiente (lunes a domingo). El nombre del día se acepta con tilde o mayúsculas ("miércoles") y se normaliza antes de validar |
| `dia_mes` (día y mes) | "el 15 de octubre" | El código elige el año: la próxima ocurrencia de esa fecha |

El modelo nunca escribe una fecha completa ni un año.

Dos relojes:

- **Hora del mensaje (`enviado_en`):** define "hoy" para interpretar la referencia, y nada más. No decide el orden de procesamiento: eso lo hace la secuencia que asigna el servidor. Así, quien envía no puede adelantarse en la cola declarando una hora antigua, y el historial muestra los mensajes en el orden en que el asistente realmente los vio.
- **Reloj real:** rechaza fechas y horarios pasados.

Orden en `consultar_disponibilidad`:

1. **Resolver la referencia del modelo** (`resolverReferencia`). Convierte la forma que eligió el modelo en un día del calendario. "Hoy" es el día que marca la hora del mensaje en la zona horaria de la clínica.
2. **Contrastarla con el mensaje** (`contrastarConMensaje`). Si el paciente escribió un día de la semana, manda lo que escribió (ver abajo).
3. **Validar la fecha resultante** (`validarFecha`) contra el reloj real: no puede ser pasada ni estar fuera del horizonte de la agenda. Con esa fecha se arman el rango de la consulta, la oferta y sus textos.

**Contraste con el día de la semana escrito.** El esquema acepta "el sábado" de tres formas, y en dos de ellas (`dia_mes` y `dias_desde_hoy`) el modelo cuenta él mismo. En la aceptación con el modelo real contó mal: "el sábado" llegó como miércoles 7; "el viernes", como jueves 8; "No, quiero el viernes", como el viernes de la semana siguiente.

Por eso el código lee el mensaje actual con una gramática deliberadamente conservadora. No es un parser de fechas:

- Un día de la semana cuenta solo detrás de "el", "este" o "próximo". "Con el doctor Domingo", "un sábado", "los sábados" o "el otro viernes" no cuentan, y la fecha queda como la pidió el modelo.
- "el", "este" y "próximo" significan lo mismo: la próxima ocurrencia, sin contar hoy. Solo una expresión explícita lleva a la semana calendario siguiente: "de la otra semana", "de la semana que viene", "de la siguiente semana", "de la próxima semana".
- También cuentan como fechas escritas "hoy", "mañana" (no "la mañana" ni "esta mañana", que son partes del día), "pasado mañana" y un día en número ("viernes 16", "el 16", "16 de octubre"). "A las 8" u "8:30" no cuentan.
- No interpreta negaciones ni mira mensajes anteriores.

| Mensaje del paciente | Qué decide el código |
|---|---|
| No nombra un día de la semana | Vale la fecha del modelo |
| Una sola fecha escrita | Vale la del paciente. Si el modelo pidió otra, se consulta la del mensaje y la traza guarda la del modelo en `fecha_modelo` |
| Varias fechas escritas ("¿mañana o el miércoles?", "el viernes 16") | Vale la del modelo si es una de ellas. Si no, la herramienta devuelve `fecha_no_coincide` y el modelo consulta una de las fechas escritas o pregunta |

Ejemplos (cubiertos por `tests/fechas.test.ts`):

- Escrito el lunes 5 de octubre: "el viernes" → viernes 9; "este viernes" → viernes 9; "el próximo viernes" → viernes 9; "el viernes de la otra semana" → viernes 16.
- Escrito el viernes 9 de octubre: "el viernes" → viernes 16; "este viernes" → viernes 16; "el próximo viernes" → viernes 16.

La franja `mañana` es antes de las 12:00 hora local; `tarde`, desde las 12:00.

Expresiones fuera de las tres formas ("a fin de mes", "en dos semanas"), o un "mejor otro día" sin decir cuál, no tienen salida calculada por el modelo: debe pedir una fecha concreta con `pregunta_aclaratoria`, sin elegirla ni probar varias fechas. Defensas adicionales: la herramienta devuelve la fecha que consultó, y el paciente ve la fecha explícita antes de confirmar.

### 7.4 Validación antes de ejecutar

1. **Forma**, con TypeBox. Sede y especialidad son listas cerradas generadas desde la base.
2. **Negocio**, contra la base de datos.

Validaciones de `agendar_cita`:

1. El mensaje completo del paciente es una selección posicional, `opcion` coincide con ella, y la oferta está en espera de selección y sin consumir.
2. El horario sigue siendo futuro según el reloj real.
3. No se superó el máximo de un agendamiento por mensaje.
4. Una sola transacción, con la hora tomada del reloj de la aplicación al empezarla y usada por todas sus sentencias. El contrato temporal es explícito: la cita se crea si el horario era futuro respecto a ese instante; no se promete que lo siga siendo en el momento exacto de confirmar, porque ninguna comprobación puede garantizar eso. La transacción: bloquea la conversación, verifica que el intento siga siendo el suyo, clasifica el horario para poder dar un error preciso, e inserta. La inserción se protege sola: en la misma sentencia exige que el horario sea de la clínica de la conversación y que siga siendo futuro, de modo que la validación y el efecto no ocurren en momentos distintos. Las dos restricciones únicas deciden el resto.

Resultado de la inserción. Se inserta sin `ON CONFLICT`, para que ningún conflicto quede oculto. Ante una violación de unicidad, el código no confía en cuál restricción reportó Postgres (si el reintento apunta al mismo horario de la cita propia, pueden violarse las dos): consulta si existe una cita con este `source_message_id`.

- Existe: es la cita propia de un intento anterior. Se devuelve la real.
- No existe: el horario lo tomó otro paciente. "Ocupado" vuelve al modelo.

### 7.5 Cierre del turno: tipos de `responder`

| Tipo | Envía el modelo | Escribe el texto | Verifica el código |
|---|---|---|---|
| `respuesta_documental` | Etiquetas de línea (máximo 4) | El código: el encabezado de la sección y las líneas elegidas, todo literal del documento | Líneas recuperadas en este intento |
| `oferta_horarios` | Etiquetas `H` | Plantilla con horas de la base | Horarios devueltos en este intento |
| `sin_disponibilidad` | Nada | Plantilla con la fecha consultada | Que la consulta de este intento saliera vacía |
| `confirmacion_cita` | Nada | Plantilla con datos de la cita | Que exista una cita de este mensaje |
| `pregunta_aclaratoria` | Datos faltantes | Plantilla por dato | Faltantes válidos: especialidad, sede, fecha, horario, intención |
| `sin_informacion` | Nada | Plantilla fija, con oferta de asesor | Que en este intento se haya buscado en el conocimiento. No se exige que la búsqueda saliera vacía: fragmentos parecidos pueden no contestar la pregunta |

Un tipo por turno. Si `responder` no pasa la verificación, el error vuelve al modelo y cuenta como iteración.

Tamaño de `respuesta_documental`: el máximo de 4 se refiere a las líneas que elige el modelo. El código agrega el encabezado de cada sección involucrada, así que el mensaje puede tener hasta 8 líneas. Como cada línea tiene un máximo de 500 caracteres en la base, la respuesta no puede superar unos 4.000 caracteres. El tope sale de la construcción, sin un camino extra de rechazo.

Un texto del modelo fuera de una llamada a `responder` es una violación del protocolo: nunca llega al paciente, se devuelve como error al modelo y cuenta como iteración. La única salida del ciclo es `responder` o `escalar_a_humano` aceptados por el código.

Límites aceptados:

- Un mensaje mixto recibe una sola respuesta por turno.
- **Nivel de garantía contra respuestas inventadas.** El modelo nunca escribe texto que llegue al paciente. En `respuesta_documental` elige qué líneas de los fragmentos recuperados responden la pregunta, y el código las envía literales. Garantía: todo dato de la clínica que recibe el paciente es texto exacto de sus documentos. No se garantiza la pertinencia: el modelo puede elegir una línea verdadera que no responde lo preguntado. Costos aceptados: la respuesta no se redacta como contestación directa (no dice "sí" o "no"; entrega la línea que lo contiene) y no sintetiza varias líneas en una frase. Requiere documentos escritos con un dato por línea, como los del seed.
- **Alternativas descartadas.** Respuesta redactada por el modelo con fuentes citadas: más natural, pero permite que el texto contradiga la fuente (decir "12 horas" citando una línea que dice "8"). Fragmento completo: seguro, pero responde con secciones enteras. Segundo modelo como juez: va en "qué haría distinto", junto con redacción generativa verificada.
- No hay herramienta para consultar una cita existente: "¿cuál es mi cita?" termina en `sin_informacion`.

### 7.6 Controles del ciclo

| Control | Valor | Evita |
|---|---|---|
| Iteraciones máximas | 5 | Ciclos sin fin |
| Tamaño de la entrada al modelo | Acotado por construcción y verificado antes de cada llamada | Costo y latencia sin tope |
| Agendamientos por mensaje | 1 | Citas dobles o inventadas |
| Tiempo por llamada al modelo | 20 s | Llamadas colgadas |
| Plazo total del intento | 60 s, con reloj monótono; cada operación recibe como límite el menor entre el suyo y lo que queda | Superar el candado de 120 s |
| Tokens de salida por llamada | Configurable | Costo y tamaño de respuesta sin tope |
| Llamadas en paralelo | No | Orden ambiguo |
| Reintentos del SDK | No | Multiplicarse con los del worker |
| Uso de herramienta | Obligatorio | Texto libre fuera de `responder` |
| Temperatura | Baja | Variabilidad |

### 7.7 RAG

- Los documentos del seed son Markdown: cada sección empieza con un encabezado `## ` y tiene un dato por línea, para permitir respuestas extractivas. La unidad de búsqueda es la sección; la unidad de respuesta es la línea. En producción, documentos arbitrarios pasarían antes por una etapa de normalización que los lleve a ese formato.
- Las líneas finales las elige el modelo, no un cálculo de similitud por línea. La garantía (texto literal) es la misma en ambos casos; lo que cambia es la pertinencia, y ahí el modelo distingue mejor entre líneas parecidas ("sede Norte: lunes a sábado" frente a "sede Sur: lunes a viernes") que una similitud de embeddings sobre frases cortas.
- Fragmentos por sección del documento, con el título antepuesto. Si una sección supera el tamaño máximo, se subdivide con solapamiento.
- Embeddings detrás de la interfaz `GeneradorEmbeddings`. Se guarda el modelo usado con cada fragmento.
- Búsqueda exacta por similitud coseno, 4 resultados, filtrada por clínica y por modelo. La aplicación la ejecuta en una sola sentencia junto con el título, la huella y las líneas de cada fragmento: una sentencia ve una única fotografía de la base, así que una reingestión simultánea no puede dejar un fragmento encontrado sin sus líneas. Al armar la respuesta se exige que existan todas las líneas elegidas; si el documento se reingirió entre tanto, el error vuelve al modelo y busca de nuevo.
- **Política de índice vectorial, por tamaño de la clínica más grande.** Lo que importa no es el total de fragmentos del sistema, sino cuántos tiene una sola clínica, porque toda búsqueda filtra por clínica. `benchmark_vectorial.py` mide la sentencia real con una clínica de cada tamaño (mediana y percentil 95, en el entorno de verificación): del orden de 2 ms con 200 fragmentos, 9 ms con 1.000, 40 ms con 5.000, 75 ms con 10.000 y 240 ms con 25.000. Los valores exactos de la última ejecución están en `benchmark_vectorial.txt`. El costo crece en línea recta con el tamaño de la clínica y no depende de las demás. Regla: la búsqueda exacta es la estrategia por defecto mientras cumpla el presupuesto de latencia y de CPU con la concurrencia real de producción. Unos 5.000 fragmentos por clínica es el punto de partida que sugiere esta medición, no una frontera fija: la medición es de una consulta a la vez, y con muchas búsquedas simultáneas sobre clínicas grandes el límite real lo pondrá la CPU de la base. El seed tiene decenas de fragmentos.
- **Por qué no HNSW por adelantado.** La medición de referencia sobre la clínica de 25.000 fragmentos confirma dos cosas: un índice aproximado es mucho más rápido (unos 3 ms) y no devuelve lo mismo que la búsqueda exacta. La cifra de coincidencia de esa prueba no estima lo que pasaría en producción, porque usa vectores aleatorios, y la consulta medida no es la de la aplicación: para que el planificador use un índice parcial hay que nombrar la clínica como constante. En este diseño un resultado perdido no produce una respuesta inventada, sino un "no tengo esa información" falso, así que un índice aproximado debe calibrarse contra la búsqueda exacta antes de adoptarse.
- **Decisión pendiente para producción: la unidad física del índice vectorial.** Un índice parcial por clínica no escala en administración. Cuando una clínica supere el presupuesto de la búsqueda exacta, hay que elegir cómo se separa físicamente su conocimiento (por ejemplo, particiones por clínica con un índice por partición, o una estructura aparte para clínicas grandes) y cómo se hace esa transición. El crecimiento desigual entre clínicas es un dato de ese diseño.
- **Contenido canónico.** Al ingerir un documento, primero se reconoce la estructura (secciones por encabezado) sobre el texto original y después se normaliza, una sola vez: Unicode en forma NFC, saltos de línea a `LF`, sin espacios al final de línea, sin líneas vacías. Ese contenido normalizado es la fuente de verdad: de él salen las líneas, los embeddings y la huella, y contra él comparan los tests de texto literal.
- **Encabezado en la respuesta.** El encabezado de la sección es una línea más del documento, así que enviarlo no rompe la garantía de texto literal. Se incluye porque una línea verdadera sin su contexto puede engañar: "lunes a viernes de 7:00 a 17:00" no dice de qué sede.
- **Largo máximo de línea: 500 caracteres.** Una línea más larga hace fallar la ingestión con un error claro, en lugar de cortarse sola: un corte automático a mitad de frase produciría unidades literales pero sin sentido. Con 4 líneas por respuesta, el mensaje al paciente queda acotado.
- **La traza es autosuficiente frente a una reingestión.** Reingerir borra el documento anterior, así que una traza vieja apuntaría a líneas que ya no existen. Por eso la traza de `buscar_conocimiento` y de `respuesta_documental` guarda, además de las identidades, el texto literal de las líneas mostradas y elegidas, el título y la huella del documento. La respuesta enviada queda también en Postgres. En producción, con auditoría más exigente, se versionarían los documentos en lugar de borrarlos.
- **Estado del conocimiento por clínica.** Se deriva de los fragmentos con una consulta, sin tabla de estado, y tiene cuatro valores. `listo`: todo está indexado con el modelo actual. `sin_indexar`: la clínica no tiene documentos. `desactualizado`: nada está indexado con el modelo actual. `parcial`: solo una parte lo está, que es lo que ocurre mientras se reingiere documento por documento. La regla al responder: lo que la búsqueda sí encuentra se puede entregar, porque es texto literal y vigente. Un resultado vacío solo se traduce en `sin_informacion` cuando el estado es `listo` o `sin_indexar`; en `parcial` o `desactualizado` un vacío no prueba que la información no exista, y el turno se escala con motivo `conocimiento_no_disponible`. Si el servicio de embeddings está caído, el intento se aborta y se reintenta.
- **Modelo de embeddings.** La búsqueda filtra por el modelo configurado. Al arrancar, si ninguna clínica tiene fragmentos de ese modelo, el worker no arranca; si solo algunas están desactualizadas, arranca y las informa como degradadas. Una versión explícita del índice, para reindexar sin interrupción, queda para producción.
- **Identidad de una línea:** documento y número de línea. Las etiquetas `F1.3` que ve el modelo son alias de esa identidad dentro del intento. Si dos fragmentos solapados contienen la misma línea, es la misma línea.
- **Armado de la respuesta.** Una sola consulta recibe las identidades de las líneas elegidas y sus encabezados, elimina las repetidas, filtra por la clínica y las devuelve ordenadas: primero por documento, en el orden en que se recuperaron, y dentro de cada documento por número de línea. Ni el orden ni la deduplicación dependen del código. El modelo elige qué líneas, no en qué orden se leen.
- Umbral mínimo de similitud: el valor actual (0,3) es provisional. Está probado solo de forma mecánica, con embeddings deterministas de prueba; no está calibrado. Calibrarlo exige embeddings reales y un conjunto de preguntas dentro y fuera del conocimiento.
- **Ingestión con un solo escritor por documento.** Los embeddings se calculan antes de abrir la transacción, para no retener bloqueos durante una llamada externa. Por eso, si dos procesos ingieren a la vez versiones distintas del mismo documento, gana el último en confirmar y la otra versión se pierde sin aviso. En esta versión la ingestión la ejecuta un solo proceso (el de preparación). Si en producción se paraleliza, hay que comparar la huella dentro de la transacción antes de reemplazar, o serializar por clínica y título.
- El seed es idempotente: no recalcula un documento si no cambió nada de lo que determina sus fragmentos: título, contenido, modelo de embeddings y versión del fragmentador (tamaño máximo, solapamiento, algoritmo). Si cambia el modelo o el fragmentador, recalcula todo. Necesita la API key.
- La dimensión del vector es parte de la estructura de la tabla. Cambiar a un modelo de otra dimensión exige una migración de la columna además de recalcular.

## 8. Qué pasa cuando algo falla

Tres categorías:

- **Validación o negocio:** vuelve al modelo como resultado de la herramienta.
- **Infraestructura:** aborta el intento; el worker reintenta con espera.
- **Fallo lógico del ciclo:** se escala.

| Fallo | Categoría | Resultado |
|---|---|---|
| Fecha pasada, sede inexistente, etiqueta desconocida | Validación | El modelo corrige o pregunta |
| Horario ocupado | Negocio | En ese turno ya no se reserva: el modelo consulta de nuevo y ofrece otros; el paciente elige en otro mensaje |
| Consulta de disponibilidad vacía | Negocio (no es fallo) | `sin_disponibilidad` |
| Búsqueda sin fragmentos sobre el umbral | Negocio (no es fallo) | `sin_informacion` o escalar |
| `responder` no pasa la verificación | Validación | El modelo corrige; cuenta como iteración |
| Iteraciones o presupuesto agotados | Lógico | Escala con ese motivo |
| LLM con timeout, 429 o 5xx | Infraestructura | Reintento |
| Servicio de embeddings caído | Infraestructura | Reintento |
| Postgres caído durante el ciclo | Infraestructura | Reintento |
| Postgres caído en el webhook | Infraestructura | 503; el emisor reintenta |
| Mongo caído | Auditoría, no negocio | El turno cierra normal; las trazas esperan en Postgres. La API muestra la conversación completa, con las trazas leídas del outbox |
| El worker muere | Infraestructura | El candado vence; otro reclama el huérfano |
| Cita creada y el worker muere antes del cierre | Infraestructura | Recuperación sin LLM |
| El candado vence con el worker vivo | Carrera | El intento tardío no puede crear cita ni cerrar |
| Tres intentos fallidos | Agotamiento | `fallido`, `escalada`, respuesta de respaldo |

## 9. Dónde está la garantía final

| Regla | Barrera |
|---|---|
| Un mensaje se recibe una vez | Clave primaria `message_id` |
| Un teléfono se procesa en orden | Candado de conversación y menor secuencia primero; la secuencia la asigna el servidor |
| No hay deadlocks entre transacciones | Orden global de bloqueos: conversación, mensaje, cita |
| Una cita no queda en la conversación equivocada | La conversación se deriva del mensaje; clave foránea compuesta en la base |
| Un worker tardío no altera nada | Cierre y cita condicionados al intento |
| Un horario tiene una sola cita activa | Único parcial sobre `slot_id` |
| Un mensaje crea máximo una cita | `UNIQUE(source_message_id)` y contador por intento |
| La agenda no tiene horarios duplicados | `UNIQUE(profesional_id, inicia_en)` |
| El modelo no inventa horarios | Etiquetas `H` del intento; texto por plantilla |
| La cita es del horario que el paciente eligió | La oferta se guarda con su respuesta; la posición se extrae del mensaje completo y debe coincidir con `opcion`; la oferta debe estar en espera de selección y sin usar, y eso se revalida en la misma sentencia que inserta la cita |
| El modelo no calcula fechas | Tres formas de fecha resueltas en código |
| El texto documental enviado no puede diferir del documento | El texto vive en una sola tabla (`documento_lineas`); los fragmentos solo apuntan a líneas y las líneas no se editan |
| Un mensaje no cambia después de recibido | Disparador en la base: identidad, orden, texto y horas nunca cambian; una vez terminado no cambia nada, incluida la respuesta que recibió el paciente |
| El conocimiento no se edita en sitio | Disparadores: documentos, líneas y fragmentos son inmutables y una línea no se borra sola. Solo se reingiere el documento completo |
| La pregunta no se compara con vectores de otro modelo | La búsqueda filtra por modelo de embeddings; el worker no arranca si hay fragmentos de otro modelo |
| Un profesional no se agenda dos veces a la misma hora | Único parcial por horario y exclusión de horarios solapados |
| La trazabilidad se ve aunque Mongo falle | El detalle une Mongo con el outbox |
| El modelo no escribe lo que recibe el paciente | Todos los tipos de `responder` usan plantillas o líneas literales de los documentos |
| No hay respuesta informativa sin respaldo | `respuesta_documental` solo acepta líneas recuperadas en el intento |
| No se cruzan datos entre clínicas | Escrituras: la base lo impone con claves compuestas en toda la cadena (profesional, horario, cita, fragmento). Lecturas: todas las consultas del asistente que leen datos de una clínica filtran por `clinica_id` del contexto de forma explícita: disponibilidad, bandeja, búsqueda, líneas de fragmento y armado de respuesta. Requisito del diseño de producción: seguridad a nivel de fila, para que las lecturas tampoco dependan del código |
| El paciente solo actúa sobre sí mismo | Teléfono desde el webhook, nunca del modelo |
| Ningún intento borra evidencia | En Mongo, la traza por `message_id` e intento es de solo inserción. El outbox de Postgres es transporte: su fila se borra cuando Mongo confirma |
| Ninguna traza de un intento cerrado se pierde | Outbox en la misma transacción del cierre; se conserva hasta su publicación o revisión. Un proceso que muere de golpe a mitad de un intento deja solo la evidencia de que ocurrió |
| El estado de una conversación no baja | Disparador en la base, además de la regla en el código |
| Una falla de auditoría no afecta al paciente | Mongo fuera del camino crítico |
| Una caída no se convierte en respuesta falsa | Errores de infraestructura abortan el intento |
| Todo mensaje termina con respuesta | Máximo de intentos; todo cierre depende solo de Postgres |
| El costo tiene tope | Iteraciones, tokens de salida por llamada, turnos de contexto, largo del mensaje, mensajes por minuto |

## 10. API

| Endpoint | Uso |
|---|---|
| `POST /webhooks/messages` | Recibe mensajes |
| `GET /api/conversaciones?estado=` | Bandeja con filtro |
| `GET /api/conversaciones/:id` | Detalle: mensajes y respuestas desde Postgres; trazas de cada intento desde Mongo, unidas con las que aún están en el outbox (pendientes o en revisión). La trazabilidad se ve aunque Mongo esté caído, y aparece junto con la respuesta, sin retraso |
| `GET /health/live` | El proceso está vivo |
| `GET /health/ready` | Listo para atender: depende solo de Postgres. Informa a Mongo como `ok` o `degradado`, sin afectar el resultado |

Mongo caído no debe hacer que un orquestador reinicie o saque de servicio la API: sería contradecir que está fuera del camino crítico.

Regla de lectura de trazas, por clave (`message_id`, intento):

- Está en Mongo: se usa la de Mongo.
- Aún no llegó a Mongo, o Mongo está caído, o quedó en revisión: se usa la del outbox.
- Está en los dos lados (Mongo confirmó y el relevo murió antes de borrar la fila): gana Mongo y se muestra una sola vez.

El frontend consulta el detalle cada 1,5 s. Un mensaje `pendiente` o `procesando` se muestra como "el asistente está respondiendo".

El texto del asistente se muestra siempre como texto plano.

## 11. Tests

Sin LLM real: modelo falso con guion, embeddings falsos deterministas, reloj fijo.

| Test | Demuestra |
|---|---|
| El mismo `message_id` dos veces | Se procesa una vez |
| Dos workers, dos mensajes del mismo teléfono | Orden secuencial |
| Dos pacientes piden el mismo horario a la vez | Solo uno lo obtiene |
| Mensaje a las 03:40 UTC del 6 de octubre con `dias_desde_hoy: 1` | Se consulta el 6, no el 7 |
| Cita creada, caída antes del cierre, reintento | El modelo no se llama; una sola cita |
| Dos agendamientos en un turno | Una cita y un error explícito |
| Etiqueta `H` que no se entregó | Rechazada |
| Fecha pasada, sede inexistente | El error vuelve al modelo |
| `respuesta_documental` con una línea no recuperada | Rechazada |
| `respuesta_documental` válida | Cada línea del texto enviado es una línea literal del contenido canónico, incluido el encabezado |
| Documento con una línea de más de 500 caracteres | La ingestión lo rechaza con un error que indica la línea |
| Fragmento recuperado que contiene una frase con forma de orden | Entra al prompt como dato delimitado, nunca en el mensaje de sistema |
| El modelo elige `F1.8`, `F1.3` y una línea repetida en dos fragmentos | Sale en orden del documento y sin repetir |
| Documento con `CRLF`, espacios finales y líneas vacías | Se normaliza al ingerir; las líneas quedan limpias |
| Historial con un mensaje que intenta dar órdenes | Va en el rol del paciente y delimitado, nunca en el mensaje de sistema |
| Embeddings caídos durante la búsqueda | Intento abortado, no "sin información" |
| El modelo falla tres veces | `fallido`, `escalada`, respaldo |
| Iteraciones agotadas | Escala sin reintentar |
| Cierre de un intento tardío | No afecta filas |
| Mensaje a una conversación escalada | Respaldo sin LLM |
| El estado no baja de rango | `cita_agendada` sobrevive a una pregunta posterior |
| Un horario cancelado | Se puede volver a reservar |
| Mongo caído durante un turno | El turno cierra, la respuesta existe y la traza llega a Mongo al volver |
| Reintento que apunta al mismo horario de la cita propia | Se reconoce como propia, no como "ocupado" |
| "El 15 de octubre" y "el viernes de la otra semana" | El código resuelve la fecha; el modelo no escribe ninguna |
| Cambio de modelo de embeddings, de título o de versión del fragmentador | El seed recalcula |
| Mongo acepta la traza y el relevo muere antes de borrar la fila | Al volver no hay duplicado en Mongo |
| Mongo rechaza una traza 10 veces | Pasa a `requiere_revision` con su error; las demás siguen |
| Mongo caído | `/health/ready` sigue listo y la API responde |
| Duplicado de un mensaje con el teléfono en su límite | 202, no 429 |
| Llamada al modelo | El adaptador envía el límite de tokens de salida |
| Texto del modelo fuera de `responder` | No llega al paciente; cuenta como iteración |
| "El primero" después de que otro paciente tomó ese horario | No se agenda el que ahora ocupa esa posición; se avisa y se ofrece de nuevo |
| Oferta, pregunta documental y después "opción 2" | La oferta sigue en espera y se reserva su opción 2 |
| Oferta, "mejor otro día", el asistente pide la fecha y el paciente contesta "el 5" | No se reserva la opción 5 de la oferta anterior |
| "El último" con un horario de la oferta ya tomado por otro paciente | Oferta nueva solo con los que siguen libres, renumerada; la elección siguiente se resuelve contra ella |
| Una reserva y después otra posición de la misma oferta | La oferta ya se usó: no crea otra cita, ni aunque la primera se cancele |
| `dia_semana` escrito como "miércoles" o "Sábado" | Se consulta ese día; no se rechaza |

## 12. Reglas de implementación

- **Orden de bloqueos en un solo lugar.** Postgres no puede verificar el orden conversación, mensaje, cita. Para que no dependa de la disciplina de quien programe, toda transacción que toque una conversación y un mensaje pasa por una única función del repositorio que toma el bloqueo de la conversación primero. Una operación futura (cancelar, reprogramar) no puede saltarse el orden sin saltarse esa función.
- **Aislamiento en un solo lugar.** `READ COMMITTED` es obligatorio para los protocolos del asistente, y lo declara de forma explícita la función que ejecuta sus sentencias (`enTransaccion`), sin heredarlo del servidor y sin aceptar otro nivel. No es una ley para todo el sistema: una operación futura que necesite otro nivel (un reporte, una conciliación) abre su transacción por otro camino, explícito, que no puede ejecutar estas sentencias. La única excepción actual es la migración del esquema, que no usa ningún protocolo. Es parte de la corrección: varios protocolos bloquean y después leen en otra sentencia, contando con que esa lectura ve lo confirmado durante la espera. En `REPEATABLE READ` se midió el tope por clínica roto (19, 10 y 20 conversaciones con tope 2) y errores de serialización en el reclamo. Los demás protocolos fallarían con un error visible; el tope fallaría en silencio, así que la sentencia que toma el turno de la clínica comprueba el nivel y el worker aborta si no es el correcto. Probado.
- **Espera del worker.** Sin trabajo, el worker espera un intervalo con variación aleatoria antes de volver a reclamar. Un reclamo rechazado por tope de clínica se reintenta de inmediato, porque la siguiente elección ya descarta esa clínica; tras tres rechazos seguidos, el worker espera igual que si no hubiera trabajo. Así una clínica llena no se convierte en un ciclo sin pausa. "No hay trabajo" y "hay trabajo pero su clínica está llena" producen la misma espera en el worker; donde sí deben distinguirse es en la métrica que decide cuántos workers hay: debe contar solo los mensajes que un worker nuevo podría tomar, no los que esperan cupo de su clínica. Queda como requisito del diseño de escalado. El intervalo concreto se fija con el código.
- **Tamaño de la traza.** El documento de traza tiene un máximo de 64 KB, impuesto en dos niveles: el código acota lo que guarda de cada resultado de herramienta, y la tabla del outbox rechaza con un `CHECK` cualquier documento mayor. Evita que un resultado grande llene el outbox o choque con el límite de documento de Mongo.
- **Niveles de verificación.** Base de datos: `verificar.py` (ver `resultado.txt`). Aplicación (ciclo, herramientas, fechas, plantillas): `npm test`, con modelo y embeddings falsos. Integraciones: pgvector real en el verificador, MongoDB real en `tests/mongo.test.ts`, y el adaptador de OpenAI sin red en `tests/openai.test.ts`. Sistema completo con el modelo real: conversaciones de prueba hechas a mano, no un conjunto de evaluación. El estado de cada nivel está en el README, en "Qué está probado y qué no".

- **Qué reloj valida el tiempo.** Todas las sentencias reciben la hora del reloj de la aplicación, tomada al empezar cada transacción. Alternativa considerada: que la última comprobación de "horario futuro" use el reloj de Postgres, para que la autoridad temporal sea la misma que guarda la cita. Se descartó porque rompe los tests con reloj fijo: el caso del enunciado (6 de octubre a las 03:40 UTC) no podría agendar una vez pasada esa fecha real. El riesgo que cubriría es un desfase de reloj entre servidores, que en AWS es de milisegundos frente a transacciones de segundos. Si se quisiera esa garantía en producción, la forma compatible con los tests es una función de base que devuelva su propio reloj salvo que una prueba lo fije.
- **Relevo con la transacción abierta: decisión de alcance.** Mientras la aplicación espera a Mongo, la sesión de Postgres está inactiva dentro de una transacción; por eso `idle_in_transaction_session_timeout` sí la corta y libera la fila (probado en `verificar.py`). El límite principal sigue siendo el del driver de Mongo, y el corte de Postgres no cancela la llamada a Mongo en curso: el relevo descarta esa conexión y sigue con otra. Es la opción simple para este volumen, no la más robusta posible: con más caudal se pasaría a reclamar, confirmar, escribir en Mongo y finalizar en otra transacción.
- **Un fragmento no cruza secciones.** La base no lo impone: lo garantiza el fragmentador y lo comprueban sus tests. Los fragmentos son inmutables, así que lo que el fragmentador genera bien no se degrada después.

- **Configuración global y por clínica.** En esta versión, el modelo de lenguaje y el de embeddings son configuración global del despliegue; por clínica solo va la zona horaria. El diseño de producción debe decir qué se configura por clínica (modelo, reglas del agente, estado del conocimiento) y qué es global.

## 13. Pendiente fuera de este documento

Los tres primeros puntos ya tienen su lugar: el diseño en AWS está en `AWS.md`; el modelo y el costo por conversación, en `DECISIONS.md` y `AWS.md`; el contenido del seed, en `conocimiento/` y `src/preparar.ts`. Se conservan como estaban al cerrar este documento.

- Diseño en AWS, escalabilidad, multi-tenant en producción y costo mensual. Incluye las alertas del outbox: edad de la traza más antigua, tamaño de la tabla y uso de disco, para que una caída larga de Mongo no termine llenando Postgres. También roles de base separados (ingestión solo inserta, worker solo actualiza campos operativos). Para multi-tenant: seguridad a nivel de fila en Postgres y claves foráneas compuestas con `clinica_id`, para que la base impida referencias entre clínicas. En esta versión, con una sola clínica, la separación la aplica el código.
- Modelo concreto de OpenAI, dimensión del vector y costo por conversación, verificados contra la documentación actual.
- Contenido del seed: documentos, sedes, especialidades y dos semanas de agenda.
- Para "qué haría distinto": outbox para envíos reales, varios bloques por respuesta, juez de respuestas, identificador de operación para varias citas por mensaje, devolver una conversación al asistente, límites por paciente.
