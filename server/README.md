# reader-server

Fluent Reader Custom 的**无界面服务端**。前端只负责渲染，它负责把订阅数据整理成一个干净的 HTTP API。

阶段 1 范围：**只做服务端**。浏览器前端形态未定，这里附一个冒烟调试页（`/`）。

## 两种后端

| `READER_BACKEND` | 谁抓取 | 用在哪 |
|---|---|---|
| `miniflux`（默认） | **Miniflux**（arm-main 上已跑 24/7） | 正式部署。复用已验证的抓取、去重、403 绕过，以及 RSSBox 的 120 个双语源 |
| `local` | 本进程直接抓 RSS 入 SQLite | 实验；或部署在到不了 Miniflux 的主机 |

`miniflux` 模式下本服务**不抓取、不镜像全库**：只做三件事——把 Miniflux 的
`/v1` 结果整形成前端要的字段、把读过的条目懒缓存到本地 SQLite（这样详情页不用
再拉一次列表）、以及把读/星写回 Miniflux。前端的死数据不会在服务器上再存一份。

`local` 模式是完整的抓取器（rss-parser + 字符集嗅探 + 去重 + 并发池），见文末实测。

## 运行

```powershell
cd server
node src/index.ts                    # http://127.0.0.1:7788
node src/index.ts --no-initial-refresh
node src/index.ts --refresh-once     # 刷一轮就退出（适合 cron / k8s Job）
node src/seed.ts                     // 仅 local 模式：从 Electron 的库复制订阅列表
```

要求 Node ≥ 22.18（内建类型擦除直接跑 `.ts`，无构建步骤；内建 `node:sqlite`，**无原生编译依赖**，arm64 部署不用装编译链）。

所有 `/api/*`（除 `/api/health`）都在网关后面：浏览器靠 Authelia 的会话
（Caddy `forward_auth` 通过后注入 `X-Forwarded-Sso` + `Remote-User`），
脚本用 `Authorization: Bearer <token>`。**没有账号密码、没有登录页**。
token 由 `READER_TOKEN` 指定，未指定时自动生成到 `data/token`（0600）。

```powershell
$env:MINIFLUX_TOKEN = "…"            # Miniflux → Settings → API Keys
$env:READER_TOKEN   = "…"            # 暴露给浏览器的那把钥匙，和 Miniflux 的无关
node src/index.ts
```

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 免鉴权；`backend` / 缓存条目数 / 未读数 / 是否在刷 |
| GET | `/api/sources` | `{sources, groups}`：订阅源 + 未读数 + 所属分类；`groups` 是 Miniflux 分类折成的分组 |
| GET | `/api/sources/:sid/icon` | 图标：Miniflux → 站点自取 → 首字母色块，结果缓存进 `source_icons` |
| POST | `/api/sources/read-all` | `{sids:[…]}`：整组标记已读，一次请求 |
| POST | `/api/sources/:sid/read-all` | 单个订阅源标记已读 |
| POST | `/api/sources` | 仅 `local` 模式：`{url, name?, iconurl?}` |
| GET | `/api/items` | `source` / `unread=1` / `starred=1` / `search` / `limit` / `offset` |
| GET | `/api/items/:id` | 单条全文（`content` 只在这里出现） |
| POST | `/api/items/read` | `{ids:[…], value?}`：批量已读/未读。按 `r` 翻页时每次按键一个请求太慢，前端把它攒成一次 |
| POST | `/api/items/:id/read\|star` | `{value?: boolean}`，写回 Miniflux 后再更新缓存 |
| POST | `/api/refresh` | 触发一轮刷新；`miniflux` 模式是让 Miniflux 立刻抓 |
| GET | `/api/stats` | 缓存条目数 / 未读数 / 源数 |

列表响应**不含 `content`**，只给 `snippet`（截断 1000 字）。详情走 `/api/items/:id`
从懒缓存读，所以点开一条不会触发第二次列表下载。

分页：`miniflux` 后端用 `offset`（Miniflux 的语义）；`local` 后端额外支持
`before=<date>_<id>` 键集游标。

### 图标为什么自己在服务端解析

Miniflux 只给 250/259 个源存了图标，剩下的 9 个（linux.do 的 5 个、science.org、
thepointmag）`icon_id` 是 0，`/v1/feeds/:id/icon` 直接 404 —— 前端 `<img>` 就是一块空白。
原因不是 Miniflux 有 bug：linux.do 返回 **403 的 HTML 里才有** `<link rel="icon" href="data:image/svg+xml;base64,…">`，
science.org 对任何 UA 都 403。所以 BFF 自己解析：

1. Miniflux 有图标（`icon_id > 0` 或 `external_icon_id` 非空）→ 代理它；
2. 否则抓站点 HTML，按文档顺序取 `<link rel~="icon">`（支持 `data:` URI，403 响应也解析，
   Discourse 的 403 页仍带图标），再退到 `/favicon.ico`、`/apple-touch-icon.png`、`/favicon.png`；
   字节数按魔数校验，`application/octet-stream` 也能认；
3. 还不行就给一个按 `sid` 取色的首字母 SVG —— 列表不会再出现空洞。

结果写进 `source_icons(sid, content_type, body, fetched_at)`：命中 7 天，未命中 24 小时
（站点被临时封的情况要能重试）。

> 图标是 `<img>` 请求，带不了 `Authorization`，所以它依赖浏览器自带的
> Authelia 会话 Cookie 通过 `forward_auth`。换句话说：**走公网域名时图标正常**；
> 如果直接打 `127.0.0.1:7788`（例如 SSH 隧道 + `?token=`），图标会 401。
> 这也是图标路由保持鉴权、`cache-control: private` 的原因。

## 数据

- SQLite 文件默认 `data/reader.db`，`PRAGMA journal_mode=WAL`。
- **表结构直接复用 Electron 端的 drizzle 迁移**（`dist/drizzle/*.sql`），
  `sources`/`items` 两张表与客户端一致。迁移按文件 sha256 记账，只应用一次。
- 额外三个索引（`items(source, date DESC)`、`items(hasRead, date DESC)`、
  `items(source, guid)`）——没有它们，几万行的表每次请求都退化成全表扫描。
- 缓存行按 `(source, guid)` upsert，`_id` 对客户端保持稳定。
- `source_icons(sid, content_type, body, fetched_at)` 是服务端自己的表（不在 drizzle
  迁移里，`openDb()` 里 `CREATE TABLE IF NOT EXISTS`），存解析出来的图标字节。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `READER_BACKEND` | 有 `MINIFLUX_TOKEN` 时 `miniflux`，否则 `local` | 后端选择 |
| `MINIFLUX_URL` | `https://rss.pilrymage.com` | Miniflux 地址；部署在 arm-main 上应改成 `http://127.0.0.1:18080` 免绕公网 |
| `MINIFLUX_TOKEN` | — | `miniflux` 模式必填 |
| `READER_TOKEN` | 自动生成 `data/token` | 前端使用的 token |
| `READER_PORT` / `READER_HOST` | `7788` / `127.0.0.1` | 监听地址 |
| `READER_DB` | `data/reader.db` | SQLite 路径 |
| `READER_MIGRATIONS` | `../dist/drizzle` | 迁移目录 |
| `READER_REFRESH_MINUTES` | `30` | 刷新间隔（`miniflux` 模式下只是"催一下"） |
| `READER_CONCURRENCY` / `READER_TIMEOUT_MS` | `4` / `20000` | 仅 `local` 抓取生效 |
| `READER_CORS_ORIGIN` | `*` | 前端独立域名时收紧 |
| `READER_AUTO_READ_GROUPS` | — | 逗号分隔的 Miniflux 分类名（如 `外文`）；这些分类的未读会被自动整组标读，见下文 |

## 实测：local 后端（2026-11-14，本机 Windows，259 源，并发 4）

- 全量一轮 **75 秒**，入库 4,470 条，成功 131/259。
- 139 个直连源中 **131 成功（94%）**。
- 128 个失败里 **120 个是 RSSBox 源**（`http://127.0.0.1:18082/rss/<slug>`）——
  这些是 arm-main 的**宿主机局部地址**，本机抓必然 `fetch failed`，
  和 RSSBox / Miniflux 同机部署后即可正常。这也是选择 `miniflux` 后端的原因之一。
- 真正失败的直连源 8 个：Linux.do ×5（HTTP 403，需要 clearance cookie）、
  Emacs China（20s 超时）、Hacker News LLM、MIT Technology Review。

## 已知限制

- `miniflux` 模式依赖 Miniflux 的 `PUT /v1/entries`（批量改状态）和
  `PUT /v1/entries/{id}/bookmark`（切换星标）；星标是"翻转"语义，所以前端
  必须传目标值、不要连点。
- **分组 = Miniflux 分类**：BFF 把分类折成 `groups`（`gid = 1000000 + 分类 id`），
  每次加载都覆盖浏览器本地存的 `sourceGroups`。也就是说在网页里改名/拖动分组
  刷新后会还原，要真改请去 Miniflux 改分类。展开状态按 `gid` 保留。
- 缓存只增不减：目前没有按时间或条目数清理，长时间使用需要加一条裁剪策略。
- `local` 模式无条件 GET（未用 ETag / If-Modified-Since）、无代理支持、无 403 绕过。
- 无全文提取（Mercury）——`loadFull` 还没搬过来。
- ~~「整个源/整组标记已读」按 200 条一页取未读，单源未读超过 200 时要再点一次~~
  已修复：`markSourcesRead` 现在按 100 条一页循环清空，直到该源未读耗尽（回归见 `tests/server-auto-read.cjs`）。

## 分类自动标读（filter）

「内容太多看不完」的对策：把不想读的分类配进 `READER_AUTO_READ_GROUPS`（逗号分隔的
Miniflux 分类名，如 `外文`），BFF 在**每次刷新后、每次启动时**把该分类下所有未读条目
整组标读（写回 Miniflux，对所有客户端生效）。效果是该分类的未读数永远 ≈ 0，未读列表
里只剩你想读的分类。

- 分类按**标题**匹配，每轮重新解析：往分类里加新订阅源、改名、移动源都会自动跟进；
  gid 只是 `1000000 + 分类 id`，不参与匹配。
- 执行时机：启动后一轮（`--no-initial-refresh` 也会跑，这是数据操作不是抓取）、
  每 `READER_REFRESH_MINUTES` 刷新后、网页里点刷新（`POST /api/refresh`）后的后台。
- 标读不可逆（写进 Miniflux 的状态），但条目本身不删：「全部文章」视图里仍能翻到，
  只是不再以未读出现。星标过的条目照常保留星标。
- 内部实现在 `backend.ts` 的 `drainFeedUnread(sid, keep)`：按 100 条一页循环抽干，
  `keep` 是判定谓词——现在是恒真（整组标读）。**要按关键词精细过滤时**（如只滤
  标题含某词的外文条目），换一个基于标题/作者正则的 `keep` 即可，循环、分页与游标
  逻辑不变；后续可挂 `READER_AUTO_READ_RULES=分类:正则` 之类的配置。
- 2026-11-21 起 arm-main 的 `reader.env` 配置为 `READER_AUTO_READ_GROUPS=外文`
  （中文 19 源、翻译 120 源保持原样）。

## 部署到 arm-main（2026-11-15 已落地）

| 项 | 值 |
|---|---|
| Node | `/opt/node22/bin/node`（v22.23.2，官方 arm64 tarball，免编译） |
| 代码 | `/opt/reader`（root:root 755，含 `server/` 与 `dist/drizzle`） |
| 配置 | `/srv/rss/reader.env`（rss:rss 600） |
| 数据 | `/srv/data/reader/reader.db`（rss:rss 750，WAL） |
| 服务 | `rss-reader.service`，`User=rss`，`Restart=always`，监听 `127.0.0.1:7788` |
| 上游 | `MINIFLUX_URL=http://127.0.0.1:18080`（走环回，不绕公网） |

必须和 Miniflux（:18080）、RSSBox（:18082）**同一台主机**：前者是数据来源，
后者的 120 个源 URL 是宿主机局部地址。

升级步骤（只改了某个文件时）：

```powershell
scp src/backend.ts ubuntu@129.225.137.7:/tmp/
ssh ubuntu@129.225.137.7 'sudo install -o root -g root -m 644 /tmp/backend.ts /opt/reader/server/src/backend.ts && sudo systemctl restart rss-reader'
```

换前端（`dist-web`）时注意 **tar 里带一层目录名**：

```powershell
tar -czf "$env:TEMP\reader-web.tgz" -C D:\github\fluent-reader-custom dist-web
scp "$env:TEMP\reader-web.tgz" ubuntu@129.225.137.7:/tmp/
```

```bash
sudo rm -rf /opt/reader/dist-web.new && sudo mkdir -p /opt/reader/dist-web.new   # /opt/reader 是 root 所有，必须 sudo
sudo tar -xzf /tmp/reader-web.tgz -C /opt/reader/dist-web.new                    # → dist-web.new/dist-web/
sudo rm -rf /opt/reader/dist-web
sudo mv /opt/reader/dist-web.new/dist-web /opt/reader/dist-web                   # 别把 dist-web.new 整个挪过去
sudo chmod -R u=rwX,go=rX /opt/reader/dist-web
sudo systemctl restart rss-reader
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7788/                 # 必须 200；拿不到就是目录层套错了
```

已验证（2026-11-15）：259 个源 / 未读计数与 Miniflux 一致；列表分页、详情正文、
读/星写回并可从 Miniflux 侧看到，读回退后未读总数复原。
同一天的回归（部署后经隧道 + 无头 Edge 实测）：

- 图标：`/api/sources/*/icon` 295 张全部 `naturalWidth > 0`（此前 9 个源 404 空白）；
- 分组：菜单出现 中文(19) / 外文(120) / 翻译(120) 三组，`gid = 1000000 + 分类 id`；
- 连按 12 次 `r`：**2 个 POST**、12 条全部落库，焦点移动 24–42 ms
  （改动前是每次按键 1 个 POST，且焦点要等往返，这条链路 RTT ≈ 250 ms）；
- 复现脚本：`tests/custom-e2e/probe-web.cjs`（图标/分组）、
  `tests/custom-e2e/probe-read-keys.cjs`（按键请求数与焦点延迟），
  敏感值从命令行传入，脚本自己不写盘。**注意**：探针需要一条已登录的 Authelia 会话
  （`authelia_session` Cookie），由命令行传入后用 CDP 种进无头浏览器；
  `<img>` 带不了 Bearer。

## 公网访问（2026-11-15 已上线）

**https://reader.pilrymage.com** —— Cloudflare Tunnel（token 模式）→ Caddy（SSO 网关）
→ `127.0.0.1:7788`，和 Miniflux / RSSBox 同一台主机。隧道与 DNS 由
`D:\github\oracle\cloudflare\add-reader.ps1` 维护（可 `-DryRun` 预览），每次改动会把当前
ingress 快照成 `tunnel-config-*.json`。

### 认证：整站 SSO，不再有账号密码

`https://reader.pilrymage.com` 的**页面、静态资源、`/api/*`** 全部在 Caddy
`forward_auth` 后面，由 Authelia 判定。未登录时 Caddy 直接 302 到
`auth.pilrymage.com`，请求根本到不了 BFF；通过后 Caddy 才注入身份头。

- 服务端只认两种凭据（`server/src/api.ts` 的 `authorized()`）：
  1. **SSO**：`X-Forwarded-Sso: 1` + `Remote-User`，两个头都由 Caddy 在
     `forward_auth` 通过后写入，客户端自己发是无效的；
  2. **机器 token**：`Authorization: Bearer $READER_TOKEN`。Caddy 对带 Bearer 的请求
     跳过 `forward_auth`，并**剥掉** `Remote-User` / `X-Forwarded-Sso`，
     防止“假 Bearer + 伪造身份头”混过去。
- 2026-11-16 起已删除：`/login` 登录页、`/api/login`、`/api/logout`、`/api/session`、
  scrypt 口令哈希（`READER_PASSWORD_HASH`）、会话签名密钥（`READER_SESSION_SECRET` /
  `data/session.secret`）、`src/hash-password.ts`。
- `/api/health` 仍然匿名（给 Uptime Kuma 用），只暴露条目数、未读数、源数；
  Authelia 侧只对 `^/api/health` 开 bypass。
- 静态资源（`/`、`/index.js`、`/article/*`）不再是公开文件：`/` 和 `/index.html`
  由 SSO 保护；带内容哈希的产物按 `private, max-age=31536000, immutable` 发，
  其余一律 `private, no-cache, must-revalidate`。

### 为什么每一条静态资源都必须带 `private`

`private` 不只是"别让共享缓存发给别人"，它还是**关掉 Cloudflare 改写**的开关。
本 zone 的 `Browser Cache TTL = 14400`、`cache_level = aggressive`（整站设置，18 个
域名共用，不能动），实测同一会话 Cookie、只有响应头不同：

| 源站发出 | Cloudflare 返回 | 后果 |
|---|---|---|
| `private, max-age=31536000, immutable` | 原样透传，`cf-cache-status: BYPASS` | 正确 |
| `no-cache, must-revalidate`（**不带 private**） | 改写成 `max-age=14400`，`MISS`/`EXPIRED` | **发版后最多 4 小时仍是旧版** |

所以非哈希资源（`styles/*.css`、`article/*`、`index.css`、`icons/*`）只写 `no-cache`
是不够的——2026-11-18 就是这样让一份修好的 `feeds.css` 有被边缘缓存 4 小时的风险。
回归测试 `tests/static-cache-policy.cjs` 直接加载 `serveStatic` 断言这两条分支，
去掉任何一处 `private` 都会红。

> 部署注意：数据目录默认取 `READER_DB` 的所在目录（`/srv/data/reader`）。代码目录
> 是 root 所有且 systemd 开了 `ProtectSystem=full`，往那里写 token 会启动失败。
> 另外 `/api` 在 Authelia 里**不能再 bypass**——去掉 bypass 后 SSO 才覆盖到接口。
> 备份别放进 `dist/`：那是静态根目录，放进去等于把备份公开出去，放到
> `/opt/reader-backups/`。

### 文章正文为什么不走 URL

`article.html` 原本把正文放在 `?a=` 查询串里。正文平均 2.8 KB、最大 144 KB，
URL 编码后远超 Node 的 16 KB 请求头上限 —— 实测 40 KB 查询串直接 **431**。浏览器版
因此改成：iframe 的 src 只带 `id=`，父页面在 `onLoad` 后用 `postMessage` 把正文推进去。

⚠️ `dist/article/article.js` 带 SRI 完整性校验（`article.html` 里两个 sha256：一个给
`mercury.web.js`、一个给 `article.js`，CSP 里还有一份）。**改这个文件必须同时更新
那两处哈希**，否则脚本会被浏览器静默拦掉，文章区全白：

```powershell
node -e "const fs=require('fs'),c=require('crypto');console.log('sha256-'+c.createHash('sha256').update(fs.readFileSync('dist/article/article.js')).digest('base64'))"
```


