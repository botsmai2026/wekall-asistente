import { describe, expect, it } from 'vitest';
import { contrastarConMensaje, escribirFecha, escribirHora, fechaLocalDe, normalizarDiaSemana, rangoDelDia, resolverReferencia, validarFecha } from '../src/dominio/fechas.js';

const ZONA = 'America/Bogota';
// 03:40 UTC del 6 de octubre de 2026 = lunes 5 de octubre, 10:40 p. m. en Cali.
const INSTANTE = new Date('2026-10-06T03:40:00Z');
const HOY = fechaLocalDe(INSTANTE, ZONA);

describe('fechas en la zona de la clínica', () => {
  it('a las 03:40 UTC del 6 de octubre, en Cali todavía es 5 de octubre', () => {
    expect(HOY).toEqual({ anio: 2026, mes: 10, dia: 5 });
    expect(escribirHora(INSTANTE, ZONA)).toBe('10:40 p. m.');
  });

  it('"mañana" a esa hora es el 6 de octubre, no el 7', () => {
    expect(resolverReferencia({ dias_desde_hoy: 1 }, HOY)).toEqual({ anio: 2026, mes: 10, dia: 6 });
  });

  it('"el viernes" es la próxima ocurrencia, sin contar hoy', () => {
    expect(resolverReferencia({ dia_semana: 'viernes' }, HOY)).toEqual({ anio: 2026, mes: 10, dia: 9 });
    // Hoy es lunes: "el lunes" es el de la semana siguiente.
    expect(resolverReferencia({ dia_semana: 'lunes' }, HOY)).toEqual({ anio: 2026, mes: 10, dia: 12 });
  });

  it('el día de la semana se reconoce con tilde y con mayúsculas', () => {
    expect(['miércoles', 'Sábado', ' MIÉRCOLES ', 'viernes'].map(normalizarDiaSemana)).toEqual(['miercoles', 'sabado', 'miercoles', 'viernes']);
    expect(normalizarDiaSemana('pasado mañana')).toBe('pasado manana'); // no valida: lo que no es un día lo rechaza el esquema
  });

  it('"el viernes de la otra semana" es el viernes de la semana calendario siguiente', () => {
    expect(resolverReferencia({ dia_semana: 'viernes', semana_siguiente: true }, HOY)).toEqual({ anio: 2026, mes: 10, dia: 16 });
  });

  it('"el 15 de octubre": el código elige el año', () => {
    expect(resolverReferencia({ dia: 15, mes: 10 }, HOY)).toEqual({ anio: 2026, mes: 10, dia: 15 });
    // Una fecha que ya pasó este año es la del año siguiente.
    expect(resolverReferencia({ dia: 20, mes: 1 }, HOY)).toEqual({ anio: 2027, mes: 1, dia: 20 });
    // Hoy mismo cuenta.
    expect(resolverReferencia({ dia: 5, mes: 10 }, HOY)).toEqual(HOY);
  });

  it('una fecha que no existe se rechaza', () => {
    expect(resolverReferencia({ dia: 31, mes: 2 }, HOY)).toEqual({ error: 'fecha_inexistente' });
  });

  it('valida contra el reloj real: ni pasada ni fuera del horizonte', () => {
    expect(validarFecha({ anio: 2026, mes: 10, dia: 4 }, HOY, 60)).toBe('fecha_pasada');
    expect(validarFecha(HOY, HOY, 60)).toBeNull();
    expect(validarFecha({ anio: 2027, mes: 1, dia: 20 }, HOY, 60)).toBe('fuera_del_horizonte');
  });

  it('el rango de un día local se convierte a instantes UTC', () => {
    const dia = { anio: 2026, mes: 10, dia: 6 };
    expect(rangoDelDia(dia, undefined, ZONA)).toEqual({ desde: new Date('2026-10-06T05:00:00Z'), hasta: new Date('2026-10-07T05:00:00Z') });
    expect(rangoDelDia(dia, 'manana', ZONA).hasta).toEqual(new Date('2026-10-06T17:00:00Z'));
    expect(rangoDelDia(dia, 'tarde', ZONA).desde).toEqual(new Date('2026-10-06T17:00:00Z'));
  });

  it('escribe la fecha como la leerá el paciente', () => {
    expect(escribirFecha({ anio: 2026, mes: 10, dia: 6 })).toBe('martes 6 de octubre de 2026');
  });
});

describe('el día de la semana que escribió el paciente manda sobre la cuenta del modelo', () => {
  // HOY es el lunes 5 de octubre de 2026.
  const octubre = (dia: number) => ({ anio: 2026, mes: 10, dia });

  it('los tres casos de la ronda de aceptación: vale el día que escribió el paciente', () => {
    // "el sábado": el modelo mandó {dia: 7, mes: 10}, un miércoles.
    expect(contrastarConMensaje(octubre(7), '¿Tienen cita de dermatología el sábado en la tarde?', HOY)).toEqual({ fecha: octubre(10), corregida: true });
    // "el viernes": el modelo mandó dias_desde_hoy = 3, un jueves.
    expect(contrastarConMensaje(octubre(8), 'Quiero otra cita de medicina general el viernes', HOY)).toEqual({ fecha: octubre(9), corregida: true });
    // El modelo mandó semana_siguiente sin que el paciente lo dijera.
    expect(contrastarConMensaje(octubre(16), 'No, quiero el viernes', HOY)).toEqual({ fecha: octubre(9), corregida: true });
  });

  it('"el viernes", "este viernes" y "el próximo viernes" son el viernes más cercano, sin contar hoy', () => {
    for (const texto of ['el viernes', 'este viernes', 'el próximo viernes']) {
      expect(contrastarConMensaje(octubre(16), texto, HOY)).toEqual({ fecha: octubre(9), corregida: true });
      expect(contrastarConMensaje(octubre(9), texto, HOY)).toEqual({ fecha: octubre(9), corregida: false });
      // Escrito el viernes 9: es el viernes 16, aunque el modelo pida hoy.
      expect(contrastarConMensaje(octubre(9), texto, octubre(9))).toEqual({ fecha: octubre(16), corregida: true });
    }
  });

  it('solo una expresión explícita lleva a la semana calendario siguiente', () => {
    for (const texto of ['el viernes de la otra semana', 'el viernes de la semana que viene', 'el viernes de la siguiente semana', 'El viernes de la próxima semana']) {
      expect(contrastarConMensaje(octubre(9), texto, HOY)).toEqual({ fecha: octubre(16), corregida: true });
    }
  });

  it('el día se reconoce con tilde o sin ella y en mayúsculas; "la mañana" no es otra fecha', () => {
    expect(contrastarConMensaje(octubre(8), 'El SÁBADO', HOY)).toEqual({ fecha: octubre(10), corregida: true });
    expect(contrastarConMensaje(octubre(8), 'el miercoles', HOY)).toEqual({ fecha: octubre(7), corregida: true });
    expect(contrastarConMensaje(octubre(8), 'el miércoles en la mañana', HOY)).toEqual({ fecha: octubre(7), corregida: true });
  });

  it('sin un día de la semana escrito, vale la fecha del modelo', () => {
    for (const texto of ['Hola, ¿tienen cita con dermatología mañana en la tarde?', '1', 'el 15 de octubre']) {
      expect(contrastarConMensaje(octubre(6), texto, HOY)).toEqual({ fecha: octubre(6), corregida: false });
    }
  });

  it('con varias fechas escritas, la del modelo vale si es una de ellas; si no, es un error', () => {
    expect(contrastarConMensaje(octubre(6), '¿mañana o el miércoles?', HOY)).toEqual({ fecha: octubre(6), corregida: false });
    expect(contrastarConMensaje(octubre(7), '¿mañana o el miércoles?', HOY)).toEqual({ fecha: octubre(7), corregida: false });
    expect(contrastarConMensaje(octubre(9), '¿mañana o el miércoles?', HOY)).toEqual({ error: 'fecha_no_coincide' });
    expect(contrastarConMensaje(octubre(8), 'dermatología el miércoles o el sábado', HOY)).toEqual({ error: 'fecha_no_coincide' });
    // Un día escrito en número también es una fecha.
    expect(contrastarConMensaje(octubre(16), 'el viernes 16', HOY)).toEqual({ fecha: octubre(16), corregida: false });
    expect(contrastarConMensaje(octubre(13), 'No puedo el viernes, ¿tienen el 13?', HOY)).toEqual({ fecha: octubre(13), corregida: false });
    // Dos maneras de nombrar el mismo día son una sola fecha.
    expect(contrastarConMensaje(octubre(13), 'mañana, el martes', HOY)).toEqual({ fecha: octubre(6), corregida: true });
  });

  it('lo que no es un día de la semana escrito no cuenta', () => {
    // Una hora no es un día del mes.
    expect(contrastarConMensaje(octubre(8), 'el viernes a las 8', HOY)).toEqual({ fecha: octubre(9), corregida: true });
    expect(contrastarConMensaje(octubre(8), 'el viernes 8:30', HOY)).toEqual({ fecha: octubre(9), corregida: true });
    // Un nombre propio, y expresiones que la gramática deja al modelo.
    for (const texto of ['Quiero cita con el doctor Domingo', 'el otro viernes', 'un sábado', '¿atienden los sábados?', 'hoy viernes']) {
      expect(contrastarConMensaje(octubre(16), texto, HOY)).toEqual({ fecha: octubre(16), corregida: false });
    }
  });
});
