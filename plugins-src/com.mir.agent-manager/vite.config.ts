import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve, join } from 'path'
import { mkdirSync, copyFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { fileURLToPath } from 'url'

const __dirname = resolve(fileURLToPath(import.meta.url), '..')
const PLUGIN_ID = 'com.mir.agent-manager'
const SRC = resolve(__dirname, 'src')
const isDev = !!process.env.ELECTRON_RENDERER_URL || !!process.env.MIR_DEV

// Output to the active userData plugins directory
const pluginsDir = isDev
  ? join(homedir(), 'Library/Application Support/mir-dev/plugins', PLUGIN_ID)
  : join(homedir(), 'Library/Application Support/mir/plugins', PLUGIN_ID)

export default defineConfig({
  plugins: [
    vue(),
    {
      name: 'copy-plugin-assets',
      closeBundle() {
        copyFileSync(resolve(__dirname, 'plugin.json'), join(pluginsDir, 'plugin.json'))
        // Write package.json with type:module so Node loads .js entries as ESM
        writeFileSync(join(pluginsDir, 'package.json'), JSON.stringify({ type: 'module' }, null, 2))
      }
    }
  ],
  build: {
    outDir: pluginsDir,
    emptyOutDir: true,
    lib: {
      entry: {
        main: resolve(SRC, 'index.ts'),
        'main-main': resolve(SRC, 'main.ts')
      },
      formats: ['es'],
      fileName: (_, name) => `${name}.js`
    },
    rollupOptions: {
      external: ['vue', 'pinia', 'vue-i18n', 'electron', 'path', 'fs', 'os', 'url', 'child_process', 'crypto', 'util']
    },
    target: 'esnext',
    minify: false,
    sourcemap: true
  },
  resolve: {
    alias: {
      '@': SRC
    }
  }
})
