// El reloj es una dependencia que se puede reemplazar. En producción es el del
// sistema; en los tests es uno fijo, para poder probar "mañana" a las 10:40 pm
// o un candado que vence sin esperar de verdad.
export interface Reloj {
  /** Hora real. Decide qué es pasado y qué es futuro. */
  ahora(): Date;
  /** Milisegundos de un reloj que nunca retrocede. Mide plazos; no es una hora. */
  monotonicoMs(): number;
}

export const relojDelSistema: Reloj = {
  ahora: () => new Date(),
  monotonicoMs: () => performance.now(),
};

export class RelojFijo implements Reloj {
  private transcurridoMs = 0;
  constructor(private instante: Date) {}
  ahora(): Date {
    return new Date(this.instante.getTime() + this.transcurridoMs);
  }
  monotonicoMs(): number {
    return this.transcurridoMs;
  }
  avanzar(ms: number): void {
    this.transcurridoMs += ms;
  }
  fijar(instante: Date): void {
    this.instante = instante;
    this.transcurridoMs = 0;
  }
}
