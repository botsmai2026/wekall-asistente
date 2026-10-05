// Estados de una conversación, en el orden en que le importan al coordinador.
// El estado solo sube de rango: una pregunta resuelta después de agendar una
// cita no hace que la conversación deje de mostrarse como "cita agendada".
// La base impone lo mismo con un disparador; esta copia sirve para que el
// código decida sin ir a la base.
export const ESTADOS_CONVERSACION = ['en_curso', 'resuelta_por_ia', 'cita_agendada', 'escalada'] as const;
export type EstadoConversacion = (typeof ESTADOS_CONVERSACION)[number];

export function rangoEstado(estado: EstadoConversacion): number {
  return ESTADOS_CONVERSACION.indexOf(estado);
}

export type TipoRespuesta =
  | 'respuesta_documental'
  | 'oferta_horarios'
  | 'sin_disponibilidad'
  | 'confirmacion_cita'
  | 'pregunta_aclaratoria'
  | 'sin_informacion'
  | 'escalamiento'
  | 'respaldo';

/** Qué estado pide cada tipo de respuesta. null = el turno no cambia el estado. */
export function estadoQuePide(tipo: TipoRespuesta): EstadoConversacion | null {
  switch (tipo) {
    case 'respuesta_documental':
      return 'resuelta_por_ia';
    case 'confirmacion_cita':
      return 'cita_agendada';
    case 'escalamiento':
      return 'escalada';
    default:
      return null;
  }
}

/**
 * Respuestas que no cambian de tema: si llegan después de una oferta de horarios,
 * la oferta sigue esperando la elección del paciente. Cualquier otro tipo la anula.
 * La misma lista está en `agendar_validar_oferta` (sql/consultas.sql), que es la que decide al reservar.
 */
export const RESPUESTAS_QUE_CONSERVAN_LA_OFERTA: readonly TipoRespuesta[] = ['respuesta_documental', 'sin_informacion'];
