import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  // Capacitor 的 WebView 直接用 file:// 加载打包产物，必须用相对路径
  base: './',
  resolve: {
    alias: {
      '@core': r('./src/core'),
      '@shared': r('./src/shared'),
      '@ui': r('./src/ui'),
    },
  },
  build: {
    outDir: 'dist',
    // 真机是移动端 WebView：不要为了老浏览器把产物撑大
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
  server: { port: 5173, host: '127.0.0.1' },
});
