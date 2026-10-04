// Cargador de sentencias SQL con nombre.
//
// Por qué existe: el SQL del asistente vive en sql/consultas.sql, que es el
// mismo archivo que ejecuta el verificador de la base de datos. La aplicación
// no tiene copias del SQL en el código: lo carga de ahí por nombre. Así, lo
// que se verificó es exactamente lo que corre.
//
// Qué hace: convierte los parámetros con nombre (":clinica_id") en los
// posicionales que entiende el driver ("$1"), y arma la lista de valores en el
// mismo orden. Nunca mete un valor dentro del texto SQL: los valores viajan
// aparte, que es lo que impide la inyección de SQL.
import { readFileSync } from 'node:fs';

// Parámetros de fecha: ver la nota "TIPOS DE LOS PARÁMETROS DE FECHA" en consultas.sql.
const PARAMETROS_DE_FECHA = new Set(['ahora', 'enviado_en', 'desde', 'hasta', 'proximo_intento_en']);

export interface Sentencia {
  nombre: string;
  texto: string; // SQL con $1, $2, ...
  parametros: string[]; // nombre de cada $n, en orden
}

export function cargarSentencias(...rutas: string[]): Map<string, Sentencia> {
  const sentencias = new Map<string, Sentencia>();
  for (const ruta of rutas) {
    const contenido = readFileSync(ruta, 'utf8');
    const bloques = contenido.split(/^-- name: /m).slice(1);
    for (const bloque of bloques) {
      const finDeLinea = bloque.indexOf('\n');
      const nombre = bloque.slice(0, finDeLinea).trim();
      const cuerpo = bloque
        .slice(finDeLinea + 1)
        .split('\n')
        .filter((linea) => !linea.trimStart().startsWith('--'))
        .join('\n')
        .trim()
        .replace(/;$/, '');
      if (sentencias.has(nombre)) throw new Error(`Sentencia SQL repetida: ${nombre}`);
      sentencias.set(nombre, compilar(nombre, cuerpo));
    }
  }
  return sentencias;
}

function compilar(nombre: string, cuerpo: string): Sentencia {
  const parametros: string[] = [];
  // ":nombre" que no venga precedido de otro ":" (eso es un cast, "::bigint")
  // ni de una letra o número (eso sería parte de otra cosa, como una hora).
  const texto = cuerpo.replace(/(?<![:\w]):([a-z_]+)/g, (_todo, parametro: string) => {
    let posicion = parametros.indexOf(parametro);
    if (posicion === -1) {
      parametros.push(parametro);
      posicion = parametros.length - 1;
    }
    const marcador = `$${posicion + 1}`;
    return PARAMETROS_DE_FECHA.has(parametro) ? `CAST(${marcador} AS timestamptz)` : marcador;
  });
  return { nombre, texto, parametros };
}

export function valoresDe(sentencia: Sentencia, valores: Record<string, unknown>): unknown[] {
  return sentencia.parametros.map((parametro) => {
    if (!(parametro in valores)) {
      throw new Error(`Falta el parámetro "${parametro}" para la sentencia "${sentencia.nombre}"`);
    }
    return valores[parametro];
  });
}
