import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Los tests comparten una base de datos real y la cola es global: van de uno en uno.
    fileParallelism: false,
    globalSetup: ['tests/preparar-base.ts'],
    testTimeout: 20_000,
    // Cada test vacía la base y la siembra de nuevo (beforeEach). Con el disco ocupado ese paso superó
    // los 10 s por defecto en 2 de 9 ejecuciones. El margen reduce esos fallos intermitentes de la
    // preparación; no demuestra que no haya bloqueos, y el límite de cada test (testTimeout) no cambia.
    hookTimeout: 30_000,
  },
});
