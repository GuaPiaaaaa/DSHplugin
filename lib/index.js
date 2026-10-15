/**
 * dsh-github-hub —— 宿主半侧（Host half）
 *
 * 职责：
 *   1. 在 `ctx.webServer` 上注册 `/dsh-github/*` 路由，为浏览器半侧（lib/client.js）提供本地 API；
 *   2. GitHub 账号登录：Personal Access Token 与 OAuth Device Flow 两条路，
 *      令牌存进 DSH 的凭据服务（credential record），**绝不下发到浏览器**；
 *   3. 登录记录：登录/退出历史写进 `$DSH_HOME/.dsh-github-hub.json`（不含令牌）；
 *   4. 插件发现：搜索 GitHub（topic:dsh-plugin / deepseek-harness）与 npm（keywords:dsh-plugin）；
 *   5. 一键安装：走 `ctx.pluginManager.installBundle()` —— 与「设置 → 插件」、`dsh plugin` 完全同一条
 *      pnpm + bundle 激活链路，安装后落进当前 profile（桌面端 = desktop profile）。
 *
 * 网络说明（很重要）：
 *   本机 hosts 常被「GitHub 加速器」类工具（如 Watt Toolkit / Steam++）把 github.com、api.github.com
 *   指向 127.0.0.1，再由它自己的本地反向代理用**自签 CA** 转发。Node 默认只信任内置根证书，
 *   于是会报 "unable to verify the first certificate"。本插件用一个「信任阶梯」适配这种情况：
 *     ① 默认信任链（未拦截时直接成功）
 *     ② 默认根证书 + 操作系统根证书（等价于 node --use-system-ca）
 *     ③ 仍失败且对端是回环地址时，按设置允许「信任本机拦截器」（rejectUnauthorized:false）
 *   每一步的结果都会在「诊断」页如实显示，不会偷偷降级。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import dns from 'node:dns'
import https from 'node:https'
import tls from 'node:tls'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_NAME = 'dsh-github-hub'
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATE_FILE = path.join(DSH_HOME, '.dsh-github-hub.json')
/** 凭据服务里的 record key：本插件为「GitHub 这一个 id」持有的凭据。 */
const CREDENTIAL_KEY = 'dsh-github-hub/github'
const ROUTE_PREFIX = '/dsh-github'
const USER_AGENT = 'dsh-github-hub/1.0.0 (+dsh-plugin)'
const GITHUB_API = 'https://api.github.com'
const GITHUB_WEB = 'https://github.com'
const GITHUB_RAW = 'https://raw.githubusercontent.com'
const DEFAULT_NPM_SEARCH = 'https://registry.npmjs.org'
const MAX_BODY_BYTES = 1024 * 1024
const HISTORY_LIMIT = 200
const INSTALL_FEED_LIMIT = 24
const LOG_LINES_LIMIT = 400

const DEFAULT_SETTINGS = {
  /** 是否允许在「对端是回环地址」时信任本机拦截器（跳过证书校验）。 */
  trustLocalInterceptor: true,
  /** npm 搜索源；安装时的 registry 仍走插件管理器自己的计划。 */
  npmSearchRegistry: DEFAULT_NPM_SEARCH,
  /** Device Flow 用的 OAuth App client_id（由用户自备，插件不内置他人 client_id）。 */
  deviceClientId: '',
  /** Device Flow 申请的 scope。 */
  deviceScope: 'read:user public_repo',
}

/* ------------------------------------------------------------------ *
 * 状态文件（设置 + 登录记录，绝不含令牌）
 * ------------------------------------------------------------------ */

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    if (parsed && typeof parsed === 'object') {
      return {
        version: 1,
        settings: { ...DEFAULT_SETTINGS, ...(parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {}) },
        history: Array.isArray(parsed.history) ? parsed.history.filter((e) => e && typeof e === 'object') : [],
      }
    }
  } catch (err) {
    /* 文件不存在或损坏都回落到默认值：登录记录是便利数据，不能拖垮插件加载 */
  }
  return { version: 1, settings: { ...DEFAULT_SETTINGS }, history: [] }
}

function writeState(state) {
  const body = JSON.stringify({ version: 1, settings: state.settings, history: state.history.slice(0, HISTORY_LIMIT) }, null, 2)
  const tmp = STATE_FILE + '.tmp'
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
    fs.writeFileSync(tmp, body, 'utf8')
    fs.renameSync(tmp, STATE_FILE)
    return true
  } catch (err) {
    try { fs.writeFileSync(STATE_FILE, body, 'utf8'); return true } catch (err2) { return false }
  }
}

function appendHistory(state, entry) {
  state.history.unshift({ id: randomUUID(), at: new Date().toISOString(), ...entry })
  if (state.history.length > HISTORY_LIMIT) state.history.length = HISTORY_LIMIT
  writeState(state)
}

/* ------------------------------------------------------------------ *
 * 信任阶梯 + HTTP 客户端
 * ------------------------------------------------------------------ */

/** 证书类错误码：命中就说明「不是网络不通，而是不被信任」。 */
function isTrustError(err) {
  const code = String((err && err.code) || '')
  const message = String((err && err.message) || '')
  if (/^(UNABLE_TO_|SELF_SIGNED|CERT_|DEPTH_ZERO|ERR_TLS_CERT_ALTNAME)/.test(code)) return true
  return /certificate|self[- ]signed|unable to verify/i.test(message)
}

let systemCABundle
/** 操作系统根证书（Node ≥ 24 提供 tls.getCACertificates('system')）。 */
function systemCAs() {
  if (systemCABundle !== undefined) return systemCABundle
  systemCABundle = null
  try {
    if (typeof tls.getCACertificates === 'function') {
      const list = tls.getCACertificates('system')
      if (Array.isArray(list) && list.length > 0) systemCABundle = list
    }
  } catch (err) { /* 运行时不支持 -> 保持 null，走其它阶梯 */ }
  return systemCABundle
}

/**
 * 把系统根证书并入本进程的默认信任链（等价于启动时加 `--use-system-ca`）。
 * 这样普通 fetch / https 也能穿过本机拦截器，是代价最低的一步。
 */
function widenDefaultTrust() {
  try {
    if (typeof tls.getCACertificates === 'function' && typeof tls.setDefaultCACertificates === 'function') {
      const base = tls.getCACertificates('default') || []
      const system = tls.getCACertificates('system') || []
      if (system.length > 0) {
        tls.setDefaultCACertificates([...base, ...system])
        return { ok: true, added: system.length }
      }
      return { ok: false, reason: '系统根证书为空' }
    }
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) }
  }
  return { ok: false, reason: '当前运行时没有 tls.getCACertificates（Node < 24）' }
}

function isLoopbackHostname(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (!h) return false
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  if (Number(m[1]) !== 127) return false
  return [m[2], m[3], m[4]].every((x) => Number(x) <= 255)
}

function requestOnce(url, options) {
  const { method = 'GET', headers = {}, body, timeoutMs = 20000, ca, insecure } = options || {}
  return new Promise((resolve, reject) => {
    let target
    try { target = new URL(url) } catch (err) { reject(new Error(`非法 URL: ${url}`)); return }
    const request = https.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 443,
      path: target.pathname + target.search,
      method,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers },
      ...(ca ? { ca } : {}),
      ...(insecure ? { rejectUnauthorized: false } : {}),
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = text ? JSON.parse(text) : null } catch (err) { /* 非 JSON 响应 */ }
        resolve({ status: res.statusCode || 0, headers: res.headers, text, json })
      })
    })
    request.setTimeout(timeoutMs, () => request.destroy(Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' })))
    request.on('error', reject)
    if (body !== undefined) request.write(typeof body === 'string' ? body : JSON.stringify(body))
    request.end()
  })
}

/**
 * 带信任阶梯的请求。返回值多带一个 `tls` 字段，说明这一跳最终用了哪一级信任。
 * @returns {Promise<{status:number, headers:object, text:string, json:any, tls:string}>}
 */
async function requestWithLadder(url, options) {
  const settings = readState().settings
  let firstError = null
  try {
    return { ...(await requestOnce(url, options)), tls: 'default' }
  } catch (err) {
    if (!isTrustError(err)) throw err
    firstError = err
  }
  const withSystem = systemCAs()
  if (withSystem && withSystem.length > 0) {
    try {
      const ca = [...(tls.rootCertificates || []), ...withSystem]
      return { ...(await requestOnce(url, { ...options, ca })), tls: 'system-ca' }
    } catch (err) {
      if (!isTrustError(err)) throw err
      firstError = err
    }
  }
  let loopback = false
  try {
    const resolved = await dns.promises.lookup(new URL(url).hostname, { all: true })
    loopback = resolved.some((entry) => isLoopbackHostname(entry.address))
  } catch (err) { /* DNS 失败 -> 不判定为回环 */ }
  if (loopback && settings.trustLocalInterceptor) {
    return { ...(await requestOnce(url, { ...options, insecure: true })), tls: 'local-interceptor' }
  }
  const wrapped = new Error(`TLS 信任失败：${String((firstError && firstError.message) || firstError)}`)
  wrapped.code = 'TLS_TRUST'
  wrapped.hint = loopback
    ? '对端解析到回环地址（本机 hosts 被加速器接管），且「信任本机拦截器」当前关闭。'
    : '无法用系统根证书验证对端证书。'
  throw wrapped
}

/* ------------------------------------------------------------------ *
 * GitHub / npm 适配
 * ------------------------------------------------------------------ */

function githubHeaders(token, extra) {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(extra || {}),
  }
}

async function githubJson(pathname, options) {
  const { method = 'GET', token, body, headers } = options || {}
  const url = pathname.startsWith('http') ? pathname : GITHUB_API + pathname
  const res = await requestWithLadder(url, {
    method,
    headers: githubHeaders(token, headers),
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (res.status === 401) { const err = new Error('GitHub 令牌无效或已过期（401）'); err.code = 'UNAUTHORIZED'; throw err }
  if (res.status === 403 && /rate limit/i.test(res.text)) {
    const err = new Error('GitHub API 速率限制（403）：未登录时搜索接口约 10 次/分钟，登录后 30 次/分钟。')
    err.code = 'RATE_LIMIT'
    throw err
  }
  if (res.status >= 400) {
    const err = new Error(`GitHub API ${res.status}：${String((res.json && res.json.message) || res.text).slice(0, 300)}`)
    err.code = 'GITHUB_API'
    err.status = res.status
    throw err
  }
  return res
}

async function fetchAccount(token) {
  const res = await githubJson('/user', { token })
  const scopes = String(res.headers['x-oauth-scopes'] || '')
    .split(',').map((s) => s.trim()).filter(Boolean)
  const user = res.json || {}
  return {
    login: String(user.login || ''),
    name: user.name ? String(user.name) : '',
    id: user.id,
    avatar: user.avatar_url ? String(user.avatar_url) : '',
    profile: user.html_url ? String(user.html_url) : (user.login ? `${GITHUB_WEB}/${user.login}` : ''),
    scopes,
  }
}

/* ------------------------------------------------------------------ *
 * 搜索：GitHub 仓库 + npm 包
 * ------------------------------------------------------------------ */

const PLUGIN_TOPICS = ['dsh-plugin', 'deepseek-harness', 'dsh-bundle', 'dsh-plugins', 'dsh-skill', 'cordis-plugin']

/**
 * 判定一个仓库是否「像」DSH 插件。
 * 光看 topic 不够：GitHub 上有大量把 dsh-plugin 当流量标签的高星仓库（搜索里会把真插件挤下去），
 * 所以要求「声明了 DSH 相关 topic」**并且**「名字/描述/README 主题里确实提到 DSH」两者同时成立。
 */
function looksLikePlugin(repo) {
  const topics = (repo.topics || []).map((t) => String(t).toLowerCase())
  const dshTopic = topics.some((t) => PLUGIN_TOPICS.includes(t))
  const harnessTopic = topics.includes('deepseek-harness')
  const haystack = `${repo.name || ''} ${repo.description || ''} ${repo.full_name || ''}`.toLowerCase()
  const mentions = /(^|[^a-z0-9])(dsh|deepseek[-_ ]?harness)([^a-z0-9]|$)/.test(haystack)
    || /dsh[-_ ]?plugin|dsh[-_ ]?bundle|deepseek[-_ ]?harness/.test(haystack)
  return (dshTopic && mentions) || (harnessTopic && mentions) || /dsh[-_ ]?plugin|deepseek[-_ ]?harness/.test(haystack)
}

async function searchGithub({ query, page, sort, token }) {
  const q = String(query || '').trim() || 'topic:dsh-plugin'
  const search = new URLSearchParams({
    q,
    per_page: '12',
    page: String(Math.max(1, Number(page) || 1)),
  })
  // 默认按最近更新排序：插件生态里「最近更新」比「最佳匹配」有用得多，
  // 后者会被上面那种蹭 topic 的高星仓库占满。
  const effective = sort === 'best-match' ? 'updated' : sort
  if (effective === 'stars' || effective === 'updated' || effective === 'forks') {
    search.set('sort', effective)
    search.set('order', 'desc')
  }
  const res = await githubJson(`/search/repositories?${search.toString()}`, { token })
  const json = res.json || {}
  return {
    source: 'github',
    query: q,
    total: Number(json.total_count || 0),
    items: (json.items || []).map((repo) => ({
      kind: 'repo',
      id: String(repo.full_name || ''),
      name: String(repo.name || ''),
      owner: String((repo.owner && repo.owner.login) || ''),
      fullName: String(repo.full_name || ''),
      description: String(repo.description || ''),
      url: String(repo.html_url || ''),
      stars: Number(repo.stargazers_count || 0),
      forks: Number(repo.forks_count || 0),
      updatedAt: String(repo.updated_at || ''),
      defaultBranch: String(repo.default_branch || 'main'),
      archived: !!repo.archived,
      topics: (repo.topics || []).map(String),
      isPlugin: looksLikePlugin(repo),
      /** 安装时使用 git spec —— pnpm 走 git，插件管理器会先做 ls-remote 可达性检查。 */
      installSpec: `github:${repo.full_name}`,
    })),
    tls: res.tls,
  }
}

async function searchNpm({ query, page, registry }) {
  const base = String(registry || DEFAULT_NPM_SEARCH).replace(/\/+$/, '')
  const text = String(query || '').trim() || 'keywords:dsh-plugin'
  const size = 12
  const from = (Math.max(1, Number(page) || 1) - 1) * size
  const res = await requestWithLadder(`${base}/-/v1/search?text=${encodeURIComponent(text)}&size=${size}&from=${from}`, {})
  if (res.status >= 400) {
    const err = new Error(`npm 搜索失败：HTTP ${res.status}`)
    err.code = 'NPM_SEARCH'
    throw err
  }
  const json = res.json || {}
  const objects = Array.isArray(json.objects) ? json.objects : []
  return {
    source: 'npm',
    query: text,
    total: Number(json.total || objects.length),
    items: objects.map((entry) => {
      const pkg = entry.package || {}
      const links = pkg.links || {}
      const repoUrl = String(links.repository || '')
      return {
        kind: 'package',
        id: String(pkg.name || ''),
        name: String(pkg.name || ''),
        owner: repoUrl ? repoUrl.replace(/^https?:\/\/github\.com\//, '').split('/')[0] || '' : '',
        fullName: String(pkg.name || ''),
        version: String(pkg.version || ''),
        description: String(pkg.description || ''),
        url: repoUrl || String(links.npm || ''),
        npmUrl: String(links.npm || ''),
        stars: 0,
        updatedAt: String(entry.updated || pkg.date || ''),
        publisher: String((entry.publisher && entry.publisher.username) || ''),
        keywords: Array.isArray(pkg.keywords) ? pkg.keywords.map(String) : [],
        isPlugin: (pkg.keywords || []).some((k) => PLUGIN_TOPICS.includes(String(k).toLowerCase()))
          || /dsh|deepseek[-_ ]?harness/i.test(String(pkg.description || '')),
        installSpec: String(pkg.name || ''),
      }
    }),
    tls: res.tls,
  }
}

/**
 * pnpm 会把 `github:owner/repo` 解析成 `git+ssh://git@github.com/owner/repo.git`；
 * 在 SSH 端口被挡或没有 known_hosts 的机器上，那个 git 进程会一直等（0 CPU、无限重试），
 * 表现就是安装界面永远停在「读取中…」。统一改写成 HTTPS 形式（本机 HTTPS 到 GitHub 已验证可用）。
 * 其它形式（npm 包名、git+https、git+file 等）原样返回。
 */
function toHttpsGitSpec(spec) {
  const text = String(spec || '').trim()
  const shorthand = text.match(/^github:([^\s/]+\/[^\s#]+?)(?:#(\S+))?$/i)
  if (shorthand) {
    const repo = shorthand[1].replace(/\.git$/i, '')
    return `git+https://github.com/${repo}.git${shorthand[2] ? `#${shorthand[2]}` : ''}`
  }
  const ssh = text.match(/^git\+ssh:\/\/git@github\.com\/(\S+)$/i)
  if (ssh) return `git+https://github.com/${ssh[1]}`
  return text
}

/** 读取仓库里的 package.json，判断它到底是不是一个 DSH 插件（bundle / client）。 */
async function inspectRepoPackage({ repo, ref }) {
  const target = String(repo || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '')
  if (!/^[^/\s]+\/[^/\s]+$/.test(target)) {
    const err = new Error('仓库名应形如 owner/repo')
    err.code = 'BAD_REPO'
    throw err
  }
  const branch = String(ref || '').trim() || 'HEAD'
  const rawUrl = `${GITHUB_RAW}/${target}/${branch}/package.json`
  // raw.githubusercontent.com 在本机加速器下偶尔会抽风（ECONNRESET / 502），
  // 而 api.github.com 一直稳定，所以 raw 失败时回退到 Contents API。
  let pkg = null
  let source = 'raw'
  let usedUrl = rawUrl
  let tls = ''
  let reason = ''
  try {
    const res = await requestWithLadder(rawUrl, { headers: { Accept: 'application/json' } })
    tls = res.tls
    if (res.status === 404) {
      reason = '仓库根目录没有 package.json（可能不是 npm 包，或在子目录里）'
    } else if (res.status >= 400) {
      reason = `raw 返回 HTTP ${res.status}`
    } else if (res.json && typeof res.json === 'object') {
      pkg = res.json
    } else {
      reason = 'package.json 不是合法 JSON'
    }
  } catch (err) {
    reason = `raw 请求失败：${String((err && err.message) || err)}`
  }

  if (!pkg) {
    try {
      const res = await githubJson(`/repos/${target}/contents/package.json?ref=${encodeURIComponent(branch)}`, {})
      const payload = res.json || {}
      const encoded = String(payload.content || '').replace(/\s+/g, '')
      if (encoded && String(payload.encoding || 'base64') === 'base64') {
        pkg = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
        source = 'api'
        usedUrl = `https://api.github.com/repos/${target}/contents/package.json?ref=${branch}`
        tls = res.tls
        reason = ''
      } else if (!reason) {
        reason = 'Contents API 没有返回内容'
      }
    } catch (err) {
      if (!reason) reason = `Contents API 也失败：${String((err && err.message) || err)}`
    }
  }

  if (!pkg) return { found: false, repo: target, url: rawUrl, reason: reason || '读取 package.json 失败' }
  const url = usedUrl
  const dsh = pkg.dsh && typeof pkg.dsh === 'object' ? pkg.dsh : {}
  const bundle = dsh.bundle && typeof dsh.bundle === 'object' ? dsh.bundle : null
  const client = dsh.client && typeof dsh.client === 'object' ? dsh.client : null
  return {
    found: true,
    repo: target,
    url,
    /** 实际拿到内容的通道：raw.githubusercontent.com 或 api.github.com 的 Contents API。 */
    source,
    tls,
    name: String(pkg.name || ''),
    version: String(pkg.version || ''),
    description: String(pkg.description || ''),
    private: !!pkg.private,
    keywords: Array.isArray(pkg.keywords) ? pkg.keywords.map(String) : [],
    hasBundle: !!bundle,
    bundlePatch: bundle ? String(bundle.patch || '') : '',
    hasClient: !!client,
    clientPlatform: client ? String(client.platform || '') : '',
    peers: (pkg.peerDependencies && typeof pkg.peerDependencies === 'object') ? pkg.peerDependencies : {},
    /** 能装成 DSH 插件的必要条件：声明了 bundle patch。 */
    installable: !!bundle,
    verdict: bundle
      ? (client ? 'DSH 插件（宿主 + 浏览器半侧）' : 'DSH 插件（宿主半侧）')
      : (client ? '只有浏览器半侧，缺少 dsh.bundle.patch —— 装进来不会出现在插件列表里' : '看起来不是 DSH 插件（package.json 里没有 dsh.bundle）'),
  }
}

/* ------------------------------------------------------------------ *
 * 连通性诊断
 * ------------------------------------------------------------------ */

function hostsFileCandidates() {
  const list = []
  if (process.env.SystemRoot) list.push(path.join(process.env.SystemRoot, 'System32', 'drivers', 'etc', 'hosts'))
  list.push('/etc/hosts')
  return list
}

function readHostsGithubEntries() {
  for (const file of hostsFileCandidates()) {
    try {
      const text = fs.readFileSync(file, 'utf8')
      const entries = text.split(/\r?\n/)
        .map((line) => line.replace(/#.*$/, '').trim())
        .filter(Boolean)
        .map((line) => line.split(/\s+/))
        .filter((parts) => parts.length >= 2 && parts.slice(1).some((host) => /github/i.test(host)))
        .map((parts) => ({ ip: parts[0], hosts: parts.slice(1) }))
      return { file, entries }
    } catch (err) { /* 下一个候选 */ }
  }
  return { file: '', entries: [] }
}

async function probeGithubApi(token) {
  const started = Date.now()
  try {
    const res = await githubJson('/rate_limit', { token })
    const core = (res.json && res.json.resources && res.json.resources.core) || {}
    const search = (res.json && res.json.resources && res.json.resources.search) || {}
    return {
      ok: true,
      tls: res.tls,
      ms: Date.now() - started,
      authenticated: !!token,
      coreRemaining: Number(core.remaining || 0),
      coreLimit: Number(core.limit || 0),
      searchRemaining: Number(search.remaining || 0),
      searchLimit: Number(search.limit || 0),
    }
  } catch (err) {
    return { ok: false, code: String(err.code || 'ERROR'), message: String((err && err.message) || err), hint: err.hint ? String(err.hint) : '', ms: Date.now() - started }
  }
}

async function probeNpm(registry) {
  const base = String(registry || DEFAULT_NPM_SEARCH).replace(/\/+$/, '')
  const started = Date.now()
  try {
    const res = await requestWithLadder(`${base}/-/v1/search?text=keywords:dsh-plugin&size=1`, {})
    return { ok: res.status < 400, registry: base, status: res.status, tls: res.tls, ms: Date.now() - started }
  } catch (err) {
    return { ok: false, registry: base, code: String(err.code || 'ERROR'), message: String((err && err.message) || err), ms: Date.now() - started }
  }
}

async function probeDns(hostname) {
  try {
    const rows = await dns.promises.lookup(hostname, { all: true })
    return { hostname, addresses: rows.map((r) => r.address), loopback: rows.some((r) => isLoopbackHostname(r.address)) }
  } catch (err) {
    return { hostname, addresses: [], loopback: false, error: String((err && err.message) || err) }
  }
}

function probeExecutable(command, args) {
  return new Promise((resolve) => {
    try {
      execFile(command, args, { timeout: 8000, windowsHide: true }, (error, stdout) => {
        if (error) resolve({ ok: false, command, error: String(error.message || error) })
        else resolve({ ok: true, command, version: String(stdout || '').trim().split(/\r?\n/)[0] })
      })
    } catch (err) {
      resolve({ ok: false, command, error: String((err && err.message) || err) })
    }
  })
}

/* ------------------------------------------------------------------ *
 * 信任栅栏（与鲸鱼挂件同源的 fail-closed 策略）
 * ------------------------------------------------------------------ */

function makeFence(ctx) {
  const trustedAuthorities = String(process.env.DSH_GH_TRUSTED_HOSTS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  const writeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

  function connectionFence() {
    try {
      const conn = ctx.get('connection')
      return conn && typeof conn.requestRejection === 'function' ? conn : null
    } catch (err) { return null }
  }

  /** 自校验：Host 必须回环（或显式声明）；跨站标记一律拒；Origin 必须与 Host 同源。 */
  function selfRejection(req, fenceAvailable) {
    try {
      const headers = req.headers || {}
      let hostUrl
      try { hostUrl = new URL('http://' + String(headers.host || '')) } catch (err) { return 403 }
      const hostname = hostUrl.hostname
      const authority = hostUrl.host.toLowerCase()
      if (!isLoopbackHostname(hostname)) {
        const listed = trustedAuthorities.some((e) => (e.includes(':') ? e === authority : e === hostname.toLowerCase()))
        if (!listed && !fenceAvailable) return 403
      }
      if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return 403
      const origin = headers.origin
      if (typeof origin === 'string' && origin && origin !== 'null') {
        let originUrl
        try { originUrl = new URL(origin) } catch (err) { return 403 }
        // 桌面端由 Electron 转发（origin 已被剥离），Web 端是同源页面 -> 两者都应通过。
        const originHost = originUrl.host.toLowerCase()
        if (originHost !== authority && originUrl.protocol !== 'dsh-app:') return 403
      }
      return null
    } catch (err) { return 403 }
  }

  /** 写请求（登录、安装、卸载）必须是本机（回环）来源。 */
  function writeRejection(req) {
    const method = String((req && req.method) || 'GET').toUpperCase()
    if (!writeMethods.has(method)) return null
    const headers = (req && req.headers) || {}
    let hostUrl
    try { hostUrl = new URL('http://' + String(headers.host || '')) } catch (err) { return 403 }
    if (isLoopbackHostname(hostUrl.hostname)) return null
    return 403
  }

  return function rejected(req, res) {
    const conn = connectionFence()
    const self = selfRejection(req, !!conn)
    if (self !== null) { try { res.writeHead(self); res.end() } catch (err) { /* 已断开 */ } return true }
    const write = writeRejection(req)
    if (write !== null) { try { res.writeHead(write); res.end() } catch (err) { /* 已断开 */ } return true }
    if (!conn) return false
    let code
    try { code = conn.requestRejection(req) } catch (err) { code = 403 }
    if (code === undefined || code === null || code === false) return false
    try { res.writeHead(typeof code === 'number' ? code : 403); res.end() } catch (err) { /* 已断开 */ }
    return true
  }
}

/* ------------------------------------------------------------------ *
 * 客户端 bundle 诊断
 * ------------------------------------------------------------------ */

/**
 * `dsh-client-modules` 的 rev：由 bundle 文件的 (mtimeMs, ctimeMs, size) 帧化哈希而来，
 * 长度 12 位十六进制。这里复刻同一算法，用来判断图里缓存的 bundle 是不是旧版本。
 */
function framedHash12(domain, parts) {
  const hash = createHash('sha1').update(domain).update('\0')
  for (const part of parts) hash.update(`${String(Buffer.byteLength(part))}:`).update(part)
  return hash.digest('hex').slice(0, 12)
}

function artifactRevisionOf(clientPath) {
  try {
    const stat = fs.statSync(clientPath)
    return framedHash12('plugin-artifact', [String(stat.mtimeMs), String(stat.ctimeMs), String(stat.size)])
  } catch (err) {
    return ''
  }
}

/* ------------------------------------------------------------------ *
 * HTTP 小工具
 * ------------------------------------------------------------------ */

/** 工作目录可能不可读，取不到就返回空串。 */
function safeCwd() {
  try { return process.cwd() } catch (err) { return '' }
}

/** 宿主日志：logger 是可选服务，缺了就当没有。 */
function log(ctx, message) {
  try {
    const factory = ctx && typeof ctx.logger === 'function' ? ctx.logger : null
    const logger = factory ? factory.call(ctx, 'dsh-github-hub') : null
    if (logger && typeof logger.info === 'function') logger.info(message)
    else if (logger && typeof logger.debug === 'function') logger.debug(message)
  } catch (err) { /* 日志失败不能影响功能 */ }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    })
    res.end(body)
  } catch (err) { /* 连接已关闭 */ }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) { reject(new Error('请求体过大')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) { resolve({}); return }
      try { resolve(JSON.parse(text)) } catch (err) { reject(new Error('请求体不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

/* ------------------------------------------------------------------ *
 * 插件入口
 * ------------------------------------------------------------------ */

export default {
  name: 'dsh-github-hub',

  apply(root) {
    // ① 先把系统根证书并进默认信任链：这一步不需要任何服务，越早做越好。
    const trust = widenDefaultTrust()
    if (!trust.ok) log(root, `系统根证书未能并入默认信任链：${trust.reason}`)

    // ② 路由必须等 webServer 就绪；写成局部 inject，apply 本身不被推迟。
    root.inject(['webServer'], (ctx) => {
      const rejected = makeFence(ctx)
      const installFeed = new Map()

      const credentialsOf = () => {
        try { return ctx.get('credentials') || null } catch (err) { return null }
      }
      const pluginManagerOf = () => {
        try { return ctx.get('pluginManager') || null } catch (err) { return null }
      }

      /** 读凭据里的令牌；只在宿主内使用，永不下发。 */
      async function readToken() {
        const credentials = credentialsOf()
        if (!credentials) return { token: '', record: null, available: false }
        let record = null
        try { record = await credentials.readRecord(CREDENTIAL_KEY) } catch (err) { record = null }
        const payload = record && record.kind === 'grant' && record.payload && typeof record.payload === 'object' ? record.payload : null
        const token = payload && typeof payload.token === 'string' ? payload.token : ''
        return { token, record: payload, available: true }
      }

      async function saveToken(payload) {
        const credentials = credentialsOf()
        if (!credentials) throw Object.assign(new Error('凭据服务（credentials）不可用，无法保存登录'), { code: 'NO_CREDENTIALS' })
        await credentials.modifyRecord(CREDENTIAL_KEY, async () => ({ kind: 'grant', payload }))
      }

      async function dropToken() {
        const credentials = credentialsOf()
        if (!credentials) return
        try { await credentials.deleteRecord(CREDENTIAL_KEY) } catch (err) { /* 已不存在 */ }
      }

      function publicAccount(record) {
        if (!record || !record.token) return { loggedIn: false }
        const token = String(record.token)
        return {
          loggedIn: true,
          login: String(record.login || ''),
          name: String(record.name || ''),
          avatar: String(record.avatar || ''),
          profile: String(record.profile || ''),
          scopes: Array.isArray(record.scopes) ? record.scopes : [],
          method: String(record.method || 'pat'),
          savedAt: String(record.savedAt || ''),
          /** 只显示尾部 4 位，用于让用户确认自己登的是哪一个令牌。 */
          tokenTail: token.length > 4 ? `••••${token.slice(-4)}` : '••••',
        }
      }

      function profileInfo() {
        // 桌面端宿主子进程不一定带 DSH_PROFILE / DSH_PROFILE_DIR 环境变量，
        // 但它的工作目录就是 profile 目录，profileContext 也能给出真正在跑的 bundle 列表。
        const fromEnv = String(process.env.DSH_PROFILE_DIR || '')
        const dir = fromEnv || safeCwd()
        const name = String(process.env.DSH_PROFILE || '') || path.basename(dir || '')
        let startedBundles = []
        let packageManager = ''
        try {
          const profile = ctx.get('profileContext')
          if (profile) {
            if (Array.isArray(profile.startedBundles)) startedBundles = profile.startedBundles.map(String)
            if (profile.packageManager) {
              packageManager = [profile.packageManager.command, ...(profile.packageManager.args || [])].join(' ')
            }
          }
        } catch (err) { /* profileContext 是可选服务 */ }
        return {
          name,
          dir,
          home: DSH_HOME,
          dshVersion: String(process.env.DSH_CLIENT_VERSION || ''),
          startedBundles,
          packageManager,
        }
      }

      function clientDiagnostics() {
        const mods = ctx.get('clientModules')
        const clientFile = path.join(PACKAGE_ROOT, 'lib', 'client.js')
        const currentRev = artifactRevisionOf(clientFile)
        if (!mods) return { available: false, clientFile, currentRev }
        const graph = typeof mods.graph === 'function' ? mods.graph() : null
        const rows = (graph && graph.entries) || []
        const row = rows.find((entry) => entry && entry.id === PACKAGE_NAME) || null
        const batches = (graph && graph.batches) || []
        const batch = batches.find((item) => item && item.descriptor && (item.descriptor.entries || []).includes(PACKAGE_NAME))
        const baseline = typeof mods.artifactBaseline === 'function' ? mods.artifactBaseline(PACKAGE_NAME) : undefined
        let clientPath
        try { clientPath = typeof mods.clientPath === 'function' ? mods.clientPath(PACKAGE_NAME) : undefined } catch (err) { clientPath = undefined }
        return {
          available: true,
          loaded: row !== null,
          clientFile,
          currentRev,
          graphRev: row ? row.rev : '',
          /** false 表示图里缓存的字节是旧版本（改过 lib/client.js 但还没重启）。 */
          fresh: row ? row.rev === currentRev : false,
          row,
          batch: batch ? { phase: batch.descriptor.phase, url: batch.descriptor.url } : null,
          baseline,
          clientPath,
          graphEntries: rows.map((entry) => entry.id),
        }
      }

      function feedOf(requestId) {
        let feed = installFeed.get(requestId)
        if (!feed) {
          feed = { requestId, spec: '', phase: 'starting', logs: [], result: null, startedAt: Date.now(), finishedAt: 0 }
          installFeed.set(requestId, feed)
          if (installFeed.size > INSTALL_FEED_LIMIT) {
            const oldest = [...installFeed.keys()][0]
            installFeed.delete(oldest)
          }
        }
        return feed
      }

      // 安装日志/阶段：订阅插件管理器的宿主事件，按 requestId 缓冲，供前端轮询。
      ctx.effect(() => {
        const offLog = ctx.on('plugin-manager/install-log', (chunk) => {
          try {
            const requestId = chunk && chunk.requestId ? String(chunk.requestId) : ''
            if (!requestId) return
            const feed = feedOf(requestId)
            const text = String((chunk && chunk.text) || '')
            for (const line of text.split(/\r?\n/)) {
              if (!line && feed.logs.length > 0) continue
              feed.logs.push({ stream: String(chunk.stream || 'stdout'), text: line })
            }
            if (feed.logs.length > LOG_LINES_LIMIT) feed.logs.splice(0, feed.logs.length - LOG_LINES_LIMIT)
          } catch (err) { /* 日志失败不影响安装 */ }
        })
        const offState = ctx.on('plugin-manager/install-state', (progress) => {
          try {
            const requestId = progress && progress.requestId ? String(progress.requestId) : ''
            if (!requestId) return
            const feed = feedOf(requestId)
            feed.phase = String(progress.phase || feed.phase)
            if (progress.attempt) feed.attempt = progress.attempt
          } catch (err) { /* 同上 */ }
        })
        return () => { offLog(); offState() }
      })

      /* ------------------------------ 路由处理 ------------------------------ */

      async function handle(req, res, url) {
        const tail = url.pathname.slice(ROUTE_PREFIX.length) || '/'
        const method = String(req.method || 'GET').toUpperCase()

        // —— 只读 ——
        if (method === 'GET' && (tail === '/' || tail === '/state')) {
          const state = readState()
          const { token, record, available } = await readToken()
          sendJson(res, 200, {
            ok: true,
            profile: profileInfo(),
            credentialsAvailable: available,
            account: publicAccount(record),
            history: state.history,
            settings: publicSettings(state.settings),
            trustLadder: trust,
            platform: process.platform,
            client: clientDiagnostics(),
          })
          return
        }

        if (method === 'GET' && tail === '/client') {
          sendJson(res, 200, { ok: true, client: clientDiagnostics() })
          return
        }

        if (method === 'GET' && tail === '/health') {
          const state = readState()
          const { token } = await readToken()
          const [api, npm, dnsApi, dnsRaw, git, pnpmOnPath] = await Promise.all([
            probeGithubApi(token),
            probeNpm(state.settings.npmSearchRegistry),
            probeDns('api.github.com'),
            probeDns('raw.githubusercontent.com'),
            probeExecutable('git', ['--version']),
            probeExecutable('pnpm', ['--version']),
          ])
          // 桌面端不自带 PATH 里的 pnpm：安装由 dsh 进程通过 profileContext 提供的包管理器执行，
          // 所以这里以「宿主是否提供包管理器」为准，PATH 探测只作为附带信息。
          const profile = profileInfo()
          const pnpm = profile.packageManager
            ? { ok: true, managed: true, version: '由宿主包管理器接管', command: profile.packageManager, path: pnpmOnPath }
            : { ...pnpmOnPath, managed: false }
          const hosts = readHostsGithubEntries()
          const loopbackHijack = hosts.entries.some((entry) => isLoopbackHostname(entry.ip))
          sendJson(res, 200, {
            ok: true,
            github: { api, dns: { api: dnsApi, raw: dnsRaw } },
            npm,
            hosts: { file: hosts.file, count: hosts.entries.length, entries: hosts.entries.slice(0, 12), loopbackHijack },
            tools: { git, pnpm },
            profile,
            trustLadder: trust,
            settings: publicSettings(state.settings),
            notes: buildHealthNotes({ api, npm, dnsApi, loopbackHijack, hosts, git, pnpm }),
          })
          return
        }

        if (method === 'GET' && tail === '/bundles') {
          const pm = pluginManagerOf()
          if (!pm) { sendJson(res, 200, { ok: false, available: false, error: '插件管理器（pluginManager）在当前 profile 不可用' }); return }
          const out = { ok: true, available: true, profile: profileInfo() }
          try { out.bundles = await pm.listBundles() } catch (err) { out.bundlesError = String((err && err.message) || err) }
          try { out.plugins = await pm.listPlugins() } catch (err) { out.pluginsError = String((err && err.message) || err) }
          try { out.registries = await pm.registries() } catch (err) { out.registriesError = String((err && err.message) || err) }
          sendJson(res, 200, out)
          return
        }

        if (method === 'GET' && tail === '/search') {
          const state = readState()
          const { token } = await readToken()
          const source = url.searchParams.get('source') === 'npm' ? 'npm' : 'github'
          const query = url.searchParams.get('q') || ''
          const page = Number(url.searchParams.get('page') || 1)
          const sort = url.searchParams.get('sort') || 'best-match'
          try {
            const result = source === 'npm'
              ? await searchNpm({ query, page, registry: url.searchParams.get('registry') || state.settings.npmSearchRegistry })
              : await searchGithub({ query, page, sort, token })
            sendJson(res, 200, { ok: true, ...result, authenticated: !!token })
          } catch (err) {
            sendJson(res, 200, { ok: false, source, error: String((err && err.message) || err), code: String(err.code || 'ERROR'), hint: err.hint ? String(err.hint) : '' })
          }
          return
        }

        if (method === 'GET' && tail === '/install/progress') {
          const requestId = String(url.searchParams.get('requestId') || '')
          const since = Math.max(0, Number(url.searchParams.get('since') || 0))
          const feed = installFeed.get(requestId)
          if (!feed) { sendJson(res, 200, { ok: false, error: 'unknown requestId' }); return }
          sendJson(res, 200, {
            ok: true,
            requestId,
            phase: feed.phase,
            spec: feed.spec,
            attempt: feed.attempt || null,
            logs: feed.logs.slice(since),
            next: feed.logs.length,
            done: !!feed.result,
            result: feed.result,
            startedAt: feed.startedAt,
            finishedAt: feed.finishedAt,
          })
          return
        }

        // —— 写入 ——
        if (method !== 'POST') {
          // 只读方法没匹配到路径 = 接口不存在（404）；其它方法才是方法不允许（405）。
          const readOnly = method === 'GET' || method === 'HEAD'
          sendJson(res, readOnly ? 404 : 405, { ok: false, error: readOnly ? `未知接口 ${tail}` : `${method} 不支持` })
          return
        }

        let body
        try { body = await readBody(req) } catch (err) { sendJson(res, 400, { ok: false, error: String((err && err.message) || err) }); return }

        if (tail === '/login/token') {
          const token = String(body.token || '').trim()
          if (!token) { sendJson(res, 400, { ok: false, error: '缺少令牌' }); return }
          try {
            const account = await fetchAccount(token)
            const state = readState()
            await saveToken({
              token,
              login: account.login,
              name: account.name,
              avatar: account.avatar,
              profile: account.profile,
              scopes: account.scopes,
              method: 'pat',
              savedAt: new Date().toISOString(),
            })
            appendHistory(state, {
              action: 'login', method: 'pat', login: account.login, avatar: account.avatar,
              scopes: account.scopes, note: String(body.note || ''),
            })
            sendJson(res, 200, { ok: true, account: publicAccount({ token, ...account, method: 'pat', savedAt: new Date().toISOString() }), history: readState().history })
          } catch (err) {
            sendJson(res, 200, { ok: false, error: String((err && err.message) || err), code: String(err.code || 'ERROR'), hint: err.hint ? String(err.hint) : '' })
          }
          return
        }

        if (tail === '/login/device/start') {
          const state = readState()
          const clientId = String(body.clientId || state.settings.deviceClientId || '').trim()
          const scope = String(body.scope || state.settings.deviceScope || '').trim()
          if (!clientId) { sendJson(res, 200, { ok: false, error: '需要先填写 OAuth App 的 client_id', code: 'NO_CLIENT_ID' }); return }
          state.settings.deviceClientId = clientId
          state.settings.deviceScope = scope
          writeState(state)
          try {
            const res2 = await requestWithLadder(`${GITHUB_WEB}/login/device/code`, {
              method: 'POST',
              headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
              body: JSON.stringify({ client_id: clientId, scope }),
            })
            const json = res2.json || {}
            if (res2.status >= 400 || json.error) {
              sendJson(res, 200, { ok: false, error: String(json.error_description || json.error || `HTTP ${res2.status}`), code: 'DEVICE_START' })
              return
            }
            sendJson(res, 200, {
              ok: true,
              deviceCode: String(json.device_code || ''),
              userCode: String(json.user_code || ''),
              verificationUri: String(json.verification_uri || 'https://github.com/login/device'),
              expiresIn: Number(json.expires_in || 900),
              interval: Number(json.interval || 5),
              tls: res2.tls,
            })
          } catch (err) {
            sendJson(res, 200, { ok: false, error: String((err && err.message) || err), code: String(err.code || 'ERROR'), hint: err.hint ? String(err.hint) : '' })
          }
          return
        }

        if (tail === '/login/device/poll') {
          const state = readState()
          const clientId = String(body.clientId || state.settings.deviceClientId || '').trim()
          const deviceCode = String(body.deviceCode || '').trim()
          if (!clientId || !deviceCode) { sendJson(res, 200, { ok: false, error: '缺少 client_id 或 device_code', code: 'BAD_REQUEST' }); return }
          try {
            const res2 = await requestWithLadder(`${GITHUB_WEB}/login/oauth/access_token`, {
              method: 'POST',
              headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
              body: JSON.stringify({ client_id: clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
            })
            const json = res2.json || {}
            if (json.access_token) {
              const account = await fetchAccount(String(json.access_token))
              await saveToken({
                token: String(json.access_token),
                login: account.login,
                name: account.name,
                avatar: account.avatar,
                profile: account.profile,
                scopes: (json.scope ? String(json.scope).split(',').map((s) => s.trim()).filter(Boolean) : account.scopes),
                method: 'device',
                savedAt: new Date().toISOString(),
              })
              appendHistory(state, { action: 'login', method: 'device', login: account.login, avatar: account.avatar, scopes: account.scopes })
              sendJson(res, 200, { ok: true, status: 'ok', account: publicAccount({ token: String(json.access_token), ...account, method: 'device', savedAt: new Date().toISOString() }), history: readState().history })
              return
            }
            const error = String(json.error || '')
            const status = error === 'authorization_pending' ? 'pending'
              : error === 'slow_down' ? 'slow_down'
                : error === 'expired_token' ? 'expired'
                  : error === 'access_denied' ? 'denied'
                    : 'error'
            sendJson(res, 200, { ok: true, status, error: String(json.error_description || error || `HTTP ${res2.status}`), interval: Number(json.interval || 0) })
          } catch (err) {
            sendJson(res, 200, { ok: false, error: String((err && err.message) || err), code: String(err.code || 'ERROR') })
          }
          return
        }

        if (tail === '/logout') {
          const { record } = await readToken()
          await dropToken()
          const state = readState()
          appendHistory(state, {
            action: 'logout',
            method: record ? String(record.method || '') : '',
            login: record ? String(record.login || '') : '',
            avatar: record ? String(record.avatar || '') : '',
          })
          sendJson(res, 200, { ok: true, account: { loggedIn: false }, history: readState().history })
          return
        }

        if (tail === '/history/clear') {
          const state = readState()
          state.history = []
          writeState(state)
          sendJson(res, 200, { ok: true, history: [] })
          return
        }

        if (tail === '/settings') {
          const state = readState()
          const patch = body && typeof body === 'object' ? body : {}
          if (typeof patch.trustLocalInterceptor === 'boolean') state.settings.trustLocalInterceptor = patch.trustLocalInterceptor
          if (typeof patch.npmSearchRegistry === 'string' && patch.npmSearchRegistry.trim()) state.settings.npmSearchRegistry = patch.npmSearchRegistry.trim()
          if (typeof patch.deviceClientId === 'string') state.settings.deviceClientId = patch.deviceClientId.trim()
          if (typeof patch.deviceScope === 'string') state.settings.deviceScope = patch.deviceScope.trim()
          writeState(state)
          sendJson(res, 200, { ok: true, settings: publicSettings(state.settings) })
          return
        }

        if (tail === '/repo/package') {
          try {
            const info = await inspectRepoPackage({ repo: body.repo, ref: body.ref })
            sendJson(res, 200, { ok: true, info })
          } catch (err) {
            sendJson(res, 200, { ok: false, error: String((err && err.message) || err), code: String(err.code || 'ERROR') })
          }
          return
        }

        if (tail === '/inspect') {
          const pm = pluginManagerOf()
          if (!pm) { sendJson(res, 200, { ok: false, error: '插件管理器不可用' }); return }
          const spec = String(body.spec || '').trim()
          if (!spec) { sendJson(res, 400, { ok: false, error: '缺少 spec' }); return }
          try {
            const inspection = await pm.inspect(spec)
            sendJson(res, 200, { ok: true, inspection })
          } catch (err) {
            sendJson(res, 200, { ok: false, error: String((err && err.message) || err), code: String(err.code || 'ERROR') })
          }
          return
        }

        if (tail === '/install') {
          const pm = pluginManagerOf()
          if (!pm) { sendJson(res, 200, { ok: false, error: '插件管理器（pluginManager）不可用，无法安装' }); return }
          const spec = toHttpsGitSpec(body.spec)
          if (!spec) { sendJson(res, 400, { ok: false, error: '缺少安装 spec' }); return }
          const requestId = String(body.requestId || `gh-${randomUUID()}`)
          const feed = feedOf(requestId)
          feed.spec = spec
          feed.phase = 'installing'
          const options = { enabled: body.enabled !== false, requestId }
          if (Array.isArray(body.approvedBuilds) && body.approvedBuilds.length > 0) options.approvedBuilds = body.approvedBuilds.map(String)
          if (body.registry) options.registry = String(body.registry)
          try {
            const result = await pm.installBundle(spec, options)
            feed.result = result
            feed.phase = 'done'
            feed.finishedAt = Date.now()
            if (result && result.bundle) feed.bundle = String(result.bundle)
            sendJson(res, 200, { ok: !(result && result.error), requestId, spec, result })
          } catch (err) {
            const failure = { stage: 'install', target: spec, application: 'failed', changed: false, error: { code: 'operation-error', diagnostic: String((err && err.message) || err) } }
            feed.result = failure
            feed.phase = 'failed'
            feed.finishedAt = Date.now()
            sendJson(res, 200, { ok: false, requestId, spec, result: failure, error: String((err && err.message) || err), code: String(err.code || 'ERROR') })
          }
          return
        }

        if (tail === '/install/cancel') {
          const pm = pluginManagerOf()
          if (!pm) { sendJson(res, 200, { ok: false, error: '插件管理器不可用' }); return }
          const requestId = String(body.requestId || '')
          if (!requestId) { sendJson(res, 400, { ok: false, error: '缺少 requestId' }); return }
          try {
            const cancellation = await pm.cancelInstall(requestId)
            sendJson(res, 200, { ok: true, cancellation })
          } catch (err) {
            sendJson(res, 200, { ok: false, error: String((err && err.message) || err) })
          }
          return
        }

        if (tail === '/install/result') {
          const pm = pluginManagerOf()
          if (!pm) { sendJson(res, 200, { ok: false, error: '插件管理器不可用' }); return }
          const requestId = String(body.requestId || '')
          if (!requestId) { sendJson(res, 400, { ok: false, error: '缺少 requestId' }); return }
          try {
            const result = await pm.waitForInstall(requestId)
            sendJson(res, 200, { ok: true, result })
          } catch (err) {
            sendJson(res, 200, { ok: false, error: String((err && err.message) || err) })
          }
          return
        }

        if (tail === '/bundle/enabled') {
          const pm = pluginManagerOf()
          if (!pm) { sendJson(res, 200, { ok: false, error: '插件管理器不可用' }); return }
          const name = String(body.name || '').trim()
          if (!name) { sendJson(res, 400, { ok: false, error: '缺少 bundle 名' }); return }
          try {
            const result = await pm.setBundleEnabled(name, body.enabled !== false)
            sendJson(res, 200, { ok: !(result && result.error), result })
          } catch (err) {
            sendJson(res, 200, { ok: false, error: String((err && err.message) || err) })
          }
          return
        }

        if (tail === '/bundle/remove') {
          const pm = pluginManagerOf()
          if (!pm) { sendJson(res, 200, { ok: false, error: '插件管理器不可用' }); return }
          const name = String(body.name || '').trim()
          if (!name) { sendJson(res, 400, { ok: false, error: '缺少 bundle 名' }); return }
          try {
            const result = await pm.removeBundle(name)
            sendJson(res, 200, { ok: !(result && result.error), result })
          } catch (err) {
            sendJson(res, 200, { ok: false, error: String((err && err.message) || err) })
          }
          return
        }

        if (tail === '/plugin/enabled') {
          const pm = pluginManagerOf()
          if (!pm) { sendJson(res, 200, { ok: false, error: '插件管理器不可用' }); return }
          try {
            const result = await pm.setPluginEnabled(String(body.id || ''), body.enabled !== false)
            sendJson(res, 200, { ok: !(result && result.error), result })
          } catch (err) {
            sendJson(res, 200, { ok: false, error: String((err && err.message) || err) })
          }
          return
        }

        sendJson(res, 404, { ok: false, error: `未知接口 ${tail}` })
      }

      ctx.effect(() => ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          let url
          try { url = new URL(req.url || '/', 'http://127.0.0.1') } catch (err) {
            sendJson(res, 400, { ok: false, error: '非法请求路径' })
            return
          }
          try {
            await handle(req, res, url)
          } catch (err) {
            sendJson(res, 500, { ok: false, error: String((err && err.stack) || err) })
          }
        },
      }), 'dsh-github-hub: routes')

      log(ctx, `已挂载 ${ROUTE_PREFIX}/*（profile=${profileInfo().name || '?'}）`)
    })
  },
}

/* ------------------------------------------------------------------ *
 * 设置下发（不含敏感字段）与诊断文案
 * ------------------------------------------------------------------ */

function publicSettings(settings) {
  return {
    trustLocalInterceptor: !!settings.trustLocalInterceptor,
    npmSearchRegistry: String(settings.npmSearchRegistry || DEFAULT_NPM_SEARCH),
    deviceClientId: String(settings.deviceClientId || ''),
    deviceScope: String(settings.deviceScope || ''),
    stateFile: STATE_FILE,
    credentialKey: CREDENTIAL_KEY,
  }
}

function buildHealthNotes({ api, npm, dnsApi, loopbackHijack, hosts, git, pnpm }) {
  const notes = []
  if (loopbackHijack) {
    notes.push(`本机 hosts（${hosts.file || '未找到'}）里有 ${hosts.entries.filter((e) => isLoopbackHostname(e.ip)).length} 条 GitHub 域名指向回环地址的记录 —— 通常由 GitHub 加速器（Watt Toolkit / Steam++ 等）写入。插件会按「信任阶梯」穿过它。`)
  }
  if (dnsApi.loopback) notes.push('api.github.com 当前解析到 127.0.0.1：请求实际由本机加速器的反向代理转发。')
  if (api.ok) {
    notes.push(`GitHub API 可达（信任级别：${api.tls}${api.tls === 'local-interceptor' ? '，已跳过证书校验' : ''}），核心配额剩余 ${api.coreRemaining}/${api.coreLimit}。`)
    if (!api.authenticated) notes.push('当前未登录：搜索接口配额较低（约 10 次/分钟），登录后提升到 30 次/分钟。')
  } else {
    notes.push(`GitHub API 不可达：${api.message}${api.hint ? ` —— ${api.hint}` : ''}`)
  }
  if (npm.ok) notes.push(`npm 搜索源可达：${npm.registry}`)
  else notes.push(`npm 搜索源不可达：${npm.message || '未知错误'}`)
  if (!git.ok) notes.push('未检测到 git：从 GitHub 仓库安装插件（github:owner/repo）需要 git 在 PATH 中。')
  if (!pnpm.ok) notes.push('未在 PATH 里发现 pnpm：安装/卸载由 dsh 宿主的包管理器执行（桌面端即自带运行时），通常不影响使用；命令行卸载则需 pnpm。')
  else if (pnpm.managed) notes.push(`安装/卸载由宿主包管理器执行：${pnpm.command}`)
  return notes
}