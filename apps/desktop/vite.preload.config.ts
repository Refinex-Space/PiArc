// Preload bundle. @electron-forge/plugin-vite emits a single CommonJS file
// `.vite/build/preload.cjs` with `electron` external; the sandbox allows nothing else.
import { defineConfig } from 'vite';

export default defineConfig({});
