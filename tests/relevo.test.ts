// El relevo de trazas hacia Mongo, con un almacén en memoria que se comporta igual:
// puede caerse, puede rechazar un documento, y trata la clave repetida como éxito.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { relevarPendientes, relevarUna } from '../src/aplicacion/relevo.js';
import { procesarUno } from '../src/aplicacion/worker.js';
import { AlmacenTrazasEnMemoria } from '../src/infraestructura/falsos.js';
import { ErrorInfraestructura } from '../src/dominio/errores.js';
import { base, escenario, mensaje, type Escenario } from './apoyo.js';

let e: Escenario;
let almacen: AlmacenTrazasEnMemoria;
beforeEach(async () => {
  e = await escenario();
  almacen = new AlmacenTrazasEnMemoria();
});
afterAll(() => base.cerrar());

const responder = { herramienta: 'responder', argumentos: { tipo: 'pregunta_aclaratoria', faltantes: ['intencion'] } };
const pendientes = async () => (await base.pool.query('SELECT message_id, estado_envio, intentos_envio, ultimo_error FROM trazas_pendientes ORDER BY message_id')).rows;

describe('relevo de trazas', () => {
  it('con Mongo caído el turno cierra igual; la traza espera en Postgres y llega cuando Mongo vuelve', async () => {
    almacen.caido = true;
    await e.enviar('hola', 'm1');
    await procesarUno(e.con(responder));
    expect((await mensaje('m1')).respuesta_tipo).toBe('pregunta_aclaratoria'); // el paciente ya tiene respuesta

    await expect(relevarPendientes(base, almacen)).rejects.toBeInstanceOf(ErrorInfraestructura);
    expect(await pendientes()).toMatchObject([{ message_id: 'm1', estado_envio: 'pendiente', intentos_envio: 0 }]); // la fila no se tocó

    almacen.caido = false;
    expect(await relevarPendientes(base, almacen)).toBe(1);
    expect(await pendientes()).toEqual([]);
    const traza = almacen.trazas.get('m1#1')!;
    expect(traza).toMatchObject({ clinica_id: e.clinicaId, tipo: 'llm', modelo: 'modelo-falso', tokens_entrada: 100, tokens_salida: 10, resultado_procesamiento: 'completado' });
  });

  it('si Mongo aceptó la traza y el relevo murió antes de borrar la fila, al volver no hay duplicado', async () => {
    await e.enviar('hola', 'm1');
    await procesarUno(e.con(responder));
    const [fila] = (await base.pool.query('SELECT documento FROM trazas_pendientes')).rows;
    await almacen.guardar(fila.documento); // Mongo ya la tiene; la fila sigue en el outbox
    expect(await relevarUna(base, almacen)).toBe('publicada');
    expect(almacen.trazas.size).toBe(1);
    expect(await pendientes()).toEqual([]);
  });

  it('una traza rechazada 10 veces pasa a revisión con su error y no bloquea a las demás', async () => {
    await e.enviar('hola', 'm1', '+573000000001');
    await e.enviar('hola', 'm2', '+573000000002');
    await procesarUno(e.con(responder));
    await procesarUno(e.con(responder));
    almacen.rechazar.add('m1');
    for (let i = 0; i < 12; i++) await relevarPendientes(base, almacen);
    expect(await pendientes()).toMatchObject([{ message_id: 'm1', estado_envio: 'requiere_revision', intentos_envio: 10, ultimo_error: 'Documento rechazado (simulado)' }]);
    expect(almacen.trazas.has('m2#1')).toBe(true);
    expect(await relevarUna(base, almacen)).toBe('vacio'); // la que está en revisión ya no se toma
  });
});
