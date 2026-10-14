# dsh-github-hub —— DSH GitHub 插件中心

给 DeepSeek Harness（DSH）加一个**原生面板**：登录你的 GitHub 账号、保存登录记录、
在 GitHub / npm 上搜索 `deepseek-harness`（`dsh-plugin`）插件，并**一键安装到当前 profile**
（桌面端 = `desktop` profile），安装链路与「设置 → 插件」「`dsh plugin add`」完全一致。

> 这是标准的 DSH 插件包：宿主半侧（`lib/index.js`）+ 浏览器半侧（`lib/client.js`，
> 在 `package.json` 里以 `dsh.client.platform = "web"` 声明），通过 `dsh.bundle.patch` 挂载。

---

## 功能

| 面板 | 做什么 |
|---|---|
| **发现插件** | 搜 GitHub 仓库（`topic:dsh-plugin`、`topic:deepseek-harness`、`dsh-plugin in:name,description,readme` …）或 npm 包（`keywords:dsh-plugin`）。GitHub 侧默认按**最近更新**排序，并可勾选「**只看插件候选**」——判定同时看 topic 与名字/描述，把蹭 `dsh-plugin` 标签的高星仓库过滤掉。点「检查」会读取仓库里的 `package.json`，判定它到底是不是可安装的 DSH 插件（有没有 `dsh.bundle.patch`、有没有 `dsh.client`）。点「安装」直接装进当前 profile，带实时 pnpm 日志、取消、安装前「是否已装过」预检，以及 pnpm 拦截构建脚本时的「允许这些构建脚本并重试」。失败时会把插件管理器的错误码（`ambiguous-install`、`not-bundle`、`incompatible-version` …）翻译成人话。 |
| **已安装** | 列出当前 profile 的插件包（bundle）与插件条目（row），可以启用 / 停用 / 卸载，并显示加载错误与只读原因。 |
| **账号登录** | 两种登录方式：**Personal Access Token**（最简单）与 **OAuth Device Flow**（自备 OAuth App 的 `client_id`，不需要 client secret）。登录记录（时间 / 账号 / 方式 / 事件 / 权限）持久保存，可清空。 |
| **诊断** | GitHub API / npm / DNS / hosts / git / pnpm 的连通性体检，以及「信任阶梯」当前走到了哪一级。 |

## 安装

在 DSH 里（桌面端或 Web 端）：

```sh
# 1) 从 npm（发布后）
dsh plugin --profile desktop add dsh-github-hub

# 2) 本地开发：直接链接本目录
dsh plugin --profile desktop add link:D:\path\to\dsh-github-hub
```

也可以在界面上用「设置 → 插件」或任意插件市场安装；本插件自己也能安装自己：
在「发现插件」里搜到它的 GitHub 仓库后点「安装」。

装好后**必须重启桌面端**（刷新页面不够：DSH 的启动注入表只在宿主启动时收集一次，新插件的客户端 bundle 要下一次启动才会被写进启动清单）。Web 端同理，重启 `dsh web` 进程即可。加载成功后：

* 左侧栏出现一个 **git 分支图标**（`GitHub 插件中心`）；
* 点它 → 中央面板打开 GitHub 插件中心。

## 自检接口

面板之外，宿主半侧还挂了几个只读接口，方便排查（都要带上浏览器的会话 cookie）：

| 接口 | 用途 |
|---|---|
| `GET /dsh-github/state` | 账号 / 设置 / 登录记录 / 信任阶梯 / 客户端 bundle 是否已进图 |
| `GET /dsh-github/health` | GitHub API、npm、DNS、hosts、git、pnpm 的体检 + 人话结论 |
| `GET /dsh-github/client` | 客户端 bundle 在图里的 `rev` 与真实 URL、以及当前文件算出来的期望 `rev`（不相等 = 改了代码还没重启） |
| `GET /dsh-github/search?source=github\|npm&q=…` | 搜索 |
| `POST /dsh-github/repo/package` | 读某个仓库的 `package.json` 并判定 |
| `POST /dsh-github/inspect` | 交给真实插件管理器预检一个 spec（会做 GitHub 连接检查，不安装） |

## 已验证（本机实测）

* GitHub API 穿过本机加速器可达：`tls=default`（启动时已把 144 张系统根证书并入进程默认信任链），无需降级到跳过校验；
* `pnpm add github:<owner>/<repo>` 与 `pnpm add git+https://github.com/<owner>/<repo>.git` 都能拉到包（前者 37s、后者 19s，含 peer 依赖）；
* 官方安装链路 `pluginManager.installBundle` 对 `link:` spec 端到端成功（pnpm 日志事件 → 进度轮询 → bundle 激活）；
* `POST /inspect` 对 `github:<owner>/<repo>` 返回 `{status:'accepted', kind:'git', host:'github.com'}`；
* 安全栅栏：已认证 200 / 无 cookie 401 / `sec-fetch-site: cross-site` 403。

## 登录 GitHub

### 方式一：Personal Access Token（推荐）

1. 打开 <https://github.com/settings/tokens> 创建 token：
   * 经典 token：勾 `read:user`（只看自己账号）；想装私有仓库再加 `repo`。
   * 细粒度 token：`Public Repositories (read-only)` 就够搜索和装公开插件。
2. 把 token 粘进「账号登录 → 用 Personal Access Token 登录」→「验证并登录」。

令牌保存在 **DSH 凭据服务**里（`~/.dsh/.credentials.yaml` 的 `records` 段，
key = `dsh-github-hub/github`，kind = `grant`），**永远不会下发到页面**：
面板只显示登录名、头像、权限和 token 尾 4 位。

### 方式二：OAuth Device Flow

1. GitHub → Settings → Developer settings → **OAuth Apps** → New OAuth App。
   Device Flow **不需要** client secret，`Authorization callback URL` 随便填本机地址即可。
2. 把 `client_id` 填进「账号登录 → 用 OAuth Device Flow 登录」，点「开始设备登录」。
3. 面板给出一次性代码，去 <https://github.com/login/device> 输入并授权，插件会自动轮询完成登录。

## 数据与隐私

| 内容 | 位置 |
|---|---|
| GitHub 令牌 | DSH 凭据服务（credential record `dsh-github-hub/github`），只存在宿主进程内存与凭据文件里 |
| 设置 + 登录记录 | `$DSH_HOME/.dsh-github-hub.json`（**不含令牌**，最多 200 条） |
| 安装日志 | `$DSH_PROFILE_DIR/.plugin-manager/logs/operation-*/pnpm.log`（由插件管理器写） |

接口全部挂在 `ctx.webServer` 的 `/dsh-github/*` 上，并且套了三层栅栏：
Host 必须是回环地址（或显式声明）、跨站标记一律拒绝、写请求（登录 / 安装 / 卸载）只允许本机来源。

## 网络：GitHub 被本机加速器接管时怎么办

本机常见情况：hosts 被 GitHub 加速器（Watt Toolkit / Steam++ / FastGithub 之类）把
`github.com`、`api.github.com`、`raw.githubusercontent.com` 指向 `127.0.0.1`，
由它的本地反向代理用**自签 CA** 转发。Node 默认不认这张 CA，于是报
`unable to verify the first certificate`。本插件用一条「信任阶梯」逐级适配：

1. **默认信任链** —— 没被拦截时直接成功；
2. **默认根证书 + 操作系统根证书** —— 等价于 `node --use-system-ca`（Node ≥ 24 用
   `tls.setDefaultCACertificates`；插件加载时就会尝试并入一次）；
3. **信任本机拦截器** —— 只有「对端确实解析到回环地址」且设置里开着
   「信任本机拦截器」时才 `rejectUnauthorized: false`，并在界面里明确标成
   `tls: local-interceptor`。

三级都不通就如实报错，不会静默降级。「诊断」页会显示当前用的是哪一级、
hosts 里有多少条 GitHub 劫持记录、以及 `git` / `pnpm` 是否可用。

> 从 GitHub 安装插件走的是 pnpm 的 `github:owner/repo`（git）通道，
> 需要 **git 在 PATH 里**；插件管理器在 pnpm 启动前会先做一次有超时的连接检查。

## 已知边界

* **Live 加载的时机**：客户端半侧由 `dsh-client-modules` 在 Loader 图变化时热同步，
  但**刚装好的插件**通常仍需重启桌面端（或刷新页面）才会出现侧栏图标 —— 这是 DSH 的
  注入表在启动时收集一次决定的，不是插件本身的问题。
* **安装第三方插件 = 让第三方宿主代码在你的 DSH 进程里运行**。面板会显示仓库描述、
  星标、以及 `package.json` 判定结果，但**不会**替你审计代码；安装前请自己看一眼仓库。
* 卸载只负责把 bundle 从 profile 里摘掉（`dsh plugin remove` 的同一路径），
  第三方插件写在 `$DSH_HOME` 里的数据文件不会被删。

## 卸载

```sh
dsh plugin --profile desktop remove dsh-github-hub
```

或直接在面板「已安装」里点卸载。设置文件 `$DSH_HOME/.dsh-github-hub.json` 与
保留的凭据记录可以手动删除。

## License

MIT（见 [LICENSE](./LICENSE)）。