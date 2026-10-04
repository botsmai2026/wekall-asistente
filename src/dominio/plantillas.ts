// Todo texto que recibe el paciente sale de aquí o es una línea literal de un
// documento de la clínica. El modelo nunca redacta lo que el paciente lee:
// elige un tipo de respuesta y entrega datos (etiquetas), y el código escribe.
//
// Por qué: así una respuesta no puede contener un horario, una fecha o una
// política que no exista. El costo es que las respuestas son menos naturales.
import { escribirFecha, escribirHora, fechaLocalDe, type FechaLocal } from './fechas.js';

export interface HorarioParaMostrar {
  iniciaEn: Date;
  profesional: string;
  sede: string;
}

export interface CitaParaMostrar extends HorarioParaMostrar {
  especialidad: string;
}

export const FALTANTES = ['especialidad', 'sede', 'fecha', 'horario', 'intencion'] as const;
export type Faltante = (typeof FALTANTES)[number];

const PREGUNTA_POR_FALTANTE: Record<Faltante, string> = {
  intencion: '¿En qué le puedo ayudar? Puedo darle información de la clínica o agendar una cita.',
  especialidad: '¿Para qué especialidad desea la cita?',
  sede: '¿En cuál sede prefiere ser atendido?',
  fecha: '¿Para qué día desea la cita? Por favor indíqueme una fecha concreta, por ejemplo "mañana", "el viernes" o "el 15 de octubre".',
  horario: '¿Cuál de los horarios disponibles prefiere?',
};

export function ofertaHorarios(especialidad: string, horarios: HorarioParaMostrar[], zona: string): string {
  const lineas = horarios.map((h, i) => {
    const fecha = escribirFecha(fechaLocalDe(h.iniciaEn, zona));
    return `${i + 1}. ${fecha}, ${escribirHora(h.iniciaEn, zona)}, con ${h.profesional}, sede ${h.sede}`;
  });
  return [`Estos son los horarios disponibles para ${especialidad}:`, ...lineas, 'Indíqueme cuál prefiere y lo agendo.'].join('\n');
}

export function sinDisponibilidad(especialidad: string, fecha: FechaLocal, sede: string | null): string {
  const donde = sede ? ` en la sede ${sede}` : '';
  return `No hay horarios disponibles de ${especialidad} para el ${escribirFecha(fecha)}${donde}. Si lo desea, puedo buscar en otra fecha.`;
}

export function confirmacionCita(cita: CitaParaMostrar, zona: string): string {
  const fecha = escribirFecha(fechaLocalDe(cita.iniciaEn, zona));
  return `Su cita quedó agendada: ${cita.especialidad} con ${cita.profesional}, el ${fecha} a las ${escribirHora(cita.iniciaEn, zona)}, en la sede ${cita.sede}.`;
}

export function preguntaAclaratoria(faltantes: Faltante[]): string {
  // Si falta la intención, las demás preguntas no tienen sentido todavía.
  if (faltantes.includes('intencion')) return PREGUNTA_POR_FALTANTE.intencion;
  return [...new Set(faltantes)].map((f) => PREGUNTA_POR_FALTANTE[f]).join('\n');
}

export const SIN_INFORMACION =
  'No tengo esa información en los documentos de la clínica. Si lo desea, puedo pasar su conversación a un asesor.';

export const ESCALAMIENTO = 'Voy a pasar su conversación a un asesor de la clínica, que le responderá por este medio.';

export const RESPALDO_REINTENTOS =
  'En este momento no puedo procesar su mensaje. Un asesor de la clínica continuará la conversación por este medio.';

export const RESPALDO_YA_ESCALADA = 'Su conversación ya está con un asesor de la clínica, que le responderá por este medio.';
