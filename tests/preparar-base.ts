// Se ejecuta una vez antes de todos los tests: deja la base de pruebas vacía y con el esquema aplicado.
import { BaseDeDatos } from '../src/infraestructura/postgres.js';
import { migrar } from '../src/preparar.js';

export const URL_PRUEBAS = process.env.POSTGRES_URL_PRUEBAS ?? 'postgres://postgres:postgres@localhost:5432/asistente_test';

export default async function () {
  const base = BaseDeDatos.conectar(URL_PRUEBAS, 1);
  await base.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrar(base);
  await base.cerrar();
}
