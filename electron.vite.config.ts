import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: { rollupOptions: { external: ['node-pty'] } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  renderer: {
    resolve: { alias: { '@shared': resolve('src/shared'), '@': resolve('src/renderer/src') } },
    plugins: [react()],
    // viewer3d.html is the sandboxed 3D viewer frame: three, its loaders and their Draco/KTX2 decoders
    // (emitted beside it as assets) load only there, never in the app bundle.
    build: { rollupOptions: { input: { index: resolve('src/renderer/index.html'), viewer3d: resolve('src/renderer/viewer3d.html') } } }
  }
})
