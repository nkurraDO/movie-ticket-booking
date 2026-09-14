import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development Vite proxies /api to the backend service so the browser only
// ever talks to one origin. In production nginx performs the same proxying.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_DEV_PROXY ?? 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
