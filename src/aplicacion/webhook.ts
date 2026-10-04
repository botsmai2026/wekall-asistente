// Recepción de un mensaje. Esta función es todo lo que ocurre dentro de la
// petición HTTP: guardar el mensaje y responder. No llama al modelo ni a Mongo.
//
// Por qué: quien envía el webhook (WhatsApp, o el simulador) espera una
// respuesta en pocos segundos y, si no la recibe, reenvía. El modelo puede
// tardar mucho más. Por eso aquí solo se registra el mensaje, de forma que
// reenviarlo sea inofensivo, y el trabajo lento lo hace el worker.
import type { BaseDeDatos } from '../infraestructura/postgres.js';
import { revertir } from '../infraestructura/postgres.js';
import type { Reloj } from '../infraestructura/reloj.js';

export interface MensajeEntrante {
  message_id: string;
  from: string;
  text: string;
  timestamp: string;
}

export type ResultadoWebhook = 'aceptado' | 'duplicado' | 'conflicto' | 'limite_excedido';

export async function recibirMensaje(
  base: BaseDeDatos,
  reloj: Reloj,
  clinicaId: number,
  mensajesPorMinuto: number,
  mensaje: MensajeEntrante,
): Promise<ResultadoWebhook> {
  const ahora = reloj.ahora();
  const enviadoEn = new Date(mensaje.timestamp);
  return base.enTransaccion<ResultadoWebhook>(async (tx) => {
    // Crea la conversación o toma la existente, y bloquea su fila. Dos
    // peticiones del mismo teléfono pasan por aquí de una en una.
    const [conversacion] = await tx.ejecutar('webhook_conversacion', { clinica_id: clinicaId, telefono: mensaje.from, ahora });
    const conversacionId = conversacion!.id;

    const insertado = await tx.ejecutar('webhook_insertar_mensaje', {
      message_id: mensaje.message_id, conversacion_id: conversacionId, texto: mensaje.text, enviado_en: enviadoEn, ahora,
    });

    if (insertado.length === 0) {
      // El identificador ya existía. Solo es un duplicado si es el mismo evento.
      const [fila] = await tx.ejecutar('webhook_es_mismo_evento', {
        message_id: mensaje.message_id, conversacion_id: conversacionId, texto: mensaje.text, enviado_en: enviadoEn,
      });
      const esElMismo = fila ? Object.values(fila)[0] === true : false;
      return esElMismo ? 'duplicado' : revertir<ResultadoWebhook>('conflicto');
    }

    // Mensaje nuevo: cuenta contra el límite por teléfono (incluido él mismo).
    const [conteo] = await tx.ejecutar('webhook_contar_recientes', { conversacion_id: conversacionId, ahora });
    if (conteo!.count > mensajesPorMinuto) return revertir<ResultadoWebhook>('limite_excedido');

    await tx.ejecutar('webhook_tocar_conversacion', { conversacion_id: conversacionId, ahora });
    return 'aceptado';
  });
}
