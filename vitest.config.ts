import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Los tests comparten una base de datos real y la cola es global: van de uno en uno.
    fileParallelism: false,
    globalSetup: ['tests/preparar-base.ts'],
    testTimeout: 20_000,
  },
});
