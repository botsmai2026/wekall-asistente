export type UsoTokens = {
  modelo: string;
  tokensEntrada: number;
  tokensEntradaCache?: number;
  tokensSalida: number;
};

type PrecioModelo = {
  entradaPorMillon: number;
  entradaCachePorMillon?: number;
  salidaPorMillon: number;
};

/**
 * Precios en USD por 1 millón de tokens.
 *
 * Importante:
 * - Estos precios son configuración de negocio, no datos del proveedor.
 * - Si cambia el precio del modelo, solo se modifica esta tabla.
 */
const PRECIOS: Record<string, PrecioModelo> = {
  'gpt-4o-mini': {
    entradaPorMillon: 0.15,
    entradaCachePorMillon: 0.075,
    salidaPorMillon: 0.60,
  },
};

export type CostoModelo = {
  modelo: string;
  tokensEntrada: number;
  tokensEntradaCache: number;
  tokensEntradaNoCache: number;
  tokensSalida: number;
  costoEntradaUsd: number;
  costoCacheUsd: number;
  costoSalidaUsd: number;
  costoTotalUsd: number;
};

export function calcularCostoModelo(uso: UsoTokens): CostoModelo | null {
  const precio = PRECIOS[uso.modelo];

  // Si no conocemos el precio del modelo, no inventamos un costo.
  if (!precio) return null;

  const tokensEntrada = Math.max(0, uso.tokensEntrada);
  const tokensSalida = Math.max(0, uso.tokensSalida);

  // Los tokens cacheados forman parte de los tokens de entrada.
  const tokensEntradaCache = Math.min(
    Math.max(0, uso.tokensEntradaCache ?? 0),
    tokensEntrada,
  );

  const tokensEntradaNoCache = tokensEntrada - tokensEntradaCache;

  const costoEntradaUsd =
    (tokensEntradaNoCache / 1_000_000) * precio.entradaPorMillon;

  const costoCacheUsd =
    (tokensEntradaCache / 1_000_000) *
    (precio.entradaCachePorMillon ?? precio.entradaPorMillon);

  const costoSalidaUsd =
    (tokensSalida / 1_000_000) * precio.salidaPorMillon;

  const costoTotalUsd =
    costoEntradaUsd + costoCacheUsd + costoSalidaUsd;

  return {
    modelo: uso.modelo,
    tokensEntrada,
    tokensEntradaCache,
    tokensEntradaNoCache,
    tokensSalida,
    costoEntradaUsd,
    costoCacheUsd,
    costoSalidaUsd,
    costoTotalUsd,
  };
}