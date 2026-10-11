// Builds src/scorers.ts into dist/scorers.js — a single IIFE the Guardian loads into Jint.
// Must stay dependency-free and ES2017-ish (Jint supports ES2023 but keep it boring).
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'es2017',
    minify: false,
    lib: { entry: 'src/scorers.ts', name: 'CoinQuestScorers', formats: ['iife'], fileName: () => 'scorers.js' },
    rollupOptions: { output: { extend: true } },
  },
});
