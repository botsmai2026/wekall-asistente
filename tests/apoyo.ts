// Apoyo común de los tests. Todo corre contra PostgreSQL real, con el mismo
// esquema y las mismas sentencias que la aplicación. Lo único falso es lo
// externo: el modelo, los embeddings, el almacén de trazas y el reloj.
import { fileURLToPath } from 'node:url';
import { LIMITES_POR_DEFECTO, type Limites } from '../src/config.js';
import type { Dependencias } from '../src/aplicacion/intento.js';
import { recibirMensaje } from '../src/aplicacion/webhook.js';
import { EmbeddingsFalsos, ModeloConGuion, type Paso } from '../src/infraestructura/falsos.js';
import { BaseDeDatos } from '../src/infraestructura/postgres.js';
import { RelojFijo } from '../src/infraestructura/reloj.js';
import { ingerirCarpeta, sembrar } from '../src/preparar.js';
import { URL_PRUEBAS } from './preparar-base.js';

export const base = BaseDeDatos.conectar(URL_PRUEBAS, 12);

/** El instante del enunciado: 03:40 UTC del 6 de octubre = lunes 5 de octubre, 10:40 p. m. en Cali. */
export const INSTANTE = new Date('2026-10-06T03:40:00Z');

export const TELEFONO = '+573001112233';

export interface Escenario {
  clinicaId: number;
  reloj: RelojFijo;
  embeddings: EmbeddingsFalsos;
  limites: Limites;
  /** Dependencias del worker con un modelo que sigue el guion dado. */
  con(...pasos: Paso[]): Dependencias & { modelo: ModeloConGuion };
  enviar(texto: string, messageId: string, telefono?: string): Promise<string>;
}

let contador = 0;

/** Base limpia con la clínica de ejemplo, su agenda y sus documentos. */
export async function escenario(): Promise<Escenario> {
  await base.pool.query(
    'TRUNCATE trazas_pendientes, citas, mensajes_entrantes, conversaciones, fragmentos_conocimiento, documento_lineas, documentos, slots, profesionales, especialidades, sedes, clinicas RESTART IDENTITY CASCADE',
  );
  const reloj = new RelojFijo(INSTANTE);
  const embeddings = new EmbeddingsFalsos();
  const clinicaId = await sembrar(base, reloj.ahora());
  const registro = console.log;
  console.log = () => {};
  await ingerirCarpeta(base, embeddings, clinicaId, fileURLToPath(new URL('../conocimiento/', import.meta.url)));
  console.log = registro;
  const limites: Limites = { ...LIMITES_POR_DEFECTO, umbralSimilitud: 0.15 };
  return {
    clinicaId, reloj, embeddings, limites,
    con: (...pasos) => ({ base, reloj, embeddings, limites, modelo: new ModeloConGuion(...pasos) }),
    enviar: async (texto, messageId, telefono = TELEFONO) => {
      contador += 1;
      return recibirMensaje(base, reloj, clinicaId, limites.mensajesPorMinuto, { message_id: messageId, from: telefono, text: texto, timestamp: reloj.ahora().toISOString() });
    },
  };
}

export async function mensaje(messageId: string) {
  const { rows } = await base.pool.query('SELECT * FROM mensajes_entrantes WHERE message_id = $1', [messageId]);
  return rows[0];
}
export async function conversacion(telefono = TELEFONO) {
  const { rows } = await base.pool.query('SELECT * FROM conversaciones WHERE telefono = $1', [telefono]);
  return rows[0];
}
export async function citas() {
  const { rows } = await base.pool.query('SELECT ci.*, s.inicia_en FROM citas ci JOIN slots s ON s.id = ci.slot_id ORDER BY ci.id');
  return rows;
}
export async function trazas(messageId: string) {
  const { rows } = await base.pool.query('SELECT intento, documento FROM trazas_pendientes WHERE message_id = $1 ORDER BY intento', [messageId]);
  return rows.map((r) => r.documento);
}
/** Todas las líneas del contenido canónico de la clínica. */
export async function lineasCanonicas(): Promise<Set<string>> {
  const { rows } = await base.pool.query('SELECT texto FROM documento_lineas');
  return new Set(rows.map((r) => r.texto));
}
