import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  // Served at www.infrastudio.app/studios via a Vercel rewrite from the
  // landing site - asset URLs need this prefix baked in so they resolve
  // against that origin instead of the frontend project's own domain.
  base: '/studios/',
  plugins: [react(), tailwindcss()],
})
