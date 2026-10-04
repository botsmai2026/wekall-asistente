// Las tres categorías de fallo de la arquitectura. Lo que importa de un error
// no es qué lo causó, sino qué debe hacer el sistema con él:
//
//   Validación o negocio  → NO es una excepción: vuelve al modelo como resultado
//                           de la herramienta, para que corrija o pregunte.
//   ErrorInfraestructura  → algo externo falló (modelo, embeddings, base). El
//                           intento se aborta y el worker reintenta con espera.
//                           Nunca se convierte en una respuesta al paciente:
//                           una caída no debe parecer un "no tengo información".
//   ErrorLogico           → el ciclo no convergió (iteraciones, plazo, tamaño).
//                           Reintentar daría lo mismo: se escala a un humano.

export class ErrorInfraestructura extends Error {
  constructor(mensaje: string, readonly causa?: unknown) {
    super(mensaje);
    this.name = 'ErrorInfraestructura';
  }
}

export type MotivoLogico = 'iteraciones_agotadas' | 'plazo_agotado' | 'entrada_excedida' | 'conocimiento_no_disponible' | 'solicitud_rechazada';

export class ErrorLogico extends Error {
  constructor(readonly motivo: MotivoLogico) {
    super(motivo);
    this.name = 'ErrorLogico';
  }
}

/** Error de programación o de configuración: el proceso no debe seguir. */
export class ErrorDeProgramacion extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'ErrorDeProgramacion';
  }
}
