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
  horario: 'Indíqueme el número de la opción que prefiere.',
};

/** "El horario de las 8:00 a. m. del martes 6 de octubre de 2026 que eligió ya no está disponible." */
function avisoHorarioPerdido(perdido: Date, zona: string): string {
  return `El horario de las ${escribirHora(perdido, zona)} del ${escribirFecha(fechaLocalDe(perdido, zona))} que eligió ya no está disponible.`;
}

function lineaHorario(numero: number, h: HorarioParaMostrar, zona: string): string {
  const fecha = escribirFecha(fechaLocalDe(h.iniciaEn, zona));
  return `${numero}. ${fecha}, ${escribirHora(h.iniciaEn, zona)}, con ${h.profesional}, sede ${h.sede}`;
}

export function ofertaHorarios(especialidad: string, horarios: HorarioParaMostrar[], zona: string, perdido: Date | null = null): string {
  const lineas = horarios.map((h, i) => lineaHorario(i + 1, h, zona));
  // Si el paciente había elegido un horario que ya no está, se le dice cuál antes de ofrecer otros.
  const aviso = perdido ? [avisoHorarioPerdido(perdido, zona)] : [];
  // Toda reserva requiere una elección por número, incluso cuando hay una sola opción.
  const cierre = 'Indíqueme el número de la opción que prefiere y la agendo.';
  return [...aviso, `Estos son los horarios disponibles para ${especialidad}:`, ...lineas, cierre].join('\n');
}

/**
 * El paciente contestó a una oferta sin dar un número ("ese", "el último"). Se le
 * vuelve a mostrar la lista, solo con los horarios que siguen libres y renumerada.
 */
export function reofertaHorarios(especialidad: string, horarios: HorarioParaMostrar[], zona: string): string {
  return `Para agendar necesito el número de la opción.\n${ofertaHorarios(especialidad, horarios, zona)}`;
}

/** Nueva oferta de candidatos: numeración y slots se persisten juntos. */
export function aclararHorario(coincidencias: (HorarioParaMostrar & { numero: number })[], zona: string): string {
  return [
    'Estos son los horarios que coinciden con la búsqueda:',
    ...coincidencias.map((c) => lineaHorario(c.numero, c, zona)),
    'Indíqueme el número de la opción que prefiere y la agendo.',
  ].join('\n');
}

export function sinDisponibilidad(especialidad: string, fecha: FechaLocal, sede: string | null, zona: string, perdido: Date | null = null): string {
  const donde = sede ? ` en la sede ${sede}` : '';
  const texto = `No hay horarios disponibles de ${especialidad} para el ${escribirFecha(fecha)}${donde}. Si lo desea, puedo buscar en otra fecha.`;
  // Sin este aviso, el paciente creería que su elección se ignoró.
  return perdido ? `${avisoHorarioPerdido(perdido, zona)}\n${texto}` : texto;
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
