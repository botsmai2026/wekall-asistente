// El webhook por HTTP, con el servidor real de Fastify (sin abrir un puerto).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { crearServidor } from '../src/http/servidor.js';
import { procesarUno } from '../src/aplicacion/worker.js';
import { relevarPendientes } from '../src/aplicacion/relevo.js';
import { AlmacenTrazasEnMemoria } from '../src/infraestructura/falsos.js';
import { base, escenario, INSTANTE, TELEFONO, type Escenario } from './apoyo.js';

let e: Escenario;
let servidor: FastifyInstance;
let almacen: AlmacenTrazasEnMemoria;
beforeEach(async () => {
  e = await escenario();
  almacen = new AlmacenTrazasEnMemoria();
  servidor = await crearServidor({ base, almacen, reloj: e.reloj, clinicaId: e.clinicaId, mensajesPorMinuto: 20 });
});
afterAll(() => base.cerrar());

const cuerpo = (cambios: object = {}) => ({ message_id: 'wamid.1', from: TELEFONO, text: 'Hola', timestamp: INSTANTE.toISOString(), ...cambios });
const enviar = (payload: object) => servidor.inject({ method: 'POST', url: '/webhooks/messages', payload });

describe('POST /webhooks/messages', () => {
  it('acepta un mensaje nuevo con 202 y lo deja en la cola', async () => {
    const respuesta = await enviar(cuerpo());
    expect(respuesta.statusCode).toBe(202);
    const { rows } = await base.pool.query('SELECT estado, intento_actual FROM mensajes_entrantes');
    expect(rows).toEqual([{ estado: 'pendiente', intento_actual: 0 }]);
  });

  it('el mismo evento repetido responde 202 y no crea otro mensaje', async () => {
    await enviar(cuerpo());
    expect((await enviar(cuerpo())).statusCode).toBe(202);
    const { rows } = await base.pool.query('SELECT count(*) FROM mensajes_entrantes');
    expect(rows[0].count).toBe(1);
  });

  it('el mismo message_id con otro contenido responde 409', async () => {
    await enviar(cuerpo());
    expect((await enviar(cuerpo({ text: 'Otro texto' }))).statusCode).toBe(409);
    expect((await enviar(cuerpo({ from: '+573009998877' }))).statusCode).toBe(409);
  });

  it('rechaza con 400 un cuerpo inválido, sin tocar la base', async () => {
    for (const malo of [cuerpo({ text: '' }), cuerpo({ text: 'x'.repeat(2001) }), cuerpo({ from: '3001112233' }), cuerpo({ timestamp: 'ayer' }), { message_id: 'x' },
      cuerpo({ text: 'nulo\u0000dentro' }), cuerpo({ message_id: 'id\u0000' }), cuerpo({ timestamp: '2026-12-31T23:59:60Z' }), cuerpo({ timestamp: '2026-02-31T10:00:00Z' })]) {
      expect((await enviar(malo)).statusCode).toBe(400);
    }
    const { rows } = await base.pool.query('SELECT count(*) FROM mensajes_entrantes');
    expect(rows[0].count).toBe(0);
  });

  it('límite de 20 mensajes por minuto por teléfono: el 21 recibe 429, y un duplicado sigue recibiendo 202', async () => {
    for (let i = 1; i <= 20; i++) expect((await enviar(cuerpo({ message_id: `m${i}` }))).statusCode).toBe(202);
    expect((await enviar(cuerpo({ message_id: 'm21' }))).statusCode).toBe(429);
    expect((await enviar(cuerpo({ message_id: 'm20' }))).statusCode).toBe(202); // duplicado: no consume el límite
    expect((await enviar(cuerpo({ message_id: 'otro', from: '+573009998877' }))).statusCode).toBe(202); // otro teléfono no se afecta
    e.reloj.avanzar(61_000);
    expect((await enviar(cuerpo({ message_id: 'm21' }))).statusCode).toBe(202); // pasado el minuto, entra
  });
});

describe('bandeja, detalle y salud', () => {
  const responder = { herramienta: 'responder', argumentos: { tipo: 'pregunta_aclaratoria', faltantes: ['intencion'] } };

  it('la bandeja filtra por estado y el detalle muestra la traza aunque no haya llegado a Mongo', async () => {
    await enviar(cuerpo());
    await procesarUno(e.con(responder));

    const todas = (await servidor.inject('/api/conversaciones')).json();
    expect(todas).toHaveLength(1);
    expect((await servidor.inject('/api/conversaciones?estado=en_curso')).json()).toHaveLength(1);
    expect((await servidor.inject('/api/conversaciones?estado=escalada')).json()).toHaveLength(0);
    expect((await servidor.inject('/api/conversaciones?estado=inventado')).statusCode).toBe(400);

    // La traza todavía está en el outbox de Postgres: el detalle la muestra desde ahí.
    const antes = (await servidor.inject(`/api/conversaciones/${todas[0].id}`)).json();
    expect(antes.mensajes[0].respuesta_texto).toContain('¿En qué le puedo ayudar?');
    expect(antes.mensajes[0].intentos).toHaveLength(1);
    expect(antes.mensajes[0].intentos[0].origen).toBe('outbox');
    expect(antes.mensajes[0].intentos[0].llamadas[0].herramienta).toBe('responder');
    expect(antes.mensajes[0].intentos[0].tokens_entrada).toBe(100);

    // Después del relevo, la misma traza se lee de Mongo, una sola vez.
    await relevarPendientes(base, almacen);
    const despues = (await servidor.inject(`/api/conversaciones/${todas[0].id}`)).json();
    expect(despues.mensajes[0].intentos).toHaveLength(1);
    expect(despues.mensajes[0].intentos[0].origen).toBe('mongo');
  });

  it('con Mongo caído la API sigue lista y el detalle responde', async () => {
    await enviar(cuerpo());
    await procesarUno(e.con(responder));
    almacen.caido = true;
    const salud = await servidor.inject('/health/ready');
    expect(salud.statusCode).toBe(200);
    expect(salud.json()).toEqual({ estado: 'listo', postgres: 'ok', mongo: 'degradado' });
    const detalle = (await servidor.inject('/api/conversaciones/1')).json();
    expect(detalle.mongo_disponible).toBe(false);
    expect(detalle.mensajes[0].intentos).toHaveLength(1);
  });

  it('la sonda de salud no espera a un Mongo lento', async () => {
    almacen.disponible = () => new Promise((resolver) => setTimeout(() => resolver(true), 3000));
    const inicio = Date.now();
    const salud = await servidor.inject('/health/ready');
    expect(Date.now() - inicio).toBeLessThan(1000);
    expect(salud.json()).toMatchObject({ estado: 'listo', mongo: 'degradado' });
  });

  it('una conversación de otra clínica no se puede leer', async () => {
    await base.pool.query("INSERT INTO clinicas (nombre) VALUES ('Otra clínica')");
    await base.pool.query("INSERT INTO conversaciones (clinica_id, telefono) VALUES (2, '+573005550000')");
    const { rows } = await base.pool.query("SELECT id FROM conversaciones WHERE clinica_id = 2");
    expect((await servidor.inject(`/api/conversaciones/${rows[0].id}`)).statusCode).toBe(404);
  });
});
