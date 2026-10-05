/** Gramática cerrada del mensaje completo. No interpreta negaciones ni contexto. */
export function extraerPosicion(texto: string): number | null {
  const normalizado = texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim().replace(/\s+/g, ' ');
  const numero = /^(?:(?:la |el )?(?:opcion |numero )?|la |el )([1-8])[.!]?$/.exec(normalizado);
  if (numero) return Number(numero[1]);
  const ordinal = /^(?:(?:el|la) )?(primer[oa]|segund[oa]|tercer[oa]|cuart[oa]|quint[oa]|sext[oa]|septim[oa]|octav[oa])[.!]?$/.exec(normalizado);
  if (!ordinal) return null;
  return ['primer', 'segund', 'tercer', 'cuart', 'quint', 'sext', 'septim', 'octav'].indexOf(ordinal[1]!.slice(0, -1)) + 1;
}
