/**
 * dsh-github-hub —— 浏览器半侧（Client half）
 *
 * 这是 DSH Web / 桌面端的一个原生客户端插件（`dsh.client.platform = "web"`）：
 *   · 在左侧栏注册一个面板图标（slot `sidebar.panellist`）；
 *   · 在中央面板注册一个页面（slot `main`，key = `github-hub`）；
 *   · 页面通过同源 fetch 调用宿主半侧的 `/dsh-github/*` 接口（桌面端由 Electron 的
 *     `dsh-app://` 协议处理器带着会话 cookie 转发给宿主，所以两条形态都一样work）。
 *
 * 手写 bundle 说明：DSH 的客户端 bundle 就是 lazy-CJS —— `window.__ModuleLoader__.load({ id, factory })`，
 * factory 内 `require()` 只能请求平台基线（React、Cordis、静态 UI 库）。本文件只用 React，
 * 因此 `dsh.client` 不需要声明任何 external/inject 依赖。
 */
window.__ModuleLoader__.load({
  id: "dsh-github-hub",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const h = react.createElement;

    /** 字典命名空间与面板 id（侧栏图标与主面板共用同一个 id）。 */
    const NS = "githubHub";
    const PANEL_ID = "github-hub";
    const API = "/dsh-github";

    /** 插件管理器的失败码 → 字典键（见 InstallPanel 的错误提示）。 */
    const ERROR_KEYS = {
      "ambiguous-install": "errAmbiguous",
      "not-bundle": "errNotBundle",
      "incompatible-version": "errIncompatible",
      "build-blocked": "errBuildBlocked",
      "not-found": "errNotFound",
      "no-matching-version": "errNotFound",
      network: "errNetwork",
      "pnpm-missing": "errPnpmMissing",
      timeout: "errTimeout",
      permission: "errPermission",
      integrity: "errIntegrity",
      "disk-full": "errDiskFull",
      "management-required": "errManagement",
      "restart-required": "errRestart",
    };

    /* ================================================================== *
     * 样式：只用 DSH 主题 token（带兜底值，token 缺失也不会崩）
     * ================================================================== */

    const CSS = `
.dgh-root{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);font-size:13px;line-height:1.55}
.dgh-head{flex:none;display:flex;align-items:center;gap:10px;padding:12px 16px 0}
.dgh-title{font-size:15px;font-weight:600;margin:0;display:flex;align-items:center;gap:7px}
.dgh-sub{color:var(--dsw-alias-label-tertiary,#8a8a8a);font-size:11.5px}
.dgh-spacer{flex:1}
.dgh-tabs{flex:none;display:flex;gap:2px;padding:10px 16px 0;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1))}
.dgh-tab{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#555);font:inherit;padding:7px 11px;border-radius:var(--dsw-radius-sm,6px) var(--dsw-radius-sm,6px) 0 0;cursor:pointer;border-bottom:2px solid transparent}
.dgh-tab:hover{color:var(--dsw-alias-label-primary,#111);background:var(--dsw-alias-fill-l1,rgba(0,0,0,.04))}
.dgh-tab[data-active="true"]{color:var(--dsw-alias-brand-primary,#4d6bfe);border-bottom-color:var(--dsw-alias-brand-primary,#4d6bfe);font-weight:600}
.dgh-body{flex:1;min-height:0;overflow:auto;padding:14px 16px 28px;display:flex;flex-direction:column;gap:12px}
.dgh-card{background:var(--dsw-alias-bg-layer-1,#f7f7f8);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:var(--dsw-radius-lg,12px);padding:12px 14px}
.dgh-card-tight{padding:10px 12px}
.dgh-row{display:flex;align-items:center;gap:8px}
.dgh-row-wrap{flex-wrap:wrap}
.dgh-col{display:flex;flex-direction:column;gap:8px}
.dgh-label{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a8a8a);letter-spacing:.02em}
.dgh-hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.dgh-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16));background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#111);font:inherit;padding:5px 11px;border-radius:var(--dsw-radius-sm,6px);cursor:pointer;white-space:nowrap}
.dgh-btn:hover{background:var(--dsw-alias-fill-l1,rgba(0,0,0,.05))}
.dgh-btn:disabled{opacity:.5;cursor:not-allowed}
.dgh-btn-primary{background:var(--dsw-alias-brand-primary,#4d6bfe);border-color:transparent;color:#fff;font-weight:600}
.dgh-btn-primary:hover{filter:brightness(1.08);background:var(--dsw-alias-brand-primary,#4d6bfe)}
.dgh-btn-danger{color:var(--dsw-alias-state-error-primary,#d5443b);border-color:var(--dsw-alias-state-error-primary,#d5443b)}
.dgh-btn-mini{padding:3px 8px;font-size:11.5px}
/* 只作用于「发现插件」页那个搜索按钮：半透明填充，不碰其它 primary 按钮。 */
button[data-role="search"]{background:rgba(77,107,254,.22);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 26%,transparent);border-color:transparent;color:var(--dsw-alias-brand-primary,#4d6bfe);font-weight:600}
button[data-role="search"]:hover{background:rgba(77,107,254,.32);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 34%,transparent);filter:none}
/* 只作用于搜索结果里那个「安装」按钮，其它 primary 按钮不受影响。 */
button[data-role="install"]{background:rgba(77,107,254,.22);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 26%,transparent);border-color:transparent;color:var(--dsw-alias-brand-primary,#4d6bfe);font-weight:600}
button[data-role="install"]:hover{background:rgba(77,107,254,.32);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 34%,transparent);filter:none}
/* 只作用于诊断页设置里那个「保存设置」按钮。 */
button[data-role="save"]{background:rgba(77,107,254,.22);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 26%,transparent);border-color:transparent;color:var(--dsw-alias-brand-primary,#4d6bfe);font-weight:600}
button[data-role="save"]:hover{background:rgba(77,107,254,.32);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 34%,transparent);filter:none}
.dgh-input,.dgh-select{font:inherit;padding:6px 9px;border-radius:var(--dsw-radius-sm,6px);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16));background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#111);min-width:0}
.dgh-input:focus,.dgh-select:focus{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:-1px}
.dgh-input-grow{flex:1}
.dgh-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));color:var(--dsw-alias-label-secondary,#555);background:var(--dsw-alias-bg-overlay,#fff)}
.dgh-badge-brand{color:var(--dsw-alias-brand-primary,#4d6bfe);border-color:currentColor}
.dgh-badge-ok{color:var(--dsw-alias-state-success-primary,#1a9c62);border-color:currentColor}
.dgh-badge-warn{color:var(--dsw-alias-state-warn-primary,#c98a12);border-color:currentColor}
.dgh-badge-err{color:var(--dsw-alias-state-error-primary,#d5443b);border-color:currentColor}
.dgh-chip{appearance:none;border:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.16));background:transparent;color:var(--dsw-alias-label-secondary,#555);font:inherit;font-size:11.5px;padding:2px 8px;border-radius:999px;cursor:pointer}
.dgh-chip:hover{color:var(--dsw-alias-brand-primary,#4d6bfe);border-color:currentColor}
/* 搜索历史：新增的一组类，只作用于历史那一行，不影响其它地方。 */
.dgh-hist-chip{display:inline-flex;align-items:center;gap:2px;border:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.16));border-radius:999px;padding:1px 4px 1px 8px;max-width:260px}
.dgh-hist-text{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#555);font:inherit;font-size:11.5px;padding:2px 0;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dgh-hist-text:hover{color:var(--dsw-alias-brand-primary,#4d6bfe)}
.dgh-hist-del{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#999);font:inherit;font-size:13px;line-height:1;padding:0 3px;cursor:pointer}
.dgh-hist-del:hover{color:var(--dsw-alias-state-error-primary,#d5443b)}
.dgh-hist-toggle{appearance:none;border:0;background:transparent;color:var(--dsw-alias-brand-primary,#4d6bfe);font:inherit;font-size:11.5px;padding:2px 4px;cursor:pointer}
.dgh-hist-toggle:hover{text-decoration:underline}
/* 快捷入口的悬停悬浮窗：只作用于带 .dgh-quick-wrap 的那几个标签。 */
.dgh-quick-wrap{position:relative;display:inline-flex}
.dgh-quick-pop{position:absolute;top:calc(100% + 6px);left:0;z-index:9;width:270px;padding:8px 10px;border-radius:var(--dsw-radius-sm,6px);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16));background:var(--dsw-alias-bg-overlay,#fff);box-shadow:0 6px 18px rgba(0,0,0,.16);color:var(--dsw-alias-label-primary,#111);font-size:11.5px;line-height:1.5;white-space:normal;text-align:left;pointer-events:none}
.dgh-quick-pop-q{display:block;margin-top:5px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary,#999);word-break:break-all}
.dgh-list{display:flex;flex-direction:column;gap:9px}
.dgh-item-title{font-weight:600;font-size:13.5px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dgh-link{color:var(--dsw-alias-brand-primary,#4d6bfe);text-decoration:none;word-break:break-all}
.dgh-link:hover{text-decoration:underline}
.dgh-desc{color:var(--dsw-alias-label-secondary,#555);font-size:12.5px;word-break:break-word}
.dgh-meta{display:flex;gap:10px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary,#8a8a8a);font-size:11.5px}
.dgh-pre{margin:0;padding:9px 10px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;white-space:pre-wrap;word-break:break-all;max-height:240px;overflow:auto;color:var(--dsw-alias-label-secondary,#555)}
.dgh-table{width:100%;border-collapse:collapse;font-size:12px}
.dgh-table th,.dgh-table td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));vertical-align:top}
.dgh-table th{color:var(--dsw-alias-label-tertiary,#8a8a8a);font-weight:500;font-size:11.5px}
.dgh-split{display:grid;grid-template-columns:minmax(150px,1fr) 2fr;gap:6px 12px}
.dgh-avatar{width:34px;height:34px;border-radius:50%;background:var(--dsw-alias-fill-l1,rgba(0,0,0,.06));object-fit:cover;flex:none}
.dgh-notice{border-radius:var(--dsw-radius-sm,6px);padding:8px 10px;font-size:12.5px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));background:var(--dsw-alias-bg-overlay,#fff)}
.dgh-notice-ok{border-color:var(--dsw-alias-state-success-primary,#1a9c62);color:var(--dsw-alias-state-success-primary,#1a9c62)}
.dgh-notice-warn{border-color:var(--dsw-alias-state-warn-primary,#c98a12);color:var(--dsw-alias-state-warn-primary,#c98a12)}
.dgh-notice-err{border-color:var(--dsw-alias-state-error-primary,#d5443b);color:var(--dsw-alias-state-error-primary,#d5443b)}
.dgh-empty{color:var(--dsw-alias-label-tertiary,#8a8a8a);font-size:12.5px;padding:14px 2px}
.dgh-switch{display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary,#555)}
.dgh-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16));border-radius:999px;overflow:hidden}
.dgh-seg button{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#555);font:inherit;font-size:12px;padding:4px 12px;cursor:pointer}
.dgh-seg button[data-active="true"]{background:rgba(77,107,254,.22);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 26%,transparent);color:var(--dsw-alias-brand-primary,#4d6bfe);font-weight:600}
.dgh-check{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--dsw-alias-label-secondary,#555);cursor:pointer;user-select:none}
.dgh-check input{accent-color:var(--dsw-alias-brand-primary,#4d6bfe);margin:0}
.dgh-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.dgh-steps{counter-reset:dghstep;font-size:12.5px;color:var(--dsw-alias-label-secondary,#555);padding-left:18px;margin:4px 0}
.dgh-steps li{margin:2px 0}
`;

    const CSS_ID = "dsh-github-hub/panel.css";
    function injectCss() {
      if (typeof document === "undefined") return;
      if (document.querySelector('style[data-plugin-css="' + CSS_ID + '"]') !== null) return;
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-github-hub";
      tag.dataset.pluginCss = CSS_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /* ================================================================== *
     * 字典
     * ================================================================== */

    const zh = {
      panel: "GitHub 插件中心",
      tabDiscover: "发现插件",
      tabInstalled: "已安装",
      tabAccount: "账号登录",
      tabDiagnostics: "诊断",
      refresh: "刷新",
      loggedInAs: "已登录",
      notLoggedIn: "未登录",
      source: "来源",
      search: "搜索",
      searchPlaceholder: "关键词，例如 topic:dsh-plugin / dsh-plugin / deepseek-harness",
      sort: "排序",
      sortBest: "最佳匹配",
      sortStars: "星标最多",
      sortUpdated: "最近更新",
      onlyPlugins: "只看插件候选",
      onlyPluginsHint: "按仓库 topic 与名字/描述判定，隐藏蹭 dsh-plugin 标签的仓库",
      allFiltered: "本页结果都被判定为「非插件候选」。取消勾选「只看插件候选」可以看全部。",
      filteredOut: "已隐藏非候选：",
      results: "结果",
      noResults: "没有结果，换个关键词试试。",
      searchHistory: "历史搜索",
      historyHint: "搜过的关键词会留在这里",
      historyExpand: "展开全部",
      historyCollapse: "收起",
      historyClear: "清空",
      historyRemove: "从历史里删除",
      filledHint: "已自动补页",
      quickTopicDsh: "按仓库的 topic 标签找：只要打了 dsh-plugin 标签就算，口径最宽，也会混进只想蹭标签的仓库。",
      quickTopicHarness: "按 topic 标签找 deepseek-harness，通常更贴近 DSH 生态本身的项目。",
      quickNameDesc: "不看标签，改在仓库名、描述、README 正文里找 dsh-plugin，能捞到没打标签但正文提到的插件。",
      quickAwesome: "普通关键词搜索，专找 awesome / 汇总清单类仓库，这类仓库常常一次列出很多插件。",
      quickNpmKeywords: "在 npm 上按包的 keywords 字段找 dsh-plugin 包。",
      quickNpmPlain: "在 npm 上做普通关键词搜索，包名或描述里含 dsh 和 plugin。",
      inspect: "检查",
      installing: "安装",
      copySpec: "复制标识",
      copied: "已复制",
      open: "打开",
      isPlugin: "DSH 插件",
      mayNotBePlugin: "未确认是插件",
      verdict: "判定",
      installTitle: "安装",
      installLog: "安装日志",
      installRunning: "正在安装…",
      installDone: "安装结束",
      installApplied: "已生效",
      installRestart: "需要重启桌面端才会加载新插件",
      approveBuilds: "允许这些构建脚本并重试",
      close: "关闭",
      cancel: "取消安装",
      alreadyInstalled: "这个包已经装过了",
      alreadyInstalledHint: "重复安装同一个 spec 时，pnpm 跑完依赖没有变化，插件管理器会回 ambiguous-install。仓库有新提交时再次安装才会真正更新；只想确认状态的话去「已安装」页。",
      errAmbiguous: "插件管理器没法从 spec 判断装的是哪个包：pnpm 跑完后依赖没有任何变化（通常是这个包已经装过、且版本没变）。请到「已安装」页确认；确实要重装的话，让仓库产生新提交后再装，或改用 npm 包名安装。",
      errNotBundle: "这个包没有 dsh.bundle.patch，不是可安装的 DSH 插件包。",
      errIncompatible: "这个包声明的 DSH 版本与当前运行时不兼容，需要版本豁免（风险自负）。",
      errBuildBlocked: "pnpm 拦截了该包的生命周期脚本。确认仓库可信后，点下面的「允许构建并重试」。",
      errNotFound: "找不到这个包（404 / 没有匹配版本）。检查名字、是否私有、是否需要登录。",
      errNetwork: "网络或证书问题导致拉取失败。看下面日志的最后几行；「诊断」页可以确认 GitHub / npm 连通性。",
      errPnpmMissing: "找不到 pnpm。桌面端由宿主的包管理器执行安装，通常不会走到这里。",
      errTimeout: "安装超时（大仓库或网络慢）。重试一次通常就好。",
      errPermission: "文件权限不足，无法写入 profile 的 node_modules。",
      errIntegrity: "包完整性校验失败。清掉 profile 的 pnpm store 后重试。",
      errDiskFull: "磁盘空间不足。",
      errManagement: "这个插件只能通过插件管理器操作（不能在 profile 文件里直接改）。",
      errRestart: "需要重启 DSH 才能生效。",
      pendingBuilds: "pnpm 阻止了以下依赖的安装脚本",
      bundleList: "当前 profile 的插件包",
      entries: "插件条目",
      enabled: "启用",
      disable: "停用",
      enable: "启用",
      remove: "卸载",
      noBundles: "还没有安装任何外部插件包。",
      profile: "Profile",
      account: "账号",
      loginWithToken: "用 Personal Access Token 登录",
      tokenPlaceholder: "粘贴 GitHub token（ghp_… / github_pat_…）",
      login: "验证并登录",
      logout: "退出登录",
      tokenHint: "令牌只保存在本机 DSH 凭据服务里，页面永远不会看到它。",
      tokenCreate: "在 GitHub 上创建令牌",
      deviceTitle: "用 OAuth Device Flow 登录",
      deviceClientId: "OAuth App client_id",
      deviceScope: "授权范围（scope）",
      deviceStart: "开始设备登录",
      deviceCode: "在浏览器里输入下面的代码",
      deviceOpen: "打开授权页面",
      deviceWaiting: "等待授权…",
      deviceDone: "授权成功",
      deviceFailed: "授权失败",
      history: "登录记录",
      historyEmpty: "还没有登录记录。",
      clearHistory: "清空记录",
      time: "时间",
      method: "方式",
      action: "事件",
      scopes: "权限",
      notes: "诊断结论",
      diagnostics: "连通性诊断",
      settings: "设置",
      trustLocal: "信任本机拦截器（对回环地址跳过证书校验）",
      npmRegistry: "npm 搜索源",
      save: "保存设置",
      saved: "已保存",
      methodPat: "令牌登录",
      methodDevice: "设备码登录",
      actionLogin: "登录",
      actionLogout: "退出",
      requiredBundle: "缺少 dsh.bundle.patch，装进来不会出现在插件列表",
      installable: "可以安装",
      notInstallable: "不是可安装的 DSH 插件包",
      specLabel: "安装标识",
      registryLabel: "registry",
      version: "版本",
      privatePkg: "私有包",
      loading: "读取中…",
    };

    const en = {
      panel: "GitHub Plugin Hub",
      tabDiscover: "Discover",
      tabInstalled: "Installed",
      tabAccount: "Account",
      tabDiagnostics: "Diagnostics",
      refresh: "Refresh",
      loggedInAs: "Signed in",
      notLoggedIn: "Signed out",
      source: "Source",
      search: "Search",
      searchPlaceholder: "e.g. topic:dsh-plugin / dsh-plugin / deepseek-harness",
      sort: "Sort",
      sortBest: "Best match",
      sortStars: "Most stars",
      sortUpdated: "Recently updated",
      onlyPlugins: "Plugin candidates only",
      onlyPluginsHint: "Judged from repository topics plus name/description; hides repositories merely carrying the dsh-plugin topic",
      allFiltered: "Every result on this page was judged a non-candidate. Clear \"Plugin candidates only\" to see them all.",
      filteredOut: "Hidden non-candidates:",
      results: "Results",
      noResults: "No results — try another query.",
      searchHistory: "Search history",
      historyHint: "Queries you run show up here",
      historyExpand: "Show all",
      historyCollapse: "Collapse",
      historyClear: "Clear",
      historyRemove: "Remove from history",
      filledHint: "Auto-filled",
      quickTopicDsh: "Topic tag search: any repository carrying the dsh-plugin topic. Widest net, so topic-spam repositories show up too.",
      quickTopicHarness: "Topic tag search for deepseek-harness — usually closer to the DSH ecosystem itself.",
      quickNameDesc: "Full-text search over repository name, description and README instead of topics, so untagged plugins can still be found.",
      quickAwesome: "Plain keyword search aimed at awesome-list style repositories, which often list many plugins at once.",
      quickNpmKeywords: "Search npm packages by their keywords field for dsh-plugin.",
      quickNpmPlain: "Plain keyword search on npm for packages whose name or description mentions dsh and plugin.",
      inspect: "Inspect",
      installing: "Install",
      copySpec: "Copy spec",
      copied: "Copied",
      open: "Open",
      isPlugin: "DSH plugin",
      mayNotBePlugin: "Unconfirmed",
      verdict: "Verdict",
      installTitle: "Install",
      installLog: "Install log",
      installRunning: "Installing…",
      installDone: "Install finished",
      installApplied: "Applied",
      installRestart: "Restart the desktop app to load the new plugin",
      approveBuilds: "Allow these build scripts and retry",
      close: "Close",
      cancel: "Cancel install",
      alreadyInstalled: "This package is already installed",
      alreadyInstalledHint: "Re-installing an identical spec changes no dependency, so the plugin manager answers ambiguous-install. Install again once the repository has new commits; use the Installed tab to check status.",
      errAmbiguous: "The manager cannot tell which package this spec installed: after pnpm ran, no dependency changed — usually because the package is already installed at the same version. Check the Installed tab; to really re-install, push new commits and try again, or install by npm package name.",
      errNotBundle: "This package has no dsh.bundle.patch, so it is not an installable DSH plugin bundle.",
      errIncompatible: "This package declares a DSH version incompatible with the running runtime; it needs a version exemption (at your own risk).",
      errBuildBlocked: "pnpm withheld this package's lifecycle scripts. Once you trust the repository, use \"Allow the build scripts and retry\" below.",
      errNotFound: "Package not found (404 / no matching version). Check the name, whether it is private, and whether you need to sign in.",
      errNetwork: "A network or certificate problem blocked the fetch. Read the last log lines below; the Diagnostics tab reports GitHub / npm reachability.",
      errPnpmMissing: "pnpm was not found. The desktop app installs through the host's own package manager, so this should not happen there.",
      errTimeout: "The install timed out (large repository or slow network). Retrying usually works.",
      errPermission: "Insufficient file permissions to write the profile's node_modules.",
      errIntegrity: "Package integrity check failed. Clear the profile's pnpm store and retry.",
      errDiskFull: "Not enough disk space.",
      errManagement: "This plugin can only be changed through the plugin manager, not by editing profile files.",
      errRestart: "DSH must restart before this takes effect.",
      pendingBuilds: "pnpm blocked install scripts for",
      bundleList: "Bundles in this profile",
      entries: "Plugin entries",
      enabled: "enabled",
      disable: "Disable",
      enable: "Enable",
      remove: "Remove",
      noBundles: "No external plugin bundles installed yet.",
      profile: "Profile",
      account: "Account",
      loginWithToken: "Sign in with a Personal Access Token",
      tokenPlaceholder: "Paste a GitHub token (ghp_… / github_pat_…)",
      login: "Verify and sign in",
      logout: "Sign out",
      tokenHint: "The token is stored in the local DSH credential service; the page never sees it.",
      tokenCreate: "Create a token on GitHub",
      deviceTitle: "Sign in with OAuth Device Flow",
      deviceClientId: "OAuth App client_id",
      deviceScope: "Scope",
      deviceStart: "Start device sign-in",
      deviceCode: "Enter this code in the browser",
      deviceOpen: "Open the authorization page",
      deviceWaiting: "Waiting for authorization…",
      deviceDone: "Authorized",
      deviceFailed: "Authorization failed",
      history: "Sign-in history",
      historyEmpty: "No sign-in records yet.",
      clearHistory: "Clear records",
      time: "Time",
      method: "Method",
      action: "Event",
      scopes: "Scopes",
      notes: "Findings",
      diagnostics: "Connectivity diagnostics",
      settings: "Settings",
      trustLocal: "Trust the local interceptor (skip certificate checks for loopback)",
      npmRegistry: "npm search registry",
      save: "Save settings",
      saved: "Saved",
      methodPat: "Token",
      methodDevice: "Device flow",
      actionLogin: "sign in",
      actionLogout: "sign out",
      requiredBundle: "Missing dsh.bundle.patch — it would not appear in the plugin list",
      installable: "Installable",
      notInstallable: "Not an installable DSH plugin package",
      specLabel: "Install spec",
      registryLabel: "registry",
      version: "Version",
      privatePkg: "Private",
      loading: "Loading…",
    };

    /* ================================================================== *
     * 小工具
     * ================================================================== */

    async function api(pathname, options) {
      const init = { cache: "no-store", ...(options || {}) };
      if (init.body !== undefined && typeof init.body !== "string") {
        init.body = JSON.stringify(init.body);
        init.headers = { "Content-Type": "application/json", ...(init.headers || {}) };
      }
      const res = await fetch(API + pathname, init);
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (err) { data = null; }
      if (!res.ok && !data) throw new Error("HTTP " + res.status);
      if (data === null) throw new Error("响应不是 JSON（HTTP " + res.status + "）");
      return data;
    }

    function post(pathname, body) {
      return api(pathname, { method: "POST", body: body || {} });
    }

    function fmtTime(value) {
      if (!value) return "—";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      const pad = (n) => String(n).padStart(2, "0");
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    function fmtRelative(value) {
      if (!value) return "—";
      const then = new Date(value).getTime();
      if (Number.isNaN(then)) return String(value);
      const diff = Date.now() - then;
      const day = 86400000;
      if (diff < 3600000) return Math.max(1, Math.round(diff / 60000)) + "m";
      if (diff < day) return Math.round(diff / 3600000) + "h";
      if (diff < day * 30) return Math.round(diff / day) + "d";
      if (diff < day * 365) return Math.round(diff / (day * 30)) + "mo";
      return Math.round(diff / (day * 365)) + "y";
    }

    function copyText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text); return; }
      } catch (err) { /* 回落到 execCommand */ }
      try {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        document.body.removeChild(area);
      } catch (err) { /* 复制失败就算了 */ }
    }

    /* ================================================================== *
     * 通用组件
     * ================================================================== */

    function Button({ variant, size, ...rest }) {
      const cls = "dgh-btn" + (variant ? " dgh-btn-" + variant : "") + (size === "mini" ? " dgh-btn-mini" : "");
      return h("button", { type: "button", ...rest, className: cls });
    }

    function Badge({ tone, children }) {
      return h("span", { className: "dgh-badge" + (tone ? " dgh-badge-" + tone : "") }, children);
    }

    function Notice({ tone, children }) {
      return h("div", { className: "dgh-notice" + (tone ? " dgh-notice-" + tone : "") }, children);
    }

    function CopyButton({ value, label, copiedLabel }) {
      const [done, setDone] = react.useState(false);
      return Button({
        size: "mini",
        onClick: () => { copyText(value); setDone(true); window.setTimeout(() => setDone(false), 1400); },
        children: done ? copiedLabel : label,
      });
    }

    /** Sidebar 面板图标：git 分支形状。 */
    function GithubHubIcon({ size }) {
      const s = size || 18;
      return h("svg", { width: s, height: s, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
        h("path", { d: "M4.6 3.1v9.8", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" }),
        h("circle", { cx: "4.6", cy: "2.4", r: "1.5", stroke: "currentColor", strokeWidth: 1.4 }),
        h("circle", { cx: "4.6", cy: "13.6", r: "1.5", stroke: "currentColor", strokeWidth: 1.4 }),
        h("circle", { cx: "11.4", cy: "6.2", r: "1.5", stroke: "currentColor", strokeWidth: 1.4 }),
        h("path", { d: "M11.4 7.8v.7a2.5 2.5 0 0 1-2.5 2.5H4.6", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" }),
      );
    }

    /* ================================================================== *
     * 安装面板：自己拥有轮询与日志状态，避免污染主页面
     * ================================================================== */

    function InstallPanel({ t, spec, requestId, onClose, onFinished, precheck }) {
      const [phase, setPhase] = react.useState("installing");
      const [logs, setLogs] = react.useState([]);
      const [result, setResult] = react.useState(null);
      const [error, setError] = react.useState("");
      const [busy, setBusy] = react.useState(false);
      const [stalled, setStalled] = react.useState("");
      const sinceRef = react.useRef(0);
      const doneRef = react.useRef(false);
      const boxRef = react.useRef(null);
      const startedRef = react.useRef(false);
      const missRef = react.useRef(0);

      // 面板一挂载就真正开始安装：宿主要收到 POST /install 才会建立进度 feed，
      // 否则轮询只会一直回 unknown requestId，界面就一直停在「读取中…」。
      react.useEffect(() => {
        if (startedRef.current) return;
        startedRef.current = true;
        post("/install", { spec, requestId }).then((res) => {
          if (res && res.result) {
            doneRef.current = true;
            setResult(res.result);
            setPhase("done");
            if (onFinished) onFinished(res.result);
          } else if (res && res.error) {
            setError(String(res.error));
          }
        }).catch((err) => {
          setError("安装没能开始：" + String((err && err.message) || err));
        });
      }, []);

      react.useEffect(() => {
        let cancelled = false;
        const timer = window.setInterval(async () => {
          if (doneRef.current) return;
          try {
            const progress = await api(`/install/progress?requestId=${encodeURIComponent(requestId)}&since=${sinceRef.current}`);
            if (cancelled) return;
            // 宿主说没有这个 requestId 的进度记录：连续几次都这样就不是慢，而是安装真的没起来。
            if (progress && progress.ok === false) {
              missRef.current += 1;
              if (missRef.current >= 5 && !doneRef.current) {
                setStalled(`宿主没有这次安装任务的进度记录（${String(progress.error || "")}）——安装可能没有真正开始，可以取消后重试。`);
              }
              return;
            }
            missRef.current = 0;
            if (!progress) return;
            sinceRef.current = progress.next || 0;
            if (progress.logs && progress.logs.length) {
              setLogs((current) => [...current, ...progress.logs.map((row) => row.text)].slice(-400));
            }
            if (progress.phase) setPhase(progress.phase);
            if (progress.done) {
              doneRef.current = true;
              setResult(progress.result || null);
              setPhase("done");
              window.clearInterval(timer);
              if (onFinished) onFinished(progress.result || null);
            }
          } catch (err) { /* 轮询失败不打断安装 */ }
        }, 1200);
        return () => { cancelled = true; window.clearInterval(timer); };
      }, [requestId]);

      react.useEffect(() => {
        const box = boxRef.current;
        if (box) box.scrollTop = box.scrollHeight;
      }, [logs.length]);

      const finished = result !== null || error !== "";
      const cancel = async () => {
        setBusy(true);
        try {
          const res = await post("/install/cancel", { requestId });
          setError(res.ok ? "已请求取消安装（" + String((res.cancellation && res.cancellation.status) || "") + "）" : String(res.error || "取消失败"));
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally { setBusy(false); }
      };
      const retryBuilds = async () => {
        const pending = result && result.pendingBuilds;
        if (!pending || !pending.length) return;
        setBusy(true);
        setError("");
        try {
          const res = await post("/install", { spec, requestId: requestId + "-retry", approvedBuilds: pending });
          if (res.result) { setResult(res.result); setPhase("done"); }
          else if (res.error) setError(res.error);
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setBusy(false);
        }
      };

      const summary = [];
      if (result) {
        summary.push(h("div", { key: "app", className: "dgh-row dgh-row-wrap" },
          Badge({ tone: result.error ? "err" : "ok", children: `application: ${String(result.application || "?")}` }),
          result.stage ? Badge({ children: `stage: ${result.stage}` }) : null,
          result.bundle ? Badge({ tone: "brand", children: result.bundle }) : null,
          result.application === "restart-required" ? Badge({ tone: "warn", children: t("installRestart") }) : null,
        ));
        if (result.error) {
          // 插件管理器的错误码是可枚举的；把它翻译成人话，并把原始 diagnostic 留在后面。
          const code = String(result.error.code || "error");
          const key = ERROR_KEYS[code];
          const hint = key ? t(key) : "";
          const detail = String(result.error.diagnostic || result.error.message || result.error.reason || "").slice(0, 600);
          summary.push(Notice({ key: "err", tone: "err", children: `${code}：${hint || detail}${hint && detail ? "\n" + detail : ""}` }));
        }
        if (result.warnings && result.warnings.length) {
          summary.push(Notice({ key: "warn", tone: "warn", children: result.warnings.join(" / ") }));
        }
        if (result.pendingBuilds && result.pendingBuilds.length) {
          summary.push(h("div", { key: "pending", className: "dgh-col" },
            Notice({ tone: "warn", children: `${t("pendingBuilds")}：${result.pendingBuilds.join(", ")}` }),
            h("div", { className: "dgh-row" }, Button({ variant: "primary", size: "mini", disabled: busy, onClick: retryBuilds, children: t("approveBuilds") })),
          ));
        }
      }

      return h("div", { className: "dgh-card dgh-col" },
        h("div", { className: "dgh-row" },
          h("strong", null, t("installTitle")),
          h("span", { className: "dgh-mono dgh-hint" }, spec),
          h("span", { className: "dgh-spacer" }),
          Badge({ tone: finished ? (result && result.error ? "err" : "ok") : "warn", children: finished ? t("installDone") : t("installRunning") }),
          finished ? null : Button({ size: "mini", disabled: busy, onClick: cancel, children: t("cancel") }),
          Button({ size: "mini", onClick: onClose, children: t("close") }),
        ),
        summary,
        precheck && precheck.alreadyInstalled
          ? Notice({ tone: "warn", children: `${t("alreadyInstalled")}：${precheck.name}${precheck.version ? " v" + precheck.version : ""}。${t("alreadyInstalledHint")}` })
          : null,
        error ? Notice({ tone: "err", children: error }) : null,
        stalled && !error ? Notice({ tone: "warn", children: stalled }) : null,
        h("div", { className: "dgh-label" }, t("installLog")),
        h("pre", { className: "dgh-pre", ref: boxRef }, logs.length ? logs.join("\n") : t("loading")),
      );
    }

    /* ================================================================== *
     * 发现页
     * ================================================================== */

    const QUICK_QUERIES = [
      { label: "topic:dsh-plugin", source: "github", q: "topic:dsh-plugin", descKey: "quickTopicDsh" },
      { label: "topic:deepseek-harness", source: "github", q: "topic:deepseek-harness", descKey: "quickTopicHarness" },
      { label: "dsh-plugin (name/desc/readme)", source: "github", q: "dsh-plugin in:name,description,readme", descKey: "quickNameDesc" },
      { label: "awesome deepseek harness", source: "github", q: "awesome deepseek harness plugins", descKey: "quickAwesome" },
      { label: "npm: keywords:dsh-plugin", source: "npm", q: "keywords:dsh-plugin", descKey: "quickNpmKeywords" },
      { label: "npm: dsh plugin", source: "npm", q: "dsh plugin", descKey: "quickNpmPlain" },
    ];

    function ResultCard({ t, item, onInstall, onInspect, inspection, inspecting }) {
      const badges = [];
      if (item.isPlugin) badges.push(Badge({ key: "p", tone: "brand", children: t("isPlugin") }));
      else badges.push(Badge({ key: "p", children: t("mayNotBePlugin") }));
      if (item.kind === "package") badges.push(Badge({ key: "k", children: "npm" }));
      if (item.version) badges.push(Badge({ key: "v", children: `v${item.version}` }));
      if (item.archived) badges.push(Badge({ key: "a", tone: "warn", children: "archived" }));

      const info = inspection && inspection.info;
      return h("div", { className: "dgh-card dgh-col" },
        h("div", { className: "dgh-item-title" },
          h("a", { className: "dgh-link", href: item.url || item.npmUrl || "#", target: "_blank", rel: "noreferrer noopener" }, item.fullName || item.name),
          badges,
        ),
        item.description ? h("div", { className: "dgh-desc" }, item.description) : null,
        h("div", { className: "dgh-meta" },
          item.kind === "repo" ? h("span", null, `★ ${item.stars}`) : null,
          item.publisher ? h("span", null, `by ${item.publisher}`) : null,
          item.updatedAt ? h("span", null, `updated ${fmtRelative(item.updatedAt)}`) : null,
          item.topics && item.topics.length ? h("span", null, item.topics.slice(0, 6).join(" · ")) : null,
        ),
        h("div", { className: "dgh-row dgh-row-wrap" },
          Button({ variant: "primary", size: "mini", "data-role": "install", onClick: () => onInstall(item), children: t("installing") }),
          item.kind === "repo" ? Button({ size: "mini", disabled: inspecting, onClick: () => onInspect(item), children: inspecting ? t("loading") : t("inspect") }) : null,
          CopyButton({ value: item.installSpec, label: t("copySpec"), copiedLabel: t("copied") }),
          h("span", { className: "dgh-hint dgh-mono" }, item.installSpec),
        ),
        inspection ? (
          inspection.ok === false
            ? Notice({ tone: "err", children: inspection.error || "检查失败" })
            : h("div", { className: "dgh-col" },
              h("div", { className: "dgh-row dgh-row-wrap" },
                info.installable ? Badge({ tone: "ok", children: t("installable") }) : Badge({ tone: "warn", children: t("notInstallable") }),
                info.hasClient ? Badge({ children: "dsh.client" }) : null,
                info.private ? Badge({ tone: "warn", children: t("privatePkg") }) : null,
              ),
              h("div", { className: "dgh-split" },
                h("div", { className: "dgh-label" }, t("verdict")), h("div", null, info.verdict),
                h("div", { className: "dgh-label" }, "package.json"), h("div", { className: "dgh-mono" }, `${info.name || "?"}${info.version ? "@" + info.version : ""}`),
                info.bundlePatch ? h("div", { className: "dgh-label" }, "bundle patch") : null,
                info.bundlePatch ? h("div", { className: "dgh-mono" }, info.bundlePatch) : null,
                info.description ? h("div", { className: "dgh-label" }, "description") : null,
                info.description ? h("div", null, info.description) : null,
              ),
              h("div", { className: "dgh-hint" }, "安装标识（git spec）：" + item.installSpec),
            )
        ) : null,
      );
    }

    /* ---------------- 搜索历史（新增：只存浏览器本地，最多 24 条） ---------------- */

    const SEARCH_HISTORY_KEY = "dgh-search-history";
    const SEARCH_HISTORY_MAX = 24;
    const SEARCH_HISTORY_VISIBLE = 8;
    const SEARCH_PAGE_SIZE = 12;   // 宿主每页返回的条数
    const FILL_TARGET = 8;         // 「只看插件候选」下想让一页至少凑够几条候选
    const FILL_MAX_PAGES = 3;      // 一次最多连抓几页（防止把搜索配额吃光）
    let searchHistoryFallback = [];

    /** 去重（大小写不敏感）、去掉空白、截到上限。 */
    function cleanSearchHistory(list) {
      const seen = new Set();
      const out = [];
      for (const item of Array.isArray(list) ? list : []) {
        const text = typeof item === "string" ? item.trim() : "";
        if (!text) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(text);
        if (out.length >= SEARCH_HISTORY_MAX) break;
      }
      return out;
    }
    function readSearchHistory() {
      try {
        const raw = window.localStorage.getItem(SEARCH_HISTORY_KEY);
        if (raw !== null) return cleanSearchHistory(JSON.parse(raw));
      } catch (err) { /* 本地存储不可用：退化成内存副本 */ }
      return searchHistoryFallback.slice();
    }
    function writeSearchHistory(list) {
      const next = cleanSearchHistory(list);
      searchHistoryFallback = next;
      try { window.localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(next)); } catch (err) { /* 只在本次会话里记着 */ }
      return next;
    }
    /** 记录一次搜索：最新在前。 */
    function rememberSearchHistory(query) {
      const text = String(query || "").trim();
      if (!text) return readSearchHistory();
      return writeSearchHistory([text, ...readSearchHistory()]);
    }
    function forgetSearchHistory(query) {
      return writeSearchHistory(readSearchHistory().filter((item) => item !== query));
    }
    function clearSearchHistory() {
      return writeSearchHistory([]);
    }

    /** 只负责拉一页原始搜索结果；失败抛错，怎么显示交给调用方。 */
    async function fetchSearchPage(source, query, sort, rawPage) {
      const params = new URLSearchParams({ source, q: query, page: String(rawPage || 1), sort: sort || "stars" });
      const data = await api("/search?" + params.toString());
      if (!data.ok) throw new Error(String(data.error || "搜索失败"));
      return { items: data.items || [], total: Number(data.total || 0), tls: String(data.tls || "") };
    }

    /**
     * pnpm 会把 `github:owner/repo` 交给 ssh（git+ssh://git@github.com/…）。
     * 本机 SSH 到 github.com:22 是 Connection refused，pnpm 会失败重试很久，
     * 界面看起来就是一直「正在安装…」。统一改写成 HTTPS 形式再交给宿主。
     */
    function toHttpsInstallSpec(spec) {
      const text = String(spec || "").trim();
      const shorthand = text.match(/^github:([^\s/]+\/[^\s#]+?)(?:#(\S+))?$/i);
      if (shorthand) {
        const repo = shorthand[1].replace(/\.git$/i, "");
        return `git+https://github.com/${repo}.git${shorthand[2] ? `#${shorthand[2]}` : ""}`;
      }
      const ssh = text.match(/^git\+ssh:\/\/git@github\.com\/(\S+)$/i);
      if (ssh) return `git+https://github.com/${ssh[1]}`;
      return text;
    }

    function DiscoverTab({ t, authenticated }) {
      const [source, setSource] = react.useState("github");
      const [query, setQuery] = react.useState("topic:dsh-plugin");
      const [sort, setSort] = react.useState("stars");
      const [onlyPlugins, setOnlyPlugins] = react.useState(true);
      const [page, setPage] = react.useState(1);
      const [state, setState] = react.useState({ loading: false, error: "", items: [], total: 0, tls: "" });
      const [inspections, setInspections] = react.useState({});
      const [inspectingId, setInspectingId] = react.useState("");
      const [session, setSession] = react.useState(null);
      const [installedTick, setInstalledTick] = react.useState(0);
      const [searchHistory, setSearchHistory] = react.useState(() => readSearchHistory());
      const [historyOpen, setHistoryOpen] = react.useState(false);
      // 每个「来源|关键词|排序」记下已经用到第几页原始页，翻页时接着往后抓。
      const fillRef = react.useRef({ key: "", pages: {} });
      const [hoverQuick, setHoverQuick] = react.useState(null);

      const run = react.useCallback(async (nextSource, nextQuery, nextSort, nextPage) => {
        setSearchHistory(rememberSearchHistory(nextQuery));
        setState((cur) => ({ ...cur, loading: true, error: "" }));
        try {
          // 「只看插件候选」会挡掉蹭 dsh-plugin 标签的高星仓库，一页可能只剩两三条；
          // 这时自动继续抓下一页，直到候选够数（或到页数上限）。
          const fill = nextSource === "github" && onlyPlugins;
          const store = fillRef.current;
          const key = `${nextSource}|${nextQuery}|${nextSort}`;
          if (store.key !== key) { store.key = key; store.pages = {}; }
          const logical = Math.max(1, Number(nextPage) || 1);
          const previousStop = store.pages[logical - 1];
          let rawPage = logical <= 1 ? 1 : (previousStop !== undefined ? previousStop + 1 : logical);
          const items = [];
          let total = 0;
          let tls = "";
          let fetchedPages = 0;
          const maxPages = fill ? FILL_MAX_PAGES : 1;
          for (let attempt = 0; attempt < maxPages; attempt += 1) {
            const chunk = await fetchSearchPage(nextSource, nextQuery, nextSort, rawPage);
            items.push(...chunk.items);
            total = chunk.total;
            tls = chunk.tls;
            fetchedPages += 1;
            if (!fill) break;
            if (items.filter((item) => item.isPlugin).length >= FILL_TARGET) break;
            if (chunk.items.length === 0) break;
            if (rawPage * SEARCH_PAGE_SIZE >= total) break;
            rawPage += 1;
          }
          store.pages[logical] = rawPage;
          const seen = new Set();
          const merged = items.filter((item) => {
            if (seen.has(item.id)) return false;
            seen.add(item.id);
            return true;
          });
          setState({ loading: false, error: "", items: merged, total, tls, pages: fetchedPages });
        } catch (err) {
          setState({ loading: false, error: String((err && err.message) || err), items: [], total: 0, tls: "" });
        }
      }, [onlyPlugins]);

      react.useEffect(() => { run(source, query, sort, page); }, []);

      const startInstall = (item) => {
        const requestId = "gh-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        // github:owner/repo 会被 pnpm 走 ssh（本机会一直失败重试），改成 HTTPS 再安装。
        const spec = toHttpsInstallSpec(item.installSpec);
        setSession({ requestId, spec, item, precheck: null });
        // 安装前先问一次宿主：这个 spec 到底指向哪个包、是不是已经装过了。
        // （插件管理器对「装完依赖没变化」的重复安装会回 ambiguous-install，提前讲清楚比事后报错好。）
        Promise.all([
          post("/inspect", { spec: item.installSpec }).catch(() => null),
          api("/bundles").catch(() => null),
        ]).then(([inspected, bundles]) => {
          const inspection = inspected && inspected.inspection;
          const name = inspection && inspection.status === "accepted" ? inspection.name : "";
          const installed = name && bundles && Array.isArray(bundles.bundles)
            ? bundles.bundles.find((bundle) => bundle.name === name && bundle.installed)
            : null;
          setSession((current) => (current && current.requestId === requestId
            ? { ...current, precheck: { name: name || item.name, version: (inspection && inspection.version) || "", alreadyInstalled: !!installed } }
            : current));
        });
      };

      const doInspect = async (item) => {
        setInspectingId(item.id);
        try {
          const data = await post("/repo/package", { repo: item.fullName, ref: item.defaultBranch });
          setInspections((cur) => ({ ...cur, [item.id]: data }));
        } catch (err) {
          setInspections((cur) => ({ ...cur, [item.id]: { ok: false, error: String((err && err.message) || err) } }));
        } finally {
          setInspectingId("");
        }
      };

      // GitHub 上有大量把 dsh-plugin 当流量标签的高星仓库，默认把它们挡掉，只留插件候选。
      const hidePlain = source === "github" && onlyPlugins;
      const visible = hidePlain ? state.items.filter((item) => item.isPlugin) : state.items;
      const hidden = state.items.length - visible.length;
      const history = Array.isArray(searchHistory) ? searchHistory : [];
      const shownHistory = historyOpen ? history : history.slice(0, SEARCH_HISTORY_VISIBLE);

      return h("div", { className: "dgh-col" },
        session ? h(InstallPanel, {
          t, spec: session.spec, requestId: session.requestId, precheck: session.precheck,
          onClose: () => setSession(null),
          onFinished: () => setInstalledTick(installedTick + 1),
        }) : null,
        h("div", { className: "dgh-card dgh-col" },
          h("div", { className: "dgh-row dgh-row-wrap" },
            h("span", { className: "dgh-label" }, t("source")),
            h("div", { className: "dgh-seg" },
              h("button", { type: "button", "data-active": source === "github", onClick: () => { const next = "topic:dsh-plugin"; setSource("github"); setQuery(next); setPage(1); run("github", next, sort, 1); }, children: "GitHub" }),
              h("button", { type: "button", "data-active": source === "npm", onClick: () => { const next = "keywords:dsh-plugin"; setSource("npm"); setQuery(next); setPage(1); run("npm", next, sort, 1); }, children: "npm" }),
            ),
            source === "github" ? h("select", {
              className: "dgh-select", value: sort,
              // 选完排序立刻用新排序重搜一次，不用再点「搜索」。
              onChange: (event) => { const next = event.target.value; setSort(next); setPage(1); run(source, query, next, 1); },
            },
              h("option", { value: "updated" }, t("sortUpdated")),
              h("option", { value: "stars" }, t("sortStars")),
              h("option", { value: "best-match" }, t("sortBest")),
            ) : null,
            source === "github" ? h("label", { className: "dgh-check", title: t("onlyPluginsHint") },
              h("input", {
                type: "checkbox", checked: onlyPlugins,
                onChange: (event) => setOnlyPlugins(event.target.checked),
              }),
              t("onlyPlugins"),
            ) : null,
            h("span", { className: "dgh-spacer" }),
            authenticated ? null : h("span", { className: "dgh-hint" }, "未登录时 GitHub 搜索配额较低"),
          ),
          h("div", { className: "dgh-row" },
            h("input", {
              className: "dgh-input dgh-input-grow",
              value: query,
              placeholder: t("searchPlaceholder"),
              onChange: (event) => setQuery(event.target.value),
              onKeyDown: (event) => { if (event.key === "Enter") { setPage(1); run(source, query, sort, 1); } },
            }),
            Button({ variant: "primary", "data-role": "search", disabled: state.loading, onClick: () => { setPage(1); run(source, query, sort, 1); }, children: state.loading ? t("loading") : t("search") }),
          ),
          h("div", { className: "dgh-row dgh-row-wrap" },
            QUICK_QUERIES.map((quick) => h("span", {
              key: quick.label, className: "dgh-quick-wrap",
              // 悬停时浮出一张说明卡；指针移开就收起。
              onMouseEnter: () => setHoverQuick(quick.label),
              onMouseLeave: () => setHoverQuick((cur) => (cur === quick.label ? null : cur)),
            },
              h("button", {
                type: "button", className: "dgh-chip",
                onClick: () => { setSource(quick.source); setQuery(quick.q); setSort("stars"); setPage(1); run(quick.source, quick.q, "stars", 1); },
              }, quick.label),
              hoverQuick === quick.label
                ? h("div", { className: "dgh-quick-pop", role: "tooltip" },
                  t(quick.descKey),
                  h("code", { className: "dgh-quick-pop-q" }, `${quick.source} · ${quick.q}`))
                : null,
            )),
          ),
          h("div", { className: "dgh-row dgh-row-wrap dgh-hist" },
            h("span", { className: "dgh-label" }, t("searchHistory")),
            history.length === 0 ? h("span", { className: "dgh-hint" }, t("historyHint")) : null,
            shownHistory.map((item) => h("span", { key: item, className: "dgh-hist-chip" },
              h("button", {
                type: "button", className: "dgh-hist-text", title: item,
                onClick: () => { setQuery(item); setPage(1); run(source, item, sort, 1); },
              }, item),
              h("button", {
                type: "button", className: "dgh-hist-del", title: t("historyRemove"), "aria-label": `${t("historyRemove")}：${item}`,
                onClick: () => setSearchHistory(forgetSearchHistory(item)),
              }, "×"),
            )),
            history.length > SEARCH_HISTORY_VISIBLE
              ? h("button", {
                type: "button", className: "dgh-hist-toggle",
                onClick: () => setHistoryOpen(!historyOpen),
              }, historyOpen ? t("historyCollapse") : `${t("historyExpand")}（${history.length}）`)
              : null,
            history.length ? h("button", {
              type: "button", className: "dgh-hist-toggle",
              onClick: () => setSearchHistory(clearSearchHistory()),
            }, t("historyClear")) : null,
          ),
        ),
        state.error ? Notice({ tone: "err", children: state.error }) : null,
        state.items.length === 0 && !state.loading && !state.error ? h("div", { className: "dgh-empty" }, t("noResults")) : null,
        visible.length === 0 && state.items.length > 0 && !state.loading ? h("div", { className: "dgh-empty" }, t("allFiltered")) : null,
        h("div", { className: "dgh-row" },
          h("span", { className: "dgh-label" }, `${t("results")}：${state.total}`),
          hidden > 0 ? h("span", { className: "dgh-hint" }, `${t("filteredOut")} ${hidden}`) : null,
          state.tls ? Badge({ tone: state.tls === "local-interceptor" ? "warn" : undefined, children: `tls: ${state.tls}` }) : null,
          state.pages > 1 ? Badge({ children: `${t("filledHint")} ×${state.pages}` }) : null,
          h("span", { className: "dgh-spacer" }),
          Button({ size: "mini", disabled: page <= 1 || state.loading, onClick: () => { const next = page - 1; setPage(next); run(source, query, sort, next); }, children: "上一页" }),
          h("span", { className: "dgh-hint" }, String(page)),
          Button({ size: "mini", disabled: state.loading || state.items.length === 0, onClick: () => { const next = page + 1; setPage(next); run(source, query, sort, next); }, children: "下一页" }),
        ),
        h("div", { className: "dgh-list" },
          visible.map((item) => h(ResultCard, {
            key: item.id, t, item,
            onInstall: startInstall,
            onInspect: doInspect,
            inspection: inspections[item.id],
            inspecting: inspectingId === item.id,
          })),
        ),
      );
    }

    /* ================================================================== *
     * 已安装页
     * ================================================================== */

    function InstalledTab({ t }) {
      const [data, setData] = react.useState(null);
      const [loading, setLoading] = react.useState(true);
      const [error, setError] = react.useState("");
      const [busy, setBusy] = react.useState("");
      const [note, setNote] = react.useState("");

      const load = react.useCallback(async () => {
        setLoading(true);
        setError("");
        try {
          setData(await api("/bundles"));
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setLoading(false);
        }
      }, []);

      react.useEffect(() => { load(); }, []);

      const act = async (key, pathname, body) => {
        setBusy(key);
        setNote("");
        try {
          const res = await post(pathname, body);
          const result = res.result || {};
          setNote(`${key} → ${String(result.application || (res.ok ? "ok" : "failed"))}${result.error ? "：" + String(result.error.diagnostic || result.error.code || "") : ""}`);
          await load();
        } catch (err) {
          setNote(`${key} → ${String((err && err.message) || err)}`);
        } finally {
          setBusy("");
        }
      };

      if (loading && !data) return h("div", { className: "dgh-empty" }, t("loading"));
      if (error) return Notice({ tone: "err", children: error });
      if (!data || data.available === false) {
        return Notice({ tone: "warn", children: (data && data.error) || "当前 profile 没有插件管理器" });
      }

      const bundles = data.bundles || [];
      const plugins = data.plugins || [];

      return h("div", { className: "dgh-col" },
        h("div", { className: "dgh-card dgh-card-tight dgh-row dgh-row-wrap" },
          Badge({ tone: "brand", children: `${t("profile")}: ${(data.profile && data.profile.name) || "?"}` }),
          h("span", { className: "dgh-hint dgh-mono" }, (data.profile && data.profile.dir) || ""),
          h("span", { className: "dgh-spacer" }),
          data.registries ? h("span", { className: "dgh-hint" }, `registry: ${String(data.registries.resolved || data.registries.registry || "")|| "—"}`) : null,
          Button({ size: "mini", disabled: loading, onClick: load, children: t("refresh") }),
        ),
        note ? Notice({ children: note }) : null,
        h("div", { className: "dgh-label" }, t("bundleList")),
        bundles.length === 0 ? h("div", { className: "dgh-empty" }, t("noBundles")) : null,
        h("div", { className: "dgh-list" },
          bundles.map((bundle) => h("div", { key: bundle.name, className: "dgh-card dgh-col" },
            h("div", { className: "dgh-item-title" },
              h("span", null, bundle.name),
              bundle.version ? Badge({ children: `v${bundle.version}` }) : null,
              bundle.enabled ? Badge({ tone: "ok", children: t("enabled") }) : Badge({ children: "off" }),
              bundle.optional ? Badge({ children: "optional" }) : null,
              bundle.installed === false ? Badge({ tone: "warn", children: "not installed" }) : null,
              bundle.error ? Badge({ tone: "err", children: String(bundle.error.code || "error") }) : null,
            ),
            bundle.description ? h("div", { className: "dgh-desc" }, String(bundle.description).slice(0, 300)) : null,
            bundle.error && bundle.error.diagnostic ? Notice({ tone: "err", children: String(bundle.error.diagnostic).slice(0, 400) }) : null,
            bundle.rows && bundle.rows.length
              ? h("div", { className: "dgh-meta" }, bundle.rows.slice(0, 8).map((row) => h("span", { key: row.rowId, className: "dgh-mono" }, row.moduleName || row.rowId)))
              : null,
            h("div", { className: "dgh-row dgh-row-wrap" },
              Button({
                size: "mini", disabled: busy !== "" || bundle.readOnlyReason !== undefined,
                onClick: () => act(bundle.enabled ? "disable" : "enable", "/bundle/enabled", { name: bundle.name, enabled: !bundle.enabled }),
                children: bundle.enabled ? t("disable") : t("enable"),
              }),
              bundle.removable ? Button({
                variant: "danger", size: "mini", disabled: busy !== "",
                onClick: () => act("remove", "/bundle/remove", { name: bundle.name }),
                children: t("remove"),
              }) : null,
              bundle.readOnlyReason ? h("span", { className: "dgh-hint" }, bundle.readOnlyReason) : null,
            ),
          )),
        ),
        h("div", { className: "dgh-label" }, `${t("entries")}（${plugins.length}）`),
        h("div", { className: "dgh-card dgh-card-tight" },
          h("table", { className: "dgh-table" },
            h("thead", null, h("tr", null,
              h("th", null, "entry"),
              h("th", null, "module"),
              h("th", null, "phase"),
              h("th", null, "actions"),
            )),
            h("tbody", null, plugins.slice(0, 120).map((entry) => h("tr", { key: entry.entryId },
              h("td", { className: "dgh-mono" }, entry.entryId),
              h("td", { className: "dgh-mono" }, entry.moduleName),
              h("td", null, entry.enabled ? Badge({ tone: "ok", children: String(entry.fiberPhase || "enabled") }) : Badge({ children: "disabled" })),
              h("td", null, entry.readOnlyReason
                ? h("span", { className: "dgh-hint" }, entry.readOnlyReason)
                : Button({
                  size: "mini", disabled: busy !== "",
                  onClick: () => act(entry.enabled ? "plugin-off" : "plugin-on", "/plugin/enabled", { id: entry.entryId, enabled: !entry.enabled }),
                  children: entry.enabled ? t("disable") : t("enable"),
                })),
            ))),
          ),
        ),
      );
    }

    /* ================================================================== *
     * 账号页
     * ================================================================== */

    function AccountTab({ t, state, refresh }) {
      const [token, setToken] = react.useState("");
      const [busy, setBusy] = react.useState("");
      const [message, setMessage] = react.useState(null);
      const [clientId, setClientId] = react.useState("");
      const [scope, setScope] = react.useState("");
      const [device, setDevice] = react.useState(null);

      const settings = (state && state.settings) || {};
      react.useEffect(() => {
        setClientId(settings.deviceClientId || "");
        setScope(settings.deviceScope || "");
      }, [state && state.settings && state.settings.deviceClientId]);

      const account = (state && state.account) || { loggedIn: false };
      const history = (state && state.history) || [];

      const loginWithToken = async () => {
        if (!token.trim()) return;
        setBusy("token");
        setMessage(null);
        try {
          const res = await post("/login/token", { token: token.trim() });
          if (!res.ok) setMessage({ tone: "err", text: `${res.error || "登录失败"}${res.hint ? " —— " + res.hint : ""}` });
          else { setMessage({ tone: "ok", text: `已登录：${res.account.login}` }); setToken(""); await refresh(); }
        } catch (err) {
          setMessage({ tone: "err", text: String((err && err.message) || err) });
        } finally { setBusy(""); }
      };

      const startDevice = async () => {
        setBusy("device");
        setMessage(null);
        try {
          const res = await post("/login/device/start", { clientId: clientId.trim(), scope: scope.trim() });
          if (!res.ok) setMessage({ tone: "err", text: res.error || "无法开始设备登录" });
          else setDevice({ ...res, status: "pending" });
        } catch (err) {
          setMessage({ tone: "err", text: String((err && err.message) || err) });
        } finally { setBusy(""); }
      };

      react.useEffect(() => {
        if (!device || device.status !== "pending") return;
        let cancelled = false;
        let interval = Math.max(5, Number(device.interval || 5)) * 1000;
        let timer = null;
        const tick = async () => {
          try {
            const res = await post("/login/device/poll", { clientId: device.clientId || clientId.trim(), deviceCode: device.deviceCode });
            if (cancelled) return;
            if (res.ok && res.status === "ok") {
              setDevice((cur) => ({ ...cur, status: "done" }));
              setMessage({ tone: "ok", text: `已登录：${res.account.login}` });
              await refresh();
              return;
            }
            if (res.status === "expired" || res.status === "denied" || res.status === "error" || res.ok === false) {
              setDevice((cur) => ({ ...cur, status: "failed", reason: res.error || "授权失败" }));
              return;
            }
            if (res.status === "slow_down") interval += 5000;
          } catch (err) { /* 继续轮询 */ }
          if (!cancelled) timer = window.setTimeout(tick, interval);
        };
        timer = window.setTimeout(tick, interval);
        return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
      }, [device && device.deviceCode, device && device.status]);

      const logout = async () => {
        setBusy("logout");
        try { await post("/logout", {}); await refresh(); } catch (err) { /* 忽略 */ } finally { setBusy(""); }
      };

      const clearHistory = async () => {
        try { await post("/history/clear", {}); await refresh(); } catch (err) { /* 忽略 */ }
      };

      return h("div", { className: "dgh-col" },
        message ? Notice({ tone: message.tone, children: message.text }) : null,
        h("div", { className: "dgh-card dgh-col" },
          h("div", { className: "dgh-row" },
            account.loggedIn && account.avatar ? h("img", { className: "dgh-avatar", src: account.avatar, alt: "" }) : h("div", { className: "dgh-avatar" }),
            h("div", { className: "dgh-col" },
              h("div", { className: "dgh-item-title" },
                h("span", null, account.loggedIn ? `@${account.login}` : t("notLoggedIn")),
                account.loggedIn ? Badge({ tone: "ok", children: t("loggedInAs") }) : null,
                account.loggedIn && account.method ? Badge({ children: account.method === "device" ? t("methodDevice") : t("methodPat") }) : null,
              ),
              account.loggedIn
                ? h("div", { className: "dgh-meta" },
                  account.name ? h("span", null, account.name) : null,
                  account.tokenTail ? h("span", { className: "dgh-mono" }, account.tokenTail) : null,
                  account.savedAt ? h("span", null, fmtTime(account.savedAt)) : null,
                  account.scopes && account.scopes.length ? h("span", null, `scopes: ${account.scopes.join(", ")}`) : null,
                )
                : h("div", { className: "dgh-hint" }, t("tokenHint")),
            ),
            h("span", { className: "dgh-spacer" }),
            account.loggedIn ? Button({ variant: "danger", size: "mini", disabled: busy !== "", onClick: logout, children: t("logout") }) : null,
          ),
          !(state && state.credentialsAvailable)
            ? Notice({ tone: "warn", children: "凭据服务不可用：登录信息将无法保存。" })
            : null,
        ),
        !account.loggedIn ? h("div", { className: "dgh-card dgh-col" },
          h("strong", null, t("loginWithToken")),
          h("div", { className: "dgh-row" },
            h("input", {
              className: "dgh-input dgh-input-grow", type: "password", value: token,
              placeholder: t("tokenPlaceholder"),
              onChange: (event) => setToken(event.target.value),
              onKeyDown: (event) => { if (event.key === "Enter") loginWithToken(); },
            }),
            Button({ variant: "primary", disabled: busy !== "" || !token.trim(), onClick: loginWithToken, children: busy === "token" ? t("loading") : t("login") }),
          ),
          h("div", { className: "dgh-hint" },
            t("tokenHint"), " ",
            h("a", { className: "dgh-link", href: "https://github.com/settings/tokens", target: "_blank", rel: "noreferrer noopener" }, t("tokenCreate")),
          ),
        ) : null,
        !account.loggedIn ? h("div", { className: "dgh-card dgh-col" },
          h("strong", null, t("deviceTitle")),
          h("ol", { className: "dgh-steps" },
            h("li", null, "在 GitHub → Settings → Developer settings → OAuth Apps 新建一个 OAuth App（Device Flow 不需要 client secret）。"),
            h("li", null, "把它的 client_id 填到下面，点「开始设备登录」。"),
            h("li", null, "按页面提示在 GitHub 上输入一次性代码完成授权。"),
          ),
          h("div", { className: "dgh-row" },
            h("span", { className: "dgh-label" }, t("deviceClientId")),
            h("input", { className: "dgh-input dgh-input-grow", value: clientId, onChange: (event) => setClientId(event.target.value), placeholder: "Iv1.xxxxxxxxxxxx" }),
          ),
          h("div", { className: "dgh-row" },
            h("span", { className: "dgh-label" }, t("deviceScope")),
            h("input", { className: "dgh-input dgh-input-grow", value: scope, onChange: (event) => setScope(event.target.value), placeholder: "read:user public_repo" }),
            Button({ variant: "primary", disabled: busy !== "" || !clientId.trim(), onClick: startDevice, children: busy === "device" ? t("loading") : t("deviceStart") }),
          ),
          device && device.status === "pending" ? h("div", { className: "dgh-col" },
            Notice({ tone: "warn", children: `${t("deviceWaiting")}（${fmtRelative(device.startedAt || new Date().toISOString())}）` }),
            h("div", { className: "dgh-row dgh-row-wrap" },
              h("span", { className: "dgh-label" }, t("deviceCode")),
              h("span", { className: "dgh-mono", style: { fontSize: 18, letterSpacing: 2, fontWeight: 600 } }, device.userCode),
              CopyButton({ value: device.userCode, label: t("copySpec"), copiedLabel: t("copied") }),
              h("a", { className: "dgh-link", href: device.verificationUri, target: "_blank", rel: "noreferrer noopener" }, t("deviceOpen")),
            ),
          ) : null,
          device && device.status === "failed" ? Notice({ tone: "err", children: `${t("deviceFailed")}：${device.reason || ""}` }) : null,
        ) : null,
        h("div", { className: "dgh-row" },
          h("span", { className: "dgh-label" }, `${t("history")}（${history.length}）`),
          h("span", { className: "dgh-spacer" }),
          history.length ? Button({ size: "mini", onClick: clearHistory, children: t("clearHistory") }) : null,
        ),
        history.length === 0
          ? h("div", { className: "dgh-empty" }, t("historyEmpty"))
          : h("div", { className: "dgh-card dgh-card-tight" },
            h("table", { className: "dgh-table" },
              h("thead", null, h("tr", null,
                h("th", null, t("time")), h("th", null, "@"), h("th", null, t("action")), h("th", null, t("method")), h("th", null, t("scopes")),
              )),
              h("tbody", null, history.map((entry) => h("tr", { key: entry.id },
                h("td", null, fmtTime(entry.at)),
                h("td", null, entry.login || "—"),
                h("td", null, entry.action === "logout" ? t("actionLogout") : t("actionLogin")),
                h("td", null, entry.method === "device" ? t("methodDevice") : entry.method === "pat" ? t("methodPat") : "—"),
                h("td", { className: "dgh-mono" }, (entry.scopes || []).join(",") || "—"),
              ))),
            ),
          ),
      );
    }

    /* ================================================================== *
     * 诊断页
     * ================================================================== */

    function DiagnosticsTab({ t, state, refresh }) {
      const [health, setHealth] = react.useState(null);
      const [loading, setLoading] = react.useState(false);
      const [error, setError] = react.useState("");
      const [form, setForm] = react.useState(null);
      const [saved, setSaved] = react.useState("");

      const run = react.useCallback(async () => {
        setLoading(true);
        setError("");
        try {
          const data = await api("/health");
          setHealth(data);
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally { setLoading(false); }
      }, []);

      react.useEffect(() => { run(); }, []);
      react.useEffect(() => {
        if (state && state.settings) setForm({ ...state.settings });
      }, [state && state.settings && state.settings.trustLocalInterceptor, state && state.settings && state.settings.npmSearchRegistry]);

      const save = async () => {
        if (!form) return;
        try {
          const res = await post("/settings", form);
          if (res.ok) { setSaved(new Date().toISOString()); await refresh(); await run(); }
        } catch (err) { setError(String((err && err.message) || err)); }
      };

      const toggle = (key) => setForm((cur) => ({ ...cur, [key]: !cur[key] }));

      const git = health && health.tools && health.tools.git;
      const pnpm = health && health.tools && health.tools.pnpm;
      const apiInfo = health && health.github && health.github.api;
      const dnsApi = health && health.github && health.github.dns && health.github.dns.api;
      const hosts = (health && health.hosts) || {};

      return h("div", { className: "dgh-col" },
        error ? Notice({ tone: "err", children: error }) : null,
        h("div", { className: "dgh-card dgh-col" },
          h("div", { className: "dgh-row" },
            h("strong", null, t("diagnostics")),
            h("span", { className: "dgh-spacer" }),
            Button({ size: "mini", disabled: loading, onClick: run, children: loading ? t("loading") : t("refresh") }),
          ),
          health && health.notes && health.notes.length
            ? h("ul", { className: "dgh-steps" }, health.notes.map((note, index) => h("li", { key: index }, note)))
            : h("div", { className: "dgh-hint" }, loading ? t("loading") : "—"),
          h("div", { className: "dgh-split" },
            h("div", { className: "dgh-label" }, "GitHub API"),
            h("div", null, apiInfo ? (apiInfo.ok ? `可访问 · tls=${apiInfo.tls} · ${apiInfo.ms}ms · 配额 ${apiInfo.coreRemaining}/${apiInfo.coreLimit}` : `不可访问：${apiInfo.message || apiInfo.error || apiInfo.code || "未知原因"}`) : "—"),
            h("div", { className: "dgh-label" }, "api.github.com DNS"),
            h("div", { className: "dgh-mono" }, dnsApi ? `${(dnsApi.addresses || []).join(", ") || "—"}${dnsApi.loopback ? "（回环，被本机代理接管）" : ""}` : "—"),
            h("div", { className: "dgh-label" }, "hosts 文件"),
            h("div", { className: "dgh-mono" }, hosts.file ? `${hosts.file} · ${hosts.count} 条 GitHub 记录${hosts.loopbackHijack ? "（含回环劫持）" : ""}` : "—"),
            h("div", { className: "dgh-label" }, "npm"),
            h("div", null, health && health.npm ? (health.npm.ok ? `可访问 · ${health.npm.registry} · tls=${health.npm.tls}` : `不可访问：${health.npm.message || health.npm.error || health.npm.code || "未知原因"}`) : "—"),
            h("div", { className: "dgh-label" }, "git"),
            h("div", null, git ? (git.ok ? git.version : `未找到：${git.error}`) : "—"),
            h("div", { className: "dgh-label" }, "pnpm"),
            h("div", null, pnpm ? (pnpm.ok ? pnpm.version : `未找到：${pnpm.error}`) : "—"),
            h("div", { className: "dgh-label" }, "信任阶梯"),
            h("div", null, health && health.trustLadder ? (health.trustLadder.ok ? `已把 ${health.trustLadder.added} 张系统根证书并入默认信任链` : `未并入：${health.trustLadder.reason}`) : "—"),
            h("div", { className: "dgh-label" }, "状态文件"),
            h("div", { className: "dgh-mono" }, (state && state.settings && state.settings.stateFile) || "—"),
            h("div", { className: "dgh-label" }, "凭据 key"),
            h("div", { className: "dgh-mono" }, (state && state.settings && state.settings.credentialKey) || "—"),
          ),
        ),
        h("div", { className: "dgh-card dgh-col" },
          h("strong", null, t("settings")),
          form ? h("div", { className: "dgh-col" },
            h("label", { className: "dgh-switch" },
              h("input", { type: "checkbox", checked: !!form.trustLocalInterceptor, onChange: () => toggle("trustLocalInterceptor") }),
              t("trustLocal"),
            ),
            h("div", { className: "dgh-row" },
              h("span", { className: "dgh-label" }, t("npmRegistry")),
              h("input", { className: "dgh-input dgh-input-grow", value: form.npmSearchRegistry || "", onChange: (event) => setForm({ ...form, npmSearchRegistry: event.target.value }) }),
            ),
            h("div", { className: "dgh-row" },
              h("span", { className: "dgh-label" }, t("deviceClientId")),
              h("input", { className: "dgh-input dgh-input-grow", value: form.deviceClientId || "", onChange: (event) => setForm({ ...form, deviceClientId: event.target.value }) }),
              h("span", { className: "dgh-label" }, t("deviceScope")),
              h("input", { className: "dgh-input dgh-input-grow", value: form.deviceScope || "", onChange: (event) => setForm({ ...form, deviceScope: event.target.value }) }),
            ),
            h("div", { className: "dgh-row" },
              Button({ variant: "primary", "data-role": "save", onClick: save, children: t("save") }),
              saved ? h("span", { className: "dgh-hint" }, `${t("saved")} ${fmtTime(saved)}`) : null,
            ),
          ) : h("div", { className: "dgh-hint" }, t("loading")),
        ),
      );
    }

    /* ================================================================== *
     * 主页面
     * ================================================================== */

    function GithubHubPage({ t }) {
      const [tab, setTab] = react.useState("discover");
      const [state, setState] = react.useState(null);
      const [error, setError] = react.useState("");

      const refresh = react.useCallback(async () => {
        try {
          const data = await api("/state");
          setState(data);
          setError("");
        } catch (err) {
          setError(String((err && err.message) || err));
        }
      }, []);

      react.useEffect(() => { refresh(); }, []);

      const account = (state && state.account) || { loggedIn: false };
      const tabs = [
        { id: "discover", label: t("tabDiscover") },
        { id: "installed", label: t("tabInstalled") },
        { id: "account", label: t("tabAccount") },
        { id: "diagnostics", label: t("tabDiagnostics") },
      ];

      return h("div", { className: "dgh-root" },
        h("div", { className: "dgh-head" },
          h("h1", { className: "dgh-title" }, t("panel")),
          state && state.profile ? h("span", { className: "dgh-sub" }, `profile: ${state.profile.name || "?"}`) : null,
          h("span", { className: "dgh-spacer" }),
          account.loggedIn
            ? h("span", { className: "dgh-row" },
              account.avatar ? h("img", { className: "dgh-avatar", style: { width: 22, height: 22 }, src: account.avatar, alt: "" }) : null,
              Badge({ tone: "ok", children: `@${account.login}` }),
            )
            : Badge({ children: t("notLoggedIn") }),
          Button({ size: "mini", onClick: refresh, children: t("refresh") }),
        ),
        h("div", { className: "dgh-tabs" },
          tabs.map((entry) => h("button", {
            key: entry.id, type: "button", className: "dgh-tab",
            "data-active": tab === entry.id,
            onClick: () => setTab(entry.id),
          }, entry.label)),
        ),
        h("div", { className: "dgh-body" },
          error ? Notice({ tone: "err", children: error }) : null,
          tab === "discover" ? h(DiscoverTab, { t, authenticated: !!account.loggedIn }) : null,
          tab === "installed" ? h(InstalledTab, { t }) : null,
          tab === "account" ? h(AccountTab, { t, state, refresh }) : null,
          tab === "diagnostics" ? h(DiagnosticsTab, { t, state, refresh }) : null,
        ),
      );
    }

    /* ================================================================== *
     * 插件入口
     * ================================================================== */

    /** 需要的客户端服务；两个都存在（slots 由 ui-slots 提供，locale 由 ui-locale 提供）。 */
    const inject = ["slots", "locale"];

    function apply(ctx) {
      injectCss();
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-github-hub: dictionaries");
      const t = ctx.locale.bind(NS);

      ctx.slots.inject("main", () => ctx.slots.register({
        name: "main",
        key: PANEL_ID,
        locale: NS,
        inject: () => ({ t }),
      }, GithubHubPage));

      ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
        name: "sidebar.panellist",
        id: PANEL_ID,
        order: 35,
        label: () => t("panel"),
        locale: NS,
      }, GithubHubIcon));
    }

    exports.NS = NS;
    exports.PANEL_ID = PANEL_ID;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});