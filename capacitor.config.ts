import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.mugglewu.mochi',
  appName: 'mochi',
  webDir: 'dist',
  android: {
    // 键盘避让由我们自己控制：insets 监听挂在 decor view 上，只改 WebView 的
    // bottomMargin（Capacitor 8 里挂在 WebView 上永远读到 0）。所以关掉内建处理，
    // 避免两套机制互相打架。
    adjustMarginsForEdgeToEdge: 'disable',
  },
  server: {
    androidScheme: 'https',
  },
};

export default config;
