import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DocumentoInvalido, huellaDe, ingerirDocumento, prepararDocumento } from '../src/aplicacion/ingestion.js';
import { EmbeddingsFalsos } from '../src/infraestructura/falsos.js';
import { base, escenario, type Escenario } from './apoyo.js';

let e: Escenario;
beforeEach(async () => {
  e = await escenario();
});
afterAll(() => base.cerrar());

describe('preparación del documento', () => {
  it('normaliza CRLF, espacios finales y líneas vacías, y quita las marcas de Markdown', () => {
    const doc = prepararDocumento('# Título  \r\n\r\n## Sección uno   \r\n- Dato A  \r\n\r\n\r\nDato B\t\r\n## Sección dos\nDato C\n');
    expect(doc.titulo).toBe('Título');
    expect(doc.lineas).toEqual(['Sección uno', 'Dato A', 'Dato B', 'Sección dos', 'Dato C']);
    expect(doc.fragmentos).toEqual([
      { lineaEncabezado: 1, lineaInicial: 2, lineaFinal: 3 },
      { lineaEncabezado: 4, lineaInicial: 5, lineaFinal: 5 },
    ]);
  });

  it('una línea de más de 500 caracteres hace fallar la ingestión e indica cuál es', () => {
    expect(() => prepararDocumento(`# T\n## S\nbien\n${'x'.repeat(501)}\n`)).toThrowError(/Línea 4: tiene 501 caracteres/);
  });

  it('rechaza contenido antes de la primera sección y documentos sin título', () => {
    expect(() => prepararDocumento('# T\nsuelto\n## S\n')).toThrowError(DocumentoInvalido);
    expect(() => prepararDocumento('## S\ndato\n')).toThrowError(/no tiene título/);
  });

  it('un fragmento nunca cruza secciones, y una sección larga se divide con una línea de solape', () => {
    const cuerpo = Array.from({ length: 10 }, (_, i) => `Dato ${i} ${'x'.repeat(390)}`).join('\n');
    const doc = prepararDocumento(`# T\n## Larga\n${cuerpo}\n## Corta\nDato final\n`);
    const larga = doc.fragmentos.filter((f) => f.lineaEncabezado === 1);
    expect(larga.length).toBeGreaterThan(1);
    for (let i = 1; i < larga.length; i++) expect(larga[i]!.lineaInicial).toBe(larga[i - 1]!.lineaFinal); // comparten una línea
    expect(larga.at(-1)!.lineaFinal).toBe(11);
    expect(doc.fragmentos.at(-1)).toEqual({ lineaEncabezado: 12, lineaInicial: 13, lineaFinal: 13 });
  });

  it('la huella cambia con el título, el contenido y el modelo de embeddings', () => {
    const a = prepararDocumento('# T\n## S\ndato\n');
    expect(huellaDe(a, 'm1')).toBe(huellaDe(prepararDocumento('# T\r\n## S\r\ndato  \r\n'), 'm1')); // mismo contenido canónico
    expect(huellaDe(a, 'm1')).not.toBe(huellaDe(a, 'm2'));
    expect(huellaDe(a, 'm1')).not.toBe(huellaDe(prepararDocumento('# T2\n## S\ndato\n'), 'm1'));
    expect(huellaDe(a, 'm1')).not.toBe(huellaDe(prepararDocumento('# T\n## S\ndato.\n'), 'm1'));
    // Mismas líneas, distinta estructura: una línea que pasa a ser encabezado cambia los fragmentos.
    expect(huellaDe(prepararDocumento('# T\n## S\nX\nY\n'), 'm1')).not.toBe(huellaDe(prepararDocumento('# T\n## S\n## X\nY\n'), 'm1'));
  });
});

describe('ingestión en la base', () => {
  const MD = '# Documento de prueba\n## Sección\nPrimer dato.\nSegundo dato.\n';
  const conteo = async () => (await base.pool.query("SELECT (SELECT count(*) FROM documentos WHERE titulo = 'Documento de prueba') AS d, (SELECT count(*) FROM fragmentos_conocimiento f JOIN documentos d ON d.id = f.documento_id WHERE d.titulo = 'Documento de prueba') AS f")).rows[0];

  it('es idempotente, y recalcula si cambia el contenido o el modelo de embeddings', async () => {
    expect(await ingerirDocumento(base, e.embeddings, e.clinicaId, MD)).toBe('ingerido');
    expect(await ingerirDocumento(base, e.embeddings, e.clinicaId, MD)).toBe('sin_cambios');
    expect(await ingerirDocumento(base, e.embeddings, e.clinicaId, MD.replace('Segundo', 'Otro'))).toBe('ingerido');
    expect(await conteo()).toEqual({ d: 1, f: 1 }); // reingerir reemplaza: no acumula
    expect(await ingerirDocumento(base, new EmbeddingsFalsos('otro-modelo'), e.clinicaId, MD.replace('Segundo', 'Otro'))).toBe('ingerido');
    expect(await conteo()).toEqual({ d: 1, f: 1 });
  });

  it('el contenido no se puede editar en sitio: solo reingerir', async () => {
    await ingerirDocumento(base, e.embeddings, e.clinicaId, MD);
    await expect(base.pool.query("UPDATE documento_lineas SET texto = 'cambiado' WHERE texto = 'Primer dato.'")).rejects.toThrow();
  });
});
