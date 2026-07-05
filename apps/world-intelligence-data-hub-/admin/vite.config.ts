import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  root:    join(__dirname, 'client'),
  build: {
    outDir:      join(__dirname, 'dist'),
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    proxy: { '/api': 'http://localhost:3001' },
  },
});
