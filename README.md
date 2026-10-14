# dsh-github-hub — a GitHub plugin hub for DeepSeek Harness

A native DSH panel (host half + browser half) that signs in to your GitHub account, keeps a
sign-in history, searches GitHub / npm for `deepseek-harness` (`dsh-plugin`) plugins, and installs
them into the current profile with one click — through exactly the same path as
**Settings → Plugins** and `dsh plugin add`.

Chinese documentation: [README.zh.md](./README.zh.md)

---

## What it adds

* **Discover** — search GitHub repositories (`topic:dsh-plugin`, `topic:deepseek-harness`,
  `dsh-plugin in:name,description,readme`, …) or npm packages (`keywords:dsh-plugin`).
  *Inspect* reads the repository's `package.json` and tells you whether it really is an
  installable DSH plugin (does it declare `dsh.bundle.patch`? does it ship a `dsh.client` half?).
  *Install* runs the profile's own pnpm path with a live log, cancel support, and an
  "allow the blocked build scripts and retry" button when pnpm withholds lifecycle scripts.
* **Installed** — the profile's bundles and plugin rows, with enable / disable / remove,
  load errors and read-only reasons.
* **Account** — sign in with a **Personal Access Token** or **OAuth Device Flow**
  (bring your own OAuth App `client_id`; no client secret needed). Sign-in / sign-out history
  is persisted and can be cleared.
* **Diagnostics** — a connectivity report for the GitHub API, npm, DNS, the hosts file, `git`
  and `pnpm`, plus which rung of the TLS trust ladder the current requests use.

## Install

```sh
dsh plugin --profile desktop add dsh-github-hub
# local development
dsh plugin --profile desktop add link:/absolute/path/to/dsh-github-hub
```

Then **restart the desktop app** — reloading the page is not enough, because DSH collects its boot
injection table once per host start, and a new plugin's client bundle only enters that manifest on
the next start (the web profile needs its `dsh web` process restarted for the same reason).
A **git-branch icon** then appears in the left sidebar and opens the panel in the central area.

## Read-only endpoints

Beyond the panel, the host half exposes a few read-only endpoints for troubleshooting (all require
the browser session cookie):

| Endpoint | Purpose |
|---|---|
| `GET /dsh-github/state` | account, settings, sign-in history, trust ladder, client-bundle graph state |
| `GET /dsh-github/health` | GitHub API, npm, DNS, hosts, git, pnpm checks plus plain-language notes |
| `GET /dsh-github/client` | the graph `rev` and real URL of the client bundle, next to the `rev` computed from the file on disk (a mismatch means edits are not loaded yet) |
| `GET /dsh-github/search?source=github\|npm&q=…` | search |
| `POST /dsh-github/repo/package` | read a repository's `package.json` and judge it |
| `POST /dsh-github/inspect` | pre-flight one spec through the real plugin manager (performs the GitHub connection check, installs nothing) |

## Verified on this machine

* the GitHub API is reachable through the local accelerator at `tls=default` (144 system roots were
  merged into the process default chain at startup), so no insecure rung was needed;
* `pnpm add github:<owner>/<repo>` and `pnpm add git+https://github.com/<owner>/<repo>.git` both
  fetch and link a real package (37s and 19s, peer dependencies included);
* the official pipeline `pluginManager.installBundle` completed end to end for a `link:` spec
  (pnpm log events → progress polling → bundle activation);
* `POST /inspect` on `github:<owner>/<repo>` returns `{status:'accepted', kind:'git', host:'github.com'}`;
* the fences hold: authenticated 200, no cookie 401, `sec-fetch-site: cross-site` 403.

## Signing in

* **Token (recommended)** — create one at <https://github.com/settings/tokens> with `read:user`
  (add `repo` for private repositories) and paste it into the panel.
  It is stored in the DSH credential service as the record `dsh-github-hub/github`
  (kind `grant`) and is **never** sent to the page; the UI only shows login, avatar, scopes and
  the last four characters.
* **Device flow** — create an OAuth App (no client secret required), paste its `client_id`,
  start the flow, enter the one-time code at <https://github.com/login/device>.

## Data

| Item | Location |
|---|---|
| GitHub token | DSH credential service (record `dsh-github-hub/github`) |
| Settings + sign-in history | `$DSH_HOME/.dsh-github-hub.json` (no token, max 200 entries) |
| Install logs | `$DSH_PROFILE_DIR/.plugin-manager/logs/operation-*/pnpm.log` |

All endpoints live under `ctx.webServer` at `/dsh-github/*` behind three fences: loopback (or
explicitly trusted) Host, no cross-site requests, and write requests accepted only from the
local machine.

## GitHub behind a local interceptor

Accelerators such as Watt Toolkit / Steam++ rewrite `github.com`, `api.github.com` and
`raw.githubusercontent.com` to `127.0.0.1` and re-serve them through a local reverse proxy with
its own CA, which Node does not trust by default (`unable to verify the first certificate`).
This plugin walks a trust ladder instead of failing:

1. default trust chain;
2. default roots **plus** the operating system root store (equivalent to `node --use-system-ca`);
3. trust the local interceptor — only when the peer genuinely resolves to loopback **and** the
   setting is enabled, and the UI always reports `tls: local-interceptor` when it happens.

Installing from GitHub uses pnpm's `github:owner/repo` (git) transport, so **`git` must be on
PATH**; the plugin manager performs a bounded connection check before pnpm starts.

## Known limits

* A freshly installed plugin usually still needs an app restart (or page reload) before its
  sidebar icon appears — DSH collects the index injection table once at startup.
* Installing a third-party plugin executes third-party host code inside your DSH process.
  The panel shows repository metadata and the `package.json` verdict, but does not audit code.
* Removing a bundle does not delete data files the third-party plugin wrote under `$DSH_HOME`.

## License

MIT — see [LICENSE](./LICENSE).