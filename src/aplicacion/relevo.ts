// El relevo lleva las trazas de PostgreSQL a Mongo (patrón "outbox transaccional").
//
// El problema que resuelve: el cierre de un turno escribe en Postgres (la
// respuesta) y debería escribir en Mongo (la traza). No existe una transacción
// que abarque las dos bases. Si se escribiera en ambas "a mano", un fallo en
// medio dejaría una respuesta sin traza, o haría depender al paciente de Mongo.
//
// La solución: la traza se guarda en una tabla de Postgres dentro de la misma
// transacción del cierre (eso sí es atómico), y este proceso la copia a Mongo
// después. Si Mongo está caído, las trazas esperan en Postgres. Si el relevo
// muere después de escribir en Mongo y antes de borrar la fila, la reenvía y el
// índice único de Mongo la absorbe: entrega "al menos una vez" sin duplicados.
import { ErrorInfraestructura } from '../dominio/errores.js';
import type { BaseDeDatos } from '../infraestructura/postgres.js';
import { TrazaRechazada, type AlmacenTrazas, type DocumentoTraza } from './puertos.js';

export type ResultadoRelevo = 'vacio' | 'publicada' | 'rechazada';

/** Publica una traza: una transacción de Postgres por traza. Lanza ErrorInfraestructura si Mongo no responde. */
export async function relevarUna(base: BaseDeDatos, almacen: AlmacenTrazas): Promise<ResultadoRelevo> {
  return base.enTransaccion<ResultadoRelevo>(async (tx) => {
    // Protección por si el límite del driver de Mongo fallara: Postgres corta
    // esta sesión si queda inactiva dentro de la transacción.
    await tx.ejecutar('relevo_limite_inactividad');
    const [fila] = await tx.ejecutar('relevo_tomar');
    if (!fila) return 'vacio';
    const clave = { message_id: fila.message_id, intento: fila.intento };
    try {
      await almacen.guardar(fila.documento as DocumentoTraza);
    } catch (causa) {
      if (!(causa instanceof TrazaRechazada)) throw causa; // Mongo caído: revertir y no tocar la fila
      await tx.ejecutar('relevo_rechazada', { ...clave, error: causa.message.slice(0, 500) });
      return 'rechazada';
    }
    await tx.ejecutar('relevo_publicada', clave);
    return 'publicada';
  });
}

const MAXIMO_POR_CICLO = 100;

/** Publica lo que haya, hasta 100 trazas. Devuelve cuántas tomó. */
export async function relevarPendientes(base: BaseDeDatos, almacen: AlmacenTrazas): Promise<number> {
  let tomadas = 0;
  while (tomadas < MAXIMO_POR_CICLO) {
    if ((await relevarUna(base, almacen)) === 'vacio') break;
    tomadas += 1;
  }
  return tomadas;
}

/** Ciclo del relevo: cada segundo; si Mongo no responde, espera cada vez más, hasta 30 s. */
export async function cicloDelRelevo(base: BaseDeDatos, almacen: AlmacenTrazas, seguir: () => boolean): Promise<void> {
  let esperaMs = 1000;
  while (seguir()) {
    try {
      await relevarPendientes(base, almacen);
      esperaMs = 1000;
    } catch (causa) {
      esperaMs = Math.min(esperaMs * 2, 30_000);
      const motivo = causa instanceof ErrorInfraestructura ? causa.message : String(causa);
      console.error(`Relevo de trazas: no se pudo publicar (${motivo}). Reintento en ${esperaMs / 1000} s`);
    }
    await new Promise((resolver) => setTimeout(resolver, esperaMs));
  }
}
