// El worker: toma mensajes de la cola y los procesa de principio a fin.
//
// La cola es la tabla mensajes_entrantes de PostgreSQL. Un intento tiene tres
// momentos, cada uno una transacción corta:
//
//   reclamo  → "este mensaje es mío": número de intento y candado de 120 s.
//   trabajo  → fuera de transacción: modelo, herramientas (hasta 60 s).
//   cierre   → respuesta, estado y traza, SOLO si el intento sigue siendo el mío.
//
// Por qué el trabajo va fuera de la transacción: una transacción abierta 60 s
// retiene una conexión y bloqueos. Por qué el cierre comprueba el intento: si
// este worker se demoró más que su candado, otro worker pudo tomar el mensaje;
// el tardío no debe pisar su resultado. El número de intento es esa protección.
import { ErrorDeProgramacion, ErrorLogico } from '../dominio/errores.js';
import { estadoQuePide, type EstadoConversacion } from '../dominio/estados.js';
import * as plantillas from '../dominio/plantillas.js';
import { revertir } from '../infraestructura/postgres.js';
import { IntentoVencido, Plazo, type ContextoIntento, type Dependencias, type ResultadoTurno } from './intento.js';
import { ejecutarCiclo, type TurnoAnterior } from './motor.js';
import { Traza, type ResultadoProcesamiento } from './traza.js';

export interface Reclamo {
  messageId: string;
  conversacionId: number;
  clinicaId: number;
  intento: number;
  texto: string;
  enviadoEn: Date;
  estadoConversacion: EstadoConversacion;
  telefono: string;
}

const MAX_RECHAZOS_SEGUIDOS = 3;

/**
 * Transacción de reclamo. Devuelve el mensaje reclamado, o null si no hay
 * trabajo que este worker pueda tomar ahora.
 */
export async function reclamar(deps: Dependencias): Promise<Reclamo | null> {
  const { base, reloj, limites } = deps;
  for (let rechazos = 0; rechazos < MAX_RECHAZOS_SEGUIDOS; rechazos++) {
    const resultado = await base.enTransaccion<Reclamo | 'nada' | 'reintentar'>(async (tx) => {
      const ahora = reloj.ahora();
      const [elegido] = await tx.ejecutar('reclamo_elegir', { ahora, max_por_clinica: limites.maxPorClinica });
      if (!elegido) return 'nada';

      // Presupuesto por clínica: se toma el turno de la clínica y se vuelve a
      // contar en otra sentencia. Ver la explicación en sql/consultas.sql.
      const [turno] = await tx.ejecutar('reclamo_turno_clinica', { clinica_id: elegido.clinica_id });
      if (!turno!.aislamiento_correcto) throw new ErrorDeProgramacion('El reclamo exige una transacción READ COMMITTED');
      const [conteo] = await tx.ejecutar('reclamo_contar_clinica', { clinica_id: elegido.clinica_id, ahora });
      if (conteo!.en_proceso >= limites.maxPorClinica) return revertir<'reintentar'>('reintentar');

      const [marcado] = await tx.ejecutar('reclamo_marcar_mensaje', { message_id: elegido.message_id });
      if (!marcado) return revertir<'reintentar'>('reintentar');
      const [conversacion] = await tx.ejecutar('reclamo_poner_candado', { conversacion_id: elegido.conversacion_id, ahora });
      return {
        messageId: elegido.message_id, conversacionId: elegido.conversacion_id, clinicaId: conversacion!.clinica_id,
        intento: marcado.intento_actual, texto: marcado.texto, enviadoEn: marcado.enviado_en,
        estadoConversacion: conversacion!.estado, telefono: conversacion!.telefono,
      };
    });
    if (resultado === 'nada') return null;
    if (resultado !== 'reintentar') return resultado;
  }
  return null; // tres rechazos seguidos: esperar como si no hubiera trabajo
}

/**
 * Reclama un mensaje y lo procesa por completo. Devuelve false si no había
 * trabajo. Nunca lanza por un fallo del intento: lo registra y deja el mensaje
 * listo para reintentar.
 */
export async function procesarUno(deps: Dependencias): Promise<boolean> {
  const reclamo = await reclamar(deps);
  if (!reclamo) return false;

  const plazo = new Plazo(deps.reloj, deps.limites.plazoIntentoMs);
  const traza = new Traza(reclamo, () => deps.reloj.monotonicoMs(), deps.reloj.ahora());
  try {
    const turno = await decidir(reclamo, plazo, traza, deps);
    await cerrar(reclamo, turno, traza, plazo, deps);
  } catch (causa) {
    if (causa instanceof ErrorDeProgramacion) throw causa;
    if (causa instanceof IntentoVencido) {
      // Otro worker tiene el mensaje. Solo se deja la evidencia de este intento.
      await registrarDescartado(reclamo, traza, deps);
      return true;
    }
    // Cualquier otro error es de infraestructura: el modelo, los embeddings o
    // la base fallaron. No se le responde nada al paciente todavía: se reintenta.
    traza.error = causa instanceof Error ? `${causa.name}: ${causa.message}` : String(causa);
    await fallar(reclamo, traza, deps).catch((error) => {
      // Si ni siquiera se puede registrar el fallo (Postgres caído), el candado
      // vence solo a los 120 s y otro worker retoma el mensaje.
      console.error('No se pudo registrar el fallo del intento', { message_id: reclamo.messageId, error: String(error) });
    });
  }
  return true;
}

interface Turno extends ResultadoTurno {
  estadoMensaje: 'procesado' | 'fallido';
}

/** Decisión previa y, si corresponde, el ciclo con el modelo. */
async function decidir(reclamo: Reclamo, plazo: Plazo, traza: Traza, deps: Dependencias): Promise<Turno> {
  const { base, limites } = deps;

  // 1. Conversación escalada: es terminal para el asistente. Respuesta fija, sin modelo.
  if (reclamo.estadoConversacion === 'escalada') {
    traza.tipo = 'respaldo';
    traza.motivo = 'conversacion_escalada';
    return { tipo: 'respaldo', texto: plantillas.RESPALDO_YA_ESCALADA, estadoMensaje: 'procesado' };
  }

  // 2. ¿Un intento anterior ya creó la cita y murió antes de responder?
  //    Entonces no se llama al modelo: se confirma con los datos reales.
  const [cita] = await base.enTransaccion((tx) => tx.ejecutar('cita_de_mensaje', { message_id: reclamo.messageId }), plazo.paraBase());
  const [clinica] = await base.enTransaccion((tx) => tx.ejecutar('contexto_clinica', { clinica_id: reclamo.clinicaId }), plazo.paraBase());
  const zona: string = clinica!.zona_horaria;
  if (cita) {
    traza.tipo = 'recuperacion_cita';
    return {
      tipo: 'confirmacion_cita',
      texto: plantillas.confirmacionCita({ iniciaEn: cita.inicia_en, profesional: cita.profesional, sede: cita.sede, especialidad: cita.especialidad }, zona),
      estadoMensaje: 'procesado',
    };
  }

  // 3. Se agotaron los intentos con el modelo: respaldo y a un humano.
  if (reclamo.intento > limites.maxIntentos) {
    traza.tipo = 'respaldo';
    traza.motivo = 'reintentos_agotados';
    return { tipo: 'respaldo', texto: plantillas.RESPALDO_REINTENTOS, motivoEscalamiento: 'reintentos_agotados', estadoMensaje: 'fallido' };
  }

  // 4. Ciclo normal.
  const [sedes, especialidades, historial] = await Promise.all([
    base.enTransaccion((tx) => tx.ejecutar('contexto_sedes', { clinica_id: reclamo.clinicaId }), plazo.paraBase()),
    base.enTransaccion((tx) => tx.ejecutar('contexto_especialidades', { clinica_id: reclamo.clinicaId }), plazo.paraBase()),
    base.enTransaccion((tx) => tx.ejecutar('contexto_ultimos_turnos', { conversacion_id: reclamo.conversacionId, n: limites.turnosDeContexto }), plazo.paraBase()),
  ]);
  const contexto: ContextoIntento = {
    ...reclamo, nombreClinica: clinica!.nombre, zona, plazo,
    sedes: sedes as ContextoIntento['sedes'], especialidades: especialidades as ContextoIntento['especialidades'],
  };
  try {
    const resultado = await ejecutarCiclo(contexto, historial as TurnoAnterior[], deps, traza);
    return { ...resultado, estadoMensaje: 'procesado' };
  } catch (causa) {
    if (!(causa instanceof ErrorLogico)) throw causa;
    // Fallo lógico: reintentar daría lo mismo. Se escala con su motivo.
    traza.error = `ErrorLogico: ${causa.motivo}`;
    return { tipo: 'escalamiento', texto: plantillas.ESCALAMIENTO, motivoEscalamiento: causa.motivo, estadoMensaje: 'procesado' };
  }
}

/** Transacción de cierre: respuesta, estado de la conversación y traza, condicionadas al intento. */
async function cerrar(reclamo: Reclamo, turno: Turno, traza: Traza, plazo: Plazo, deps: Dependencias): Promise<void> {
  const { base, reloj } = deps;
  const estadoConversacion = turno.motivoEscalamiento ? 'escalada' : estadoQuePide(turno.tipo);
  traza.textoAsistente = turno.texto;
  traza.resultado = { tipo: turno.tipo, estado_conversacion: estadoConversacion };

  await base.enTransaccion(async (tx) => {
    const ahora = reloj.ahora();
    await tx.ejecutar('bloquear_conversacion', { message_id: reclamo.messageId });
    const aplicado = await tx.ejecutar('cierre_mensaje', {
      message_id: reclamo.messageId, intento: reclamo.intento, estado_mensaje: turno.estadoMensaje,
      respuesta_tipo: turno.tipo, respuesta_texto: turno.texto,
    });
    let resultado: ResultadoProcesamiento = 'descartado_por_intento';
    if (aplicado.length > 0) {
      await tx.ejecutar('cierre_conversacion', {
        conversacion_id: reclamo.conversacionId, estado_conversacion: estadoConversacion, motivo: turno.motivoEscalamiento ?? null, ahora,
      });
      resultado = turno.estadoMensaje === 'fallido' ? 'fallido' : 'completado';
    }
    // La traza se guarda siempre, en la misma transacción: aplique o no el cierre.
    await tx.ejecutar('traza_insertar', { message_id: reclamo.messageId, intento: reclamo.intento, documento: JSON.stringify(traza.documento(resultado)), ahora });
  }, Math.max(plazo.paraBase(), 2000));
}

/** Transacción de fallo: el mensaje vuelve a la cola con espera y se libera el candado. */
async function fallar(reclamo: Reclamo, traza: Traza, deps: Dependencias): Promise<void> {
  const { base, reloj, limites } = deps;
  const espera = limites.esperasReintentoMs[reclamo.intento - 1] ?? 0;
  await base.enTransaccion(async (tx) => {
    const ahora = reloj.ahora();
    await tx.ejecutar('bloquear_conversacion', { message_id: reclamo.messageId });
    const aplicado = await tx.ejecutar('fallo_mensaje', {
      message_id: reclamo.messageId, intento: reclamo.intento, proximo_intento_en: new Date(ahora.getTime() + espera),
    });
    if (aplicado.length > 0) await tx.ejecutar('fallo_liberar_candado', { conversacion_id: reclamo.conversacionId });
    const resultado: ResultadoProcesamiento = aplicado.length > 0 ? 'fallido' : 'descartado_por_intento';
    await tx.ejecutar('traza_insertar', { message_id: reclamo.messageId, intento: reclamo.intento, documento: JSON.stringify(traza.documento(resultado)), ahora });
  });
}

async function registrarDescartado(reclamo: Reclamo, traza: Traza, deps: Dependencias): Promise<void> {
  traza.error = 'intento_vencido';
  await deps.base.enTransaccion((tx) =>
    tx.ejecutar('traza_insertar', { message_id: reclamo.messageId, intento: reclamo.intento, documento: JSON.stringify(traza.documento('descartado_por_intento')), ahora: deps.reloj.ahora() }),
  );
}

/** Ciclo principal del worker. Corre hasta que `seguir()` devuelva false. */
export async function cicloDelWorker(deps: Dependencias, seguir: () => boolean): Promise<void> {
  while (seguir()) {
    let huboTrabajo = false;
    try {
      huboTrabajo = await procesarUno(deps);
    } catch (error) {
      if (error instanceof ErrorDeProgramacion) throw error;
      console.error('Error en el ciclo del worker', String(error)); // p. ej. Postgres caído durante el reclamo
    }
    if (!huboTrabajo) {
      // Sin trabajo (o sin poder tomarlo): esperar. La variación evita que
      // todos los workers consulten la cola en el mismo instante.
      const variacion = 0.75 + Math.random() * 0.5;
      await new Promise((resolver) => setTimeout(resolver, deps.limites.esperaSinTrabajoMs * variacion));
    }
  }
}
