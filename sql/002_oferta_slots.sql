-- 002_oferta_slots.sql
-- Qué horarios se le ofrecieron al paciente en un turno, en el orden en que
-- los vio. Sirve para que una posición ("el primero", "2") se resuelva al MISMO
-- horario que el paciente leyó, y no al que ocupe esa posición en una
-- consulta nueva. Una referencia por hora, sede o profesional ("la de las 8")
-- no reserva: se busca en esta lista y produce otra oferta, que se guarda igual.
--
-- Origen: prueba con el modelo real (4 de octubre de 2026). El paciente dijo
-- "El primero" y el asistente volvió a consultar la disponibilidad y agendó el
-- primero de la lista nueva. Si otro paciente hubiera tomado ese horario entre
-- los dos mensajes, habría agendado una hora distinta de la que el paciente eligió.
--
-- Va en el mensaje porque es parte de la respuesta que recibió el paciente, y
-- queda congelada con ella: el disparador mensajes_inmutables ya impide
-- cambiar cualquier columna de un mensaje terminado.
--
-- Es la única columna de la oferta. Si sigue esperando la elección del paciente
-- y si ya se usó no se guardan: se derivan del tipo de las respuestas
-- posteriores y de las citas de la conversación (agendar_validar_oferta, en
-- consultas.sql). Una oferta autoriza como máximo una cita.

ALTER TABLE mensajes_entrantes
  ADD COLUMN oferta_slots bigint[],
  ADD CONSTRAINT mensajes_oferta_solo_en_ofertas
    CHECK (oferta_slots IS NULL
           OR (respuesta_tipo = 'oferta_horarios' AND cardinality(oferta_slots) BETWEEN 1 AND 8));
