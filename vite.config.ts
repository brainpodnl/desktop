import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Tauri serves the dev server and watches src-tauri itself, so Vite must stay
// off that directory and use a fixed port the Rust side can point at.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    target: 'safari18',
    sourcemap: true,
  },
  resolve: {
    alias: { '@': new URL('./src', import.meta.url).pathname },
  },
});
