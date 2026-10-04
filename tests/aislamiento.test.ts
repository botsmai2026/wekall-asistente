// La aplicación fija el nivel de aislamiento por sí misma: no lo hereda del servidor.
// El verificador de la base prueba que el protocolo de reclamo es correcto en
// READ COMMITTED y que se rompe en REPEATABLE READ. Este test prueba la otra
// mitad: que el código real de la aplicación corre en READ COMMITTED aunque el
// servidor esté configurado con otro nivel por defecto.
import pg from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { procesarUno } from '../src/aplicacion/worker.js';
import { recibirMensaje } from '../src/aplicacion/webhook.js';
import { BaseDeDatos } from '../src/infraestructura/postgres.js';
import { base, escenario, mensaje } from './apoyo.js';
import { URL_PRUEBAS } from './preparar-base.js';

// Un pool cuyas conexiones tienen REPEATABLE READ como nivel por defecto.
const otra = new BaseDeDatos(new pg.Pool({ connectionString: URL_PRUEBAS, max: 3, options: '-c default_transaction_isolation=repeatable\\ read' }));
afterAll(async () => {
  await otra.cerrar();
  await base.cerrar();
});

describe('nivel de aislamiento', () => {
  it('con un servidor en REPEATABLE READ por defecto, el webhook y el worker siguen en READ COMMITTED', async () => {
    const e = await escenario();
    expect((await otra.pool.query('SHOW transaction_isolation')).rows[0].transaction_isolation).toBe('repeatable read');

    await recibirMensaje(otra, e.reloj, e.clinicaId, 20, { message_id: 'm1', from: '+573001112233', text: 'hola', timestamp: e.reloj.ahora().toISOString() });
    // El reclamo comprueba el nivel en la propia base y aborta si no es READ COMMITTED.
    const deps = { ...e.con({ herramienta: 'responder', argumentos: { tipo: 'pregunta_aclaratoria', faltantes: ['intencion'] } }), base: otra };
    expect(await procesarUno(deps)).toBe(true);
    expect((await mensaje('m1')).estado).toBe('procesado');
  });

  it('solo postgres.ts abre transacciones; la única excepción es la migración del esquema', () => {
    const abren: string[] = [];
    const recorrer = (carpeta: string) => {
      for (const entrada of readdirSync(carpeta, { withFileTypes: true })) {
        const ruta = `${carpeta}/${entrada.name}`;
        if (entrada.isDirectory()) recorrer(ruta);
        else if (/\bBEGIN\b|pool\.connect\(/.test(readFileSync(ruta, 'utf8'))) abren.push(ruta.replace(/^.*\/src\//, 'src/'));
      }
    };
    recorrer(new URL('../src', import.meta.url).pathname);
    expect(abren.sort()).toEqual(['src/infraestructura/postgres.ts', 'src/preparar.ts']);
  });
});
