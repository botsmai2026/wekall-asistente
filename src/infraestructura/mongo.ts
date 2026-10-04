// MongoDB guarda las trazas de intento. Es evidencia: "qué ocurrió y cuánto
// costó". Ninguna operación del asistente necesita que Mongo responda para ser
// correcta. El único que escribe aquí es el relevo (src/aplicacion/relevo.ts).
//
// Por qué Mongo para esto: una traza es un documento anidado y de forma
// variable (cada turno usa herramientas distintas, con argumentos distintos),
// solo se inserta, nunca se modifica, y crece rápido. No tiene relaciones que
// vigilar ni transacciones que respetar.
import { MongoClient, MongoServerError, type Collection } from 'mongodb';
import { ErrorInfraestructura } from '../dominio/errores.js';
import { TrazaRechazada, type AlmacenTrazas, type DocumentoTraza } from '../aplicacion/puertos.js';

const LIMITE_MS = 3000; // tiempo máximo de cualquier operación, incluida la conexión

export class AlmacenTrazasMongo implements AlmacenTrazas {
  private constructor(private readonly cliente: MongoClient, private readonly coleccion: Collection<DocumentoTraza>) {}

  static crear(url: string, base: string): AlmacenTrazasMongo {
    // No se conecta aquí: el driver conecta en la primera operación. Así, que
    // Mongo esté caído al arrancar no impide que la API ni el worker arranquen.
    const cliente = new MongoClient(url, {
      serverSelectionTimeoutMS: LIMITE_MS,
      timeoutMS: LIMITE_MS,
      // La fila del outbox solo se borra tras una escritura confirmada en disco.
      writeConcern: { w: 'majority', journal: true },
      retryWrites: false,
    });
    return new AlmacenTrazasMongo(cliente, cliente.db(base).collection<DocumentoTraza>('trazas_intento'));
  }

  private indicesListos = false;

  /**
   * Crea los índices si aún no se han creado en este proceso. Es idempotente.
   * Se llama antes de cada escritura: si Mongo estaba caído al arrancar, los
   * índices se crean en la primera escritura que sí llegue. Importa porque el
   * índice único es lo que hace segura la entrega repetida.
   */
  async prepararIndices(): Promise<void> {
    if (this.indicesListos) return;
    // Identidad de una traza: hace que repetir la inserción no duplique nada.
    await this.coleccion.createIndex({ message_id: 1, intento: 1 }, { unique: true });
    // Para el detalle de una conversación. La clínica va primero: ninguna consulta depende solo de un id global.
    await this.coleccion.createIndex({ clinica_id: 1, conversacion_id: 1, creado_en: 1 });
    this.indicesListos = true;
  }

  async guardar(traza: DocumentoTraza): Promise<void> {
    try {
      await this.prepararIndices();
      await this.coleccion.insertOne({ ...traza });
    } catch (causa) {
      if (causa instanceof MongoServerError && causa.code === 11000) return; // ya estaba: éxito
      if (esRechazoDelDocumento(causa)) throw new TrazaRechazada(String((causa as Error).message));
      throw new ErrorInfraestructura('Mongo no respondió', causa);
    }
  }

  // Si una lectura falla, durante 5 s no se vuelve a intentar: la pantalla de
  // detalle consulta cada 1,5 s y, con Mongo caído, cada consulta esperaría 3 s.
  private lecturasSuspendidasHasta = 0;

  async deConversacion(clinicaId: number, conversacionId: number): Promise<DocumentoTraza[]> {
    if (Date.now() < this.lecturasSuspendidasHasta) throw new ErrorInfraestructura('Mongo no respondió hace un momento');
    try {
      return await this.coleccion.find({ clinica_id: clinicaId, conversacion_id: conversacionId }, { projection: { _id: 0 } }).sort({ creado_en: 1 }).toArray();
    } catch (causa) {
      this.lecturasSuspendidasHasta = Date.now() + 5000;
      throw new ErrorInfraestructura('Mongo no respondió', causa);
    }
  }

  async disponible(): Promise<boolean> {
    try {
      await this.cliente.db('admin').command({ ping: 1 });
      return true;
    } catch {
      return false;
    }
  }

  async cerrar(): Promise<void> {
    await this.cliente.close();
  }
}

/** Mongo respondió y dijo que no a este documento (validación, tamaño, formato). Reintentar daría lo mismo. */
function esRechazoDelDocumento(causa: unknown): boolean {
  if (causa instanceof MongoServerError) {
    return [121 /* validación */, 10334 /* documento muy grande */, 2 /* valor inválido */, 14 /* tipo inválido */].includes(Number(causa.code));
  }
  const nombre = (causa as { name?: string } | null)?.name ?? '';
  return nombre === 'BSONError' || nombre === 'MongoInvalidArgumentError';
}
