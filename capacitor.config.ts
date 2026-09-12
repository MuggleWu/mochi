import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.mugglewu.mochi',
  appName: 'mochi',
  webDir: 'dist',
  plugins: {
    SystemBars: {
      // 安全区一律由网页自己处理（styles.css 的 --inset-*），不让原生再掺一脚。
      //
      // 为什么关掉内建的自动处理：它那套的生效条件随 WebView 版本与 Android 版本漂移
      // （WebView 较新且带 viewport-fit=cover 才给真实的 env()；只在 Android 15+ 才给
      // WebView 的父视图补内边距）。于是「Android 14 + 老 WebView」这一格两个机制都不生效，
      // 网页拿到的全是 0，内容压进状态栏与导航栏 —— 真机反馈的正是这个现象。
      // 关掉之后所有设备走同一条路：MainActivity 读真实窗口内边距注入 --native-inset-*，
      // CSS 取 env() / 这里注入的值 / --native-inset-* 三者最大值。
      insetsHandling: 'disable',
    },
  },
  server: {
    androidScheme: 'https',
  },
};

export default config;
