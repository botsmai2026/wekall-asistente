// Acceso a PostgreSQL. Dos reglas de la arquitectura viven aquí, en un solo lugar:
//
// 1. Aislamiento. Toda transacción se abre como READ COMMITTED de forma
//    explícita. Varios protocolos (el tope por clínica, la protección contra
//    workers tardíos) bloquean y luego leen en otra sentencia, contando con que
//    esa lectura ve lo que se confirmó mientras esperaban. En otro nivel de
//    aislamiento eso es falso. Como esta es la única función que abre
//    transacciones, nadie puede abrir una con otro nivel por descuido.
//
// 2. Límite de tiempo. Cada transacción recibe un máximo en milisegundos, que
//    se aplica tanto a ejecutar una sentencia como a esperar un bloqueo. Así
//    una base lenta no deja colgado al worker más allá de su plazo.
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { cargarSentencias, valoresDe, type Sentencia } from './consultas.js';

// Postgres devuelve bigint y count(*) como texto, porque pueden no caber en un
// número de JavaScript. Nuestros identificadores y conteos caben de sobra.
pg.types.setTypeParser(20, (valor) => Number(valor));

const CARPETA_SQL = fileURLToPath(new URL('../../sql/', import.meta.url));
const SENTENCIAS: Map<string, Sentencia> = cargarSentencias(
  `${CARPETA_SQL}consultas.sql`,
  `${CARPETA_SQL}ingestion.sql`,
  `${CARPETA_SQL}seed.sql`,
);

export type Fila = Record<string, any>;

/** Lo que puede hacer el código dentro de una transacción: ejecutar sentencias por nombre. */
export interface Transaccion {
  ejecutar(nombre: string, valores?: Record<string, unknown>): Promise<Fila[]>;
}

export const LIMITE_TRANSACCION_MS = 5000;

export class BaseDeDatos {
  constructor(readonly pool: pg.Pool) {}

  static conectar(url: string, maximoConexiones = 10): BaseDeDatos {
    const pool = new pg.Pool({ connectionString: url, max: maximoConexiones });
    // Una conexión en reposo que se cae (reinicio de Postgres, corte de red) emite
    // un evento de error. Sin alguien que lo escuche, Node termina el proceso.
    // Aquí solo se registra: el pool descarta esa conexión y abre otra cuando haga falta.
    pool.on('error', (error) => console.error('PostgreSQL: se perdió una conexión en reposo', error.message));
    return new BaseDeDatos(pool);
  }

  /**
   * Ejecuta `trabajo` dentro de una transacción. Si `trabajo` termina, confirma;
   * si lanza un error, revierte y relanza el error.
   * `trabajo` puede pedir revertir sin error devolviendo `revertir(valor)`.
   */
  async enTransaccion<T>(trabajo: (tx: Transaccion) => Promise<T | Revertir<T>>, limiteMs = LIMITE_TRANSACCION_MS): Promise<T> {
    const cliente = await this.pool.connect();
    let descartarConexion = false;
    // Lo mismo para una conexión en uso: si Postgres la corta (por ejemplo, por
    // inactividad dentro de una transacción), la sentencia en curso falla con su
    // propio error; este oyente evita que además se caiga el proceso.
    const alPerderse = () => {
      descartarConexion = true;
    };
    cliente.on('error', alPerderse);
    try {
      const limite = Math.max(1, Math.min(Math.floor(limiteMs), LIMITE_TRANSACCION_MS));
      await cliente.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await cliente.query(`SET LOCAL statement_timeout = ${limite}`);
      await cliente.query(`SET LOCAL lock_timeout = ${limite}`);
      const resultado = await trabajo({ ejecutar: (nombre, valores = {}) => ejecutarEn(cliente, nombre, valores) });
      if (resultado instanceof Revertir) {
        await cliente.query('ROLLBACK');
        return resultado.valor;
      }
      await cliente.query('COMMIT');
      return resultado;
    } catch (error) {
      try {
        await cliente.query('ROLLBACK');
      } catch {
        descartarConexion = true; // la conexión quedó en un estado desconocido: no se reutiliza
      }
      throw error;
    } finally {
      cliente.removeListener('error', alPerderse);
      cliente.release(descartarConexion);
    }
  }

  /** Una sola sentencia de lectura, fuera de una transacción explícita. */
  async leer(nombre: string, valores: Record<string, unknown> = {}): Promise<Fila[]> {
    return this.enTransaccion((tx) => tx.ejecutar(nombre, valores));
  }

  async cerrar(): Promise<void> {
    await this.pool.end();
  }
}

/** Marca para terminar una transacción con ROLLBACK sin que sea un error. */
export class Revertir<T> {
  constructor(readonly valor: T) {}
}
export function revertir<T>(valor: T): Revertir<T> {
  return new Revertir(valor);
}

async function ejecutarEn(cliente: pg.PoolClient, nombre: string, valores: Record<string, unknown>): Promise<Fila[]> {
  const sentencia = SENTENCIAS.get(nombre);
  if (!sentencia) throw new Error(`Sentencia SQL desconocida: ${nombre}`);
  const resultado = await cliente.query(sentencia.texto, valoresDe(sentencia, valores));
  return resultado.rows;
}

export function nombresDeSentencias(): string[] {
  return [...SENTENCIAS.keys()];
}

/** Código de error de Postgres para "violación de unicidad". */
export function esViolacionDeUnicidad(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}
