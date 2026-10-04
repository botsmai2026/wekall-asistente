// Los "puertos" son las tres cosas externas que la lógica del asistente
// necesita, descritas como interfaces. La lógica no sabe quién está detrás.
//
// Por qué: los tests no pueden depender de OpenAI (cuesta, tarda y responde
// distinto cada vez), y la lógica de negocio no debe cambiar si mañana se
// cambia de proveedor. La implementación real está en src/infraestructura/openai.ts
// y las de prueba en src/infraestructura/falsos.ts.

/** Definición de una herramienta tal como se le presenta al modelo. */
export interface DefinicionHerramienta {
  nombre: string;
  descripcion: string;
  /** JSON Schema de los argumentos. Es el mismo objeto con el que el código valida. */
  esquema: object;
}

export type MensajeModelo =
  | { rol: 'sistema'; contenido: string }
  | { rol: 'paciente'; contenido: string }
  | { rol: 'asistente'; contenido: string }
  /** El modelo pidió usar una herramienta. `argumentosCrudos` es el texto tal como lo escribió. */
  | { rol: 'llamada'; id: string; herramienta: string; argumentosCrudos: string }
  /** Lo que el código le contesta al modelo por esa llamada. */
  | { rol: 'resultado'; id: string; contenido: string };

export interface RespuestaModelo {
  /** Presente si el modelo pidió una herramienta. */
  llamada?: { id: string; herramienta: string; argumentosCrudos: string };
  /** Texto libre del modelo. No llega nunca al paciente. */
  texto?: string;
  modelo: string;
  tokensEntrada: number;
  tokensSalida: number;
  /** De los tokens de entrada, cuántos cobró el proveedor como leídos de caché. Si no lo informa, se omite. */
  tokensEntradaEnCache?: number;
}

export interface OpcionesLlamada {
  limiteMs: number;
  maxTokensSalida: number;
}

export interface ModeloLenguaje {
  /** Lanza ErrorInfraestructura si el proveedor falla, y ErrorLogico('entrada_excedida') si rechaza por tamaño. */
  completar(mensajes: MensajeModelo[], herramientas: DefinicionHerramienta[], opciones: OpcionesLlamada): Promise<RespuestaModelo>;
}

export interface GeneradorEmbeddings {
  /** Nombre del modelo: se guarda con cada fragmento y la búsqueda filtra por él. */
  readonly modelo: string;
  /** Lanza ErrorInfraestructura si el servicio falla. */
  generar(textos: string[], limiteMs: number): Promise<number[][]>;
}

/** Una traza: el registro de un intento. Ver src/aplicacion/traza.ts. */
export type DocumentoTraza = Record<string, unknown> & { message_id: string; intento: number };

export class TrazaRechazada extends Error {}

export interface AlmacenTrazas {
  /**
   * Guarda una traza. Si ya existía (misma clave), lo trata como éxito.
   * Lanza TrazaRechazada si el almacén rechaza ESTE documento, y
   * ErrorInfraestructura si el almacén no responde.
   */
  guardar(traza: DocumentoTraza): Promise<void>;
  deConversacion(clinicaId: number, conversacionId: number): Promise<DocumentoTraza[]>;
  /** true si responde. Nunca lanza. */
  disponible(): Promise<boolean>;
}
