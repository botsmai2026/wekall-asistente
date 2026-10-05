// Prueba del almacén de trazas contra un MongoDB REAL. Solo corre si se indica
// dónde está:  MONGO_URL_PRUEBAS=mongodb://localhost:27017 npm test
// Sin esa variable se omite, para que "npm test" no dependa de tener Mongo.
import { createServer, connect, type AddressInfo, type Server } from 'node:net';
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

// Si la PRIMERA conexión de un cliente del driver falla, ese cliente queda cerrado
// y sus operaciones siguientes fallan al instante sin volver a intentar. Pasó al
// arrancar la API antes que Mongo: no volvió a leer trazas hasta reiniciarla.
describe('Mongo no estaba listo en el primer uso', () => {
  /** Un puerto local libre: se abre un servidor, se anota su puerto y se cierra. */
  const puertoLibre = () => new Promise<number>((resolver) => {
    const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address() as AddressInfo; s.close(() => resolver(port)); });
  });
  const escuchar = (servidor: Server, puerto: number) => new Promise<void>((resolver) => servidor.listen(puerto, '127.0.0.1', resolver));

  it('después de un primer fallo, la siguiente operación vuelve a intentar conectarse', async () => {
    const puerto = await puertoLibre();
    const almacen = AlmacenTrazasMongo.crear(`mongodb://127.0.0.1:${puerto}`, 'nada');
    expect(await almacen.disponible()).toBe(false); // nadie escucha todavía

    // Ahora sí hay alguien en ese puerto. No es Mongo: solo cuenta si le llegan conexiones.
    let conexiones = 0;
    const servidor = createServer((socket) => { conexiones += 1; socket.destroy(); });
    await escuchar(servidor, puerto);
    await almacen.disponible();
    expect(conexiones).toBeGreaterThan(0); // con el cliente cerrado del driver no llegaría ninguna
    await almacen.cerrar();
    await new Promise((resolver) => servidor.close(resolver));
  }, 15_000);

  it.skipIf(!url)('y si Mongo ya está arriba, se recupera sin reiniciar el proceso', async () => {
    // "Mongo caído y luego arriba" se simula con un puente TCP hacia el Mongo real que al principio no existe.
    const destino = new URL(url!);
    const puerto = await puertoLibre();
    const almacen = AlmacenTrazasMongo.crear(`mongodb://127.0.0.1:${puerto}/?directConnection=true`, `pruebas_${Date.now()}`);
    expect(await almacen.disponible()).toBe(false);

    const puente = createServer((entrada) => {
      const salida = connect(Number(destino.port || 27017), destino.hostname);
      entrada.pipe(salida).pipe(entrada);
      const cortar = () => { entrada.destroy(); salida.destroy(); };
      entrada.on('error', cortar); salida.on('error', cortar);
    });
    await escuchar(puente, puerto);
    expect(await almacen.disponible()).toBe(true);
    await almacen.guardar({ message_id: 'recuperado', intento: 1, clinica_id: 1, conversacion_id: 1, creado_en: new Date().toISOString() });
    expect(await almacen.deConversacion(1, 1)).toHaveLength(1);
    await almacen.cerrar();
    await new Promise((resolver) => puente.close(resolver));
  }, 20_000);
});
