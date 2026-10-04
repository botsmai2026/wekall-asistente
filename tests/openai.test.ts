// El adaptador de OpenAI, sin red: se reemplaza la conexión por una función que
// guarda lo que el adaptador envía y devuelve una respuesta con el formato del
// proveedor. Comprueba la traducción en los dos sentidos y la clasificación de
// errores. NO comprueba que un modelo real se comporte bien: eso exige una clave.
import { describe, expect, it } from 'vitest';
import { EmbeddingsOpenAI, ModeloOpenAI } from '../src/infraestructura/openai.js';
import { ErrorDeProgramacion, ErrorInfraestructura, ErrorLogico } from '../src/dominio/errores.js';
import type { MensajeModelo } from '../src/aplicacion/puertos.js';

function conRespuesta(estado: number, cuerpo: object) {
  const peticiones: any[] = [];
  const fetchFalso = (async (_url: any, opciones: any) => {
    peticiones.push(JSON.parse(opciones.body));
    return new Response(JSON.stringify(cuerpo), { status: estado, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { peticiones, fetchFalso };
}
const opciones = { apiKey: 'clave', modelo: 'modelo-x', temperatura: 0.1, ventanaContextoTokens: 128_000, maxCaracteresEntrada: 24_000, maxTokensSalida: 400 };
const herramientas = [{ nombre: 'responder', descripcion: 'd', esquema: { type: 'object', properties: {} } }];
const mensajes: MensajeModelo[] = [
  { rol: 'sistema', contenido: 'reglas' },
  { rol: 'paciente', contenido: 'hola' },
  { rol: 'llamada', id: 'c1', herramienta: 'buscar_conocimiento', argumentosCrudos: '{"pregunta":"x"}' },
  { rol: 'resultado', id: 'c1', contenido: '{"fragmentos":[]}' },
];

describe('adaptador de OpenAI', () => {
  it('envía herramienta obligatoria, sin llamadas en paralelo y con tope de tokens; y traduce la respuesta', async () => {
    const { peticiones, fetchFalso } = conRespuesta(200, {
      model: 'modelo-x-2026',
      choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'responder', arguments: '{"tipo":"sin_informacion"}' } }] } }],
      usage: { prompt_tokens: 812, completion_tokens: 17, prompt_tokens_details: { cached_tokens: 640 } },
    });
    const respuesta = await new ModeloOpenAI({ ...opciones, fetch: fetchFalso }).completar(mensajes, herramientas, { limiteMs: 5000, maxTokensSalida: 400 });

    expect(respuesta).toEqual({ llamada: { id: 'c2', herramienta: 'responder', argumentosCrudos: '{"tipo":"sin_informacion"}' }, texto: undefined, modelo: 'modelo-x-2026', tokensEntrada: 812, tokensSalida: 17, tokensEntradaEnCache: 640 });
    const [enviado] = peticiones;
    expect(enviado).toMatchObject({ model: 'modelo-x', tool_choice: 'required', parallel_tool_calls: false, max_completion_tokens: 400, temperature: 0.1 });
    expect(enviado.messages.map((m: any) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(enviado.messages[2].tool_calls[0]).toMatchObject({ id: 'c1', function: { name: 'buscar_conocimiento' } });
    expect(enviado.messages[3]).toMatchObject({ tool_call_id: 'c1' });
    expect(enviado.tools[0]).toEqual({ type: 'function', function: { name: 'responder', description: 'd', parameters: { type: 'object', properties: {} } } });
  });

  it('un 400 es un rechazo de esta solicitud: fallo lógico, se escala sin reintentar', async () => {
    const { fetchFalso } = conRespuesta(400, { error: { message: 'esquema inválido', type: 'invalid_request_error' } });
    await expect(new ModeloOpenAI({ ...opciones, fetch: fetchFalso }).completar(mensajes, herramientas, { limiteMs: 5000, maxTokensSalida: 400 })).rejects.toMatchObject({ motivo: 'solicitud_rechazada' });
  });

  it('un 401, un 429 o un 500 es un error de infraestructura, y no se reintenta dentro del adaptador', async () => {
    for (const estado of [401, 429, 500]) {
      const { peticiones, fetchFalso } = conRespuesta(estado, { error: { message: 'fallo', type: 'x' } });
      await expect(new ModeloOpenAI({ ...opciones, fetch: fetchFalso }).completar(mensajes, herramientas, { limiteMs: 5000, maxTokensSalida: 400 })).rejects.toBeInstanceOf(ErrorInfraestructura);
      expect(peticiones).toHaveLength(1);
    }
  });

  it('un rechazo por tamaño de contexto es un fallo lógico: no se reintenta, se escala', async () => {
    const { fetchFalso } = conRespuesta(400, { error: { message: 'demasiado largo', type: 'invalid_request_error', code: 'context_length_exceeded' } });
    await expect(new ModeloOpenAI({ ...opciones, fetch: fetchFalso }).completar(mensajes, herramientas, { limiteMs: 5000, maxTokensSalida: 400 })).rejects.toBeInstanceOf(ErrorLogico);
  });

  it('no arranca si el tope de entrada no cabe en la ventana del modelo', () => {
    expect(() => new ModeloOpenAI({ ...opciones, ventanaContextoTokens: 8000 })).toThrowError(ErrorDeProgramacion);
  });

  it('con temperatura "ninguna" no envía el parámetro', async () => {
    const { peticiones, fetchFalso } = conRespuesta(200, { model: 'm', choices: [{ message: { role: 'assistant', content: 'texto' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const respuesta = await new ModeloOpenAI({ ...opciones, temperatura: null, fetch: fetchFalso }).completar(mensajes, herramientas, { limiteMs: 5000, maxTokensSalida: 400 });
    expect(peticiones[0]).not.toHaveProperty('temperature');
    expect(respuesta.llamada).toBeUndefined();
    expect(respuesta.texto).toBe('texto');
  });

  it('embeddings: devuelve los vectores en el orden de los textos, y un fallo es de infraestructura', async () => {
    const bien = conRespuesta(200, { data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] });
    expect(await new EmbeddingsOpenAI('clave', 'emb', bien.fetchFalso).generar(['a', 'b'], 5000)).toEqual([[1, 0], [0, 1]]);
    expect(bien.peticiones[0]).toMatchObject({ model: 'emb', input: ['a', 'b'] });
    const mal = conRespuesta(503, { error: { message: 'caído' } });
    await expect(new EmbeddingsOpenAI('clave', 'emb', mal.fetchFalso).generar(['a'], 5000)).rejects.toBeInstanceOf(ErrorInfraestructura);
  });
});
