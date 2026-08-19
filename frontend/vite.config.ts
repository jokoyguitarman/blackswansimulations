import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, '../shared'),
    },
  },
  build: {
    rollupOptions: {
      input: {
        // The app shell. Stays at index.html so the SPA catch-all rewrite in
        // vercel.json keeps working untouched.
        app: path.resolve(__dirname, 'index.html'),
        // Public marketing pages. Static, and they load marketing.ts only, so
        // none of the application bundle ships with them.
        simulations: path.resolve(__dirname, 'simulations/index.html'),
        simulationsConsultants: path.resolve(__dirname, 'simulations/consultants.html'),
        simulationsFounder: path.resolve(__dirname, 'simulations/founder.html'),
      },
    },
  },
  server: {
    port: 3002,
    strictPort: false, // Allow Vite to try another port if 3002 is in use
    host: '0.0.0.0', // Listen on all interfaces (IPv4 and IPv6)
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
