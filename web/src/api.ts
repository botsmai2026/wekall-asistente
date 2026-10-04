// Llamadas a la API y los tipos de lo que devuelve.
export type Estado = 'en_curso' | 'resuelta_por_ia' | 'cita_agendada' | 'escalada';

export interface Conversacion {
  id: number;
  telefono: string;
  estado: Estado;
  motivo_escalamiento: string | null;
  ultima_actividad: string;
}

export interface Llamada {
  herramienta: string;
  argumentos: unknown;
  resultado: unknown;
  real?: unknown;
  ms: number;
}

export interface Intento {
  intento: number;
  tipo: string;
  motivo: string | null;
  modelo: string | null;
  tokens_entrada: number;
  tokens_salida: number;
  tokens_entrada_en_cache?: number;
  latencia_ms: number;
  llamadas: Llamada[];
  resultado_procesamiento: string;
  error: string | null;
  origen: 'mongo' | 'outbox';
}

export interface Mensaje {
  message_id: string;
  texto: string;
  enviado_en: string;
  estado: 'pendiente' | 'procesando' | 'procesado' | 'fallido';
  respuesta_tipo: string | null;
  respuesta_texto: string | null;
  intentos: Intento[];
}

export interface Detalle {
  conversacion: Conversacion;
  mensajes: Mensaje[];
  mongo_disponible: boolean;
}

async function leer<T>(url: string): Promise<T> {
  const respuesta = await fetch(url);
  if (!respuesta.ok) throw new Error(`${respuesta.status}`);
  return respuesta.json() as Promise<T>;
}

export const listar = (estado: Estado | '') => leer<Conversacion[]>(`/api/conversaciones${estado ? `?estado=${estado}` : ''}`);
export const detallar = (id: number) => leer<Detalle>(`/api/conversaciones/${id}`);

/** Simula el webhook de WhatsApp. Devuelve el código HTTP. */
export async function enviarMensaje(telefono: string, texto: string): Promise<number> {
  const respuesta = await fetch('/webhooks/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message_id: `sim-${crypto.randomUUID()}`, from: telefono, text: texto, timestamp: new Date().toISOString() }),
  });
  return respuesta.status;
}
