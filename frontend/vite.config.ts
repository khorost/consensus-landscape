/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'child_process'

const commitHash = execSync('git rev-parse --short HEAD').toString().trim()
const commitDate = execSync('git log -1 --format=%ci').toString().trim().slice(0, 10)

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/consensus-landscape/' : '/',
  plugins: [react()],
  define: {
    __BUILD_HASH__: JSON.stringify(commitHash),
    __BUILD_DATE__: JSON.stringify(commitDate),
  },
  test: {
    globals: true,
  },
})
