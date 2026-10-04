// Lo que el código sabe de un intento mientras lo ejecuta.
//
// Un "intento" es una ejecución del worker sobre un mensaje. Todo lo que hay
// aquí vive en memoria y muere con el intento: las etiquetas F y H que ve el
// modelo solo valen dentro de él. Si el intento se repite, se consulta todo de nuevo.
import type { Limites } from '../config.js';
import type { BaseDeDatos } from '../infraestructura/postgres.js';
import type { Reloj } from '../infraestructura/reloj.js';
import type { GeneradorEmbeddings, ModeloLenguaje } from './puertos.js';
import type { CitaParaMostrar } from '../dominio/plantillas.js';
import type { FechaLocal } from '../dominio/fechas.js';
import type { TipoRespuesta } from '../dominio/estados.js';
import { LIMITE_TRANSACCION_MS } from '../infraestructura/postgres.js';

export interface Dependencias {
  base: BaseDeDatos;
  reloj: Reloj;
  modelo: ModeloLenguaje;
  embeddings: GeneradorEmbeddings;
  limites: Limites;
}

/** Plazo total del intento, medido con un reloj que no retrocede. */
export class Plazo {
  private readonly venceEn: number;
  constructor(private readonly reloj: Reloj, duracionMs: number) {
    this.venceEn = reloj.monotonicoMs() + duracionMs;
  }
  restanteMs(): number {
    return this.venceEn - this.reloj.monotonicoMs();
  }
  /** El menor entre el límite propio de una operación y lo que queda del plazo. */
  limitePara(propioMs: number): number {
    return Math.max(1, Math.min(propioMs, this.restanteMs()));
  }
  paraBase(): number {
    return this.limitePara(LIMITE_TRANSACCION_MS);
  }
}

/** Datos del mensaje y de su clínica. Vienen del webhook y de la base, nunca del modelo. */
export interface ContextoIntento {
  messageId: string;
  intento: number;
  conversacionId: number;
  clinicaId: number;
  telefono: string;
  texto: string;
  enviadoEn: Date;
  nombreClinica: string;
  zona: string;
  sedes: { id: number; nombre: string }[];
  especialidades: { id: number; nombre: string }[];
  plazo: Plazo;
}

export interface LineaRecuperada {
  documentoId: number;
  numero: number;
  encabezado: number; // número de la línea del encabezado de su sección
  texto: string;
}

export interface HorarioOfrecido {
  slotId: number;
  iniciaEn: Date;
  profesional: string;
  sede: string;
  especialidad: string;
}

/** Memoria del intento: a qué dato real corresponde cada etiqueta que vio el modelo. */
export class MemoriaIntento {
  readonly lineas = new Map<string, LineaRecuperada>(); // "F1.2" → línea
  readonly ordenDocumentos: number[] = []; // documentos en el orden en que se recuperaron
  readonly horarios = new Map<string, HorarioOfrecido>(); // "H3" → horario
  fragmentosVistos = 0;
  /** Búsquedas de conocimiento completadas en este intento. */
  busquedas = 0;
  ultimaConsulta: { especialidad: string; sede: string | null; fecha: FechaLocal; vacia: boolean } | null = null;
  citaCreada: CitaParaMostrar | null = null;
}

/** Cómo termina un turno: qué recibe el paciente y qué pasa con la conversación. */
export interface ResultadoTurno {
  tipo: TipoRespuesta;
  texto: string;
  /** Solo si el turno escala la conversación. */
  motivoEscalamiento?: string;
}

/** El intento ya no es el vigente: otro worker tomó el mensaje. Hay que detenerse sin tocar nada. */
export class IntentoVencido extends Error {
  constructor() {
    super('intento_vencido');
  }
}
