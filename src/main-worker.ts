// Proceso del worker. Corre dos ciclos: el que procesa mensajes y el relevo de
// trazas hacia Mongo. Van en el mismo proceso para no agregar un contenedor;
// son módulos independientes y pueden separarse sin cambiar código.
import { leerConfiguracion } from './config.js';
import { cicloDelRelevo } from './aplicacion/relevo.js';
import { cicloDelWorker } from './aplicacion/worker.js';
import { AlmacenTrazasMongo } from './infraestructura/mongo.js';
import { EmbeddingsOpenAI, ModeloOpenAI } from './infraestructura/openai.js';
import { BaseDeDatos } from './infraestructura/postgres.js';
import { relojDelSistema } from './infraestructura/reloj.js';

const config = leerConfiguracion();
if (!config.openaiApiKey) {
  console.error('Falta OPENAI_API_KEY. El worker no puede arrancar sin ella.');
  process.exit(1);
}

// Cada mensaje en curso usa hasta tres conexiones a la vez; el pool se dimensiona con eso.
const base = BaseDeDatos.conectar(config.postgresUrl, config.concurrenciaWorker * 3 + 2);
const almacen = AlmacenTrazasMongo.crear(config.mongoUrl, config.mongoBase);
const modelo = new ModeloOpenAI({
  apiKey: config.openaiApiKey, modelo: config.modeloLenguaje, temperatura: config.temperatura, esfuerzoRazonamiento: config.esfuerzoRazonamiento,
  ventanaContextoTokens: config.ventanaContextoTokens, maxCaracteresEntrada: config.limites.maxCaracteresEntrada, maxTokensSalida: config.limites.maxTokensSalida,
});
const embeddings = new EmbeddingsOpenAI(config.openaiApiKey, config.modeloEmbeddings);

// Comprobación de arranque: si hay conocimiento cargado y nada de él está
// indexado con el modelo de embeddings configurado, es un error de
// configuración. Arrancar así haría que toda búsqueda saliera vacía.
const estado = await base.leer('conocimiento_estado_por_clinica', { modelo: embeddings.modelo });
if (estado.length > 0 && estado.every((fila) => fila.actuales === 0)) {
  console.error(`Ningún fragmento está indexado con el modelo de embeddings "${embeddings.modelo}". Ejecute "npm run preparar".`);
  process.exit(1);
}
for (const fila of estado.filter((f) => f.actuales < f.total)) {
  console.warn(`Clínica ${fila.clinica_id}: conocimiento degradado (${fila.actuales} de ${fila.total} fragmentos con el modelo actual)`);
}

let activo = true;
for (const senal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(senal, () => {
    activo = false; // termina el mensaje en curso y sale
  });
}

console.log(`Worker en marcha (modelo ${config.modeloLenguaje}, ${config.concurrenciaWorker} mensajes a la vez)`);
const deps = { base, reloj: relojDelSistema, modelo, embeddings, limites: config.limites };
await Promise.all([
  // Varios ciclos en el mismo proceso: el trabajo es casi todo espera de red
  // (modelo y base), así que un proceso atiende varios mensajes a la vez. La
  // cola ya impide que dos ciclos tomen el mismo mensaje o la misma conversación.
  ...Array.from({ length: config.concurrenciaWorker }, () => cicloDelWorker(deps, () => activo)),
  cicloDelRelevo(base, almacen, () => activo),
]);
await base.cerrar();
await almacen.cerrar();
