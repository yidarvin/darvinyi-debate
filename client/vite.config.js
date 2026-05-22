import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite config. Dev server proxies /api/* to the local Express server on :3001.
// In production, VITE_API_URL is empty (set in .env.production) so fetch() hits
// the same origin — the Express server in prod also serves the SPA.

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
