-- ingestion.sql
-- Sentencias del proceso de INGESTIÓN de conocimiento (el seed y, en producción,
-- la carga de documentos de cada clínica). Mismo formato que consultas.sql:
-- bloques "-- name:" con parámetros ":nombre".
--
-- Está separado de consultas.sql a propósito: es un proceso administrativo
-- distinto del asistente. En producción corre con otro rol de base de datos, el
-- único con permiso de escritura sobre las tablas de conocimiento; el worker
-- solo las lee.
--
-- Reingerir un documento, UNA transacción:
--   ingestion_huella_actual
--     · igual a la huella nueva → COMMIT, no hay nada que hacer
--   → ingestion_borrar_documento   (la cascada elimina sus líneas y fragmentos)
--   → ingestion_insertar_documento
--   → ingestion_insertar_lineas
--   → ingestion_insertar_fragmento (una vez por fragmento)
--   → COMMIT
-- Nunca conviven líneas nuevas con embeddings viejos: o está el documento
-- anterior completo, o está el nuevo completo.
--
-- La huella cubre título, contenido canónico, modelo de embeddings y versión
-- del fragmentador. El contenido llega ya normalizado: estructura reconocida
-- sobre el original, Unicode NFC, saltos LF, sin espacios finales ni líneas vacías.

-- name: ingestion_huella_actual
SELECT huella FROM documentos
WHERE clinica_id = :clinica_id AND titulo = :titulo;

-- name: ingestion_borrar_documento
DELETE FROM documentos
WHERE clinica_id = :clinica_id AND titulo = :titulo;

-- name: ingestion_insertar_documento
INSERT INTO documentos (clinica_id, titulo, huella)
VALUES (:clinica_id, :titulo, :huella)
RETURNING id;

-- name: ingestion_insertar_lineas
-- :textos es el arreglo de líneas en orden. La numeración la asigna la base
-- por posición: empieza en 1 y es consecutiva por construcción.
INSERT INTO documento_lineas (documento_id, numero, texto)
SELECT :documento_id, l.numero, l.texto
FROM unnest(:textos::text[]) WITH ORDINALITY AS l(texto, numero);

-- name: ingestion_insertar_fragmento
-- Las claves foráneas rechazan un fragmento cuya clínica no sea la del
-- documento, o que apunte a líneas que no existen en ese documento.
INSERT INTO fragmentos_conocimiento
  (documento_id, clinica_id, linea_encabezado, linea_inicial, linea_final, embedding, modelo_embedding)
VALUES (:documento_id, :clinica_id, :linea_encabezado, :linea_inicial, :linea_final, :embedding, :modelo);
