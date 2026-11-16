import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// GitHub Pages project site: /iot-escape-cn466/
// Local dev server: /
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE_PATH || '/',
})
