# mochi

Lightweight Android client for reading, editing, and syncing a Git-hosted Markdown vault over the GitHub API.

一个面向 Android 的轻量 Markdown 笔记客户端：**只读优先 + 轻量编辑**，与存放在 GitHub（私有或公开）仓库里的笔记目录双向增量同步。

## Project status / 项目状态

**This is a practice project. It is not being developed or tested further.**

It was built to learn a specific set of things end to end: Capacitor on Android, the GitHub
Git Data API, incremental two-way sync, a tiered download strategy, and a search index that
stays correct while the files underneath it change. Those goals were met, and the code is
kept as a reference. What it is *not* is a product with users to support.

**Honest reason for stopping.** Most of the time I have a computer within reach. The moments
I do not are commutes or time already spoken for by something else — and if I am away from a
desk and genuinely free, I would rather review flashcards on my phone than edit notes on it.
That leaves almost no occasion that actually calls for a note app on a phone: not writing,
and not even reading much. Operating notes on a phone is far less convenient than on a
computer anyway. So the premise did not survive contact with how I actually work, and I
stopped.

If you found this repo looking for a maintained Android client for a Git-backed Markdown
vault, this is not it. The design document and the code are still here in case the approach
or a specific piece is useful to you.

---

**这是一个练手项目，不再继续开发和测试。**

它当初是为了把一组东西从头到尾做通：Android 上的 Capacitor、GitHub Git Data API、
双向增量同步、分级下载策略，以及一个在底层文件不断变化时仍然正确的搜索索引。这些目标
达到了，代码留作参考。但它**不是**一个有用户要支持的产品。

**放弃的真实原因。** 我大部分时间手边都有电脑。没有电脑的时候，一般是在通勤，或者
有别的事情占着 —— 而如果我在远离桌子的地方又确实空闲，我更愿意用手机刷卡（复习卡片），
而不是在手机上编辑笔记。于是真正需要"手机上的笔记 App"的场景少之又少：别说写笔记，
连看笔记都很少。何况在手机上操作笔记本来就远不如电脑方便。所以这个前提没有经受住
我实际工作方式的检验，我就停下了。

如果你是来找一个**在维护的**、面向 Git 仓库 Markdown 笔记的 Android 客户端，那它不是。
设计文档和代码都还在，如果其中的思路或某个具体做法对你有用，尽管拿走。

## License / 许可

**MIT** — see [LICENSE](LICENSE). © 2026 MuggleWu

用就是了：不必在文件里逐个注明出处，也没有任何担保。项目已停更，更不会有人来管你
怎么用。

---

## 它做什么

- 阅读：渲染标题/列表/表格/引用/代码块/公式，`[[内部链接]]` 跳转，外链确认后打开
- 编辑：带行号的纯文本编辑，软换行，读写态之间按位置互相跳转
- 目录与搜索：抽屉列出全部笔记，按修改时间倒序；搜索支持 `and` 语义（命中文件名或内容）
- 增删改：新建、重命名、删除；删除是软删除，推送成功后才真正清掉本地备份
- 复制：顶栏「⋮」菜单可把当前笔记（含标题或仅正文）复制到剪贴板，直接粘到别的应用
- 同步：打开时拉取；推送是手动动作，且**先核对远端再推**，推送前后都会确认没有覆盖别人的改动
- 断点续接：切到别的应用再回来、或者关掉重开，仍在离开时那篇、那个位置、那个态（未保存的正文也在）

## 它不做什么

不做 git 客户端（不建本地仓库、不碰历史、不支持分支与多人协作），不做附件与图片管理，不兼容任何笔记软件插件生态，不追求成为桌面端编辑器的移动替代品。

只处理仓库根目录的 `.md`，子目录与附件原样不动。

**已知限制**：同一篇笔记在手机和别处都改过时，它会保守地判定成冲突、**停下不推**，而不是猜一个赢家。应用里目前**没有**"保留哪一边"的选择界面，这是有意的：手机上两个版本都是你自己写的，哪边更重要只有你知道，而整篇覆盖型的二选一在小屏幕上很难看清后果。这类笔记要**先回电脑上把内容理顺并同步**，再回到应用同步一次 —— 那几篇会被电脑上的版本覆盖。宁可停下让人来处理，也不要静默覆盖掉一边的改动。

## 技术要点

- Capacitor 8 + React 18 + TypeScript（strict）+ Vite，前端全部逻辑都在 WebView 内，**不自写原生插件**
- 文件存应用私有目录，零存储权限
- 同步走 GitHub REST（Git Data API）：拉取两阶段（先元数据后内容），推送用内联 `content` 的最小化提交
- 一次推送最少 3 个请求（建树 → 建提交 → 更新分支），**绝不 force**：远端在我们读取之后被推过时如实报错让人先拉取
- 推送完会读回刚建立的提交，确认它的父提交正是推送前记下的那个、树正是刚建的那个；对不上就报失败并保留改动，宁可下次重复推一遍
- 拉取带 ETag 条件请求，树没变时 0 字节返回；真实修改时间从版本历史反推，**一次同步连着核对多段**（每段完就落盘并重排，中断也不丢进度）
- 列表、搜索、同步**不读文件**：内存清单 + 常驻 2-gram 倒排索引（差分 varint 压缩）
- 编辑状态用原生 `<textarea>` + 行号槽；跳转定位用同排版的隐藏镜像测量（软换行下 `scrollTop ÷ 行高` 不成立）

## 开发

项目已停更，但下面这套流程仍然可用 —— 想拿它当参考实现、或自己改着玩都没问题。

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
- `mochi-<版本>-debug-<日期>.apk` —— 同一份文件的带版本号副本，便于确认版本

**这个目录只保留最新一版**（项目已停更，见开头「项目状态」）：开发过程中一度堆了十几个
历史包、共 90 MB 左右，而实际没有任何一次回退用上过 —— 需要旧版本时照上面的流程重新
构建即可，代码才是权威。

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
| L1 | 元数据一到就自动开跑 | 300 篇，保证"打开就能读" |
| L2 | L1 完成后自动接着跑 | 其余全部，带进度、可暂停 |
| L3 | 打开某篇时 | 本地没有就地拉那一篇，无网则如实说"尚未下载" |

> **这 300 篇不是"最近编辑的"。** 递归树里没有文件修改时间，所以首屏只能按树里的
> 固定顺序取前 300 篇（契约见 `pull-content.ts` 与它的单测：给什么顺序就按什么顺序）。
> 想看全库内容，等 L2 跑完。原因与后果详见下面「时间戳」。

规则实现在 `src/core/sync/pull-content.ts`（纯函数 + 单测），调度在 `store.ts` 的 `pullContent`。
并发 6：不追求极限，避开 GitHub 的二次限流。

## 时间戳

**列表里显示的日期是下载到本机的时刻，不是笔记的修改时间。** 别拿它当"这篇什么时候改的"。

原因是 git 的数据结构里**只有内容**：递归树给的是路径、模式、类型、blob sha、大小，
**没有 mtime**（`git log --format=%cI` 那套是本地库的能力，API 的树不提供）。
所以只能拿"落盘那一刻"顶上，取它的目的是**顺序稳定**而不是准确。

连带的三处后果：

| 位置 | 表现 |
|---|---|
| 列表排序 | 按下载顺序，不是修改时间 |
| 列表上的日期 | 下载时刻 |
| 搜索结果的排序 | 同样跟着这个时间走 |

想要准确的修改时间并非没办法，但要额外多抓一轮数据，而且抓取量会随仓库的
提交次数增长。**当前没做** —— 与其显示一个看起来精确、其实是假的数字，
不如在这里把话说清楚。

## 几个容易写错的地方

都踩过：

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
