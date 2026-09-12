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

