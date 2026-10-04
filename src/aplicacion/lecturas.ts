// Lecturas para la bandeja del coordinador.
import { ESTADOS_CONVERSACION, type EstadoConversacion } from '../dominio/estados.js';
import type { BaseDeDatos, Fila } from '../infraestructura/postgres.js';
import type { AlmacenTrazas, DocumentoTraza } from './puertos.js';

export function esEstado(valor: string): valor is EstadoConversacion {
  return (ESTADOS_CONVERSACION as readonly string[]).includes(valor);
}

export async function bandeja(base: BaseDeDatos, clinicaId: number, estado: EstadoConversacion | null): Promise<Fila[]> {
  return estado ? base.leer('bandeja', { clinica_id: clinicaId, estado }) : base.leer('bandeja_todas', { clinica_id: clinicaId });
}

export interface Detalle {
  conversacion: Fila;
  mensajes: (Fila & { intentos: (DocumentoTraza & { origen: 'mongo' | 'outbox'; estado_envio?: string })[] })[];
  /** false si Mongo no respondió: las trazas mostradas son solo las que siguen en el outbox. */
  mongo_disponible: boolean;
}

/**
 * Detalle de una conversación: mensajes y respuestas desde Postgres, y las
 * trazas de cada intento desde Mongo unidas con las que aún están en el outbox.
 * Regla por clave (message_id, intento): si está en Mongo, vale la de Mongo;
 * si no, la del outbox. Así la trazabilidad se ve aunque Mongo esté caído.
 */
export async function detalle(base: BaseDeDatos, almacen: AlmacenTrazas, clinicaId: number, conversacionId: number): Promise<Detalle | null> {
  const [conversacion] = await base.leer('detalle_conversacion', { conversacion_id: conversacionId, clinica_id: clinicaId });
  if (!conversacion) return null;
  const mensajes = await base.leer('detalle_mensajes', { conversacion_id: conversacionId });
  const enOutbox = await base.leer('detalle_trazas_en_outbox', { conversacion_id: conversacionId });

  let enMongo: DocumentoTraza[] = [];
  let mongoDisponible = true;
  try {
    enMongo = await almacen.deConversacion(clinicaId, conversacionId);
  } catch {
    mongoDisponible = false;
  }

  const porClave = new Map<string, DocumentoTraza & { origen: 'mongo' | 'outbox'; estado_envio?: string }>();
  for (const fila of enOutbox) {
    porClave.set(`${fila.message_id}#${fila.intento}`, { ...(fila.documento as DocumentoTraza), origen: 'outbox', estado_envio: fila.estado_envio });
  }
  for (const traza of enMongo) {
    porClave.set(`${traza.message_id}#${traza.intento}`, { ...traza, origen: 'mongo' }); // Mongo gana
  }
  const trazas = [...porClave.values()].sort((a, b) => a.intento - b.intento);

  return {
    conversacion,
    mensajes: mensajes.map((m) => ({ ...m, intentos: trazas.filter((t) => t.message_id === m.message_id) })),
    mongo_disponible: mongoDisponible,
  };
}
