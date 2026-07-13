import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      '/api': process.env.VITE_API_TARGET ?? 'http://localhost:3001'
    }
  }
});
