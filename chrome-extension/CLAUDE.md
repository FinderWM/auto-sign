# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

Chrome MV3 扩展「公益站自动签到助手」：管理多个公益 API 站点的每日签到，支持 NewAPI / Sub2API / ZenAPI / Infinite Canvas / DEEIX Chat / LocalAPI / points-checkin（Cookie 会话 + `/api/points/checkin`）/ Sota Agent（独立鉴权分支）接口签到、页面按钮兜底签到、仅访问模式。功能清单、签到流程、站点类型、权限说明、逐文件用途见 `README.md`——本文件只记录需要跨多文件阅读才能掌握的架构与非显而易见的工作约定。

## 开发命令

无构建步骤、无打包、无第三方运行依赖、**非 git 仓库**。所有 `.js` 为 MV3/浏览器手写脚本。改完在 `chrome://extensions` 重新加载扩展即生效。

> 注：当前仅使用 Node 内置测试运行器覆盖独立模块，不存在完整的浏览器自动化测试套件。

- 语法校验（本地无依赖可跑）：`node --check background.js`、`node --check popup.js`，可对任意 `.js` 重复执行。
- Sota Agent 契约测试：`node --test tests/sota-agent.test.js`。
- 验证签到逻辑需在真实 Chrome 加载扩展，观察 service worker 控制台（`chrome://extensions` → 扩展 →「service worker」链接）的日志。

## 架构（big picture）

### 模块加载

`background.js`（MV3 service worker，单文件 ~113KB）顶部用 `importScripts(...)` 按**固定顺序**加载全部辅助模块。顺序敏感（存在依赖链，如签到编排依赖 `page-status.js` 的错误类型、`checkin-run-state.js` 的状态工具）。新增模块必须追加到 `importScripts` 列表且置于其依赖之后。模块统一用 `(function(root){...})(self)` 挂全局，多数附 `module.exports` 以便 `node --check`。

### 站点类型探测与分发

配置中 `type: 'auto'` 的站点，首次签到由 `detectSiteType`（URL 提示 + 页面探测）识别为 `newapi`/`sub2api`/`zenapi`/`infinite-canvas`/`deeix-chat`/`localapi`/`points-checkin`/`sota-agent` 等并持久化回配置。`checkInSite` 优先通过 `SITE_TYPE_CHECK_IN_HANDLERS` 按类型分发到专用 handler，未命中则走默认 NewAPI 路径；`mode === 'visit'` 走 `visitSite`（仅访问页面、读余额）。新增站点协议时优先新增 type + handler + config 映射，避免扩张默认 NewAPI 流程。

`sota-agent` 仅对精确域名 `www.sotamodel.net` 生效。专用 handler 在 `/agents` 页面内读取 `localStorage.uid`，以 `New-Api-User` 请求头调用 `GET/POST /api/user/sota-agent-checkin`；它不调用 NewAPI 的缓存认证、`/auth/refresh` 或 OAuth 分支。

`localapi` 通过 `x-user-token` 调用 `/user/api/checkin`，`points-checkin` 则是 Cookie 会话 + `/api/auth/linuxdo/start` + `/api/points/checkin` 协议，两者不能混用。

### 认证三级回退

取认证头（`getNewApiAuthHeaders` 等）顺序：加密缓存（`authHeadersCache`，由 `auth-cache-crypto.js` 加解密）→ 浏览器已有登录态（cookies / 页面 storage）→ linux.do OAuth。遇 Cloudflare 拦截（403 / Just a moment）切到 `doCheckInRequest` 的 fetch-in-tab 路径，在页面上下文发请求绕过。401 清缓存后按同序重试一次。

### 运行编排与重试（核心状态机）

- 两条独立通道：`batchCheckIn`（批量，manual/schedule 单实例）与 `singleSiteCheckIns`（`Map<siteId>`，单站重试）。**完全独立并发**，互不阻塞，仅同站防重入（`isSiteBusy`）。
- 共用 `runSiteCheckInWithRetries`：最多 3 次尝试，单次受 `withTimeout` 90s 硬超时保护；签到请求另有 30s `AbortController` 超时（`SITE_FETCH_TIMEOUT_MS`）防止 fetch 挂起 keepalive 拖垮 worker。成功/已签/失效立即返回，仅 `failed` 重试。
- 批量 `executeAllCheckIns` 每站失败只记 failed 并 `continue`——**任何单站异常都不中断后续站点**（`runSiteCheckInWithRetries` 内部全 try/catch，绝不向外抛）。
- 改这条编排链路时必须守住「单站失败不传染」这一不变量。

### 状态持久化与 MV3 worker 回收

- storage key：`checkInRunState`（**仅批量**运行态；单站重试不翻转它）、`checkInResults`（每站结果，单站只写这里）、`authHeadersCache`（加密）、`userSites`、`autoSignTime`。
- 单站重试只把 `checkInResults[siteId]` 置 `checking` → 最终结果，不触发批量按钮的 running 态。
- MV3 worker 随时被回收：`recoverStaleCheckInState`（worker 重建时执行）+ `normalizeCheckInResultsForRun`（getStatus 时执行）把残留 `running:true` / `checking` 规整为 `failed` / `签到中断`，避免 UI 卡死。任何新增异步长任务都要确保能被这套规整逻辑兜底。

### 临时标签页会话

`createSiteTabSession` 为每次签到尝试提供独立、可复用的后台 tab；`runContext.tabSession` 指向当前活动会话，cancel 时即时关闭以中止当次尝试。页面读取/按钮点击/余额抓取均通过 `chrome.scripting.executeScript` 注入页面上下文执行。

### popup ↔ background 通信

popup 经 `chrome.runtime.sendMessage` 触发 `manualCheckIn` / `retrySiteCheckIn` / `cancelCheckIn` / `getStatus` / `importCurrentSite`；逐站状态实时刷新依赖 `chrome.storage.onChanged` 监听 `checkInResults` 变化重渲染（`render-guard.js` 防并发渲染）。

## 工作约定

### 版本号递增

- 每完成一次实质性代码修改，将 `manifest.json` 的 `version` 末段 +1（如 `1.23` → `1.24`），并同步更新 `version_name`。
- 原因：扩展代码改动必须 reload 才生效，版本号是确认「已加载到最新代码」的唯一可见标志；不递增则无法区分 reload 的是哪一轮改动，验证时易误判。
- 页脚版本号同步：popup 启动时 `popup.js` 用 manifest 版本动态覆盖 `#versionFooter`；每次递增版本时仍须同步修改 `popup.html` 的兜底文本，确保 popup JavaScript 未执行时也显示正确版本。
- 验证前提示用户在 `chrome://extensions` reload，并确认显示的新版本号。纯文档/注释类改动可酌情跳过。

### 新增站点类型：必须同步页面签到按钮识别

新增站点类型时，除签到协议（type + handler + `config.js`/`site-url.js` 映射 + `detectSiteType`）外，**页面签到按钮的识别要一并适配**，否则两条链路会静默失效、且没有报错：

- **入口注入**：`import-entry.js` 的「加入签到助手」按钮由 `ensureEntry` → `findCheckInButton` 触发；找不到该站签到按钮就不注入，用户无法从页面一键加入。
- **页面点击兜底**：`useApi=false`（含接口失效回退）时，`background.js` 的 `checkInFromOfficialPage` 注入版 `findCheckInButton` 负责找按钮并点击；找不到即页面签到失败。

两处 `findCheckInButton` 默认靠文案启发式（`import-entry.js` 的 `CHECKIN_TEXT` / background 注入版的 `matchesCheckInText`，多为 `^签到$` 精确锚定）。当目标站按钮是**动态文案**（如皮皮智绘「签到 +100~200」）、纯图标或非常规文案时启发式会漏，必须按域名加**稳定选择器特例**（如 `#checkinBtn` / `[data-act="checkin"]`），参考 `IS_SOTA_AGENT_PAGE`（`www.sotamodel.net`）、`IS_PIPI_STUDIO_PAGE`（`img.pipiwangcom.com`）。同时确认已签态文案能被 `matchesAlreadyCheckedText` / `findCheckedInStateText` 命中，避免已签站被反复点击。
