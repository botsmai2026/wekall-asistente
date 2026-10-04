// Versiones de prueba de las dependencias externas. Los tests las usan para no
// depender de OpenAI ni de Mongo: son rápidas, gratis y siempre responden igual.
import { createHash } from 'node:crypto';
import { ErrorInfraestructura } from '../dominio/errores.js';
import type {
  AlmacenTrazas, DefinicionHerramienta, DocumentoTraza, GeneradorEmbeddings, MensajeModelo, ModeloLenguaje, OpcionesLlamada, RespuestaModelo,
} from '../aplicacion/puertos.js';
import { TrazaRechazada } from '../aplicacion/puertos.js';

/** Un paso del guion: qué "responde" el modelo falso en una llamada. */
export type Paso =
  | { herramienta: string; argumentos: unknown }
  | { texto: string }
  | { falla: Error }
  /** Decide según lo que recibió: sirve para usar etiquetas que solo se conocen durante el turno. */
  | ((mensajes: MensajeModelo[]) => Paso);

/** Modelo falso que sigue un guion, paso a paso. Guarda lo que recibió para poder comprobarlo. */
export class ModeloConGuion implements ModeloLenguaje {
  readonly recibido: { mensajes: MensajeModelo[]; herramientas: DefinicionHerramienta[]; opciones: OpcionesLlamada }[] = [];
  private readonly pasos: Paso[];
  constructor(...pasos: Paso[]) {
    this.pasos = pasos;
  }
  agregar(...pasos: Paso[]): void {
    this.pasos.push(...pasos);
  }
  get llamadas(): number {
    return this.recibido.length;
  }
  async completar(mensajes: MensajeModelo[], herramientas: DefinicionHerramienta[], opciones: OpcionesLlamada): Promise<RespuestaModelo> {
    this.recibido.push({ mensajes: structuredClone(mensajes), herramientas, opciones });
    let paso = this.pasos.shift();
    if (!paso) throw new Error('El guion del modelo falso se quedó sin pasos');
    while (typeof paso === 'function') paso = paso(mensajes);
    if ('falla' in paso) throw paso.falla;
    const medicion = { modelo: 'modelo-falso', tokensEntrada: 100, tokensSalida: 10 };
    if ('texto' in paso) return { texto: paso.texto, ...medicion };
    return { llamada: { id: `llamada_${this.recibido.length}`, herramienta: paso.herramienta, argumentosCrudos: JSON.stringify(paso.argumentos) }, ...medicion };
  }
}

/** Último resultado de herramienta que recibió el modelo, ya interpretado. */
export function ultimoResultado(mensajes: MensajeModelo[]): any {
  const ultimo = [...mensajes].reverse().find((m) => m.rol === 'resultado');
  return ultimo && ultimo.rol === 'resultado' ? JSON.parse(ultimo.contenido) : null;
}

const DIMENSION = 1536;

/**
 * Embeddings falsos y deterministas: cada palabra suma en una posición del
 * vector que sale de su hash. Dos textos con palabras en común quedan cerca.
 * Sirve para probar el recorrido de la búsqueda, no la calidad semántica.
 */
export class EmbeddingsFalsos implements GeneradorEmbeddings {
  caido = false;
  constructor(readonly modelo = 'embeddings-falsos') {}
  async generar(textos: string[]): Promise<number[][]> {
    if (this.caido) throw new ErrorInfraestructura('Servicio de embeddings caído (simulado)');
    return textos.map((texto) => {
      const vector = new Array<number>(DIMENSION).fill(0);
      const palabras = texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
      for (const palabra of palabras) {
        const posicion = createHash('sha256').update(palabra).digest().readUInt32BE(0) % DIMENSION;
        vector[posicion] = (vector[posicion] ?? 0) + 1;
      }
      const norma = Math.sqrt(vector.reduce((s, v) => s + v * v, 0)) || 1;
      return vector.map((v) => v / norma);
    });
  }
}

/** Almacén de trazas en memoria, con los mismos comportamientos que el de Mongo. */
export class AlmacenTrazasEnMemoria implements AlmacenTrazas {
  readonly trazas = new Map<string, DocumentoTraza>();
  caido = false;
  /** message_id que el almacén rechaza siempre (simula un documento inválido). */
  readonly rechazar = new Set<string>();
  async guardar(traza: DocumentoTraza): Promise<void> {
    if (this.caido) throw new ErrorInfraestructura('Almacén de trazas caído (simulado)');
    if (this.rechazar.has(traza.message_id)) throw new TrazaRechazada('Documento rechazado (simulado)');
    const clave = `${traza.message_id}#${traza.intento}`;
    if (!this.trazas.has(clave)) this.trazas.set(clave, traza); // clave duplicada = éxito, sin modificar
  }
  async deConversacion(clinicaId: number, conversacionId: number): Promise<DocumentoTraza[]> {
    if (this.caido) throw new ErrorInfraestructura('Almacén de trazas caído (simulado)');
    return [...this.trazas.values()].filter((t) => t.clinica_id === clinicaId && t.conversacion_id === conversacionId);
  }
  async disponible(): Promise<boolean> {
    return !this.caido;
  }
}
