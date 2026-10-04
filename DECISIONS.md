# Decisiones

Qué decidí, por qué, qué descarté y qué costo acepté. El detalle técnico está en [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md), [`docs/ADR-001-cola-en-produccion.md`](docs/ADR-001-cola-en-produccion.md) y [`docs/AWS.md`](docs/AWS.md); aquí está el razonamiento.

> **Nota para Michael antes de entregar.** Este documento es un borrador redactado con IA a partir de las decisiones que tomamos. Las secciones 6 y 7 hablan en tu nombre: léelas, corrige lo que no sea cierto para ti y completa lo marcado como `[POR COMPLETAR]`. Borra esta nota.

## 1. Lo que hay y lo que no

Construí un asistente que responde preguntas con base en los documentos de una clínica y agenda citas, con todo el recorrido: webhook, cola, worker, herramientas, trazabilidad, interfaz y datos de ejemplo.

Lo que no hay, dicho de entrada:

- No está desplegado en AWS. El diseño está en `docs/AWS.md`.
- La respuesta se guarda y se muestra; no se envía a WhatsApp.
- El webhook y la API no tienen autenticación.
- El modelo de lenguaje definitivo no está elegido (sección 5).
- `[POR COMPLETAR: qué ejecutaste tú con tu clave y qué resultado dio — docker compose, conversaciones reales, test de Mongo]`

## 2. La idea que ordena todo lo demás

**El código responde por el resultado, no el modelo.** El modelo interpreta lo que dice el paciente y elige una herramienta. El código valida, calcula las fechas, ejecuta contra la base y escribe el texto que recibe el paciente.

Lo elegí porque la prueba pide confiabilidad, y un modelo de lenguaje no la da por sí solo: no sabe qué día es, puede inventar un horario y puede redactar una política que no existe. Cada regla crítica tiene una barrera en código o en la base de datos, no una instrucción en el prompt.

## 3. Decisiones

### 3.1 El modelo nunca escribe lo que recibe el paciente

Además de las cuatro herramientas pedidas hay una quinta, `responder`. El modelo elige un tipo de respuesta y entrega etiquetas (qué líneas de un documento, qué horarios); el texto sale de una plantilla o es una línea literal del documento.

- **Por qué.** Garantiza por construcción que todo dato que recibe el paciente sale de una plantilla o de un texto almacenado, en lugar de depender de que el modelo obedezca una instrucción de no inventar. Hay otras formas de acercarse a eso (un segundo modelo que verifique, salida estructurada con comprobación posterior); esta es la más simple de probar.
- **Descarté** que el modelo redactara citando sus fuentes. Es más natural, pero permite que el texto contradiga la fuente que cita ("12 horas" citando una línea que dice "8").
- **Costo aceptado.** Las respuestas son menos naturales: el paciente recibe la línea que contiene el dato, no un "sí" o un "no". Lo que no se garantiza es la pertinencia: el modelo puede elegir una línea verdadera que no contesta la pregunta.

### 3.2 Qué va en PostgreSQL y qué en MongoDB

PostgreSQL dice qué es cierto ahora: conversaciones, mensajes, agenda, citas, conocimiento y la respuesta que recibió el paciente. Necesita transacciones y restricciones: un horario con una sola cita activa, una cita por mensaje, un estado que solo sube.

MongoDB dice qué ocurrió y cuánto costó: una traza por intento, con modelo, tokens, latencia y cada herramienta con sus argumentos y resultados. Es un documento anidado de forma variable, que solo se inserta y crece rápido.

- **Por qué así.** Ninguna operación necesita que Mongo responda para ser correcta. Si Mongo se cae, el paciente no lo nota.
- **Lo digo sin adornos:** con este volumen, una columna JSON en PostgreSQL bastaría. Mongo es un requisito de la prueba y le di el papel donde mejor encaja.

### 3.3 Consistencia entre las dos bases

No existe una transacción que abarque PostgreSQL y Mongo. La traza se guarda en una tabla de PostgreSQL dentro de la misma transacción que cierra el turno, y un proceso aparte la copia a Mongo (patrón outbox).

- **Por qué.** El cierre es atómico: no puede haber respuesta sin traza ni al revés. Si el proceso muere después de escribir en Mongo y antes de borrar la fila, la reenvía y un índice único en Mongo la absorbe.
- **Descarté** escribir en las dos bases desde el worker: un fallo en medio deja una respuesta sin traza, o hace depender al paciente de Mongo.
- **Costo aceptado.** La traza llega a Mongo hasta un segundo después. La interfaz la muestra de inmediato porque también lee de PostgreSQL. Y el proceso que copia mantiene una transacción abierta mientras espera a Mongo (máximo 3 s); con más caudal lo cambiaría por reclamar, confirmar y luego escribir.

### 3.4 La cola es una tabla de PostgreSQL

El mensaje guardado por el webhook es a la vez el registro de idempotencia y el trabajo pendiente. El worker lo reclama con un candado por conversación que vence a los 120 s y un número de intento.

- **Por qué.** Guardar el mensaje y encolarlo es una sola escritura: no puede quedar un mensaje recibido sin encolar. El orden por paciente, los reintentos y la protección contra un worker que se demoró viven en la misma transacción que el estado.
- **Descarté SQS FIFO** para esto. No reemplaza nada de lo anterior: seguiría necesitando el candado, el número de intento y la idempotencia en PostgreSQL, y añadiría un componente. A 20.000 mensajes al día, reclamar un mensaje cuesta menos de medio milisegundo.
- **Costo aceptado.** La base de datos hace más trabajo y hay que vigilar la tabla. Lo reabriría si la base se volviera el cuello de botella.
- SQS sí aparece en el diseño de producción, para enviar las respuestas a WhatsApp: ahí solo transporta algo que ya es cierto en PostgreSQL.

### 3.5 Idempotencia y orden

- El `message_id` es la clave primaria: un mensaje repetido no crea nada. Si llega el mismo identificador con otro contenido, respondo 409 en lugar de fingir que es un duplicado.
- El orden por paciente lo da un número de secuencia que asigna el servidor, no la hora que declara el mensaje. Quien envía no puede adelantarse en la cola declarando una hora antigua.

### 3.6 Un horario no se agenda dos veces

Tres barreras en la base, no en el código:

- Un índice único parcial: un horario tiene como máximo una cita activa.
- `UNIQUE(source_message_id)`: un mensaje crea como máximo una cita, aunque se reintente.
- La inserción exige en la misma sentencia que el horario sea futuro y de la clínica de la conversación.

Si un worker crea la cita y muere antes de responder, el reintento encuentra la cita y la confirma sin llamar al modelo. Probado con dos pacientes pidiendo el mismo horario a la vez, y con 20 conexiones simultáneas en el verificador de la base.

### 3.7 Fechas

El modelo nunca escribe una fecha. Dice a qué se refiere el paciente ("días desde hoy", "día de la semana", "día y mes") y el código calcula el día en la zona horaria de la clínica.

El caso de la prueba es un test: un mensaje a las 03:40 UTC del 6 de octubre es, en Cali, el 5 a las 10:40 p. m., y "mañana" es el 6. La hora del mensaje define "hoy"; el reloj del servidor decide si la fecha ya pasó.

- **Costo aceptado.** Expresiones como "a fin de mes" no tienen salida: el asistente pide una fecha concreta.

### 3.8 Conocimiento (RAG) y base vectorial

Uso pgvector dentro del mismo PostgreSQL, con búsqueda exacta.

- **Por qué pgvector.** La búsqueda se filtra por clínica en la misma consulta, con las mismas garantías que el resto de los datos, y no hay otra base que sincronizar.
- **Por qué búsqueda exacta y no un índice aproximado.** Medí la consulta: 2 ms con 200 fragmentos en una clínica, 40 ms con 5.000. Un índice aproximado puede perder un fragmento relevante, y aquí eso aumenta el riesgo de un "no tengo esa información" falso. Con el tamaño actual la búsqueda exacta cumple la latencia y evita ese costo.
- **El texto vive en un solo lugar,** línea por línea. Los fragmentos que se buscan no guardan texto: apuntan a un rango de líneas. Lo que recibe el paciente no puede diferir del documento.
- **"No tengo esa información" exige haber buscado** en ese mismo turno.
- **Sin calibrar:** el umbral de similitud (0,3) es provisional. Solo está probado con embeddings de prueba.
- **Límite conocido:** la ingestión supone un solo proceso por documento. Dos a la vez sobre el mismo documento pierden una versión.

### 3.9 Cuando el modelo falla

Separé tres clases de fallo, porque cada una pide algo distinto:

| Clase | Ejemplo | Qué hace el sistema |
|---|---|---|
| Validación o negocio | Sede inexistente, horario ocupado | Vuelve al modelo, que corrige o pregunta |
| Infraestructura | El proveedor no responde, la base se cae | Aborta el intento y reintenta con espera |
| Lógico | Cinco iteraciones sin terminar, plazo agotado | Reintentar daría lo mismo: pasa a un asesor |

Tras tres intentos fallidos, el paciente recibe una respuesta fija y la conversación pasa a un asesor. Una caída nunca se convierte en una respuesta falsa: si la búsqueda de conocimiento falla, el intento se aborta; no se responde "no tengo esa información".

- **Falta:** un interruptor para errores de configuración (clave inválida). Hoy cada conversación paga sus tres intentos antes de escalar. Es lo primero que agregaría.

### 3.10 Seguridad del asistente

Recorrí las diez categorías del OWASP Top 10 para aplicaciones con LLM (edición 2025). No es una auditoría: es qué hay y qué falta en cada una.

| Riesgo | Qué hay | Qué falta |
|---|---|---|
| LLM01 Inyección de instrucciones | El texto del paciente va en su rol y delimitado; los documentos llegan como resultado de herramienta. La defensa real es que el modelo solo actúa por herramientas validadas y no redacta la salida | — |
| LLM02 Divulgación de información sensible | El teléfono y la clínica no entran al prompt; el conocimiento se filtra por clínica | Las trazas guardan el texto del paciente: falta definir retención y control de acceso |
| LLM03 Cadena de suministro | Pocas dependencias, con versiones fijadas; `npm audit` sin vulnerabilidades conocidas al entregar. El modelo de lenguaje y el de embeddings se nombran en la configuración, y el modelo que respondió queda en cada traza | Análisis automático de dependencias e imágenes en cada cambio; y repetir la evaluación de conversaciones antes de cambiar de modelo o de versión |
| LLM04 Envenenamiento de datos | No hay entrenamiento. El conocimiento solo entra por la ingestión, y los documentos no se editan en sitio | Un rol de base exclusivo para la ingestión (diseñado, no implementado) y revisión de quién puede cargar documentos |
| LLM05 Manejo inseguro de la salida | La salida del modelo nunca llega a SQL (todo son parámetros) ni al paciente; los argumentos se validan con esquema; la interfaz muestra texto plano | — |
| LLM06 Agencia excesiva | Cinco herramientas, una cita por mensaje, sin herramienta para cancelar ni modificar; la identidad viene del webhook, nunca del modelo | — |
| LLM07 Filtración del prompt de sistema | El prompt no contiene secretos ni credenciales: filtrarlo solo revela las reglas. Además el modelo no puede emitir texto libre | — |
| LLM08 Debilidades de vectores y embeddings | La búsqueda filtra por clínica y por modelo de embeddings; el texto vive en una sola tabla | Seguridad a nivel de fila, para que el filtro no dependa de cada consulta |
| LLM09 Desinformación | Respuestas por plantilla o líneas literales; "no tengo esa información" exige haber buscado | La pertinencia no está garantizada: el modelo puede elegir una línea verdadera que no contesta |
| LLM10 Consumo sin límite | Iteraciones, plazo, tokens de salida, tamaño de entrada, mensajes por minuto por teléfono, tope por clínica | Cuota diaria por clínica |

Lo que falta para producción: verificar la firma del webhook, autenticar al coordinador y seguridad a nivel de fila en la base.

### 3.11 Índices

Cada uno existe por una consulta concreta:

| Índice | Para qué |
|---|---|
| Conversaciones por clínica, estado y última actividad | La bandeja con filtro |
| Dos índices parciales sobre mensajes sin terminar | La cola. Solo contienen lo pendiente, así que no crecen con el historial |
| Mensajes por conversación y hora de recepción | El límite por teléfono |
| Único parcial en citas por horario, donde la cita está activa | Impedir la doble reserva |
| Único por profesional y hora, y exclusión de horarios solapados | Una agenda coherente |
| Fragmentos por clínica y modelo de embeddings | Acotar la búsqueda vectorial a una clínica |
| En Mongo: único por mensaje e intento; y por clínica, conversación y fecha | Entrega repetida sin duplicados; el detalle de una conversación |

El índice de la cola lo decidí midiendo: la primera versión tardaba de 75 a 140 ms con atraso, y la actual menos de medio milisegundo.

### 3.12 Stack

- **TypeScript con Fastify y TypeBox.** Elegí TypeBox sobre Zod porque su esquema ya es JSON Schema: el mismo objeto valida en el servidor y se le envía al modelo como definición de la herramienta. No hay dos definiciones que puedan divergir.
- **Sin ORM.** El SQL está en archivos, con nombre, y el código lo carga de ahí. El verificador de la base ejecuta esos mismos archivos: lo que se probó es lo que corre.
- **Sin LangChain.** El ciclo de herramientas ocupa poco más de cien líneas. Prefiero poder explicar cada una.
- **El proveedor de IA está detrás de una interfaz.** Los tests usan un modelo falso con guion; cambiar de proveedor es escribir un archivo.

### 3.13 AWS

Resumen; el detalle y los precios están en `docs/AWS.md`.

| Tema | Decisión | Por qué |
|---|---|---|
| Base de datos | RDS PostgreSQL, instancia Multi-AZ | El sistema ya tolera los 60 a 120 s de conmutación sin perder trabajo confirmado en PostgreSQL; los webhooks que llegan durante la caída dependen del reintento del proveedor. Aurora y el clúster Multi-AZ cuestan unos 140 USD más al mes por algo que no necesito |
| Cómputo | ECS Fargate | El worker es un ciclo largo con conexiones abiertas. Lambda no encaja; Kubernetes sobra |
| MongoDB | Atlas M10 | Es MongoDB real y cuesta menos que dos instancias de DocumentDB. A cambio, hay un segundo proveedor, con su factura y su red |
| Multi-tenant | Una base compartida con `clinica_id` | 50 bases serían 50 veces el costo fijo y 50 migraciones por cambio |
| Región | `us-east-1` | Precio y cercanía esperada al proveedor del modelo. La latencia desde Colombia no está medida |

La regla que seguí: la complejidad debe ser proporcional al problema. A 20.000 mensajes al día, casi todas las decisiones eligen la opción más simple que cumple.

## 4. Costo

Estimación para 50 clínicas y 600.000 mensajes al mes: entre 690 y 1.030 USD mensuales (14 a 21 USD por clínica). AWS son unos 444, Atlas 58 y el modelo entre 190 y 530.

**Una conversación típica** (4 mensajes del paciente, 9 llamadas al modelo, unos 22.000 tokens de entrada y 400 de salida) cuesta entre 0,0013 y 0,0035 USD, según el modelo y cuánto se aproveche la caché de entrada. Son precios del nivel de procesamiento estándar.

Qué tan firmes son estas cifras: los precios se consultaron el 4 de octubre de 2026; los tokens salen del tamaño medido del prompt con una conversión aproximada, no de llamadas reales; la duración del turno y la forma del pico son supuestos.

La infraestructura es casi toda costo fijo. El modelo es el costo que crece con el uso.

## 5. El modelo de lenguaje

Usé OpenAI. Los candidatos iniciales son `gpt-4o-mini`, que es el valor por defecto y el que ya acepta los parámetros del adaptador, y `gpt-6-luna`, por su precio actual.

No lo doy por decidido. Elegir por precio sería elegir a ciegas: lo que importa aquí es que el modelo escoja bien la herramienta y las líneas, en español. La forma correcta es un conjunto de 30 a 50 conversaciones de prueba (preguntas, agendamientos, fechas relativas, horario ocupado, intentos de inyección, escalamientos), correrlo con los dos y quedarse con el más barato que no falle.

`[POR COMPLETAR: con qué modelo lo probaste y qué observaste]`

## 6. Uso de IA

Usé IA durante todo el proyecto, y creo que lo relevante es cómo.

**El método.** Trabajé con dos asistentes. Uno diseñaba y construía; el otro revisaba cada entrega buscando fallos. Yo llevaba las objeciones de uno al otro con una regla: nadie cede por llegar a un acuerdo, solo ante un argumento o una medición. Primero cerramos la arquitectura y después se escribió el código.

**Lo que no acepté sin prueba.** Cuando una afirmación sobre concurrencia o rendimiento importaba, pedí que se ejecutara. De ahí salió un verificador de la base de datos (140 comprobaciones contra PostgreSQL real, con carreras de 20 conexiones; la salida exacta de la última ejecución está en `verificacion/resultado.txt`) y los tests de la aplicación.

**Errores de la IA que ese método detectó.** Los incluyo porque muestran por qué no basta con pedir y aceptar:

- Afirmó que el tope de conversaciones por clínica se podía exceder "por uno como máximo". Al medirlo con 20 workers simultáneos y tope 2, quedaron 20. Se corrigió con un bloqueo por clínica y un segundo conteo.
- El primer diseño ponía a Mongo en el camino de la respuesta al paciente. Se cambió por el outbox.
- Dos transacciones tomaban los bloqueos en orden distinto. Se reprodujo el interbloqueo y se fijó un orden único.
- El límite por teléfono usaba la hora declarada por el mensaje, que el emisor controla. Pasó a la hora del servidor.
- Una revisión independiente del código encontró que una caída de conexión a PostgreSQL tumbaba el proceso, y que una cita creada podía terminar en "escalada" sin que el paciente recibiera la confirmación.
- La documentación decía que el umbral de similitud estaba "calibrado". No lo estaba.
- El diseño de AWS dimensionaba 10 mensajes por tarea cuando el código usa 4.

**Dónde decidí contra una de las dos IA.** `[POR COMPLETAR, con tus palabras. Ejemplos que ocurrieron: pediste comparar Zod y TypeBox y elegiste TypeBox; exigiste cerrar la arquitectura antes de escribir código; mantuviste la numeración continua de las etiquetas de horario frente a la propuesta de reiniciarlas.]`

**Lo que la IA no puede darme.** `[POR COMPLETAR: qué ejecutaste y comprobaste tú mismo, y qué partes puedes explicar línea por línea.]`

## 7. Qué haría distinto

Con más tiempo, en este orden:

1. Un conjunto de conversaciones de evaluación con el modelo real, para elegir modelo y calibrar el umbral de similitud con datos.
2. El interruptor del proveedor, para que un error de configuración no se pague conversación por conversación.
3. Verificación de la firma del webhook y autenticación del coordinador.
4. Seguridad a nivel de fila en PostgreSQL, para que el aislamiento entre clínicas no dependa de que cada consulta filtre.
5. El envío real a WhatsApp, con su propia idempotencia.

Y dos cosas que cambiaría de cómo trabajé:

- `[POR COMPLETAR: tu propia reflexión. Una posible, si la compartes: la revisión de la capa de base de datos tomó muchas rondas y dejó poco tiempo para probar con el modelo real, que es donde está la mayor incertidumbre.]`
