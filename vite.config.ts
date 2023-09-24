import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import polyfills from './vite-plugin-node-stdlib-browser.cjs'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react({
      jsxImportSource: '@emotion/react'
    }),
    polyfills(),
  ],
})
