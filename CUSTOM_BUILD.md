# Fluent Reader Custom — Windows 本地构建

本项目是 [Fluent Reader](https://github.com/yang991178/fluent-reader) 的个人定制 fork，保留上游 BSD-3-Clause 许可证及作者信息。

## 按键目标

- `a`：把键盘焦点跳到文章标题列表，不必反复按 `Tab`。落点是“当前打开的文章所在行”→“上次键盘光标行”→“列表第一行”，只在目标行不在视野内时做最小滚动。卡片视图下文章是盖在列表上的焦点陷阱，`a` 会先关闭它再聚焦该行；文章 WebView 持有焦点时同样可用。在搜索框、编辑区、输入法组合、设置/菜单/弹窗以及侧边订阅源菜单内不生效（菜单里的字母仍用于跳转订阅源）。

在文章标题列表聚焦时：

- `r`：明确标记当前文章已读，聚焦下一条，不打开文章；支持长按。
- `Shift+r` / `R`：当前分类（包括其订阅以及尚未加载的文章）全部标读，不弹确认；长按不重复提交。在“全部文章”视图下，作用范围为全部订阅。
- `p` / `ArrowUp`：上一条；`n` / `ArrowDown`：下一条，支持长按。
- `Ctrl+l`：当前标题居中 → 置顶 → 置底循环；移动后重置。
- 越过屏幕下边界时，下一条置于下一屏顶部；向上越界时上一条置于上一屏底部。列表开头/结尾受实际可滚动范围限制。
- 搜索框、编辑区、输入法组合、设置/菜单/弹窗及文章 WebView 不触发列表快捷键。
- 文章打开后，`b` 用默认浏览器打开当前已打开的文章（焦点在网页或文章工具栏均可），不跟随列表光标；列表上的 `b` 仍打开光标所在的文章。
- 侧边订阅源菜单获得焦点时（例如按 `Tab` 后），`p` / `n` 像上下方向键一样移动，跳过折叠分组内的条目，首尾不循环。
- 已读标题显示灰色。保留 Fever 订阅图标支持。

## 阅读服务同步

本地标记的已读/未读在服务端确认前会被记为“待确认”（保存在应用的 localStorage，按服务地址和账号区分）。同步时先等待仍在途中的标记请求，再重试失败的请求，最后用这些待确认状态覆盖服务端返回的未读列表，因此网络失败或请求较慢不会再让已读文章变回未读。Fever 的“全部标为已读”在后台以有限并发发送，发布时间晚于标记时间的条目会单独重试。

## 构建

Windows x64；本机验证使用 Node.js 22、Electron 44.7.0。依赖版本以 `package-lock.json` 为准。

```bash
npm ci
npm run build
npm run package-custom
```

`postinstall` 安装 Electron 并准备原生依赖；首次下载 Electron 需要可访问 GitHub。构建覆盖主进程、preload 与 renderer，不使用原安装目录里的程序资源。`package-custom` 生成未签名 ZIP 以及可直接启动的 `bin/win32/x64/win-unpacked/Fluent Reader Custom.exe`。

本机开发工作树复用了旧源码的 `node_modules` 目录联接；此联接不进入 Git。新的 clone 应运行 `npm ci`，无须依赖旧工作树。

构建后可双击根目录 `Launch Custom.cmd`，或直接运行上面的 EXE。解压 ZIP 后，请运行解压目录里的 `Fluent Reader Custom.exe`，不要只复制单个 EXE。

## 数据安全

- 定制版应用标识：`io.github.pilrymage.fluent-reader-custom`。
- 默认独立数据目录：`%APPDATA%/fluent-reader-custom`。
- 显式 `--user-data-dir=...` 用于隔离测试时保留指定目录。
- 不自动复制原版数据库或服务登录配置，不覆盖原版程序。
- 如需日常使用已有订阅，请先在原版导出备份，再在定制版导入。**阅读服务可能同步标读结果；不要在真实数据上随意试按 R。**
- 安装器配置不在卸载时删除用户数据；本次优先交付可解压运行的 ZIP。
- Windows 未签名包可能出现 SmartScreen 提示；本地构建不代表已获得官方签名。

## 验收范围

单元回归测试：

```bash
node tests/keyboard-shortcuts.cjs
node tests/scroll-geometry.cjs
node tests/item-shortcuts.cjs
node tests/card-events.cjs
node tests/fever-icons.cjs
node tests/custom-runtime.cjs
node tests/pending-read-states.cjs
```

真实 Electron 隔离测试（构建后执行，需要 Python 的 `psutil`、`websocket-client`）：

```bash
python tests/custom-e2e/e2e.py
python tests/custom-e2e/navigation_e2e.py
```

测试自建无账号的 70 篇样本库，不连接真实阅读服务；运行时会启动/关闭定制版测试进程，不要与另一份定制版实例同时运行。真实订阅账户不作为快捷键批量标读测试对象。本机额外的默认数据目录安全检查与构建日志保存在相邻的 `fluent-reader-custom-verification` 目录。
