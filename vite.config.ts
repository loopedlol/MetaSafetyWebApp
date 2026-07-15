import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET ?? 'http://localhost:3001',
        changeOrigin: false
      }
    }
  }
});
