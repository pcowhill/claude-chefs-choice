import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base './' so the built dist/ can be opened from any path or file://
export default defineConfig({
  base: './',
  plugins: [react()],
})
