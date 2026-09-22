import { defineConfig } from 'vite';
import path from 'node:path';

/**
 * Marketing site build. One entry per page, all at the root of the output so the
 * public URLs are /, /consultants, /corporate-crisis and so on rather than living
 * under a /simulations prefix.
 */
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        index: path.resolve(__dirname, 'index.html'),
        consultants: path.resolve(__dirname, 'consultants.html'),
        corporateCrisis: path.resolve(__dirname, 'corporate-crisis.html'),
        founder: path.resolve(__dirname, 'founder.html'),
        thankYou: path.resolve(__dirname, 'thank-you.html'),
      },
    },
  },
  server: {
    port: 3006,
  },
  preview: {
    port: 4186,
  },
});
