// Todo texto que recibe el paciente sale de aquí o es una línea literal de un
// documento de la clínica. El modelo nunca redacta lo que el paciente lee:
// elige un tipo de respuesta y entrega datos (etiquetas), y el código escribe.
//
// Por qué: así una respuesta no puede contener un horario, una fecha o una
// política que no exista. El costo es que las respuestas son menos naturales.
import { escribirFecha, escribirHora, fechaLocalDe, type FechaLocal, type Franja } from './fechas.js';

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

/** Toda reserva requiere una elección por número, incluso cuando hay una sola opción. */
const PEDIR_NUMERO = 'Responda con el número de la opción que prefiere.';

const PREGUNTA_POR_FALTANTE: Record<Faltante, string> = {
  intencion: '¿En qué le puedo ayudar? Puedo darle información de la clínica o agendar una cita.',
  especialidad: '¿Para qué especialidad desea la cita?',
  sede: '¿En cuál sede prefiere ser atendido?',
  fecha: '¿Para qué día desea la cita? Por favor indíqueme una fecha concreta, por ejemplo "mañana", "el viernes" o "el 15 de octubre".',
  horario: PEDIR_NUMERO,
};

/** "El horario de las 8:00 a. m. del martes 6 de octubre de 2026 que eligió ya no está disponible." */
function avisoHorarioPerdido(perdido: Date, zona: string): string {
  return `El horario de las ${escribirHora(perdido, zona)} del ${escribirFecha(fechaLocalDe(perdido, zona))} que eligió ya no está disponible.`;
}

/**
 * Encabezado y líneas numeradas de una lista de horarios.
 *
 * Invariante: una línea por horario, en el MISMO orden en que llegan y numeradas
 * de 1 a N. Esta función no ordena, no agrupa y no quita nada: el número que lee
 * el paciente es la posición del horario en la lista que se guarda con la oferta.
 *
 * Para no repetir en cada línea lo que es igual en todas, la fecha, el
 * profesional y la sede suben al encabezado solo si son idénticos en TODAS las
 * opciones; lo que cambia de una opción a otra se queda en su línea. La hora va
 * siempre en la línea.
 */
function listaDeHorarios(titulo: string, horarios: HorarioParaMostrar[], zona: string): string[] {
  const fechas = horarios.map((h) => escribirFecha(fechaLocalDe(h.iniciaEn, zona)));
  const comun = (valores: string[]) => valores.length > 0 && valores.every((v) => v === valores[0]);
  const fechaComun = comun(fechas);
  const profesionalComun = comun(horarios.map((h) => h.profesional));
  const sedeComun = comun(horarios.map((h) => h.sede));

  const encabezado = [
    titulo + (fechaComun ? ` para el ${fechas[0]}` : ''),
    ...(profesionalComun ? [`con ${horarios[0]!.profesional}`] : []),
    ...(sedeComun ? [`sede ${horarios[0]!.sede}`] : []),
  ].join(', ');
  const lineas = horarios.map((h, i) => {
    const partes = [
      ...(fechaComun ? [] : [fechas[i]!]),
      escribirHora(h.iniciaEn, zona),
      ...(profesionalComun ? [] : [`con ${h.profesional}`]),
      ...(sedeComun ? [] : [`sede ${h.sede}`]),
    ];
    return `${i + 1}. ${partes.join(', ')}`;
  });
  return [`${encabezado}:`, ...lineas];
}

export function ofertaHorarios(especialidad: string, horarios: HorarioParaMostrar[], zona: string, perdido: Date | null = null): string {
  // Si el paciente había elegido un horario que ya no está, se le dice cuál antes de ofrecer otros.
  const aviso = perdido ? [avisoHorarioPerdido(perdido, zona)] : [];
  return [...aviso, ...listaDeHorarios(`Horarios de ${especialidad}`, horarios, zona), PEDIR_NUMERO].join('\n');
}

/**
 * El paciente contestó a una oferta sin dar un número ("ese", "el último"). Se le
 * vuelve a mostrar la lista, solo con los horarios que siguen libres y renumerada.
 */
export function reofertaHorarios(especialidad: string, horarios: HorarioParaMostrar[], zona: string): string {
  return `Para agendar necesito el número de la opción.\n${ofertaHorarios(especialidad, horarios, zona)}`;
}

/** Los horarios de la oferta que coinciden con lo que describió el paciente. Es una oferta nueva, con su propia numeración. */
export function aclararHorario(especialidad: string, coincidencias: HorarioParaMostrar[], zona: string): string {
  return [...listaDeHorarios(`Horarios de ${especialidad} que coinciden con su búsqueda`, coincidencias, zona), PEDIR_NUMERO].join('\n');
}

export function sinDisponibilidad(
  especialidad: string, fecha: FechaLocal, sede: string | null, zona: string, perdido: Date | null = null, franja: Franja | null = null,
): string {
  const donde = sede ? ` en la sede ${sede}` : '';
  // Si solo se consultó la mañana o la tarde, el texto lo dice: sin esto afirmaría
  // que no hay horarios en todo el día, y puede haberlos en la otra mitad.
  const cuando = franja === 'tarde' ? ' en la tarde' : franja === 'manana' ? ' en la mañana' : '';
  const alternativa = franja ? 'en otro momento del día o en otra fecha' : 'en otra fecha';
  const texto = `No hay horarios disponibles de ${especialidad} para el ${escribirFecha(fecha)}${cuando}${donde}. Si lo desea, puedo buscar ${alternativa}.`;
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
