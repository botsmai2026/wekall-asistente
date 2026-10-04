-- seed.sql
-- Datos de ejemplo. Lo ejecuta "npm run preparar" (src/preparar.ts), no el
-- asistente. Todas las sentencias son idempotentes: correrlo dos veces no
-- duplica nada.

-- name: seed_clinica_existente
SELECT id FROM clinicas WHERE nombre = :nombre;

-- name: seed_clinica
INSERT INTO clinicas (nombre, zona_horaria) VALUES (:nombre, :zona_horaria) RETURNING id;

-- name: seed_sede
INSERT INTO sedes (clinica_id, nombre) VALUES (:clinica_id, :nombre)
ON CONFLICT (clinica_id, nombre) DO UPDATE SET nombre = EXCLUDED.nombre
RETURNING id;

-- name: seed_especialidad
INSERT INTO especialidades (clinica_id, nombre) VALUES (:clinica_id, :nombre)
ON CONFLICT (clinica_id, nombre) DO UPDATE SET nombre = EXCLUDED.nombre
RETURNING id;

-- name: seed_profesional_existente
SELECT id FROM profesionales WHERE clinica_id = :clinica_id AND nombre = :nombre;

-- name: seed_profesional
INSERT INTO profesionales (clinica_id, sede_id, especialidad_id, nombre)
VALUES (:clinica_id, :sede_id, :especialidad_id, :nombre)
RETURNING id;

-- name: seed_slot
-- Un horario de 30 minutos. Si ya existe para ese profesional, no hace nada.
INSERT INTO slots (clinica_id, profesional_id, inicia_en, termina_en)
VALUES (:clinica_id, :profesional_id, :desde, :hasta)
ON CONFLICT (profesional_id, inicia_en) DO NOTHING;
