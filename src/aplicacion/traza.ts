// La traza es el registro de un intento: qué modelo se usó, cuántos tokens,
// cuánto tardó, qué herramientas pidió con qué argumentos y qué devolvieron.
// Es lo que le permite a un coordinador (o a quien depure) entender por qué el
// asistente respondió lo que respondió.
//
// Se va llenando durante el intento y se guarda al final, pase lo que pase:
// si el intento termina, si falla, o si lo descarta la protección contra
// workers tardíos. Un intento fallido también costó dinero y también explica algo.
import type { DocumentoTraza } from './puertos.js';
import type { ContextoIntento } from './intento.js';

export type TipoTraza = 'llm' | 'recuperacion_cita' | 'respaldo';
export type ResultadoProcesamiento = 'completado' | 'fallido' | 'descartado_por_intento';

export interface LlamadaRegistrada {
  herramienta: string;
  argumentos: unknown;
  resultado: unknown;
  /** Identificadores reales detrás de las etiquetas que vio el modelo. */
  real?: unknown;
  ms: number;
}

const MAXIMO_BYTES = 60_000; // la base rechaza más de 64 KB; se deja margen
const MAXIMO_TEXTO = 2_000;

export class Traza {
  tipo: TipoTraza = 'llm';
  motivo: string | null = null;
  modelo: string | null = null;
  tokensEntrada = 0;
  tokensSalida = 0;
  tokensEntradaEnCache = 0;
  llamadasAlModelo = 0;
  readonly llamadas: LlamadaRegistrada[] = [];
  textoAsistente: string | null = null;
  resultado: { tipo: string; estado_conversacion: string | null } | null = null;
  error: string | null = null;
  private readonly inicioMs: number;

  constructor(private readonly contexto: Pick<ContextoIntento, 'messageId' | 'intento' | 'clinicaId' | 'conversacionId' | 'texto'>, private readonly relojMs: () => number, private readonly creadoEn: Date) {
    this.inicioMs = relojMs();
  }

  documento(resultadoProcesamiento: ResultadoProcesamiento): DocumentoTraza {
    const base = {
      message_id: this.contexto.messageId,
      intento: this.contexto.intento,
      clinica_id: this.contexto.clinicaId,
      conversacion_id: this.contexto.conversacionId,
      creado_en: this.creadoEn.toISOString(),
      tipo: this.tipo,
      motivo: this.motivo,
      texto_paciente: this.contexto.texto,
      texto_asistente: this.textoAsistente,
      modelo: this.modelo,
      tokens_entrada: this.tokensEntrada,
      tokens_salida: this.tokensSalida,
      tokens_entrada_en_cache: this.tokensEntradaEnCache,
      llamadas_al_modelo: this.llamadasAlModelo,
      latencia_ms: Math.round(this.relojMs() - this.inicioMs),
      resultado: this.resultado,
      resultado_procesamiento: resultadoProcesamiento,
      error: this.error,
    };
    // Tope de tamaño: primero se recortan los textos largos; si aun así no cabe,
    // se guardan las llamadas sin su resultado. La medición nunca se pierde.
    const recortadas = this.llamadas.map((l) => recortar(l) as LlamadaRegistrada);
    let documento: DocumentoTraza = { ...base, llamadas: recortadas };
    if (Buffer.byteLength(JSON.stringify(documento)) > MAXIMO_BYTES) {
      documento = { ...base, llamadas: recortadas.map((l) => ({ herramienta: l.herramienta, argumentos: l.argumentos, ms: l.ms, resultado: '[omitido por tamaño]' })), traza_recortada: true };
    }
    return documento;
  }
}

function recortar(valor: unknown): unknown {
  if (typeof valor === 'string') return valor.length > MAXIMO_TEXTO ? `${valor.slice(0, MAXIMO_TEXTO)}… [recortado]` : valor;
  if (valor instanceof Date) return valor.toISOString();
  if (Array.isArray(valor)) return valor.map(recortar);
  if (valor && typeof valor === 'object') return Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, recortar(v)]));
  return valor;
}
