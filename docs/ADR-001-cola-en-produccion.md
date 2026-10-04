# ADR-001: dónde vive la cola en producción

Estado: propuesta para revisión. Primera decisión de la etapa de AWS, porque el resto del diseño depende de ella.

Escenario del enunciado: 50 clínicas, 20.000 mensajes al día.

## 1. Qué se decide

Hoy la cola es una tabla de PostgreSQL. La pregunta es si en producción debe seguir ahí o pasar a Amazon SQS FIFO, total o parcialmente.

La cola actual no es solo transporte. Es parte del estado transaccional: en las mismas tablas viven el mensaje, su estado, el número de intento, la espera de reintento, el candado de la conversación y la protección contra workers tardíos. Por eso reemplazarla no es cambiar una pieza por otra equivalente.

## 2. Dimensionamiento: el promedio no decide

20.000 mensajes al día son 0,23 por segundo de promedio, pero una cola se dimensiona por el pico y por la concurrencia que ese pico exige.

Supuestos, a validar con datos reales de WeKall:

| Supuesto | Valor |
|---|---|
| Mensajes en horario de atención (10 horas) | 80 %: 16.000 |
| Ritmo medio en ese horario | 0,44 por segundo |
| Factor de pico por minuto | entre 5 y 10 veces |
| Ritmo en el pico | entre 2 y 4,5 por segundo |
| Duración de un turno (2 a 3 llamadas al modelo) | unos 8 segundos |

Consecuencias:

- **Concurrencia en el pico:** ritmo por duración, entre 18 y 36 turnos simultáneos.
- **Atraso tras una caída del modelo de 30 minutos:** entre 800 mensajes (ritmo medio) y 8.000 (si coincide con el pico).
- **Escenario de estrés, 20 por segundo:** unas 40 veces el ritmo medio del horario de atención. No es el escenario del enunciado, pero se usa abajo para ver cuál opción se rompe primero. Exigiría unos 160 turnos simultáneos.

En los escenarios medidos, el reclamo en PostgreSQL no es el cuello de botella. La capacidad de extremo a extremo la determina el menor de varios límites: la base, los workers, el proveedor del modelo y sus cuotas, las APIs externas y los topes de concurrencia. No se ha hecho una prueba de extremo a extremo con 160 turnos simultáneos: lo medido es el costo de cada operación de la cola por separado.

## 3. Las tres opciones

**A. PostgreSQL como cola (diseño actual).** El webhook inserta el mensaje; los workers lo reclaman con una consulta.

**B. SQS FIFO como cola.** El webhook publica en SQS con la conversación como grupo; los workers reciben de SQS. PostgreSQL sigue guardando mensajes, citas y estado.

**C. PostgreSQL como fuente de verdad y SQS como transporte.** El webhook inserta en PostgreSQL junto con una fila de despacho; un despachador publica en SQS FIFO; el worker recibe de SQS y luego reclama en PostgreSQL.

Una variante mínima de C, llamada aquí **C'**: SQS estándar solo como aviso de "hay trabajo en esta conversación". El worker sigue reclamando en PostgreSQL con la consulta actual, y si un aviso se pierde, la consulta periódica lo cubre.

## 4. Hechos de SQS FIFO que condicionan la decisión

Tomados de la documentación de AWS consultada en octubre de 2026:

- **Orden por grupo.** Mientras un mensaje de un grupo está en proceso, SQS no entrega otros del mismo grupo hasta que se borre o venza su visibilidad. Es una serialización de la entrega, parecida a nuestro candado por conversación, pero no lo sustituye: cuando la visibilidad vence, el mensaje se vuelve a entregar aunque el primer worker siga vivo.
- **El orden es el de llegada a SQS, no el nuestro.** SQS ordena dentro del grupo según el orden en que acepta los mensajes. Nuestro diseño define el orden por la secuencia que asigna PostgreSQL al recibir. Con dos peticiones simultáneas del mismo teléfono, PostgreSQL puede dar la secuencia 100 a una y 101 a la otra, y SQS aceptarlas al revés.
- **Deduplicación de 5 minutos.** Pasado ese intervalo, un mismo identificador se acepta de nuevo.
- **Sin retraso por mensaje.** Las colas FIFO no admiten temporizadores en mensajes individuales; solo un retraso para toda la cola.
- **Visibilidad máxima de 12 horas** desde la primera recepción, ajustable por mensaje.
- **Caudal:** 300 operaciones por segundo sin lotes, 3.000 con lotes, y mucho más en modo de alto caudal.
- **Sin protección contra el consumidor tardío.** Si la visibilidad vence con el worker vivo, SQS entrega el mensaje a otro. Evitar el doble efecto es responsabilidad de la aplicación.
- **Precio:** 0,50 dólares por millón de peticiones en FIFO, con un millón gratis al mes (dato de marzo de 2026 para Virginia del Norte, de una fuente secundaria; verificar en la calculadora de AWS antes de entregar).

## 5. Comparación

| Criterio | A. PostgreSQL | B. SQS FIFO como cola | C. PostgreSQL + SQS |
|---|---|---|---|
| Orden por conversación | Secuencia del servidor y candado. Probado | Por grupo, pero en el orden de llegada a SQS: cambia el contrato de orden actual o exige serializar antes de publicar | Dos autoridades de orden que deben coincidir: el despachador debe publicar en orden de secuencia |
| Un solo mensaje por conversación a la vez | Candado con vencimiento. Probado con 8 workers | Serialización de entrega por grupo; no impide la reentrega al vencer la visibilidad | Serialización en SQS, más el candado en PostgreSQL |
| Equidad entre clínicas | Tope estricto de conversaciones en proceso por clínica, dentro de la transacción de reclamo. Probado con 20 workers simultáneos | No la da: un grupo es una conversación, no una clínica. Habría que limitar en el worker o usar una cola por clínica | Igual que B, o el tope en PostgreSQL |
| Reintento con espera | Columna de próximo intento | Sin retraso por mensaje: hay que usar la visibilidad como espera | Igual que B |
| Worker que muere | El candado vence y otro reclama. Probado | La visibilidad vence y SQS reentrega | Igual que B |
| Worker tardío | Número de intento en PostgreSQL. Probado | SQS no lo cubre: hace falta el mismo número de intento en PostgreSQL | Igual que B |
| Idempotencia de entrada | Clave primaria, sin límite de tiempo | 5 minutos en SQS; para más, la clave en PostgreSQL | Clave primaria en PostgreSQL |
| Atomicidad con el estado | Total: recibir y encolar es una sola escritura | Ninguna: guardar en PostgreSQL y publicar en SQS son dos escrituras | Se logra con un outbox de despacho, que es otra cola en PostgreSQL |
| Mensajes agotados | Estado `fallido`, respaldo y escalamiento en el mismo cierre | Cola de mensajes muertos, y un consumidor aparte que responda y escale | Igual que B |
| Pico y estrés | El reclamo cuesta 0,15 ms; a 20 por segundo no se nota | Sobrado | Sobrado |
| Atraso de miles | Medido: 0,2 a 0,4 ms con 20.000 atrasados; unos 40 ms con 10.000 listos pero bloqueados | Sin degradación | Sin degradación |
| Escalado de workers | Hay que publicar la profundidad de la cola como métrica propia | Métrica nativa de mensajes pendientes | Métrica nativa |
| Entrega al worker | Consulta periódica, cada segundo | Espera larga, sin consultas en vacío | Espera larga |
| Si cae PostgreSQL | El webhook responde 503 y no se procesa nada | El webhook puede seguir aceptando, pero no se procesa nada | Igual que A: el webhook depende de PostgreSQL |
| Si cae la cola | No aplica: es la misma base | El webhook no puede aceptar mensajes | El despachador espera; nada se pierde |
| Observabilidad | Consultas y métricas propias | Métricas y alarmas de SQS listas | Las dos |
| Operación | Un sistema; exige autovacuum bien configurado en la tabla de cola | Dos sistemas | Dos sistemas y un despachador |
| Costo adicional | Ninguno | Pequeño frente al costo del modelo | Pequeño frente al costo del modelo |
| Piezas nuevas que construir y probar | Ninguna | Publicación, consumidor de mensajes muertos, espera por visibilidad | Outbox de despacho, despachador, y todo lo de B |

Orden de magnitud del costo: 20.000 mensajes al día son unos 600.000 al mes, y con unas cuatro peticiones por mensaje quedan en pocos millones de peticiones, es decir, del orden de un dólar al mes. La cifra exacta depende de los lotes y del tamaño de los mensajes, y no hace falta: el costo de SQS es pequeño frente al del modelo y no cambia la decisión.

## 6. Lo que la comparación muestra

**SQS no elimina la parte difícil.** SQS FIFO aporta la serialización de la entrega dentro de una conversación. No sustituye la exclusión ni la idempotencia de negocio, que siguen necesitando PostgreSQL con cualquier opción: el número de intento contra workers tardíos, la idempotencia de la cita, el cierre atómico de mensaje, estado y traza, y la idempotencia de entrada más allá de 5 minutos.

**SQS agrega un problema que hoy no existe.** Con la opción A, recibir un mensaje y dejarlo en cola es una sola escritura. Con B son dos escrituras en dos sistemas, y con C hace falta un outbox de despacho, es decir, otra cola en PostgreSQL para alimentar la cola de SQS.

**B tiene una ventaja real que A no tiene.** Si PostgreSQL está caído, el webhook puede seguir aceptando mensajes en SQS. En A, el webhook responde 503 y depende de que el proveedor reintente. El costo de esa ventaja: mientras el mensaje solo está en SQS, no aparece en la bandeja, no cuenta para el límite por teléfono y su deduplicación dura 5 minutos.

**Qué tan grave es esa dependencia en A.** Depende del tipo de despliegue de la base, que se decide en el diseño de AWS. Según la documentación de AWS, una conmutación por fallo dura típicamente de 60 a 120 segundos en una instancia Multi-AZ y menos de 35 segundos en un clúster Multi-AZ. Durante ese tiempo el webhook rechaza y el proveedor de mensajería reintenta. Supuesto sin verificar: no encontré en la documentación oficial de Meta la política exacta de reintentos de webhooks; hay que confirmarla antes de apoyarse en ella.

**Lo que SQS da de verdad, se puede obtener más barato.** Entrega sin consultas en vacío y una métrica para escalar son las dos ventajas operativas. Las dos se logran sin cambiar la fuente de verdad: publicando la profundidad de la cola como métrica propia, y, si la consulta periódica llegara a molestar, con la variante C' de aviso.

## 7. Decisión propuesta

**Opción A: la cola se queda en PostgreSQL**, con dos añadidos para producción:

1. La profundidad de la cola (mensajes listos y edad del más antiguo) se publica como métrica, y el número de workers escala con ella, dentro de techos explícitos.
2. La tabla de cola lleva configuración propia de autovacuum, porque es donde se concentran las actualizaciones.
3. Presupuesto de concurrencia por clínica: tope estricto de conversaciones en proceso por clínica, dentro de la transacción de reclamo.

**Techos del escalado.** Escalar workers solo por la profundidad de la cola puede empeorar una caída: más workers, más conexiones a la base, más llamadas al modelo, más errores por cuota, más reintentos y más cola. Por eso el escalado tiene cuatro límites que no dependen de la cola:

| Límite | Qué protege |
|---|---|
| Máximo de workers | La base y el presupuesto |
| Conexiones a PostgreSQL por worker, y total | La base |
| Concurrencia global de llamadas al modelo | Las cuotas del proveedor |
| Conversaciones en proceso por clínica | A las demás clínicas |

El último ya está implementado y probado: con un tope de 2, una clínica con cinco conversaciones atrasadas ocupa dos turnos y la siguiente clínica es atendida de inmediato.

Tiene dos partes. La consulta de reclamo descarta las clínicas llenas, para que el worker pase a otra. Eso solo no garantiza el tope: cada sentencia ve una fotografía, y con 20 reclamos simultáneos y tope 2 se midieron 20 conversaciones tomadas de una misma clínica. La garantía la da un segundo paso en la misma transacción: el reclamo toma un turno por clínica (`pg_advisory_xact_lock` con el id de la clínica como clave, sin hash), vuelve a contar en una sentencia aparte y solo entonces pone el candado; si la clínica ya está llena, deshace y elige de nuevo. Los reclamos de clínicas distintas no se esperan entre sí. Probado con 20 workers que arrancan a la vez: quedan exactamente 2 por clínica, y con rotación (reclamar, procesar, cerrar) nunca se ven más de 2.

Esta garantía depende de que la transacción sea `READ COMMITTED`: en `REPEATABLE READ` el segundo conteo vería la fotografía del inicio y el tope se rompe (medido: 19, 10 y 20 con tope 2). Por eso el nivel se declara al abrir cada transacción y la sentencia del turno lo comprueba; un reclamo en otro nivel se rechaza sin tomar nada. Tras tres rechazos seguidos por clínica llena, el worker espera como si no hubiera trabajo.

Límites de la garantía: cuenta candados vigentes, no procesos, así que un worker cuyo candado venció no cuenta; y el tope es un parámetro global, no un valor por clínica. Como cada conversación en proceso hace una sola llamada al modelo a la vez, este tope es también el máximo de llamadas simultáneas al modelo por clínica: no hace falta un segundo contador para eso. Un presupuesto por clínica de costo o de mensajes por día es otra cosa y queda para el diseño multi-tenant.

Con SQS esto no existiría en la cola: habría que construirlo igual en PostgreSQL o en otro almacén compartido.

Costo medido: el paso de admisión añade unos 0,2 ms por reclamo. En la carrera de 20 workers simultáneos, unos 30 intentos se deshacen y se repiten; solo ocurre cuando varios workers compiten por la misma clínica en el mismo instante. Por el filtro, el reclamo pasa de unos 0,15 ms a entre 0,2 y 0,4 ms, y el peor caso (10.000 mensajes listos pero bloqueados) de unos 16 ms a unos 40 ms.

Razones, en orden de peso:

- La cola es estado transaccional. Sacarla de la base rompe la atomicidad que hoy tenemos y obliga a reconstruirla con más piezas.
- SQS solo reemplaza dos de las protecciones; las demás siguen en PostgreSQL de todos modos.
- A este volumen, incluido el escenario de estrés, el costo medido de las operaciones de la cola es despreciable. SQS no ganaría por capacidad: tiene de sobra, pero aquí no hace falta.
- Menos piezas que operar, probar y explicar.

## 8. El mejor argumento en contra, y cuándo cambiaría la decisión

**El argumento en contra.** El enunciado pide elegir servicios de AWS, y nombra las colas. No usar SQS puede leerse como desconocimiento. Además, B desacopla la recepción de mensajes de la disponibilidad de la base, y A no. Si el proveedor de mensajería no reintenta con suficiente insistencia, A puede perder mensajes durante una conmutación por fallo, y B no.

**Respuesta.** La decisión se defiende con la comparación de arriba, no evitando el servicio. Y el riesgo de la conmutación se resuelve verificando la política de reintentos del proveedor. Si resulta insuficiente, la corrección es poner SQS delante del webhook como amortiguador de entrada, y solo eso, manteniendo la cola de procesamiento en PostgreSQL.

**Condiciones para reabrir la decisión:**

| Si ocurre | Entonces |
|---|---|
| El proveedor no reintenta lo suficiente ante un 503 | SQS como amortiguador de entrada delante de PostgreSQL |
| La consulta periódica de muchos workers pesa en la base | Variante C': SQS estándar como aviso |
| El ritmo sostenido supera lo que una sola base escribe con holgura (cientos por segundo) | Opción C completa |
| Los mensajes listos pero bloqueados por su conversación superan decenas de miles de forma habitual | Opción C completa: SQS resuelve ese caso sin recorrerlos |
| Se necesita procesar en varias regiones | Opción C completa |

**Dónde sí encaja SQS en este sistema.** En el envío de respuestas a WhatsApp cuando exista: un outbox de respuestas en PostgreSQL publicado hacia una cola, con un emisor que respete los límites del proveedor. Ahí la cola es transporte puro y no estado.

## 9. Lo que esta decisión deja sin resolver

- La política de reintentos de webhooks del proveedor, que condiciona el riesgo durante una conmutación por fallo.
- El dimensionamiento de PostgreSQL, que ahora carga con la cola además del resto. Va en el diseño de AWS.
- Los supuestos de pico de la sección 2, que son estimaciones y no datos.

## Fuentes

- [Cuotas de mensajes de Amazon SQS](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html)
- [Lógica de entrega de las colas FIFO](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-queues-understanding-logic.html)
- [Temporizadores de mensajes en SQS](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-message-timers.html)
- [Identificador de deduplicación en SQS](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/using-messagededuplicationid-property.html)
- [Tiempo de visibilidad en SQS](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html)
- [Conmutación por fallo en instancias Multi-AZ de RDS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZ.Failover.html) y [en clústeres Multi-AZ](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/multi-az-db-clusters-concepts-failover.html) (cifras citadas por la otra revisión; confirmar al fijar el tipo de despliegue)
- [Precios de Amazon SQS](https://aws.amazon.com/sqs/pricing/)
- [Amazon SQS Pricing: The 64 KB Rule Most Teams Never Notice](https://cloudburn.io/blog/amazon-sqs-pricing) (fuente secundaria para las cifras de precio)
