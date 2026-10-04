// Carga de documentos de conocimiento.
//
// Un documento es Markdown con este formato: un título ("# "), secciones ("## ")
// y, dentro de cada sección, un dato por línea. Ese formato es lo que permite
// responder con líneas literales: la unidad de búsqueda es la sección y la
// unidad de respuesta es la línea.
//
// El texto se guarda UNA sola vez, línea por línea, en documento_lineas. Los
// fragmentos (lo que se busca por similitud) no guardan texto: apuntan a un
// rango de líneas. Así, lo que recibe el paciente no puede diferir del documento.
import { createHash } from 'node:crypto';
import type { BaseDeDatos } from '../infraestructura/postgres.js';
import type { GeneradorEmbeddings } from './puertos.js';

/** Cambiar el algoritmo de fragmentación obliga a recalcular todo: por eso tiene versión. */
export const VERSION_FRAGMENTADOR = 'secciones-v1';
const MAX_CARACTERES_LINEA = 500;
const MAX_CARACTERES_FRAGMENTO = 1500;
const LINEAS_DE_SOLAPE = 1;

export class DocumentoInvalido extends Error {}

export interface DocumentoCanonico {
  titulo: string;
  lineas: string[]; // contenido canónico: la línea 1 es lineas[0]
  fragmentos: { lineaEncabezado: number; lineaInicial: number; lineaFinal: number }[];
}

/** Normalización de una línea: Unicode NFC, sin espacios al final. */
function normalizar(texto: string): string {
  return texto.normalize('NFC').replace(/\s+$/u, '');
}

/**
 * Convierte el Markdown en contenido canónico y fragmentos.
 * Primero reconoce la estructura sobre el texto original y después normaliza.
 * Las marcas de Markdown ("## ", "- ") no forman parte del contenido: el
 * paciente recibe "Sede Norte", no "## Sede Norte".
 */
export function prepararDocumento(markdown: string): DocumentoCanonico {
  const crudas = markdown.replace(/\r\n?/g, '\n').split('\n');
  let titulo = '';
  const lineas: string[] = [];
  const secciones: { encabezado: number; cuerpo: number[] }[] = [];

  crudas.forEach((cruda, indice) => {
    const linea = normalizar(cruda);
    if (linea.trim() === '') return; // sin líneas vacías
    if (/^# /.test(linea)) {
      if (titulo) throw new DocumentoInvalido(`Línea ${indice + 1}: el documento tiene más de un título ("# ")`);
      titulo = linea.slice(2).trim();
      return;
    }
    const esEncabezado = /^## /.test(linea);
    const texto = esEncabezado ? linea.slice(3).trim() : linea.replace(/^\s*[-*] /, '').trim();
    if (texto.length > MAX_CARACTERES_LINEA) {
      throw new DocumentoInvalido(`Línea ${indice + 1}: tiene ${texto.length} caracteres y el máximo es ${MAX_CARACTERES_LINEA}. Divídala en varias líneas, un dato por línea.`);
    }
    lineas.push(texto);
    const numero = lineas.length;
    if (esEncabezado) {
      secciones.push({ encabezado: numero, cuerpo: [] });
    } else {
      const seccion = secciones.at(-1);
      if (!seccion) throw new DocumentoInvalido(`Línea ${indice + 1}: hay contenido antes de la primera sección ("## ")`);
      seccion.cuerpo.push(numero);
    }
  });
  if (!titulo) throw new DocumentoInvalido('El documento no tiene título ("# ")');

  // Un fragmento por sección. Si la sección es muy larga, se divide en tramos
  // que comparten una línea, para que una idea partida en dos se encuentre igual.
  const fragmentos: DocumentoCanonico['fragmentos'] = [];
  for (const seccion of secciones) {
    let inicio = 0;
    while (inicio < seccion.cuerpo.length) {
      let fin = inicio;
      let caracteres = lineas[seccion.cuerpo[inicio]! - 1]!.length;
      while (fin + 1 < seccion.cuerpo.length && caracteres + lineas[seccion.cuerpo[fin + 1]! - 1]!.length <= MAX_CARACTERES_FRAGMENTO) {
        fin += 1;
        caracteres += lineas[seccion.cuerpo[fin]! - 1]!.length;
      }
      fragmentos.push({ lineaEncabezado: seccion.encabezado, lineaInicial: seccion.cuerpo[inicio]!, lineaFinal: seccion.cuerpo[fin]! });
      if (fin + 1 >= seccion.cuerpo.length) break;
      inicio = Math.max(fin + 1 - LINEAS_DE_SOLAPE, inicio + 1);
    }
  }
  return { titulo, lineas, fragmentos };
}

/** La huella cubre todo lo que determina los fragmentos: si no cambió nada de esto, no hay que recalcular. */
export function huellaDe(documento: DocumentoCanonico, modeloEmbeddings: string): string {
  // La lista de fragmentos entra en la huella: dos documentos con las mismas líneas pero distinta
  // estructura (una línea que pasa a ser encabezado) producen fragmentos distintos.
  return createHash('sha256').update([documento.titulo, documento.lineas.join('\n'), JSON.stringify(documento.fragmentos), modeloEmbeddings, VERSION_FRAGMENTADOR].join('\u0000')).digest('hex');
}

export type ResultadoIngestion = 'sin_cambios' | 'ingerido';

/** Ingiere un documento. Es idempotente: si nada cambió, no hace nada (y no gasta embeddings). */
export async function ingerirDocumento(base: BaseDeDatos, embeddings: GeneradorEmbeddings, clinicaId: number, markdown: string): Promise<ResultadoIngestion> {
  const documento = prepararDocumento(markdown);
  const huella = huellaDe(documento, embeddings.modelo);
  const [actual] = await base.leer('ingestion_huella_actual', { clinica_id: clinicaId, titulo: documento.titulo });
  if (actual?.huella === huella) return 'sin_cambios';

  // Los embeddings se calculan antes de abrir la transacción: es una llamada
  // externa lenta y no debe retener bloqueos en la base.
  const textos = documento.fragmentos.map((f) =>
    [documento.titulo, documento.lineas[f.lineaEncabezado - 1], ...documento.lineas.slice(f.lineaInicial - 1, f.lineaFinal)].join('\n'),
  );
  const vectores = textos.length > 0 ? await embeddings.generar(textos, 30_000) : [];

  // Reingerir = borrar e insertar en una sola transacción: nadie ve el documento a medias.
  await base.enTransaccion(async (tx) => {
    await tx.ejecutar('ingestion_borrar_documento', { clinica_id: clinicaId, titulo: documento.titulo });
    const [insertado] = await tx.ejecutar('ingestion_insertar_documento', { clinica_id: clinicaId, titulo: documento.titulo, huella });
    const documentoId = insertado!.id;
    await tx.ejecutar('ingestion_insertar_lineas', { documento_id: documentoId, textos: documento.lineas });
    for (const [i, fragmento] of documento.fragmentos.entries()) {
      await tx.ejecutar('ingestion_insertar_fragmento', {
        documento_id: documentoId, clinica_id: clinicaId, linea_encabezado: fragmento.lineaEncabezado,
        linea_inicial: fragmento.lineaInicial, linea_final: fragmento.lineaFinal, embedding: JSON.stringify(vectores[i]), modelo: embeddings.modelo,
      });
    }
  });
  return 'ingerido';
}
