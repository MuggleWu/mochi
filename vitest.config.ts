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
    // src 下是单元测试（秒级）；bench 下是基准（几十秒，只在 `npm run bench:index` 时跑），
    // 用文件名后缀 `.bench.test.ts` 与单元测试区分，不混进 `npm test`
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'bench/**/*.bench.test.ts'],
    reporters: ['default'],
    setupFiles: ['./src/test-setup.ts'],
  },
});
