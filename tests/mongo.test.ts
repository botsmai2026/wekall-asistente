// Prueba del almacén de trazas contra un MongoDB REAL. Solo corre si se indica
// dónde está:  MONGO_URL_PRUEBAS=mongodb://localhost:27017 npm test
// Sin esa variable se omite, para que "npm test" no dependa de tener Mongo.
import { afterAll, describe, expect, it } from 'vitest';
import { AlmacenTrazasMongo } from '../src/infraestructura/mongo.js';
import { ErrorInfraestructura } from '../src/dominio/errores.js';

const url = process.env.MONGO_URL_PRUEBAS;

describe.skipIf(!url)('almacén de trazas en MongoDB real', () => {
  const almacen = url ? AlmacenTrazasMongo.crear(url, `pruebas_${Date.now()}`) : (null as never);
  afterAll(() => almacen?.cerrar());
  const traza = (intento: number) => ({ message_id: 'm1', intento, clinica_id: 1, conversacion_id: 7, creado_en: new Date(2026, 9, 6, 0, intento).toISOString(), tipo: 'llm' });

  it('guarda, trata la clave repetida como éxito y no modifica lo guardado', async () => {
    await almacen.guardar({ ...traza(1), marca: 'original' });
    await almacen.guardar({ ...traza(1), marca: 'repetida' });
    await almacen.guardar(traza(2));
    const leidas = await almacen.deConversacion(1, 7);
    expect(leidas.map((t) => [t.intento, t.marca])).toEqual([[1, 'original'], [2, undefined]]);
    expect(leidas[0]).not.toHaveProperty('_id');
  });

  it('filtra por clínica: la misma conversación con otra clínica no devuelve nada', async () => {
    expect(await almacen.deConversacion(2, 7)).toEqual([]);
  });

  it('responde a la comprobación de disponibilidad', async () => {
    expect(await almacen.disponible()).toBe(true);
  });
});

describe('almacén de trazas con Mongo inalcanzable', () => {
  it('falla como error de infraestructura en unos 3 segundos, sin colgarse', async () => {
    const almacen = AlmacenTrazasMongo.crear('mongodb://127.0.0.1:27999', 'nada');
    const inicio = Date.now();
    await expect(almacen.guardar({ message_id: 'x', intento: 1 })).rejects.toBeInstanceOf(ErrorInfraestructura);
    expect(Date.now() - inicio).toBeLessThan(5000);
    expect(await almacen.disponible()).toBe(false);
    await almacen.cerrar();
  });
});
