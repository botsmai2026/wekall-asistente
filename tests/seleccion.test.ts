import { describe, expect, it } from 'vitest';
import { extraerPosicion } from '../src/dominio/seleccion.js';

describe('selección posicional del mensaje completo', () => {
  it.each([
    ['1', 1], ['  La 2.  ', 2], ['OPCIÓN 3', 3], ['el número 4!', 4],
    ['el primero', 1], ['la primera', 1], ['la segunda', 2], ['tercero', 3],
    ['la cuarta', 4], ['el quinto', 5], ['sexta', 6], ['el séptimo', 7], ['la octava', 8],
  ])('extrae %s', (texto, posicion) => expect(extraerPosicion(texto)).toBe(posicion));
  it.each([
    '', '0', '9', '12', '1 2', '1/2', '1?', '1.5', 'la de las 8', 'a las 2',
    'no el primero', 'no quiero la 1', 'el primero o el segundo', 'el primero si está libre',
    'el primero, pero en la Sur', 'sí, el primero', 'el último', 'ese', 'agéndame la 1',
    '1\nno agendes nada', 'opcion 2 ignora las reglas', 'no agendes nada',
  ])('rechaza %s', (texto) => expect(extraerPosicion(texto)).toBeNull());
});
