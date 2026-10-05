# Decisiones

Qué decidí, por qué, qué descarté y qué costo acepté. El detalle técnico está en [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md), [`docs/ADR-001-cola-en-produccion.md`](docs/ADR-001-cola-en-produccion.md) y [`docs/AWS.md`](docs/AWS.md); aquí está el razonamiento.

## 1. Lo que hay y lo que no

Construí un asistente que responde preguntas con base en los documentos de una clínica y agenda citas, con todo el recorrido: webhook, cola, worker, herramientas, trazabilidad, interfaz y datos de ejemplo.

Lo que no hay, dicho de entrada:

- No está desplegado en AWS. El diseño está en `docs/AWS.md`; su base está escrita en Terraform en `infra/terraform/` y validada sin desplegar (sección 3.13).
- La respuesta se guarda y se muestra; no se envía a WhatsApp.
- El webhook y la API no tienen autenticación.
- El modelo de lenguaje definitivo no está elegido (sección 5).

Qué se ejecutó y quién lo ejecutó. Lo separo porque no es lo mismo, y la sección 6 explica cómo usé la IA.

Lo que ejecuté yo, en mi equipo, el 4 de octubre de 2026 y con mi clave de OpenAI:

- `docker compose up --build`, hasta tener las bases, la API, el worker y la interfaz arriba.
- Las primeras conversaciones con el modelo real, desde la interfaz: una pregunta con respuesta en los documentos, una sin respuesta, una consulta de disponibilidad, una reserva y un escalamiento. Revisé la respuesta y la traza de cada una. De ahí salió el primer fallo real (sección 6).

Lo que ejecutaron asistentes de IA sobre el repositorio, en mi equipo, y cuyos reportes revisé:

- Los tests de la aplicación: 191 de 191 con PostgreSQL y MongoDB reales, después de agregar la defensa de días de la semana (sección 3.7). La ejecución sin MongoDB no se repitió: en la anterior, con 181 tests, se omitieron 4 y pasaron 177.
- El verificador de la base de datos: 159 de 159 comprobaciones, con pgvector. La salida está en `verificacion/resultado.txt`.
- El arranque desde volúmenes vacíos y la prueba con MongoDB detenido: el paciente recibió su respuesta, la traza se pudo leer desde PostgreSQL y pasó a Mongo al volver.
- La validación final con `gpt-4o-mini`, que repitió los flujos de elección sobre una oferta de horarios y encontró dos fallos que los tests no cubrían (sección 5).

## 2. La idea que ordena todo lo demás

**El código responde por el resultado, no el modelo.** El modelo interpreta lo que dice el paciente y elige una herramienta. El código valida, calcula las fechas, ejecuta contra la base y escribe el texto que recibe el paciente.

Lo elegí porque la prueba pide confiabilidad, y un modelo de lenguaje no la da por sí solo: no sabe qué día es, puede inventar un horario y puede redactar una política que no existe. Cada regla crítica tiene una barrera en código o en la base de datos, no una instrucción en el prompt.

### 2.1 Cómo está organizado el proyecto

| Carpeta | Qué vive ahí |
|---|---|
| `src/dominio/` | Reglas puras, sin dependencias: fechas, estados, plantillas de texto, lectura de una selección por número |
| `src/aplicacion/` | La lógica de negocio: webhook, worker, ciclo del asistente, herramientas (validan y ejecutan), relevo de trazas, ingestión |
| `src/infraestructura/` | Lo que habla con el exterior: PostgreSQL, MongoDB y OpenAI, más las versiones falsas para los tests |
| `src/http/` | Rutas y esquemas de la API |
| `sql/` | Esquema, migraciones y todas las sentencias, con nombre |

- **Dónde está la lógica de negocio:** en `aplicacion/` y `dominio/`, y en las restricciones de la base. Ninguna regla depende del prompt.
- **Dónde está la integración con el LLM:** en un solo archivo, `infraestructura/openai.ts`. La aplicación solo conoce una interfaz (`ModeloLenguaje`, en `aplicacion/puertos.ts`); no importa el SDK del proveedor.

## 3. Decisiones

### 3.1 El modelo nunca escribe lo que recibe el paciente

Además de las cuatro herramientas pedidas hay una quinta, `responder`. El modelo elige un tipo de respuesta y entrega etiquetas (qué líneas de un documento, qué horarios); el texto sale de una plantilla o es una línea literal del documento.

- **Por qué.** Garantiza por construcción que todo dato que recibe el paciente sale de una plantilla o de un texto almacenado, en lugar de depender de que el modelo obedezca una instrucción de no inventar. Hay otras formas de acercarse a eso (un segundo modelo que verifique, salida estructurada con comprobación posterior); esta es la más simple de probar.
- **Descarté** que el modelo redactara citando sus fuentes. Es más natural, pero permite que el texto contradiga la fuente que cita ("12 horas" citando una línea que dice "8").
- **Costo aceptado.** Las respuestas son menos naturales: el paciente recibe la línea que contiene el dato, no un "sí" o un "no". Lo que no se garantiza es la pertinencia: el modelo puede elegir una línea verdadera que no contesta la pregunta.

### 3.2 Qué va en PostgreSQL y qué en MongoDB

PostgreSQL dice qué es cierto ahora: conversaciones, mensajes, agenda, citas, conocimiento y la respuesta que recibió el paciente. Necesita transacciones y restricciones: un horario con una sola cita activa, una cita por mensaje, un estado que solo sube.

MongoDB dice qué ocurrió y cuánto costó: una traza por intento, con modelo, tokens, latencia y cada herramienta con sus argumentos y resultados. Es un documento anidado de forma variable, que solo se inserta y crece rápido.

Entidades en PostgreSQL (12 tablas; el detalle, con sus restricciones, está en la sección 3 de `docs/ARQUITECTURA.md`):

- **Agenda:** clínica → sedes y especialidades → profesionales → horarios (`slots`) → citas.
- **Conversación:** clínica → conversaciones (una por teléfono) → mensajes entrantes, cada uno con su respuesta. Una cita apunta al mensaje que la originó.
- **Conocimiento:** documentos → líneas → fragmentos con su vector.
- **Trazas pendientes** de copiar a Mongo.

En MongoDB hay una colección, `trazas_intento`: un documento por intento.

- **Por qué así.** Ninguna operación necesita que Mongo responda para ser correcta. Si Mongo se cae, el paciente no lo nota.
- **Lo digo sin adornos:** con este volumen, una columna JSON en PostgreSQL bastaría. Mongo es un requisito de la prueba y le di el papel donde mejor encaja.

### 3.3 Consistencia entre las dos bases

No existe una transacción que abarque PostgreSQL y Mongo. La traza se guarda en una tabla de PostgreSQL dentro de la misma transacción que cierra el turno, y un proceso aparte la copia a Mongo (patrón outbox).

- **Por qué.** Cuando un turno termina con una respuesta, PostgreSQL guarda en una sola transacción esa respuesta y la traza pendiente de envío: quedan las dos o ninguna. Mongo no participa en esa transacción. El relevo publica la traza después; si muere tras escribir en Mongo y antes de borrar la fila, la reenvía y un índice único en Mongo la absorbe.
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

**La elección del paciente también la resuelve el código.** Cuando el asistente ofrece horarios, guarda cuáles ofreció y en qué orden, y esa lista ya no cambia. Una cita nueva solo se crea si el mensaje completo del paciente es una posición de esa lista ("2", "el primero", "opción 3"): el código la extrae del texto, exige que coincida con la que indica el modelo y la traduce al horario que el paciente leyó. Las referencias por hora, sede o profesional no reservan: producen otra lista numerada.

- **La oferta tiene que estar esperando esa elección.** Una respuesta documental en medio no la anula. Una pregunta del asistente (fecha, sede, especialidad), un "no hay horarios" u otra oferta sí: así "el 5", contestado a "¿para qué día?", no reserva la opción 5 de una lista anterior.
- **Una oferta sirve para una sola cita,** aunque esa cita se cancele después. Otra cita exige otra oferta y otra elección.
- **Si el horario elegido ya lo tomó otra persona,** ese mensaje ya no puede crear ninguna cita: se le dice al paciente cuál horario ya no está y se le ofrecen los disponibles.
- **Si el paciente no da un número** ("ese", "el último"), se le vuelve a mostrar la lista solo con los horarios que siguen libres, renumerada.
- **Costo aceptado.** Reservar exige contestar con un número; "mañana a las 8" o "la de la doctora Mejía" cuestan un mensaje más.

Nada de esto estaba en el diseño inicial: salió de probar con el modelo real y de las revisiones posteriores (sección 6).

Si un worker crea la cita y muere antes de responder, el reintento encuentra la cita y la confirma sin llamar al modelo. Probado con dos pacientes pidiendo el mismo horario a la vez, y con 20 conexiones simultáneas en el verificador de la base.

### 3.7 Fechas

El modelo nunca escribe una fecha. Dice a qué se refiere el paciente ("días desde hoy", "día de la semana", "día y mes") y el código calcula el día en la zona horaria de la clínica.

El caso de la prueba es un test: un mensaje a las 03:40 UTC del 6 de octubre es, en Cali, el 5 a las 10:40 p. m., y "mañana" es el 6. La hora del mensaje define "hoy"; el reloj del servidor decide si la fecha ya pasó.

- **Costo aceptado.** Expresiones como "a fin de mes" no tienen salida: el asistente pide una fecha concreta.
- **Lo que encontró la aceptación con el modelo real.** El esquema acepta un día de la semana de tres formas, y en dos de ellas el modelo cuenta él mismo. Contó mal tres veces: "el sábado" llegó como `{dia: 7, mes: 10}` (un miércoles); "el viernes", como `dias_desde_hoy: 3` (un jueves); y "No, quiero el viernes", con `semana_siguiente: true` (el viernes de la semana siguiente). Las tres eran fechas válidas y el código las aceptaba.
- **La defensa.** Ahora el código contrasta el día de la semana que escribió el paciente con la fecha que propone el modelo, antes de `validarFecha` (`contrastarConMensaje`, en `src/dominio/fechas.ts`):
  - La gramática es deliberadamente estrecha: solo el mensaje actual, un día de la semana solo detrás de "el", "este" o "próximo", la semana siguiente solo con una expresión explícita ("de la otra semana"), y sin interpretar negaciones.
  - Si el mensaje tiene una única fecha explícita, manda la que escribió el paciente.
  - Si tiene varias referencias válidas ("¿mañana o el miércoles?"), la fecha del modelo debe ser una de ellas. Si no lo es, la herramienta devuelve `fecha_no_coincide` y el modelo consulta otra o pregunta.
  - Cuando el código corrige la fecha, la traza conserva la que pidió el modelo en `fecha_modelo`.
  - No cambiaron las ofertas, la reserva, la concurrencia, el SQL ni el prompt.

  Es la idea de la sección 2 aplicada a las fechas: el código responde por el resultado, no el modelo.
- **Límite.** Si el mensaje no nombra un día de la semana ("en tres días", o el día se dijo en un mensaje anterior), el número lo pone el modelo, y si cuenta mal el código no puede saberlo. La defensa que queda es que el paciente lee la fecha completa en la oferta antes de elegir.

### 3.8 Conocimiento (RAG) y base vectorial

Uso pgvector dentro del mismo PostgreSQL, con búsqueda exacta.

- **Por qué pgvector.** La búsqueda se filtra por clínica en la misma consulta, con las mismas garantías que el resto de los datos, y no hay otra base que sincronizar.
- **Por qué búsqueda exacta y no un índice aproximado.** La consulta se midió: 2 ms con 200 fragmentos en una clínica, 40 ms con 5.000. Un índice aproximado puede perder un fragmento relevante, y aquí eso aumenta el riesgo de un "no tengo esa información" falso. Con el tamaño actual la búsqueda exacta cumple la latencia y evita ese costo.
- **El texto vive en un solo lugar,** línea por línea. Los fragmentos que se buscan no guardan texto: apuntan a un rango de líneas. Lo que recibe el paciente no puede diferir del documento.
- **"No tengo esa información" exige haber buscado** en ese mismo turno.
- **Umbral de similitud (0,3): medido y conservado.** Se midió con los documentos y los embeddings reales: 48 preguntas, cada una en dos formas (como la escribe el paciente y como consulta corta), 96 búsquedas reales. Entre ellas había preguntas con respuesta en las mismas palabras del documento, con respuesta en otras palabras, sin respuesta, y sin respuesta pero con todas sus palabras presentes en los documentos.
  - Ningún umbral separa los dos grupos. Subirlo a 0,44 reduce de 29 a 17 (de 32) las búsquedas sin respuesta que reciben fragmentos, pero bloquea consultas válidas como "¿Abren los domingos?" (0,38, por debajo de "¿Cuánto cuesta una resonancia magnética?", 0,40).
  - Las defensas léxicas e híbridas medidas (cobertura de términos, términos ausentes del corpus, similitud alta o evidencia léxica, sinónimos por embeddings) también rompieron consultas válidas. La de menos errores en total rompió 8 de 64 y aun dejaba pasar 7 de 32 búsquedas sin respuesta, justo las preguntas cuyas palabras sí están en los documentos.
  - Por eso en esta entrega se conserva el comportamiento actual. Es una limitación medida y una decisión consciente: no se introduce una heurística que no demostró ser robusta. Un fragmento parecido no obliga a responder, porque el modelo elige las líneas y puede contestar "no tengo esa información". Esa elección es la parte no garantizada: ante la pregunta de la resonancia, en la aceptación lo hizo en una de tres ejecuciones, y en las otras dos citó las tarifas de consulta.
  - La mejora correcta es una etapa explícita de verificación de pertinencia, o conocimiento estructurado para los datos críticos (precios, duraciones, servicios).
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

La revisión recorre las diez categorías del OWASP Top 10 para aplicaciones con LLM (edición 2025). No es una auditoría: es qué hay y qué falta en cada una.

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

El índice de la cola se decidió con mediciones: la primera versión tardaba de 75 a 140 ms con atraso, y la actual menos de medio milisegundo.

### 3.12 Stack

- **TypeScript con Fastify y TypeBox.** Elegí TypeBox sobre Zod porque su esquema ya es JSON Schema: el mismo objeto valida en el servidor y se le envía al modelo como definición de la herramienta. No hay dos definiciones que puedan divergir.
- **Sin ORM.** El SQL está en archivos, con nombre, y el código lo carga de ahí. El verificador de la base ejecuta esos mismos archivos: lo que se probó es lo que corre.
- **Sin LangChain.** El ciclo de herramientas ocupa poco más de cien líneas: es lo bastante pequeño como para mantenerlo explícito y auditable dentro del proyecto.
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

En `docs/AWS.md` están el diagrama (sección 2), los servicios con las alternativas descartadas (3), cómo escala (4), qué pasa si cae una pieza (5), cómo se separan los datos de cada clínica (6) y el costo mensual (8).

**Infraestructura como código.** El enunciado la cuenta como un extra. La base del diseño está en Terraform, en `infra/terraform/`:
- la red en dos zonas, con un NAT por zona;
- los grupos de seguridad;
- RDS PostgreSQL Multi-AZ;
- la cola SQS FIFO de envío, con su cola de fallidos y una alarma;
- los secretos, vacíos;
- los grupos de logs.

Pasó `terraform fmt`, `init` y `validate`; no se ha ejecutado `plan` ni `apply` contra una cuenta de AWS. Lo demás (ECS, balanceador, WAF, Cognito, Atlas) sigue siendo diseño. El detalle, y lo que hubo que concretar al escribirlo, está en la sección 10 de `docs/AWS.md`.

### 3.14 Pipeline de IA

- **Cómo se parten los documentos.** Cada documento es Markdown con un título, secciones y un dato por línea. Un fragmento es una sección; si pasa de 1.500 caracteres se divide, repitiendo una línea entre partes. Cada línea tiene un máximo de 500 caracteres. Elegí la sección como unidad de búsqueda y la línea como unidad de respuesta: así se puede contestar con texto literal.
- **Embeddings.** `text-embedding-3-small`, de 1.536 dimensiones. Cada fragmento guarda con qué modelo se calculó, y cambiar de modelo obliga a recalcular.
- **Búsqueda.** Distancia coseno exacta en pgvector, filtrada por clínica; se entregan al modelo los 4 fragmentos más cercanos que superen el umbral (sección 3.8).
- **Cómo se arma el prompt.** Primero las reglas fijas, luego las sedes y especialidades reales de la clínica, y al final la fecha y hora del mensaje: lo que no cambia va primero para aprovechar la caché del proveedor. El historial son los últimos 10 turnos, solo texto. El texto del paciente va delimitado y en su propio rol, nunca en el mensaje de sistema.
- **Cómo se controla el ciclo de herramientas.** Una herramienta por llamada, siempre obligatoria. Máximo 5 iteraciones, 60 s por intento, 20 s por llamada al modelo, 400 tokens de salida y un tope al tamaño de la entrada. Cada llamada se valida dos veces, contra el esquema y contra la base; un error vuelve al modelo como resultado para que corrija o pregunte. El ciclo solo termina con `responder` o `escalar_a_humano` aceptados por el código.

### 3.15 Ambigüedades del enunciado y cómo las resolví

- **Qué hora manda.** La hora del mensaje define qué día es "hoy" y "mañana"; el reloj del servidor decide si una fecha ya pasó. Consecuencia: el ejemplo literal del enunciado, enviado después del 6 de octubre de 2026, pide una fecha pasada y el asistente solicita otra. El caso está cubierto por un test con reloj fijo.
- **`consultar_disponibilidad(especialidad, sede, fecha)`.** La sede es opcional, porque el paciente no siempre la dice, y agregué una franja opcional (mañana o tarde) para "mañana en la tarde".
- **`agendar_cita(...)`.** El enunciado deja abiertos los argumentos. Decidí que el modelo no identifique el horario: indica la posición que eligió el paciente y el código la resuelve (sección 3.6).
- **Estados.** Además de los tres del enunciado hay `en_curso`, para una conversación que todavía no tiene resultado.
- **"Cuánto costó".** Por turno se muestran modelo, tokens de entrada y de salida, y cuántos se leyeron de caché. No se muestra un valor en dinero: depende de un precio que cambia, y se calcula a partir de esos datos.
- **Escalar a un humano.** La conversación queda marcada con su motivo y el paciente recibe un aviso. No hay bandeja de asesor: desde ahí el asistente solo responde que un asesor continuará.

## 4. Costo

Estimación para 50 clínicas y 600.000 mensajes al mes: entre unos 710 y 1.050 USD mensuales (14 a 21 USD por clínica). AWS son unos 458, incluidas las IP públicas de los NAT y del balanceador; Atlas, 58, y el modelo, entre 190 y 530.

**Escenario de referencia para costos.** La estimación parte de una conversación de 4 mensajes del paciente, 9 llamadas al modelo, unos 22.000 tokens de entrada y 400 de salida. Es un supuesto de cálculo, no una estadística de uso real. Con él, una conversación cuesta entre 0,0013 y 0,0035 USD, según el modelo y cuánto se aproveche la caché de entrada. Son precios del nivel de procesamiento estándar.

**Mediciones reales.** Estas cifras sí salen del consumo que reporta el proveedor en cada llamada (`usage`), guardado en las trazas. Una conversación de 4 mensajes con `gpt-4o-mini`, el 4 de octubre de 2026: 16.252 tokens de entrada, de los cuales el 61 % se leyó de caché, 269 de salida, entre 2,4 y 5,2 s por turno, y un costo de unos 0,0019 USD. En la validación final, 22 turnos de 8 conversaciones cortas con el mismo modelo sumaron 79.062 tokens de entrada (60 % de caché) y 1.264 de salida, con turnos de 0,8 a 4,1 s. Quedan por debajo del escenario de referencia, pero la muestra es demasiado pequeña para reemplazar los supuestos de dimensionamiento: los orienta.

Qué tan firme es la estimación mensual: los precios se consultaron el 4 de octubre de 2026; los tokens del escenario de referencia salen del tamaño medido del prompt con una conversión aproximada, no de llamadas reales; la duración del turno y la forma del pico son supuestos. Las mediciones reales de arriba no entraron en ese cálculo.

La infraestructura es casi toda costo fijo. El modelo es el costo que crece con el uso.

**Cómo lo reduciría.** Casi todo el costo de una conversación son tokens de entrada que se repiten en cada llamada. En orden de efecto esperado:

1. Mantener estable el comienzo del prompt para que el proveedor lo cobre como caché. Ya está hecho; en las pruebas se leyó de caché cerca del 60 % de la entrada.
2. Menos llamadas por turno: que el código cierre el turno cuando el resultado ya está determinado, como ya hace al volver a ofrecer horarios.
3. Historial más corto: ofertas de horarios más compactas y menos turnos de contexto.
4. Un modelo más barato, solo después de medirlo con un conjunto de conversaciones de evaluación.

## 5. El modelo de lenguaje

Usé OpenAI. Los candidatos iniciales son `gpt-4o-mini`, que es el valor por defecto y el que ya acepta los parámetros del adaptador, y `gpt-6-luna`, por su precio actual.

No lo doy por decidido. Elegir por precio sería elegir a ciegas: lo que importa aquí es que el modelo escoja bien la herramienta y las líneas, en español. La forma correcta es un conjunto de 30 a 50 conversaciones de prueba (preguntas, agendamientos, fechas relativas, horario ocupado, intentos de inyección, escalamientos), correrlo con los dos y quedarse con el más barato que no falle.

**Lo que se probó con el modelo real.** Solo `gpt-4o-mini` (el proveedor respondió como `gpt-4o-mini-2024-07-18`), con embeddings de `text-embedding-3-small`, en conversaciones de prueba del 4 y el 5 de octubre de 2026. Las primeras las envié yo desde la interfaz; las de la validación final las envió un asistente de IA (Claude Code) al sistema levantado en mi equipo, y lo que sigue resume su reporte y las trazas guardadas. No es una evaluación: son pocos casos, cada uno repetido entre una y tres veces.

Lo que hizo bien:

- Pregunta con respuesta en los documentos (ayuno para el perfil lipídico): respondió con las líneas correctas.
- Pregunta sin respuesta (precio de una resonancia): eligió "no tengo esa información". No inventó un precio.
- "Mañana", "el martes" y "el 5" llegaron al código en la forma prevista y se consultó el día correcto. Las citas se crearon por opción numerada.
- Oferta, pregunta sobre un examen y después "2": reservó la opción 2 de esa misma oferta.
- Oferta, "mejor otro día", pregunta por la fecha y "el 5": lo tomó como fecha, consultó ese día y ofreció de nuevo. No intentó reservar.
- "El último" cuando otro paciente ya había tomado un horario de la oferta: no reservó; recibió la lista sin ese horario, renumerada, y su elección siguiente se resolvió contra esa lista.
- "Quiero hablar con una persona": escaló.

Lo que hizo mal:

- Ante "mejor otro día" consultó cinco días seguidos sin responder, agotó las iteraciones y la conversación terminó con un asesor. Pasó en dos conversaciones de dos. No hubo cita equivocada, pero tampoco respuesta útil. Se agregó al prompt la regla de pedir la fecha; después, tres de tres preguntaron la fecha. Es una regla de interpretación, no una garantía: si el modelo vuelve a hacerlo, el resultado sigue siendo el escalamiento.
- En dos conversaciones, al responder con líneas de un documento añadió un argumento vacío que el esquema rechaza, y lo corrigió en la llamada siguiente. Cuesta una llamada más en ese turno.

Un fallo del código que el modelo real destapó, en una conversación de seis con "el miércoles":

- **El fallo inicial fue del esquema, no del modelo.** El modelo indicó el día como `miércoles`, con tilde, que es como se escribe. La lista cerrada de días estaba sin tildes y el código lo rechazó.
- **El error del modelo vino después.** Tras el rechazo dejó de usar el día de la semana y pasó a contar los días él mismo: contó dos en vez de tres y ofreció el martes.
- **Corrección.** El código acepta ahora el día con tilde o con mayúsculas y lo normaliza antes de validar, con un test que antes fallaba.
- **Límite que permanece.** Cuando el modelo cuenta días, el código no puede saber si contó bien (sección 3.7). El arreglo quita el motivo que lo llevó a contar en este caso, no el límite.

Un límite observado, que no es un fallo de corrección: «la de las 8». Pasó el 5 de octubre, después de una oferta de ocho horarios de medicina general, dos de ellos a las 8:00:

- **Lo que hizo el modelo.** En 3 de 3 conversaciones, ante «la de las 8», llamó a `agendar_cita` con `opcion: 1` en lugar de usar `atributos`, que es lo que pide el prompt para una referencia por hora.
- **Lo que hizo el código.** Rechazó esa autorización porque el mensaje no contiene una posición, y no se creó ninguna cita. El turno terminó con la oferta otra vez numerada: los mismos ocho horarios, porque seguían libres, guardados como oferta nueva. No se redujo a los dos de las 8:00: eso solo ocurre cuando el modelo usa `atributos`.
- **La selección siguiente.** En la conversación que continuó, «1» reservó exactamente el horario de la posición 1 de esa oferta nueva, comprobado en PostgreSQL.
- **Qué cuesta.** Un turno más para el paciente, no una reserva equivocada.
- **Qué no demuestra.** Solo se probó esta frase, con un modelo y en tres conversaciones. No se sabe cómo se comporta con referencias por sede o por profesional, ni si con otro modelo usaría `atributos`.

## 6. Uso de IA

Usé IA durante todo el proyecto, y creo que lo relevante es cómo.

**El método.** Trabajé con dos asistentes. Uno diseñaba y construía; el otro revisaba cada entrega buscando fallos. Yo llevaba las objeciones de uno al otro con una regla: nadie cede por llegar a un acuerdo, solo ante un argumento o una medición. Antes de implementar cerramos una primera arquitectura y acordamos no reabrir decisiones por opinión. Sí se reabrieron, varias veces, cuando hubo un fallo reproducible, un test que fallaba, una medición o un requisito incumplido: la lógica de reserva cambió cuatro veces por esa vía (más abajo). Al final usé además Codex y Claude Code directamente sobre el repositorio, para revisión adversarial y para la validación final.

**Quién escribió qué.** La mayor parte del código, de los tests y de esta documentación la escribieron los asistentes, bajo mi dirección. Lo mío fue fijar los requisitos y las reglas de trabajo, decidir entre alternativas, exigir que cada afirmación importante se ejecutara, y probar el sistema con el modelo real.

**Lo que no acepté sin prueba.** Cuando una afirmación sobre concurrencia o rendimiento importaba, pedí que se ejecutara. De ahí salió un verificador de la base de datos (159 comprobaciones contra PostgreSQL real, con carreras de 20 conexiones; la salida exacta de la última ejecución está en `verificacion/resultado.txt`) y los tests de la aplicación.

**Errores de la IA que ese método detectó.** Los incluyo porque muestran por qué no basta con pedir y aceptar:

- Afirmó que el tope de conversaciones por clínica se podía exceder "por uno como máximo". Al medirlo con 20 workers simultáneos y tope 2, quedaron 20. Se corrigió con un bloqueo por clínica y un segundo conteo.
- El primer diseño ponía a Mongo en el camino de la respuesta al paciente. Se cambió por el outbox.
- Dos transacciones tomaban los bloqueos en orden distinto. Se reprodujo el interbloqueo y se fijó un orden único.
- El límite por teléfono usaba la hora declarada por el mensaje, que el emisor controla. Pasó a la hora del servidor.
- Una revisión independiente del código encontró que una caída de conexión a PostgreSQL tumbaba el proceso, y que una cita creada podía terminar en "escalada" sin que el paciente recibiera la confirmación.
- La documentación decía que el umbral de similitud estaba "calibrado". No lo estaba.
- El diseño de AWS dimensionaba 10 mensajes por tarea cuando el código usa 4.

**Lo que solo apareció al ejecutar con el modelo real.** En la primera conversación de prueba, ante "El primero", el modelo intentó agendar una etiqueta de un mensaje anterior. El código la rechazó, como estaba previsto, pero el modelo volvió a consultar y agendó el primero de la lista nueva. Funcionó por casualidad: con otro paciente reservando entre los dos mensajes, habría agendado una hora distinta de la que el paciente eligió. Ninguna de las rondas de revisión lo había visto. La primera corrección propuesta fue ajustar el prompt; la descarté porque dejaba la garantía en manos del modelo. La segunda guardaba la oferta y resolvía la opción en el código, y pasó todos los tests. Una revisión adversarial con otra herramienta mostró que seguía incompleta: después del rechazo, el modelo todavía podía agendar otra opción o un horario de una consulta nueva dentro del mismo mensaje. La versión final cierra el turno para agendar en cuanto la elección falla, y tiene tests que reproducen las dos formas de saltársela. Quedaba un tercer caso: «la de las 8» con dos horarios a las 8:00. La búsqueda por atributos evitaba elegir si había dos coincidencias, pero la revisión reprodujo otras vías: una etiqueta H podía elegir sede sin autorización, `opcion` podía contradecir el mensaje, y un atributo añadido por el modelo podía hacer única la coincidencia. La autorización ahora se extrae determinísticamente del mensaje completo y debe coincidir con `opcion`. Las etiquetas H no crean citas; los atributos solo producen ofertas persistidas, incluso con una sola coincidencia. Esto sacrifica la reserva inmediata por hora/profesional y exige una elección posicional posterior. Una revisión posterior encontró otro caso: tras una oferta, el paciente dice «mejor otro día», el asistente pregunta la fecha y el paciente contesta «el 5». El texto es una posición válida, y si el modelo lo tomaba como la opción 5 se creaba la cita. Ahora una posición solo vale mientras el asistente espera la elección de esa oferta, y eso se deduce de los tipos de respuesta ya guardados: una pregunta al paciente la anula; una respuesta documental no. Y la validación final con el modelo real, que repitió esos flujos, encontró dos fallos más que ningún test cubría: uno del prompt y otro del código (sección 5). Lo que aprendí: una suite en verde solo prueba lo que cubre.

**Lo que encontré al levantar el proyecto por segunda vez.** La interfaz mostraba "Mongo no responde" con MongoDB sano. La API había usado Mongo unos segundos antes de que estuviera listo, y el cliente del driver, tras fallar su primera conexión, queda cerrado y no vuelve a intentar. Lo reproduje apagando Mongo, arrancando la API y encendiéndolo de nuevo: seguía sin recuperarse. Ahora el adaptador descarta ese cliente y abre otro, con un test que fallaba antes. Ni los tests ni las revisiones lo habían visto: todos probaban el caso contrario, Mongo caído después de conectar.

**Dónde decidí contra una recomendación de la IA.**

- Pedí comparar Zod y TypeBox antes de aceptar la propuesta inicial, y elegí TypeBox (sección 3.12).
- Exigí cerrar una primera arquitectura antes de escribir código.
- Ante "El primero", no acepté la corrección que solo ajustaba el prompt: la garantía tenía que quedar en el código.
- Con el caso de "el 5", un asistente recomendó esperar a ver si el modelo real se equivocaba antes de cambiar el código. Decidí corregirlo de inmediato: que un fallo necesite un error del modelo no es una defensa, porque la capa determinista existe para contener esos errores.
- Para volver a mostrar una oferta, descarté las dos primeras propuestas (reconocer la pregunta por su texto, y repetir la lista anterior tal cual) y pedí que se comprobara la disponibilidad de ese momento.

## 7. Qué haría distinto

Con más tiempo, en este orden:

1. Un conjunto de conversaciones de evaluación con el modelo real, para elegir modelo y calibrar el umbral de similitud con datos.
2. El interruptor del proveedor, para que un error de configuración no se pague conversación por conversación.
3. Verificación de la firma del webhook y autenticación del coordinador.
4. Seguridad a nivel de fila en PostgreSQL, para que el aislamiento entre clínicas no dependa de que cada consulta filtre.
5. El envío real a WhatsApp, con control de reintentos, deduplicación best-effort y semántica at-least-once documentada.

La observabilidad y la operación con varias clínicas en producción están diseñadas en `docs/AWS.md`, secciones 3.10 y 6.
