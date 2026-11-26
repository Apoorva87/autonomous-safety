import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served from https://<user>.github.io/autonomous-safety/
export default defineConfig({
  base: '/autonomous-safety/',
  plugins: [react()],
  build: { chunkSizeWarningLimit: 2000 },
});
