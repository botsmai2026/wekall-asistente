import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// En desarrollo, la interfaz corre en otro puerto y reenvía las llamadas a la API.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:3000', '/webhooks': 'http://localhost:3000', '/health': 'http://localhost:3000' } },
});
