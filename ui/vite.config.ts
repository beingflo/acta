import { readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'
import solid from 'vite-plugin-solid'

// MapLibre loads its worker via a dynamic `new URL()` whose filename is
// computed at runtime, so Vite can't statically find it and never emits it.
// Copy the worker and its shared import into dist/assets, which is where the
// runtime URL resolves.
function maplibreWorker(): Plugin {
  const files = ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']
  return {
    name: 'maplibre-worker',
    generateBundle() {
      for (const file of files) {
        this.emitFile({
          type: 'asset',
          fileName: `assets/${file}`,
          source: readFileSync(new URL(`./node_modules/maplibre-gl/dist/${file}`, import.meta.url)),
        })
      }
    },
  }
}

export default defineConfig({
  plugins: [solid(), maplibreWorker()],
  optimizeDeps: {
    // MapLibre's dynamic worker URL breaks when pre-bundled.
    exclude: ['maplibre-gl'],
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8080',
      '/tiles': 'http://127.0.0.1:8080',
    },
  },
  build: {
    target: 'esnext',
  },
})
