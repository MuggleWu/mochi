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

## 内容怎么进到手机里

分三层，为的是**首启就能用**而不是等全量下完（一万篇按实测网速要几十分钟）：

| 层级 | 时机 | 范围 |
|---|---|---|
| L1 | 元数据一到就自动开跑 | 最近的 300 篇，保证"打开就能读" |
| L2 | L1 完成后自动接着跑 | 其余全部，带进度、可暂停 |
| L3 | 打开某篇时 | 本地没有就地拉那一篇，无网则如实说"尚未下载" |

规则实现在 `src/core/sync/pull-content.ts`（纯函数 + 单测），调度在 `store.ts` 的 `pullContent`。
并发 6：不追求极限，避开 GitHub 的二次限流。

几个容易写错的地方，都踩过：

- **下载来的内容不能走 `save()`**。`save()` 会把条目标成 DIRTY（那是给本地编辑用的），
  下载内容标 DIRTY 会被推送阶段误判成"手机改过"，进而产生一堆假冲突。
  下载走 `NotesRepo.acceptRemote()`，落盘前**校验内容 sha 与递归树给的一致** ——
  对不上说明下载被截断或串了，宁可当失败也不写进去（写进去就成了"本地改动"）。
- **不需要记"下到哪了"**。是否需要下载只看 `localSha !== remoteSha` 这一条，
  L2 重跑、同步后补拉都复用同一套逻辑。多存一份进度状态迟早会和清单漂移
  （"标记说下过了但文件其实没了"）。
- **进度条会一直留着**直到不欠账，因为"后台还在补"这件事用户需要知道，
  否则搜不到某篇内容时会以为坏了。

公式与内链见下节。

## 渲染

`src/core/markdown/render.ts`：markdown-it + KaTeX（复用 miki 已验证的方案）。

里面有一段**必须先做**的处理：公式要被抽成占位符、渲染完再回填 KaTeX。
不这么做的话 markdown 会把公式里的 `_` `*` `<` 当成强调/标签标记吃掉，
`$a_b$` 渲染出来就成了斜体 `a` 加一个 `b`。内链 `[[目标|别名]]` 同样走占位符，
且**必须排在公式之后** —— 它的替换结果含 `<` 与 `]`，先替换会被 markdown 当标记解析。

- 公式/内链/表格/引用/代码块都渲染；**不解析内联 HTML**（笔记里的 `<` 多是文本比较，
  当标签解析只会吃内容）。
- 内链目前渲染成 `<span class="wikilink">`，**点击跳转还没做**（M4 之后）。
  刻意不用 `<a>`：点不动却长得像链接，用户会以为坏了。
- 外链新开并断开 opener。
- 管线**懒加载**（KaTeX 与它的字体几 MB），启动后预取；未就绪时先按纯文本显示，
  不让用户对着转圈等。

## 系统栏与键盘（改 Android 工程前先看）

`env(safe-area-inset-*)` 在 Android 上**不是可靠来源**：只有「WebView 较新 + 页面带
`viewport-fit=cover`」时才有值，老 WebView 一律是 0。Android 15+ 起系统又强制边到边，
窗口不再随输入法收缩，`windowSoftInputMode="adjustResize"` 在边到边窗口上等于失效。
两个机制各自失效的那一格，内容就会压进状态栏与导航栏（真机反馈过这个现象）。

现在三处配合解决：

- `src/ui/styles.css` 的 `--inset-*` 取三者**最大值**：`env()`、Capacitor 注入的
  `--safe-area-inset-*`、以及 `MainActivity` 兜底注入的 `--native-inset-*`。三者只在
  "该由网页自己留白"时才是同一个真值，取 max 不会叠加。
- `MainActivity` 读真实窗口内边距并注入上面那个变量，**已经被原生留过白的方向发 0**；
  排这类问题用 `adb logcat -s mochi-insets`，日志里有「系统报了多少 / 原生补了多少 /
  发给网页多少」三个数。
- 底部留白**只认一个来源** `--bottom-blocked: max(--kb, --inset-bottom)` —— 键盘和导航栏
  不会同时占位，所以取 max 而不是相加。贴底的元素都别再单独写 `--kb`。

两个已经踩过的坑：`android/.../styles.xml` 的**注释里不能出现连续两个减号**（写 CSS 变量名
时要避开）；`body` 留白之后 `.app` 的高度必须是容器的 `100%` 而**不是 `100dvh`**，
后者比容器高出一个安全区，底部那一条会被裁掉。

## 抽屉手势

左缘右滑打开、抽屉上左滑收回，全程跟手；判定规则抽在 `src/ui/edge-swipe.ts`（纯函数、有单测），
事件在 `src/ui/useEdgeSwipe.ts`。

用**触摸事件在 document 上被动监听**，不用 Pointer Events。这里踩过坑：Pointer Events 配
`setPointerCapture` 时，浏览器一旦把手势判成滚动就会发 `pointercancel` 抢走它，表现是
"从左缘拖动完全没反应"（实测 pointerdown 1 次、pointermove 1 次、pointercancel 1 次）。
被动监听从不 `preventDefault`，也就不会收到 cancel —— 浏览器照常滚动，只在有把握时才动抽屉，
判成纵向就整个放弃这次手势。

## 配置

仓库地址、分支与访问令牌都在应用内填写，保存在应用私有存储；令牌只需要目标仓库的 contents 读写权限。
