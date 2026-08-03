let currentRunState = { running: false };
let addingSite = false;
const sitesRenderGuard = createLatestRenderGuard();
let singleSiteRunningIds = new Set();
let singleSiteCancellingIds = new Set();

// 页面加载时初始化
document.addEventListener('DOMContentLoaded', () => {
  loadStatus();
  setupEventListeners();
  chrome.storage.onChanged.addListener(handleStorageChange);
  const manifest = chrome.runtime.getManifest();
  const v = manifest.version_name || manifest.version;
  const footer = document.getElementById('versionFooter');
  if (footer) footer.textContent = `v${v}`;
});

function setupEventListeners() {
  document.getElementById('checkInBtn').addEventListener('click', handleManualCheckIn);
  document.getElementById('resumeBtn').addEventListener('click', handleResumeCheckIn);
  document.getElementById('showAddBtn').addEventListener('click', () => {
    document.getElementById('addForm').classList.toggle('show');
    document.getElementById('newDomain').focus();
  });
  document.getElementById('confirmAddBtn').addEventListener('click', handleAddSite);
  document.getElementById('cancelAddBtn').addEventListener('click', () => {
    document.getElementById('addForm').classList.remove('show');
    resetAddForm();
  });
  document.getElementById('newDomain').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAddSite();
  });

  // 导出/导入
  document.getElementById('exportBtn').addEventListener('click', handleExport);
  document.getElementById('importBtn').addEventListener('click', () => {
    document.getElementById('importFile').click();
  });
  document.getElementById('importFile').addEventListener('change', handleImport);
  document.getElementById('saveTimeBtn').addEventListener('click', handleSaveAutoSignTime);
  document.getElementById('clearLogsBtn').addEventListener('click', handleClearLogs);
}

// 加载签到状态
function loadStatus() {
  chrome.runtime.sendMessage({ action: 'getStatus' }, (response) => {
    if (response) {
      const results = response.checkInResults || {};
      currentRunState = getCheckInRunState({ checkInRunState: response.checkInRunState });
      syncSingleSiteRunState(response);
      updateStats(results);
      renderLogs(response.checkInLogs || []);
      renderSites(results);
    }
    if (response?.lastCheckInTime) {
      document.getElementById('lastCheck').textContent =
        `上次签到: ${formatDateTime(new Date(response.lastCheckInTime))}`;
    }
    if (response?.autoSignTime) {
      setAutoSignTimeDisplay(response.autoSignTime);
    }
  });
}

function handleStorageChange(changes, areaName) {
  if (areaName !== 'local') return;

  if (changes.checkInLogs) {
    renderLogs(changes.checkInLogs.newValue || []);
  }

  if (changes.checkInResults) {
    const results = changes.checkInResults.newValue || {};
    pruneSingleSiteRunStateByResults(results);
    updateStats(results);
    renderSites(results, { preserveScroll: true });
  }

  if (changes.checkInRunState) {
    const previousRunning = isCheckInRunningState(currentRunState);
    currentRunState = getCheckInRunState({ checkInRunState: changes.checkInRunState.newValue });
    updateCheckInButtonState();
    const nextRunning = isCheckInRunningState(currentRunState);
    const previousCancelling = changes.checkInRunState.oldValue?.cancelling === true;
    const nextCancelling = changes.checkInRunState.newValue?.cancelling === true;
    if (previousRunning !== nextRunning || previousCancelling !== nextCancelling) {
      renderSites(undefined, { preserveScroll: true });
    }
  }

  if (changes.userSites) {
    renderSites(undefined, { preserveScroll: true });
  }

  if (changes.lastCheckInTime?.newValue) {
    document.getElementById('lastCheck').textContent =
      `上次签到: ${formatDateTime(new Date(changes.lastCheckInTime.newValue))}`;
  }
}

function renderLogs(logs) {
  const output = document.getElementById('logOutput');
  if (!output) return;
  const rawLogs = Array.isArray(logs) ? logs : [];
  const lines = [];
  let previousSiteName = '';

  for (const rawLog of rawLogs) {
    const entry = parseCheckInLogEntry(rawLog);
    if (!entry) continue;
    if (previousSiteName && previousSiteName !== entry.siteName) {
      lines.push('----------');
    }
    lines.push(`[${entry.siteName}][${entry.loginStatus}][${entry.time}]`);
    lines.push(entry.message);
    previousSiteName = entry.siteName;
  }

  output.value = lines.join('\n');
  output.scrollTop = output.scrollHeight;
}

function parseCheckInLogEntry(rawLog) {
  const text = String(rawLog || '').trim();
  if (!text) return null;
  const matched = text.match(/^\[(.*?)\]\[(.*?)\]\[(.*?)\]\s*(.*)$/);
  if (!matched) {
    return {
      siteName: '系统',
      loginStatus: '未知',
      time: '--',
      message: text
    };
  }
  return {
    siteName: matched[1] || '系统',
    loginStatus: matched[2] || '未知',
    time: matched[3] || '--',
    message: matched[4] || '暂无内容'
  };
}

async function handleClearLogs() {
  try {
    await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'clearCheckInLogs' }, (response) => {
        if (response?.success) resolve(response);
        else reject(new Error(response?.error || '清空日志失败'));
      });
    });
  } catch (error) {
    alert('清空日志失败: ' + error.message);
  }
}

function syncSingleSiteRunState(data = {}) {
  singleSiteRunningIds = new Set(Array.isArray(data.singleSiteRunningIds) ? data.singleSiteRunningIds : []);
  singleSiteCancellingIds = new Set(Array.isArray(data.singleSiteCancellingIds) ? data.singleSiteCancellingIds : []);
  for (const siteId of Array.from(singleSiteCancellingIds)) {
    if (!singleSiteRunningIds.has(siteId)) {
      singleSiteCancellingIds.delete(siteId);
    }
  }
}

function pruneSingleSiteRunStateByResults(results = {}) {
  const activeCheckingIds = new Set(
    Object.entries(results || {})
      .filter(([, result]) => result?.status === 'checking')
      .map(([siteId]) => siteId)
  );
  for (const siteId of Array.from(singleSiteRunningIds)) {
    if (!activeCheckingIds.has(siteId)) {
      singleSiteRunningIds.delete(siteId);
      singleSiteCancellingIds.delete(siteId);
    }
  }
}

function shouldHighlightHumanVerification(result) {
  if (!result || typeof result.message !== 'string') return false;
  if (result.status !== 'failed' && result.status !== 'invalid') return false;
  return /人机验证|安全验证|Turnstile|captcha|验证码|请完成验证|verify you are human/i.test(result.message);
}

// 渲染站点列表
const UNGROUPED_LABEL = '默认';
let sortableInstances = [];
let activeGroup = null;
let draggingDomain = null;
let tabDropHandled = false;

async function renderSites(results, { preserveScroll = false } = {}) {
  const renderToken = sitesRenderGuard.begin();
  const scrollContainer = document.scrollingElement || document.documentElement;
  const scrollTop = preserveScroll ? scrollContainer.scrollTop : 0;
  const sites = await loadRawSites();

  // 如果没传 results，从 storage 读取上次结果
  if (!results) {
    const data = await chrome.storage.local.get('checkInResults');
    results = data.checkInResults || {};
  }

  if (!sitesRenderGuard.isCurrent(renderToken)) return;

  const sitesList = document.getElementById('sitesList');
  document.getElementById('totalSites').textContent = sites.length;
  updateCheckInButtonState(sites);

  destroySortables();

  if (sites.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '暂无站点，添加后即可开始签到';
    sitesList.replaceChildren(empty);
    return;
  }

  function buildItem(site) {
    const siteId = getRawSiteId(site);
    const result = results[siteId];
    const enabled = site.enabled !== false;
    const batchRunning = isCheckInRunningState(currentRunState);
    const singleSiteRunning = singleSiteRunningIds.has(siteId);
    const singleSiteCancelling = singleSiteCancellingIds.has(siteId);

    const item = document.createElement('div');
    item.className = 'site-item';
    item.dataset.domain = site.domain;
    if (!enabled) item.style.opacity = '0.5';

    const content = document.createElement('div');
    content.className = 'site-content';

    const primaryRow = document.createElement('div');
    primaryRow.className = 'site-primary-row';

    const secondaryRow = document.createElement('div');
    secondaryRow.className = 'site-secondary-row';

    const meta = document.createElement('div');
    meta.className = 'site-meta';

    // 拖拽手柄
    const handle = document.createElement('span');
    handle.className = 'drag-handle';
    handle.textContent = '⠿';
    handle.title = '拖拽排序或拖到其他分组';

    // 开关
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.className = 'toggle';
    toggle.checked = enabled;
    toggle.title = enabled ? '点击禁用' : '点击启用';
    toggle.addEventListener('change', () => toggleSiteByDomain(site.domain, toggle.checked));

    // 站点名
    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'site-name site-link';
    name.textContent = site.name || site.domain;
    name.title = `打开 ${getSitePageUrl(site)}`;
    name.addEventListener('click', () => openSitePage(site));

    if (shouldHighlightHumanVerification(result)) {
      const verificationHint = document.createElement('span');
      verificationHint.className = 'site-alert-badge human-verification';
      verificationHint.textContent = '需人机验证';
      verificationHint.title = result.message;
      primaryRow.appendChild(name);
      primaryRow.appendChild(verificationHint);
    } else {
      primaryRow.appendChild(name);
    }

    // 状态
    const canRetry = enabled && canRetrySiteStatus(result?.status);
    const status = document.createElement(canRetry ? 'button' : 'span');
    status.className = 'site-status';
    if (canRetry) {
      status.type = 'button';
      status.classList.add('retryable');
      status.title = result?.message ? `${result.message}，点击重试` : '点击签到该站点';
      status.addEventListener('click', () => handleRetrySite(siteId));
    }
    if (result) {
      const view = getStatusView(result.status);
      status.classList.add(view.className);
      status.textContent = view.text;
      if (result.message && !canRetry) {
        status.title = result.message;
      }
    } else {
      status.classList.add('pending');
      status.textContent = enabled ? '待签' : '禁用';
    }

    // 模式/类型
    const mode = document.createElement('span');
    mode.className = 'site-mode';
    if (['visit', 'login', 'relogin'].includes(site.mode)) {
      mode.classList.add(site.mode);
    }
    mode.textContent = getSiteTypeLabel(site);

    // 接口调用开关与状态标签（仅标准签到模式显示）
    const apiToggle = document.createElement('input');
    apiToggle.type = 'checkbox';
    apiToggle.className = 'api-toggle';
    apiToggle.checked = site.useApi === true;
    apiToggle.title = site.useApi ? '点击关闭接口调用（仅页面点击）' : '点击启用接口调用（可能有封号风险）';
    apiToggle.addEventListener('change', () => toggleSiteApiByDomain(site.domain, apiToggle.checked));

    const apiLabel = document.createElement('span');
    apiLabel.className = 'api-label';
    apiLabel.textContent = site.useApi ? 'API' : '页面';
    apiLabel.title = site.useApi ? '当前使用接口调用' : '当前使用页面点击';

    const balance = document.createElement('span');
    balance.className = 'site-balance';
    if (result?.balance) {
      balance.textContent = result.balance;
      balance.title = `余额: ${result.balance}`;
    }

    // 分组设置
    const groupPick = document.createElement('button');
    groupPick.type = 'button';
    groupPick.className = 'site-group-pick';
    groupPick.textContent = '🏷';
    groupPick.title = '设置分组';
    groupPick.addEventListener('click', () => handlePickGroup(site.domain));

    const continuePick = document.createElement('button');
    continuePick.type = 'button';
    continuePick.className = 'site-continue-pick';
    continuePick.textContent = '续';
    continuePick.disabled = !enabled || batchRunning;
    continuePick.title = !enabled
      ? '站点已禁用'
      : batchRunning
      ? '当前有批量签到任务在运行'
      : '从此处开始继续签到';
    continuePick.addEventListener('click', () => handleManualCheckInFromSite(siteId));

    const stopPick = document.createElement('button');
    stopPick.type = 'button';
    stopPick.className = 'site-stop-pick';
    stopPick.textContent = singleSiteCancelling ? '停中' : '停';
    stopPick.disabled = singleSiteCancelling;
    stopPick.title = singleSiteCancelling ? '正在停止当前单站重试' : '停止当前单站重试';
    stopPick.addEventListener('click', () => handleStopSingleSite(siteId));

    // 删除按钮
    const del = document.createElement('button');
    del.className = 'btn-del';
    del.textContent = '\u00d7';
    del.title = '删除站点';
    del.addEventListener('click', () => removeSiteByDomain(site.domain));

    item.appendChild(handle);
    item.appendChild(toggle);
    secondaryRow.appendChild(mode);
    if (!['visit', 'login', 'relogin'].includes(site.mode)) {
      secondaryRow.appendChild(apiToggle);
      secondaryRow.appendChild(apiLabel);
    }
    if (result?.balance) secondaryRow.appendChild(balance);
    content.appendChild(primaryRow);
    content.appendChild(secondaryRow);
    meta.appendChild(status);
    if (singleSiteRunning) meta.appendChild(stopPick);
    meta.appendChild(continuePick);
    meta.appendChild(groupPick);
    meta.appendChild(del);
    item.appendChild(content);
    item.appendChild(meta);
    return item;
  }

  // 按分组归类，以 tab 形式展示：顶部标签切组，下方仅显示当前组
  const groups = groupSites(sites);

  // 校正当前激活分组：默认选第一个；失效则回退
  if (!activeGroup || !groups.some(g => g.name === activeGroup)) {
    activeGroup = groups[0]?.name || null;
  }

  const fragment = document.createDocumentFragment();

  // tab 栏
  const tabBar = document.createElement('div');
  tabBar.className = 'group-tabs';
  groups.forEach(({ name: groupName, sites: groupSiteList }) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'group-tab' + (groupName === activeGroup ? ' active' : '');
    tab.dataset.group = groupName;

    const label = document.createElement('span');
    label.textContent = groupName;
    const count = document.createElement('span');
    count.className = 'tab-count';
    count.textContent = groupSiteList.length;
    tab.appendChild(label);
    tab.appendChild(count);

    tab.addEventListener('click', () => {
      activeGroup = groupName;
      renderSites(undefined, { preserveScroll: true });
    });

    // 拖放接收：把站点拖到 tab 上即归入该分组
    setupTabDropTarget(tab, groupName);

    tabBar.appendChild(tab);
  });
  fragment.appendChild(tabBar);

  // 当前组的站点列表
  const active = groups.find(g => g.name === activeGroup) || groups[0];
  const body = document.createElement('div');
  body.className = 'site-group-body';
  body.dataset.group = active.name === UNGROUPED_LABEL ? '' : active.name;
  active.sites.forEach(site => body.appendChild(buildItem(site)));
  fragment.appendChild(body);

  sitesList.replaceChildren(fragment);
  setupSortables();

  if (preserveScroll) {
    requestAnimationFrame(() => {
      if (sitesRenderGuard.isCurrent(renderToken)) {
        scrollContainer.scrollTop = scrollTop;
      }
    });
  }
}

function getSiteTypeLabel(site) {
  if (site?.mode === 'visit') return '访问';
  if (site?.mode === 'login') return '登录签到';
  if (site?.mode === 'relogin') return '重登签到';
  const labels = {
    auto: '自动',
    newapi: 'NewAPI',
    sub2api: 'Sub2API',
    zenapi: 'ZenAPI',
    'infinite-canvas': 'Canvas',
    'deeix-chat': 'DEEIX',
    'points-checkin': '积分签到',
    localapi: 'LocalAPI'
  };
  return labels[site?.type] || '自动';
}

// 站点分组键（空/缺省归入「未分组」）
function getSiteGroup(site) {
  const g = String(site?.group || '').trim();
  return g || UNGROUPED_LABEL;
}

// 按 group 归类，保留各组首次出现顺序；默认组始终排在最前
function groupSites(sites) {
  const order = [];
  const map = new Map();
  for (const site of sites) {
    const key = getSiteGroup(site);
    if (!map.has(key)) {
      map.set(key, []);
      order.push(key);
    }
    map.get(key).push(site);
  }
  order.sort((a, b) => {
    if (a === UNGROUPED_LABEL) return -1;
    if (b === UNGROUPED_LABEL) return 1;
    return 0;
  });
  return order.map(name => ({ name, sites: map.get(name) }));
}

// 更新统计数字
function updateStats(results) {
  const vals = Object.values(results);
  document.getElementById('successCount').textContent = vals.filter(r => r.status === 'success').length;
  document.getElementById('alreadyCount').textContent = vals.filter(r => r.status === 'already').length;
  document.getElementById('failedCount').textContent = vals.filter(r => r.status === 'failed' || r.status === 'invalid').length;
}

function getStatusView(status) {
  if (status === 'success') return { className: 'success', text: '成功' };
  if (status === 'already') return { className: 'already', text: '已签' };
  if (status === 'checking') return { className: 'checking', text: '签到中' };
  if (status === 'invalid') return { className: 'invalid', text: '失效' };
  return { className: 'failed', text: '失败' };
}

function canRetrySiteStatus(status) {
  return !status || status === 'failed' || status === 'invalid';
}

function getRawSiteId(site) {
  return String(site?.domain || '').replace(/\./g, '_');
}

function countBatchSitesFromSite(sites, siteId) {
  if (!Array.isArray(sites) || !siteId) return 0;
  const startIndex = sites.findIndex(site => getRawSiteId(site) === siteId);
  if (startIndex === -1) return 0;
  return sites.slice(startIndex).length;
}

// 添加站点
async function handleAddSite() {
  if (addingSite) return;
  addingSite = true;
  const confirmAddBtn = document.getElementById('confirmAddBtn');
  confirmAddBtn.disabled = true;

  const input = document.getElementById('newDomain');
  const mode = getSelectedSiteMode();
  try {
    const site = parseSiteInput(input.value, mode);

    if (!site) {
      alert('请输入有效的签到页链接，如 c.com/console/personal');
      return;
    }

    const sites = await loadRawSites();
    if (sites.some(s => String(s.domain || '').toLowerCase() === site.domain)) {
      alert('该站点已存在');
      return;
    }

    sites.push(site);
    await saveSitesConfig(sites);

    resetAddForm();
    document.getElementById('addForm').classList.remove('show');
    renderSites();
  } finally {
    addingSite = false;
    confirmAddBtn.disabled = false;
  }
}

function getSelectedSiteMode() {
  return document.getElementById('siteMode').value;
}

function resetAddForm() {
  document.getElementById('newDomain').value = '';
  document.getElementById('siteMode').value = 'checkin';
}

function openSitePage(site) {
  chrome.tabs.create(getSiteTabCreateOptions(site));
}

// 切换启用/禁用（按域名定位，兼容分组重排后的顺序）
async function toggleSiteByDomain(domain, enabled) {
  const sites = await loadRawSites();
  const site = sites.find(s => s.domain === domain);
  if (site) {
    site.enabled = enabled;
    await saveSitesConfig(sites);
    await renderSites(undefined, { preserveScroll: true });
  }
}

async function toggleSiteApiByDomain(domain, useApi) {
  const sites = await loadRawSites();
  const site = sites.find(s => s.domain === domain);
  if (site) {
    site.useApi = useApi;
    await saveSitesConfig(sites);
    await renderSites(undefined, { preserveScroll: true });
  }
}

// 删除站点（按域名定位）
async function removeSiteByDomain(domain) {
  const sites = await loadRawSites();
  const idx = sites.findIndex(s => s.domain === domain);
  if (idx === -1) return;

  if (!confirm(`确定删除 ${getSiteDisplayName(sites[idx])}？`)) return;

  sites.splice(idx, 1);
  await saveSitesConfig(sites);
  renderSites();
}

// 设置站点分组：弹窗选择已有分组或新建
async function handlePickGroup(domain) {
  const sites = await loadRawSites();
  const site = sites.find(s => s.domain === domain);
  if (!site) return;

  const existing = Array.from(new Set(
    sites.map(s => String(s.group || '').trim()).filter(Boolean)
  ));
  const current = String(site.group || '').trim();
  const hint = existing.length
    ? `现有分组：${existing.join('、')}\n\n输入分组名（留空=未分组）：`
    : '输入分组名（留空=未分组）：';
  const input = prompt(hint, current);
  if (input === null) return; // 取消

  const next = input.trim();
  if (next === current) return;
  if (next) site.group = next;
  else delete site.group;

  await saveSitesConfig(sites);
  await renderSites(undefined, { preserveScroll: true });
}

function getSiteDisplayName(site) {
  return site.name || site.domain;
}

// ============ 拖拽排序 / 跨组拖拽（SortableJS） ============

function destroySortables() {
  sortableInstances.forEach(inst => {
    try { inst.destroy(); } catch (e) {}
  });
  sortableInstances = [];
}

function setupSortables() {
  if (typeof Sortable === 'undefined') return;
  const bodies = document.querySelectorAll('.site-group-body');
  bodies.forEach(body => {
    sortableInstances.push(new Sortable(body, {
      group: 'sites',
      handle: '.drag-handle',
      animation: 150,
      ghostClass: 'sortable-ghost',
      chosenClass: 'sortable-chosen',
      onStart: (evt) => {
        draggingDomain = evt.item?.dataset?.domain || null;
        tabDropHandled = false;
        document.body.classList.add('dragging-site');
      },
      onEnd: async (evt) => {
        document.body.classList.remove('dragging-site');
        draggingDomain = null;
        clearTabDropHighlight();
        // 若已通过拖到 tab 改组并重渲染，跳过排序持久化，避免竞态
        if (tabDropHandled) {
          tabDropHandled = false;
          return;
        }
        await persistOrderFromDom();
      }
    }));
  });
}

// 让 tab 成为拖放目标：把站点拖到某个 tab 上即归入该分组
function setupTabDropTarget(tab, groupName) {
  tab.addEventListener('dragover', (e) => {
    if (!draggingDomain) return;
    e.preventDefault();
    tab.classList.add('drop-target');
  });
  tab.addEventListener('dragleave', () => {
    tab.classList.remove('drop-target');
  });
  tab.addEventListener('drop', async (e) => {
    if (!draggingDomain) return;
    e.preventDefault();
    const domain = draggingDomain;
    const target = groupName === UNGROUPED_LABEL ? '' : groupName;
    tab.classList.remove('drop-target');
    tabDropHandled = true; // 标记由 tab 接管，onEnd 不再持久化排序
    await moveSiteToGroup(domain, target, groupName);
  });
}

function clearTabDropHighlight() {
  document.querySelectorAll('.group-tab.drop-target')
    .forEach(t => t.classList.remove('drop-target'));
}

// 把站点移动到目标分组，并切换到该分组 tab
async function moveSiteToGroup(domain, groupValue, groupName) {
  const sites = await loadRawSites();
  const site = sites.find(s => s.domain === domain);
  if (!site) return;

  const current = String(site.group || '').trim();
  if (current === groupValue) return; // 同组无需处理

  if (groupValue) site.group = groupValue;
  else delete site.group;

  await saveSitesConfig(sites);
  activeGroup = groupName; // 跳到目标分组，便于确认结果
  await renderSites(undefined, { preserveScroll: true });
}

// 拖拽结束：以 DOM 当前顺序与所属分组为准，重排并持久化 userSites
async function persistOrderFromDom() {
  const sites = await loadRawSites();
  const byDomain = new Map(sites.map(s => [s.domain, s]));

  const ordered = [];
  document.querySelectorAll('.site-group-body').forEach(body => {
    const groupName = body.dataset.group || '';
    body.querySelectorAll('.site-item').forEach(item => {
      const site = byDomain.get(item.dataset.domain);
      if (!site) return;
      if (groupName) site.group = groupName;
      else delete site.group;
      ordered.push(site);
      byDomain.delete(item.dataset.domain);
    });
  });
  // 兜底：DOM 中遗漏的站点保持原样追加
  for (const site of byDomain.values()) ordered.push(site);

  await saveSitesConfig(ordered);
  await renderSites(undefined, { preserveScroll: true });
}

// 手动签到
async function handleManualCheckIn() {
  const sites = await loadRawSites();
  if (isCheckInRunningState(currentRunState)) {
    await cancelCurrentCheckIn(sites);
    return;
  }

  if (!canStartCheckIn(sites, currentRunState)) {
    updateCheckInButtonState(sites);
    return;
  }

  currentRunState = buildCheckInRunningState({ total: sites.length, source: 'manual' });
  updateCheckInButtonState(sites);
  showLoading();

  try {
    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'manualCheckIn' }, (response) => {
        if (response?.success) resolve(response);
        else reject(new Error(response?.error || '签到失败'));
      });
    });

    updateStats(response.results || {});
    renderSites(response.results || {});
    if (!response.running) {
      document.getElementById('lastCheck').textContent = `上次签到: ${formatDateTime(new Date())}`;
    }
  } catch (error) {
    alert('签到失败: ' + error.message);
  } finally {
    const data = await chrome.storage.local.get('checkInRunState');
    currentRunState = getCheckInRunState(data);
    await updateCheckInButtonState();
  }
}

async function handleManualCheckInFromSite(siteId) {
  const sites = await loadRawSites();
  if (!siteId || isCheckInRunningState(currentRunState)) return;

  if (!canStartCheckIn(sites, currentRunState)) {
    updateCheckInButtonState(sites);
    return;
  }

  const total = countBatchSitesFromSite(sites, siteId);
  if (total <= 0) {
    alert('未找到起始站点');
    return;
  }

  currentRunState = buildCheckInRunningState({ total, source: 'manual' });
  await updateCheckInButtonState(sites);
  await renderSites(undefined, { preserveScroll: true });

  try {
    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'manualCheckInFromSite', siteId }, (response) => {
        if (response?.success) resolve(response);
        else reject(new Error(response?.error || '从指定站点继续签到失败'));
      });
    });

    updateStats(response.results || {});
    renderSites(response.results || {}, { preserveScroll: true });
    if (!response.running) {
      document.getElementById('lastCheck').textContent = `上次签到: ${formatDateTime(new Date())}`;
    }
  } catch (error) {
    alert('从指定站点继续签到失败: ' + error.message);
  } finally {
    const data = await chrome.storage.local.get('checkInRunState');
    currentRunState = getCheckInRunState(data);
    await updateCheckInButtonState();
  }
}

// 继续签到：仅重签上轮失败/未完成的站点（已成功/已签的跳过）。
async function handleResumeCheckIn() {
  const sites = await loadRawSites();
  if (isCheckInRunningState(currentRunState)) return;
  if (!canStartCheckIn(sites, currentRunState)) {
    updateCheckInButtonState(sites);
    return;
  }

  currentRunState = buildCheckInRunningState({ total: sites.length, source: 'manual' });
  updateCheckInButtonState(sites);

  try {
    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'resumeCheckIn' }, (response) => {
        if (response?.success) resolve(response);
        else reject(new Error(response?.error || '继续签到失败'));
      });
    });

    updateStats(response.results || {});
    renderSites(response.results || {});
    if (!response.running) {
      document.getElementById('lastCheck').textContent = `上次签到: ${formatDateTime(new Date())}`;
    }
  } catch (error) {
    alert('继续签到失败: ' + error.message);
  } finally {
    const data = await chrome.storage.local.get('checkInRunState');
    currentRunState = getCheckInRunState(data);
    await updateCheckInButtonState();
  }
}

async function cancelCurrentCheckIn(sites) {
  const btn = document.getElementById('checkInBtn');
  const btnText = document.getElementById('btnText');
  btn.disabled = true;
  btnText.textContent = '正在终止...';
  btn.title = '正在终止当前签到任务';

  try {
    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'cancelCheckIn' }, (response) => {
        if (response?.success) resolve(response);
        else reject(new Error(response?.error || '终止失败'));
      });
    });

    if (response.runState) {
      currentRunState = getCheckInRunState({ checkInRunState: response.runState });
    }
    if (response.results) {
      updateStats(response.results);
      renderSites(response.results, { preserveScroll: true });
    }
  } catch (error) {
    alert('终止失败: ' + error.message);
  } finally {
    const data = await chrome.storage.local.get('checkInRunState');
    currentRunState = getCheckInRunState(data);
    await updateCheckInButtonState(sites);
  }
}

async function handleRetrySite(siteId) {
  // 不再因全局 running 阻断单站重试：单站与批量完全独立。
  // 同站防重入由 UI checking 态 + 后端 isSiteBusy 双重保证。
  if (!siteId) return;

  singleSiteRunningIds.add(siteId);
  singleSiteCancellingIds.delete(siteId);
  const data = await chrome.storage.local.get('checkInResults');
  const currentResults = data.checkInResults || {};
  const checkingResults = markSiteChecking(currentResults, siteId);
  updateStats(checkingResults);
  renderSites(checkingResults, { preserveScroll: true });

  try {
    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'retrySiteCheckIn', siteId }, (response) => {
        if (response?.busy) resolve({ ...response, busy: true });
        else if (response?.success) resolve(response);
        else reject(new Error(response?.error || '重试失败'));
      });
    });

    if (response.busy) {
      // 该站点已在签到中（批量正处理到该站，或单站重试进行中），静默刷新即可
      loadStatus();
      return;
    }

    singleSiteRunningIds.delete(siteId);
    singleSiteCancellingIds.delete(siteId);
    updateStats(response.results || {});
    renderSites(response.results || {}, { preserveScroll: true });
    if (!response.running) {
      document.getElementById('lastCheck').textContent = `上次签到: ${formatDateTime(new Date())}`;
    }
  } catch (error) {
    singleSiteRunningIds.delete(siteId);
    singleSiteCancellingIds.delete(siteId);
    alert('重试失败: ' + error.message);
    loadStatus();
  }
}

async function handleStopSingleSite(siteId) {
  if (!siteId || !singleSiteRunningIds.has(siteId)) return;

  singleSiteCancellingIds.add(siteId);
  await renderSites(undefined, { preserveScroll: true });

  try {
    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'cancelSingleSiteCheckIn', siteId }, (reply) => {
        if (reply?.success) resolve(reply);
        else reject(new Error(reply?.error || '停止失败'));
      });
    });

    syncSingleSiteRunState(response);
    if (response.results) {
      updateStats(response.results);
      renderSites(response.results, { preserveScroll: true });
    } else {
      loadStatus();
    }
  } catch (error) {
    singleSiteCancellingIds.delete(siteId);
    alert('停止失败: ' + error.message);
    loadStatus();
  }
}

async function updateCheckInButtonState(sites) {
  const currentSites = sites || await loadRawSites();
  const running = isCheckInRunningState(currentRunState);
  const cancelling = running && currentRunState?.cancelling === true;
  const enabledCount = countEnabledSites(currentSites);
  const btn = document.getElementById('checkInBtn');
  const btnText = document.getElementById('btnText');
  const btnSpinner = document.getElementById('btnSpinner');
  btn.disabled = cancelling || !canClickCheckInButton(currentSites, currentRunState);
  btnText.textContent = cancelling ? '正在终止...' : (running ? '签到中，点击终止' : '立即签到');
  btnSpinner?.classList.toggle('active', running);
  btn.title = cancelling
    ? '正在终止当前签到任务'
    : running
    ? '点击终止当前签到任务'
    : (enabledCount > 0 ? '' : '请先添加并启用至少一个站点');

  await updateResumeButtonState(running);
}

// 「继续签到」按钮：仅在「非运行中」且「存在失败/失效站点」时显示。
async function updateResumeButtonState(running) {
  const resumeBtn = document.getElementById('resumeBtn');
  if (!resumeBtn) return;
  if (running) {
    resumeBtn.style.display = 'none';
    return;
  }
  const { checkInResults = {} } = await chrome.storage.local.get('checkInResults');
  const hasFailed = Object.values(checkInResults).some(
    r => r?.status === 'failed' || r?.status === 'invalid'
  );
  resumeBtn.style.display = hasFailed ? '' : 'none';
}

// 继续签到：复用批量通道，后台仅重跑未完成（失败/失效/未跑）站点。
async function handleResumeCheckIn() {
  const sites = await loadRawSites();
  if (isCheckInRunningState(currentRunState)) return;
  if (!canStartCheckIn(sites, currentRunState)) return;

  currentRunState = buildCheckInRunningState({ total: countEnabledSites(sites), source: 'manual' });
  await updateCheckInButtonState(sites);

  try {
    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'resumeCheckIn' }, (response) => {
        if (response?.success) resolve(response);
        else reject(new Error(response?.error || '继续签到失败'));
      });
    });

    updateStats(response.results || {});
    renderSites(response.results || {}, { preserveScroll: true });
    if (!response.running) {
      document.getElementById('lastCheck').textContent = `上次签到: ${formatDateTime(new Date())}`;
    }
  } catch (error) {
    alert('继续签到失败: ' + error.message);
  } finally {
    const data = await chrome.storage.local.get('checkInRunState');
    currentRunState = getCheckInRunState(data);
    await updateCheckInButtonState();
  }
}

function showLoading() {
  document.getElementById('sitesList').innerHTML = `
    <div class="loading">
      <div class="spinner"></div>
      <div>正在签到...</div>
    </div>
  `;
}

function formatDateTime(date) {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${m}-${d} ${h}:${min}`;
}

async function handleSaveAutoSignTime() {
  const input = document.getElementById('autoSignTime');
  const status = document.getElementById('timeStatus');
  const btn = document.getElementById('saveTimeBtn');
  const time = input.value;

  status.classList.remove('error');
  status.textContent = '';

  if (!isValidAutoSignTime(time)) {
    status.classList.add('error');
    status.textContent = '请选择有效时间';
    return;
  }

  btn.disabled = true;
  try {
    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'updateAutoSignTime', time }, (response) => {
        if (response?.success) resolve(response);
        else reject(new Error(response?.error || '保存失败'));
      });
    });

    setAutoSignTimeDisplay(response.autoSignTime);
    status.textContent = `已保存为 ${response.autoSignTime}`;
  } catch (error) {
    status.classList.add('error');
    status.textContent = error.message;
  } finally {
    btn.disabled = false;
  }
}

function setAutoSignTimeDisplay(time) {
  document.getElementById('autoSignTime').value = time;
  document.getElementById('autoSignTimeLabel').textContent = time;
}

// 导出配置
async function handleExport() {
  const sites = await loadRawSites();
  const exportOrder = getCurrentSiteListOrder();
  const displayNamesByDomain = getCurrentSiteDisplayNamesByDomain();
  const { autoSignTime } = await chrome.storage.local.get('autoSignTime');
  const currentAutoSignTime = isValidAutoSignTime(autoSignTime)
    ? autoSignTime
    : document.getElementById('autoSignTime').value;

  const config = buildExportConfig(sites, currentAutoSignTime, {
    orderedDomains: exportOrder,
    displayNamesByDomain
  });

  const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `checkin-sites-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function getCurrentSiteListOrder() {
  return Array.from(document.querySelectorAll('#sitesList .site-item'))
    .map(item => item.dataset.domain)
    .filter(Boolean);
}

function getCurrentSiteDisplayNamesByDomain() {
  const names = {};
  for (const item of document.querySelectorAll('#sitesList .site-item')) {
    const domain = item.dataset.domain;
    if (!domain) continue;
    const name = item.querySelector('.site-name')?.textContent?.trim();
    if (name) names[domain] = name;
  }
  return names;
}

// 导入配置
async function handleImport(event) {
  const file = event.target.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const config = JSON.parse(text);

    // 验证配置格式
    if (!config.sites || !Array.isArray(config.sites)) {
      alert('配置文件格式错误');
      return;
    }

    // 验证并兼容旧版站点格式
    const validSites = normalizeImportSites(config.sites);

    if (validSites.length === 0) {
      alert('配置文件中没有有效的站点');
      return;
    }

    if (!confirm(`将导入 ${validSites.length} 个站点，是否继续？`)) {
      return;
    }

    const currentSites = await loadRawSites();
    let importMode = 'replace';
    if (currentSites.length > 0) {
      importMode = confirm(
        `当前有 ${currentSites.length} 个站点，是否覆盖？\n\n点击"确定"覆盖，点击"取消"合并`
      ) ? 'replace' : 'merge';
    }

    const importResult = buildImportSites(currentSites, validSites, importMode);
    if (!importResult) {
      return;
    }

    let finalSites = importResult;
    if (!Array.isArray(importResult)) {
      finalSites = importResult.sites;
      if (importResult.newCount === 0) {
        alert('所有站点都已存在，无需导入');
        return;
      }
      alert(`成功导入 ${importResult.newCount} 个新站点`);
    }

    await saveSitesConfig(finalSites);

    const importedAutoSignTime = getImportAutoSignTime(config);
    if (importedAutoSignTime) {
      await chrome.runtime.sendMessage({ action: 'updateAutoSignTime', time: importedAutoSignTime });
      setAutoSignTimeDisplay(importedAutoSignTime);
    }

    renderSites();
  } catch (error) {
    alert('导入失败: ' + error.message);
  } finally {
    // 清空文件选择
    event.target.value = '';
  }
}
