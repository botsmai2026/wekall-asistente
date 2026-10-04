-- consultas.sql
-- ÚNICA FUENTE de las sentencias SQL del asistente (webhook, worker, relevo y
-- lecturas). Las de carga de conocimiento están en ingestion.sql. Cada bloque "-- name:" es una
-- sentencia con nombre y parámetros ":nombre". El verificador (verificar.py) y
-- la aplicación cargan ESTE archivo y ejecutan estas mismas sentencias: no hay
-- copias del SQL en los tests ni en el código. Lo que sí vive en el código es
-- el orden en que cada transacción las ejecuta, descrito aquí en comentarios.
--
-- ":ahora" siempre viene del Reloj inyectable de la aplicación, nunca de now(),
-- para que los tests fijen la hora.
--
-- TIPOS DE LOS PARÁMETROS DE FECHA: la aplicación envía los parámetros al
-- servidor sin interpolarlos en el texto. En una expresión como
-- ":ahora - interval '1 minute'" Postgres no puede deducir el tipo del
-- parámetro (lo tomaría por un intervalo). Por eso el cargador de la aplicación
-- convierte cada parámetro de fecha (:ahora, :enviado_en, :desde, :hasta,
-- :proximo_intento_en) en CAST($n AS timestamptz). Es la única transformación
-- que aplica, y está en un solo lugar: src/infraestructura/consultas.ts.
--
-- ORDEN GLOBAL DE BLOQUEOS:  1. conversación   2. mensaje   3. cita / horario
--   Toda transacción que toque más de uno los toma en ese orden. Con un orden
--   inconsistente, un worker tardío que agenda mientras otro reclama la misma
--   conversación produce un deadlock (reproducido en verificar.py, sección 4b).
--   Por eso toda transacción sobre un mensaje empieza con "bloquear_conversacion".
--
-- AISLAMIENTO: READ COMMITTED es obligatorio para los protocolos de este
--   archivo, y es parte del contrato, no un valor heredado del servidor. La
--   función que ejecuta estas sentencias (enTransaccion) abre siempre con
--   BEGIN ISOLATION LEVEL READ COMMITTED  y no acepta otro nivel.
--   No es una ley para todo el sistema: una operación futura que necesite otro
--   nivel (un reporte, una conciliación) debe abrir su transacción de forma
--   explícita por otro camino, y por ese camino no puede ejecutar estas
--   sentencias.
--   Varios protocolos de este archivo bloquean y LUEGO leen en otra sentencia,
--   contando con que esa sentencia ve lo confirmado mientras se esperaba el
--   bloqueo. En REPEATABLE READ la fotografía es la del inicio de la
--   transacción. Medido con 20 reclamos simultáneos y tope 2 en ese nivel:
--   19, 10 y 20 conversaciones tomadas, más errores de serialización.
--   El tope por clínica es el único caso que fallaría EN SILENCIO, así que
--   "reclamo_turno_clinica" devuelve además si el nivel es el correcto y el
--   worker aborta si no lo es.
--
-- PLAZO DEL INTENTO: toda transacción del worker dentro de un intento empieza con
--     SET LOCAL statement_timeout = <ms restantes del plazo, máximo 5 s>;
--     SET LOCAL lock_timeout      = <ms restantes del plazo, máximo 5 s>;
--   Un timeout aquí es un fallo de infraestructura: el intento se reintenta.

-- ===========================================================================
-- 1. WEBHOOK: recibir un mensaje
-- ===========================================================================
-- Transacción: webhook_conversacion → webhook_insertar_mensaje
--   · sin fila  → webhook_es_mismo_evento: true = COMMIT y 202 (duplicado: no
--                 genera trabajo ni consume el límite); false = ROLLBACK y 409.
--   · con fila  → webhook_contar_recientes: si supera 20, ROLLBACK y 429;
--                 si no, webhook_tocar_conversacion, COMMIT y 202.

-- name: webhook_conversacion
-- Crea la conversación o toma la existente, y bloquea su fila: dos peticiones
-- del mismo teléfono se serializan aquí. Eso hace exacto el conteo del límite
-- y monótona la secuencia dentro de la conversación.
INSERT INTO conversaciones (clinica_id, telefono, ultima_actividad, creado_en)
VALUES (:clinica_id, :telefono, :ahora, :ahora)
ON CONFLICT (clinica_id, telefono) DO UPDATE SET telefono = EXCLUDED.telefono
RETURNING id;

-- name: webhook_insertar_mensaje
INSERT INTO mensajes_entrantes
  (message_id, conversacion_id, texto, enviado_en, recibido_en, proximo_intento_en)
VALUES (:message_id, :conversacion_id, :texto, :enviado_en, :ahora, :ahora)
ON CONFLICT (message_id) DO NOTHING
RETURNING message_id;

-- name: webhook_es_mismo_evento
-- Solo es un duplicado si es el MISMO evento: mismo teléfono, texto y hora.
SELECT conversacion_id = :conversacion_id AND texto = :texto AND enviado_en = :enviado_en
FROM mensajes_entrantes WHERE message_id = :message_id;

-- name: webhook_contar_recientes
-- Límite por teléfono. Cuenta por la hora del servidor, no por la del mensaje.
SELECT count(*) FROM mensajes_entrantes
WHERE conversacion_id = :conversacion_id AND recibido_en > :ahora - interval '1 minute';

-- name: webhook_tocar_conversacion
UPDATE conversaciones SET ultima_actividad = :ahora WHERE id = :conversacion_id;

-- ===========================================================================
-- 2. WORKER: reclamar el siguiente mensaje (transacción corta)
-- ===========================================================================
-- Transacción: reclamo_elegir → (sin fila: COMMIT y esperar)
--              → reclamo_turno_clinica
--              → reclamo_contar_clinica (en_proceso >= tope: ROLLBACK y reintentar el ciclo;
--                tras 3 rechazos seguidos, esperar como si no hubiera trabajo)
--              → reclamo_marcar_mensaje (sin fila: ROLLBACK y reintentar el ciclo)
--              → reclamo_poner_candado → COMMIT
-- Orden de bloqueos: conversación → turno de la clínica. Ninguna otra
-- transacción toma el turno de la clínica, así que no puede haber ciclo.

-- name: reclamo_elegir
-- De cada conversación solo es elegible su mensaje sin terminar con menor
-- secuencia: si ese espera un reintento, los posteriores también esperan.
-- Entre conversaciones se atiende primero el que lleva más tiempo listo.
-- Presupuesto de concurrencia por clínica: aquí se DESCARTAN las clínicas que
-- ya tienen :max_por_clinica conversaciones en proceso, para que el worker
-- pase a otra clínica. Este filtro solo no garantiza el tope: cada sentencia
-- ve una fotografía, y varios reclamos simultáneos pueden ver el mismo conteo
-- (medido: 20 workers a la vez, tope 2, 20 conversaciones tomadas). El tope lo
-- garantizan las dos sentencias siguientes.
-- Bloquea la conversación elegida.
WITH ocupadas AS MATERIALIZED (        -- conversaciones en proceso por clínica, calculado una sola vez
  SELECT clinica_id, count(*) AS en_proceso
  FROM conversaciones
  WHERE procesando_hasta >= :ahora
  GROUP BY clinica_id
)
SELECT m.message_id, m.conversacion_id, c.clinica_id
FROM mensajes_entrantes m
JOIN conversaciones c ON c.id = m.conversacion_id
LEFT JOIN ocupadas o ON o.clinica_id = c.clinica_id
WHERE m.estado IN ('pendiente','procesando')
  AND m.proximo_intento_en <= :ahora
  AND (c.procesando_hasta IS NULL OR c.procesando_hasta < :ahora)
  AND coalesce(o.en_proceso, 0) < :max_por_clinica
  AND NOT EXISTS (
    SELECT 1 FROM mensajes_entrantes anterior
    WHERE anterior.conversacion_id = m.conversacion_id
      AND anterior.estado IN ('pendiente','procesando')
      AND anterior.secuencia < m.secuencia)
ORDER BY m.proximo_intento_en, m.secuencia
LIMIT 1
FOR UPDATE OF c SKIP LOCKED;

-- name: reclamo_turno_clinica
-- Serializa la admisión de UNA clínica: dos reclamos de la misma clínica pasan
-- de uno en uno por aquí; los de clínicas distintas no se esperan. El bloqueo
-- es de transacción: se suelta solo al terminar (COMMIT o ROLLBACK), también
-- si el worker muere. No bloquea ninguna fila, así que no interfiere con el
-- webhook ni con las claves foráneas hacia clinicas.
-- La clave es el propio id de la clínica (bigint): sin hash no hay colisiones
-- entre clínicas. El espacio de bloqueos consultivos de UNA clave queda
-- reservado para esto; cualquier otro uso futuro debe usar la forma de dos
-- claves, que es un espacio separado.
-- Si aislamiento_correcto es false, el worker hace ROLLBACK y termina con un
-- error de programación: no reclama nada.
SELECT pg_advisory_xact_lock(CAST(:clinica_id AS bigint)),
       current_setting('transaction_isolation') = 'read committed' AS aislamiento_correcto;

-- name: reclamo_contar_clinica
-- Debe ser una sentencia APARTE de la anterior: en READ COMMITTED cada
-- sentencia toma su fotografía al empezar. Si el conteo fuera en la misma
-- sentencia que el bloqueo, la fotografía sería anterior a la espera y no
-- vería los candados que confirmó el reclamo que iba delante.
-- Si en_proceso >= tope, el worker hace ROLLBACK y vuelve a elegir: para
-- entonces reclamo_elegir ya ve la clínica llena y toma otra.
-- Cuenta candados vigentes: un worker cuyo candado venció no cuenta.
SELECT count(*) AS en_proceso
FROM conversaciones
WHERE clinica_id = :clinica_id AND procesando_hasta >= :ahora;

-- name: reclamo_marcar_mensaje
-- La condición de estado evita revivir un mensaje que otro worker cerró entre
-- la lectura y el bloqueo.
UPDATE mensajes_entrantes
SET estado = 'procesando', intento_actual = intento_actual + 1
WHERE message_id = :message_id AND estado IN ('pendiente','procesando')
RETURNING intento_actual, texto, enviado_en;

-- name: reclamo_poner_candado
UPDATE conversaciones
SET procesando_hasta = :ahora + interval '120 seconds'
WHERE id = :conversacion_id
RETURNING estado, clinica_id, telefono;

-- ===========================================================================
-- 3. Piezas comunes a toda transacción sobre un mensaje
-- ===========================================================================

-- name: bloquear_conversacion
-- Primer paso de agendar, cerrar y fallar. La conversación se deriva del
-- mensaje: nunca se recibe como parámetro aparte.
SELECT c.id, c.clinica_id FROM conversaciones c
JOIN mensajes_entrantes m ON m.conversacion_id = c.id
WHERE m.message_id = :message_id
FOR UPDATE OF c;

-- name: verificar_intento
-- Protección contra worker tardío: el intento debe seguir siendo el suyo.
-- Sin fila: ROLLBACK y abortar el intento.
SELECT 1 FROM mensajes_entrantes
WHERE message_id = :message_id AND intento_actual = :intento AND estado = 'procesando'
FOR UPDATE;

-- name: cita_de_mensaje
-- ¿Existe una cita originada por este mensaje? Se usa en la verificación previa
-- del worker (recuperación sin modelo) y tras una violación de unicidad:
--   con fila → cita propia de un intento anterior; se devuelve como éxito.
--   sin fila → el horario lo tomó otro paciente: "ocupado".
-- Trae también los nombres que necesita la plantilla de confirmación, para
-- que el texto salga de la base y no de lo que recuerde el modelo.
SELECT ci.id, ci.slot_id, s.inicia_en,
       p.nombre AS profesional, se.nombre AS sede, e.nombre AS especialidad
FROM citas ci
JOIN slots s          ON s.id = ci.slot_id
JOIN profesionales p  ON p.id = s.profesional_id
JOIN sedes se         ON se.id = p.sede_id
JOIN especialidades e ON e.id = p.especialidad_id
WHERE ci.source_message_id = :message_id;

-- ===========================================================================
-- 4. HERRAMIENTAS: disponibilidad y agendamiento
-- ===========================================================================

-- name: disponibilidad
-- El modelo habla con nombres; tras validar, el código pasa identificadores.
-- :clinica_id es la de la conversación. El filtro explícito hace que un
-- identificador de otra clínica devuelva vacío, no datos ajenos.
-- :desde y :hasta son el rango en UTC calculado para la fecha local y la franja.
SELECT s.id, s.inicia_en, p.nombre AS profesional, p.sede_id
FROM slots s
JOIN profesionales p ON p.id = s.profesional_id
WHERE p.clinica_id = :clinica_id
  AND p.especialidad_id = :especialidad_id
  AND (:sede_id::bigint IS NULL OR p.sede_id = :sede_id)
  AND s.inicia_en >= :desde AND s.inicia_en < :hasta
  AND s.inicia_en > :ahora
  AND NOT EXISTS (SELECT 1 FROM citas ci
                  WHERE ci.slot_id = s.id AND ci.estado IN ('agendada'))
ORDER BY s.inicia_en
LIMIT 8;

-- agendar_cita, transacción:
--   bloquear_conversacion → verificar_intento → agendar_clasificar_horario
--     · sin fila          → ROLLBACK, 'horario_invalido' (no existe o es de otra
--                           clínica; con etiquetas H no debería ocurrir: se
--                           registra como error del código)
--     · es_futuro = false → ROLLBACK, 'pasado'
--   → agendar_insertar_cita
--     · sin fila          → ROLLBACK, 'pasado' (dejó de ser futuro entre la
--                           clasificación y la inserción)
--     · unique_violation  → ROLLBACK, cita_de_mensaje: 'propia' u 'ocupado'.
--                           No se confía en cuál restricción reportó Postgres.
--   :ahora se toma del reloj de la aplicación al empezar ESTA transacción, no al
--   empezar el intento, y todas sus sentencias usan ese mismo instante.
--   Contrato temporal: la cita se crea si el horario era futuro RESPECTO A ESE
--   INSTANTE. No promete que siga siéndolo en el momento exacto del COMMIT: el
--   tiempo avanza y ninguna comprobación puede garantizar eso. Es una decisión
--   "a la fecha de :ahora", determinista y comprobable en tests con reloj fijo.
--   → agendar_subir_estado → COMMIT, 'creada'

-- name: agendar_clasificar_horario
SELECT s.clinica_id, s.inicia_en > :ahora AS es_futuro
FROM slots s
JOIN conversaciones c ON c.id = :conversacion_id AND c.clinica_id = s.clinica_id
WHERE s.id = :slot_id;

-- name: agendar_insertar_cita
-- La inserción se protege sola: solo crea la cita si el horario es de la
-- clínica de la conversación y sigue siendo futuro. La validación y el efecto
-- ocurren en la misma sentencia; la clasificación anterior solo sirve para
-- darle al modelo un error preciso. Sin ON CONFLICT: ningún conflicto queda
-- oculto. La clínica sale de la conversación, no de un parámetro.
INSERT INTO citas (clinica_id, slot_id, conversacion_id, source_message_id, creado_en)
SELECT c.clinica_id, s.id, c.id, :message_id, :ahora
FROM slots s
JOIN conversaciones c ON c.id = :conversacion_id AND c.clinica_id = s.clinica_id
WHERE s.id = :slot_id AND s.inicia_en > :ahora
RETURNING id;

-- name: agendar_subir_estado
UPDATE conversaciones SET estado = 'cita_agendada'
WHERE id = :conversacion_id AND rango_estado(estado) < rango_estado('cita_agendada');

-- ===========================================================================
-- 5. WORKER: cierre del intento
-- ===========================================================================
-- Transacción: bloquear_conversacion → cierre_mensaje
--   · con fila → cierre_conversacion
--   · siempre  → traza_insertar (si el cierre no aplicó, la traza lleva
--                resultado_procesamiento = 'descartado_por_intento')
--   → COMMIT
-- Aquí se persiste también el escalamiento. La herramienta escalar_a_humano no
-- escribe nada: devuelve la intención, y este cierre, protegido por el intento,
-- decide si aplica. Un worker tardío no puede escalar una conversación.

-- name: cierre_mensaje
-- :estado_mensaje es 'procesado' o 'fallido'.
UPDATE mensajes_entrantes
SET estado = :estado_mensaje, intento_valido = intento_actual,
    respuesta_tipo = :respuesta_tipo, respuesta_texto = :respuesta_texto
WHERE message_id = :message_id AND intento_actual = :intento AND estado = 'procesando'
RETURNING message_id;

-- name: cierre_conversacion
-- El estado sube, nunca baja. :estado_conversacion puede ser NULL (sin cambio).
UPDATE conversaciones
SET estado = CASE WHEN :estado_conversacion::text IS NOT NULL
                   AND rango_estado(:estado_conversacion) > rango_estado(estado)
                  THEN :estado_conversacion ELSE estado END,
    motivo_escalamiento = CASE WHEN :estado_conversacion = 'escalada' AND estado <> 'escalada'
                               THEN :motivo ELSE motivo_escalamiento END,
    procesando_hasta = NULL,
    ultima_actividad = :ahora
WHERE id = :conversacion_id;

-- name: traza_insertar
INSERT INTO trazas_pendientes (message_id, intento, documento, creado_en)
VALUES (:message_id, :intento, :documento, :ahora)
ON CONFLICT (message_id, intento) DO NOTHING;

-- ===========================================================================
-- 6. WORKER: el intento falló por infraestructura
-- ===========================================================================
-- Transacción: bloquear_conversacion → fallo_mensaje
--   · con fila → fallo_liberar_candado
--   · siempre  → traza_insertar (con el error)
--   → COMMIT

-- name: fallo_mensaje
UPDATE mensajes_entrantes
SET estado = 'pendiente', proximo_intento_en = :proximo_intento_en
WHERE message_id = :message_id AND intento_actual = :intento AND estado = 'procesando'
RETURNING message_id;

-- name: fallo_liberar_candado
UPDATE conversaciones SET procesando_hasta = NULL WHERE id = :conversacion_id;

-- ===========================================================================
-- 7. RELEVO DEL OUTBOX: publicar una traza en Mongo (una transacción por traza)
-- ===========================================================================
-- Transacción: relevo_limite_inactividad → relevo_tomar → (inserción en Mongo)
--   · Mongo aceptó o respondió clave duplicada → relevo_publicada → COMMIT
--   · Mongo rechazó este documento             → relevo_rechazada → COMMIT
--   · Mongo no responde (fallo del servicio)   → ROLLBACK, no tocar la fila,
--                                                esperar con tiempo creciente
-- Contrato:
--   - Único componente que escribe en Mongo.
--   - Entrega de al menos una vez; el índice único (message_id, intento) en
--     Mongo hace idempotente la repetición.
--   - La fila solo se borra tras una escritura reconocida por Mongo según el
--     write concern configurado para el despliegue.
--   - Tiempo máximo de la operación en Mongo: 3 s (lo impone el driver).
--   - Si Postgres corta la sesión por inactividad, el relevo descarta esa
--     conexión y sigue con otra. La llamada a Mongo en curso no se cancela por
--     eso: si termina bien, la traza se reenvía y Mongo la absorbe.
--   - Solo toca trazas_pendientes: no participa en el orden de bloqueos.

-- name: relevo_limite_inactividad
SET LOCAL idle_in_transaction_session_timeout = '10s';

-- name: relevo_tomar
SELECT message_id, intento, documento
FROM trazas_pendientes
WHERE estado_envio = 'pendiente'
ORDER BY creado_en
LIMIT 1
FOR UPDATE SKIP LOCKED;

-- name: relevo_publicada
DELETE FROM trazas_pendientes WHERE message_id = :message_id AND intento = :intento;

-- name: relevo_rechazada
UPDATE trazas_pendientes
SET intentos_envio = intentos_envio + 1,
    ultimo_error = :error,
    estado_envio = CASE WHEN intentos_envio + 1 >= 10
                        THEN 'requiere_revision' ELSE 'pendiente' END
WHERE message_id = :message_id AND intento = :intento;

-- ===========================================================================
-- 8. LECTURAS
-- ===========================================================================

-- name: bandeja
SELECT id, telefono, estado, motivo_escalamiento, ultima_actividad
FROM conversaciones
WHERE clinica_id = :clinica_id AND estado = :estado
ORDER BY ultima_actividad DESC
LIMIT 50;

-- name: detalle_mensajes
-- En el orden en que el servidor recibió los mensajes.
SELECT message_id, texto, enviado_en, estado, intento_actual, intento_valido,
       respuesta_tipo, respuesta_texto
FROM mensajes_entrantes
WHERE conversacion_id = :conversacion_id
ORDER BY secuencia;

-- name: detalle_trazas_en_outbox
-- Trazas que todavía no están en Mongo: pendientes de publicar o en revisión.
-- El detalle las une con las de Mongo por (message_id, intento); si una traza
-- está en ambos lados, vale la de Mongo y se muestra una sola vez.
SELECT t.message_id, t.intento, t.documento, t.estado_envio
FROM trazas_pendientes t
JOIN mensajes_entrantes m ON m.message_id = t.message_id
WHERE m.conversacion_id = :conversacion_id
ORDER BY t.message_id, t.intento;

-- name: contexto_ultimos_turnos
-- Los últimos :n turnos terminados, entregados en orden cronológico. El orden
-- lo resuelve la consulta para que no dependa de invertir la lista en el código.
SELECT message_id, texto, respuesta_texto
FROM (SELECT message_id, texto, respuesta_texto, secuencia
      FROM mensajes_entrantes
      WHERE conversacion_id = :conversacion_id AND estado IN ('procesado','fallido')
      ORDER BY secuencia DESC
      LIMIT :n) ultimos
ORDER BY secuencia;

-- name: bandeja_todas
SELECT id, telefono, estado, motivo_escalamiento, ultima_actividad
FROM conversaciones
WHERE clinica_id = :clinica_id
ORDER BY ultima_actividad DESC
LIMIT 50;

-- name: detalle_conversacion
-- Filtra por la clínica del contexto: un id de otra clínica devuelve vacío.
SELECT id, telefono, estado, motivo_escalamiento, ultima_actividad
FROM conversaciones
WHERE id = :conversacion_id AND clinica_id = :clinica_id;

-- name: contexto_clinica
SELECT nombre, zona_horaria FROM clinicas WHERE id = :clinica_id;

-- name: contexto_sedes
-- Listas cerradas para el prompt y para validar los argumentos del modelo.
SELECT id, nombre FROM sedes WHERE clinica_id = :clinica_id ORDER BY nombre;

-- name: contexto_especialidades
SELECT id, nombre FROM especialidades WHERE clinica_id = :clinica_id ORDER BY nombre;

-- ===========================================================================
-- 9. CONOCIMIENTO (RAG)
-- ===========================================================================

-- name: conocimiento_buscar
-- La búsqueda sola. Es la que miden benchmark_vectorial.py y planes.txt; la
-- aplicación ejecuta "conocimiento_buscar_con_texto", que la envuelve.
-- Requiere pgvector. verificar.py la ejecuta cuando la extensión está instalada
-- (con embeddings de prueba: comprueba orden, filtros y cálculo, no calidad
-- semántica). benchmark_vectorial.py mide su tiempo según el tamaño de la clínica.
-- El filtro por modelo impide comparar la pregunta con vectores de otro modelo:
-- si coincidiera la dimensión, Postgres no daría error y el resultado sería
-- basura. El código descarta los resultados bajo el umbral de similitud.
SELECT f.id, f.documento_id, f.linea_encabezado, f.linea_inicial, f.linea_final,
       1 - (f.embedding <=> :embedding) AS similitud
FROM fragmentos_conocimiento f
WHERE f.clinica_id = :clinica_id AND f.modelo_embedding = :modelo
ORDER BY f.embedding <=> :embedding
LIMIT 4;

-- name: conocimiento_buscar_con_texto
-- Lo que ejecuta la aplicación: la búsqueda anterior y, EN LA MISMA SENTENCIA,
-- el título, la huella y las líneas literales de cada fragmento encontrado.
-- Por qué una sola sentencia: una sentencia ve una única fotografía de la
-- base. Si la búsqueda y la lectura de las líneas fueran sentencias separadas,
-- una reingestión entre ambas dejaría fragmentos encontrados sin líneas, y la
-- aplicación podría concluir "no hay información" cuando sí la hay.
-- Devuelve una fila por línea; el encabezado de la sección viene como una línea
-- más (numero = linea_encabezado). El filtro por clínica se repite en documentos.
WITH mejores AS (
  SELECT f.id, f.documento_id, f.linea_encabezado, f.linea_inicial, f.linea_final,
         1 - (f.embedding <=> :embedding) AS similitud
  FROM fragmentos_conocimiento f
  WHERE f.clinica_id = :clinica_id AND f.modelo_embedding = :modelo
  ORDER BY f.embedding <=> :embedding
  LIMIT 4
)
SELECT m.id AS fragmento_id, m.documento_id, m.linea_encabezado, m.similitud,
       d.titulo, d.huella, l.numero, l.texto
FROM mejores m
JOIN documentos d ON d.id = m.documento_id AND d.clinica_id = :clinica_id
JOIN documento_lineas l ON l.documento_id = m.documento_id
 AND (l.numero = m.linea_encabezado OR l.numero BETWEEN m.linea_inicial AND m.linea_final)
ORDER BY m.similitud DESC, m.id, l.numero;

-- name: conocimiento_estado
-- Estado del conocimiento de una clínica, derivado de sus fragmentos. Se
-- consulta cuando la búsqueda no encuentra nada utilizable, para no confundir:
--   'listo'          todo indexado con el modelo actual → sin_informacion es verdad
--   'sin_indexar'    la clínica no tiene documentos     → sin_informacion es verdad
--   'parcial'        solo una parte está indexada con el modelo actual (ocurre
--                    mientras se reingiere documento por documento). Lo que la
--                    búsqueda SÍ encuentra se puede responder; un vacío no
--                    prueba que no exista → se escala, 'conocimiento_no_disponible'
--   'desactualizado' nada está indexado con el modelo actual → se escala igual
--   (servicio de embeddings caído: no llega aquí; aborta el intento)
WITH conteo AS (
  SELECT count(*) AS total,
         count(*) FILTER (WHERE modelo_embedding = :modelo) AS actuales
  FROM fragmentos_conocimiento
  WHERE clinica_id = :clinica_id
)
SELECT CASE
         WHEN total = 0        THEN 'sin_indexar'
         WHEN actuales = total THEN 'listo'
         WHEN actuales = 0     THEN 'desactualizado'
         ELSE 'parcial'
       END
FROM conteo;

-- name: conocimiento_estado_por_clinica
-- Comprobación de arranque del worker. Si NINGUNA clínica está 'listo' ni
-- 'parcial' con el modelo configurado y existen fragmentos, es un error de
-- configuración: el worker no arranca. Si solo algunas están desactualizadas o
-- parciales, arranca y las informa como degradadas en /health/ready y en el log.
SELECT clinica_id,
       count(*) AS total,
       count(*) FILTER (WHERE modelo_embedding = :modelo) AS actuales
FROM fragmentos_conocimiento
GROUP BY clinica_id;

-- name: conocimiento_armar_respuesta
-- El texto que recibe el paciente se lee siempre de documento_lineas: es la
-- única copia. El código pasa las identidades (documento, número) de los
-- encabezados y las líneas elegidas como dos arreglos paralelos. La consulta
-- elimina las repetidas y las devuelve en orden de documento y de línea: ni el
-- orden ni la deduplicación dependen del código.
-- Filtra por la clínica del contexto: ninguna línea de otra clínica puede
-- llegar a un paciente, aunque el código pasara mal una identidad.
SELECT l.documento_id, l.numero, l.texto
FROM (SELECT DISTINCT documento_id, numero
      FROM unnest(:documentos::bigint[], :numeros::int[]) AS u(documento_id, numero)) pedido
JOIN documento_lineas l USING (documento_id, numero)
JOIN documentos d ON d.id = l.documento_id AND d.clinica_id = :clinica_id
ORDER BY array_position(:documentos::bigint[], l.documento_id), l.numero;

-- La ingestión de documentos (borrar, insertar documento, líneas y fragmentos)
-- está en ingestion.sql: es otro proceso, con otro rol de base de datos.
