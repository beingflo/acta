import { readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
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
  plugins: [solid(), maplibreWorker(), VitePWA({
    // The shell is a handful of hashed files: precache them so an installed app
    // opens instantly, and take an update as soon as one is deployed.
    registerType: 'autoUpdate',
    includeAssets: ['icon.svg', 'apple-touch-icon.png', 'icon-maskable.svg'],
    manifest: {
      name: 'Acta',
      short_name: 'Acta',
      description: 'Dashboards over everything acta collects.',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      background_color: '#ffffff',
      theme_color: '#ffffff',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        // Same mark on a full-bleed plate, because Android crops a maskable
        // icon to whatever shape it likes.
        { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    workbox: {
      globPatterns: ['**/*.{js,css,html,svg,png}'],
      navigateFallback: '/index.html',
      // A dashboard is live data: the API and the tiles are never cached. A
      // stale chart is worse than a chart that has to wait for the network.
      navigateFallbackDenylist: [/^\/api\//, /^\/tiles\//],
      runtimeCaching: [{ urlPattern: /\/(api|tiles)\//, handler: 'NetworkOnly' }],
    },
  })],
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
