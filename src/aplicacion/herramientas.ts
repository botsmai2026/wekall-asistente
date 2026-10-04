// Las cinco herramientas del asistente.
//
// Idea central: el modelo propone y el código decide. El modelo puede pedir
// "agenda el H3", pero aquí se comprueba que H3 sea un horario que el código le
// mostró en este intento, que siga siendo futuro y que nadie lo haya tomado.
// Cada herramienta valida dos veces:
//   1. Forma: con el esquema TypeBox (el mismo que se le envió al modelo).
//   2. Negocio: contra la base de datos.
// Un argumento inválido no es una excepción: vuelve al modelo como resultado,
// para que corrija o le pregunte al paciente.
//
// El teléfono y la clínica nunca son argumentos. Vienen del contexto del
// mensaje, así que el modelo no puede actuar sobre otro paciente ni otra clínica.
import { Kind, Type, TypeRegistry, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { ErrorLogico } from '../dominio/errores.js';
import {
  DIAS_SEMANA, escribirFecha, escribirHora, fechaLocalDe, rangoDelDia, resolverReferencia, validarFecha,
  type Franja, type ReferenciaFecha,
} from '../dominio/fechas.js';
import * as plantillas from '../dominio/plantillas.js';
import { FALTANTES, type Faltante } from '../dominio/plantillas.js';
import { esViolacionDeUnicidad, revertir } from '../infraestructura/postgres.js';
import { IntentoVencido, type ContextoIntento, type Dependencias, type MemoriaIntento, type ResultadoTurno } from './intento.js';
import type { DefinicionHerramienta } from './puertos.js';

export const MOTIVOS_ESCALAMIENTO = ['paciente_lo_pide', 'urgencia_medica', 'queja_o_reclamo', 'tema_fuera_de_alcance'] as const;

const TIPOS_RESPONDER = ['respuesta_documental', 'oferta_horarios', 'sin_disponibilidad', 'confirmacion_cita', 'pregunta_aclaratoria', 'sin_informacion'] as const;
const MAX_LINEAS_RESPUESTA = 4;
const MAX_HORARIOS = 8;

// Lista cerrada de textos. Se declara como un "enum" de JSON Schema, que es la
// forma que mejor entienden los modelos, y se registra en TypeBox para que
// valide con esa misma definición.
if (!TypeRegistry.Has('ListaCerrada')) {
  TypeRegistry.Set<{ enum: string[] }>('ListaCerrada', (esquema, valor) => typeof valor === 'string' && esquema.enum.includes(valor));
}
function unoDe(valores: readonly string[]): TSchema {
  return Type.Unsafe<string>({ [Kind]: 'ListaCerrada', type: 'string', enum: [...valores] });
}

/**
 * Las herramientas de un intento. Sede y especialidad son listas cerradas con
 * los nombres reales de la clínica: el modelo no puede inventar una.
 */
export function definirHerramientas(contexto: ContextoIntento): DefinicionHerramienta[] {
  const fecha = Type.Union([
    Type.Object({ dias_desde_hoy: Type.Integer({ minimum: 0, maximum: 365 }) }, { additionalProperties: false, description: 'Días contados desde hoy. Hoy = 0, mañana = 1, pasado mañana = 2.' }),
    Type.Object({ dia_semana: unoDe(DIAS_SEMANA), semana_siguiente: Type.Optional(Type.Boolean()) }, { additionalProperties: false, description: 'Un día de la semana. Sin semana_siguiente: la próxima vez que ocurra, sin contar hoy. Con semana_siguiente = true: ese día de la semana que viene.' }),
    Type.Object({ dia: Type.Integer({ minimum: 1, maximum: 31 }), mes: Type.Integer({ minimum: 1, maximum: 12 }) }, { additionalProperties: false, description: 'Día y mes. El año lo calcula el sistema.' }),
  ]);
  return [
    {
      nombre: 'buscar_conocimiento',
      descripcion: 'Busca en los documentos de la clínica. Úsala para cualquier pregunta informativa (horarios de atención, preparación de exámenes, convenios, políticas, pagos).',
      esquema: Type.Object({ pregunta: Type.String({ minLength: 3, maxLength: 500 }) }, { additionalProperties: false }),
    },
    {
      nombre: 'consultar_disponibilidad',
      descripcion: 'Consulta los horarios libres de una especialidad en una fecha. Devuelve la fecha consultada y horarios con etiquetas H1, H2…',
      esquema: Type.Object(
        {
          especialidad: unoDe(contexto.especialidades.map((e) => e.nombre)),
          sede: Type.Optional(unoDe(contexto.sedes.map((s) => s.nombre))),
          fecha,
          franja: Type.Optional(unoDe(['manana', 'tarde'])),
        },
        { additionalProperties: false },
      ),
    },
    {
      nombre: 'agendar_cita',
      descripcion: 'Agenda la cita en un horario devuelto por consultar_disponibilidad en este mismo turno. Solo cuando el paciente ya eligió un horario concreto.',
      esquema: Type.Object({ horario: Type.String({ pattern: '^H[0-9]{1,3}$' }) }, { additionalProperties: false }),
    },
    {
      nombre: 'escalar_a_humano',
      descripcion: 'Pasa la conversación a un asesor humano. Termina el turno.',
      esquema: Type.Object({ motivo: unoDe(MOTIVOS_ESCALAMIENTO) }, { additionalProperties: false }),
    },
    {
      nombre: 'responder',
      descripcion:
        'Termina el turno con una respuesta al paciente. El texto lo escribe el sistema. ' +
        'respuesta_documental: requiere "lineas" (etiquetas como F1.2). oferta_horarios: requiere "horarios" (etiquetas H). ' +
        'pregunta_aclaratoria: requiere "faltantes". Los demás tipos no llevan datos.',
      esquema: Type.Object(
        {
          tipo: unoDe(TIPOS_RESPONDER),
          lineas: Type.Optional(Type.Array(Type.String({ pattern: '^F[0-9]{1,3}\\.[0-9]{1,3}$' }), { minItems: 1, maxItems: MAX_LINEAS_RESPUESTA })),
          horarios: Type.Optional(Type.Array(Type.String({ pattern: '^H[0-9]{1,3}$' }), { minItems: 1, maxItems: MAX_HORARIOS })),
          faltantes: Type.Optional(Type.Array(unoDe(FALTANTES), { minItems: 1, maxItems: FALTANTES.length })),
        },
        { additionalProperties: false },
      ),
    },
  ];
}

/** Lo que devuelve ejecutar una herramienta: o un resultado para el modelo, o el fin del turno. */
export type Salida =
  | { resultado: Record<string, unknown>; real?: Record<string, unknown> } // `real`: identificadores reales, solo para la traza
  | { fin: ResultadoTurno; real?: Record<string, unknown> };

function error(codigo: string, detalle: string): Salida {
  return { resultado: { error: codigo, detalle } };
}

export async function ejecutarHerramienta(
  definiciones: DefinicionHerramienta[],
  nombre: string,
  argumentosCrudos: string,
  contexto: ContextoIntento,
  memoria: MemoriaIntento,
  deps: Dependencias,
): Promise<{ argumentos: unknown; salida: Salida }> {
  const definicion = definiciones.find((d) => d.nombre === nombre);
  if (!definicion) return { argumentos: argumentosCrudos, salida: error('herramienta_desconocida', `No existe la herramienta "${nombre}".`) };

  let argumentos: unknown;
  try {
    argumentos = JSON.parse(argumentosCrudos);
  } catch {
    return { argumentos: argumentosCrudos, salida: error('argumentos_invalidos', 'Los argumentos no son JSON válido.') };
  }
  const esquema = definicion.esquema as TSchema;
  if (!Value.Check(esquema, argumentos)) {
    const primero = Value.Errors(esquema, argumentos).First();
    const donde = primero?.path ? ` en "${primero.path}"` : '';
    const permitidos = Array.isArray(primero?.schema.enum) ? ` Valores permitidos: ${primero.schema.enum.join(', ')}.` : '';
    return { argumentos, salida: error('argumentos_invalidos', `Argumentos inválidos${donde}: ${primero?.message ?? 'no cumplen el esquema'}.${permitidos}`) };
  }

  const a = argumentos as any;
  switch (nombre) {
    case 'buscar_conocimiento':
      return { argumentos, salida: await buscarConocimiento(a.pregunta, contexto, memoria, deps) };
    case 'consultar_disponibilidad':
      return { argumentos, salida: await consultarDisponibilidad(a, contexto, memoria, deps) };
    case 'agendar_cita':
      return { argumentos, salida: await agendarCita(a.horario, contexto, memoria, deps) };
    case 'escalar_a_humano':
      // Si en este turno ya se creó una cita, el paciente tiene que recibir su
      // confirmación. Escalar aquí lo dejaría con una cita de la que nadie le habló.
      if (memoria.citaCreada) {
        return { argumentos, salida: error('respuesta_no_permitida', 'En este turno se agendó una cita. Usa responder con tipo confirmacion_cita.') };
      }
      // No escribe nada: devuelve la intención. El cierre del intento, protegido
      // contra workers tardíos, es el que guarda el estado "escalada".
      return { argumentos, salida: { fin: { tipo: 'escalamiento', texto: plantillas.ESCALAMIENTO, motivoEscalamiento: a.motivo } } };
    default:
      return { argumentos, salida: await responder(a, contexto, memoria, deps) };
  }
}

// --------------------------------------------------------------------------
// buscar_conocimiento
// --------------------------------------------------------------------------
async function buscarConocimiento(pregunta: string, contexto: ContextoIntento, memoria: MemoriaIntento, deps: Dependencias): Promise<Salida> {
  const { base, embeddings, limites } = deps;
  // Si el servicio de embeddings falla, esto lanza ErrorInfraestructura y el
  // intento se aborta. No se devuelve "sin resultados": sería una respuesta falsa.
  const [vector] = await embeddings.generar([pregunta], contexto.plazo.limitePara(limites.limiteEmbeddingsMs));
  // Una sola sentencia trae los fragmentos más cercanos con su documento y sus
  // líneas. Así la búsqueda y el texto salen de la misma fotografía de la base:
  // una reingestión simultánea no puede dejar un fragmento encontrado sin líneas.
  const filas = await base.enTransaccion(
    (tx) => tx.ejecutar('conocimiento_buscar_con_texto', { clinica_id: contexto.clinicaId, modelo: embeddings.modelo, embedding: JSON.stringify(vector) }),
    contexto.plazo.paraBase(),
  );
  memoria.busquedas += 1;
  const utiles = filas.filter((f) => Number(f.similitud) >= limites.umbralSimilitud);

  if (utiles.length === 0) {
    // Un vacío solo significa "no existe" si el conocimiento de la clínica está completo.
    const [fila] = await base.enTransaccion((tx) => tx.ejecutar('conocimiento_estado', { clinica_id: contexto.clinicaId, modelo: embeddings.modelo }), contexto.plazo.paraBase());
    const estado = Object.values(fila!)[0];
    if (estado === 'parcial' || estado === 'desactualizado') throw new ErrorLogico('conocimiento_no_disponible');
    return {
      resultado: { fragmentos: [], nota: 'Ningún documento de la clínica respalda una respuesta. Usa responder con tipo sin_informacion, o escalar_a_humano.' },
      real: { similitudes: [...new Set(filas.map((f) => Number(f.similitud)))], estado_conocimiento: estado },
    };
  }

  const paraModelo: unknown[] = [];
  const paraTraza: unknown[] = [];
  // Las filas vienen ordenadas por similitud y, dentro de cada fragmento, por número de línea.
  for (const fragmentoId of [...new Set(utiles.map((f) => f.fragmento_id))]) {
    const lineas = utiles.filter((f) => f.fragmento_id === fragmentoId);
    const fragmento = lineas[0]!;
    memoria.fragmentosVistos += 1;
    const etiqueta = `F${memoria.fragmentosVistos}`;
    if (!memoria.ordenDocumentos.includes(fragmento.documento_id)) memoria.ordenDocumentos.push(fragmento.documento_id);
    const encabezado = lineas.find((l) => l.numero === fragmento.linea_encabezado);
    const cuerpo = lineas.filter((l) => l.numero !== fragmento.linea_encabezado);
    const etiquetadas = cuerpo.map((l, i) => {
      const etiquetaLinea = `${etiqueta}.${i + 1}`;
      memoria.lineas.set(etiquetaLinea, { documentoId: fragmento.documento_id, numero: l.numero, encabezado: fragmento.linea_encabezado, texto: l.texto });
      return { etiqueta: etiquetaLinea, texto: l.texto };
    });
    paraModelo.push({ etiqueta, documento: fragmento.titulo, seccion: encabezado?.texto ?? '', lineas: etiquetadas });
    // La traza guarda el texto literal y la huella: sigue siendo legible aunque el documento se reingiera después.
    paraTraza.push({
      etiqueta, fragmento_id: fragmentoId, documento_id: fragmento.documento_id, titulo: fragmento.titulo, huella: fragmento.huella,
      similitud: Number(fragmento.similitud), encabezado: encabezado?.texto ?? '', lineas: cuerpo.map((l) => ({ numero: l.numero, texto: l.texto })),
    });
  }
  return { resultado: { fragmentos: paraModelo }, real: { fragmentos: paraTraza } };
}

// --------------------------------------------------------------------------
// consultar_disponibilidad
// --------------------------------------------------------------------------
async function consultarDisponibilidad(
  a: { especialidad: string; sede?: string; fecha: ReferenciaFecha; franja?: Franja },
  contexto: ContextoIntento,
  memoria: MemoriaIntento,
  deps: Dependencias,
): Promise<Salida> {
  const { base, reloj, limites } = deps;
  // "Hoy" para interpretar la referencia es el día en que el paciente escribió.
  const hoyDelMensaje = fechaLocalDe(contexto.enviadoEn, contexto.zona);
  const fecha = resolverReferencia(a.fecha, hoyDelMensaje);
  if ('error' in fecha) return error(fecha.error, 'Esa fecha no existe. Pide al paciente una fecha concreta.');
  // Pasado o futuro lo decide el reloj real, no la hora que declara el mensaje.
  const ahora = reloj.ahora();
  const problema = validarFecha(fecha, fechaLocalDe(ahora, contexto.zona), limites.horizonteAgendaDias);
  if (problema === 'fecha_pasada') return error('fecha_pasada', `La fecha ${escribirFecha(fecha)} ya pasó. Pide al paciente otra fecha.`);
  if (problema) return error(problema, `La agenda solo está abierta para los próximos ${limites.horizonteAgendaDias} días.`);

  // El modelo habló con nombres; el esquema ya garantizó que existen. Aquí se pasan a identificadores.
  const especialidad = contexto.especialidades.find((e) => e.nombre === a.especialidad)!;
  const sede = a.sede ? contexto.sedes.find((s) => s.nombre === a.sede)! : null;
  const { desde, hasta } = rangoDelDia(fecha, a.franja, contexto.zona);

  const filas = await base.enTransaccion(
    (tx) => tx.ejecutar('disponibilidad', { clinica_id: contexto.clinicaId, especialidad_id: especialidad.id, sede_id: sede?.id ?? null, desde, hasta, ahora }),
    contexto.plazo.paraBase(),
  );

  const horarios = filas.map((fila) => {
    const etiqueta = `H${memoria.horarios.size + 1}`;
    const nombreSede = contexto.sedes.find((s) => s.id === fila.sede_id)?.nombre ?? '';
    memoria.horarios.set(etiqueta, { slotId: fila.id, iniciaEn: fila.inicia_en, profesional: fila.profesional, sede: nombreSede, especialidad: especialidad.nombre });
    return { etiqueta, hora: escribirHora(fila.inicia_en, contexto.zona), profesional: fila.profesional, sede: nombreSede };
  });
  memoria.ultimaConsulta = { especialidad: especialidad.nombre, sede: sede?.nombre ?? null, fecha, vacia: horarios.length === 0 };

  return {
    resultado: { fecha_consultada: escribirFecha(fecha), especialidad: especialidad.nombre, horarios },
    real: { fecha, desde, hasta, especialidad_id: especialidad.id, sede_id: sede?.id ?? null, slots: filas.map((f) => f.id) },
  };
}

// --------------------------------------------------------------------------
// agendar_cita
// --------------------------------------------------------------------------
type ResultadoAgendar = 'creada' | 'propia' | 'ocupado' | 'pasado' | 'horario_invalido';

async function agendarCita(etiqueta: string, contexto: ContextoIntento, memoria: MemoriaIntento, deps: Dependencias): Promise<Salida> {
  const { base, reloj } = deps;
  const horario = memoria.horarios.get(etiqueta);
  if (!horario) return error('etiqueta_desconocida', `"${etiqueta}" no es un horario devuelto en este turno. Vuelve a usar consultar_disponibilidad.`);
  if (memoria.citaCreada) return error('maximo_un_agendamiento_por_mensaje', 'Ya se agendó una cita en este turno. Usa responder con tipo confirmacion_cita.');

  let resultado: ResultadoAgendar;
  try {
    resultado = await base.enTransaccion<ResultadoAgendar>(async (tx) => {
      // La hora se toma al empezar ESTA transacción y todas sus sentencias usan la misma.
      const ahora = reloj.ahora();
      // Orden global de bloqueos: conversación, mensaje, cita.
      await tx.ejecutar('bloquear_conversacion', { message_id: contexto.messageId });
      const vigente = await tx.ejecutar('verificar_intento', { message_id: contexto.messageId, intento: contexto.intento });
      if (vigente.length === 0) throw new IntentoVencido();

      const [clasificado] = await tx.ejecutar('agendar_clasificar_horario', { conversacion_id: contexto.conversacionId, slot_id: horario.slotId, ahora });
      if (!clasificado) return revertir<ResultadoAgendar>('horario_invalido');
      if (!clasificado.es_futuro) return revertir<ResultadoAgendar>('pasado');

      const insertada = await tx.ejecutar('agendar_insertar_cita', { conversacion_id: contexto.conversacionId, slot_id: horario.slotId, message_id: contexto.messageId, ahora });
      if (insertada.length === 0) return revertir<ResultadoAgendar>('pasado');

      await tx.ejecutar('agendar_subir_estado', { conversacion_id: contexto.conversacionId });
      return 'creada';
    }, contexto.plazo.paraBase());
  } catch (causa) {
    if (!esViolacionDeUnicidad(causa)) throw causa;
    // Hubo un conflicto. No se confía en cuál restricción reportó Postgres: se
    // pregunta si existe una cita de ESTE mensaje. Si existe, es la propia de un
    // intento anterior; si no, el horario lo tomó otro paciente.
    const propia = await base.enTransaccion((tx) => tx.ejecutar('cita_de_mensaje', { message_id: contexto.messageId }), contexto.plazo.paraBase());
    resultado = propia.length > 0 ? 'propia' : 'ocupado';
  }

  if (resultado === 'ocupado') return error('ocupado', 'Ese horario lo acaba de tomar otro paciente. Ofrece otro horario.');
  if (resultado === 'pasado') return error('pasado', 'Ese horario ya pasó. Ofrece otro horario.');
  if (resultado === 'horario_invalido') return error('horario_invalido', 'Ese horario no es válido. Vuelve a usar consultar_disponibilidad.');

  // Creada (o propia): los datos de la confirmación se leen de la base, no de lo que recuerde el modelo.
  const [cita] = await base.enTransaccion((tx) => tx.ejecutar('cita_de_mensaje', { message_id: contexto.messageId }), contexto.plazo.paraBase());
  memoria.citaCreada = { iniciaEn: cita!.inicia_en, profesional: cita!.profesional, sede: cita!.sede, especialidad: cita!.especialidad };
  return {
    resultado: { estado: 'cita_agendada', siguiente_paso: 'Usa responder con tipo confirmacion_cita.' },
    real: { resultado, cita_id: cita!.id, slot_id: cita!.slot_id },
  };
}

// --------------------------------------------------------------------------
// responder
// --------------------------------------------------------------------------
async function responder(
  a: { tipo: (typeof TIPOS_RESPONDER)[number]; lineas?: string[]; horarios?: string[]; faltantes?: Faltante[] },
  contexto: ContextoIntento,
  memoria: MemoriaIntento,
  deps: Dependencias,
): Promise<Salida> {
  // Si en este turno se creó una cita, el paciente tiene que enterarse: no se acepta otra respuesta.
  if (memoria.citaCreada && a.tipo !== 'confirmacion_cita') {
    return error('respuesta_no_permitida', 'En este turno se agendó una cita. Usa responder con tipo confirmacion_cita.');
  }
  switch (a.tipo) {
    case 'respuesta_documental': {
      if (!a.lineas) return error('faltan_datos', 'respuesta_documental requiere "lineas".');
      const elegidas = [];
      for (const etiqueta of a.lineas) {
        const linea = memoria.lineas.get(etiqueta);
        if (!linea) return error('linea_desconocida', `"${etiqueta}" no es una línea devuelta por buscar_conocimiento en este turno.`);
        elegidas.push(linea);
      }
      // Se piden las líneas elegidas y el encabezado de su sección. La consulta
      // quita las repetidas, filtra por clínica y ordena: nada de eso depende de este código.
      const pares = elegidas
        .flatMap((l) => [{ documento: l.documentoId, numero: l.encabezado }, { documento: l.documentoId, numero: l.numero }])
        .sort((x, y) => memoria.ordenDocumentos.indexOf(x.documento) - memoria.ordenDocumentos.indexOf(y.documento));
      const filas = await deps.base.enTransaccion(
        (tx) => tx.ejecutar('conocimiento_armar_respuesta', { clinica_id: contexto.clinicaId, documentos: pares.map((p) => p.documento), numeros: pares.map((p) => p.numero) }),
        contexto.plazo.paraBase(),
      );
      // Si el documento se reingirió después de la búsqueda, sus líneas ya no existen.
      // Se exige que estén TODAS: una respuesta con solo una parte sería un texto incompleto sin aviso.
      const pedidas = new Set(pares.map((p) => `${p.documento}#${p.numero}`)).size;
      if (filas.length !== pedidas) return error('lineas_no_disponibles', 'El documento cambió y esas líneas ya no están disponibles. Vuelve a usar buscar_conocimiento.');
      return {
        fin: { tipo: 'respuesta_documental', texto: filas.map((f) => f.texto).join('\n') },
        real: { lineas: filas.map((f) => ({ documento_id: f.documento_id, numero: f.numero, texto: f.texto })) },
      };
    }
    case 'oferta_horarios': {
      if (!a.horarios) return error('faltan_datos', 'oferta_horarios requiere "horarios".');
      const elegidos = [];
      for (const etiqueta of [...new Set(a.horarios)]) {
        const horario = memoria.horarios.get(etiqueta);
        if (!horario) return error('etiqueta_desconocida', `"${etiqueta}" no es un horario devuelto en este turno.`);
        elegidos.push(horario);
      }
      if (new Set(elegidos.map((h) => h.especialidad)).size > 1) {
        return error('respuesta_no_permitida', 'Una oferta solo puede tener horarios de una misma especialidad.');
      }
      elegidos.sort((x, y) => x.iniciaEn.getTime() - y.iniciaEn.getTime());
      return {
        fin: { tipo: 'oferta_horarios', texto: plantillas.ofertaHorarios(elegidos[0]!.especialidad, elegidos, contexto.zona) },
        real: { slots: elegidos.map((h) => h.slotId) },
      };
    }
    case 'sin_disponibilidad': {
      const consulta = memoria.ultimaConsulta;
      if (!consulta || !consulta.vacia) return error('respuesta_no_permitida', 'sin_disponibilidad solo es válida si la última consulta de disponibilidad de este turno no devolvió horarios.');
      return { fin: { tipo: 'sin_disponibilidad', texto: plantillas.sinDisponibilidad(consulta.especialidad, consulta.fecha, consulta.sede) } };
    }
    case 'confirmacion_cita': {
      if (!memoria.citaCreada) return error('respuesta_no_permitida', 'No se ha agendado ninguna cita en este turno. Usa agendar_cita primero.');
      return { fin: { tipo: 'confirmacion_cita', texto: plantillas.confirmacionCita(memoria.citaCreada, contexto.zona) } };
    }
    case 'pregunta_aclaratoria': {
      if (!a.faltantes) return error('faltan_datos', 'pregunta_aclaratoria requiere "faltantes".');
      return { fin: { tipo: 'pregunta_aclaratoria', texto: plantillas.preguntaAclaratoria(a.faltantes) } };
    }
    case 'sin_informacion':
      // "No tengo esa información" es una afirmación sobre los documentos de la
      // clínica: solo se acepta si en este intento se buscó en ellos. No se exige
      // que la búsqueda saliera vacía: puede traer fragmentos parecidos que no
      // contestan la pregunta, y ahí la respuesta correcta sigue siendo esta.
      if (memoria.busquedas === 0) {
        return error('respuesta_no_permitida', 'Antes de responder sin_informacion debes usar buscar_conocimiento en este turno.');
      }
      return { fin: { tipo: 'sin_informacion', texto: plantillas.SIN_INFORMACION } };
  }
}
