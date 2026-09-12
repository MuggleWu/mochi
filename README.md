# mochi

Lightweight Android client for reading, editing, and syncing a Git-hosted Markdown vault over the GitHub API.

一个面向 Android 的轻量 Markdown 笔记客户端：**只读优先 + 轻量编辑**，与存放在 GitHub（私有或公开）仓库里的笔记目录双向增量同步。

## 它做什么

- 阅读：渲染标题/列表/表格/引用/代码块/公式，`[[内部链接]]` 跳转，外链确认后打开
- 编辑：带行号的纯文本编辑，软换行，读写态之间按位置互相跳转
- 目录与搜索：抽屉列出全部笔记，按修改时间倒序；搜索支持 `and` 语义（命中文件名或内容）
- 增删改：新建、重命名、删除
- 同步：打开时拉取、手动推送增量；冲突采取"三方判定 + 三选项（保留本地/保留远端/都保留）"

## 它不做什么

不做 git 客户端（不建本地仓库、不碰历史、不支持分支与多人协作），不做附件与图片管理，不兼容任何笔记软件插件生态，不追求成为桌面端编辑器的移动替代品。

## 技术要点

- Capacitor 8 + React 18 + TypeScript（strict）+ Vite，前端全部逻辑都在 WebView 内，**不自写原生插件**
- 文件存应用私有目录，零存储权限
- 同步走 GitHub REST（Git Data API）：拉取两阶段（先元数据后内容），推送用内联 `content` 的最小化提交
- 列表、搜索、同步**不读文件**：内存清单 + 常驻 2-gram 倒排索引（差分 varint 压缩）
- 编辑状态用原生 `<textarea>` + 行号槽；跳转定位用同排版的隐藏镜像测量（软换行下 `scrollTop ÷ 行高` 不成立）

## 开发

```bash
npm install
npm run dev            # 浏览器里跑（调试开关见下）
npm run typecheck      # tsc --noEmit
npm run lint           # eslint
npm run test           # vitest
npm run build          # 类型检查 + 打包
```

Android 构建：

```bash
npm run build
npx cap sync android
cd android && ./gradlew assembleDebug   # 需先设好 ANDROID_HOME
```

调试开关（浏览器控制台）：

- `window.__mochiKbOverride = { height, offsetTop }` —— 在桌面浏览器里复现软键盘占位
- `window.__mochiIndexOverride` —— 模拟"搜索索引尚未就绪"

## 图标与启动图

图标由一张 1024×1024 的方形源图生成，脚本不在本仓库里（它记录的是生成者的本机路径）。生成规则记在这里，便于日后换图时照着做：

- 先按"与底色明显不同"抠出图案的实际外接框，再裁成正方形并留 6% 边距 —— 源图四周留白很大（图案只占画布 72%），直接缩放会让图标显得很小
- **自适应图标前景**里的图案占画布 94%：几何上限是 1/√2 ≈ 70.7%（图案须落在画布内切圆内），本图案近似圆形、方形外接框四角本来就是空的，实测取到 94% 仍零裁切；留 6% 余量给抗锯齿
- 前景层的 alpha **只用来定形状，不能当颜色深浅**：低饱和的柔和图案若按颜色差线性给 alpha，整张会变半透明、合成后颜色偏淡（本图单通道差最大只有 158，线性映射后 alpha 上限仅 153）。所以只把"很接近底色"的像素判为透明，其余一律不透明，12~40 的窄区间做过渡以保留抗锯齿
- 背景层用米白 `#F7F2E8`，与源图底色一致 —— **自适应图标的前景层只保留图案、四角是透明的，底色由背景层提供，所以 `ic_launcher_background` 与源图底色必须同色**，不一致时图案周围会露出一圈异色边
- 旧版（API 26 以下）图标用"白圆底 + 居中图案"，避免方形图标在圆形启动器上被切角
- 启动图沿用模板尺寸，白底居中放图案，图案占较短边的 30%

产物为 `mipmap-{m,h,xh,xxh,xxxh}dpi/ic_launcher{,_round,_foreground}.png` 与 11 张 `drawable*/splash.png`，共 26 个文件。

## 构建产物

出包后把 APK 归档到与仓库同级的 **`../mochi-产物/`**（本仓库的上一级目录，每次构建都要放）：

- `mochi-latest.apk` —— 最新一版，装机用这个
- `mochi-<版本>-debug-<日期>.apk` —— 按日期留档，便于回退到旧版本

```sh
npm run build && npx cap sync android && (cd android && ./gradlew assembleDebug)
cp android/app/build/outputs/apk/debug/app-debug.apk ../mochi-产物/mochi-latest.apk
```

出包前需要指向本机 Android SDK（`ANDROID_HOME`），路径按各自环境设；Gradle 仓库已换成国内镜像，直连 dl.google.com 会 TLS 握手失败。

归档前**核对 APK 里确实是当前代码**：分包后的 JS 直接在 `assets/public/assets/*.js`，可以用 `unzip -p <apk> <该文件> | grep <刚改的标识符>` 确认。踩过一次坑——图标改完就出包归档，结果那份 APK 里没有同批的同步优化代码。

