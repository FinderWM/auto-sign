let currentRunState = { running: false };
let addingSite = false;
const sitesRenderGuard = createLatestRenderGuard();
let singleSiteRunningIds = new Set();
let singleSiteCancellingIds = new Set();
let groupDialogContext = null;
let groupDialogSaving = false;
let siteEditDialogContext = null;
let siteEditDialogSaving = false;
let groupAutoSignTimes = {};
let fallbackAutoSignTime = '09:00';

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
  document.getElementById('siteSearchInput').addEventListener('input', handleSiteSearchInput);

  // 导出/导入
  document.getElementById('exportBtn').addEventListener('click', handleExport);
  document.getElementById('importBtn').addEventListener('click', () => {
    document.getElementById('importFile').click();
  });
  document.getElementById('importFile').addEventListener('change', handleImport);
  document.getElementById('saveTimeBtn').addEventListener('click', handleSaveAutoSignTime);
  document.getElementById('clearLogsBtn').addEventListener('click', handleClearLogs);
  setupGroupDialogEvents();
  setupSiteEditDialogEvents();
}

function setupGroupDialogEvents() {
  const dialog = document.getElementById('groupDialog');
  const existingSelect = document.getElementById('groupExistingSelect');

  document.getElementById('groupDialogForm').addEventListener('submit', handleGroupDialogSubmit);
  document.getElementById('groupDialogCancel').addEventListener('click', () => closeGroupDialog());
  document.getElementById('groupDialogClose').addEventListener('click', () => closeGroupDialog());
  existingSelect.addEventListener('change', () => {
    document.getElementById('groupNewInput').value = '';
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) closeGroupDialog();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && groupDialogContext) {
      event.preventDefault();
      closeGroupDialog();
    }
  });
}

function setupSiteEditDialogEvents() {
  const dialog = document.getElementById('siteEditDialog');

  document.getElementById('siteEditDialogForm').addEventListener('submit', handleSiteEditDialogSubmit);
  document.getElementById('siteEditDialogCancel').addEventListener('click', () => closeSiteEditDialog());
  document.getElementById('siteEditDialogClose').addEventListener('click', () => closeSiteEditDialog());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) closeSiteEditDialog();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && siteEditDialogContext) {
      event.preventDefault();
      closeSiteEditDialog();
    }
  });
}

// 加载签到状态
function loadStatus() {
  chrome.runtime.sendMessage({ action: 'getStatus' }, (response) => {
    if (response) {
      groupAutoSignTimes = normalizePopupGroupAutoSignTimes(response.groupAutoSignTimes);
      fallbackAutoSignTime = isValidAutoSignTime(response.autoSignTime)
        ? response.autoSignTime
        : '09:00';
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

  if (changes.groupAutoSignTimes || changes.autoSignTime) {
    if (changes.groupAutoSignTimes) {
      groupAutoSignTimes = normalizePopupGroupAutoSignTimes(changes.groupAutoSignTimes.newValue);
    }
    if (changes.autoSignTime) {
      fallbackAutoSignTime = isValidAutoSignTime(changes.autoSignTime.newValue)
        ? changes.autoSignTime.newValue
        : '09:00';
    }
    updateAutoSignTimeDisplay();
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

function createTrashIcon() {
  const svgNamespace = 'http://www.w3.org/2000/svg';
  const icon = document.createElementNS(svgNamespace, 'svg');
  icon.classList.add('site-delete-icon');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '2');
  icon.setAttribute('stroke-linecap', 'round');
  icon.setAttribute('stroke-linejoin', 'round');
  icon.setAttribute('aria-hidden', 'true');
  icon.setAttribute('focusable', 'false');

  const path = document.createElementNS(svgNamespace, 'path');
  const trashPath = [
    'M3 6h18',
    'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6',
    'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
    'M10 11v6',
    'M14 11v6'
  ].join('');
  path.setAttribute('d', trashPath);
  icon.appendChild(path);
  return icon;
}

// 渲染站点列表
const UNGROUPED_LABEL = '默认';
let sortableInstances = [];
let activeGroup = null;
let siteSearchQuery = '';
let draggingDomain = null;
let tabDropHandled = false;

function normalizeSiteGroupValue(value) {
  return normalizeSiteGroup(value);
}

function getActiveGroupValue() {
  return normalizeSiteGroupValue(activeGroup);
}

function getActiveGroupSites(sites = []) {
  return filterSitesByGroup(sites, getActiveGroupValue());
}

function handleSiteSearchInput(event) {
  siteSearchQuery = event.target.value;
  renderSites(undefined, { preserveScroll: true });
}

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

  destroySortables();

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

    const linkRow = document.createElement('div');
    linkRow.className = 'site-link-row';

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
    const openPageUrl = getSitePageUrl(site);
    const recordedPageUrl = String(site.pageUrl || openPageUrl);
    const displayName = site.name || site.domain;
    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'site-name site-link';
    name.textContent = displayName;
    name.title = `${displayName}\n打开 ${openPageUrl}`;
    name.addEventListener('click', () => openSitePage(site));

    const pageUrl = document.createElement('span');
    pageUrl.className = 'site-page-url';
    pageUrl.textContent = recordedPageUrl;
    pageUrl.title = recordedPageUrl;

    primaryRow.appendChild(name);
    linkRow.appendChild(pageUrl);
    let verificationHint = null;
    if (shouldHighlightHumanVerification(result)) {
      verificationHint = document.createElement('span');
      verificationHint.className = 'site-alert-badge human-verification';
      verificationHint.textContent = '需人机验证';
      verificationHint.title = result.message;
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
    apiToggle.setAttribute('aria-label', '签到方式：页面或 API');
    apiToggle.title = site.useApi ? '点击关闭接口调用（仅页面点击）' : '点击启用接口调用（可能有封号风险）';
    apiToggle.addEventListener('change', () => toggleSiteApiByDomain(site.domain, apiToggle.checked));

    const apiSlider = document.createElement('span');
    apiSlider.className = 'api-slider';
    apiSlider.setAttribute('aria-hidden', 'true');

    const apiLabel = document.createElement('span');
    apiLabel.className = 'api-label';
    apiLabel.textContent = site.useApi ? 'API' : '页面';
    apiLabel.title = site.useApi ? '当前使用接口调用' : '当前使用页面点击';

    const apiMode = document.createElement('label');
    apiMode.className = 'site-api-mode';
    apiMode.title = apiToggle.title;
    apiMode.appendChild(apiToggle);
    apiMode.appendChild(apiSlider);
    apiMode.appendChild(apiLabel);

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
    groupPick.textContent = '分组';
    groupPick.title = '设置分组';
    groupPick.addEventListener('click', () => handlePickGroup(site.domain));

    const editPick = document.createElement('button');
    editPick.type = 'button';
    editPick.className = 'site-edit-pick';
    editPick.textContent = '编辑';
    editPick.title = '编辑站点信息';
    editPick.addEventListener('click', () => handleEditSite(site.domain));

    const continuePick = document.createElement('button');
    continuePick.type = 'button';
    continuePick.className = 'site-continue-pick';
    continuePick.textContent = '从此续';
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
    del.type = 'button';
    del.className = 'btn-del';
    del.setAttribute('aria-label', '删除站点');
    del.title = '删除站点';
    del.appendChild(createTrashIcon());
    del.addEventListener('click', () => removeSiteByDomain(site.domain));

    item.appendChild(handle);
    item.appendChild(toggle);
    secondaryRow.appendChild(mode);
    if (!['visit', 'login', 'relogin'].includes(site.mode)) {
      secondaryRow.appendChild(apiMode);
    }
    if (result?.balance) secondaryRow.appendChild(balance);
    if (verificationHint) secondaryRow.appendChild(verificationHint);
    secondaryRow.appendChild(editPick);
    secondaryRow.appendChild(groupPick);
    secondaryRow.appendChild(status);
    if (singleSiteRunning) secondaryRow.appendChild(stopPick);
    content.appendChild(primaryRow);
    content.appendChild(linkRow);
    content.appendChild(secondaryRow);
    meta.appendChild(continuePick);
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
  updateAutoSignTimeDisplay();
  updateCheckInButtonState(sites);

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
      document.getElementById('timeStatus').textContent = '';
      renderSites(undefined, { preserveScroll: true });
    });

    // 拖放接收：把站点拖到 tab 上即归入该分组
    setupTabDropTarget(tab, groupName);

    tabBar.appendChild(tab);
  });
  fragment.appendChild(tabBar);

  // 当前组的站点列表
  const active = groups.find(g => g.name === activeGroup) || groups[0];
  const normalizedSearchQuery = normalizeSiteSearchText(siteSearchQuery);
  const visibleSites = normalizedSearchQuery
    ? filterSitesBySearch(active.sites, normalizedSearchQuery)
    : active.sites;
  const body = document.createElement('div');
  body.className = normalizedSearchQuery
    ? 'site-group-body site-search-results'
    : 'site-group-body';
  body.dataset.group = active.name === UNGROUPED_LABEL ? '' : active.name;
  if (visibleSites.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = normalizedSearchQuery
      ? '当前分组未找到匹配的站点'
      : sites.length === 0
      ? '暂无站点，添加后即可开始签到'
      : '当前分组暂无站点';
    body.appendChild(empty);
  } else {
    visibleSites.forEach(site => body.appendChild(buildItem(site)));
  }
  fragment.appendChild(body);

  sitesList.replaceChildren(fragment);
  if (!normalizedSearchQuery) setupSortables();

  if (preserveScroll) {
    requestAnimationFrame(() => {
      if (sitesRenderGuard.isCurrent(renderToken)) {
        scrollContainer.scrollTop = scrollTop;
      }
    });
  }
}

function normalizeSiteSearchText(value) {
  return String(value || '').trim().toLowerCase();
}

function filterSitesBySearch(sites, query) {
  const keywords = normalizeSiteSearchText(query).split(/\s+/).filter(Boolean);
  if (keywords.length === 0) return sites;

  return sites.filter(site => {
    const searchableText = normalizeSiteSearchText(`${site?.name || ''} ${site?.domain || ''}`);
    return keywords.every(keyword => searchableText.includes(keyword));
  });
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
    localapi: 'LocalAPI',
    'sota-agent': 'Sota Agent',
    'fengwind-welfare': 'Fengwind 福利',
    'pipi-studio': '皮皮智绘'
  };
  return labels[site?.type] || '自动';
}

// 站点分组键（空/缺省归入「默认」）
function getSiteGroup(site) {
  return normalizeSiteGroupValue(site?.group) || UNGROUPED_LABEL;
}

// 按 group 归类，保留各组首次出现顺序；默认组始终排在最前
function groupSites(sites) {
  const order = [UNGROUPED_LABEL];
  const map = new Map([[UNGROUPED_LABEL, []]]);
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

async function handleEditSite(domain) {
  const returnFocus = document.activeElement;
  const sites = await loadRawSites();
  const site = sites.find(item => item.domain === domain);
  if (!site) return;

  openSiteEditDialog(site, returnFocus);
}

function openSiteEditDialog(site, returnFocus) {
  const dialog = document.getElementById('siteEditDialog');
  const nameInput = document.getElementById('siteEditName');

  nameInput.value = getSiteDisplayName(site);
  document.getElementById('siteEditPageUrl').value = String(site.pageUrl || getSitePageUrl(site));
  document.getElementById('siteEditMode').value = normalizeEditableSiteMode(site.mode);
  document.getElementById('siteEditDomain').textContent = site.domain;
  siteEditDialogContext = { domain: site.domain, returnFocus };
  setSiteEditDialogError('');
  setSiteEditDialogBusy(false);

  dialog.classList.add('show');
  dialog.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => nameInput.focus());
}

function normalizeEditableSiteMode(mode) {
  return ['visit', 'login', 'relogin'].includes(mode) ? mode : 'checkin';
}

async function handleSiteEditDialogSubmit(event) {
  event.preventDefault();
  if (!siteEditDialogContext || siteEditDialogSaving) return;

  const context = siteEditDialogContext;
  const name = document.getElementById('siteEditName').value.trim();
  const pageUrlInput = document.getElementById('siteEditPageUrl').value.trim();
  const mode = document.getElementById('siteEditMode').value;

  setSiteEditDialogError('');
  if (!name) {
    setSiteEditDialogError('请输入站点名称');
    document.getElementById('siteEditName').focus();
    return;
  }

  const parsedSite = parseSiteInput(pageUrlInput, mode);
  if (!parsedSite) {
    setSiteEditDialogError('请输入有效的站点页面链接');
    document.getElementById('siteEditPageUrl').focus();
    return;
  }
  if (parsedSite.domain !== context.domain) {
    setSiteEditDialogError('站点域名不可修改，请添加新站点');
    document.getElementById('siteEditPageUrl').focus();
    return;
  }

  setSiteEditDialogBusy(true);
  try {
    const sites = await loadRawSites();
    const site = sites.find(item => item.domain === context.domain);
    if (!site) throw new Error('站点不存在');

    site.name = name;
    site.pageUrl = parsedSite.pageUrl || getSitePageUrl(parsedSite);
    if (mode === 'checkin') delete site.mode;
    else site.mode = mode;
    await saveSitesConfig(sites);

    closeSiteEditDialog(true);
    await renderSites(undefined, { preserveScroll: true });
  } catch (error) {
    setSiteEditDialogError('保存失败: ' + error.message);
  } finally {
    setSiteEditDialogBusy(false);
  }
}

function setSiteEditDialogError(message) {
  document.getElementById('siteEditDialogError').textContent = message;
}

function setSiteEditDialogBusy(busy) {
  siteEditDialogSaving = busy;
  document.getElementById('siteEditName').disabled = busy;
  document.getElementById('siteEditPageUrl').disabled = busy;
  document.getElementById('siteEditMode').disabled = busy;
  document.getElementById('siteEditDialogCancel').disabled = busy;
  document.getElementById('siteEditDialogClose').disabled = busy;
  const saveButton = document.getElementById('siteEditDialogSave');
  saveButton.disabled = busy;
  saveButton.textContent = busy ? '保存中...' : '保存';
}

function closeSiteEditDialog(force = false) {
  if (!siteEditDialogContext || (siteEditDialogSaving && !force)) return;

  const dialog = document.getElementById('siteEditDialog');
  const returnFocus = siteEditDialogContext.returnFocus;
  siteEditDialogContext = null;
  dialog.classList.remove('show');
  dialog.setAttribute('aria-hidden', 'true');
  setSiteEditDialogError('');

  if (returnFocus && document.contains(returnFocus)) {
    returnFocus.focus();
  }
}

// 设置站点分组：打开分组选择对话框
async function handlePickGroup(domain) {
  const returnFocus = document.activeElement;
  const sites = await loadRawSites();
  const site = sites.find(s => s.domain === domain);
  if (!site) return;

  const existing = Array.from(new Set(
    sites.map(s => normalizeSiteGroupValue(s.group)).filter(Boolean)
  ));
  openGroupDialog(site, existing, returnFocus);
}

function openGroupDialog(site, existingGroups, returnFocus) {
  const dialog = document.getElementById('groupDialog');
  const existingSelect = document.getElementById('groupExistingSelect');
  const current = normalizeSiteGroupValue(site.group);

  existingSelect.replaceChildren();
  appendGroupOption(existingSelect, '', UNGROUPED_LABEL);
  existingGroups.forEach(groupName => appendGroupOption(existingSelect, groupName, groupName));
  existingSelect.value = current;

  document.getElementById('groupDialogSite').textContent = getSiteDisplayName(site);
  document.getElementById('groupNewInput').value = '';
  groupDialogContext = { domain: site.domain, current, returnFocus };
  setGroupDialogBusy(false);

  dialog.classList.add('show');
  dialog.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => existingSelect.focus());
}

function appendGroupOption(select, value, label) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  select.appendChild(option);
}

async function handleGroupDialogSubmit(event) {
  event.preventDefault();
  if (!groupDialogContext || groupDialogSaving) return;

  const context = groupDialogContext;
  const selectedGroup = normalizeSiteGroupValue(document.getElementById('groupExistingSelect').value);
  const newGroupInput = document.getElementById('groupNewInput').value.trim();
  const nextGroup = newGroupInput ? normalizeSiteGroupValue(newGroupInput) : selectedGroup;

  setGroupDialogBusy(true);
  try {
    const sites = await loadRawSites();
    const site = sites.find(item => item.domain === context.domain);
    if (!site) throw new Error('站点不存在');

    const currentGroup = normalizeSiteGroupValue(site.group);
    if (nextGroup !== currentGroup) {
      if (nextGroup) site.group = nextGroup;
      else delete site.group;
      await saveSitesConfig(sites);
    }

    closeGroupDialog(true);
    await renderSites(undefined, { preserveScroll: true });
  } catch (error) {
    alert('保存分组失败: ' + error.message);
  } finally {
    setGroupDialogBusy(false);
  }
}

function setGroupDialogBusy(busy) {
  groupDialogSaving = busy;
  document.getElementById('groupExistingSelect').disabled = busy;
  document.getElementById('groupNewInput').disabled = busy;
  document.getElementById('groupDialogCancel').disabled = busy;
  document.getElementById('groupDialogClose').disabled = busy;
  const saveButton = document.getElementById('groupDialogSave');
  saveButton.disabled = busy;
  saveButton.textContent = busy ? '保存中...' : '保存';
}

function closeGroupDialog(force = false) {
  if (!groupDialogContext || (groupDialogSaving && !force)) return;

  const dialog = document.getElementById('groupDialog');
  const returnFocus = groupDialogContext.returnFocus;
  groupDialogContext = null;
  dialog.classList.remove('show');
  dialog.setAttribute('aria-hidden', 'true');

  if (returnFocus && document.contains(returnFocus)) {
    returnFocus.focus();
  }
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

  const current = normalizeSiteGroupValue(site.group);
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
  const allSites = await loadRawSites();
  const sites = getActiveGroupSites(allSites);
  const group = getActiveGroupValue();
  if (isCheckInRunningState(currentRunState)) {
    await cancelCurrentCheckIn(sites);
    return;
  }

  if (!canStartCheckIn(sites, currentRunState)) {
    updateCheckInButtonState(sites);
    return;
  }

  currentRunState = {
    ...buildCheckInRunningState({ total: sites.length, source: 'manual' }),
    group
  };
  updateCheckInButtonState(sites);
  showLoading();

  try {
    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'manualCheckIn', group }, (response) => {
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
  const allSites = await loadRawSites();
  const sites = getActiveGroupSites(allSites);
  const group = getActiveGroupValue();
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

  currentRunState = {
    ...buildCheckInRunningState({ total, source: 'manual' }),
    group
  };
  await updateCheckInButtonState(sites);
  await renderSites(undefined, { preserveScroll: true });

  try {
    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'manualCheckInFromSite', siteId, group }, (response) => {
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
  const allSites = sites || await loadRawSites();
  const currentSites = getActiveGroupSites(allSites);
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

  await updateResumeButtonState(running, currentSites);
}

// 「继续签到」按钮：仅在「非运行中」且「存在失败/失效站点」时显示。
async function updateResumeButtonState(running, currentSites = []) {
  const resumeBtn = document.getElementById('resumeBtn');
  if (!resumeBtn) return;
  if (running) {
    resumeBtn.style.display = 'none';
    return;
  }
  const { checkInResults = {} } = await chrome.storage.local.get('checkInResults');
  const currentSiteIds = new Set(currentSites.map(getRawSiteId));
  const hasFailed = Object.entries(checkInResults).some(
    ([siteId, result]) => currentSiteIds.has(siteId)
      && (result?.status === 'failed' || result?.status === 'invalid')
  );
  resumeBtn.style.display = hasFailed ? '' : 'none';
}

// 继续签到：复用批量通道，后台仅重跑未完成（失败/失效/未跑）站点。
async function handleResumeCheckIn() {
  const allSites = await loadRawSites();
  const sites = getActiveGroupSites(allSites);
  const group = getActiveGroupValue();
  if (isCheckInRunningState(currentRunState)) return;
  if (!canStartCheckIn(sites, currentRunState)) return;

  currentRunState = {
    ...buildCheckInRunningState({ total: sites.length, source: 'manual' }),
    group
  };
  await updateCheckInButtonState(sites);

  try {
    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'resumeCheckIn', group }, (response) => {
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
  const group = getActiveGroupValue();
  const groupName = activeGroup || UNGROUPED_LABEL;
  try {
    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'updateAutoSignTime', group, time }, (response) => {
        if (response?.success) resolve(response);
        else reject(new Error(response?.error || '保存失败'));
      });
    });

    groupAutoSignTimes = normalizePopupGroupAutoSignTimes(response.groupAutoSignTimes);
    fallbackAutoSignTime = isValidAutoSignTime(response.fallbackAutoSignTime)
      ? response.fallbackAutoSignTime
      : fallbackAutoSignTime;
    updateAutoSignTimeDisplay();
    status.textContent = `已保存 ${groupName}分组为 ${time}`;
  } catch (error) {
    status.classList.add('error');
    status.textContent = error.message;
  } finally {
    btn.disabled = false;
  }
}

function normalizePopupGroupAutoSignTimes(value) {
  return Object.fromEntries(
    Object.entries(normalizeGroupAutoSignTimes(value))
      .filter(([, time]) => isValidAutoSignTime(time))
  );
}

function getPopupAutoSignTime() {
  const time = getGroupAutoSignTime(groupAutoSignTimes, getActiveGroupValue(), fallbackAutoSignTime);
  return isValidAutoSignTime(time) ? time : fallbackAutoSignTime;
}

function updateAutoSignTimeDisplay() {
  const time = getPopupAutoSignTime();
  document.getElementById('autoSignTime').value = time;
  document.getElementById('autoSignTimeLabel').textContent = time;
  const groupLabel = document.getElementById('autoSignGroupLabel');
  if (groupLabel) groupLabel.textContent = activeGroup || UNGROUPED_LABEL;
}

// 导出配置
async function handleExport() {
  const sites = await loadRawSites();
  const exportOrder = getCurrentSiteListOrder();
  const displayNamesByDomain = getCurrentSiteDisplayNamesByDomain();
  const { autoSignTime, groupAutoSignTimes: storedGroupAutoSignTimes } = await chrome.storage.local.get([
    'autoSignTime',
    'groupAutoSignTimes'
  ]);
  const currentAutoSignTime = isValidAutoSignTime(autoSignTime)
    ? autoSignTime
    : fallbackAutoSignTime;

  const config = buildExportConfig(sites, currentAutoSignTime, {
    orderedDomains: exportOrder,
    displayNamesByDomain
  });
  config.groupAutoSignTimes = normalizePopupGroupAutoSignTimes(storedGroupAutoSignTimes);

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
    const hasImportedGroupTimes = config.groupAutoSignTimes
      && typeof config.groupAutoSignTimes === 'object'
      && !Array.isArray(config.groupAutoSignTimes);
    if (importedAutoSignTime || hasImportedGroupTimes) {
      const currentSchedule = await chrome.storage.local.get([
        'autoSignTime',
        'groupAutoSignTimes'
      ]);
      const importedTimes = normalizePopupGroupAutoSignTimes(config.groupAutoSignTimes);
      const mergedTimes = importMode === 'merge'
        ? {
          ...normalizePopupGroupAutoSignTimes(currentSchedule.groupAutoSignTimes),
          ...importedTimes
        }
        : importedTimes;
      const response = await chrome.runtime.sendMessage({
        action: 'updateGroupAutoSignTimes',
        groupAutoSignTimes: mergedTimes,
        autoSignTime: importedAutoSignTime || currentSchedule.autoSignTime
      });
      if (!response?.success) throw new Error(response?.error || '导入分组签到时间失败');
      groupAutoSignTimes = normalizePopupGroupAutoSignTimes(response.groupAutoSignTimes);
      fallbackAutoSignTime = isValidAutoSignTime(response.fallbackAutoSignTime)
        ? response.fallbackAutoSignTime
        : fallbackAutoSignTime;
      updateAutoSignTimeDisplay();
    }

    renderSites();
  } catch (error) {
    alert('导入失败: ' + error.message);
  } finally {
    // 清空文件选择
    event.target.value = '';
  }
}
