// Prepara la base de datos: crea el esquema, carga los datos de ejemplo e
// ingiere los documentos de conocimiento. Se puede ejecutar cuantas veces se
// quiera: cada paso comprueba si ya está hecho.
//
// Uso: npm run preparar            (necesita OPENAI_API_KEY para los embeddings)
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { leerConfiguracion } from './config.js';
import { ingerirDocumento } from './aplicacion/ingestion.js';
import type { GeneradorEmbeddings } from './aplicacion/puertos.js';
import { fechaLocalDe, indiceDiaSemana, instanteDe, sumarDias } from './dominio/fechas.js';
import { EmbeddingsOpenAI } from './infraestructura/openai.js';
import { BaseDeDatos } from './infraestructura/postgres.js';

const RAIZ = fileURLToPath(new URL('../', import.meta.url));

/** Aplica el esquema una sola vez. La tabla "migraciones" recuerda qué se aplicó. */
export async function migrar(base: BaseDeDatos): Promise<boolean> {
  const cliente = await base.pool.connect();
  try {
    await cliente.query('CREATE TABLE IF NOT EXISTS migraciones (nombre text PRIMARY KEY, aplicada_en timestamptz NOT NULL DEFAULT now())');
    const nombre = '001_esquema.sql';
    const { rowCount } = await cliente.query('SELECT 1 FROM migraciones WHERE nombre = $1', [nombre]);
    if (rowCount) return false;
    await cliente.query('BEGIN');
    try {
      await cliente.query(readFileSync(`${RAIZ}sql/${nombre}`, 'utf8'));
      await cliente.query('INSERT INTO migraciones (nombre) VALUES ($1)', [nombre]);
      await cliente.query('COMMIT');
    } catch (error) {
      await cliente.query('ROLLBACK');
      throw error;
    }
    return true;
  } finally {
    cliente.release();
  }
}

export const CLINICA_DE_EJEMPLO = 'Clínica Valle Salud';
const ZONA = 'America/Bogota';
const SEDES = ['Norte', 'Sur'];
const PROFESIONALES = [
  { nombre: 'Dra. Laura Mejía', especialidad: 'Medicina general', sede: 'Norte' },
  { nombre: 'Dr. Andrés Caicedo', especialidad: 'Medicina general', sede: 'Sur' },
  { nombre: 'Dra. Paola Rengifo', especialidad: 'Pediatría', sede: 'Norte' },
  { nombre: 'Dr. Julián Ospina', especialidad: 'Pediatría', sede: 'Sur' },
  { nombre: 'Dra. Camila Torres', especialidad: 'Dermatología', sede: 'Norte' },
];
// Media hora cada cita. Lunes a viernes: 8:00–12:00 y 14:00–17:00. Sábado: 8:00–12:00.
const HORAS_MANANA = [8, 8.5, 9, 9.5, 10, 10.5, 11, 11.5];
const HORAS_TARDE = [14, 14.5, 15, 15.5, 16, 16.5];
const DIAS_DE_AGENDA = 14;

/** Clínica, sedes, especialidades, profesionales y dos semanas de agenda a partir de hoy. */
export async function sembrar(base: BaseDeDatos, ahora: Date): Promise<number> {
  return base.enTransaccion(async (tx) => {
    let [clinica] = await tx.ejecutar('seed_clinica_existente', { nombre: CLINICA_DE_EJEMPLO });
    if (!clinica) [clinica] = await tx.ejecutar('seed_clinica', { nombre: CLINICA_DE_EJEMPLO, zona_horaria: ZONA });
    const clinicaId: number = clinica!.id;

    const sedes = new Map<string, number>();
    for (const nombre of SEDES) sedes.set(nombre, (await tx.ejecutar('seed_sede', { clinica_id: clinicaId, nombre }))[0]!.id);
    const especialidades = new Map<string, number>();
    for (const nombre of new Set(PROFESIONALES.map((p) => p.especialidad))) {
      especialidades.set(nombre, (await tx.ejecutar('seed_especialidad', { clinica_id: clinicaId, nombre }))[0]!.id);
    }

    const hoy = fechaLocalDe(ahora, ZONA);
    for (const profesional of PROFESIONALES) {
      let [fila] = await tx.ejecutar('seed_profesional_existente', { clinica_id: clinicaId, nombre: profesional.nombre });
      if (!fila) {
        [fila] = await tx.ejecutar('seed_profesional', {
          clinica_id: clinicaId, sede_id: sedes.get(profesional.sede), especialidad_id: especialidades.get(profesional.especialidad), nombre: profesional.nombre,
        });
      }
      for (let d = 0; d < DIAS_DE_AGENDA; d++) {
        const dia = sumarDias(hoy, d);
        const diaSemana = indiceDiaSemana(dia); // 0 = lunes … 6 = domingo
        if (diaSemana === 6) continue;
        const horas = diaSemana === 5 ? HORAS_MANANA : [...HORAS_MANANA, ...HORAS_TARDE];
        for (const hora of horas) {
          const desde = new Date(instanteDe(dia, Math.floor(hora), ZONA).getTime() + (hora % 1) * 3_600_000);
          await tx.ejecutar('seed_slot', { clinica_id: clinicaId, profesional_id: fila!.id, desde, hasta: new Date(desde.getTime() + 30 * 60_000) });
        }
      }
    }
    return clinicaId;
  }, 5000);
}

export async function ingerirCarpeta(base: BaseDeDatos, embeddings: GeneradorEmbeddings, clinicaId: number, carpeta: string): Promise<void> {
  for (const archivo of readdirSync(carpeta).filter((a) => a.endsWith('.md')).sort()) {
    const resultado = await ingerirDocumento(base, embeddings, clinicaId, readFileSync(`${carpeta}${archivo}`, 'utf8'));
    console.log(`  ${archivo}: ${resultado}`);
  }
}

// Solo se ejecuta cuando el archivo se invoca directamente (no cuando lo importa un test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const config = leerConfiguracion();
  const base = BaseDeDatos.conectar(config.postgresUrl, 2);
  console.log((await migrar(base)) ? 'Esquema creado' : 'Esquema: ya estaba aplicado');
  const clinicaId = await sembrar(base, new Date());
  console.log(`Datos de ejemplo listos (clínica ${clinicaId})`);
  if (clinicaId !== config.clinicaId) console.warn(`ATENCIÓN: la clínica de ejemplo es la ${clinicaId} y CLINICA_ID vale ${config.clinicaId}`);
  if (!config.openaiApiKey) {
    // Sin clave no se pueden calcular embeddings. No es un error de este paso:
    // el esquema y la agenda quedan listos y la API puede arrancar. El worker sí
    // exige la clave y lo dirá al arrancar.
    console.warn('ATENCIÓN: falta OPENAI_API_KEY. No se cargaron los documentos de conocimiento.');
    await base.cerrar();
    process.exit(0);
  }
  console.log('Documentos de conocimiento:');
  try {
    await ingerirCarpeta(base, new EmbeddingsOpenAI(config.openaiApiKey, config.modeloEmbeddings), clinicaId, `${RAIZ}conocimiento/`);
  } catch (error) {
    // Con una clave inválida o sin conexión no se puede cargar el conocimiento.
    // Se termina con error a propósito: un asistente sin documentos respondería
    // "no tengo esa información" a todo, y eso sería falso.
    console.error(`No se pudieron cargar los documentos de conocimiento. Revise OPENAI_API_KEY y OPENAI_MODELO_EMBEDDINGS.\n  Causa: ${error instanceof Error ? error.message : String(error)}`);
    await base.cerrar();
    process.exit(1);
  }
  await base.cerrar();
}
