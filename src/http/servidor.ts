// La API. Dos responsabilidades y nada más: recibir mensajes (webhook) y
// mostrarle al coordinador qué pasó (bandeja y detalle). Nunca llama al modelo.
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { Type, type Static } from '@sinclair/typebox';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { recibirMensaje } from '../aplicacion/webhook.js';
import { bandeja, detalle, esEstado } from '../aplicacion/lecturas.js';
import type { AlmacenTrazas } from '../aplicacion/puertos.js';
import type { BaseDeDatos } from '../infraestructura/postgres.js';
import type { Reloj } from '../infraestructura/reloj.js';

// El esquema del webhook. Fastify lo usa para validar antes de ejecutar la ruta:
// un cuerpo que no cumple recibe 400 sin tocar la base de datos.
const CuerpoWebhook = Type.Object({
  // Sin el carácter nulo: Postgres no puede guardarlo, y debe ser un 400 y no un fallo de la base.
  message_id: Type.String({ minLength: 1, maxLength: 200, pattern: '^[^\\u0000]+$' }),
  from: Type.String({ pattern: '^\\+[0-9]{8,15}$' }),
  text: Type.String({ minLength: 1, maxLength: 2000, pattern: '^[^\\u0000]+$' }),
  timestamp: Type.String({ format: 'date-time' }),
});

export interface DependenciasHttp {
  base: BaseDeDatos;
  almacen: AlmacenTrazas;
  reloj: Reloj;
  clinicaId: number;
  mensajesPorMinuto: number;
}

export async function crearServidor(deps: DependenciasHttp): Promise<FastifyInstance> {
  const servidor = Fastify({ bodyLimit: 16 * 1024, logger: false });

  servidor.post<{ Body: Static<typeof CuerpoWebhook> }>('/webhooks/messages', { schema: { body: CuerpoWebhook } }, async (peticion, respuesta) => {
    // El formato acepta cadenas que no son un instante real (segundo 60, día 31 de un mes de 30).
    if (Number.isNaN(Date.parse(peticion.body.timestamp))) return respuesta.code(400).send({ error: 'timestamp_invalido' });
    let resultado;
    try {
      resultado = await recibirMensaje(deps.base, deps.reloj, deps.clinicaId, deps.mensajesPorMinuto, peticion.body);
    } catch (error) {
      // Postgres no respondió. 503: quien envía reintenta, y el message_id hace seguro ese reintento.
      console.error('Webhook: fallo de base de datos', String(error));
      return respuesta.code(503).send({ error: 'servicio_no_disponible' });
    }
    switch (resultado) {
      case 'aceptado':
      case 'duplicado':
        return respuesta.code(202).send({ estado: resultado });
      case 'conflicto':
        return respuesta.code(409).send({ error: 'message_id_con_otro_contenido' });
      case 'limite_excedido':
        return respuesta.code(429).send({ error: 'demasiados_mensajes' });
    }
  });

  servidor.get<{ Querystring: { estado?: string } }>('/api/conversaciones', async (peticion, respuesta) => {
    const estado = peticion.query.estado;
    if (estado !== undefined && estado !== '' && !esEstado(estado)) return respuesta.code(400).send({ error: 'estado_invalido' });
    return bandeja(deps.base, deps.clinicaId, estado ? (estado as any) : null);
  });

  servidor.get<{ Params: { id: string } }>('/api/conversaciones/:id', async (peticion, respuesta) => {
    const id = Number(peticion.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return respuesta.code(400).send({ error: 'id_invalido' });
    const resultado = await detalle(deps.base, deps.almacen, deps.clinicaId, id);
    return resultado ?? respuesta.code(404).send({ error: 'no_encontrada' });
  });

  servidor.get('/health/live', async () => ({ estado: 'vivo' }));

  // "Listo" depende solo de Postgres. Mongo se informa, pero no decide: si
  // decidiera, una caída de Mongo sacaría de servicio a la API, y Mongo está
  // precisamente fuera del camino crítico.
  servidor.get('/health/ready', async (_peticion, respuesta) => {
    // A Mongo se le da un máximo de 300 ms: una sonda de salud con un límite corto
    // no debe fallar porque Mongo tarde en contestar.
    const sinRespuesta = new Promise<boolean>((resolver) => setTimeout(() => resolver(false), 300).unref());
    const comprobacionMongo = Promise.race([deps.almacen.disponible(), sinRespuesta]);
    try {
      await deps.base.pool.query('SELECT 1');
      const mongo = (await comprobacionMongo) ? 'ok' : 'degradado';
      return { estado: 'listo', postgres: 'ok', mongo };
    } catch {
      const mongo = (await comprobacionMongo) ? 'ok' : 'degradado';
      return respuesta.code(503).send({ estado: 'no_listo', postgres: 'caido', mongo });
    }
  });

  // Interfaz web, si está construida (web/dist).
  const carpetaWeb = fileURLToPath(new URL('../../web/dist/', import.meta.url));
  if (existsSync(carpetaWeb)) {
    await servidor.register(fastifyStatic, { root: carpetaWeb });
  }
  return servidor;
}
