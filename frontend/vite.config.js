import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import katexInlineFonts from './vite-plugin-katex-inline-fonts.js'

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte(), katexInlineFonts()],
  build: {
    rollupOptions: {
      output: {
        // Fixed names so Rust include_bytes! paths are stable across rebuilds.
        entryFileNames: 'assets/index.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: (assetInfo) => {
          // Keep sprite PNGs at predictable paths.
          if (assetInfo.name && assetInfo.name.endsWith('.png')) {
            return 'assets/[name][extname]';
          }
          return 'assets/[name][extname]';
        },
      },
    },
  },
})
