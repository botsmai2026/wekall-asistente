// Fechas. Regla de la arquitectura: el modelo nunca escribe una fecha completa.
// Solo dice a qué se refiere el paciente ("mañana" = 1 día desde hoy, "el
// viernes", "el 15 de octubre") y este código calcula el día.
//
// Por qué: un modelo de lenguaje no sabe qué día es hoy ni en qué zona horaria
// está la clínica. El caso de la prueba lo muestra: un mensaje enviado a las
// 03:40 UTC del 6 de octubre es, en Cali, el 5 de octubre a las 10:40 pm. Ahí
// "mañana" es el 6, no el 7. Calcularlo en código lo hace exacto y comprobable.
//
// Este archivo no depende de nada: son funciones puras, fáciles de probar.

/** Un día del calendario en la zona de la clínica, sin hora. */
export interface FechaLocal {
  anio: number;
  mes: number; // 1 a 12
  dia: number;
}

export const DIAS_SEMANA = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'] as const;
export type DiaSemana = (typeof DIAS_SEMANA)[number];

/** Un día de la semana como está en DIAS_SEMANA: en minúsculas y sin tildes ("Miércoles" → "miercoles"). */
export function normalizarDiaSemana(texto: string): string {
  return texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

/** Las tres formas en que el modelo puede referirse a una fecha. Exactamente una. */
export type ReferenciaFecha =
  | { dias_desde_hoy: number }
  | { dia_semana: DiaSemana; semana_siguiente?: boolean }
  | { dia: number; mes: number };

export type Franja = 'manana' | 'tarde';

export type ErrorFecha = 'fecha_inexistente' | 'fecha_pasada' | 'fuera_del_horizonte';

/** Qué día es, en la zona indicada, en un instante dado. */
export function fechaLocalDe(instante: Date, zona: string): FechaLocal {
  const partes = new Intl.DateTimeFormat('en-CA', { timeZone: zona, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instante);
  const valor = (tipo: string) => Number(partes.find((p) => p.type === tipo)!.value);
  return { anio: valor('year'), mes: valor('month'), dia: valor('day') };
}

// Aritmética de días: se hace sobre un calendario "neutro" en UTC, que no
// tiene cambios de hora, y nunca sobre instantes reales.
function aNeutro(f: FechaLocal): number {
  return Date.UTC(f.anio, f.mes - 1, f.dia);
}
function deNeutro(ms: number): FechaLocal {
  const d = new Date(ms);
  return { anio: d.getUTCFullYear(), mes: d.getUTCMonth() + 1, dia: d.getUTCDate() };
}
const UN_DIA_MS = 86_400_000;

export function sumarDias(f: FechaLocal, dias: number): FechaLocal {
  return deNeutro(aNeutro(f) + dias * UN_DIA_MS);
}
export function compararFechas(a: FechaLocal, b: FechaLocal): number {
  return aNeutro(a) - aNeutro(b);
}
/** 0 = lunes … 6 = domingo. */
export function indiceDiaSemana(f: FechaLocal): number {
  return (new Date(aNeutro(f)).getUTCDay() + 6) % 7;
}
function existe(f: FechaLocal): boolean {
  const ida = deNeutro(aNeutro(f));
  return ida.anio === f.anio && ida.mes === f.mes && ida.dia === f.dia;
}

/**
 * Convierte la referencia del modelo en un día concreto.
 * `hoy` es el día en que el paciente escribió (sale de la hora del mensaje).
 */
export function resolverReferencia(referencia: ReferenciaFecha, hoy: FechaLocal): FechaLocal | { error: ErrorFecha } {
  if ('dias_desde_hoy' in referencia) {
    return sumarDias(hoy, referencia.dias_desde_hoy);
  }
  if ('dia_semana' in referencia) {
    const pedido = DIAS_SEMANA.indexOf(referencia.dia_semana);
    const actual = indiceDiaSemana(hoy);
    if (referencia.semana_siguiente) {
      // Ese día en la semana calendario siguiente (lunes a domingo).
      const lunesSiguiente = sumarDias(hoy, 7 - actual);
      return sumarDias(lunesSiguiente, pedido);
    }
    // Próxima ocurrencia sin contar hoy: si hoy es viernes, "el viernes" es el de la otra semana.
    const diferencia = (pedido - actual + 7) % 7;
    return sumarDias(hoy, diferencia === 0 ? 7 : diferencia);
  }
  // Día y mes: el código elige el año. Es la próxima vez que ocurre esa fecha, contando hoy.
  for (const anio of [hoy.anio, hoy.anio + 1]) {
    const candidata = { anio, mes: referencia.mes, dia: referencia.dia };
    if (existe(candidata) && compararFechas(candidata, hoy) >= 0) return candidata;
  }
  return { error: 'fecha_inexistente' };
}

/**
 * Comprueba la fecha contra el reloj real: no puede ser pasada ni estar más
 * allá del horizonte de la agenda. `hoyReal` sale del reloj del servidor, no de
 * la hora que declara el mensaje: así un mensaje con hora antigua no agenda en el pasado.
 */
export function validarFecha(fecha: FechaLocal, hoyReal: FechaLocal, horizonteDias: number): ErrorFecha | null {
  if (compararFechas(fecha, hoyReal) < 0) return 'fecha_pasada';
  if (compararFechas(fecha, sumarDias(hoyReal, horizonteDias)) > 0) return 'fuera_del_horizonte';
  return null;
}

/** El instante (UTC) que corresponde a una fecha y hora locales en la zona indicada. */
export function instanteDe(fecha: FechaLocal, hora: number, zona: string): Date {
  // Se parte de suponer que la hora local es UTC y se corrige con el desfase de
  // la zona en ese momento. Se repite una vez por si la corrección cruza un cambio de hora.
  const supuesto = Date.UTC(fecha.anio, fecha.mes - 1, fecha.dia, hora);
  let instante = supuesto;
  for (let i = 0; i < 2; i++) {
    instante = supuesto - desfaseMs(new Date(instante), zona);
  }
  return new Date(instante);
}
function desfaseMs(instante: Date, zona: string): number {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: zona, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instante);
  const v = (tipo: string) => Number(partes.find((p) => p.type === tipo)!.value);
  const comoUtc = Date.UTC(v('year'), v('month') - 1, v('day'), v('hour'), v('minute'), v('second'));
  return comoUtc - Math.floor(instante.getTime() / 1000) * 1000;
}

/** Rango de instantes [desde, hasta) de un día local. Mañana: antes de las 12:00. Tarde: desde las 12:00. */
export function rangoDelDia(fecha: FechaLocal, franja: Franja | undefined, zona: string): { desde: Date; hasta: Date } {
  const inicio = franja === 'tarde' ? 12 : 0;
  const desde = instanteDe(fecha, inicio, zona);
  const hasta = franja === 'manana' ? instanteDe(fecha, 12, zona) : instanteDe(sumarDias(fecha, 1), 0, zona);
  return { desde, hasta };
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DIAS_ESCRITOS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];

/** "martes 6 de octubre de 2026" */
export function escribirFecha(fecha: FechaLocal): string {
  return `${DIAS_ESCRITOS[indiceDiaSemana(fecha)]} ${fecha.dia} de ${MESES[fecha.mes - 1]} de ${fecha.anio}`;
}

/** "8:30 a. m." en la zona indicada. */
export function escribirHora(instante: Date, zona: string): string {
  const partes = new Intl.DateTimeFormat('en-US', { timeZone: zona, hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(instante);
  const v = (tipo: string) => partes.find((p) => p.type === tipo)!.value;
  return `${v('hour')}:${v('minute')} ${v('dayPeriod') === 'AM' ? 'a. m.' : 'p. m.'}`;
}
