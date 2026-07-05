import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    conditions: ['browser']
  },
  server: {
    port: 3000
  },
  build: {
    outDir: 'dist'
  }
});
