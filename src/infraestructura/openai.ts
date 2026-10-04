// Único archivo que conoce a OpenAI. Traduce entre las interfaces del
// asistente (src/aplicacion/puertos.ts) y la API del proveedor. Cambiar de
// proveedor es escribir otro archivo como este; la lógica no se toca.
import OpenAI from 'openai';
import { ErrorDeProgramacion, ErrorInfraestructura, ErrorLogico } from '../dominio/errores.js';
import type {
  DefinicionHerramienta, GeneradorEmbeddings, MensajeModelo, ModeloLenguaje, OpcionesLlamada, RespuestaModelo,
} from '../aplicacion/puertos.js';

export interface OpcionesModeloOpenAI {
  apiKey: string;
  modelo: string;
  /** null = no enviar temperatura (algunos modelos no la aceptan). */
  temperatura: number | null;
  /** Si se indica, se envía como reasoning_effort (los modelos con razonamiento lo exigen para usar herramientas). */
  esfuerzoRazonamiento?: string | null;
  ventanaContextoTokens: number;
  maxCaracteresEntrada: number;
  maxTokensSalida: number;
  /** Solo para tests: reemplaza la conexión de red por una función. */
  fetch?: typeof fetch;
}

export class ModeloOpenAI implements ModeloLenguaje {
  private readonly cliente: OpenAI;
  constructor(private readonly opciones: OpcionesModeloOpenAI) {
    // Contrato de tamaño: la aplicación acota la entrada en caracteres, y aquí
    // se comprueba, una vez al arrancar, que ese tope cabe con holgura en la
    // ventana del modelo. Se supone el peor caso razonable de 2 caracteres por
    // token y se exige que entrada más salida no pasen del 80 % de la ventana.
    const peorCasoTokens = opciones.maxCaracteresEntrada / 2 + opciones.maxTokensSalida;
    if (peorCasoTokens > opciones.ventanaContextoTokens * 0.8) {
      throw new ErrorDeProgramacion(
        `El tope de entrada (${opciones.maxCaracteresEntrada} caracteres) no cabe con holgura en la ventana de ${opciones.modelo} (${opciones.ventanaContextoTokens} tokens)`,
      );
    }
    // Sin reintentos del SDK: los reintentos los decide el worker. Si los dos
    // reintentaran, se multiplicarían entre sí.
    this.cliente = new OpenAI({ apiKey: opciones.apiKey, maxRetries: 0, fetch: opciones.fetch as any });
  }

  async completar(mensajes: MensajeModelo[], herramientas: DefinicionHerramienta[], opciones: OpcionesLlamada): Promise<RespuestaModelo> {
    try {
      const respuesta = await this.cliente.chat.completions.create(
        {
          model: this.opciones.modelo,
          messages: mensajes.map(aFormatoOpenAI),
          tools: herramientas.map((h) => ({ type: 'function' as const, function: { name: h.nombre, description: h.descripcion, parameters: h.esquema as Record<string, unknown> } })),
          tool_choice: 'required', // siempre debe pedir una herramienta
          parallel_tool_calls: false, // una a la vez: el orden nunca es ambiguo
          max_completion_tokens: opciones.maxTokensSalida,
          ...(this.opciones.temperatura === null ? {} : { temperature: this.opciones.temperatura }),
          ...(this.opciones.esfuerzoRazonamiento ? { reasoning_effort: this.opciones.esfuerzoRazonamiento as any } : {}),
        },
        { timeout: opciones.limiteMs },
      );
      const eleccion = respuesta.choices[0]?.message;
      const llamada = eleccion?.tool_calls?.[0];
      return {
        llamada: llamada && llamada.type === 'function' ? { id: llamada.id, herramienta: llamada.function.name, argumentosCrudos: llamada.function.arguments } : undefined,
        texto: eleccion?.content ?? undefined,
        modelo: respuesta.model,
        tokensEntrada: respuesta.usage?.prompt_tokens ?? 0,
        tokensSalida: respuesta.usage?.completion_tokens ?? 0,
        tokensEntradaEnCache: respuesta.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      };
    } catch (causa) {
      if (causa instanceof OpenAI.APIError && causa.code === 'context_length_exceeded') {
        // No se reintenta: el contrato de tamaño de arriba está mal calculado.
        console.error('ALERTA de configuración: el proveedor rechazó la entrada por tamaño');
        throw new ErrorLogico('entrada_excedida');
      }
      if (causa instanceof OpenAI.APIError && Number(causa.status) === 400) {
        // El proveedor rechazó ESTA solicitud (contenido o formato). Repetir la
        // misma entrada daría lo mismo: no se reintenta, el turno se escala.
        console.error(`ALERTA: OpenAI rechazó la solicitud (400): ${causa.message}`);
        throw new ErrorLogico('solicitud_rechazada');
      }
      // 401, 403 y 404 son de configuración (clave, permisos, modelo), no de este
      // mensaje. Se reintentan como infraestructura a propósito: escalar es
      // irreversible para la conversación, y un error de despliegue corregido en
      // segundos no debe dejar escaladas todas las conversaciones que llegaron
      // mientras tanto. Se avisa aparte para que el operador lo vea.
      if (causa instanceof OpenAI.APIError && [401, 403, 404].includes(Number(causa.status))) {
        console.error(`ALERTA de configuración: OpenAI respondió ${causa.status}: ${causa.message}`);
      }
      // Timeout, 429, 5xx, red: infraestructura. El worker reintenta con espera.
      throw new ErrorInfraestructura(`OpenAI: ${causa instanceof Error ? causa.message : String(causa)}`, causa);
    }
  }
}

function aFormatoOpenAI(mensaje: MensajeModelo): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  switch (mensaje.rol) {
    case 'sistema':
      return { role: 'system', content: mensaje.contenido };
    case 'paciente':
      return { role: 'user', content: mensaje.contenido };
    case 'asistente':
      return { role: 'assistant', content: mensaje.contenido };
    case 'llamada':
      return { role: 'assistant', content: null, tool_calls: [{ id: mensaje.id, type: 'function', function: { name: mensaje.herramienta, arguments: mensaje.argumentosCrudos } }] };
    case 'resultado':
      return { role: 'tool', tool_call_id: mensaje.id, content: mensaje.contenido };
  }
}

export class EmbeddingsOpenAI implements GeneradorEmbeddings {
  private readonly cliente: OpenAI;
  constructor(apiKey: string, readonly modelo: string, fetchDePrueba?: typeof fetch) {
    this.cliente = new OpenAI({ apiKey, maxRetries: 0, fetch: fetchDePrueba as any });
  }
  async generar(textos: string[], limiteMs: number): Promise<number[][]> {
    try {
      const respuesta = await this.cliente.embeddings.create({ model: this.modelo, input: textos, encoding_format: 'float' }, { timeout: limiteMs });
      return respuesta.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    } catch (causa) {
      throw new ErrorInfraestructura(`OpenAI embeddings: ${causa instanceof Error ? causa.message : String(causa)}`, causa);
    }
  }
}
