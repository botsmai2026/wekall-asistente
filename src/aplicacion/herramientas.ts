// Las cinco herramientas del asistente.
//
// Idea central: el modelo propone y el código decide. El modelo puede pedir
// "agenda la opción 3", pero aquí se exige esa posición en el mensaje completo
// y en la oferta persistida, que siga siendo futura y que nadie la haya tomado.
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
  contrastarConMensaje, DIAS_SEMANA, escribirFecha, escribirHora, fechaLocalDe, normalizarDiaSemana, rangoDelDia, resolverReferencia, validarFecha,
  type Franja, type ReferenciaFecha,
} from '../dominio/fechas.js';
import { extraerPosicion } from '../dominio/seleccion.js';
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
      descripcion: 'Consulta los horarios libres de una especialidad en una fecha. Si el paciente dijo "en la mañana" o "en la tarde", envíalo en "franja" (manana = antes del mediodía, tarde = desde el mediodía); sin franja se consulta todo el día. Devuelve la fecha consultada y horarios con etiquetas H1, H2…',
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
      descripcion:
        'Crea una cita solo con "opcion": debe coincidir con una selección posicional inequívoca del mensaje completo (por ejemplo "2", "la segunda", "opción 3") sobre la última oferta recibida. ' +
        '"atributos" busca por hora, sede o profesional dentro de esa oferta y produce otra oferta numerada; nunca crea una cita, incluso si hay una sola coincidencia. ' +
        'Para cualquier otra expresión, pide el número de opción. Las etiquetas H solo sirven para ofrecer horarios, nunca para reservar.',
      esquema: Type.Object(
        {
          opcion: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_HORARIOS })),
          atributos: Type.Optional(
            Type.Object(
              {
                hora: Type.Optional(Type.String({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$', description: 'Hora en formato de 24 horas, por ejemplo "08:00" o "15:30".' })),
                sede: Type.Optional(unoDe(contexto.sedes.map((s) => s.nombre))),
                profesional: Type.Optional(Type.String({ minLength: 2, maxLength: 80, description: 'Nombre o apellido del profesional, como lo dijo el paciente.' })),
              },
              { additionalProperties: false, minProperties: 1 },
            ),
          ),
        },
        { additionalProperties: false },
      ),
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
  // "miércoles" y "sábado" llevan tilde y la lista cerrada no. Se aceptan como el
  // modelo los escriba: si se rechazan, el modelo pasa a contar los días él mismo
  // (dias_desde_hoy), y contar es justo lo que no se le confía.
  const fecha = nombre === 'consultar_disponibilidad' ? (argumentos as { fecha?: { dia_semana?: unknown } } | null)?.fecha : undefined;
  if (fecha && typeof fecha.dia_semana === 'string') fecha.dia_semana = normalizarDiaSemana(fecha.dia_semana);
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
      return { argumentos, salida: await agendarCita(a, contexto, memoria, deps) };
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
  const delModelo = resolverReferencia(a.fecha, hoyDelMensaje);
  if ('error' in delModelo) return error(delModelo.error, 'Esa fecha no existe. Pide al paciente una fecha concreta.');
  // Si el paciente nombró un día de la semana, la fecha sale de lo que escribió, no de la cuenta del modelo.
  const contraste = contrastarConMensaje(delModelo, contexto.texto, hoyDelMensaje);
  if ('error' in contraste) {
    return error('fecha_no_coincide', `El ${escribirFecha(delModelo)} no es ninguna de las fechas que escribió el paciente. Consulta una de ellas, o pide una fecha concreta con pregunta_aclaratoria.`);
  }
  const fecha = contraste.fecha;
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
  if (memoria.eleccionFallida) memoria.eleccionFallida.consultoDespues = true;
  memoria.ultimaConsulta = { especialidad: especialidad.nombre, sede: sede?.nombre ?? null, fecha, franja: a.franja ?? null, vacia: horarios.length === 0 };

  return {
    resultado: { fecha_consultada: escribirFecha(fecha), especialidad: especialidad.nombre, horarios },
    real: { fecha, ...(contraste.corregida ? { fecha_modelo: delModelo } : {}), desde, hasta, especialidad_id: especialidad.id, sede_id: sede?.id ?? null, slots: filas.map((f) => f.id) },
  };
}

// --------------------------------------------------------------------------
// agendar_cita
// --------------------------------------------------------------------------
type ResultadoAgendar = 'creada' | 'propia' | 'ocupado' | 'pasado' | 'horario_invalido' | 'oferta_no_vigente';

interface Atributos { hora?: string; sede?: string; profesional?: string }

/** Minúsculas, sin tildes y sin tratamientos: "Dra. Laura Gómez" → ["laura", "gomez"]. */
function palabrasDeNombre(nombre: string): string[] {
  return nombre.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .split(/[^a-z0-9]+/).filter((p) => p && !['dr', 'dra', 'doctor', 'doctora'].includes(p));
}

function horaLocal24(instante: Date, zona: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: zona, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(instante);
}

async function agendarCita(a: { opcion?: number; atributos?: Atributos }, contexto: ContextoIntento, memoria: MemoriaIntento, deps: Dependencias): Promise<Salida> {
  const { base, reloj } = deps;
  // Barrera: si en este intento ya falló la elección del paciente, no se crea
  // ninguna cita, venga como venga la petición (otra opción o la misma). No depende de que el modelo obedezca: lo impide el código.
  if (memoria.eleccionFallida) {
    return error('nueva_eleccion_requerida', 'El horario que eligió el paciente ya no está disponible y en este turno no se puede agendar otro. Usa consultar_disponibilidad y luego responder (oferta_horarios o sin_disponibilidad): el paciente debe elegir de nuevo en su siguiente mensaje.');
  }
  if ((a.opcion === undefined) === (a.atributos === undefined)) {
    return error('argumentos_invalidos', 'Indica exactamente uno: "opcion" para reservar o "atributos" para buscar y ofrecer.');
  }
  if (memoria.citaCreada) return error('maximo_un_agendamiento_por_mensaje', 'Ya se agendó una cita en este turno. Usa responder con tipo confirmacion_cita.');
  if (!contexto.ofertaAnterior || contexto.ofertaAnterior.consumida) return error('sin_oferta_previa', 'No hay una oferta en espera de selección: no se ofrecieron horarios, ya se usó, o la conversación pasó a otra pregunta. Usa consultar_disponibilidad y ofrece horarios nuevos; el paciente debe elegir en otro mensaje.');
  // Los atributos pueden reducir la lista, pero nunca autorizar una reserva.
  if (a.atributos !== undefined) return resolverPorAtributos(a.atributos, contexto, deps);

  const posicion = extraerPosicion(contexto.texto);
  // El mensaje no es una selección por número ("ese", "el último"): no se reserva.
  // El turno termina aquí, con la lista actualizada, para que el paciente dé el número.
  if (posicion === null) return reofertar(contexto, deps, 'seleccion_no_posicional');
  if (a.opcion !== posicion) return error('opcion_no_autorizada', 'La opción no coincide con la posición indicada en el mensaje del paciente. Usa esa misma posición; no elijas por él.');
  const slotId = contexto.ofertaAnterior.slots[posicion - 1];
  if (slotId === undefined) return error('opcion_desconocida', `La última lista tenía ${contexto.ofertaAnterior.slots.length} opciones. Pide un número de esa lista.`);
  const horario: { slotId: number; iniciaEn: Date | null } = { slotId, iniciaEn: null };

  const oferta = contexto.ofertaAnterior;
  const autorizacion = {
    conversacion_id: contexto.conversacionId, message_id: contexto.messageId, slot_id: horario.slotId,
    oferta_message_id: oferta.messageId, oferta_secuencia: oferta.secuencia, oferta_slots: oferta.slots, opcion: posicion,
  };
  let resultado: ResultadoAgendar;
  try {
    resultado = await base.enTransaccion<ResultadoAgendar>(async (tx) => {
      // La hora se toma al empezar ESTA transacción y todas sus sentencias usan la misma.
      const ahora = reloj.ahora();
      // Orden global de bloqueos: conversación, mensaje, cita.
      await tx.ejecutar('bloquear_conversacion', { message_id: contexto.messageId });
      const vigente = await tx.ejecutar('verificar_intento', { message_id: contexto.messageId, intento: contexto.intento });
      if (vigente.length === 0) throw new IntentoVencido();
      // Una cita del mismo mensaje tiene prioridad sobre el consumo de la oferta.
      const propia = await tx.ejecutar('cita_de_mensaje', { message_id: contexto.messageId });
      if (propia.length > 0) return 'propia';
      if ((await tx.ejecutar('agendar_validar_oferta', autorizacion)).length === 0) return revertir<ResultadoAgendar>('oferta_no_vigente');

      const [clasificado] = await tx.ejecutar('agendar_clasificar_horario', { conversacion_id: contexto.conversacionId, slot_id: horario.slotId, ahora });
      if (!clasificado) return revertir<ResultadoAgendar>('horario_invalido');
      if (!clasificado.es_futuro) return revertir<ResultadoAgendar>('pasado');

      const insertada = await tx.ejecutar('agendar_insertar_cita', { ...autorizacion, ahora });
      if (insertada.length === 0) {
        const sigueVigente = await tx.ejecutar('agendar_validar_oferta', autorizacion);
        return revertir<ResultadoAgendar>(sigueVigente.length > 0 ? 'pasado' : 'oferta_no_vigente');
      }

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

  if (resultado === 'oferta_no_vigente') return error('oferta_no_vigente', 'La oferta que vio el paciente ya no está vigente. Consulta y ofrece horarios nuevamente; la nueva selección debe llegar en otro mensaje.');
  if (resultado !== 'creada' && resultado !== 'propia') {
    // El horario elegido no se pudo agendar. Se anota cuál era, para decírselo al
    // paciente, y se cierra la posibilidad de agendar otro en este intento.
    let hora = horario.iniciaEn;
    if (!hora) {
      const [fila] = await base.enTransaccion((tx) => tx.ejecutar('horario_ofrecido', { slot_id: horario.slotId, clinica_id: contexto.clinicaId }), contexto.plazo.paraBase());
      hora = fila?.inicia_en ?? null;
    }
    memoria.eleccionFallida = { slotId: horario.slotId, hora, consultoDespues: false };
    const motivo = resultado === 'ocupado' ? 'ya lo tomó otro paciente' : resultado === 'pasado' ? 'ya pasó' : 'no es válido';
    return {
      resultado: { error: resultado, detalle: `Ese horario ${motivo}. En este turno ya no se puede agendar: usa consultar_disponibilidad y luego responder con oferta_horarios (o sin_disponibilidad si no hay). El paciente elegirá en su siguiente mensaje.` },
      // Queda en la traza qué horario eligió el paciente y por qué no se agendó:
      // si la conversación termina con un asesor, puede verlo sin preguntarle de nuevo.
      real: { resultado, slot_id: horario.slotId, horario_elegido: hora },
    };
  }

  // Creada (o propia): los datos de la confirmación se leen de la base, no de lo que recuerde el modelo.
  const [cita] = await base.enTransaccion((tx) => tx.ejecutar('cita_de_mensaje', { message_id: contexto.messageId }), contexto.plazo.paraBase());
  memoria.citaCreada = { iniciaEn: cita!.inicia_en, profesional: cita!.profesional, sede: cita!.sede, especialidad: cita!.especialidad };
  return {
    resultado: { estado: 'cita_agendada', siguiente_paso: 'Usa responder con tipo confirmacion_cita.' },
    real: { resultado, cita_id: cita!.id, slot_id: cita!.slot_id },
  };
}

interface OpcionOfrecida { numero: number; slotId: number; iniciaEn: Date; profesional: string; sede: string; especialidad: string; disponible: boolean }

/**
 * Lee la oferta en espera, en el orden y con el número que vio el paciente.
 * Bajo el bloqueo de conversación comprueba que siga vigente; si no, devuelve null.
 */
async function leerOfertaEnEspera(contexto: ContextoIntento, deps: Dependencias): Promise<OpcionOfrecida[] | null> {
  const oferta = contexto.ofertaAnterior!;
  const filas = await deps.base.enTransaccion(
    async (tx) => {
      await tx.ejecutar('bloquear_conversacion', { message_id: contexto.messageId });
      if ((await tx.ejecutar('verificar_intento', { message_id: contexto.messageId, intento: contexto.intento })).length === 0) throw new IntentoVencido();
      const vigente = await tx.ejecutar('agendar_validar_oferta', {
        conversacion_id: contexto.conversacionId, message_id: contexto.messageId,
        oferta_message_id: oferta.messageId, oferta_secuencia: oferta.secuencia, oferta_slots: oferta.slots,
        opcion: 1, slot_id: oferta.slots[0],
      });
      return vigente.length > 0 ? tx.ejecutar('oferta_detalle', { slots: oferta.slots, clinica_id: contexto.clinicaId, ahora: deps.reloj.ahora() }) : null;
    },
    contexto.plazo.paraBase(),
  );
  if (filas === null) return null;
  return oferta.slots.flatMap((slotId, i) => {
    const fila = filas.find((f) => f.id === slotId);
    return fila ? [{
      numero: i + 1, slotId, iniciaEn: fila.inicia_en as Date, profesional: fila.profesional as string,
      sede: fila.sede as string, especialidad: fila.especialidad as string, disponible: fila.disponible as boolean,
    }] : [];
  });
}

/**
 * Vuelve a presentar la oferta en espera cuando el paciente no dio un número.
 * No copia la lista anterior: comprueba cada horario contra la agenda de ahora y
 * solo muestra los que siguen libres, renumerados. Esa lista se guarda como una
 * oferta nueva, y es la única contra la que vale la próxima elección.
 */
async function reofertar(contexto: ContextoIntento, deps: Dependencias, motivo: string): Promise<Salida> {
  const opciones = await leerOfertaEnEspera(contexto, deps);
  const libres = (opciones ?? []).filter((o) => o.disponible);
  if (libres.length === 0) {
    return error('oferta_no_vigente', 'Los horarios que vio el paciente ya no están disponibles. Usa consultar_disponibilidad y luego responder con oferta_horarios, o sin_disponibilidad si no hay; el paciente debe elegir en otro mensaje.');
  }
  return {
    fin: {
      tipo: 'oferta_horarios',
      texto: plantillas.reofertaHorarios(libres[0]!.especialidad, libres, contexto.zona),
      ofertaSlots: libres.map((o) => o.slotId),
    },
    real: { resultado: motivo, slots: libres.map((o) => o.slotId), retirados: opciones!.filter((o) => !o.disponible).map((o) => o.slotId) },
  };
}

/** Busca candidatos en la oferta persistida y ofrece una nueva lista; nunca reserva. */
async function resolverPorAtributos(
  atributos: Atributos,
  contexto: ContextoIntento,
  deps: Dependencias,
): Promise<Salida> {
  const buscadas = atributos.profesional === undefined ? [] : palabrasDeNombre(atributos.profesional);
  if (atributos.profesional !== undefined && buscadas.length === 0) {
    return error('argumentos_invalidos', '"profesional" debe tener un nombre o un apellido.');
  }
  const opciones = await leerOfertaEnEspera(contexto, deps);
  if (opciones === null) return error('oferta_no_vigente', 'La oferta ya no está vigente. Consulta y ofrece horarios nuevos; el paciente debe elegir en otro mensaje.');
  const coinciden = opciones.filter((o) => {
    if (atributos.hora !== undefined && horaLocal24(o.iniciaEn, contexto.zona) !== atributos.hora) return false;
    if (atributos.sede !== undefined && o.sede !== atributos.sede) return false;
    const nombre = palabrasDeNombre(o.profesional);
    return buscadas.every((p) => nombre.includes(p));
  });

  if (coinciden.length === 0) {
    return {
      resultado: {
        error: 'sin_coincidencia',
        detalle: 'Ningún horario de la última oferta coincide. Consulta y ofrece otra lista o pide un número de opción.',
        opciones: opciones.map((o) => ({ opcion: o.numero, hora: horaLocal24(o.iniciaEn, contexto.zona), profesional: o.profesional, sede: o.sede })),
      },
    };
  }
  // La lista que recibe ahora el paciente y su nueva numeración se congelan juntas.
  // Incluso una coincidencia única requiere otro mensaje con su número.
  return {
    fin: {
      tipo: 'oferta_horarios',
      texto: plantillas.aclararHorario(coinciden[0]!.especialidad, coinciden, contexto.zona),
      ofertaSlots: coinciden.map((o) => o.slotId),
    },
    real: { resultado: 'oferta_por_atributos', atributos, slots: coinciden.map((o) => o.slotId) },
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
  // Si la elección del paciente falló, tiene que enterarse: la única respuesta
  // válida es la que se lo dice (una oferta nueva, o que no quedan horarios), y
  // debe salir de una consulta hecha DESPUÉS del fallo.
  if (memoria.eleccionFallida) {
    if (a.tipo !== 'oferta_horarios' && a.tipo !== 'sin_disponibilidad') {
      return error('respuesta_no_permitida', 'El horario que eligió el paciente ya no está disponible. Usa consultar_disponibilidad y luego responder con oferta_horarios, o sin_disponibilidad si no hay horarios.');
    }
    if (!memoria.eleccionFallida.consultoDespues) {
      return error('respuesta_no_permitida', 'Antes de responder vuelve a usar consultar_disponibilidad: la disponibilidad cambió.');
    }
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
      if (memoria.eleccionFallida && elegidos.some((h) => h.slotId === memoria.eleccionFallida!.slotId)) {
        return error('respuesta_no_permitida', 'No ofrezcas el horario que ya no está disponible.');
      }
      if (new Set(elegidos.map((h) => h.especialidad)).size > 1) {
        return error('respuesta_no_permitida', 'Una oferta solo puede tener horarios de una misma especialidad.');
      }
      elegidos.sort((x, y) => x.iniciaEn.getTime() - y.iniciaEn.getTime());
      return {
        fin: {
          tipo: 'oferta_horarios',
          texto: plantillas.ofertaHorarios(elegidos[0]!.especialidad, elegidos, contexto.zona, memoria.eleccionFallida?.hora ?? null),
          // Se guarda qué se ofreció y en qué orden: la próxima elección del paciente se resuelve contra esto.
          ofertaSlots: elegidos.map((h) => h.slotId),
        },
        real: { slots: elegidos.map((h) => h.slotId) },
      };
    }
    case 'sin_disponibilidad': {
      const consulta = memoria.ultimaConsulta;
      if (!consulta || !consulta.vacia) return error('respuesta_no_permitida', 'sin_disponibilidad solo es válida si la última consulta de disponibilidad de este turno no devolvió horarios.');
      return { fin: { tipo: 'sin_disponibilidad', texto: plantillas.sinDisponibilidad(consulta.especialidad, consulta.fecha, consulta.sede, contexto.zona, memoria.eleccionFallida?.hora ?? null, consulta.franja) } };
    }
    case 'confirmacion_cita': {
      if (!memoria.citaCreada) return error('respuesta_no_permitida', 'No se ha agendado ninguna cita en este turno. Usa agendar_cita primero.');
      return { fin: { tipo: 'confirmacion_cita', texto: plantillas.confirmacionCita(memoria.citaCreada, contexto.zona) } };
    }
    case 'pregunta_aclaratoria': {
      if (!a.faltantes) return error('faltan_datos', 'pregunta_aclaratoria requiere "faltantes".');
      // Pedir solo el horario cuando hay una oferta en espera es volver a mostrarla.
      // Una pregunta guardada como tal anularía la oferta y el número que conteste el
      // paciente no tendría contra qué resolverse.
      if (a.faltantes.every((f) => f === 'horario') && contexto.ofertaAnterior && !contexto.ofertaAnterior.consumida) {
        return reofertar(contexto, deps, 'reoferta_por_pregunta');
      }
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
