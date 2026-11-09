import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {
    // @agentclientprotocol/sdk 与 zod 是 ESM-only，放在 devDependencies 由 vite 打包进主进程产物，
    // 避免 CJS 主进程在运行时 require 一个 ESM 包（详见 docs/acp-client.md）。
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@main': resolve('src/main'),
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        // 第二个入口：MIR Harness 的 agent 进程（内置 Agent，由主进程 spawn）。
        // 产物 out/main/agent/index.js 会被打进 asar，启动时用 ELECTRON_RUN_AS_NODE + process.execPath 运行。
        input: {
          index: resolve('src/main/index.ts'),
          'agent/index': resolve('src/agent/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          webview: resolve('src/preload/webview.ts')
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [vue({
      template: {
        compilerOptions: {
          isCustomElement: (tag) => tag === 'webview'
        }
      }
    })],
  }
})
