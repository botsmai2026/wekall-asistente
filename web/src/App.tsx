// Interfaz mínima: bandeja con filtro por estado, detalle de la conversación
// con la trazabilidad de cada intento, y un simulador para enviar mensajes.
//
// Seguridad: todo texto (del paciente, del asistente, de las trazas) se muestra
// como texto plano. React lo escapa; aquí no se usa HTML crudo en ningún lugar.
import { useEffect, useState } from 'react';
import { detallar, enviarMensaje, listar, type Conversacion, type Detalle, type Estado, type Intento, type Mensaje } from './api';

const ESTADOS: { valor: Estado | ''; nombre: string }[] = [
  { valor: '', nombre: 'Todas' },
  { valor: 'en_curso', nombre: 'En curso' },
  { valor: 'resuelta_por_ia', nombre: 'Resuelta por IA' },
  { valor: 'cita_agendada', nombre: 'Cita agendada' },
  { valor: 'escalada', nombre: 'Escalada' },
];
const nombreEstado = (estado: string) => ESTADOS.find((e) => e.valor === estado)?.nombre ?? estado;
const hora = (iso: string) => new Date(iso).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' });
const CADA_MS = 1500;

/** Repite una lectura cada 1,5 s. Así la respuesta del asistente aparece sola. */
function useConsulta<T>(leer: () => Promise<T>, dependencias: unknown[]): { datos: T | null; error: boolean } {
  const [datos, setDatos] = useState<T | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let vigente = true;
    const actualizar = () =>
      leer().then(
        (nuevo) => vigente && (setDatos(nuevo), setError(false)),
        () => vigente && setError(true),
      );
    setDatos(null);
    actualizar();
    const intervalo = setInterval(actualizar, CADA_MS);
    return () => {
      vigente = false;
      clearInterval(intervalo);
    };
  }, dependencias);
  return { datos, error };
}

export function App() {
  const [filtro, setFiltro] = useState<Estado | ''>('');
  const [seleccion, setSeleccion] = useState<number | null>(null);
  const bandeja = useConsulta(() => listar(filtro), [filtro]);

  return (
    <div className="pagina">
      <header>
        <h1>Asistente de agendamiento</h1>
        {bandeja.error && <span className="aviso">Sin conexión con la API</span>}
      </header>
      <main>
        <section className="bandeja">
          <div className="filtros">
            {ESTADOS.map((e) => (
              <button key={e.valor} className={filtro === e.valor ? 'activo' : ''} onClick={() => setFiltro(e.valor)}>
                {e.nombre}
              </button>
            ))}
          </div>
          <ul>
            {bandeja.datos?.map((c) => <Fila key={c.id} conversacion={c} activa={c.id === seleccion} alElegir={() => setSeleccion(c.id)} />)}
            {bandeja.datos?.length === 0 && <li className="vacio">No hay conversaciones en este estado.</li>}
          </ul>
        </section>
        <section className="detalle">{seleccion ? <DetalleConversacion id={seleccion} /> : <p className="vacio">Elija una conversación, o envíe un mensaje con el simulador.</p>}</section>
        <Simulador alEnviar={(telefono) => bandeja.datos?.find((c) => c.telefono === telefono) && setSeleccion(bandeja.datos.find((c) => c.telefono === telefono)!.id)} />
      </main>
    </div>
  );
}

function Fila({ conversacion, activa, alElegir }: { conversacion: Conversacion; activa: boolean; alElegir: () => void }) {
  return (
    <li className={activa ? 'activa' : ''} onClick={alElegir}>
      <strong>{conversacion.telefono}</strong>
      <span className={`estado ${conversacion.estado}`}>{nombreEstado(conversacion.estado)}</span>
      <small>
        {hora(conversacion.ultima_actividad)}
        {conversacion.motivo_escalamiento && ` · motivo: ${conversacion.motivo_escalamiento}`}
      </small>
    </li>
  );
}

function DetalleConversacion({ id }: { id: number }) {
  const { datos } = useConsulta<Detalle>(() => detallar(id), [id]);
  if (!datos) return <p className="vacio">Cargando…</p>;
  return (
    <>
      <h2>
        {datos.conversacion.telefono} <span className={`estado ${datos.conversacion.estado}`}>{nombreEstado(datos.conversacion.estado)}</span>
      </h2>
      {!datos.mongo_disponible && <p className="aviso">Mongo no responde: se muestran las trazas que aún están en PostgreSQL.</p>}
      {datos.mensajes.map((m) => <Turno key={m.message_id} mensaje={m} />)}
    </>
  );
}

function Turno({ mensaje }: { mensaje: Mensaje }) {
  const enProceso = mensaje.estado === 'pendiente' || mensaje.estado === 'procesando';
  return (
    <article className="turno">
      <div className="burbuja paciente">
        <p>{mensaje.texto}</p>
        <small>{hora(mensaje.enviado_en)}</small>
      </div>
      <div className="burbuja asistente">
        {enProceso ? <p className="pensando">El asistente está respondiendo…</p> : <p>{mensaje.respuesta_texto}</p>}
        {mensaje.respuesta_tipo && <small>{mensaje.respuesta_tipo}{mensaje.estado === 'fallido' && ' · no se resolvió automáticamente'}</small>}
      </div>
      {mensaje.intentos.length > 0 && (
        <details>
          <summary>
            Trazabilidad: {mensaje.intentos.length} {mensaje.intentos.length === 1 ? 'intento' : 'intentos'}
          </summary>
          {mensaje.intentos.map((i) => <TrazaIntento key={i.intento} intento={i} />)}
        </details>
      )}
    </article>
  );
}

function TrazaIntento({ intento }: { intento: Intento }) {
  return (
    <div className="intento">
      <p>
        <strong>Intento {intento.intento}</strong> · {intento.tipo}
        {intento.motivo && ` (${intento.motivo})`} · {intento.resultado_procesamiento} · leído de {intento.origen === 'mongo' ? 'Mongo' : 'PostgreSQL (aún no publicado)'}
      </p>
      <p className="medicion">
        modelo: {intento.modelo ?? 'ninguno'} · tokens de entrada: {intento.tokens_entrada} ({intento.tokens_entrada_en_cache ?? 0} de caché) · tokens de salida: {intento.tokens_salida} · latencia: {intento.latencia_ms} ms
      </p>
      {intento.error && <p className="aviso">Error: {intento.error}</p>}
      {intento.llamadas.map((llamada, n) => (
        <div className="llamada" key={n}>
          <p>
            {n + 1}. <code>{llamada.herramienta}</code> · {llamada.ms} ms
          </p>
          <pre>argumentos: {JSON.stringify(llamada.argumentos, null, 2)}</pre>
          <pre>resultado: {JSON.stringify(llamada.resultado, null, 2)}</pre>
          {llamada.real !== undefined && <pre>datos reales: {JSON.stringify(llamada.real, null, 2)}</pre>}
        </div>
      ))}
    </div>
  );
}

const MENSAJE_POR_CODIGO: Record<number, string> = {
  202: 'Enviado.',
  400: 'Mensaje inválido: revise el teléfono (+57…) y el texto.',
  409: 'Ese identificador ya se usó con otro contenido.',
  429: 'Demasiados mensajes de este teléfono en un minuto.',
  503: 'El servicio no está disponible.',
};

function Simulador({ alEnviar }: { alEnviar: (telefono: string) => void }) {
  const [telefono, setTelefono] = useState('+573001112233');
  const [texto, setTexto] = useState('');
  const [aviso, setAviso] = useState('');
  const enviar = async (evento: React.FormEvent) => {
    evento.preventDefault();
    if (!texto.trim()) return;
    try {
      const codigo = await enviarMensaje(telefono.trim(), texto);
      setAviso(MENSAJE_POR_CODIGO[codigo] ?? `Respuesta ${codigo}`);
      if (codigo === 202) {
        setTexto('');
        setTimeout(() => alEnviar(telefono.trim()), CADA_MS + 200);
      }
    } catch {
      setAviso('Sin conexión con la API.');
    }
  };
  return (
    <form className="simulador" onSubmit={enviar}>
      <h2>Simulador de paciente</h2>
      <label>
        Teléfono
        <input value={telefono} onChange={(e) => setTelefono(e.target.value)} />
      </label>
      <label>
        Mensaje
        <textarea value={texto} maxLength={2000} rows={4} onChange={(e) => setTexto(e.target.value)} placeholder="Quiero una cita de medicina general mañana" />
      </label>
      <button type="submit">Enviar</button>
      {aviso && <p className="aviso-suave">{aviso}</p>}
    </form>
  );
}
