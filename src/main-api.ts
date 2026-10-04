// Proceso de la API.
import { leerConfiguracion } from './config.js';
import { crearServidor } from './http/servidor.js';
import { AlmacenTrazasMongo } from './infraestructura/mongo.js';
import { BaseDeDatos } from './infraestructura/postgres.js';
import { relojDelSistema } from './infraestructura/reloj.js';

const config = leerConfiguracion();
const base = BaseDeDatos.conectar(config.postgresUrl);
const almacen = AlmacenTrazasMongo.crear(config.mongoUrl, config.mongoBase);
const servidor = await crearServidor({ base, almacen, reloj: relojDelSistema, clinicaId: config.clinicaId, mensajesPorMinuto: config.limites.mensajesPorMinuto });

await servidor.listen({ host: '0.0.0.0', port: config.puerto });
console.log(`API escuchando en el puerto ${config.puerto}`);

for (const senal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(senal, async () => {
    await servidor.close();
    await base.cerrar();
    await almacen.cerrar();
    process.exit(0);
  });
}
