-- 001_esquema.sql
-- Esquema completo del asistente de agendamiento.
-- Principio: las barreras que afirma ARQUITECTURA.md existen aquí, no solo en el código.
-- Todas las fechas son timestamptz (se guardan en UTC).

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- para impedir horarios solapados

-- ---------------------------------------------------------------------------
-- Catálogo de la clínica
-- ---------------------------------------------------------------------------

CREATE TABLE clinicas (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre        text NOT NULL,
  zona_horaria  text NOT NULL DEFAULT 'America/Bogota'
);

CREATE TABLE sedes (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinica_id  bigint NOT NULL REFERENCES clinicas(id),
  nombre      text NOT NULL,
  UNIQUE (clinica_id, nombre),
  UNIQUE (id, clinica_id)
);

CREATE TABLE especialidades (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinica_id  bigint NOT NULL REFERENCES clinicas(id),
  nombre      text NOT NULL,
  UNIQUE (clinica_id, nombre),
  UNIQUE (id, clinica_id)
);

-- La sede y la especialidad de un profesional son de su misma clínica: lo
-- impone la base con claves compuestas, no solo el código.
CREATE TABLE profesionales (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinica_id       bigint NOT NULL REFERENCES clinicas(id),
  sede_id          bigint NOT NULL,
  especialidad_id  bigint NOT NULL,
  nombre           text NOT NULL,
  FOREIGN KEY (sede_id, clinica_id)         REFERENCES sedes (id, clinica_id),
  FOREIGN KEY (especialidad_id, clinica_id) REFERENCES especialidades (id, clinica_id),
  UNIQUE (id, clinica_id)
);
CREATE INDEX profesionales_especialidad_sede ON profesionales (especialidad_id, sede_id);

-- Horarios predefinidos. Un profesional no tiene dos horarios a la misma hora.
CREATE TABLE slots (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinica_id      bigint NOT NULL,
  profesional_id  bigint NOT NULL,
  inicia_en       timestamptz NOT NULL,
  termina_en      timestamptz NOT NULL,
  CHECK (termina_en > inicia_en),
  -- El horario es de la misma clínica que su profesional.
  FOREIGN KEY (profesional_id, clinica_id) REFERENCES profesionales (id, clinica_id),
  UNIQUE (id, clinica_id),
  UNIQUE (profesional_id, inicia_en),
  -- Un profesional no tiene dos horarios que se solapen. Sin esto, dos pacientes
  -- podrían reservar 10:00-11:00 y 10:30-11:30 con el mismo profesional: cada
  -- horario tendría una sola cita, y aun así sería un doble agendamiento.
  CONSTRAINT slots_sin_solapamiento EXCLUDE USING gist (
    profesional_id WITH =,
    tstzrange(inicia_en, termina_en, '[)') WITH &&
  )
);

-- ---------------------------------------------------------------------------
-- Conversaciones: estado de negocio y candado de procesamiento
-- ---------------------------------------------------------------------------

-- Rango de cada estado. El estado representa la situación más relevante para
-- el coordinador y solo puede subir.
CREATE FUNCTION rango_estado(estado text) RETURNS int
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE estado
    WHEN 'en_curso'        THEN 0
    WHEN 'resuelta_por_ia' THEN 1
    WHEN 'cita_agendada'   THEN 2
    WHEN 'escalada'        THEN 3
  END
$$;

CREATE TABLE conversaciones (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinica_id           bigint NOT NULL REFERENCES clinicas(id),
  telefono             text NOT NULL CHECK (telefono ~ '^\+[0-9]{8,15}$'),
  estado               text NOT NULL DEFAULT 'en_curso'
                       CHECK (estado IN ('en_curso','resuelta_por_ia','cita_agendada','escalada')),
  motivo_escalamiento  text,
  procesando_hasta     timestamptz,           -- candado con vencimiento; NULL = libre
  ultima_actividad     timestamptz NOT NULL DEFAULT now(),
  creado_en            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinica_id, telefono),
  UNIQUE (id, clinica_id),
  -- Una conversación escalada siempre dice por qué, y solo ella tiene motivo.
  CHECK ((estado = 'escalada') = (motivo_escalamiento IS NOT NULL))
);

-- Bandeja: conversaciones de una clínica por estado, las más recientes primero.
CREATE INDEX conversaciones_bandeja
  ON conversaciones (clinica_id, estado, ultima_actividad DESC);

-- Conversaciones en proceso por clínica, para el tope de equidad del reclamo.
-- Solo contiene las que tienen candado puesto: es pequeño.
CREATE INDEX conversaciones_en_proceso
  ON conversaciones (clinica_id, procesando_hasta)
  WHERE procesando_hasta IS NOT NULL;

-- Barrera en la base: ningún código puede bajar el estado de una conversación.
CREATE FUNCTION impedir_bajar_estado() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF rango_estado(NEW.estado) < rango_estado(OLD.estado) THEN
    RAISE EXCEPTION 'el estado de una conversación no puede bajar de % a %',
      OLD.estado, NEW.estado USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER conversaciones_estado_solo_sube
  BEFORE UPDATE OF estado ON conversaciones
  FOR EACH ROW EXECUTE FUNCTION impedir_bajar_estado();

-- ---------------------------------------------------------------------------
-- Mensajes entrantes: registro de idempotencia, cola y respuesta
-- ---------------------------------------------------------------------------

CREATE TABLE mensajes_entrantes (
  message_id          text PRIMARY KEY,       -- idempotencia del webhook
  conversacion_id     bigint NOT NULL REFERENCES conversaciones(id),
  -- Orden operativo: lo asigna el servidor al recibir. Define qué mensaje se
  -- procesa primero y cómo se lee el historial. Quien envía no lo controla.
  secuencia           bigint GENERATED ALWAYS AS IDENTITY,
  texto               text NOT NULL CHECK (char_length(texto) BETWEEN 1 AND 2000),
  -- Hora del mensaje: solo define "hoy" para interpretar fechas relativas.
  enviado_en          timestamptz NOT NULL,
  recibido_en         timestamptz NOT NULL DEFAULT now(),  -- hora del servidor: límite por teléfono
  estado              text NOT NULL DEFAULT 'pendiente'
                      CHECK (estado IN ('pendiente','procesando','procesado','fallido')),
  intento_actual      int NOT NULL DEFAULT 0 CHECK (intento_actual >= 0),
  intento_valido      int,
  proximo_intento_en  timestamptz NOT NULL DEFAULT now(),
  respuesta_tipo      text CHECK (respuesta_tipo IN (
                        'respuesta_documental','oferta_horarios','sin_disponibilidad',
                        'confirmacion_cita','pregunta_aclaratoria','sin_informacion',
                        'escalamiento','respaldo')),
  respuesta_texto     text CHECK (char_length(respuesta_texto) <= 4096),

  -- Un mensaje terminado tiene intento válido y respuesta; uno sin terminar, no.
  CONSTRAINT terminado_tiene_intento_valido
    CHECK ((estado IN ('procesado','fallido')) = (intento_valido IS NOT NULL)),
  CONSTRAINT terminado_tiene_respuesta
    CHECK ((estado IN ('procesado','fallido')) = (respuesta_tipo IS NOT NULL)
       AND (estado IN ('procesado','fallido')) = (respuesta_texto IS NOT NULL)),
  -- El intento válido es el último: un mensaje terminado no se vuelve a reclamar.
  CONSTRAINT intento_valido_es_el_actual
    CHECK (intento_valido IS NULL OR intento_valido = intento_actual),
  -- Solo se procesa lo que fue reclamado al menos una vez.
  CONSTRAINT procesando_fue_reclamado
    CHECK (estado = 'pendiente' OR intento_actual >= 1),
  -- Permite que otras tablas referencien el par (mensaje, conversación) y así
  -- la base impida asociar un mensaje con una conversación que no es la suya.
  CONSTRAINT mensaje_y_su_conversacion UNIQUE (message_id, conversacion_id)
);

-- Historial de una conversación en el orden en que el servidor recibió los mensajes.
CREATE INDEX mensajes_historial
  ON mensajes_entrantes (conversacion_id, secuencia);

-- Cola: solo mensajes sin terminar. Se mantiene pequeño aunque el historial crezca.
-- Resuelve "¿hay otro más antiguo sin terminar en esta conversación?".
CREATE INDEX mensajes_cola
  ON mensajes_entrantes (conversacion_id, secuencia)
  WHERE estado IN ('pendiente','procesando');

-- Cola: descubrir el siguiente mensaje listo entre todas las conversaciones.
-- Se ordena por el momento en que el mensaje quedó listo (para uno nuevo, su
-- llegada; para uno en reintento, el fin de su espera). Así el índice salta los
-- mensajes que aún esperan. Medido en verificar.py: con un índice solo por
-- secuencia, el reclamo se degrada cuando hay muchos mensajes en espera.
CREATE INDEX mensajes_cola_listos
  ON mensajes_entrantes (proximo_intento_en, secuencia)
  WHERE estado IN ('pendiente','procesando');

-- Límite de mensajes por teléfono: cuenta por hora del servidor, no por la del
-- mensaje, que la controla quien envía.
CREATE INDEX mensajes_recibidos
  ON mensajes_entrantes (conversacion_id, recibido_en);

-- Barrera en la base: un mensaje es inmutable.
--  - Identidad, orden, texto y horas no cambian nunca.
--  - Mientras está en la cola solo cambian sus campos operativos.
--  - Una vez terminado (procesado o fallido) no cambia nada: la respuesta que
--    recibió el paciente y el intento válido quedan fijos.
CREATE FUNCTION impedir_modificar_mensaje() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.message_id, NEW.conversacion_id, NEW.secuencia, NEW.texto, NEW.enviado_en, NEW.recibido_en)
     IS DISTINCT FROM
     (OLD.message_id, OLD.conversacion_id, OLD.secuencia, OLD.texto, OLD.enviado_en, OLD.recibido_en) THEN
    RAISE EXCEPTION 'el mensaje % es inmutable: solo cambian sus campos operativos', OLD.message_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.estado IN ('procesado','fallido') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'el mensaje % ya terminó: su estado y su respuesta no cambian', OLD.message_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER mensajes_inmutables
  BEFORE UPDATE ON mensajes_entrantes
  FOR EACH ROW EXECUTE FUNCTION impedir_modificar_mensaje();

-- ---------------------------------------------------------------------------
-- Citas
-- ---------------------------------------------------------------------------

CREATE TABLE citas (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinica_id         bigint NOT NULL,
  slot_id            bigint NOT NULL,
  conversacion_id    bigint NOT NULL,
  -- El horario y la conversación de una cita son de la misma clínica: un
  -- paciente de una clínica no puede quedar agendado en la agenda de otra.
  FOREIGN KEY (slot_id, clinica_id)         REFERENCES slots (id, clinica_id),
  FOREIGN KEY (conversacion_id, clinica_id) REFERENCES conversaciones (id, clinica_id),
  -- Mensaje que originó la cita: clave de idempotencia del agendamiento.
  source_message_id  text NOT NULL,
  estado             text NOT NULL DEFAULT 'agendada'
                     CHECK (estado IN ('agendada','cancelada')),
  creado_en          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT citas_un_mensaje_una_cita UNIQUE (source_message_id),
  -- La cita pertenece a la conversación del mensaje que la originó. Clave
  -- compuesta: la base rechaza un mensaje de una conversación con otra.
  CONSTRAINT cita_en_la_conversacion_de_su_mensaje
    FOREIGN KEY (source_message_id, conversacion_id)
    REFERENCES mensajes_entrantes (message_id, conversacion_id)
);

-- Regla de negocio: una cita agendada bloquea el horario; una cancelada lo libera.
CREATE UNIQUE INDEX citas_un_slot_una_cita_activa
  ON citas (slot_id) WHERE estado IN ('agendada');

CREATE INDEX citas_por_conversacion ON citas (conversacion_id);

-- ---------------------------------------------------------------------------
-- Conocimiento (RAG)
-- ---------------------------------------------------------------------------

-- El texto de un documento vive en un solo lugar: sus líneas. No hay copia en
-- el documento ni en los fragmentos, así que lo que recibe el paciente no puede
-- diferir del contenido canónico.
CREATE TABLE documentos (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinica_id  bigint NOT NULL REFERENCES clinicas(id),
  titulo      text NOT NULL,
  -- Huella de título + contenido + modelo de embeddings + versión del fragmentador.
  huella      text NOT NULL,
  UNIQUE (clinica_id, titulo),
  UNIQUE (id, clinica_id)
);

-- Contenido canónico, ya normalizado, una fila por línea. La identidad de una
-- línea es (documento_id, numero). Los encabezados de sección son líneas también.
CREATE TABLE documento_lineas (
  documento_id  bigint NOT NULL REFERENCES documentos(id) ON DELETE CASCADE,
  numero        int NOT NULL CHECK (numero >= 1),
  texto         text NOT NULL CHECK (char_length(texto) BETWEEN 1 AND 500),
  PRIMARY KEY (documento_id, numero)
);

-- El conocimiento es inmutable. Documentos, líneas y fragmentos no se editan.
-- El único camino para cambiarlo es reingerir: borrar el documento completo y
-- volver a insertarlo en una transacción. Así un embedding nunca queda apuntando
-- a un texto distinto del que lo generó, y la huella siempre describe lo que hay.
CREATE FUNCTION impedir_modificar_conocimiento() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'el conocimiento no se modifica (%): se reingiere el documento completo', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER documentos_inmutables
  BEFORE UPDATE ON documentos
  FOR EACH ROW EXECUTE FUNCTION impedir_modificar_conocimiento();

CREATE TRIGGER lineas_inmutables
  BEFORE UPDATE ON documento_lineas
  FOR EACH ROW EXECUTE FUNCTION impedir_modificar_conocimiento();

-- Una línea no se borra sola: solo desaparece cuando se borra su documento.
-- Durante el borrado en cascada el documento ya no existe; en un borrado
-- directo de la línea, sí, y se rechaza.
CREATE FUNCTION impedir_borrar_linea_suelta() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM documentos WHERE id = OLD.documento_id) THEN
    RAISE EXCEPTION 'una línea no se borra sola: se reingiere el documento completo'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER lineas_no_se_borran_sueltas
  BEFORE DELETE ON documento_lineas
  FOR EACH ROW EXECUTE FUNCTION impedir_borrar_linea_suelta();

-- Un fragmento es un tramo de líneas consecutivas de una sección, más la línea
-- de su encabezado. No guarda texto: solo apunta a las líneas. Las etiquetas
-- F1.3 que ve el modelo son alias temporales de (documento_id, numero).
CREATE TABLE fragmentos_conocimiento (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  documento_id       bigint NOT NULL,
  clinica_id         bigint NOT NULL,
  linea_encabezado   int NOT NULL,
  linea_inicial      int NOT NULL,
  linea_final        int NOT NULL,
  embedding          vector(1536) NOT NULL,
  modelo_embedding   text NOT NULL,
  CHECK (linea_final >= linea_inicial),
  CHECK (linea_encabezado <= linea_inicial),
  UNIQUE (documento_id, linea_inicial),
  -- Un fragmento pertenece a la misma clínica que su documento: lo impone la base.
  CONSTRAINT fragmento_en_la_clinica_de_su_documento
    FOREIGN KEY (documento_id, clinica_id)
    REFERENCES documentos (id, clinica_id) ON DELETE CASCADE,
  -- Las tres líneas que referencia existen en ese mismo documento.
  FOREIGN KEY (documento_id, linea_encabezado) REFERENCES documento_lineas (documento_id, numero) ON DELETE CASCADE,
  FOREIGN KEY (documento_id, linea_inicial)    REFERENCES documento_lineas (documento_id, numero) ON DELETE CASCADE,
  FOREIGN KEY (documento_id, linea_final)      REFERENCES documento_lineas (documento_id, numero) ON DELETE CASCADE
);
-- La búsqueda filtra por clínica y por modelo de embeddings: nunca compara el
-- vector de una pregunta con vectores generados por otro modelo.
CREATE INDEX fragmentos_por_clinica_y_modelo ON fragmentos_conocimiento (clinica_id, modelo_embedding);

CREATE TRIGGER fragmentos_inmutables
  BEFORE UPDATE ON fragmentos_conocimiento
  FOR EACH ROW EXECUTE FUNCTION impedir_modificar_conocimiento();

-- ---------------------------------------------------------------------------
-- Outbox de trazas hacia MongoDB
-- ---------------------------------------------------------------------------

CREATE TABLE trazas_pendientes (
  message_id      text NOT NULL REFERENCES mensajes_entrantes(message_id),
  intento         int NOT NULL CHECK (intento >= 1),
  -- Tope real del tamaño de una traza: 64 KB de su representación JSON.
  documento       jsonb NOT NULL CHECK (octet_length(documento::text) <= 65536),
  creado_en       timestamptz NOT NULL DEFAULT now(),
  intentos_envio  int NOT NULL DEFAULT 0 CHECK (intentos_envio >= 0),
  estado_envio    text NOT NULL DEFAULT 'pendiente'
                  CHECK (estado_envio IN ('pendiente','requiere_revision')),
  ultimo_error    text,
  PRIMARY KEY (message_id, intento)
);

CREATE INDEX trazas_por_publicar
  ON trazas_pendientes (creado_en) WHERE estado_envio = 'pendiente';
