import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@core': r('./src/core'),
      '@shared': r('./src/shared'),
      '@ui': r('./src/ui'),
    },
  },
  test: {
    globals: true,
    // 纯逻辑用 node；涉及 DOM 的用例在文件顶部用 `// @vitest-environment jsdom` 声明
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    reporters: ['default'],
    setupFiles: ['./src/test-setup.ts'],
  },
});
