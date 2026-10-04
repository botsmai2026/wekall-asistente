// Toda la configuración sale de variables de entorno y se lee una sola vez.
// Los valores por defecto son los de la arquitectura; cada uno dice qué evita.
function numero(nombre: string, porDefecto: number): number {
  const crudo = process.env[nombre];
  if (crudo === undefined || crudo === '') return porDefecto;
  const valor = Number(crudo);
  if (!Number.isFinite(valor)) throw new Error(`La variable ${nombre} debe ser un número`);
  return valor;
}
function texto(nombre: string, porDefecto: string): string {
  const crudo = process.env[nombre];
  return crudo === undefined || crudo === '' ? porDefecto : crudo;
}

export interface Configuracion {
  postgresUrl: string;
  mongoUrl: string;
  mongoBase: string;
  puerto: number;
  /** Clínica a la que pertenecen los mensajes que entran por el webhook. */
  clinicaId: number;
  openaiApiKey: string;
  modeloLenguaje: string;
  modeloEmbeddings: string;
  /** Ventana de contexto del modelo configurado, en tokens. La comprueba el adaptador al arrancar. */
  ventanaContextoTokens: number;
  temperatura: number | null;
  /** Para modelos con razonamiento: nivel a enviar (p. ej. "none"). Vacío = no se envía. */
  esfuerzoRazonamiento: string | null;
  /** Mensajes que un proceso del worker atiende a la vez. */
  concurrenciaWorker: number;
  limites: Limites;
}

export interface Limites {
  maxIntentos: number; // intentos con el modelo antes del respaldo
  maxIteraciones: number; // vueltas del ciclo por intento: evita ciclos sin fin
  plazoIntentoMs: number; // plazo total del intento: debe quedar bajo el candado de 120 s
  limiteLlamadaModeloMs: number; // una llamada colgada no consume todo el plazo
  limiteEmbeddingsMs: number;
  maxTokensSalida: number; // tope de costo por llamada
  maxCaracteresEntrada: number; // tope de lo que se envía al modelo
  turnosDeContexto: number;
  umbralSimilitud: number; // bajo este valor, un fragmento no cuenta como respaldo
  horizonteAgendaDias: number;
  maxPorClinica: number; // conversaciones en proceso por clínica
  mensajesPorMinuto: number;
  esperaSinTrabajoMs: number;
  /** Espera antes de reintentar, según el número del intento que falló. */
  esperasReintentoMs: number[];
}

export const LIMITES_POR_DEFECTO: Limites = {
  maxIntentos: 3,
  maxIteraciones: 5,
  plazoIntentoMs: 60_000,
  limiteLlamadaModeloMs: 20_000,
  limiteEmbeddingsMs: 10_000,
  maxTokensSalida: 400,
  maxCaracteresEntrada: 24_000,
  turnosDeContexto: 10,
  umbralSimilitud: 0.3,
  horizonteAgendaDias: 60,
  maxPorClinica: 5,
  mensajesPorMinuto: 20,
  esperaSinTrabajoMs: 1000,
  esperasReintentoMs: [5_000, 20_000, 0],
};

export function leerConfiguracion(): Configuracion {
  const temperatura = process.env.OPENAI_TEMPERATURA;
  return {
    postgresUrl: texto('POSTGRES_URL', 'postgres://postgres:postgres@localhost:5432/asistente'),
    mongoUrl: texto('MONGO_URL', 'mongodb://localhost:27017'),
    mongoBase: texto('MONGO_BASE', 'asistente'),
    puerto: numero('PUERTO', 3000),
    clinicaId: numero('CLINICA_ID', 1),
    openaiApiKey: texto('OPENAI_API_KEY', ''),
    modeloLenguaje: texto('OPENAI_MODELO', 'gpt-4o-mini'),
    modeloEmbeddings: texto('OPENAI_MODELO_EMBEDDINGS', 'text-embedding-3-small'),
    ventanaContextoTokens: numero('OPENAI_VENTANA_CONTEXTO', 128_000),
    temperatura: temperatura === undefined || temperatura === '' ? 0.1 : temperatura === 'ninguna' ? null : Number(temperatura),
    esfuerzoRazonamiento: texto('OPENAI_ESFUERZO_RAZONAMIENTO', '') || null,
    concurrenciaWorker: numero('WORKER_CONCURRENCIA', 4),
    limites: {
      ...LIMITES_POR_DEFECTO,
      maxTokensSalida: numero('MAX_TOKENS_SALIDA', LIMITES_POR_DEFECTO.maxTokensSalida),
      maxCaracteresEntrada: numero('MAX_CARACTERES_ENTRADA', LIMITES_POR_DEFECTO.maxCaracteresEntrada),
      turnosDeContexto: numero('TURNOS_DE_CONTEXTO', LIMITES_POR_DEFECTO.turnosDeContexto),
      umbralSimilitud: numero('UMBRAL_SIMILITUD', LIMITES_POR_DEFECTO.umbralSimilitud),
      maxPorClinica: numero('MAX_POR_CLINICA', LIMITES_POR_DEFECTO.maxPorClinica),
    },
  };
}
