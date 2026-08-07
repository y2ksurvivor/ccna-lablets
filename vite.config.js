import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Served from https://<user>.github.io/ccna-lablets/, so asset URLs need the
  // repo name as a prefix. Change this if the repo is ever renamed.
  base: '/ccna-lablets/',
  plugins: [react()],
})
