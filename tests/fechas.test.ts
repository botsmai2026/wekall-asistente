import { describe, expect, it } from 'vitest';
import { escribirFecha, escribirHora, fechaLocalDe, normalizarDiaSemana, rangoDelDia, resolverReferencia, validarFecha } from '../src/dominio/fechas.js';

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
