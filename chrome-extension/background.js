// 导入配置
importScripts('schedule.js', 'config.js', 'site-url.js', 'auth-headers.js', 'auth-cache-crypto.js', 'checkin-result.js',
  'sota-agent.js', 'pipi-studio.js', 'fengwind-welfare.js', 'newapi-auth.js', 'zenapi-auth.js', 'tab-options.js', 'site-name.js',
  'page-status.js', 'checkin-run-state.js', 'balance.js');

const DAILY_CHECK_IN_ALARM = 'dailyCheckIn';
const GROUP_AUTO_SIGN_TIMES_STORAGE_KEY = 'groupAutoSignTimes';
const PAGE_USABLE_TIMEOUT_MS = 20000;
// 单站签到的重试与超时策略：批量与单站重试共用，确保任何一步挂起都不会卡死整体流程。
const SITE_CHECKIN_TIMEOUT_MS = 90000;       // 单次签到尝试的硬超时（覆盖 OAuth 登录等慢流程）
const SITE_CHECKIN_MAX_ATTEMPTS = 3;         // 含初试：初试 + 2 次重试
const SITE_CHECKIN_RETRY_INTERVAL_MS = 2500; // 失败后的退避间隔
// service worker 中签到请求的单次 fetch 超时：用 AbortController 真正中止挂起的 fetch，
// 避免其 keepalive 撞 MV3 worker 5 分钟硬上限导致整个批量流程被杀（剩余站点不跑）。
const SITE_FETCH_TIMEOUT_MS = 30000;
// 死站快速失败：正式尝试前的可达性预检超时。TCP/TLS 握手撑不过这个时间即判不可达，
// 跳过 3 次重试，避免宕机站点靠每步 fetch 耗满 30s、单次尝试 90s、×3 次拖垮整批。
const SITE_REACHABILITY_TIMEOUT_MS = 8000;
const CHECK_IN_LOGS_STORAGE_KEY = 'checkInLogs';
const CHECK_IN_LOGS_MAX_ENTRIES = 200;
const INFINITE_CANVAS_AUTH_TOKEN_KEY = 'infinite-canvas-auth-token-v1';
const DEEIX_CHAT_LINUX_DO_PROVIDER_SLUG = 'linux-do';
const DEEIX_CHAT_DEFAULT_PATH = '/chat';
const SITE_TYPE_CHECK_IN_HANDLERS = {
  'deeix-chat': checkInDeeixChatSite,
  'infinite-canvas': checkInInfiniteCanvasSite,
  sub2api: checkInSub2ApiSite,
  zenapi: checkInZenApiSite,
  'points-checkin': checkInPointsCheckinSite,
  localapi: checkInLocalApiSite,
  'sota-agent': checkInSotaAgentSite,
  'fengwind-welfare': checkInFengwindWelfareSite,
  'pipi-studio': checkInPipiStudioSite
};
const SITE_TYPE_DAILY_LOGIN_HANDLERS = {
  newapi: checkInNewApiDailyLogin
};

// 批量签到（manual / schedule）单一运行实例；与单站重试完全独立。
let batchCheckIn = null; // { promise, cancelToken, runContext }
// 单站重试按 siteId 独立跟踪，互不阻塞、也不阻塞批量。
const singleSiteCheckIns = new Map(); // siteId -> { promise, cancelToken, runContext }
let checkInLogWriteQueue = Promise.resolve();
let scheduledCheckInQueue = Promise.resolve();
let groupScheduleRefreshPromise = null;
let groupScheduleRefreshRequested = false;

function formatCheckInLogTime(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function getLocalDayKey(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) return null;
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isPreviousLocalDay(dateValue, now = new Date()) {
  if (!dateValue) return false;
  const dayKey = getLocalDayKey(dateValue);
  const todayKey = getLocalDayKey(now);
  if (!dayKey || !todayKey) return false;
  return dayKey !== todayKey;
}

// 跨日清状态：优先用 checkInResultsDay（本地日键）；兼容旧数据回退 lastCheckInTime。
function shouldResetCheckInResultsForNewDay(data = {}, now = new Date()) {
  const todayKey = getLocalDayKey(now);
  if (!todayKey) return false;

  const storedDay = typeof data.checkInResultsDay === 'string' ? data.checkInResultsDay : null;
  if (storedDay) return storedDay !== todayKey;

  // 旧版本仅有 lastCheckInTime：无时间戳但有结果时也清，避免永远残留昨日状态。
  if (data.lastCheckInTime) return isPreviousLocalDay(data.lastCheckInTime, now);
  return Object.keys(data.checkInResults || {}).length > 0;
}

// 无任务在跑时，若已跨日本地日则清空结果并写入今日日键。返回是否执行了清空。
async function resetCheckInResultsIfNewDay(data = {}, { force = false } = {}) {
  const runState = getCheckInRunState(data);
  if (!force
    && (isCheckInRunningState(runState) || batchCheckIn || singleSiteCheckIns.size > 0)) {
    return { reset: false, results: data.checkInResults || {} };
  }

  const results = data.checkInResults || {};
  if (Object.keys(results).length === 0 && data.checkInResultsDay === getLocalDayKey()) {
    return { reset: false, results };
  }
  if (!shouldResetCheckInResultsForNewDay({ ...data, checkInResults: results })) {
    return { reset: false, results };
  }

  const empty = {};
  await chrome.storage.local.set({
    checkInResults: empty,
    checkInResultsDay: getLocalDayKey()
  });
  return { reset: true, results: empty };
}

function normalizeCheckInLogValue(value, fallback) {
  const normalized = String(value || '')
    .replace(/[\r\n\[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized || fallback;
}

function queueCheckInLogWrite(task) {
  checkInLogWriteQueue = checkInLogWriteQueue.then(task, task);
  return checkInLogWriteQueue;
}

async function resetCheckInLogs() {
  await queueCheckInLogWrite(() => chrome.storage.local.set({ [CHECK_IN_LOGS_STORAGE_KEY]: [] }));
}

async function appendCheckInLog(siteName, loginStatus, message) {
  const normalizedMessage = String(message || '').replace(/\s+/g, ' ').trim();
  if (!normalizedMessage) return;

  const entry = `[${normalizeCheckInLogValue(siteName, '系统')}][${normalizeCheckInLogValue(loginStatus, '未知')}][${formatCheckInLogTime()}] ${normalizedMessage}`;
  await queueCheckInLogWrite(async () => {
    const data = await chrome.storage.local.get(CHECK_IN_LOGS_STORAGE_KEY);
    const currentLogs = Array.isArray(data[CHECK_IN_LOGS_STORAGE_KEY])
      ? data[CHECK_IN_LOGS_STORAGE_KEY].filter(item => typeof item === 'string' && item.trim())
      : [];
    currentLogs.push(entry);
    await chrome.storage.local.set({
      [CHECK_IN_LOGS_STORAGE_KEY]: currentLogs.slice(-CHECK_IN_LOGS_MAX_ENTRIES)
    });
  });
}

function deriveLogLoginStatusFromResult(result) {
  const message = String(result?.message || '');
  if (/未登录|请登录/i.test(message)) return '未登录';
  if (/登录失败/i.test(message)) return '登录失败';
  if (result?.status === 'success' || result?.status === 'already') return '已登录';
  return '未知';
}

function buildResultLogMessage(result) {
  if (!result) return '执行结束';
  if (result.status === 'success') {
    return result.balance ? `签到成功，余额 ${result.balance}` : '签到成功';
  }
  if (result.status === 'already') {
    return result.balance ? `今日已签，余额 ${result.balance}` : '今日已签';
  }
  if (result.status === 'invalid') {
    return result.message ? `站点失效：${result.message}` : '站点失效';
  }
  return result.message ? `签到失败：${result.message}` : '签到失败';
}

function isBatchRunning() {
  return Boolean(batchCheckIn);
}

function isSingleSiteRunning(siteId) {
  return Boolean(siteId) && singleSiteCheckIns.has(siteId);
}

function getSingleSiteRunSnapshot() {
  const singleSiteRunningIds = [];
  const singleSiteCancellingIds = [];
  for (const [siteId, entry] of singleSiteCheckIns.entries()) {
    if (!siteId) continue;
    singleSiteRunningIds.push(siteId);
    if (isCheckInCancelRequested(entry?.cancelToken)) {
      singleSiteCancellingIds.push(siteId);
    }
  }
  return { singleSiteRunningIds, singleSiteCancellingIds };
}

function normalizeTransientCheckingResults(results = {}, runState = {}) {
  const activeCheckingSiteIds = new Set(getSingleSiteRunSnapshot().singleSiteRunningIds);
  if (isCheckInRunningState(runState) && batchCheckIn?.runContext?.currentSiteId) {
    activeCheckingSiteIds.add(batchCheckIn.runContext.currentSiteId);
  }

  let changed = false;
  const normalized = {};
  for (const [siteId, result] of Object.entries(results || {})) {
    if (result?.status === 'checking' && !activeCheckingSiteIds.has(siteId)) {
      normalized[siteId] = { status: 'failed', message: '签到中断' };
      changed = true;
      continue;
    }
    normalized[siteId] = result;
  }
  return changed ? normalized : results;
}

// 同站防重入：该站正在被单站重试，或批量正处理到该站。
function isSiteBusy(siteId) {
  return isSingleSiteRunning(siteId)
    || (isBatchRunning() && batchCheckIn.runContext?.currentSiteId === siteId);
}

// Service worker 重新唤醒后恢复残留状态。
// MV3 的 worker 随时可能被回收：若签到跑到一半 worker 被杀，内存里的
// batchCheckIn / singleSiteCheckIns 会丢失，但 storage 里仍残留 running:true
// （批量）或某站点的 checking 状态，导致 UI 卡在"签到中"。worker 顶层代码执行
// 意味着它刚被重建，此时不可能有任务仍在运行，故任何 running:true 都是残留。
// 单站残留的 checking 则由 normalizeCheckInResultsForRun 规整为 failed。
async function recoverStaleCheckInState() {
  try {
    const data = await chrome.storage.local.get(['checkInResults', 'checkInRunState']);
    const runState = getCheckInRunState(data);
    if (!isCheckInRunningState(runState)) return;

    console.log('检测到残留的签到状态，执行恢复清理');
    await chrome.storage.local.set({
      checkInResults: normalizeCheckInResultsForRun(data.checkInResults || {}),
      checkInRunState: clearCheckInRunningState(runState)
    });
    chrome.action.setBadgeText({ text: '' });
  } catch (error) {
    console.warn('恢复残留签到状态失败（已捕获，忽略）:', error);
  }
}

recoverStaleCheckInState();

// 安装时初始化
chrome.runtime.onInstalled.addListener(() => {
  console.log('公益站自动签到助手已安装');

  chrome.storage.local.set({
    lastCheckInTime: null,
    checkInResults: {},
    checkInResultsDay: getLocalDayKey(),
    checkInLogs: []
  }).then(() => refreshGroupCheckInSchedules()).catch(error => {
    console.warn('初始化分组签到时间失败:', error);
  });
});

chrome.runtime.onStartup.addListener(() => {
  refreshGroupCheckInSchedules().catch(error => {
    console.warn('启动时恢复分组签到时间失败:', error);
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes.userSites || changes[GROUP_AUTO_SIGN_TIMES_STORAGE_KEY] || changes.autoSignTime) {
    refreshGroupCheckInSchedules().catch(error => {
      console.warn('分组签到时间更新失败:', error);
    });
  }
});

// 监听定时器
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DAILY_CHECK_IN_ALARM) {
    refreshGroupCheckInSchedules().catch(error => {
      console.warn('清理旧签到闹钟失败:', error);
    });
    return;
  }
  const groupAlarm = parseGroupCheckInAlarmName(alarm.name);
  if (groupAlarm) enqueueScheduledGroupCheckIn(groupAlarm.group);
});

// 监听来自 popup 的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'manualCheckIn') {
    if (batchCheckIn) {
      chrome.storage.local.get(['checkInResults', 'checkInRunState'], (data) => {
        sendResponse({
          success: true,
          running: true,
          results: data.checkInResults || {},
          runState: getCheckInRunState(data)
        });
      });
    } else {
      startCheckInRun('manual', { group: normalizeSiteGroup(request.group) }).then(results => {
        sendResponse({ success: true, running: false, results });
      }).catch(error => {
        sendResponse({ success: false, error: error.message });
      });
    }
    return true;
  }

  if (request.action === 'resumeCheckIn') {
    if (batchCheckIn) {
      chrome.storage.local.get(['checkInResults', 'checkInRunState'], (data) => {
        sendResponse({
          success: true,
          running: true,
          results: data.checkInResults || {},
          runState: getCheckInRunState(data)
        });
      });
    } else {
      startCheckInRun('manual', {
        resume: true,
        group: normalizeSiteGroup(request.group)
      }).then(results => {
        sendResponse({ success: true, running: false, results });
      }).catch(error => {
        sendResponse({ success: false, error: error.message });
      });
    }
    return true;
  }

  if (request.action === 'manualCheckInFromSite') {
    if (batchCheckIn) {
      chrome.storage.local.get(['checkInResults', 'checkInRunState'], (data) => {
        sendResponse({
          success: true,
          running: true,
          results: data.checkInResults || {},
          runState: getCheckInRunState(data)
        });
      });
    } else {
      startCheckInRun('manual', {
        startSiteId: request.siteId,
        group: normalizeSiteGroup(request.group)
      }).then(results => {
        sendResponse({ success: true, running: false, results });
      }).catch(error => {
        sendResponse({ success: false, error: error.message });
      });
    }
    return true;
  }

  if (request.action === 'retrySiteCheckIn') {
    startSingleSiteCheckInRun(request.siteId).then(outcome => {
      if (outcome?.__busy) {
        sendResponse({
          success: false,
          running: false,
          busy: true,
          results: outcome.results,
          runState: outcome.runState,
          error: '该站点正在签到中'
        });
      } else {
        sendResponse({ success: true, running: false, results: outcome });
      }
    }).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  if (request.action === 'cancelCheckIn') {
    cancelCurrentCheckInRun().then(response => {
      sendResponse(response);
    }).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  if (request.action === 'cancelSingleSiteCheckIn') {
    cancelSingleSiteCheckInRun(request.siteId).then(response => {
      sendResponse(response);
    }).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  if (request.action === 'clearCheckInLogs') {
    resetCheckInLogs().then(() => {
      sendResponse({ success: true });
    }).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  if (request.action === 'getStatus') {
    chrome.storage.local.get(
      [
        'lastCheckInTime',
        'checkInResults',
        'checkInResultsDay',
        'checkInRunState',
        'autoSignTime',
        GROUP_AUTO_SIGN_TIMES_STORAGE_KEY,
        'checkInLogs'
      ],
      async (data) => {
      let runState = getCheckInRunState(data);
      let results = data.checkInResults || {};

      // 防线：storage 说批量还在跑，但内存里没有运行中的批量任务，说明是 worker
      // 被回收后的残留状态（recoverStaleCheckInState 可能尚未完成），就地清理。
      if (isCheckInRunningState(runState) && !batchCheckIn) {
        results = normalizeCheckInResultsForRun(results);
        runState = clearCheckInRunningState(runState);
        await chrome.storage.local.set({ checkInResults: results, checkInRunState: runState });
        chrome.action.setBadgeText({ text: '' });
      }

      const normalizedResults = normalizeTransientCheckingResults(results, runState);
      if (normalizedResults !== results) {
        results = normalizedResults;
        await chrome.storage.local.set({ checkInResults: results });
      }

      // 跨天后首次读取时清掉昨日状态，避免定时签到开始前仍显示昨天的结果。
      const dayReset = await resetCheckInResultsIfNewDay({
        ...data,
        checkInResults: results,
        checkInRunState: runState
      });
      results = dayReset.results;

      const singleSiteSnapshot = getSingleSiteRunSnapshot();

      sendResponse({
        ...data,
        checkInResults: results,
        checkInRunState: runState,
        checkInLogs: Array.isArray(data.checkInLogs) ? data.checkInLogs : [],
        autoSignTime: getFallbackAutoSignTime(data),
        groupAutoSignTimes: sanitizeGroupAutoSignTimes(data[GROUP_AUTO_SIGN_TIMES_STORAGE_KEY]),
        ...singleSiteSnapshot
      });
    });
    return true;
  }

  if (request.action === 'updateAutoSignTime') {
    const time = request.time;
    if (!isValidAutoSignTime(time)) {
      sendResponse({ success: false, error: '无效的时间格式' });
      return false;
    }

    updateGroupAutoSignTime(request.group, time).then(result => {
      sendResponse({ success: true, ...result });
    }).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  if (request.action === 'updateGroupAutoSignTimes') {
    updateAllGroupAutoSignTimes(request.groupAutoSignTimes, request.autoSignTime).then(result => {
      sendResponse({ success: true, ...result });
    }).catch((error) => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  // 页面内入口：将当前站点一键导入签到列表
  if (request.action === 'importCurrentSite') {
    importCurrentSite(request.site).then(result => {
      sendResponse(result);
    }).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  if (request.action === 'removeCurrentSite') {
    removeCurrentSite(request.site).then(result => {
      sendResponse(result);
    }).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }
});

// 将页面注入入口传入的站点写入 userSites（复用现有原始格式与去重逻辑）
async function importCurrentSite(rawSite) {
  const parsed = parseSiteInput(rawSite?.pageUrl || rawSite?.domain || '', 'checkin', 'auto');
  if (!parsed) {
    return { success: false, error: '无法识别当前站点地址' };
  }
  if (rawSite?.name) {
    parsed.name = String(rawSite.name).slice(0, 60);
  }

  const sites = await loadRawSites();
  if (sites.some(s => String(s.domain || '').toLowerCase() === parsed.domain)) {
    return { success: true, alreadyExists: true, domain: parsed.domain };
  }

  sites.push(parsed);
  await saveSitesConfig(sites);
  return { success: true, alreadyExists: false, domain: parsed.domain };
}

async function removeCurrentSite(rawSite) {
  const parsed = parseSiteInput(rawSite?.pageUrl || rawSite?.domain || '', 'checkin', 'auto');
  if (!parsed) {
    return { success: false, error: '无法识别当前站点地址' };
  }

  const sites = await loadRawSites();
  const nextSites = sites.filter(s => String(s?.domain || '').toLowerCase() !== parsed.domain);
  if (nextSites.length === sites.length) {
    return { success: true, notFound: true, domain: parsed.domain };
  }

  await saveSitesConfig(nextSites);
  return { success: true, notFound: false, domain: parsed.domain };
}

function startCheckInRun(
  source = 'manual',
  { resume = false, startSiteId = null, group = '' } = {}
) {
  if (batchCheckIn) {
    console.log('已有批量签到任务正在执行，跳过重复触发');
    return batchCheckIn.promise;
  }

  const cancelToken = createCheckInCancelToken();
  const runContext = { cancelToken, tabSession: null, currentSiteId: null };
  const promise = executeAllCheckIns({
    source,
    cancelToken,
    runContext,
    resume,
    startSiteId,
    group
  }).finally(() => {
    if (batchCheckIn?.cancelToken === cancelToken) batchCheckIn = null;
  });
  batchCheckIn = { promise, cancelToken, runContext };
  return promise;
}

async function startSingleSiteCheckInRun(siteId) {
  if (!siteId) throw new Error('缺少站点 ID');

  // 单站重试不被批量阻塞（完全独立并发）；仅同站防重入。
  if (isSiteBusy(siteId)) {
    console.log(`站点 ${siteId} 正在签到中，跳过重复触发`);
    const data = await chrome.storage.local.get(['checkInResults', 'checkInRunState']);
    return {
      __busy: true,
      results: normalizeCheckInResultsForRun(data.checkInResults || {}),
      runState: getCheckInRunState(data)
    };
  }

  const cancelToken = createCheckInCancelToken();
  const runContext = { cancelToken, tabSession: null, currentSiteId: siteId };
  const promise = executeSingleSiteCheckIn(siteId, { cancelToken, runContext }).finally(() => {
    singleSiteCheckIns.delete(siteId);
  });
  singleSiteCheckIns.set(siteId, { promise, cancelToken, runContext });
  return promise;
}

async function cancelSingleSiteCheckInRun(siteId) {
  if (!siteId) throw new Error('缺少站点 ID');

  const inflight = singleSiteCheckIns.get(siteId);
  const data = await chrome.storage.local.get(['checkInResults', 'checkInRunState']);
  const runState = getCheckInRunState(data);

  if (!inflight) {
    const results = normalizeTransientCheckingResults(data.checkInResults || {}, runState);
    if (results !== data.checkInResults) {
      await chrome.storage.local.set({ checkInResults: results });
    }
    return {
      success: true,
      running: false,
      results,
      runState,
      ...getSingleSiteRunSnapshot()
    };
  }

  requestCheckInCancel(inflight.cancelToken);
  await appendCheckInLog('系统', '未知', `收到单站终止请求，正在停止 ${siteId} 的重试任务`);
  await inflight.runContext?.tabSession?.close?.();

  return {
    success: true,
    running: true,
    results: data.checkInResults || {},
    runState,
    ...getSingleSiteRunSnapshot()
  };
}

function createCheckInCancelToken() {
  return {
    requested: false,
    requestedAt: null
  };
}

function isCheckInCancelRequested(cancelToken) {
  return cancelToken?.requested === true;
}

function requestCheckInCancel(cancelToken) {
  if (!cancelToken) return false;
  cancelToken.requested = true;
  cancelToken.requestedAt = cancelToken.requestedAt || new Date().toISOString();
  return true;
}

async function cancelCurrentCheckInRun() {
  // cancel 仅作用于批量签到（cancel 按钮仅在批量运行时出现）；单站重试靠超时×N 自终止。
  if (!batchCheckIn) {
    const data = await chrome.storage.local.get(['checkInResults', 'checkInRunState']);
    return {
      success: true,
      running: false,
      results: normalizeCheckInResultsForRun(data.checkInResults || {}),
      runState: getCheckInRunState(data)
    };
  }

  const { cancelToken, runContext } = batchCheckIn;
  requestCheckInCancel(cancelToken);
  await appendCheckInLog('系统', '未知', '收到终止请求，正在停止当前签到任务');
  await runContext?.tabSession?.close?.();

  const data = await chrome.storage.local.get(['checkInResults', 'checkInRunState']);
  const runState = getCheckInRunState(data);
  const nextRunState = isCheckInRunningState(runState)
    ? {
      ...runState,
      cancelling: true,
      cancelRequestedAt: cancelToken.requestedAt
    }
    : runState;
  const nextResults = normalizeCheckInResultsForRun(data.checkInResults || {});

  await chrome.storage.local.set({
    checkInResults: nextResults,
    checkInRunState: nextRunState
  });

  return {
    success: true,
    running: isCheckInRunningState(nextRunState),
    results: nextResults,
    runState: nextRunState
  };
}

// 单次签到尝试的硬超时包装：无论内部哪一步挂起，最多 ms 后必 settle。
// 调用方负责在 finally 关 tab 释放资源；这里对内部 promise 预挂空 catch，
// 防止超时胜出后内部后续 reject 沦为 unhandled rejection。
function withTimeout(promise, ms, label = '操作') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}超时（${ms}ms）`)), ms);
  });
  if (promise && typeof promise.catch === 'function') promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// 死站快速失败预检：正式尝试前，对站点根域发一次 no-cors GET。
// 活站（哪怕被 CORS / Cloudflare 拦截）会收到 opaque 响应即视为「可达」；
// 只有 TCP/TLS 握手撑不过 SITE_REACHABILITY_TIMEOUT_MS（死站特征）才判「不可达」。
// 判不可达时跳过全部重试，把最坏 ~4.5 分钟的空耗压到一次短超时。
async function probeSiteReachable(site) {
  const target = site?.visitUrl
    || (site?.cookieDomain ? `https://${site.cookieDomain}/` : null);
  if (!target) return { reachable: true }; // 拿不到探测目标时不拦截，交给正常流程

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SITE_REACHABILITY_TIMEOUT_MS);
  try {
    // no-cors：只关心「能否建连并拿到响应」，不读 body、不校验状态码。
    await fetch(target, {
      method: 'GET',
      mode: 'no-cors',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'follow',
      signal: controller.signal
    });
    return { reachable: true };
  } catch (e) {
    // AbortError（握手超时）或网络层 reject（DNS/连接失败）都判不可达。
    const reason = e?.name === 'AbortError'
      ? `${SITE_REACHABILITY_TIMEOUT_MS}ms 内未建连`
      : (e?.message || '网络连接失败');
    console.warn(`[reachability] ${site.siteName} 预检未通过（判为不可达）:`, e?.name || e?.message);
    return { reachable: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

// 站点不可达的结构化结果：走 failed 但独立文案，提示是网络连通问题而非签到失败。
function createUnreachableSiteResult(reason) {
  return {
    status: 'failed',
    unreachable: true,
    message: `站点无法连接（${reason || '预检未通过'}），已跳过重试`
  };
}

// 把某站点重试进度写入 checkInResults，供 UI 显示「重试中(N/M)」。
async function updateAttemptProgress(results, siteId, attempt) {
  if (!siteId) return;
  const { checkInResults: latest = {} } = await chrome.storage.local.get('checkInResults');
  await chrome.storage.local.set({
    checkInResults: {
      ...latest,
      [siteId]: {
        status: 'checking',
        message: `重试中(${attempt}/${SITE_CHECKIN_MAX_ATTEMPTS})`
      }
    }
  });
}

function createDisabledSkipResult(message = '检测到站点已禁用，跳过本轮签到') {
  return {
    skipped: true,
    reason: 'disabled',
    message
  };
}

async function isSiteEnabledInStorage(site) {
  const domain = String(site?.cookieDomain || '').trim().toLowerCase();
  if (!domain) return false;

  const sites = await loadRawSites();
  const rawSite = sites.find(item => item.domain === domain);
  return rawSite?.enabled !== false;
}

// 单次签到原子单元：类型解析 + 名称更新 + 实际签到/访问。
// 抽取自原 executeAllCheckIns / executeSingleSiteCheckIn 的重复片段。
async function executeSiteCheckInOnce(site, { tabSession, cancelToken } = {}) {
  const isDailyLoginSite = ['login', 'relogin'].includes(site.mode);
  if (isDailyLoginSite) {
    const modeLabel = site.mode === 'relogin' ? '重登签到' : '每日登录签到';
    await appendCheckInLog(site.siteName, '待检查', `开始执行${modeLabel}：先识别站点类型`);
    const resolvedSite = await resolveSiteType(site, tabSession);
    await appendCheckInLog(resolvedSite.siteName, '待检查', `站点类型识别完成：${resolvedSite.type}，进入独立登录流程`);
    const dailyLoginHandler = SITE_TYPE_DAILY_LOGIN_HANDLERS[resolvedSite.type];
    if (dailyLoginHandler) {
      return dailyLoginHandler(resolvedSite, tabSession);
    }
    await appendCheckInLog(resolvedSite.siteName, '待检查', `站点类型 ${resolvedSite.type} 暂无专用登录流程，使用通用登录流程`);
    return checkInByDailyLogin(resolvedSite, tabSession);
  }

  await appendCheckInLog(site.siteName, '待检查', '开始预处理：识别站点类型并准备执行路径');
  let resolvedSite = site.mode === 'visit'
    ? site
    : await resolveSiteType(site, tabSession);
  resolvedSite = await maybeUpdateSiteName(resolvedSite, tabSession);
  if (resolvedSite.mode === 'checkin') {
    const upgradedSite = await maybeUpgradeLegacyNewApiSite(resolvedSite, tabSession);
    if (upgradedSite !== resolvedSite) {
      resolvedSite = upgradedSite;
      await appendCheckInLog(
        resolvedSite.siteName,
        '待检查',
        `检测到站点实际为 ${resolvedSite.type}，已切换到${resolvedSite.useApi ? 'API' : '页面'}流程`
      );
    }
  }
  const executionPath = resolvedSite.mode === 'visit'
    ? '访问'
    : (resolvedSite.useApi ? 'API' : '页面');
  await appendCheckInLog(
    resolvedSite.siteName,
    '待检查',
    `预处理完成：当前模式 ${resolvedSite.mode}，站点类型 ${
      resolvedSite.mode === 'visit' ? 'visit' : resolvedSite.type
    }，执行方式 ${executionPath}`
  );
  if (isCheckInCancelRequested(cancelToken)) {
    return { status: 'failed', message: '签到中断' };
  }
  const executionLabel = `${resolvedSite.mode}/${resolvedSite.type}/${executionPath}`;
  await appendCheckInLog(resolvedSite.siteName, '待检查', `开始执行 ${executionLabel}`);
  console.log(`开始执行: ${resolvedSite.siteName} (${resolvedSite.mode}/${resolvedSite.type})`);
  if (resolvedSite.mode === 'visit') {
    return visitSite(resolvedSite, tabSession);
  }
  return checkInSite(resolvedSite, tabSession);
}

// 批量与单站共用的重试外壳：最多 SITE_CHECKIN_MAX_ATTEMPTS 次，每次受硬超时保护。
// 成功/已签/失效/中断 立即返回；仅 failed 进入下一次重试。
async function runSiteCheckInWithRetries(site, { cancelToken = null, runContext = null, onAttempt = null, beforeAttempt = null } = {}) {
  async function resolveAttemptDecision(attempt) {
    if (!beforeAttempt) return null;
    const decision = await beforeAttempt({ site, attempt });
    if (decision === false) {
      return createDisabledSkipResult('检测到站点已禁用，跳过后续重试');
    }
    return decision?.skipped ? decision : null;
  }

  // 死站快速失败：进入重试循环前先做一次可达性预检，不可达直接返回，避免耗尽 3 次×90s 预算。
  if (!isCheckInCancelRequested(cancelToken)) {
    const reach = await probeSiteReachable(site);
    if (!reach.reachable) {
      console.warn(`${site.siteName} 可达性预检失败，跳过重试:`, reach.reason);
      await appendCheckInLog(site.siteName, '未知', `站点不可达（${reach.reason}），已跳过本轮重试`);
      return createUnreachableSiteResult(reach.reason);
    }
  }

  let lastResult = null;
  for (let attempt = 1; attempt <= SITE_CHECKIN_MAX_ATTEMPTS; attempt++) {
    if (isCheckInCancelRequested(cancelToken)) {
      return { status: 'failed', message: '签到中断' };
    }
    const attemptDecision = await resolveAttemptDecision(attempt);
    if (attemptDecision) {
      return attemptDecision;
    }
    if (attempt > 1) {
      await appendCheckInLog(site.siteName, '未知', `开始第${attempt}/${SITE_CHECKIN_MAX_ATTEMPTS}次尝试`);
    }

    const tabSession = createSiteTabSession();
    if (runContext) runContext.tabSession = tabSession;
    try {
      const attemptPromise = executeSiteCheckInOnce(site, { tabSession, cancelToken });
      const result = await withTimeout(attemptPromise, SITE_CHECKIN_TIMEOUT_MS, site.siteName);
      if (isCheckInCancelRequested(cancelToken)) {
        lastResult = { status: 'failed', message: '签到中断' };
        return lastResult;
      }
      lastResult = result;
      // 成功/已签/失效：不再重试
      if (result.status === 'success' || result.status === 'already' || result.status === 'invalid') {
        return result;
      }
      console.warn(`${site.siteName} 第${attempt}/${SITE_CHECKIN_MAX_ATTEMPTS}次尝试失败:`, result?.message);
    } catch (error) {
      if (isCheckInCancelRequested(cancelToken)) {
        lastResult = { status: 'failed', message: '签到中断' };
        return lastResult;
      }
      if (isInvalidSiteError(error)) {
        console.warn(`${site.siteName} 站点失效，停止重试:`, error.message);
        return createInvalidSiteResult(error);
      }
      lastResult = { status: 'failed', message: error.message };
      console.warn(`${site.siteName} 第${attempt}/${SITE_CHECKIN_MAX_ATTEMPTS}次尝试异常:`, error.message);
    } finally {
      await tabSession.close();
      if (runContext?.tabSession === tabSession) runContext.tabSession = null;
    }

    if (attempt < SITE_CHECKIN_MAX_ATTEMPTS) {
      const nextAttemptDecision = await resolveAttemptDecision(attempt + 1);
      if (nextAttemptDecision) {
        return nextAttemptDecision;
      }
      if (onAttempt) await onAttempt(attempt + 1);
      await sleep(SITE_CHECKIN_RETRY_INTERVAL_MS);
    }
  }
  return lastResult || { status: 'failed', message: '签到失败' };
}

// 续签判定：上一轮已 success/already 的站点视为本轮已完成，跳过且沿用其结果（含余额）。
function isResumeDoneResult(result) {
  return result?.status === 'success' || result?.status === 'already';
}

function getBatchTaskSites(sites = [], { startSiteId = null, group = '' } = {}) {
  const scopedSites = filterSitesByGroup(sites, group);
  const startIndex = startSiteId
    ? scopedSites.findIndex(site => site.siteId === startSiteId)
    : 0;

  if (startSiteId && startIndex === -1) {
    throw new Error('未在当前分组找到起始站点');
  }

  return {
    startSite: startIndex >= 0 ? scopedSites[startIndex] : null,
    taskSites: scopedSites.slice(Math.max(startIndex, 0))
  };
}

function getCheckInGroupLabel(group) {
  return normalizeSiteGroup(group) || '默认';
}

// 全量/从某站重启：删掉目标站点结果，面板立刻回到「待签」。
function clearSelectedResults(results = {}, siteIds = new Set()) {
  const next = { ...(results || {}) };
  for (const siteId of siteIds) {
    delete next[siteId];
  }
  return next;
}

// 执行所有站点签到
async function executeAllCheckIns({
  source = 'manual',
  cancelToken = null,
  runContext = null,
  resume = false,
  startSiteId = null,
  group = ''
} = {}) {
  const groupLabel = `${getCheckInGroupLabel(group)}分组`;
  console.log(startSiteId
    ? `开始在 ${groupLabel} 从指定站点继续签到: ${startSiteId}`
    : resume
    ? `开始继续签到（${groupLabel}，仅未完成站点）`
    : `开始批量签到（${groupLabel}）`);
  const sites = await loadSitesConfig();
  const { startSite, taskSites } = getBatchTaskSites(sites, {
    startSiteId,
    group
  });
  const total = taskSites.length;
  if (total <= 0) {
    throw new Error(startSiteId
      ? '起始站点之后没有可签到的站点配置'
      : '当前分组没有可签到的站点配置');
  }

  const targetSiteIds = new Set(taskSites.map(site => site.siteId));
  const stored = await chrome.storage.local.get([
    'checkInResults',
    'checkInResultsDay',
    'lastCheckInTime',
    'checkInRunState'
  ]);
  // 跨日启动：昨日结果作废（含 resume，避免把昨日「成功」当今日已完成）。
  const dayReset = await resetCheckInResultsIfNewDay(stored, { force: true });
  const previousResults = dayReset.results;
  const normalizedPreviousResults = normalizeCheckInResultsForRun(previousResults);
  await resetCheckInLogs();
  await appendCheckInLog('系统', '未知', startSite
    ? `在 ${groupLabel} 从 ${startSite.siteName} 开始继续签到，共 ${total} 个任务站点`
    : resume
    ? `开始继续签到 ${groupLabel}，共 ${total} 个任务站点`
    : `开始批量签到 ${groupLabel}，共 ${total} 个任务站点`);

  // 续签：保留上轮已完成站点的结果（含余额）作为种子；
  // 立即签到 / 定时签到：删掉目标站点结果，UI 立即显示「待签」。
  const results = resume
    ? Object.fromEntries(
        Object.entries(normalizedPreviousResults).filter(([siteId, r]) => {
          return !targetSiteIds.has(siteId) || isResumeDoneResult(r);
        })
      )
    : clearSelectedResults(normalizedPreviousResults, targetSiteIds);

  let current = 0;
  const startedRunState = {
    ...buildCheckInRunningState({ total, source }),
    group: normalizeSiteGroup(group)
  };
  await chrome.storage.local.set({
    checkInRunState: startedRunState,
    checkInResults: resume
      ? { ...normalizedPreviousResults, ...results }
      : results,
    checkInResultsDay: getLocalDayKey()
  });

  // 设置初始badge
  chrome.action.setBadgeBackgroundColor({ color: '#667eea' });
  chrome.action.setBadgeText({ text: '0/' + total });

  for (let site of taskSites) {
    if (isCheckInCancelRequested(cancelToken)) {
      console.log('签到任务已终止，停止处理后续站点');
      break;
    }

    const siteGroup = normalizeSiteGroup(site.group);

    // 续签：上轮已完成（成功/已签）的站点直接计入进度并跳过，结果已在种子里。
    if (resume && isResumeDoneResult(results[site.siteId])) {
      current++;
      chrome.action.setBadgeText({ text: `${current}/${total}` });
      console.log(`${site.siteName} 上轮已完成，跳过`);
      continue;
    }

    current++;
    if (runContext) runContext.currentSiteId = site.siteId;
    const progressRunState = {
      ...startedRunState,
      current,
      currentSiteId: site.siteId,
      currentGroup: siteGroup
    };
    // 更新badge进度
    chrome.action.setBadgeText({ text: `${current}/${total}` });
    if (!(await isSiteEnabledInStorage(site))) {
      delete results[site.siteId];
      await chrome.storage.local.set({
        checkInRunState: progressRunState,
        checkInResults: { ...results }
      });
      await appendCheckInLog(site.siteName, '未知', '检测到站点已禁用，跳过本轮签到');
      continue;
    }
    await chrome.storage.local.set({
      checkInRunState: progressRunState,
      checkInResults: markSiteChecking(results, site.siteId)
    });

    // 同站防重入：该站正被单站重试占用时，等待其结果而非重复执行
    const inflight = singleSiteCheckIns.get(site.siteId);
    if (inflight) {
      console.log(`${site.siteName} 正在单站重试，等待其结果`);
      try {
        // inflight.promise resolve 的是完整 results map，取本站结果
        const inflightResults = await inflight.promise;
        results[site.siteId] = inflightResults?.[site.siteId]
          || { status: 'failed', message: '签到失败' };
      } catch (e) {
        results[site.siteId] = { status: 'failed', message: e?.message || '签到失败' };
      }
      if (!(await isSiteEnabledInStorage(site))) {
        delete results[site.siteId];
        await appendCheckInLog(site.siteName, '未知', '检测到站点已禁用，跳过本轮签到');
        await chrome.storage.local.set({ checkInResults: { ...results } });
        if (isCheckInCancelRequested(cancelToken)) break;
        continue;
      }
      await chrome.storage.local.set({ checkInResults: results });
      if (isCheckInCancelRequested(cancelToken)) break;
      await sleep(SITE_CHECKIN_RETRY_INTERVAL_MS);
      continue;
    }

    const result = await runSiteCheckInWithRetries(site, {
      cancelToken,
      runContext,
      onAttempt: (nextAttempt) => updateAttemptProgress(results, site.siteId, nextAttempt),
      beforeAttempt: async () => (
        (await isSiteEnabledInStorage(site))
          ? true
          : createDisabledSkipResult('检测到站点已禁用，跳过后续重试')
      )
    });
    if (result?.skipped === true && result.reason === 'disabled') {
      delete results[site.siteId];
      await appendCheckInLog(site.siteName, '未知', result.message);
      await chrome.storage.local.set({ checkInResults: { ...results } });
      continue;
    }
    results[site.siteId] = isCheckInCancelRequested(cancelToken)
      ? { status: 'failed', message: '签到中断' }
      : result;
    console.log(`${site.siteName} 执行结果:`, result);
    await appendCheckInLog(site.siteName, deriveLogLoginStatusFromResult(results[site.siteId]), buildResultLogMessage(results[site.siteId]));
    await chrome.storage.local.set({ checkInResults: results });

    if (isCheckInCancelRequested(cancelToken)) {
      console.log('签到任务已终止');
      break;
    }

    await sleep(2000);
  }

  await chrome.storage.local.set({
    lastCheckInTime: new Date().toISOString(),
    checkInResults: normalizeCheckInResultsForRun(results),
    checkInResultsDay: getLocalDayKey(),
    checkInRunState: clearCheckInRunningState(startedRunState)
  });

  // 显示最终结果badge
  const targetResults = taskSites
    .map(site => results[site.siteId])
    .filter(Boolean);
  const skippedCount = Math.max(taskSites.length - targetResults.length, 0);
  const successCount = targetResults.filter(r => r.status === 'success').length;
  const alreadyCount = targetResults.filter(r => r.status === 'already').length;
  const failedCount = targetResults.filter(r => r.status === 'failed' || r.status === 'invalid').length;

  if (failedCount > 0) {
    chrome.action.setBadgeBackgroundColor({ color: '#dc3545' });
    chrome.action.setBadgeText({ text: '✗' + failedCount });
  } else if (successCount > 0) {
    chrome.action.setBadgeBackgroundColor({ color: '#28a745' });
    chrome.action.setBadgeText({ text: '✓' });
  } else {
    chrome.action.setBadgeBackgroundColor({ color: '#17a2b8' });
    chrome.action.setBadgeText({ text: '✓' });
  }

  // 5秒后清除badge
  setTimeout(() => {
    chrome.action.setBadgeText({ text: '' });
  }, 5000);

  await appendCheckInLog('系统', '未知', startSite
    ? `${groupLabel} 从 ${startSite.siteName} 开始的签到结束：成功 ${successCount}，已签 ${alreadyCount}，失败 ${failedCount}，跳过 ${skippedCount}`
    : `${groupLabel} 签到结束：成功 ${successCount}，已签 ${alreadyCount}，失败 ${failedCount}，跳过 ${skippedCount}`);

  return results;
}

async function executeSingleSiteCheckIn(siteId, { cancelToken = null, runContext = null } = {}) {
  if (!siteId) throw new Error('缺少站点 ID');

  const sites = await loadSitesConfig();
  const site = sites.find(item => item.siteId === siteId);
  if (!site) throw new Error('未找到要重试的站点');
  if (!site.enabled) throw new Error('站点已禁用，请启用后重试');

  // 单站重试不翻转全局 running 标志（与批量解耦）；只把该站状态写成 checking 数据。
  // 跨日时先清空昨日结果，避免只更新 lastCheckInTime/日键却保留其它站昨日状态。
  const stored = await chrome.storage.local.get([
    'checkInResults',
    'checkInResultsDay',
    'lastCheckInTime',
    'checkInRunState'
  ]);
  const dayReset = await resetCheckInResultsIfNewDay(stored, { force: true });
  const previousResults = dayReset.results;
  await chrome.storage.local.set({
    checkInResults: markSiteChecking(normalizeCheckInResultsForRun(previousResults), siteId),
    checkInResultsDay: getLocalDayKey()
  });
  await appendCheckInLog(site.siteName, '未知', '开始单站重试');

  let result;
  try {
    result = await runSiteCheckInWithRetries(site, {
      cancelToken,
      runContext,
      onAttempt: (nextAttempt) => updateAttemptProgress({}, siteId, nextAttempt)
    });
    console.log(`${site.siteName} 单站重试结果:`, result);
  } catch (error) {
    console.warn(`${site.siteName} 单站重试失败（已捕获，转 failed 结果）:`, error);
    result = { status: 'failed', message: error.message };
  }

  const { checkInResults: latestResults = {} } = await chrome.storage.local.get('checkInResults');
  const nextResults = {
    ...normalizeCheckInResultsForRun(latestResults),
    [siteId]: result
  };

  await chrome.storage.local.set({
    checkInResults: nextResults,
    checkInResultsDay: getLocalDayKey(),
    lastCheckInTime: new Date().toISOString()
  });
  await appendCheckInLog(site.siteName, deriveLogLoginStatusFromResult(result), `单站重试完成：${buildResultLogMessage(result)}`);

  return nextResults;
}

async function maybeUpdateSiteName(site, tabSession = null) {
  const rawSite = {
    domain: site.cookieDomain,
    name: site.siteName
  };
  if (!shouldAutoFetchSiteName(rawSite)) return site;

  const fetchedName = await fetchSiteDisplayName(site, tabSession);
  if (!fetchedName) return site;

  await updateRawSiteName(site.cookieDomain, fetchedName);
  console.log(`${site.siteName} 自动获取站点名称: ${fetchedName}`);

  return buildSiteConfig({
    domain: site.cookieDomain,
    name: fetchedName,
    enabled: site.enabled,
    mode: site.mode,
    type: site.type,
    pageUrl: site.visitUrl,
    useApi: ['sota-agent', 'fengwind-welfare', 'pipi-studio'].includes(site.type) ? site.useApi : undefined
  });
}

async function fetchSiteDisplayName(site, tabSession = null) {
  let tab;
  try {
    tab = await openSiteSessionTab(tabSession, site.visitUrl, 15000);
    await sleep(1000);

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        title: document.title,
        ogSiteName: document.querySelector('meta[property="og:site_name"]')?.content || '',
        applicationName: document.querySelector('meta[name="application-name"]')?.content || '',
        siteName: document.querySelector('meta[name="site-name"]')?.content || ''
      })
    });

    return pickSiteDisplayName(results[0]?.result || {}, site.cookieDomain);
  } catch (e) {
    if (isInvalidSiteError(e)) throw e;
    console.warn(`${site.siteName} 获取站点名称失败:`, e);
    return null;
  } finally {
    if (!tabSession && tab?.id) {
      try { await chrome.tabs.remove(tab.id); } catch (e) {}
    }
  }
}

// 单个站点访问
async function visitSite(site, tabSession = null) {
  let tab;
  try {
    tab = await openSiteSessionTab(tabSession, site.visitUrl, 20000);
    await sleep(3000);

    const tabInfo = await chrome.tabs.get(tab.id);
    if (isInvalidTabUrl(tabInfo.url)) {
      return { status: 'invalid', message: '站点页面失效' };
    }

    await refreshVisitPageBeforeReadingBalance(tab.id, site);

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        bodyText: document.body?.innerText || ''
      })
    });

    const page = results[0]?.result;
    if (!page || isInvalidTabUrl(page.url)) {
      return { status: 'invalid', message: '站点页面失效' };
    }

    const loaded = page.readyState === 'complete' || page.readyState === 'interactive';
    if (!loaded) {
      return { status: 'failed', message: '页面未完成加载' };
    }

    const balance = extractBalanceFromText(page.bodyText);
    const result = { status: 'success', message: '已访问' };
    if (balance) result.balance = balance;
    return result;
  } finally {
    if (!tabSession && tab?.id) {
      try { await chrome.tabs.remove(tab.id); } catch (e) {}
    }
  }
}

async function checkInByDailyLogin(site, tabSession = null) {
  let tab;
  let reloginLogoutPerformed = false;
  try {
    tab = await openSiteSessionTab(tabSession, site.visitUrl, 20000);
    await sleep(2500);

    const logoutBeforeRelogin = async (currentState) => {
      if (site.mode !== 'relogin' || !currentState?.authenticated) {
        return currentState;
      }

      await appendCheckInLog(site.siteName, '退出中', '检测到已登录，先退出当前登录态');
      const logoutResult = await resetSiteLoginSession(site, tab.id);
      if (!logoutResult.success) {
        throw new Error('未能退出当前站点登录态');
      }

      await chrome.tabs.update(tab.id, { url: site.visitUrl, active: false });
      await ensureTabPageReady(tab.id, site.visitUrl, 20000);
      await sleep(1200);
      const afterLogout = await inspectDailyLoginAuthState(site, tab.id);
      if (afterLogout.authenticated) {
        throw new Error('退出登录未生效，已停止重新登录');
      }
      reloginLogoutPerformed = true;
      await appendCheckInLog(site.siteName, '未登录', '已退出当前登录态，准备重新进行 LinuxDo 登录');
      return afterLogout;
    };

    await appendCheckInLog(site.siteName, '检查中', '确认当前站点登录态');
    let authState = await inspectDailyLoginAuthState(site, tab.id);
    if (authState.authenticated) {
      await appendCheckInLog(site.siteName, '已登录', '已确认当前站点处于登录状态');
    } else if (authState.unauthenticated) {
      await appendCheckInLog(site.siteName, '未登录', '已确认当前站点未登录');
    } else {
      await appendCheckInLog(site.siteName, '未知', '暂未确认当前登录态，转到登录页继续探测');
    }

    authState = await logoutBeforeRelogin(authState);

    if (site.mode === 'login' && authState.authenticated) {
      return buildDailyLoginSuccessResult(site, tab.id, '已登录，访问签到完成');
    }

    if (site.mode === 'relogin' && authState.authenticated) {
      return { status: 'failed', message: '退出登录未生效，已停止重新登录' };
    }

    let entry = await findDailyLoginEntry(site, tab, authState);
    tab = entry.tab;
    authState = entry.state;
    if (authState.authenticated || entry.authenticatedByRedirect) {
      if (site.mode === 'relogin') {
        await appendCheckInLog(site.siteName, '已登录', '登录页探测确认当前站点处于登录状态');
        authState = await logoutBeforeRelogin({
          ...authState,
          authenticated: authState.authenticated || entry.authenticatedByRedirect
        });
        entry = await findDailyLoginEntry(site, tab, authState);
        tab = entry.tab;
        authState = entry.state;
      } else {
        return buildDailyLoginSuccessResult(site, tab.id, '已登录，访问签到完成');
      }
    }

    if (site.type === 'auto') {
      await appendCheckInLog(site.siteName, '待登录', '已确认需要登录，开始识别站点登录协议');
      site = await resolveSiteType(site, tabSession);
      await appendCheckInLog(site.siteName, '待登录', `站点登录协议识别完成：${site.type}`);

      entry = await findDailyLoginEntry(site, tab);
      tab = entry.tab;
      authState = entry.state;
      if (authState.authenticated || entry.authenticatedByRedirect) {
        if (site.mode !== 'relogin') {
          return buildDailyLoginSuccessResult(site, tab.id, '已登录，访问签到完成');
        }
        await appendCheckInLog(site.siteName, '已登录', '协议识别后确认当前站点处于登录状态');
        authState = await logoutBeforeRelogin({
          ...authState,
          authenticated: true
        });
        entry = await findDailyLoginEntry(site, tab, authState);
        tab = entry.tab;
        authState = entry.state;
      }
    }

    if (!entry.flow) {
      return { status: 'failed', message: '未找到可用的 LinuxDo 登录入口' };
    }

    await appendCheckInLog(
      site.siteName,
      '待登录',
      site.mode === 'relogin' && reloginLogoutPerformed
        ? '当前已退出登录，开始 LinuxDo 登录'
        : '当前未登录，直接开始 LinuxDo 登录'
    );

    const linuxDoCookies = await chrome.cookies.getAll({ domain: 'linux.do' });
    if (linuxDoCookies.length === 0) {
      return { status: 'failed', message: '浏览器尚未登录 linux.do' };
    }

    const loginTab = await ensureOfficialPageLoginBeforeCheckIn(site, tab, tabSession);
    if (loginTab?.id) tab = loginTab;
    const finalState = await inspectDailyLoginAuthState(site, tab.id);
    const loginCompleted = Boolean(tab._officialLoginCompleted) && !finalState.unauthenticated;
    if (!loginCompleted && !finalState.authenticated) {
      return { status: 'failed', message: 'LinuxDo 登录后未确认站点登录态' };
    }

    const message = site.mode === 'relogin' ? '重新登录签到完成' : 'LinuxDo 登录签到完成';
    return buildDailyLoginSuccessResult(site, tab.id, message);
  } catch (error) {
    if (isInvalidSiteError(error)) throw error;
    console.warn(`${site.siteName} 每日登录签到失败:`, error);
    return { status: 'failed', message: error.message || '每日登录签到失败' };
  } finally {
    if (tab?.id && !tabSession?.owns(tab.id)) {
      await closeTabQuietly(tab.id);
    }
  }
}

async function inspectNewApiDailyLoginAuthState(site, tabId) {
  const pageState = decorateOfficialPageAuthState(
    site,
    await inspectOfficialPageAuthState(tabId, site.unauthKeywords, site.cookieDomain)
  );
  const tabInfo = await chrome.tabs.get(tabId);
  const url = tabInfo.url || tabInfo.pendingUrl || pageState?.url || '';
  let session = { hasUser: false, userAuthenticated: false };
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        let hasUser = Boolean(localStorage.getItem('user') || sessionStorage.getItem('user'));
        if (!hasUser) {
          try {
            const raw = localStorage.getItem('new-api-auth-session') ||
              sessionStorage.getItem('new-api-auth-session');
            const parsed = raw ? JSON.parse(raw) : null;
            const auth = parsed?.state?.auth || parsed?.auth || parsed?.state || parsed;
            hasUser = Boolean(auth?.user);
          } catch (e) {}
        }
        return { hasUser };
      }
    });
    session = {
      hasUser: Boolean(results[0]?.result?.hasUser),
      userAuthenticated: false
    };
  } catch (e) {}
  const authState = classifyNewApiDailyLoginAuthState({
    url,
    domain: site.cookieDomain,
    pageState,
    session
  });
  return { ...authState, pageState, session, url };
}

async function logoutNewApiDailyLoginSite(site, tabId) {
  await clearCachedHeaders(site.siteId);
  let apiResult = null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async () => {
        function readUserId() {
          try {
            const raw = localStorage.getItem('user') || sessionStorage.getItem('user');
            const user = raw ? JSON.parse(raw) : null;
            return String(user?.id || user?.user_id || user?.uid || '').trim();
          } catch (e) {
            return '';
          }
        }

        try {
          const headers = { Accept: 'application/json' };
          const userId = readUserId();
          if (userId) headers['New-API-User'] = userId;
          const response = await fetch('/api/user/logout', {
            method: 'GET',
            credentials: 'include',
            headers
          });
          const contentType = String(response.headers.get('content-type') || '').toLowerCase();
          let data = null;
          if (contentType.includes('application/json')) {
            try { data = await response.json(); } catch (e) {}
          }
          const success = response.ok && contentType.includes('application/json') && data?.success !== false;
          if (success) {
            const authKeys = [
              'access_token', 'accessToken', 'auth_token', 'authToken', 'token',
              'user_token', 'userToken', 'user', 'uid', 'new-api-auth-session'
            ];
            for (const storage of [localStorage, sessionStorage]) {
              for (const key of authKeys) storage.removeItem(key);
            }
          }
          return { success, httpStatus: response.status };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }
    });
    apiResult = results[0]?.result || null;
  } catch (e) {}

  if (apiResult?.success) {
    await appendCheckInLog(site.siteName, '退出中', '已调用 NewAPI 退出接口');
    return { success: true, method: 'newapi-api' };
  }

  await appendCheckInLog(site.siteName, '退出中', 'NewAPI 退出接口未完成，回退页面退出入口');
  return resetSiteLoginSession(site, tabId);
}

function formatNewApiDailyLoginAuthReason(reason) {
  const labels = {
    'verified-session': '会话接口确认',
    'authenticated-page-control': '登录后页面控件确认',
    'persisted-user-on-authenticated-route': '登录后路由与本地用户态确认',
    'login-page': '当前位于登录页',
    'login-entry-without-user': '存在登录入口且无本地用户态',
    unknown: '证据不足'
  };
  return labels[reason] || labels.unknown;
}

async function waitForNewApiDailyLoginAuthenticated(site, tabId, timeout = 30000) {
  const startedAt = Date.now();
  let callbackAttempted = false;
  let lastState = null;

  while (Date.now() - startedAt < timeout) {
    const tabInfo = await chrome.tabs.get(tabId);
    const currentUrl = tabInfo.url || tabInfo.pendingUrl || '';
    if (isOfficialPageOAuthPendingUrl(currentUrl, site.cookieDomain) && !callbackAttempted) {
      callbackAttempted = true;
      await sleep(1500);
      const callbackResult = await processNewApiOAuthCallback(tabId, 'NewAPI 登录签到');
      if (callbackResult?.success) {
        await chrome.tabs.update(tabId, { url: site.visitUrl, active: false });
        await ensureTabPageReady(tabId, site.visitUrl, 20000);
      }
    }

    lastState = await inspectNewApiDailyLoginAuthState(site, tabId);
    if (lastState.authenticated) {
      return { authenticated: true, state: lastState };
    }
    if (lastState.unauthenticated && Date.now() - startedAt >= 5000) {
      return { authenticated: false, state: lastState };
    }
    await sleep(800);
  }

  return { authenticated: false, state: lastState };
}

async function loginNewApiDailyLoginSite(site, tab) {
  for (const loginUrl of getNewApiLoginUrlCandidates(site.cookieDomain, site.visitUrl)) {
    await chrome.tabs.update(tab.id, { url: loginUrl, active: false });
    await ensureTabPageReady(tab.id, loginUrl, 20000);
    await sleep(800);

    const loginState = await inspectNewApiDailyLoginAuthState(site, tab.id);
    if (!loginState.pageState?.hasLinuxDoLoginEntry) {
      continue;
    }

    const started = await startSiteLinuxDoOAuthFromLoginPage(
      tab.id,
      site.cookieDomain,
      site.visitUrl,
      'NewAPI 登录签到',
      loginUrl
    );
    if (!started?.tabId) {
      continue;
    }

    const settled = await waitForNewApiDailyLoginAuthenticated(site, started.tabId, 30000);
    if (!settled.authenticated) {
      continue;
    }

    const currentTab = await chrome.tabs.get(started.tabId);
    if (currentTab.url !== site.visitUrl) {
      await chrome.tabs.update(started.tabId, { url: site.visitUrl, active: false });
      await ensureTabPageReady(started.tabId, site.visitUrl, 20000);
      await sleep(1000);
    }

    const finalState = await inspectNewApiDailyLoginAuthState(site, started.tabId);
    if (finalState.authenticated) {
      return { tabId: started.tabId, state: finalState };
    }
  }

  return null;
}

async function checkInNewApiDailyLogin(site, tabSession = null) {
  let tab;
  try {
    tab = await openSiteSessionTab(tabSession, site.visitUrl, 20000);
    await sleep(2000);
    await appendCheckInLog(site.siteName, '检查中', 'NewAPI 专用流程：检查当前登录态');

    let authState = await inspectNewApiDailyLoginAuthState(site, tab.id);
    if (authState.authenticated) {
      await appendCheckInLog(site.siteName, '已登录', `NewAPI 已确认登录：${formatNewApiDailyLoginAuthReason(authState.reason)}`);
    } else if (authState.unauthenticated) {
      await appendCheckInLog(site.siteName, '未登录', `NewAPI 已确认未登录：${formatNewApiDailyLoginAuthReason(authState.reason)}`);
    } else {
      await appendCheckInLog(site.siteName, '未知', `NewAPI 暂未确认登录态：${formatNewApiDailyLoginAuthReason(authState.reason)}，转登录页探测`);
    }

    if (!authState.authenticated && !authState.unauthenticated) {
      const loginUrl = getNewApiLoginUrl(site.cookieDomain, site.visitUrl);
      await chrome.tabs.update(tab.id, { url: loginUrl, active: false });
      await ensureTabPageReady(tab.id, loginUrl, 20000);
      await sleep(1000);
      authState = await inspectNewApiDailyLoginAuthState(site, tab.id);
      if (authState.authenticated) {
        await appendCheckInLog(site.siteName, '已登录', `NewAPI 登录页探测确认已登录：${formatNewApiDailyLoginAuthReason(authState.reason)}`);
      } else if (authState.unauthenticated) {
        await appendCheckInLog(site.siteName, '未登录', `NewAPI 登录页确认未登录：${formatNewApiDailyLoginAuthReason(authState.reason)}`);
      }
    }

    if (site.mode === 'relogin' && authState.authenticated) {
      await appendCheckInLog(site.siteName, '退出中', 'NewAPI 已登录，先执行站点退出');
      const logoutResult = await logoutNewApiDailyLoginSite(site, tab.id);
      if (!logoutResult.success) {
        return { status: 'failed', message: 'NewAPI 未能退出当前登录态' };
      }
      await chrome.tabs.update(tab.id, { url: site.visitUrl, active: false });
      await ensureTabPageReady(tab.id, site.visitUrl, 20000);
      await sleep(1200);
      authState = await inspectNewApiDailyLoginAuthState(site, tab.id);
      if (authState.authenticated) {
        return { status: 'failed', message: 'NewAPI 退出登录未生效' };
      }
      await appendCheckInLog(site.siteName, '未登录', 'NewAPI 已退出，准备 LinuxDo 登录');
    }

    if (site.mode === 'login' && authState.authenticated) {
      return buildDailyLoginSuccessResult(site, tab.id, 'NewAPI 已登录，自动签到完成');
    }

    if (!authState.unauthenticated) {
      return { status: 'failed', message: 'NewAPI 未能确认未登录状态' };
    }

    await appendCheckInLog(site.siteName, '待登录', site.mode === 'relogin'
      ? 'NewAPI 已退出，开始 LinuxDo 登录'
      : 'NewAPI 当前未登录，开始 LinuxDo 登录');

    const loginResult = await loginNewApiDailyLoginSite(site, tab);
    if (!loginResult?.tabId) {
      return { status: 'failed', message: 'NewAPI LinuxDo 登录未完成' };
    }
    tab = await chrome.tabs.get(loginResult.tabId);
    await appendCheckInLog(site.siteName, '登录成功', 'NewAPI LinuxDo 登录完成，已返回站点');
    return buildDailyLoginSuccessResult(site, tab.id, site.mode === 'relogin'
      ? 'NewAPI 重登签到完成'
      : 'NewAPI LinuxDo 登录签到完成');
  } catch (error) {
    if (isInvalidSiteError(error)) throw error;
    await appendCheckInLog(site.siteName, '登录失败', error.message || 'NewAPI 登录流程失败');
    return { status: 'failed', message: error.message || 'NewAPI 登录流程失败' };
  } finally {
    if (tab?.id && !tabSession?.owns(tab.id)) {
      await closeTabQuietly(tab.id);
    }
  }
}

async function buildDailyLoginSuccessResult(site, tabId, message) {
  const result = { status: 'success', message };
  try {
    const balance = await readBalanceFromTab(tabId, site);
    if (balance) result.balance = balance;
  } catch (e) {}
  return result;
}

async function inspectDailyLoginAuthState(site, tabId) {
  const pageState = decorateOfficialPageAuthState(
    site,
    await inspectOfficialPageAuthState(tabId, site.unauthKeywords, site.cookieDomain)
  );
  const tabInfo = await chrome.tabs.get(tabId);
  const url = tabInfo.url || tabInfo.pendingUrl || pageState?.url || '';
  let session = null;
  try {
    session = await inspectNewApiBrowserSession(tabId);
  } catch (e) {}
  const authenticated = hasOfficialPageAuthenticatedEvidence(pageState, session, url);
  return {
    pageState,
    session,
    url,
    authenticated,
    unauthenticated: !authenticated && Boolean(pageState?.looksUnauthenticated || pageState?.isTargetLoginPage)
  };
}

function getDailyLoginUrlCandidates(site) {
  const candidates = [];
  const push = (url) => {
    const value = String(url || '').trim();
    if (value && !candidates.includes(value)) candidates.push(value);
  };

  push(getOfficialPageLoginUrl(site));
  for (const url of getNewApiLoginUrlCandidates(site.cookieDomain, site.visitUrl)) {
    push(url);
  }
  return candidates;
}

async function findDailyLoginEntry(site, tab, initialState = null) {
  let state = initialState || await inspectDailyLoginAuthState(site, tab.id);
  let flow = matchOfficialPageLoginFlow(site, state.pageState);
  if (flow || state.authenticated) {
    return { tab, state, flow, authenticatedByRedirect: false };
  }

  let authenticatedByRedirect = false;
  for (const loginUrl of getDailyLoginUrlCandidates(site)) {
    if (state.url !== loginUrl) {
      await chrome.tabs.update(tab.id, { url: loginUrl, active: false });
      await ensureTabPageReady(tab.id, loginUrl, 20000);
      await sleep(1200);
    }

    state = await inspectDailyLoginAuthState(site, tab.id);
    flow = matchOfficialPageLoginFlow(site, state.pageState);
    authenticatedByRedirect = isTargetDomainLoginPage(loginUrl, site.cookieDomain) &&
      !isTargetDomainLoginPage(state.url, site.cookieDomain) &&
      !state.unauthenticated &&
      !state.pageState?.hasLinuxDoLoginEntry;
    if (flow || state.authenticated || authenticatedByRedirect) break;
  }

  return { tab, state, flow, authenticatedByRedirect };
}

async function resetSiteLoginSession(site, tabId) {
  await clearCachedHeaders(site.siteId);

  const logoutResult = await clickSiteLogoutControl(tabId);
  if (logoutResult.clicked) {
    await sleep(1500);
    await appendCheckInLog(site.siteName, '退出中', '已触发站点退出登录入口');
    return { success: true, method: 'page' };
  }

  const [removedCookies, removedStorageKeys] = await Promise.all([
    removeSiteCookiesForLogout(site.cookieDomain),
    clearSiteAuthStorage(tabId)
  ]);
  const success = removedCookies > 0 || removedStorageKeys > 0;
  await appendCheckInLog(
    site.siteName,
    success ? '退出中' : '退出失败',
    success
      ? `未找到退出入口，已清理站点登录态（Cookie ${removedCookies}，认证存储 ${removedStorageKeys}）`
      : '未找到退出入口，也未发现可清理的站点登录态'
  );
  return { success, method: 'session', removedCookies, removedStorageKeys };
}

async function clearSiteAuthStorage(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const authKeys = [
          'access_token',
          'accessToken',
          'auth_token',
          'authToken',
          'token',
          'user_token',
          'userToken',
          'user',
          'uid',
          'new-api-auth-session'
        ];
        let removed = 0;
        for (const storage of [localStorage, sessionStorage]) {
          for (const key of authKeys) {
            if (storage.getItem(key) === null) continue;
            storage.removeItem(key);
            removed += 1;
          }
        }
        return removed;
      }
    });
    return Number(results[0]?.result || 0);
  } catch (e) {
    return 0;
  }
}

async function removeSiteCookiesForLogout(domain) {
  const cookies = await chrome.cookies.getAll({ domain });
  let removed = 0;
  for (const cookie of cookies) {
    if (/^(?:cf_clearance|__cf_bm|cf_chl_)/i.test(cookie.name)) continue;
    const host = String(cookie.domain || domain).replace(/^\./, '');
    const details = {
      url: `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path || '/'}`,
      name: cookie.name,
      storeId: cookie.storeId
    };
    if (cookie.partitionKey) details.partitionKey = cookie.partitionKey;
    try {
      const result = await chrome.cookies.remove(details);
      if (result) removed += 1;
    } catch (e) {}
  }
  return removed;
}

async function clickSiteLogoutControl(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async () => {
        const logoutPattern = /退出登录|退出账号|注销登录|登出|log\s*out|logout|sign\s*out|\bquit\b/i;
        const selectors = 'a[href], button, [role="button"], [role="menuitem"], [onclick]';

        function isVisible(el) {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        }

        function getText(el) {
          return [
            el.textContent,
            el.getAttribute('aria-label'),
            el.getAttribute('title'),
            el.getAttribute('href')
          ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
        }

        function findLogout() {
          return Array.from(document.querySelectorAll(selectors)).find((el) => {
            const text = getText(el);
            return text && text.length <= 100 && isVisible(el) && logoutPattern.test(text);
          });
        }

        function menuTriggerScore(el) {
          const text = getText(el);
          const className = String(el.className || '');
          let score = 0;
          if (/linuxdo|profile|account|user|用户|账号|账户|个人/i.test(text)) score += 10;
          if (/avatar|rounded-full|user-menu/i.test(className)) score += 5;
          return score;
        }

        let logout = findLogout();
        if (!logout) {
          const menuTriggers = Array.from(document.querySelectorAll('[aria-haspopup]'))
            .filter((el) => isVisible(el))
            .sort((left, right) => menuTriggerScore(right) - menuTriggerScore(left));
          for (const menuTrigger of menuTriggers) {
            menuTrigger.click();
            await new Promise(resolve => setTimeout(resolve, 500));
            logout = findLogout();
            if (!logout && menuTriggerScore(menuTrigger) > 0) {
              menuTrigger.click();
              await new Promise(resolve => setTimeout(resolve, 500));
              logout = findLogout();
            }
            if (logout) break;
          }
        }

        if (!logout) return { clicked: false };
        const text = getText(logout).slice(0, 80);
        logout.click();
        return { clicked: true, text };
      }
    });
    return results[0]?.result || { clicked: false };
  } catch (e) {
    return { clicked: false, error: e.message };
  }
}

async function refreshVisitPageBeforeReadingBalance(tabId, site) {
  if (!tabId) return;
  try {
    console.log(`${site.siteName} 访问后刷新页面以读取最新余额`);
    await chrome.tabs.reload(tabId);
    await ensureTabPageReady(tabId, site.visitUrl, 20000);
    await sleep(1000);
  } catch (e) {
    console.warn(`${site.siteName} 访问后刷新页面失败，继续尝试读取余额:`, e);
  }
}

async function resolveSiteType(site, tabSession = null) {
  if (site.type !== 'auto') return site;

  const detectedType = await detectSiteType(site, tabSession);
  const defaultsToApi = ['sota-agent', 'fengwind-welfare', 'pipi-studio'].includes(detectedType);
  const storedUseApi = defaultsToApi ? await getConfiguredUseApi(site.cookieDomain) : undefined;
  const configuredUseApi = defaultsToApi
    ? (typeof storedUseApi === 'boolean' ? storedUseApi : true)
    : site.useApi;
  await updateRawSiteType(site.cookieDomain, detectedType, {
    useApi: defaultsToApi ? configuredUseApi : undefined
  });

  return buildSiteConfig({
    domain: site.cookieDomain,
    name: site.siteName,
    enabled: site.enabled,
    mode: site.mode,
    type: detectedType,
    pageUrl: getResolvedVisitUrl(site, detectedType),
    useApi: configuredUseApi
  });
}

async function getConfiguredUseApi(domain) {
  const sites = await loadRawSites();
  const rawSite = sites.find(site => site.domain === domain);
  return typeof rawSite?.useApi === 'boolean' ? rawSite.useApi : undefined;
}

function getResolvedVisitUrl(site, type) {
  if (type === 'deeix-chat' && site.visitUrl.endsWith('/console/personal')) {
    return `https://${site.cookieDomain}${DEEIX_CHAT_DEFAULT_PATH}`;
  }
  if (type === 'deeix-chat' && isTargetDomainLoginPage(site.visitUrl, site.cookieDomain)) {
    return `https://${site.cookieDomain}${DEEIX_CHAT_DEFAULT_PATH}`;
  }
  if (type === 'infinite-canvas' && site.visitUrl.endsWith('/console/personal')) {
    return `https://${site.cookieDomain}/check-in`;
  }
  if (type === 'infinite-canvas' && isTargetDomainLoginPage(site.visitUrl, site.cookieDomain)) {
    return `https://${site.cookieDomain}${getInfiniteCanvasOAuthRedirect(site.visitUrl)}`;
  }
  if (type === 'sub2api' && site.visitUrl.endsWith('/console/personal')) {
    return `https://${site.cookieDomain}/check-in`;
  }
  if (type === 'sub2api' && isTargetDomainLoginPage(site.visitUrl, site.cookieDomain)) {
    return `https://${site.cookieDomain}${getSub2ApiOAuthRedirect(site.visitUrl)}`;
  }
  if (type === 'zenapi' && site.visitUrl.endsWith('/console/personal')) {
    return `https://${site.cookieDomain}/user`;
  }
  if (type === 'points-checkin') {
    if (site.visitUrl.endsWith('/console/personal') || isTargetDomainLoginPage(site.visitUrl, site.cookieDomain)) {
      return getPointsCheckinDefaultPageUrl(site.cookieDomain);
    }
  }
  if (type === 'localapi') {
    try {
      const parsed = new URL(site.visitUrl);
      if (
        parsed.hostname === site.cookieDomain &&
        (
          parsed.pathname === '/' ||
          parsed.pathname === '/console/personal' ||
          /^\/(?:login|sign-?in)(?:\/|$)/i.test(parsed.pathname)
        )
      ) {
        return getLocalApiDefaultPageUrl(site.cookieDomain);
      }
    } catch (e) {}
  }
  if (type === 'sota-agent' && isSotaAgentDomain(site.cookieDomain)) {
    return `https://${site.cookieDomain}${SOTA_AGENT_PAGE_PATH}`;
  }
  if (type === 'fengwind-welfare' && isFengwindWelfareDomain(site.cookieDomain)) {
    return `https://${site.cookieDomain}${FENGWIND_WELFARE_PAGE_PATH}`;
  }
  if (type === 'pipi-studio' && isPipiStudioDomain(site.cookieDomain)) {
    return `https://${site.cookieDomain}${PIPI_STUDIO_PAGE_PATH}`;
  }
  return site.visitUrl;
}

function getPointsCheckinDefaultPageUrl(domain) {
  return `https://${domain}/#/checkin`;
}

function getLocalApiDefaultPageUrl(domain) {
  return `https://${domain}/checkin`;
}

async function maybeUpgradeLegacyNewApiSite(site, tabSession = null) {
  if (site?.type !== 'newapi' || site?.mode === 'visit') {
    return site;
  }

  const detectedType = await detectSiteType(site, tabSession);
  if (
    !detectedType ||
    detectedType === 'unknown' ||
    detectedType === 'newapi' ||
    detectedType === site.type ||
    !SITE_TYPE_CHECK_IN_HANDLERS[detectedType]
  ) {
    return site;
  }

  let forcedUseApi =
    detectedType === 'sub2api' ||
      detectedType === 'points-checkin' ||
      detectedType === 'localapi' ||
      detectedType === 'fengwind-welfare'
      ? true
      : undefined;
  if (detectedType === 'sota-agent') {
    const configuredUseApi = await getConfiguredUseApi(site.cookieDomain);
    forcedUseApi = typeof configuredUseApi === 'boolean' ? configuredUseApi : true;
  }
  if (detectedType === 'fengwind-welfare') {
    const configuredUseApi = await getConfiguredUseApi(site.cookieDomain);
    forcedUseApi = typeof configuredUseApi === 'boolean' ? configuredUseApi : true;
  }
  if (detectedType === 'pipi-studio') {
    const configuredUseApi = await getConfiguredUseApi(site.cookieDomain);
    forcedUseApi = typeof configuredUseApi === 'boolean' ? configuredUseApi : true;
  }
  await updateRawSiteType(site.cookieDomain, detectedType, { useApi: forcedUseApi });

  const resolvedPageUrl = detectedType === 'points-checkin'
    ? getPointsCheckinDefaultPageUrl(site.cookieDomain)
    : detectedType === 'localapi'
    ? getLocalApiDefaultPageUrl(site.cookieDomain)
    : detectedType === 'sota-agent'
    ? `https://${site.cookieDomain}${SOTA_AGENT_PAGE_PATH}`
    : detectedType === 'fengwind-welfare'
    ? `https://${site.cookieDomain}${FENGWIND_WELFARE_PAGE_PATH}`
    : detectedType === 'pipi-studio'
    ? `https://${site.cookieDomain}${PIPI_STUDIO_PAGE_PATH}`
    : getResolvedVisitUrl(site, detectedType);

  const nextSite = buildSiteConfig({
    domain: site.cookieDomain,
    name: site.siteName,
    enabled: site.enabled,
    type: detectedType,
    pageUrl: resolvedPageUrl,
    useApi: typeof forcedUseApi === 'boolean' ? forcedUseApi : site.useApi
  });
  nextSite._legacyTypeUpgradedFrom = site.type;
  return nextSite;
}

function buildSiteTypeProbeUrls(site) {
  const urls = [];
  const push = (value) => {
    const url = String(value || '').trim();
    if (!url || urls.includes(url)) return;
    urls.push(url);
  };

  push(site?.visitUrl);
  if (site?.cookieDomain) {
    push(`https://${site.cookieDomain}/login`);
    push(`https://${site.cookieDomain}/home`);
    push(`https://${site.cookieDomain}/`);
  }
  return urls;
}

async function detectSiteTypeFromHtml(site) {
  const probeUrls = buildSiteTypeProbeUrls(site);
  for (const url of probeUrls) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      let response;
      try {
        response = await fetch(url, {
          method: 'GET',
          redirect: 'follow',
          signal: controller.signal
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) continue;
      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      if (!contentType.includes('text/html')) continue;

      const html = await response.text();
      if (!html) continue;

      if (
        html.includes('window.__APP_CONFIG__=') &&
        (
          html.includes('linuxdo_oauth_enabled') ||
          html.includes('api_base_url') ||
          html.includes('turnstile_site_key')
        )
      ) {
        return 'sub2api';
      }

      if (
        /<title>\s*LocalAPI\s*<\/title>/i.test(html) ||
        /localapi_(?:user|admin)_token/i.test(html)
      ) {
        return 'localapi';
      }

      // points-checkin SPA 常见：标题含智画创/WisArt，且无 NewAPI/Sub2API 特征
      if (
        /智画创|WisArt/i.test(html) &&
        !html.includes('window.__APP_CONFIG__=') &&
        !/linuxdo_client_id|New-API-User/i.test(html)
      ) {
        return 'points-checkin';
      }
    } catch (e) {}
  }
  return null;
}

// LocalAPI：公开配置 + 受保护签到接口，登录态通过 x-user-token 传递。
async function detectLocalApiFromApi(domain) {
  const host = String(domain || '').trim().toLowerCase();
  if (!host) return false;

  async function fetchJson(path) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`https://${host}${path}`, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        credentials: 'omit',
        headers: { Accept: 'application/json' }
      });
      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (e) {
        data = null;
      }
      return { ok: response.ok, status: response.status, data };
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    const [config, checkin] = await Promise.all([
      fetchJson('/user/api/config'),
      fetchJson('/user/api/checkin')
    ]);
    const configData = config.data;
    const checkinData = checkin.data;
    const configLooksLikeLocalApi =
      config.ok &&
      configData &&
      typeof configData === 'object' &&
      Object.prototype.hasOwnProperty.call(configData, 'checkin_enabled') &&
      (
        Object.prototype.hasOwnProperty.call(configData, 'linuxdo_enabled') ||
        Object.prototype.hasOwnProperty.call(configData, 'password_login_enabled')
      );
    const checkinLooksLikeLocalApi =
      checkinData &&
      typeof checkinData === 'object' &&
      (
        Object.prototype.hasOwnProperty.call(checkinData, 'settings') ||
        Object.prototype.hasOwnProperty.call(checkinData, 'checked_in_today') ||
        /invalid or expired user session/i.test(String(checkinData.error || ''))
      );
    return Boolean(configLooksLikeLocalApi && checkinLooksLikeLocalApi);
  } catch (e) {
    console.warn(`[LocalAPI] API 探测失败 ${host}:`, e);
    return false;
  }
}

// 不依赖标签页：直接用 SW fetch 探测 points-checkin 协议特征
async function detectPointsCheckinFromApi(domain) {
  const host = String(domain || '').trim().toLowerCase();
  if (!host) return false;

  async function fetchJson(path) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`https://${host}${path}`, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        credentials: 'omit',
        headers: { Accept: 'application/json' }
      });
      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (e) {
        data = null;
      }
      return { ok: response.ok, status: response.status, data, contentType: response.headers.get('content-type') || '' };
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    const [linuxdoConfig, pointsCheckin, authMe] = await Promise.all([
      fetchJson('/api/auth/linuxdo/config'),
      fetchJson('/api/points/checkin'),
      fetchJson('/api/auth/me')
    ]);

    const hasLinuxdoConfig =
      linuxdoConfig.ok &&
      linuxdoConfig.data &&
      typeof linuxdoConfig.data === 'object' &&
      Object.prototype.hasOwnProperty.call(linuxdoConfig.data, 'enabled');

    const pointsLooksLikeApi =
      pointsCheckin.data &&
      typeof pointsCheckin.data === 'object' &&
      (
        Object.prototype.hasOwnProperty.call(pointsCheckin.data, 'daily_checkin') ||
        pointsCheckin.data.code === 'unauthorized' ||
        /未登录|登录已过期/.test(String(pointsCheckin.data.error || ''))
      );

    const meLooksLikeApi =
      authMe.data &&
      typeof authMe.data === 'object' &&
      (
        Object.prototype.hasOwnProperty.call(authMe.data, 'user') ||
        authMe.data.code === 'unauthorized' ||
        /未登录|登录已过期/.test(String(authMe.data.error || ''))
      );

    // 核心：linuxdo config + points/checkin JSON API
    if (hasLinuxdoConfig && pointsLooksLikeApi) {
      return true;
    }
    // 弱特征：points/checkin + auth/me 都是同协议 JSON，且不是 HTML 回落
    if (pointsLooksLikeApi && meLooksLikeApi) {
      return true;
    }
    return false;
  } catch (e) {
    console.warn(`[points-checkin] API 探测失败 ${host}:`, e);
    return false;
  }
}

async function detectSiteType(site, tabSession = null) {
  const urlHint = detectSiteTypeFromUrl(site.visitUrl);

  if (urlHint === 'fengwind-welfare') {
    console.log(`${site.siteName} URL 精确识别为 Fengwind 福利站`);
    return 'fengwind-welfare';
  }

  if (urlHint === 'sota-agent') {
    console.log(`${site.siteName} URL 精确识别为 Sota Agent`);
    return 'sota-agent';
  }

  if (urlHint === 'pipi-studio') {
    console.log(`${site.siteName} URL 精确识别为皮皮智绘`);
    return 'pipi-studio';
  }

  // 1) SW 侧 API 探测（不依赖 tab / 页面脚本）
  if (site?.cookieDomain && await detectLocalApiFromApi(site.cookieDomain)) {
    console.log(`${site.siteName} API 探测识别为 localapi`);
    return 'localapi';
  }

  if (site?.cookieDomain && await detectPointsCheckinFromApi(site.cookieDomain)) {
    console.log(`${site.siteName} API 探测识别为 points-checkin`);
    return 'points-checkin';
  }

  // 2) HTML 特征
  const htmlDetectedType = await detectSiteTypeFromHtml(site);
  if (htmlDetectedType) {
    return htmlDetectedType;
  }

  // 3) URL hint（hash /checkin 等）
  if (urlHint === 'localapi') {
    return 'localapi';
  }
  if (urlHint === 'points-checkin') {
    return 'points-checkin';
  }

  let tab;
  try {
    tab = await openSiteSessionTab(tabSession, site.visitUrl, 15000);
    await sleep(1500);

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        const appConfig = window.__APP_CONFIG__ || {};

        // points-checkin：/api/auth/linuxdo/config + /api/points/checkin（401 JSON 也算命中）
        try {
          const [linuxdoConfigResponse, pointsCheckinResponse] = await Promise.all([
            fetch('/api/auth/linuxdo/config', { credentials: 'include' }),
            fetch('/api/points/checkin', { credentials: 'include' })
          ]);
          let linuxdoConfig = null;
          let pointsCheckin = null;
          try {
            linuxdoConfig = await linuxdoConfigResponse.json();
          } catch (e) {}
          try {
            pointsCheckin = await pointsCheckinResponse.json();
          } catch (e) {}
          const hasLinuxdoConfig =
            linuxdoConfigResponse.ok &&
            linuxdoConfig &&
            typeof linuxdoConfig === 'object' &&
            Object.prototype.hasOwnProperty.call(linuxdoConfig, 'enabled');
          const hasPointsCheckinApi =
            pointsCheckin &&
            typeof pointsCheckin === 'object' &&
            (
              Object.prototype.hasOwnProperty.call(pointsCheckin, 'daily_checkin') ||
              pointsCheckin.code === 'unauthorized' ||
              /未登录|登录已过期/.test(String(pointsCheckin.error || ''))
            );
          if (hasLinuxdoConfig && hasPointsCheckinApi) {
            return 'points-checkin';
          }
          // 仅 points/checkin 命中也足够（有的部署可能关掉 linuxdo config 展示）
          if (hasPointsCheckinApi) {
            return 'points-checkin';
          }
        } catch (e) {}

        try {
          const [configResponse, checkinResponse] = await Promise.all([
            fetch('/user/api/config', { credentials: 'include' }),
            fetch('/user/api/checkin', { credentials: 'include' })
          ]);
          const config = await configResponse.json().catch(() => null);
          const checkin = await checkinResponse.json().catch(() => null);
          const configLooksLikeLocalApi =
            configResponse.ok &&
            config &&
            typeof config === 'object' &&
            Object.prototype.hasOwnProperty.call(config, 'checkin_enabled') &&
            (
              Object.prototype.hasOwnProperty.call(config, 'linuxdo_enabled') ||
              Object.prototype.hasOwnProperty.call(config, 'password_login_enabled')
            );
          const checkinLooksLikeLocalApi =
            checkin &&
            typeof checkin === 'object' &&
            (
              Object.prototype.hasOwnProperty.call(checkin, 'settings') ||
              Object.prototype.hasOwnProperty.call(checkin, 'checked_in_today') ||
              /invalid or expired user session/i.test(String(checkin.error || ''))
            );
          if (configLooksLikeLocalApi && checkinLooksLikeLocalApi) return 'localapi';
        } catch (e) {}

        try {
          const [loginPageResponse, loginOptionsResponse] = await Promise.all([
            fetch('/api/v1/settings/login-page', { credentials: 'include' }),
            fetch('/api/v1/auth/login-options', { credentials: 'include' })
          ]);
          const loginPage = await loginPageResponse.json();
          const loginOptions = await loginOptionsResponse.json();
          const pageData = loginPage?.data || {};
          const optionData = loginOptions?.data || {};
          if (
            loginPageResponse.ok &&
            loginOptionsResponse.ok &&
            typeof pageData.defaultNextPath === 'string' &&
            Array.isArray(optionData.providers) &&
            optionData.providers.some(provider => provider?.type === 'oauth2' && provider?.slug)
          ) {
            return 'deeix-chat';
          }
        } catch (e) {}

        try {
          const response = await fetch('/api/settings', { credentials: 'include' });
          const data = await response.json();
          const settings = data?.data || data;
          if (
            data?.code === 0 &&
            settings?.auth &&
            settings?.checkIn &&
            Object.prototype.hasOwnProperty.call(settings.auth, 'linuxDo')
          ) {
            return 'infinite-canvas';
          }
        } catch (e) {}

        if (
          Object.prototype.hasOwnProperty.call(appConfig, 'api_base_url') ||
          Object.prototype.hasOwnProperty.call(appConfig, 'linuxdo_oauth_enabled')
        ) {
          return 'sub2api';
        }

        try {
          const response = await fetch('/api/public/site-info', { credentials: 'include' });
          const data = await response.json();
          if (
            Object.prototype.hasOwnProperty.call(data, 'site_mode') ||
            Object.prototype.hasOwnProperty.call(data, 'registration_mode') ||
            Object.prototype.hasOwnProperty.call(data, 'linuxdo_enabled') ||
            location.pathname.startsWith('/user')
          ) {
            return 'zenapi';
          }
        } catch (e) {
          if (location.pathname.startsWith('/user')) return 'zenapi';
        }

        try {
          const response = await fetch('/api/status', { credentials: 'include' });
          const contentType = response.headers.get('content-type') || '';
          // SPA 站点常把未知路径回落成 HTML，不能当 NewAPI
          if (!String(contentType).includes('application/json')) {
            // fallthrough
          } else {
            const data = await response.json();
            if (data?.data?.linuxdo_client_id || data?.linuxdo_client_id) {
              return 'newapi';
            }
          }
        } catch (e) {}

        if (location.pathname === '/check-in') {
          return 'sub2api';
        }
        if (location.pathname === '/checkin' && /LocalAPI/i.test(document.title || '')) {
          return 'localapi';
        }

        const hashRoute = String(location.hash || '').replace(/^#/, '');
        const hashPath = hashRoute.split('?')[0] || '';
        if (hashPath === '/checkin' || /智画创|WisArt/i.test(document.title || '')) {
          return 'points-checkin';
        }

        return 'unknown';
      }
    });

    if (results[0]?.result === 'points-checkin') return 'points-checkin';
    if (results[0]?.result === 'deeix-chat') return 'deeix-chat';
    if (results[0]?.result === 'infinite-canvas') return 'infinite-canvas';
    if (results[0]?.result === 'sub2api') return 'sub2api';
    if (results[0]?.result === 'zenapi') return 'zenapi';
    if (results[0]?.result === 'localapi') return 'localapi';
    return urlHint || 'newapi';
  } catch (e) {
    if (isInvalidSiteError(e)) throw e;
    console.warn(`${site.siteName} 自动识别站点类型失败，回退 New API:`, e);
    return urlHint || 'newapi';
  } finally {
    if (!tabSession) await closeTabQuietly(tab?.id);
  }
}

function detectSiteTypeFromUrl(url) {
  try {
    const parsed = new URL(url || '');
    if (isFengwindWelfareDomain(parsed.hostname)) return 'fengwind-welfare';
    if (isSotaAgentDomain(parsed.hostname)) return 'sota-agent';
    if (isPipiStudioDomain(parsed.hostname)) return 'pipi-studio';
    if (parsed.pathname.startsWith('/chat')) return 'deeix-chat';
    const redirect = parsed.searchParams.get('redirect') || '';
    if (
      parsed.pathname === '/check-in' ||
      redirect === '/check-in' ||
      redirect.startsWith('/check-in?')
    ) {
      return 'sub2api';
    }
    if (parsed.pathname.startsWith('/user')) return 'zenapi';
    if (parsed.pathname === '/checkin') return 'localapi';

    // points-checkin 常见 hash 路由：#/checkin 或 #/login?redirect=/checkin
    const hashRoute = String(parsed.hash || '').replace(/^#/, '');
    const hashPath = hashRoute.split('?')[0] || '';
    const hashQuery = hashRoute.includes('?') ? hashRoute.slice(hashRoute.indexOf('?') + 1) : '';
    const hashRedirect = new URLSearchParams(hashQuery).get('redirect') || '';
    if (
      hashPath === '/checkin' ||
      hashRedirect === '/checkin' ||
      hashRedirect.startsWith('/checkin?')
    ) {
      return 'points-checkin';
    }
  } catch (e) {}
  return null;
}

async function updateRawSiteType(domain, type, { useApi } = {}) {
  const sites = await loadRawSites();
  const nextSites = sites.map(site => {
    if (site.domain !== domain) return site;
    const next = { ...site, type };
    if (typeof useApi === 'boolean') {
      next.useApi = useApi;
    }
    if (type === 'deeix-chat' && !next.pageUrl) {
      next.pageUrl = `https://${domain}${DEEIX_CHAT_DEFAULT_PATH}`;
    }
    if (type === 'infinite-canvas' && !next.pageUrl) {
      next.pageUrl = `https://${domain}/check-in`;
    }
    if (type === 'sub2api' && !next.pageUrl) {
      next.pageUrl = `https://${domain}/check-in`;
    }
    if (type === 'zenapi' && !next.pageUrl) {
      next.pageUrl = `https://${domain}/user`;
    }
    if (type === 'points-checkin') {
      // 从 newapi 误判升级时，常残留 /console/personal 或登录页，强制纠正到 #/checkin
      const current = String(next.pageUrl || '');
      const needsDefault =
        !current ||
        current.endsWith('/console/personal') ||
        isTargetDomainLoginPage(current, domain) ||
        !/#\/checkin(?:\?|$)/.test(current);
      if (needsDefault) {
        next.pageUrl = getPointsCheckinDefaultPageUrl(domain);
      }
    }
    if (type === 'localapi') {
      let needsDefault = !next.pageUrl;
      try {
        const parsed = new URL(next.pageUrl || '');
        needsDefault = needsDefault ||
          parsed.hostname === domain &&
          (
            parsed.pathname === '/' ||
            parsed.pathname === '/console/personal' ||
            /^\/(?:login|sign-?in)(?:\/|$)/i.test(parsed.pathname)
          );
      } catch (e) {}
      if (needsDefault) next.pageUrl = getLocalApiDefaultPageUrl(domain);
    }
    if (type === 'sota-agent' && isSotaAgentDomain(domain)) {
      next.pageUrl = `https://${domain}${SOTA_AGENT_PAGE_PATH}`;
    }
    if (type === 'fengwind-welfare' && isFengwindWelfareDomain(domain)) {
      next.pageUrl = `https://${domain}${FENGWIND_WELFARE_PAGE_PATH}`;
    }
    if (type === 'pipi-studio' && isPipiStudioDomain(domain)) {
      next.pageUrl = `https://${domain}${PIPI_STUDIO_PAGE_PATH}`;
    }
    return next;
  });
  await saveSitesConfig(nextSites);
}

async function updateRawSiteName(domain, name) {
  const sites = await loadRawSites();
  const nextSites = sites.map(site => {
    if (site.domain !== domain) return site;
    if (!shouldAutoFetchSiteName(site)) return site;
    return { ...site, name };
  });
  await saveSitesConfig(nextSites);
}

// 单个站点签到
async function checkInSite(site, tabSession = null) {
  const specializedHandler = SITE_TYPE_CHECK_IN_HANDLERS[site.type];
  if (specializedHandler) {
    return specializedHandler(site, tabSession);
  }

  // 站点已关闭接口调用（避免封号风险）：直接走页面点击兜底，不获取认证头
  if (!site.useApi) {
    console.log(`${site.siteName} 已禁用接口调用，直接使用页面点击签到`);
    await appendCheckInLog(site.siteName, '待检查', '已禁用接口调用，进入页面登录/签到流程');
    const fallback = await tryOfficialPageFallback(site, {
      success: false,
      message: '已禁用接口调用，使用页面点击签到',
      httpStatus: 0,
      skipApiByConfig: true
    }, null, tabSession);
    const result = await buildResultWithLatestBalance(site, fallback.execResult, null, fallback.tabToCleanup);
    await closeTabUnlessInSession(fallback.tabToCleanup, tabSession);
    return result;
  }

  // 1. 统一认证顺序：缓存 -> 浏览器已有登录态 -> linux.do OAuth
  await appendCheckInLog(site.siteName, '待检查', '当前为 API 模式，准备获取认证信息');
  const authResult = await getNewApiAuthHeaders(site, {}, tabSession);
  let authHeaders = authResult?.headers;
  let tabToCleanup = authResult?.tabToCleanup || null;

  if (!authHeaders) {
    const fallback = await tryOfficialPageFallback(site, {
      success: false,
      message: '无法获取接口认证信息，尝试打开官方页面签到',
      httpStatus: 401
    }, tabToCleanup, tabSession);
    const result = await buildResultWithLatestBalance(site, fallback.execResult, null, fallback.tabToCleanup);
    await closeTabUnlessInSession(fallback.tabToCleanup, tabSession);
    return result;
  }

  // 2. 执行签到
  let execResult = await doCheckInRequest(site.signExecUrl, site.signExecMethod, site.signExecParams, authHeaders);
  let officialPageFallbackTried = false;
  console.log(`${site.siteName} 签到响应:`, execResult);

  if (execResult.requiresPageExecution) {
    ({ execResult, tabToCleanup } = await tryOfficialPageFallback(site, execResult, tabToCleanup, tabSession));
    officialPageFallbackTried = true;
  }

  // 2.5 网络层失败（Failed to fetch，httpStatus:0）：SW 直连被连接层拦截，
  // 改为在站点标签页内执行 fetch 重试一次（带页面上下文，可绕过多数拦截）。
  if (isNetworkLevelFetchFailure(execResult) && !authHeaders._needsTabExecution) {
    console.log(`${site.siteName} 直连 fetch 失败（${execResult.error || execResult.message}），改为站点页面内重试...`);
    await appendCheckInLog(site.siteName, '待检查', 'service worker 直连失败，改为站点页面内重试签到请求');
    ({ headers: authHeaders, tabToCleanup } = await ensureTabExecutionHeaders(site, authHeaders, tabToCleanup, tabSession));
    execResult = await doCheckInRequest(site.signExecUrl, site.signExecMethod, site.signExecParams, authHeaders);
    console.log(`${site.siteName} 页面内重试签到响应:`, execResult);
    if (execResult.success || execResult.alreadyCheckedIn) {
      await cacheHeaders(site.siteId, authHeaders);
    }
  }

  // 3. 检测 Cloudflare 错误（cf_clearance 过期或被拦截）
  const normalizedFetchError = String(execResult.error || '').toLowerCase();
  const isCloudflareError =
    execResult.httpStatus === 403 &&
    (
      normalizedFetchError.includes('just a moment') ||
      normalizedFetchError.includes('cloudflare') ||
      normalizedFetchError.includes('<!doctype html') ||
      normalizedFetchError.includes('<html')
    );

  if (isCloudflareError) {
    console.log(`${site.siteName} 检测到 Cloudflare 防护，清除缓存并重新登录...`);
    await clearCachedHeaders(site.siteId);

    const refreshedAuth = await getNewApiAuthHeaders(site, { forceRefresh: true, needsTabExecution: true }, tabSession);
    if (refreshedAuth?.headers) {
      // 标记该站点需要在标签页中执行（绕过 Cloudflare）
      refreshedAuth.headers._needsTabExecution = true;
      await cacheHeaders(site.siteId, refreshedAuth.headers);
      const retryResult = await doCheckInRequest(site.signExecUrl, site.signExecMethod, site.signExecParams, refreshedAuth.headers);
      console.log(`${site.siteName} 刷新认证后重试签到响应:`, retryResult);

      const fallback = await tryOfficialPageFallback(site, retryResult, refreshedAuth.tabToCleanup, tabSession);
      const result = await buildResultWithLatestBalance(site, fallback.execResult, refreshedAuth.headers, fallback.tabToCleanup);
      await closeTabUnlessInSession(fallback.tabToCleanup, tabSession);
      if (tabToCleanup && tabToCleanup !== fallback.tabToCleanup) await closeTabUnlessInSession(tabToCleanup, tabSession);
      return result;
    }
    await closeTabUnlessInSession(tabToCleanup, tabSession);
    throw new Error('Cloudflare 验证失败，重新登录失败');
  }

  // 4. 如果 401，重新按“浏览器已有登录态 -> OAuth”顺序获取认证
  if (execResult.httpStatus === 401) {
    console.log(`${site.siteName} 认证过期，尝试刷新浏览器登录态...`);
    await clearCachedHeaders(site.siteId);

    const refreshedAuth = await getNewApiAuthHeaders(site, { forceRefresh: true }, tabSession);
    if (refreshedAuth?.headers) {
      await cacheHeaders(site.siteId, refreshedAuth.headers);
      const retryResult = await doCheckInRequest(site.signExecUrl, site.signExecMethod, site.signExecParams, refreshedAuth.headers);
      console.log(`${site.siteName} 刷新认证后重试签到响应:`, retryResult);

      const fallback = await tryOfficialPageFallback(site, retryResult, refreshedAuth.tabToCleanup, tabSession);
      const result = await buildResultWithLatestBalance(site, fallback.execResult, refreshedAuth.headers, fallback.tabToCleanup);
      await closeTabUnlessInSession(fallback.tabToCleanup, tabSession);
      if (tabToCleanup && tabToCleanup !== fallback.tabToCleanup) await closeTabUnlessInSession(tabToCleanup, tabSession);
      return result;
    }
    const fallback = await tryOfficialPageFallback(site, {
      success: false,
      message: '接口认证已过期，刷新浏览器登录态失败，尝试打开官方页面签到',
      httpStatus: 401
    }, tabToCleanup, tabSession);
    const result = await buildResultWithLatestBalance(site, fallback.execResult, authHeaders, fallback.tabToCleanup);
    await closeTabUnlessInSession(fallback.tabToCleanup, tabSession);
    return result;
  }

  if (!officialPageFallbackTried) {
    ({ execResult, tabToCleanup } = await tryOfficialPageFallback(site, execResult, tabToCleanup, tabSession));
  }

  // 4. 查询验证
  let queryVerified = false;
  const isSuccess = execResult.success || execResult.alreadyCheckedIn;
  if (site.signQueryUrl && isSuccess) {
    await sleep(1000);
    try {
      const currentMonth = new Date().toISOString().slice(0, 7);
      const queryUrl = `${site.signQueryUrl}?month=${currentMonth}`;
      const queryResult = await doFetchWithHeaders(queryUrl, 'GET', null, authHeaders);
      queryVerified = queryResult.data?.data?.stats?.checked_in_today || false;
    } catch (e) {
      console.warn(`${site.siteName} 查询失败:`, e);
    }
  }

  const result = await buildResultWithLatestBalance(site, execResult, authHeaders, tabToCleanup);
  await closeTabUnlessInSession(tabToCleanup, tabSession);
  result.queryVerified = queryVerified;
  return result;
}

async function executeSotaAgentTabRequest(tabId, method) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: requestSotaAgentInPage,
      args: [method, SOTA_AGENT_CHECK_IN_PATH, SOTA_AGENT_USER_HEADER, SITE_FETCH_TIMEOUT_MS]
    });
    return results[0]?.result || {
      error: 'Sota Agent 页面请求无响应',
      httpStatus: 0,
      data: null
    };
  } catch (e) {
    return {
      error: e?.message || 'Sota Agent 页面请求失败',
      httpStatus: 0,
      data: null
    };
  }
}

function logSotaAgentRequestState(site, stage, result) {
  console.log(`${site.siteName} Sota Agent ${stage}:`, {
    httpStatus: result?.httpStatus || 0,
    hasUid: result?.hasUid === true,
    missingUid: result?.missingUid === true,
    invalidSite: result?.invalidSite === true,
    hasError: Boolean(result?.error)
  });
}

function buildSotaAgentRunResult(execResult, queryVerified = false) {
  const result = formatResult(execResult);
  if (execResult?.balance) result.balance = execResult.balance;
  result.queryVerified = queryVerified;
  return result;
}

async function finishSotaAgentWithPageFallback(site, execResult, tabId, tabSession) {
  const fallback = await tryOfficialPageFallback(site, execResult, tabId, tabSession);
  const result = buildSotaAgentRunResult(fallback.execResult, false);
  await closeTabUnlessInSession(fallback.tabToCleanup, tabSession);
  return result;
}

async function finishSotaAgentApiResult(execResult, tabId, tabSession, queryVerified) {
  const result = buildSotaAgentRunResult(execResult, queryVerified);
  await closeTabUnlessInSession(tabId, tabSession);
  return result;
}

async function checkInSotaAgentSite(site, tabSession = null) {
  if (!isSotaAgentDomain(site.cookieDomain)) {
    return { status: 'failed', message: 'Sota Agent 仅支持 www.sotamodel.net' };
  }

  if (!site.useApi) {
    return finishSotaAgentWithPageFallback(site, {
      success: false,
      message: '已禁用接口调用，使用页面点击签到',
      httpStatus: 0,
      skipApiByConfig: true
    }, null, tabSession);
  }

  await appendCheckInLog(site.siteName, '待检查', '使用 Sota Agent 页面登录态查询今日签到状态');
  const tab = await openSiteSessionTab(tabSession, site.visitUrl, 20000);
  const flowResult = await runSotaAgentCheckInFlow(
    method => executeSotaAgentTabRequest(tab.id, method),
    (stage, result) => logSotaAgentRequestState(site, stage, result)
  );
  if (flowResult.shouldFallback) {
    return finishSotaAgentWithPageFallback(site, flowResult.execResult, tab.id, tabSession);
  }
  return finishSotaAgentApiResult(
    flowResult.execResult,
    tab.id,
    tabSession,
    flowResult.queryVerified
  );
}

async function executePipiStudioTabRequest(tabId, method, endpoint) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: requestPipiStudioInPage,
      args: [method, endpoint, PIPI_STUDIO_TOKEN_KEY, SITE_FETCH_TIMEOUT_MS]
    });
    return results[0]?.result || {
      error: '皮皮智绘页面请求无响应',
      httpStatus: 0,
      data: null
    };
  } catch (e) {
    return {
      error: e?.message || '皮皮智绘页面请求失败',
      httpStatus: 0,
      data: null
    };
  }
}

function logPipiStudioRequestState(site, stage, result) {
  console.log(`${site.siteName} 皮皮智绘 ${stage}:`, {
    httpStatus: result?.httpStatus || 0,
    hasToken: result?.hasToken === true,
    missingToken: result?.missingToken === true,
    invalidSite: result?.invalidSite === true,
    hasError: Boolean(result?.error)
  });
}

function buildPipiStudioRunResult(execResult, queryVerified = false) {
  const result = formatResult(execResult);
  const pointsText = formatPipiStudioPoints(execResult?.points);
  if (pointsText) result.balance = `${pointsText} 积分`;
  result.queryVerified = queryVerified;
  return result;
}

async function finishPipiStudioWithPageFallback(site, execResult, tabId, tabSession) {
  const fallback = await tryOfficialPageFallback(site, execResult, tabId, tabSession);
  const result = buildPipiStudioRunResult(fallback.execResult, false);
  await closeTabUnlessInSession(fallback.tabToCleanup, tabSession);
  return result;
}

async function finishPipiStudioApiResult(execResult, tabId, tabSession, queryVerified) {
  const result = buildPipiStudioRunResult(execResult, queryVerified);
  await closeTabUnlessInSession(tabId, tabSession);
  return result;
}

async function checkInPipiStudioSite(site, tabSession = null) {
  if (!isPipiStudioDomain(site.cookieDomain)) {
    return { status: 'failed', message: '皮皮智绘仅支持 img.pipiwangcom.com' };
  }

  if (!site.useApi) {
    return finishPipiStudioWithPageFallback(site, {
      success: false,
      message: '已禁用接口调用，使用页面点击签到',
      httpStatus: 0,
      skipApiByConfig: true
    }, null, tabSession);
  }

  await appendCheckInLog(site.siteName, '待检查', '使用皮皮智绘页面登录态查询今日签到状态');
  const tab = await openSiteSessionTab(tabSession, site.visitUrl, 20000);
  const flowResult = await runPipiStudioCheckInFlow(
    (method, endpoint) => executePipiStudioTabRequest(tab.id, method, endpoint),
    (stage, result) => logPipiStudioRequestState(site, stage, result)
  );
  if (flowResult.shouldFallback) {
    return finishPipiStudioWithPageFallback(site, flowResult.execResult, tab.id, tabSession);
  }
  return finishPipiStudioApiResult(
    flowResult.execResult,
    tab.id,
    tabSession,
    flowResult.queryVerified
  );
}

async function executeFengwindWelfareTabRequest(tabId, method, endpoint) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: requestFengwindWelfareInPage,
      args: [method, endpoint, FENGWIND_WELFARE_TOKEN_KEY, SITE_FETCH_TIMEOUT_MS]
    });
    return results[0]?.result || {
      error: 'Fengwind 福利站页面请求无响应',
      httpStatus: 0,
      data: null
    };
  } catch (e) {
    return {
      error: e?.message || 'Fengwind 福利站页面请求失败',
      httpStatus: 0,
      data: null
    };
  }
}

function logFengwindWelfareRequestState(site, stage, result) {
  console.log(`${site.siteName} Fengwind 福利站 ${stage}:`, {
    httpStatus: result?.httpStatus || 0,
    hasToken: result?.hasToken === true,
    missingToken: result?.missingToken === true,
    invalidSite: result?.invalidSite === true,
    hasError: Boolean(result?.error)
  });
}

function buildFengwindWelfareRunResult(execResult, queryVerified = false) {
  const result = formatResult(execResult);
  result.queryVerified = queryVerified;
  return result;
}

async function probeFengwindWelfareStatus(site, tabId) {
  const rawResult = await executeFengwindWelfareTabRequest(
    tabId,
    'GET',
    FENGWIND_WELFARE_STATUS_PATH
  );
  logFengwindWelfareRequestState(site, 'GET 状态查询', rawResult);
  return parseFengwindWelfareResponse(rawResult, 'GET');
}

async function beginFengwindWelfareLogin(tabId) {
  const beforeTab = await chrome.tabs.get(tabId);
  const beforeUrl = beforeTab.url || beforeTab.pendingUrl || '';
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: startFengwindWelfareLoginInPage,
      args: [
        FENGWIND_WELFARE_LOGIN_PATH,
        FENGWIND_WELFARE_STATE_KEY,
        FENGWIND_WELFARE_MAIN_DOMAIN,
        SITE_FETCH_TIMEOUT_MS
      ]
    });
    const result = results[0]?.result || { success: false, message: '福利站登录跳转未启动' };
    if (!result.success) return result;
    await waitForTabUrlChange(tabId, beforeUrl, 5000);
    return result;
  } catch (e) {
    const currentTab = await chrome.tabs.get(tabId).catch(() => null);
    const currentUrl = currentTab?.url || currentTab?.pendingUrl || '';
    if (currentUrl && currentUrl !== beforeUrl) {
      return { success: true, started: true, loginUrl: '' };
    }
    return { success: false, message: e?.message || '福利站登录跳转未启动' };
  }
}

async function completeFengwindWelfareCallback(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: completeFengwindWelfareCallbackInPage,
      args: [
        FENGWIND_WELFARE_EXCHANGE_PATH,
        FENGWIND_WELFARE_TOKEN_KEY,
        FENGWIND_WELFARE_STATE_KEY,
        SITE_FETCH_TIMEOUT_MS
      ]
    });
    return results[0]?.result || { success: false, message: '福利站登录回调无响应' };
  } catch (e) {
    return { success: false, message: e?.message || '福利站登录回调处理失败' };
  }
}

async function clickFengwindMainLinuxDoLogin(tabId) {
  const linuxDoCookies = await chrome.cookies.getAll({ domain: 'linux.do' });
  if (!linuxDoCookies.length) {
    return { success: false, fatal: true, message: '浏览器尚未登录 linux.do' };
  }

  const knownTabIds = await getOpenTabIds();
  const clickResult = await clickSiteLinuxDoLoginButton(tabId, 'Fengwind 主站登录');
  if (!clickResult?.clicked) {
    return { success: false, message: '未找到 Fengwind 主站 LinuxDo 登录入口' };
  }

  let capturedUrl = String(clickResult.popupUrl || clickResult.sameTabUrl || '').trim();
  if (!capturedUrl) {
    const newLoginTab = await waitForNewFengwindLoginTab(knownTabIds, 3000);
    if (newLoginTab?.id) {
      capturedUrl = String(newLoginTab.url || newLoginTab.pendingUrl || '').trim();
      await closeTabQuietly(newLoginTab.id);
    }
  }
  if (capturedUrl && !isTrustedFengwindLoginUrl(capturedUrl)) {
    return { success: false, fatal: true, message: 'Fengwind 登录跳转地址不受信任' };
  }
  if (capturedUrl && isTrustedFengwindLoginUrl(capturedUrl)) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const currentUrl = tab?.url || tab?.pendingUrl || '';
    if (currentUrl !== capturedUrl) {
      await chrome.tabs.update(tabId, { url: capturedUrl, active: false });
    }
  }
  return { success: true };
}

async function waitForNewFengwindLoginTab(knownTabIds, timeout = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    try {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find(candidate => {
        const url = candidate.url || candidate.pendingUrl || '';
        return candidate.id &&
          !knownTabIds.has(candidate.id) &&
          isTrustedFengwindLoginUrl(url);
      });
      if (tab?.id) return tab;
    } catch (e) {
      return null;
    }
    await sleep(250);
  }
  return null;
}

function isTrustedFengwindLoginUrl(url) {
  const stage = classifyFengwindWelfareLoginUrl(url);
  return [
    'welfare',
    'welfare-callback',
    'main',
    'main-login',
    'main-sso',
    'main-oauth-callback',
    'linuxdo',
    'linuxdo-login'
  ].includes(stage);
}

async function navigateFengwindWelfareHome(site, tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const currentUrl = tab?.url || tab?.pendingUrl || '';
  if (currentUrl !== site.visitUrl) {
    await chrome.tabs.update(tabId, { url: site.visitUrl, active: false });
    await ensureTabPageReady(tabId, site.visitUrl, 20000);
    await sleep(800);
  }
}

async function waitForFengwindWelfareLogin(site, tabId, loginUrl, timeout = 60000) {
  const startedAt = Date.now();
  let callbackSeenAt = 0;
  let callbackAttempted = false;
  let lastMainLoginAttemptAt = 0;
  let mainSsoSeenAt = 0;
  let mainPageSeenAt = 0;
  let mainCallbackSeenAt = 0;
  let lastLinuxDoAuthorizeAt = 0;
  let lastMessage = '';

  while (Date.now() - startedAt < timeout) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const currentUrl = tab?.url || tab?.pendingUrl || '';
    if (!currentUrl) {
      await sleep(500);
      continue;
    }

    const stage = classifyFengwindWelfareLoginUrl(currentUrl);
    if (stage !== 'main-sso') mainSsoSeenAt = 0;
    if (stage === 'welfare' || stage === 'welfare-callback') {
      const statusResult = await probeFengwindWelfareStatus(site, tabId);
      if (statusResult.authenticated) {
        await navigateFengwindWelfareHome(site, tabId);
        return { success: true };
      }

      if (stage === 'welfare-callback') {
        callbackSeenAt = callbackSeenAt || Date.now();
        if (!callbackAttempted && Date.now() - callbackSeenAt >= 3500) {
          callbackAttempted = true;
          const callbackResult = await completeFengwindWelfareCallback(tabId);
          lastMessage = callbackResult.message || lastMessage;
          if (callbackResult.stateMismatch) {
            return { success: false, message: callbackResult.message };
          }
          if (callbackResult.success) {
            await navigateFengwindWelfareHome(site, tabId);
          }
        }
      } else if (Date.now() - startedAt >= 5000) {
        lastMessage = statusResult.message || '福利站回跳后仍未建立登录态';
      }
    } else if (stage === 'main-sso') {
      mainSsoSeenAt = mainSsoSeenAt || Date.now();
      mainPageSeenAt = 0;
      mainCallbackSeenAt = 0;
      if (Date.now() - mainSsoSeenAt >= 10000) {
        lastMessage = 'Fengwind 主站 SSO 跳转超时';
      }
    } else if (stage === 'main-login') {
      mainPageSeenAt = 0;
      mainCallbackSeenAt = 0;
      if (Date.now() - lastMainLoginAttemptAt >= 4000) {
        lastMainLoginAttemptAt = Date.now();
        const loginResult = await clickFengwindMainLinuxDoLogin(tabId);
        lastMessage = loginResult.message || lastMessage;
        if (loginResult.fatal) return loginResult;
      }
    } else if (stage === 'linuxdo') {
      mainPageSeenAt = 0;
      mainCallbackSeenAt = 0;
      if (Date.now() - lastLinuxDoAuthorizeAt >= 3000) {
        lastLinuxDoAuthorizeAt = Date.now();
        await waitForUsableTabPage(tabId, 15000);
        await clickLinuxDoAuthorizeButton(tabId);
      }
    } else if (stage === 'linuxdo-login') {
      return { success: false, message: 'linux.do 登录态已失效，请先在浏览器登录后重试' };
    } else if (stage === 'main-oauth-callback') {
      mainPageSeenAt = 0;
      mainCallbackSeenAt = mainCallbackSeenAt || Date.now();
      if (loginUrl && Date.now() - mainCallbackSeenAt >= 8000) {
        await chrome.tabs.update(tabId, { url: loginUrl, active: false });
        await waitForTabComplete(tabId, 20000);
        mainCallbackSeenAt = 0;
      }
    } else if (stage === 'main') {
      mainCallbackSeenAt = 0;
      mainPageSeenAt = mainPageSeenAt || Date.now();
      if (loginUrl && Date.now() - mainPageSeenAt >= 1500) {
        await chrome.tabs.update(tabId, { url: loginUrl, active: false });
        await waitForTabComplete(tabId, 20000);
        mainPageSeenAt = 0;
      }
    } else {
      mainPageSeenAt = 0;
      mainCallbackSeenAt = 0;
    }

    await sleep(700);
  }

  return { success: false, message: lastMessage || 'Fengwind 福利站登录超时' };
}

async function ensureFengwindWelfareAuthenticated(site, tabId) {
  await appendCheckInLog(site.siteName, '未登录', '福利站未检测到有效登录态，开始向主站获取登录状态');
  const startResult = await beginFengwindWelfareLogin(tabId);
  if (!startResult.success) return startResult;

  const loginResult = await waitForFengwindWelfareLogin(site, tabId, startResult.loginUrl || '');
  if (loginResult.success) {
    await appendCheckInLog(site.siteName, '登录成功', '主站 SSO 完成，已返回 Fengwind 福利站');
  }
  return loginResult;
}

async function finishFengwindWelfarePageCheckIn(site, tabId, tabSession) {
  const fallback = await tryOfficialPageFallback(site, {
    success: false,
    message: '已禁用接口调用，使用页面点击签到',
    httpStatus: 0,
    skipApiByConfig: true
  }, tabId, tabSession);
  const activeTabId = fallback.tabToCleanup || tabId;
  const verifyResult = await probeFengwindWelfareStatus(site, activeTabId);
  let execResult = fallback.execResult;
  if (verifyResult.alreadyCheckedIn && !execResult.success) {
    execResult = {
      ...verifyResult,
      success: true,
      alreadyCheckedIn: false,
      message: '签到成功，状态查询已确认'
    };
  }
  await closeTabUnlessInSession(activeTabId, tabSession);
  return buildFengwindWelfareRunResult(execResult, verifyResult.alreadyCheckedIn === true);
}

async function checkInFengwindWelfareSite(site, tabSession = null) {
  if (!isFengwindWelfareDomain(site.cookieDomain)) {
    return { status: 'failed', message: 'Fengwind 福利站仅支持 api-welfalre.fengwind.com' };
  }

  const tab = await openSiteSessionTab(tabSession, site.visitUrl, 20000);
  try {
    await sleep(800);
    if (!site.useApi) {
      let statusResult = await probeFengwindWelfareStatus(site, tab.id);
      if (statusResult.unauthenticated) {
        const loginResult = await ensureFengwindWelfareAuthenticated(site, tab.id);
        if (!loginResult.success) {
          return { status: 'failed', message: loginResult.message || 'Fengwind 福利站登录失败' };
        }
        statusResult = await probeFengwindWelfareStatus(site, tab.id);
      }
      if (statusResult.alreadyCheckedIn || statusResult.invalidSite || statusResult.disabled) {
        return buildFengwindWelfareRunResult(statusResult, statusResult.alreadyCheckedIn === true);
      }
      return finishFengwindWelfarePageCheckIn(site, tab.id, tabSession);
    }

    await appendCheckInLog(site.siteName, '待检查', '使用福利站页面登录态执行专用 API 签到流程');
    let flowResult = await runFengwindWelfareCheckInFlow(
      (method, endpoint) => executeFengwindWelfareTabRequest(tab.id, method, endpoint),
      (stage, result) => logFengwindWelfareRequestState(site, stage, result)
    );
    if (flowResult.shouldLogin) {
      const loginResult = await ensureFengwindWelfareAuthenticated(site, tab.id);
      if (!loginResult.success) {
        return { status: 'failed', message: loginResult.message || 'Fengwind 福利站登录失败' };
      }
      flowResult = await runFengwindWelfareCheckInFlow(
        (method, endpoint) => executeFengwindWelfareTabRequest(tab.id, method, endpoint),
        (stage, result) => logFengwindWelfareRequestState(site, stage, result)
      );
    }
    if (flowResult.shouldLogin) {
      return { status: 'failed', message: 'Fengwind 福利站登录后仍未获得有效登录态' };
    }
    return buildFengwindWelfareRunResult(flowResult.execResult, flowResult.queryVerified);
  } finally {
    await closeTabUnlessInSession(tab.id, tabSession);
  }
}

async function checkInDeeixChatSite(site, tabSession = null) {
  if (!site.useApi) {
    console.log(`${site.siteName} 已禁用接口调用，直接使用页面点击签到`);
    const fallback = await tryOfficialPageFallback(site, {
      success: false,
      message: '已禁用接口调用，使用页面点击签到',
      httpStatus: 0,
      skipApiByConfig: true
    }, null, tabSession);
    const result = await buildResultWithLatestBalance(site, fallback.execResult, null, fallback.tabToCleanup);
    await closeTabUnlessInSession(fallback.tabToCleanup, tabSession);
    return result;
  }

  await appendCheckInLog(site.siteName, '待检查', '当前为 DEEIX Chat API 模式，准备获取认证信息');
  let authResult = await getDeeixChatAuthHeaders(site, {}, tabSession);
  let authHeaders = authResult?.headers || null;
  let tabToCleanup = authResult?.tabToCleanup || null;

  if (!hasAuthorizationHeader(authHeaders)) {
    await closeTabUnlessInSession(tabToCleanup, tabSession);
    return { status: 'failed', message: 'DEEIX Chat 登录失败，请确认浏览器已登录 linux.do 后重试' };
  }

  let shouldUseTabExecution = shouldUseDeeixChatTabExecution(site);
  if (shouldUseTabExecution) {
    await appendCheckInLog(site.siteName, '待检查', '匹配 DEEIX Chat /checkin 页面，改为站点页面内执行签到请求');
    ({ headers: authHeaders, tabToCleanup } = await ensureDeeixChatExecutionHeaders(
      site,
      authHeaders,
      tabToCleanup,
      tabSession
    ));
  }

  let execResult = await doDeeixChatCheckInRequest(site, authHeaders);
  console.log(`${site.siteName} DEEIX Chat 签到响应:`, execResult);

  if (isDeeixChatOriginRejectedResult(execResult) && !authHeaders._needsTabExecution) {
    shouldUseTabExecution = true;
    await appendCheckInLog(site.siteName, '待检查', 'DEEIX Chat 返回 origin is not allowed，改为站点页面内重试');
    ({ headers: authHeaders, tabToCleanup } = await ensureDeeixChatExecutionHeaders(
      site,
      authHeaders,
      tabToCleanup,
      tabSession
    ));
    execResult = await doDeeixChatCheckInRequest(site, authHeaders);
    console.log(`${site.siteName} DEEIX Chat 页内重试签到响应:`, execResult);
  }

  if (isDeeixChatUnauthResult(execResult)) {
    await clearCachedHeaders(site.siteId);
    authResult = await getDeeixChatAuthHeaders(site, { forceRefresh: true }, tabSession);
    const refreshedHeaders = authResult?.headers || null;

    if (hasAuthorizationHeader(refreshedHeaders)) {
      if (tabToCleanup && tabToCleanup !== authResult.tabToCleanup) {
        await closeTabUnlessInSession(tabToCleanup, tabSession);
      }
      authHeaders = refreshedHeaders;
      tabToCleanup = authResult.tabToCleanup || tabToCleanup;
      if (shouldUseTabExecution) {
        ({ headers: authHeaders, tabToCleanup } = await ensureDeeixChatExecutionHeaders(
          site,
          authHeaders,
          tabToCleanup,
          tabSession
        ));
      }
      execResult = await doDeeixChatCheckInRequest(site, authHeaders);
      console.log(`${site.siteName} DEEIX Chat 重新登录后签到响应:`, execResult);
      if (isDeeixChatOriginRejectedResult(execResult) && !authHeaders._needsTabExecution) {
        shouldUseTabExecution = true;
        await appendCheckInLog(site.siteName, '待检查', 'DEEIX Chat 重新登录后仍返回 origin is not allowed，改为站点页面内重试');
        ({ headers: authHeaders, tabToCleanup } = await ensureDeeixChatExecutionHeaders(
          site,
          authHeaders,
          tabToCleanup,
          tabSession
        ));
        execResult = await doDeeixChatCheckInRequest(site, authHeaders);
        console.log(`${site.siteName} DEEIX Chat 重新登录后页内重试签到响应:`, execResult);
      }
    }
  }

  const result = await buildResultWithLatestBalance(site, execResult, authHeaders, tabToCleanup);
  await closeTabUnlessInSession(tabToCleanup, tabSession);
  result.queryVerified = execResult.success || execResult.alreadyCheckedIn || false;
  return result;
}

async function getDeeixChatAuthHeaders(site, { forceRefresh = false } = {}, tabSession = null) {
  if (!forceRefresh) {
    const cachedHeaders = await getCachedHeaders(site.siteId);
    if (hasAuthorizationHeader(cachedHeaders)) {
      console.log(`${site.siteName} 使用 DEEIX Chat 缓存认证头`);
      await appendCheckInLog(site.siteName, '已登录', '复用 DEEIX Chat 缓存认证信息');
      return { headers: cachedHeaders, tabToCleanup: null, source: 'cache' };
    }
  }

  const postLoginUrl = getDeeixChatPostLoginUrl(site.cookieDomain, site.visitUrl);
  const tab = await openSiteSessionTab(tabSession, postLoginUrl, 20000);
  try {
    await appendCheckInLog(site.siteName, '待检查', '开始检查 DEEIX Chat 浏览器登录态');
    let headers = await readDeeixChatAuthHeadersFromTab(tab.id, null);
    if (hasAuthorizationHeader(headers)) {
      await cacheHeaders(site.siteId, headers);
      console.log(`${site.siteName} 已复用 DEEIX Chat 浏览器登录态`);
      await appendCheckInLog(site.siteName, '已登录', '复用 DEEIX Chat 浏览器登录态');
      return { headers, tabToCleanup: tab.id, source: 'browser-session' };
    }

    await appendCheckInLog(site.siteName, '登录中', '未检测到 DEEIX Chat 登录态，尝试 linux.do OAuth');
    const oauthResult = await autoDeeixChatOAuthLogin(site.cookieDomain, tab.id, site.visitUrl);
    headers = oauthResult?.headers || await readDeeixChatAuthHeadersFromTab(tab.id, null);
    if (hasAuthorizationHeader(headers)) {
      await cacheHeaders(site.siteId, headers);
      console.log(`${site.siteName} DEEIX Chat OAuth 登录成功`);
      await appendCheckInLog(site.siteName, '登录成功', 'DEEIX Chat OAuth 登录成功');
      return { headers, tabToCleanup: oauthResult?.tabId || tab.id, source: 'oauth' };
    }

    await appendCheckInLog(site.siteName, '登录失败', '无法获取 DEEIX Chat 认证信息');
    await closeTabUnlessInSession(tab.id, tabSession);
    return null;
  } catch (e) {
    console.warn(`${site.siteName} 获取 DEEIX Chat 认证失败:`, e);
    await appendCheckInLog(site.siteName, '登录失败', `获取 DEEIX Chat 认证失败：${e.message}`);
    await closeTabUnlessInSession(tab.id, tabSession);
    return null;
  }
}

function getDeeixChatPostLoginUrl(domain, visitUrl = '') {
  const nextPath = getDeeixChatNextPath(visitUrl);
  return `https://${domain}${nextPath}`;
}

function getDeeixChatLoginUrl(domain, visitUrl = '') {
  const nextPath = getDeeixChatNextPath(visitUrl);
  return `https://${domain}/login?next=${encodeURIComponent(nextPath)}`;
}

function getDeeixChatNextPath(visitUrl = '') {
  try {
    const parsed = new URL(visitUrl || '');
    const next = parsed.searchParams.get('next');
    if (isSafeDeeixChatPath(next)) return next;
    if (
      isSafeDeeixChatPath(parsed.pathname) &&
      !/^\/(?:login|sign-?in|auth)(?:\/|$)/i.test(parsed.pathname)
    ) {
      return `${parsed.pathname}${parsed.search || ''}${parsed.hash || ''}`;
    }
  } catch (e) {}
  return DEEIX_CHAT_DEFAULT_PATH;
}

function isSafeDeeixChatPath(path) {
  return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//');
}

function isDeeixChatCheckInPath(pathname = '') {
  return /^\/check-?in(?:\/|$)/i.test(String(pathname || ''));
}

function shouldUseDeeixChatTabExecution(site) {
  try {
    const parsed = new URL(site?.visitUrl || '');
    return parsed.hostname === site?.cookieDomain && isDeeixChatCheckInPath(parsed.pathname);
  } catch (e) {
    return false;
  }
}

function isDeeixChatOriginRejectedResult(result) {
  const message = String(
    result?.message ||
    result?.error ||
    result?.data?.errorMsg ||
    result?.data?.message ||
    ''
  );
  return !result?.success && /origin is not allowed/i.test(message);
}

async function ensureDeeixChatExecutionHeaders(site, authHeaders, tabToCleanup = null, tabSession = null) {
  const nextHeaders = {
    ...(authHeaders || {}),
    _needsTabExecution: true
  };
  const currentTabId = nextHeaders._tabId;

  if (currentTabId) {
    try {
      await chrome.tabs.get(currentTabId);
      return { headers: nextHeaders, tabToCleanup };
    } catch (e) {}
  }

  const tab = await openSiteSessionTab(tabSession, site?.visitUrl || getDeeixChatPostLoginUrl(site.cookieDomain, site.visitUrl), 20000);
  nextHeaders._tabId = tab.id;

  if (tabToCleanup && tabToCleanup !== tab.id) {
    await closeTabUnlessInSession(tabToCleanup, tabSession);
  }

  return { headers: nextHeaders, tabToCleanup: tab.id };
}

// service worker 直连被网络层拒绝（TypeError: Failed to fetch，httpStatus:0）：
// 请求根本没拿到响应，通常是 Cloudflare/WAF 在连接层拦掉了缺页面上下文的裸 fetch。
// 与业务错误（4xx/5xx）区分——业务错误有 httpStatus，网络失败为 0。
function isNetworkLevelFetchFailure(result) {
  if (!result || result.success || result.alreadyCheckedIn) return false;
  if (result.httpStatus !== 0) return false;
  const message = String(result.error || result.message || '').toLowerCase();
  return /failed to fetch|networkerror|load failed|fetch failed|err_/.test(message);
}

// 通用「转标签页内执行」：为默认 NewAPI 路径开一个站点后台 tab 并标记 _needsTabExecution，
// 使 doCheckInRequest 走 fetch-in-tab 路径，绕过 SW 直连被拒的场景。
async function ensureTabExecutionHeaders(site, authHeaders, tabToCleanup = null, tabSession = null) {
  const nextHeaders = {
    ...(authHeaders || {}),
    _needsTabExecution: true
  };
  const currentTabId = nextHeaders._tabId;

  if (currentTabId) {
    try {
      await chrome.tabs.get(currentTabId);
      return { headers: nextHeaders, tabToCleanup };
    } catch (e) {}
  }

  const tab = await openSiteSessionTab(tabSession, site.visitUrl, 20000);
  nextHeaders._tabId = tab.id;

  if (tabToCleanup && tabToCleanup !== tab.id) {
    await closeTabUnlessInSession(tabToCleanup, tabSession);
  }

  return { headers: nextHeaders, tabToCleanup: tab.id };
}

async function readDeeixChatAuthHeadersFromTab(tabId, baseHeaders = {}) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        try {
          const response = await fetch('/api/v1/auth/refresh', {
            method: 'POST',
            credentials: 'include'
          });
          const data = await response.json().catch(() => null);
          const session = data?.data || data || {};
          return {
            ok: response.ok,
            status: response.status,
            accessToken: session.accessToken || session.access_token || '',
            sessionID: session.sessionID || session.sessionId || '',
            errorCode: data?.errorCode || '',
            errorMsg: data?.errorMsg || data?.message || ''
          };
        } catch (e) {
          return { ok: false, status: 0, errorMsg: e.message };
        }
      }
    });

    const session = results[0]?.result || {};
    const headers = mergeAuthorizationHeader(baseHeaders || {}, session.accessToken);
    if (session.sessionID) headers._deeixSessionID = session.sessionID;
    headers._tabId = tabId;
    return headers;
  } catch (e) {
    console.warn('[DEEIX Chat] 读取页面登录令牌失败:', e);
    return baseHeaders || {};
  }
}

async function autoDeeixChatOAuthLogin(domain, tabId = null, visitUrl = null) {
  console.log(`[DEEIX Chat OAuth] 开始登录: ${domain}`);

  const ldCookies = await chrome.cookies.getAll({ domain: 'linux.do' });
  if (ldCookies.length === 0) {
    console.warn('[DEEIX Chat OAuth] linux.do 未登录');
    return null;
  }

  let tab;
  const ownsTab = !tabId;
  const loginUrl = getDeeixChatLoginUrl(domain, visitUrl);
  const nextPath = getDeeixChatNextPath(visitUrl);
  try {
    tab = tabId ? await chrome.tabs.get(tabId) : await createTemporaryBackgroundTab(loginUrl, 20000);
    if (!tab.url || !tab.url.includes(domain)) {
      await chrome.tabs.update(tab.id, { url: loginUrl, active: false });
      await ensureTabPageReady(tab.id, loginUrl, 20000);
    }

    const startResult = await startDeeixChatOAuthFromTab(tab.id, nextPath);
    console.log('[DEEIX Chat OAuth] 启动结果:', startResult);
    await waitForTabComplete(tab.id, 20000);
    await waitForUsableTabPage(tab.id, 20000);
    await sleep(1000);

    let tabInfo = await chrome.tabs.get(tab.id);
    if (tabInfo.url && tabInfo.url.includes('connect.linux.do')) {
      await clickLinuxDoAuthorizeButton(tab.id);
      const redirected = await waitForTabUrlMatch(tab.id, domain, 30000);
      if (!redirected) {
        console.warn('[DEEIX Chat OAuth] 等待回跳目标站点超时');
        if (ownsTab) await closeTabQuietly(tab.id);
        return null;
      }
      await waitForTabComplete(tab.id, 20000);
      await waitForUsableTabPage(tab.id, 20000);
      await sleep(1000);
      tabInfo = await chrome.tabs.get(tab.id);
    }

    const headers = await waitForDeeixChatLoginHeaders(tab.id, domain, 30000);
    if (hasAuthorizationHeader(headers)) {
      console.log('[DEEIX Chat OAuth] 已读取登录令牌');
      return { headers, tabId: tab.id };
    }

    console.warn(`[DEEIX Chat OAuth] 未能读取登录令牌，当前页面: ${tabInfo.url || 'unknown'}`);
    if (ownsTab) await closeTabQuietly(tab.id);
    return null;
  } catch (e) {
    console.warn('[DEEIX Chat OAuth] 登录失败:', e);
    if (ownsTab) await closeTabQuietly(tab?.id);
    return null;
  }
}

async function startDeeixChatOAuthFromTab(tabId, nextPath = DEEIX_CHAT_DEFAULT_PATH) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (providerSlug, defaultNextPath) => {
      function base64Url(bytes) {
        let binary = '';
        bytes.forEach(byte => { binary += String.fromCharCode(byte); });
        return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
      }

      const safeNextPath = typeof defaultNextPath === 'string' &&
        defaultNextPath.startsWith('/') &&
        !defaultNextPath.startsWith('//')
        ? defaultNextPath
        : '/chat';
      const randomBytes = new Uint8Array(48);
      window.crypto.getRandomValues(randomBytes);
      const verifier = base64Url(randomBytes);
      const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
      const challenge = base64Url(new Uint8Array(digest));
      window.sessionStorage.setItem(`deeix-chat:oauth:${providerSlug}:pkce_verifier`, verifier);

      const redirectUri = `${window.location.origin}/auth/callback?provider=${encodeURIComponent(providerSlug)}`;
      const params = new URLSearchParams({
        redirect_uri: redirectUri,
        next: safeNextPath,
        code_challenge: challenge,
        intent: 'login'
      });
      const startPath = `/api/v1/auth/providers/${encodeURIComponent(providerSlug)}/start?${params.toString()}`;
      window.location.href = startPath;
      return { startPath, redirectUri, next: safeNextPath };
    },
    args: [DEEIX_CHAT_LINUX_DO_PROVIDER_SLUG, nextPath]
  });
  return results[0]?.result || null;
}

async function waitForDeeixChatLoginHeaders(tabId, domain, timeout = 30000) {
  const startedAt = Date.now();
  let callbackAttempted = false;

  while (Date.now() - startedAt < timeout) {
    let tabInfo;
    try {
      tabInfo = await chrome.tabs.get(tabId);
    } catch (e) {
      return null;
    }

    const currentUrl = tabInfo.url || tabInfo.pendingUrl || '';
    if (currentUrl.includes('connect.linux.do')) {
      await clickLinuxDoAuthorizeButton(tabId);
      await waitForTabUrlMatch(tabId, domain, 30000);
      await waitForTabComplete(tabId, 20000);
      await waitForUsableTabPage(tabId, 20000);
      await sleep(1000);
      continue;
    }

    if (isDeeixChatOAuthCallbackUrl(currentUrl, domain) && !callbackAttempted) {
      callbackAttempted = true;
      const callbackHeaders = await processDeeixChatOAuthCallback(tabId);
      if (hasAuthorizationHeader(callbackHeaders)) return callbackHeaders;
    }

    const headers = await readDeeixChatAuthHeadersFromTab(tabId, null);
    if (hasAuthorizationHeader(headers)) return headers;
    await sleep(1000);
  }

  return null;
}

function isDeeixChatOAuthCallbackUrl(url, domain) {
  try {
    const parsed = new URL(url || '');
    return parsed.hostname === domain &&
      parsed.pathname === '/auth/callback' &&
      parsed.searchParams.has('provider') &&
      parsed.searchParams.has('code') &&
      parsed.searchParams.has('state');
  } catch (e) {
    return false;
  }
}

async function processDeeixChatOAuthCallback(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async (fallbackProvider, defaultNextPath) => {
        function decodeState(state) {
          try {
            const [payload] = String(state || '').split('.');
            if (!payload) return {};
            const padded = payload.replaceAll('-', '+').replaceAll('_', '/').padEnd(4 * Math.ceil(payload.length / 4), '=');
            return JSON.parse(atob(padded));
          } catch (e) {
            return {};
          }
        }

        const parsed = new URL(window.location.href);
        const provider = parsed.searchParams.get('provider') || fallbackProvider;
        const code = parsed.searchParams.get('code') || '';
        const state = parsed.searchParams.get('state') || '';
        if (!provider || !code || !state) {
          return { success: false, error: 'missing callback params' };
        }

        const verifierKey = `deeix-chat:oauth:${provider}:pkce_verifier`;
        const codeVerifier = window.sessionStorage.getItem(verifierKey) || '';
        if (!codeVerifier) {
          return { success: false, error: 'missing pkce verifier' };
        }

        const statePayload = decodeState(state);
        const next = typeof statePayload.next === 'string' &&
          statePayload.next.startsWith('/') &&
          !statePayload.next.startsWith('//')
          ? statePayload.next
          : defaultNextPath;
        const intent = ['login', 'register', 'bind'].includes(statePayload.intent)
          ? statePayload.intent
          : 'login';
        const redirectURI = `${window.location.origin}${window.location.pathname}?provider=${encodeURIComponent(provider)}`;
        const response = await fetch(`/api/v1/auth/providers/${encodeURIComponent(provider)}/callback`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, state, redirectURI, codeVerifier, intent })
        });
        const data = await response.json().catch(() => null);
        if (!response.ok) {
          return {
            success: false,
            status: response.status,
            errorCode: data?.errorCode || '',
            errorMsg: data?.errorMsg || data?.message || 'OAuth callback failed'
          };
        }

        window.sessionStorage.removeItem(verifierKey);
        if (next) window.history.replaceState(null, '', next);
        const session = data?.data || data || {};
        return {
          success: true,
          status: response.status,
          accessToken: session.accessToken || session.access_token || '',
          sessionID: session.sessionID || session.sessionId || '',
          data
        };
      },
      args: [DEEIX_CHAT_LINUX_DO_PROVIDER_SLUG, DEEIX_CHAT_DEFAULT_PATH]
    });

    const callback = results[0]?.result || {};
    const headers = mergeAuthorizationHeader({}, callback.accessToken);
    if (callback.sessionID) headers._deeixSessionID = callback.sessionID;
    headers._tabId = tabId;
    return headers;
  } catch (e) {
    console.warn('[DEEIX Chat OAuth] 手动处理回调失败:', e);
    return null;
  }
}

async function doDeeixChatCheckInRequest(site, authHeaders) {
  if (authHeaders?._needsTabExecution) {
    const result = await doCheckInRequest(site.signExecUrl, site.signExecMethod, site.signExecParams, authHeaders);
    if (result?.invalidSite && result.httpStatus === 404) {
      return {
        success: false,
        message: '自动登录成功，但未发现 DEEIX Chat 签到接口（/api/v1/billing/checkin），可能该站未开放签到功能',
        httpStatus: 404
      };
    }
    return result;
  }
  return doDeeixChatFetch(site.signExecUrl, site.signExecMethod, site.signExecParams, authHeaders);
}

async function doDeeixChatFetch(url, method, params, capturedHeaders = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const authKeys = ['authorization', 'cookie', 'session', 'token', 'x-token', 'x-auth'];

  for (const [name, value] of Object.entries(capturedHeaders || {})) {
    if (name.startsWith('_')) continue;
    const lower = name.toLowerCase();
    if (authKeys.some(k => lower.includes(k))) {
      headers[name] = value;
    }
  }

  const options = { method, headers, credentials: 'include' };
  if (method === 'POST' && params && Object.keys(params).length > 0) {
    options.body = JSON.stringify(params);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SITE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) {}

    if (response.status === 404) {
      return {
        success: false,
        message: '自动登录成功，但未发现 DEEIX Chat 签到接口（/api/v1/billing/checkin），可能该站未开放签到功能',
        httpStatus: response.status,
        data
      };
    }

    if (!data) {
      return {
        success: false,
        message: text ? `Response is not JSON: ${text.substring(0, 100)}` : '接口返回为空',
        httpStatus: response.status
      };
    }

    const parsed = parseCheckInResponse(data, response.status, response.ok && !data?.errorCode && !data?.errorMsg);
    if (!parsed.success && !parsed.alreadyCheckedIn) {
      parsed.message = data.errorMsg || data.message || parsed.message;
    }
    return parsed;
  } catch (e) {
    const aborted = e?.name === 'AbortError';
    return {
      error: aborted ? `请求超时（${SITE_FETCH_TIMEOUT_MS}ms）` : e.message,
      success: false,
      httpStatus: 0
    };
  } finally {
    clearTimeout(timer);
  }
}

function isDeeixChatUnauthResult(result) {
  const message = String(result?.message || result?.error || result?.data?.errorMsg || result?.data?.errorCode || '');
  return !result?.success &&
    (
      result?.httpStatus === 401 ||
      result?.httpStatus === 403 ||
      /auth\.invalid|unauthorized|forbidden|invalid token|authorization header/i.test(message)
    );
}

async function checkInInfiniteCanvasSite(site, tabSession = null) {
  // Infinite Canvas 使用自有 /api/auth/* 协议；默认走官方 API，页面模式保留为手动兜底开关。
  if (!site.useApi) {
    console.log(`${site.siteName} 已禁用接口调用，直接使用页面点击签到`);
    const fallback = await tryOfficialPageFallback(site, {
      success: false,
      message: '已禁用接口调用，使用页面点击签到',
      httpStatus: 0,
      skipApiByConfig: true
    }, null, tabSession);
    const result = await buildResultWithLatestBalance(site, fallback.execResult, null, fallback.tabToCleanup);
    await closeTabUnlessInSession(fallback.tabToCleanup, tabSession);
    return result;
  }

  let authHeaders = await getCachedHeaders(site.siteId);
  let tabToCleanup = null;

  if (!hasAuthorizationHeader(authHeaders)) {
    const tab = await openSiteSessionTab(tabSession, site.visitUrl);
    authHeaders = await readInfiniteCanvasAuthHeadersFromTab(tab.id, authHeaders);

    if (!hasAuthorizationHeader(authHeaders)) {
      const oauthResult = await autoInfiniteCanvasOAuthLogin(site.cookieDomain, tab.id, site.visitUrl);
      authHeaders = oauthResult?.headers || authHeaders;
    }

    if (!hasAuthorizationHeader(authHeaders)) {
      await closeTabUnlessInSession(tab.id, tabSession);
      throw new Error('Infinite Canvas 登录失败，请确认浏览器已登录 linux.do 后重试');
    }

    await cacheHeaders(site.siteId, authHeaders);
    tabToCleanup = tab.id;
  }

  let activeHeaders = { ...authHeaders };
  let execResult = await doCheckInRequest(site.signExecUrl, site.signExecMethod, site.signExecParams, activeHeaders);
  console.log(`${site.siteName} Infinite Canvas 签到响应:`, execResult);

  if (isInfiniteCanvasUnauthResult(execResult)) {
    await clearCachedHeaders(site.siteId);
    const tab = await openSiteSessionTab(tabSession, site.visitUrl);
    authHeaders = await readInfiniteCanvasAuthHeadersFromTab(tab.id, null);

    if (!hasAuthorizationHeader(authHeaders)) {
      const oauthResult = await autoInfiniteCanvasOAuthLogin(site.cookieDomain, tab.id, site.visitUrl);
      authHeaders = oauthResult?.headers || authHeaders;
    }

    if (hasAuthorizationHeader(authHeaders)) {
      activeHeaders = { ...authHeaders };
      await cacheHeaders(site.siteId, authHeaders);
      execResult = await doCheckInRequest(site.signExecUrl, site.signExecMethod, site.signExecParams, activeHeaders);
      console.log(`${site.siteName} Infinite Canvas 重新登录后签到响应:`, execResult);
      if (tabToCleanup && tabToCleanup !== tab.id) await closeTabUnlessInSession(tabToCleanup, tabSession);
      tabToCleanup = tab.id;
    } else {
      await closeTabUnlessInSession(tab.id, tabSession);
    }
  }

  ({ execResult, tabToCleanup } = await tryOfficialPageFallback(site, execResult, tabToCleanup, tabSession));

  const result = await buildResultWithLatestBalance(site, execResult, activeHeaders, tabToCleanup);
  await closeTabUnlessInSession(tabToCleanup, tabSession);
  result.queryVerified = execResult.success || execResult.alreadyCheckedIn || false;
  return result;
}

function isInfiniteCanvasUnauthResult(result) {
  const message = String(result?.message || result?.error || '');
  return !result?.success &&
    (
      result?.httpStatus === 401 ||
      result?.httpStatus === 403 ||
      /未登录|权限不足|unauthorized|forbidden/i.test(message)
    );
}

async function checkInSub2ApiSite(site, tabSession = null) {
  // 站点已关闭接口调用：直接走页面点击兜底
  if (!site.useApi) {
    console.log(`${site.siteName} 已禁用接口调用，直接使用页面点击签到`);
    const fallback = await tryOfficialPageFallback(site, {
      success: false,
      message: '已禁用接口调用，使用页面点击签到',
      httpStatus: 0,
      skipApiByConfig: true
    }, null, tabSession);
    const result = await buildResultWithLatestBalance(site, fallback.execResult, null, fallback.tabToCleanup);
    await closeTabUnlessInSession(fallback.tabToCleanup, tabSession);
    return result;
  }

  let authHeaders = await getCachedHeaders(site.siteId);
  let tabToCleanup = null;

  if (!hasSub2ApiUsableAuth(authHeaders)) {
    const tab = await openSiteSessionTab(tabSession, site.visitUrl);
    authHeaders = await readSub2ApiAuthHeadersFromTab(tab.id, authHeaders);

    if (!hasSub2ApiUsableAuth(authHeaders)) {
      const oauthResult = await autoSub2ApiOAuthLogin(site.cookieDomain, tab.id, site.visitUrl);
      authHeaders = oauthResult?.headers || authHeaders;
    }

    if (!hasSub2ApiUsableAuth(authHeaders)) {
      await closeTabUnlessInSession(tab.id, tabSession);
      throw new Error('Sub2API 登录失败，请确认浏览器已登录 linux.do 后重试');
    }

    if (hasAuthorizationHeader(authHeaders)) {
      await cacheHeaders(site.siteId, authHeaders);
    }
    tabToCleanup = tab.id;
  }

  const sub2ApiHeaders = { ...authHeaders, _needsTabExecution: true, _successOnHttpOk: true };
  let activeHeaders = sub2ApiHeaders;
  let execResult = await doCheckInRequest(site.signExecUrl, site.signExecMethod, site.signExecParams, sub2ApiHeaders);
  console.log(`${site.siteName} Sub2API 签到响应:`, execResult);

  if (execResult.httpStatus === 401 || execResult.httpStatus === 403) {
    await clearCachedHeaders(site.siteId);
    const tab = await openSiteSessionTab(tabSession, site.visitUrl);
    authHeaders = await readSub2ApiAuthHeadersFromTab(tab.id, null);

    if (!hasSub2ApiUsableAuth(authHeaders)) {
      const oauthResult = await autoSub2ApiOAuthLogin(site.cookieDomain, tab.id, site.visitUrl);
      authHeaders = oauthResult?.headers || authHeaders;
    }

    if (hasSub2ApiUsableAuth(authHeaders)) {
      const retryHeaders = { ...authHeaders, _needsTabExecution: true, _successOnHttpOk: true };
      activeHeaders = retryHeaders;
      if (hasAuthorizationHeader(authHeaders)) {
        await cacheHeaders(site.siteId, authHeaders);
      }
      execResult = await doCheckInRequest(site.signExecUrl, site.signExecMethod, site.signExecParams, retryHeaders);
      console.log(`${site.siteName} Sub2API 重新读取令牌后签到响应:`, execResult);
      if (tabToCleanup && tabToCleanup !== tab.id) await closeTabUnlessInSession(tabToCleanup, tabSession);
      tabToCleanup = tab.id;
    } else {
      await closeTabUnlessInSession(tab.id, tabSession);
    }
  }

  ({ execResult, tabToCleanup } = await tryOfficialPageFallback(site, execResult, tabToCleanup, tabSession));

  const result = await buildResultWithLatestBalance(site, execResult, activeHeaders, tabToCleanup);
  await closeTabUnlessInSession(tabToCleanup, tabSession);
  result.queryVerified = execResult.success || execResult.alreadyCheckedIn || false;
  return result;
}

async function checkInZenApiSite(site, tabSession = null) {
  // 站点已关闭接口调用：直接走页面点击兜底
  if (!site.useApi) {
    console.log(`${site.siteName} 已禁用接口调用，直接使用页面点击签到`);
    const fallback = await tryOfficialPageFallback(site, {
      success: false,
      message: '已禁用接口调用，使用页面点击签到',
      httpStatus: 0,
      skipApiByConfig: true
    }, null, tabSession);
    const result = await buildResultWithLatestBalance(site, fallback.execResult, null, fallback.tabToCleanup);
    await closeTabUnlessInSession(fallback.tabToCleanup, tabSession);
    return result;
  }

  let authHeaders = await getCachedHeaders(site.siteId);
  let tabToCleanup = null;

  if (!hasAuthorizationHeader(authHeaders)) {
    const tab = await openSiteSessionTab(tabSession, site.visitUrl);
    authHeaders = await readStorageTokenAuthHeadersFromTab(tab.id, ['user_token'], authHeaders);

    if (!hasAuthorizationHeader(authHeaders)) {
      const oauthResult = await autoZenApiOAuthLogin(site.cookieDomain, tab.id);
      authHeaders = oauthResult?.headers || authHeaders;
      if (oauthResult?.tabId && tab._autoCreated) tabToCleanup = oauthResult.tabId;
    }

    if (!hasAuthorizationHeader(authHeaders)) {
      await closeTabUnlessInSession(tab.id, tabSession);
      throw new Error('ZenAPI 登录失败，请确认浏览器已登录 linux.do 后重试');
    }

    await cacheHeaders(site.siteId, authHeaders);
    tabToCleanup = tab.id;
  }

  const zenApiHeaders = { ...authHeaders, _needsTabExecution: true };
  let activeHeaders = zenApiHeaders;
  let execResult = await doCheckInRequest(site.signExecUrl, site.signExecMethod, site.signExecParams, zenApiHeaders);
  console.log(`${site.siteName} ZenAPI 签到响应:`, execResult);

  if (execResult.httpStatus === 401 || execResult.httpStatus === 403) {
    await clearCachedHeaders(site.siteId);
    const tab = await openSiteSessionTab(tabSession, site.visitUrl);
    authHeaders = await readStorageTokenAuthHeadersFromTab(tab.id, ['user_token'], null);

    if (!hasAuthorizationHeader(authHeaders)) {
      const oauthResult = await autoZenApiOAuthLogin(site.cookieDomain, tab.id);
      authHeaders = oauthResult?.headers || authHeaders;
    }

    if (hasAuthorizationHeader(authHeaders)) {
      const retryHeaders = { ...authHeaders, _needsTabExecution: true };
      activeHeaders = retryHeaders;
      await cacheHeaders(site.siteId, authHeaders);
      execResult = await doCheckInRequest(site.signExecUrl, site.signExecMethod, site.signExecParams, retryHeaders);
      console.log(`${site.siteName} ZenAPI 重新读取令牌后签到响应:`, execResult);
      if (tabToCleanup && tabToCleanup !== tab.id) await closeTabUnlessInSession(tabToCleanup, tabSession);
      tabToCleanup = tab.id;
    } else {
      await closeTabUnlessInSession(tab.id, tabSession);
    }
  }

  ({ execResult, tabToCleanup } = await tryOfficialPageFallback(site, execResult, tabToCleanup, tabSession));

  const result = await buildResultWithLatestBalance(site, execResult, activeHeaders, tabToCleanup);
  await closeTabUnlessInSession(tabToCleanup, tabSession);
  result.queryVerified = execResult.success || execResult.alreadyCheckedIn || false;
  return result;
}

async function checkInPointsCheckinSite(site, tabSession = null) {
  // points-checkin：Cookie 会话 + /api/points/checkin；默认走 API，页面点击保留兜底。
  if (!site.useApi) {
    console.log(`${site.siteName} 已禁用接口调用，直接使用页面点击签到`);
    const fallback = await tryOfficialPageFallback(site, {
      success: false,
      message: '已禁用接口调用，使用页面点击签到',
      httpStatus: 0,
      skipApiByConfig: true
    }, null, tabSession);
    const result = await buildResultWithLatestBalance(site, fallback.execResult, null, fallback.tabToCleanup);
    await closeTabUnlessInSession(fallback.tabToCleanup, tabSession);
    return result;
  }

  let authHeaders = await getCachedHeaders(site.siteId);
  let tabToCleanup = null;

  if (!hasPointsCheckinUsableAuth(authHeaders)) {
    const tab = await openSiteSessionTab(tabSession, site.visitUrl);
    await sleep(1000);
    authHeaders = await probePointsCheckinSession(tab.id, authHeaders);

    if (!hasPointsCheckinUsableAuth(authHeaders)) {
      const oauthResult = await autoPointsCheckinOAuthLogin(site.cookieDomain, tab.id, site.visitUrl);
      authHeaders = oauthResult?.headers || authHeaders;
      if (oauthResult?.tabId) tabToCleanup = oauthResult.tabId;
    }

    if (!hasPointsCheckinUsableAuth(authHeaders)) {
      await closeTabUnlessInSession(tab.id, tabSession);
      throw new Error('积分签到站登录失败，请确认浏览器已登录 linux.do，或先在浏览器中手动登录该站点后重试');
    }

    await cacheHeaders(site.siteId, {
      _pointsCheckinSessionAuth: true,
      // 不缓存 _tabId：MV3 worker 回收后 tab 可能已失效，下次重新探测
    });
    tabToCleanup = tabToCleanup || tab.id;
  }

  // 缓存只保证“曾经登录成功”，真正请求必须绑定可用 tab
  if (!authHeaders?._tabId) {
    const tab = await openSiteSessionTab(tabSession, site.visitUrl);
    await sleep(800);
    const probed = await probePointsCheckinSession(tab.id, authHeaders);
    if (hasPointsCheckinUsableAuth(probed)) {
      authHeaders = probed;
    } else {
      const oauthResult = await autoPointsCheckinOAuthLogin(site.cookieDomain, tab.id, site.visitUrl);
      authHeaders = oauthResult?.headers || probed;
    }
    if (!hasPointsCheckinUsableAuth(authHeaders)) {
      await closeTabUnlessInSession(tab.id, tabSession);
      throw new Error('积分签到站登录失败，请确认浏览器已登录 linux.do，或先在浏览器中手动登录该站点后重试');
    }
    tabToCleanup = tab.id;
  }

  let activeHeaders = buildPointsCheckinRequestHeaders(authHeaders);
  let execResult = await executePointsCheckin(site, activeHeaders);
  console.log(`${site.siteName} 积分签到响应:`, execResult);

  if (isPointsCheckinUnauthResult(execResult)) {
    await clearCachedHeaders(site.siteId);
    const tab = await openSiteSessionTab(tabSession, site.visitUrl);
    await sleep(800);
    authHeaders = await probePointsCheckinSession(tab.id, null);

    if (!hasPointsCheckinUsableAuth(authHeaders)) {
      const oauthResult = await autoPointsCheckinOAuthLogin(site.cookieDomain, tab.id, site.visitUrl);
      authHeaders = oauthResult?.headers || authHeaders;
    }

    if (hasPointsCheckinUsableAuth(authHeaders)) {
      activeHeaders = buildPointsCheckinRequestHeaders(authHeaders);
      await cacheHeaders(site.siteId, { _pointsCheckinSessionAuth: true });
      execResult = await executePointsCheckin(site, activeHeaders);
      console.log(`${site.siteName} 积分签到重新登录后响应:`, execResult);
      if (tabToCleanup && tabToCleanup !== tab.id) await closeTabUnlessInSession(tabToCleanup, tabSession);
      tabToCleanup = tab.id;
    } else {
      await closeTabUnlessInSession(tab.id, tabSession);
    }
  }

  ({ execResult, tabToCleanup } = await tryOfficialPageFallback(site, execResult, tabToCleanup, tabSession));

  const result = await buildResultWithLatestBalance(site, execResult, activeHeaders, tabToCleanup);
  await closeTabUnlessInSession(tabToCleanup, tabSession);
  result.queryVerified = execResult.success || execResult.alreadyCheckedIn || false;
  return result;
}

async function checkInLocalApiSite(site, tabSession = null) {
  // LocalAPI 使用页面 localStorage 中的 localapi_user_token，通过 x-user-token 访问用户接口。
  if (!site.useApi) {
    console.log(`${site.siteName} 已禁用接口调用，直接使用页面点击签到`);
    const fallback = await tryOfficialPageFallback(site, {
      success: false,
      message: '已禁用接口调用，使用页面点击签到',
      httpStatus: 0,
      skipApiByConfig: true
    }, null, tabSession);
    const result = await buildResultWithLatestBalance(site, fallback.execResult, null, fallback.tabToCleanup);
    await closeTabUnlessInSession(fallback.tabToCleanup, tabSession);
    return result;
  }

  let authHeaders = await getCachedHeaders(site.siteId);
  let tabToCleanup = null;

  if (!hasLocalApiUsableAuth(authHeaders)) {
    const tab = await openSiteSessionTab(tabSession, site.visitUrl, 20000);
    await sleep(800);
    authHeaders = await readLocalApiAuthHeadersFromTab(tab.id, authHeaders);

    if (!hasLocalApiUsableAuth(authHeaders)) {
      const oauthResult = await autoLocalApiOAuthLogin(site.cookieDomain, tab.id, site.visitUrl);
      authHeaders = oauthResult?.headers || authHeaders;
      if (oauthResult?.tabId) tabToCleanup = oauthResult.tabId;
    }

    if (!hasLocalApiUsableAuth(authHeaders)) {
      await closeTabUnlessInSession(tab.id, tabSession);
      throw new Error('LocalAPI 登录失败，请确认浏览器已登录 linux.do 后重试');
    }

    await cacheHeaders(site.siteId, {
      _localApiUserToken: authHeaders._localApiUserToken
    });
    tabToCleanup = tabToCleanup || tab.id;
  }

  if (!authHeaders?._tabId) {
    const tab = await openSiteSessionTab(tabSession, site.visitUrl, 20000);
    await sleep(500);
    authHeaders = await readLocalApiAuthHeadersFromTab(tab.id, authHeaders);
    if (!hasLocalApiUsableAuth(authHeaders)) {
      await closeTabUnlessInSession(tab.id, tabSession);
      throw new Error('LocalAPI 登录态已失效，请重新登录后重试');
    }
    tabToCleanup = tab.id;
  }

  let activeHeaders = buildLocalApiRequestHeaders(authHeaders);
  let execResult = await executeLocalApiCheckin(site, activeHeaders);
  console.log(`${site.siteName} LocalAPI 签到响应:`, execResult);

  if (isLocalApiUnauthResult(execResult)) {
    await clearCachedHeaders(site.siteId);
    const tab = await openSiteSessionTab(tabSession, site.visitUrl, 20000);
    await sleep(500);
    await clearLocalApiAuthFromTab(tab.id);
    const oauthResult = await autoLocalApiOAuthLogin(site.cookieDomain, tab.id, site.visitUrl);
    authHeaders = oauthResult?.headers || null;
    if (hasLocalApiUsableAuth(authHeaders)) {
      activeHeaders = buildLocalApiRequestHeaders(authHeaders);
      await cacheHeaders(site.siteId, { _localApiUserToken: authHeaders._localApiUserToken });
      execResult = await executeLocalApiCheckin(site, activeHeaders);
      console.log(`${site.siteName} LocalAPI 重新登录后签到响应:`, execResult);
      if (tabToCleanup && tabToCleanup !== tab.id) await closeTabUnlessInSession(tabToCleanup, tabSession);
      tabToCleanup = tab.id;
    } else {
      await closeTabUnlessInSession(tab.id, tabSession);
    }
  }

  ({ execResult, tabToCleanup } = await tryOfficialPageFallback(site, execResult, tabToCleanup, tabSession));
  const result = await buildResultWithLatestBalance(site, execResult, activeHeaders, tabToCleanup);
  await closeTabUnlessInSession(tabToCleanup, tabSession);
  result.queryVerified = execResult.success || execResult.alreadyCheckedIn || false;
  return result;
}

function hasLocalApiUsableAuth(headers) {
  return Boolean(headers?._localApiUserToken && headers?._tabId);
}

function buildLocalApiRequestHeaders(authHeaders) {
  return {
    ...(authHeaders || {}),
    _needsTabExecution: true,
    _localApiUserToken: authHeaders?._localApiUserToken || ''
  };
}

async function readLocalApiAuthHeadersFromTab(tabId, baseHeaders = {}) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const callbackToken = new URL(location.href).searchParams.get('linuxdo_token') || '';
        if (callbackToken) {
          localStorage.setItem('localapi_user_token', callbackToken);
          localStorage.setItem('localapi_auth_mode', 'user');
          const cleanUrl = new URL(location.href);
          cleanUrl.searchParams.delete('linuxdo_token');
          history.replaceState(null, '', `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
        }
        return {
          token: callbackToken ||
            localStorage.getItem('localapi_user_token') ||
            sessionStorage.getItem('localapi_user_token') || ''
        };
      }
    });
    const token = String(results[0]?.result?.token || '').trim();
    return {
      ...(baseHeaders || {}),
      _tabId: tabId,
      _localApiUserToken: token || baseHeaders?._localApiUserToken || ''
    };
  } catch (e) {
    console.warn('[LocalAPI] 读取页面登录令牌失败:', e);
    return baseHeaders || {};
  }
}

async function clearLocalApiAuthFromTab(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        localStorage.removeItem('localapi_user_token');
        sessionStorage.removeItem('localapi_user_token');
      }
    });
  } catch (e) {
    console.warn('[LocalAPI] 清理过期页面令牌失败:', e);
  }
}

async function autoLocalApiOAuthLogin(domain, tabId = null, visitUrl = null) {
  console.log(`[LocalAPI OAuth] 开始登录: ${domain}`);
  const ldCookies = await chrome.cookies.getAll({ domain: 'linux.do' });
  if (ldCookies.length === 0) {
    console.warn('[LocalAPI OAuth] linux.do 未登录');
    return null;
  }

  let tab;
  const ownsTab = !tabId;
  try {
    tab = tabId ? await chrome.tabs.get(tabId) : await createTemporaryBackgroundTab(getLocalApiDefaultPageUrl(domain));
    const loginUrl = `https://${domain}/user/api/auth/linuxdo`;
    await chrome.tabs.update(tab.id, { url: loginUrl, active: false });
    await waitForTabComplete(tab.id, 20000);
    await waitForUsableTabPage(tab.id, 20000);

    let tabInfo = await chrome.tabs.get(tab.id);
    if (tabInfo.url && tabInfo.url.includes('connect.linux.do')) {
      await clickLinuxDoAuthorizeButton(tab.id);
      const redirected = await waitForTabUrlMatch(tab.id, domain, 30000);
      if (!redirected) {
        if (ownsTab) await closeTabQuietly(tab.id);
        return null;
      }
      await ensureTabPageReady(tab.id, getLocalApiDefaultPageUrl(domain), 20000);
      await sleep(800);
    }

    const headers = await waitForLocalApiAuthHeaders(tab.id, domain, visitUrl, 15000);
    if (hasLocalApiUsableAuth(headers)) {
      const readyUrl = visitUrl || getLocalApiDefaultPageUrl(domain);
      try {
        const current = await chrome.tabs.get(tab.id);
        if (current.url !== readyUrl) {
          await chrome.tabs.update(tab.id, { url: readyUrl, active: false });
          await ensureTabPageReady(tab.id, readyUrl, 20000);
        }
      } catch (e) {
        console.warn('[LocalAPI OAuth] 返回签到页失败，继续使用当前页面:', e);
      }
      const refreshedHeaders = await readLocalApiAuthHeadersFromTab(tab.id, headers);
      return { headers: refreshedHeaders, tabId: tab.id };
    }
    if (ownsTab) await closeTabQuietly(tab.id);
    return null;
  } catch (e) {
    console.warn('[LocalAPI OAuth] 登录失败:', e);
    if (ownsTab) await closeTabQuietly(tab?.id);
    return null;
  }
}

async function waitForLocalApiAuthHeaders(tabId, domain, visitUrl = null, timeout = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const headers = await readLocalApiAuthHeadersFromTab(tabId, null);
    if (headers._localApiUserToken) return headers;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (isTargetDomainLoginPage(tab.url, domain)) {
        await chrome.tabs.update(tabId, { url: visitUrl || getLocalApiDefaultPageUrl(domain), active: false });
        await ensureTabPageReady(tabId, visitUrl || getLocalApiDefaultPageUrl(domain), 15000);
      }
    } catch (e) {}
    await sleep(800);
  }
  return null;
}

async function executeLocalApiCheckin(site, authHeaders) {
  const statusResult = await doCheckInRequest(
    site.signExecUrl,
    'GET',
    null,
    { ...authHeaders, _needsTabExecution: true, _successOnHttpOk: false }
  );
  const statusParsed = parseLocalApiResult(statusResult, 'GET');
  if (statusParsed.alreadyCheckedIn || statusParsed.disabled || isLocalApiUnauthResult(statusParsed)) {
    return statusParsed;
  }

  const postResult = await doCheckInRequest(
    site.signExecUrl,
    'POST',
    {},
    { ...authHeaders, _needsTabExecution: true, _successOnHttpOk: false }
  );
  return parseLocalApiResult(postResult, 'POST');
}

function parseLocalApiResult(rawResult, method = 'POST') {
  if (!rawResult) return { success: false, alreadyCheckedIn: false, message: '无响应', httpStatus: 0 };
  if (rawResult.invalidSite) return rawResult;
  const data = rawResult.data || {};
  const httpStatus = rawResult.httpStatus || 0;
  const message = String(data.error || data.message || data.msg || rawResult.message || rawResult.error || '');

  if (httpStatus === 401 || httpStatus === 403 || /invalid or expired user session|unauthorized|forbidden/i.test(message)) {
    return { success: false, alreadyCheckedIn: false, message: message || '未登录或登录已过期', httpStatus, data };
  }
  if (data.settings?.enabled === false) {
    return {
      success: false,
      alreadyCheckedIn: false,
      disabled: true,
      message: '签到未开启',
      httpStatus: httpStatus || 200,
      data
    };
  }
  if (data.checked_in_today === true || data.status === 'already' || /already checked|今日已签到|已签到/i.test(message)) {
    const points = Number(data.record?.points);
    return {
      success: true,
      alreadyCheckedIn: true,
      message: Number.isFinite(points) ? `今日已签到，获得 ${points.toFixed(2)} 积分` : '今日已签到',
      httpStatus: httpStatus || 200,
      data
    };
  }
  if (method === 'POST' && httpStatus >= 200 && httpStatus < 300 && data.record) {
    const points = Number(data.record.points);
    return {
      success: true,
      alreadyCheckedIn: false,
      message: Number.isFinite(points) ? `签到成功，获得 ${points.toFixed(2)} 积分` : '签到成功',
      httpStatus,
      data
    };
  }
  if (method === 'GET' && httpStatus >= 200 && httpStatus < 300) {
    return { success: false, alreadyCheckedIn: false, message: message || '待签到', httpStatus, data };
  }
  return { success: false, alreadyCheckedIn: false, message: message || '签到失败', httpStatus, data };
}

function isLocalApiUnauthResult(result) {
  const message = String(result?.message || result?.error || result?.data?.error || '');
  const authFailure = result?.httpStatus === 401 ||
    result?.httpStatus === 403 ||
    /invalid or expired user session|未登录|登录已过期|unauthorized|forbidden/i.test(message);
  return !result?.success && !result?.alreadyCheckedIn && authFailure;
}

function hasPointsCheckinUsableAuth(headers) {
  return Boolean(headers?._pointsCheckinSessionAuth && headers?._tabId);
}

function buildPointsCheckinRequestHeaders(authHeaders) {
  return {
    ...authHeaders,
    _needsTabExecution: true,
    _pointsCheckinSessionAuth: true
  };
}

function isPointsCheckinUnauthResult(result) {
  const message = String(result?.message || result?.error || result?.data?.error || '');
  const code = String(result?.data?.code || result?.code || '');
  return !result?.success &&
    !result?.alreadyCheckedIn &&
    (
      result?.httpStatus === 401 ||
      result?.httpStatus === 403 ||
      code === 'unauthorized' ||
      /未登录|登录已过期|unauthorized|forbidden/i.test(message)
    );
}

async function probePointsCheckinSession(tabId, baseHeaders = {}) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        try {
          const response = await fetch('/api/auth/me', { credentials: 'include' });
          const text = await response.text();
          let data = null;
          try {
            data = text ? JSON.parse(text) : null;
          } catch (e) {
            data = null;
          }
          return {
            ok: response.ok,
            status: response.status,
            data,
            hasUser: Boolean(data?.user)
          };
        } catch (e) {
          return { ok: false, status: 0, error: e.message, hasUser: false };
        }
      }
    });

    const probe = results[0]?.result;
    if (probe?.ok && probe?.hasUser) {
      return {
        ...(baseHeaders || {}),
        _tabId: tabId,
        _pointsCheckinSessionAuth: true,
        _needsTabExecution: true
      };
    }
    return {
      ...(baseHeaders || {}),
      _tabId: tabId
    };
  } catch (e) {
    console.warn('[PointsCheckin] 探测登录态失败:', e);
    return baseHeaders || {};
  }
}

function buildPointsCheckinLinuxDoOAuthStartUrl(domain, visitUrl = null) {
  const redirect = getPointsCheckinOAuthRedirect(visitUrl);
  const params = new URLSearchParams({ redirect });
  return `https://${domain}/api/auth/linuxdo/start?${params.toString()}`;
}

function getPointsCheckinOAuthRedirect(currentUrl = '') {
  try {
    const parsed = new URL(currentUrl || '');
    const hashRoute = String(parsed.hash || '').replace(/^#/, '');
    const hashPath = hashRoute.split('?')[0] || '';
    const hashQuery = hashRoute.includes('?') ? hashRoute.slice(hashRoute.indexOf('?') + 1) : '';
    const hashRedirect = new URLSearchParams(hashQuery).get('redirect');
    if (hashRedirect && hashRedirect.startsWith('/')) return hashRedirect;
    if (hashPath && hashPath !== '/login' && !/^\/sign-?in$/i.test(hashPath)) {
      return hashPath;
    }

    const redirect = parsed.searchParams.get('redirect');
    if (redirect && redirect.startsWith('/')) return redirect;

    if (parsed.pathname && parsed.pathname !== '/' && !/^\/(?:login|sign-?in)(?:\/|$)/i.test(parsed.pathname)) {
      return `${parsed.pathname}${parsed.search || ''}` || '/checkin';
    }
  } catch (e) {}
  return '/checkin';
}

async function autoPointsCheckinOAuthLogin(domain, tabId = null, visitUrl = null) {
  console.log(`[PointsCheckin OAuth] 开始登录: ${domain}`);

  const ldCookies = await chrome.cookies.getAll({ domain: 'linux.do' });
  if (ldCookies.length === 0) {
    console.warn('[PointsCheckin OAuth] linux.do 未登录');
    return null;
  }

  let tab;
  const ownsTab = !tabId;
  const startUrl = buildPointsCheckinLinuxDoOAuthStartUrl(domain, visitUrl);
  try {
    tab = tabId ? await chrome.tabs.get(tabId) : await createTemporaryBackgroundTab(startUrl);
    console.log(`[PointsCheckin OAuth] 打开 OAuth start 入口: ${startUrl}`);
    await chrome.tabs.update(tab.id, { url: startUrl, active: false });

    await waitForTabComplete(tab.id, 20000);
    await waitForUsableTabPage(tab.id, 20000);
    let tabInfo = await chrome.tabs.get(tab.id);
    console.log(`[PointsCheckin OAuth] OAuth start 后页面: ${tabInfo.url}`);

    if (tabInfo.url && tabInfo.url.includes('connect.linux.do')) {
      await clickLinuxDoAuthorizeButton(tab.id);
      const redirected = await waitForTabUrlMatch(tab.id, domain, 30000);
      if (!redirected) {
        console.warn('[PointsCheckin OAuth] 等待回跳目标站超时');
        if (ownsTab) await closeTabQuietly(tab.id);
        return null;
      }
      await ensureTabPageReady(tab.id, getPointsCheckinDefaultPageUrl(domain), 20000);
      await sleep(1000);
      tabInfo = await chrome.tabs.get(tab.id);
    }

    for (let retry = 0; retry < 12; retry++) {
      const headers = await probePointsCheckinSession(tab.id, null);
      if (hasPointsCheckinUsableAuth(headers)) {
        console.log('[PointsCheckin OAuth] 已建立 Cookie 会话');
        // 回跳后尽量落到签到页，方便后续页面兜底
        try {
          const current = await chrome.tabs.get(tab.id);
          if (!String(current.url || '').includes('#/checkin')) {
            await chrome.tabs.update(tab.id, { url: getPointsCheckinDefaultPageUrl(domain), active: false });
            await ensureTabPageReady(tab.id, getPointsCheckinDefaultPageUrl(domain), 15000);
          }
        } catch (e) {}
        return { headers, tabId: tab.id };
      }
      await sleep(1000);
    }

    console.warn('[PointsCheckin OAuth] 未能建立登录会话');
    if (ownsTab) await closeTabQuietly(tab.id);
    return null;
  } catch (e) {
    console.warn('[PointsCheckin OAuth] 登录失败:', e);
    if (ownsTab) await closeTabQuietly(tab?.id);
    return null;
  }
}

async function executePointsCheckin(site, authHeaders) {
  // 1) GET 状态：已签 / 未开启 可直接返回
  const statusResult = await doCheckInRequest(
    site.signExecUrl,
    'GET',
    null,
    { ...authHeaders, _needsTabExecution: true }
  );
  const statusParsed = parsePointsCheckinResult(statusResult, 'GET');
  if (statusParsed.alreadyCheckedIn || statusParsed.disabled || isPointsCheckinUnauthResult(statusParsed)) {
    return statusParsed;
  }

  // 2) POST 签到
  const postResult = await doCheckInRequest(
    site.signExecUrl,
    site.signExecMethod || 'POST',
    site.signExecParams || {},
    { ...authHeaders, _needsTabExecution: true }
  );
  return parsePointsCheckinResult(postResult, 'POST');
}

function parsePointsCheckinResult(rawResult, method = 'POST') {
  if (!rawResult) {
    return { success: false, alreadyCheckedIn: false, message: '无响应', httpStatus: 0 };
  }
  if (rawResult.error && !rawResult.data && !rawResult.httpStatus) {
    return {
      success: false,
      alreadyCheckedIn: false,
      message: rawResult.error,
      httpStatus: rawResult.httpStatus || 0,
      error: rawResult.error
    };
  }
  if (rawResult.invalidSite) {
    return rawResult;
  }

  const data = rawResult.data;
  const httpStatus = rawResult.httpStatus || 0;
  const daily = data?.daily_checkin || data?.dailyCheckin || null;
  const messageFromApi = data?.error || data?.message || data?.msg || rawResult.message || rawResult.error || '';

  if (httpStatus === 401 || httpStatus === 403 || data?.code === 'unauthorized') {
    return {
      success: false,
      alreadyCheckedIn: false,
      message: messageFromApi || '未登录或登录已过期',
      httpStatus,
      data,
      code: data?.code || 'unauthorized'
    };
  }

  if (daily && daily.enabled === false) {
    return {
      success: false,
      alreadyCheckedIn: false,
      disabled: true,
      message: '签到未开启',
      httpStatus,
      data
    };
  }

  if (daily?.signed_today === true) {
    const points = Number.isFinite(Number(data?.points))
      ? Number(data.points)
      : Number.isFinite(Number(data?.user?.points))
        ? Number(data.user.points)
        : null;
    return {
      success: true,
      alreadyCheckedIn: true,
      message: points != null ? `今日已签到，当前积分 ${points}` : '今日已签到',
      httpStatus: httpStatus || 200,
      data
    };
  }

  // POST 成功：有 added 或 daily_checkin 回写
  const added = Number(data?.added);
  if (method === 'POST' && httpStatus >= 200 && httpStatus < 300 && data && typeof data === 'object') {
    if (Number.isFinite(added) || daily || data.user) {
      return {
        success: true,
        alreadyCheckedIn: false,
        message: Number.isFinite(added)
          ? `签到成功，获得 ${added} 积分`
          : (messageFromApi || '签到成功'),
        httpStatus,
        data
      };
    }
  }

  // GET 且未签：交给 POST
  if (method === 'GET' && httpStatus >= 200 && httpStatus < 300) {
    return {
      success: false,
      alreadyCheckedIn: false,
      message: messageFromApi || '待签到',
      httpStatus,
      data
    };
  }

  // 回退：若通用解析已判定成功/已签，保留
  if (rawResult.success || rawResult.alreadyCheckedIn) {
    return {
      ...rawResult,
      success: true,
      alreadyCheckedIn: Boolean(rawResult.alreadyCheckedIn)
    };
  }

  return {
    success: false,
    alreadyCheckedIn: false,
    message: messageFromApi || rawResult.message || '签到失败',
    httpStatus,
    data,
    error: rawResult.error
  };
}

async function tryOfficialPageFallback(site, execResult, tabToCleanup = null, tabSession = null) {
  if (!shouldTryOfficialPageCheckIn(execResult)) {
    return { execResult, tabToCleanup };
  }

  // 配置级禁用接口调用，直接走页面签到，不打印"接口签到失败"
  if (execResult.skipApiByConfig) {
    let pageResult;
    try {
      pageResult = await checkInFromOfficialPage(site, tabSession);
    } catch (e) {
      await closeTabUnlessInSession(tabToCleanup, tabSession);
      throw e;
    }
    let nextTabToCleanup = tabToCleanup;

    if (pageResult.tabId) {
      if (pageResult.keepTabOpen) {
        if (tabToCleanup && tabToCleanup !== pageResult.tabId) {
          await closeTabUnlessInSession(tabToCleanup, tabSession);
        }
        nextTabToCleanup = null;
      } else if (nextTabToCleanup && nextTabToCleanup !== pageResult.tabId) {
        await closeTabUnlessInSession(pageResult.tabId, tabSession);
      } else {
        nextTabToCleanup = pageResult.tabId;
      }
    }

    console.log(`${site.siteName} 页面签到响应:`, pageResult.result);
    return { execResult: pageResult.result, tabToCleanup: nextTabToCleanup };
  }

  console.log(`${site.siteName} 接口签到失败，尝试打开官方页面点击签到按钮...`);
  let pageResult;
  try {
    pageResult = await checkInFromOfficialPage(site, tabSession);
  } catch (e) {
    await closeTabUnlessInSession(tabToCleanup, tabSession);
    throw e;
  }
  let nextTabToCleanup = tabToCleanup;

  if (pageResult.tabId) {
    if (pageResult.keepTabOpen) {
      if (tabToCleanup && tabToCleanup !== pageResult.tabId) {
        await closeTabUnlessInSession(tabToCleanup, tabSession);
      }
      nextTabToCleanup = null;
    } else if (nextTabToCleanup && nextTabToCleanup !== pageResult.tabId) {
      await closeTabUnlessInSession(pageResult.tabId, tabSession);
    } else {
      nextTabToCleanup = pageResult.tabId;
    }
  }

  console.log(`${site.siteName} 官方页面兜底签到响应:`, pageResult.result);
  return { execResult: pageResult.result, tabToCleanup: nextTabToCleanup };
}

async function ensureOfficialPageTabAlive(site, tab, tabSession = null, preferredUrl = '') {
  const fallbackUrl = preferredUrl ||
    getOfficialPagePostLoginUrl(site) ||
    site?.visitUrl ||
    (site?.cookieDomain ? `https://${site.cookieDomain}/` : '');
  if (!fallbackUrl) {
    return tab;
  }

  const tabId = tab?.id;
  if (tabId) {
    try {
      const liveTab = await chrome.tabs.get(tabId);
      if (liveTab?.id) {
        liveTab._autoCreated = tab?._autoCreated;
        return liveTab;
      }
    } catch (e) {
      console.warn(`[页面签到] ${site?.siteName || ''} 标签页已失效，准备重建:`, e?.message || e);
    }
  }

  const reopened = await openSiteSessionTab(tabSession, fallbackUrl, 20000);
  reopened._autoCreated = true;
  return reopened;
}

async function checkInFromOfficialPage(site, tabSession = null) {
  let tab = await openSiteSessionTab(tabSession, site.visitUrl, 20000);
  await sleep(3000);

  tab = await ensureOfficialPageLoginBeforeCheckIn(site, tab, tabSession);
  tab = await ensureOfficialPageTabAlive(site, tab, tabSession, getOfficialPagePostLoginUrl(site) || site.visitUrl);
  await sleep(1000);

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async (targetUrl) => {
      const originalFetch = window.fetch;
      const originalXhrOpen = window.XMLHttpRequest?.prototype?.open;
      const originalXhrSend = window.XMLHttpRequest?.prototype?.send;
      const checkInResponses = [];
      let targetPath = '';

      try {
        targetPath = new URL(targetUrl).pathname;
      } catch (e) {}

      function recordCheckInResponse(url, method, status, text) {
        try {
          if (!url) {
            return;
          }
          const requestMethod = String(method || 'GET').toUpperCase();
          const requestPath = new URL(String(url), location.origin).pathname;
          const commonCheckInPath =
            requestPath.includes('/checkin') ||
            requestPath.includes('/check-in') ||
            requestPath.includes('/signin') ||
            requestPath.includes('/sign-in');
          if (requestPath !== targetPath && !commonCheckInPath) return;
          if (requestMethod !== 'POST' && !commonCheckInPath) return;

          let data = null;
          try { data = JSON.parse(text); } catch (e) {}
          checkInResponses.push({ httpStatus: status, data, text, method: requestMethod, url: String(url) });
        } catch (e) {}
      }

      window.fetch = async (...args) => {
        const response = await originalFetch.apply(window, args);
        try {
          const request = args[0];
          const options = args[1] || {};
          const url = typeof request === 'string' ? request : request?.url;
          const method = String(options.method || request?.method || 'GET').toUpperCase();
          if (url) {
            const clone = response.clone();
            const text = await clone.text();
            recordCheckInResponse(url, method, response.status, text);
          }
        } catch (e) {}
        return response;
      };

      if (originalXhrOpen && originalXhrSend) {
        window.XMLHttpRequest.prototype.open = function(method, url, ...rest) {
          this.__newApiCheckInRequest = { method, url: String(url || '') };
          return originalXhrOpen.call(this, method, url, ...rest);
        };
        window.XMLHttpRequest.prototype.send = function(...args) {
          try {
            this.addEventListener('load', () => {
              const req = this.__newApiCheckInRequest || {};
              recordCheckInResponse(req.url, req.method, this.status, this.responseText || '');
            }, { once: true });
          } catch (e) {}
          return originalXhrSend.apply(this, args);
        };
      }

      const pollIntervalMs = 500;
      const regularWaitLoops = 40;
      const securityCheckWaitLoops = 40;

      function isVisible(el) {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          rect.width > 0 &&
          rect.height > 0;
      }

      function hasSecurityCheck() {
        const text = document.body?.innerText || '';
        return /Security Check|安全验证|人机验证|Turnstile|captcha|验证码|请完成验证|verify you are human/i.test(text) ||
          Boolean(document.querySelector([
            'iframe[src*="challenges.cloudflare.com"]',
            'iframe[src*="turnstile"]',
            'iframe[src*="google.com/recaptcha"]',
            'iframe[src*="recaptcha.net/recaptcha"]',
            'iframe[src*="hcaptcha.com"]',
            '.cf-turnstile',
            '.g-recaptcha',
            '.h-captcha',
            '[data-sitekey]',
            'input[name="cf-turnstile-response"]',
            'textarea[name="g-recaptcha-response"]',
            'textarea[name="h-captcha-response"]'
          ].join(', ')));
      }

      function getCandidateText(el) {
        return [
          el.textContent,
          el.getAttribute('aria-label'),
          el.getAttribute('title'),
          el.getAttribute('data-title'),
          el.getAttribute('data-tooltip'),
          el.value
        ].filter(Boolean).join(' ').trim();
      }

      function matchesAlreadyCheckedText(text) {
        const normalized = String(text || '').replace(/\s+/g, ' ').trim();
        if (!normalized || normalized.length > 40) return false;
        return /^(Checked in|Already checked|Already signed|已签到|已签|已签过|今日已签|今日已签到|今天已签|今天已签到|已经签到)$/i.test(normalized) ||
          /^(今日|今天).{0,12}(已签到|已签|已签过|已经签到)$/i.test(normalized) ||
          /^(Checked in|Already checked|Already signed).{0,16}today$/i.test(normalized);
      }

      function findCheckedInStateText() {
        const candidates = Array.from(document.querySelectorAll('button, [role="button"], [role="status"], [aria-live], a, input[type="button"], input[type="submit"], [tabindex]:not([tabindex="-1"]), [onclick], [class*="cursor-pointer"], [data-slot="button"], [class*="status"], [class*="tag"], [class*="badge"], [class*="checked"], [class*="signed"], [class*="success"], span, p'));
        const found = candidates.find((el) => {
          const text = getCandidateText(el).replace(/\s+/g, ' ').trim();
          return text &&
            isVisible(el) &&
            matchesAlreadyCheckedText(text);
        });
        return found ? getCandidateText(found).replace(/\s+/g, ' ').trim() : '';
      }

      function hasCheckedInText() {
        return Boolean(findCheckedInStateText());
      }

      function isDisabledCandidate(el) {
        return el.disabled ||
          el.getAttribute('aria-disabled') === 'true' ||
          el.classList.contains('disabled') ||
          el.closest('[aria-disabled="true"], [disabled]');
      }

      function matchesCheckInText(text) {
        return /Check in now|Daily Check-in|check.?in|checkin|daily check.?in|daily reward|claim reward|领取奖励|领取额度|每日领取|签到领取|每日福利|今日福利|立即签到|现在签到|每日签到|^签$|^签到$|^领取$/i.test(text) &&
          !/^(Checked in|Already checked|Already signed)$/i.test(String(text || '').replace(/\s+/g, ' ').trim());
      }

      function isNonUserCheckInControl(text) {
        return /settings?|配置|设置|enable check.?in|minimum check.?in|maximum check.?in|check.?in quota/i.test(text);
      }

      function getCheckInTextPriority(text) {
        if (/立即签到|现在签到|Check in now|^签到$|^签$/i.test(text)) return 0;
        if (/签到领取|领取奖励|领取额度|claim reward|^领取$/i.test(text)) return 1;
        if (/每日签到|每日领取|Daily Check-in|daily check.?in|daily reward|今日福利|每日福利/i.test(text)) return 2;
        if (/check.?in|checkin/i.test(text)) return 3;
        return 4;
      }

      function isImmediateCheckInText(text) {
        return getCheckInTextPriority(text) === 0;
      }

      function findCheckInButton({ immediateOnly = false } = {}) {
        // 皮皮智绘：签到按钮文案含动态奖励后缀（如“签到 +100~200”），文案启发式不命中，
        // 用稳定的 #checkinBtn / [data-act="checkin"] 直取（禁用/已签态交给已签检测处理）。
        if (location.hostname === 'img.pipiwangcom.com') {
          const pipiBtn = document.querySelector('#checkinBtn, [data-act="checkin"]');
          if (pipiBtn && isVisible(pipiBtn) && !isDisabledCandidate(pipiBtn) &&
            !matchesAlreadyCheckedText(getCandidateText(pipiBtn).replace(/\s+/g, ' ').trim())) {
            return pipiBtn;
          }
        }
        const clickableSelector = [
          'button',
          '[role="button"]',
          'a',
          'input[type="button"]',
          'input[type="submit"]',
          '[tabindex]:not([tabindex="-1"])',
          '[onclick]',
          '[class*="cursor-pointer"]',
          '[data-slot="button"]'
        ].join(', ');
        const directCandidates = Array.from(document.querySelectorAll(clickableSelector));
        const textCandidates = Array.from(document.querySelectorAll('button, a, div, span, p, li')).filter((el) => {
          const text = getCandidateText(el);
          return text && text.length <= 80 && matchesCheckInText(text);
        });
        const candidates = [...directCandidates, ...textCandidates]
          .map((el) => el.closest(clickableSelector) || el)
          .filter((el, index, arr) => el && arr.indexOf(el) === index);

        return candidates
          .map((el, index) => ({ el, index, text: getCandidateText(el) }))
          .filter(({ el, text }) => text &&
            text.length <= 120 &&
            !isDisabledCandidate(el) &&
            isVisible(el) &&
            matchesCheckInText(text) &&
            (!immediateOnly || isImmediateCheckInText(text)) &&
            !isNonUserCheckInControl(text) &&
            !matchesAlreadyCheckedText(text))
          .sort((a, b) => getCheckInTextPriority(a.text) - getCheckInTextPriority(b.text) || a.index - b.index)[0]?.el || null;
      }

      function getCheckInCandidateSummary() {
        const candidates = Array.from(document.querySelectorAll('button, [role="button"], a, input[type="button"], input[type="submit"], [tabindex]:not([tabindex="-1"]), [onclick], [class*="cursor-pointer"], [data-slot="button"]'))
          .map(getCandidateText)
          .map(text => text.replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .filter(text => text.length <= 80)
          .slice(0, 8);
        return candidates.join(' | ');
      }

      function hasDisabledCheckInButton() {
        const candidates = Array.from(document.querySelectorAll('button, [role="button"], a, input[type="button"], input[type="submit"], [tabindex]:not([tabindex="-1"]), [onclick], [class*="cursor-pointer"], [data-slot="button"]'));
        return candidates.some((el) => {
          const text = getCandidateText(el);
          return text &&
            text.length <= 120 &&
            isDisabledCandidate(el) &&
            isVisible(el) &&
            matchesCheckInText(text) &&
            !isNonUserCheckInControl(text) &&
            !matchesAlreadyCheckedText(text) &&
            !/Loading|加载|处理中/i.test(text);
        });
      }

      try {
        let button = null;
        let clickedText = '';
        let securityCheckSeen = false;
        for (let i = 0; i < (securityCheckSeen ? securityCheckWaitLoops : regularWaitLoops); i++) {
          button = findCheckInButton({ immediateOnly: true });
          if (button) break;

          const checkedInStateText = findCheckedInStateText();
          if (checkedInStateText) {
            return { kind: 'already', message: `今日已签到: ${checkedInStateText}` };
          }
          if (hasDisabledCheckInButton()) {
            return { kind: 'already', message: '今日已签到' };
          }
          button = findCheckInButton();
          if (button) break;
          if (hasSecurityCheck()) {
            securityCheckSeen = true;
          }
          await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        }

        if (!button) {
          const candidates = getCheckInCandidateSummary();
          return {
            kind: hasSecurityCheck() ? 'security-check' : 'no-button',
            message: hasSecurityCheck()
              ? '站点要求完成人机验证，等待超时，自动签到已停止'
              : candidates
                ? `未找到官方页面签到按钮，页面候选: ${candidates}`
                : '未找到官方页面签到按钮，自动签到失败',
            candidates
          };
        }

        button.scrollIntoView?.({ block: 'center', inline: 'center' });
        await new Promise(resolve => setTimeout(resolve, 100));
        clickedText = getCandidateText(button).replace(/\s+/g, ' ').trim().slice(0, 80);
        button.click();

        for (let i = 0; i < (securityCheckSeen ? securityCheckWaitLoops : regularWaitLoops); i++) {
          await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
          if (checkInResponses.length > 0) {
            return { kind: 'response', clickedText, ...checkInResponses[checkInResponses.length - 1] };
          }
          if (hasSecurityCheck()) {
            securityCheckSeen = true;
            continue;
          }
          if (hasCheckedInText()) {
            return {
              kind: 'success',
              message: clickedText ? `签到成功: ${clickedText}` : '签到成功',
              data: { clickedText }
            };
          }
        }

        return {
          kind: securityCheckSeen ? 'security-check' : 'timeout',
          message: securityCheckSeen
            ? '站点要求完成人机验证，等待超时，自动签到已停止'
            : clickedText
            ? `官方页面已点击「${clickedText}」，但未捕获到签到结果`
            : '官方页面签到请求超时，自动签到失败',
          clickedText,
          candidates: getCheckInCandidateSummary()
        };
      } finally {
        window.fetch = originalFetch;
        if (originalXhrOpen && originalXhrSend) {
          window.XMLHttpRequest.prototype.open = originalXhrOpen;
          window.XMLHttpRequest.prototype.send = originalXhrSend;
        }
      }
    },
    args: [site.signExecUrl]
  });

  const pageResult = results[0]?.result || {};
  if (shouldRefreshOfficialPageBeforeBalance(pageResult)) {
    await refreshTabBeforeReadingBalance(tab.id, site);
  }
  const fallbackPageBalance = await readBalanceFromTab(tab.id, site);
  console.log(`${site.siteName} 官方页面签到执行结果:`, pageResult);

  function withFallbackPageBalance(result) {
    if (fallbackPageBalance) result.balance = fallbackPageBalance;
    return result;
  }

  if (pageResult.kind === 'response' && pageResult.data) {
    let parsed = parseCheckInResponse(pageResult.data, pageResult.httpStatus, false);
    if (parsed.alreadyCheckedIn && pageResult.clickedText) {
      parsed = markOfficialPageClickSuccess(parsed, pageResult.clickedText);
    }
    if (parsed.requiresPageExecution) {
      parsed.message = '站点仍要求页面内操作，自动签到已停止';
      return { result: withFallbackPageBalance(parsed), tabId: tab.id, keepTabOpen: shouldKeepOfficialPageFallbackTabOpen(parsed) };
    }
    if (parsed.requiresSecurityCheck) {
      parsed.message = '站点要求完成 Turnstile 安全验证，自动签到已停止';
      return { result: withFallbackPageBalance(parsed), tabId: tab.id, keepTabOpen: shouldKeepOfficialPageFallbackTabOpen(parsed) };
    }
    return { result: withFallbackPageBalance(parsed), tabId: tab.id, keepTabOpen: shouldKeepOfficialPageFallbackTabOpen(parsed) };
  }

  if (pageResult.kind === 'already') {
    return {
      result: withFallbackPageBalance({
        success: true,
        alreadyCheckedIn: true,
        message: pageResult.message || '今日已签到',
        httpStatus: 200,
        data: pageResult
      }),
      tabId: tab.id,
      keepTabOpen: false
    };
  }

  if (pageResult.kind === 'success') {
    return {
      result: withFallbackPageBalance({
        success: true,
        alreadyCheckedIn: false,
        message: pageResult.message || '签到成功',
        httpStatus: 200,
        data: pageResult,
        fallbackClicked: true
      }),
      tabId: tab.id,
      keepTabOpen: false
    };
  }

  return {
    result: withFallbackPageBalance({
      success: false,
      message: pageResult.message || getOfficialPageFallbackFailureMessage(pageResult),
      httpStatus: pageResult.kind === 'security-check' ? 403 : 0,
      data: pageResult
    }),
    tabId: tab.id,
    keepTabOpen: false
  };
}

function getOfficialPageLoginUrl(site) {
  if (!site?.cookieDomain) {
    return site?.visitUrl || '';
  }
  return isTargetDomainLoginPage(site.visitUrl, site.cookieDomain)
    ? site.visitUrl
    : `https://${site.cookieDomain}/login`;
}

function canBypassOfficialPageSecurityCheck(pageState) {
  // Turnstile/验证码会拦邮箱密码登录，但不影响直接点 LinuxDo OAuth 入口。
  return Boolean(pageState?.hasLinuxDoLoginEntry);
}

function shouldAutoLoginFromOfficialPageState(pageState) {
  const canBypassSecurityCheck = canBypassOfficialPageSecurityCheck(pageState);
  return Boolean(pageState?.looksUnauthenticated) &&
    pageState?.hasLinuxDoLoginEntry &&
    !pageState?.hasCheckInButton &&
    !pageState?.checkedInStateText &&
    (!pageState?.hasSecurityCheck || canBypassSecurityCheck);
}

function decorateOfficialPageAuthState(site, pageState) {
  if (!pageState) {
    return null;
  }
  return {
    ...pageState,
    looksUnauthenticated: Boolean(
      pageState.hasUnauthText ||
      pageState.isTargetLoginPage ||
      isTargetDomainLoginPage(pageState.url, site?.cookieDomain)
    )
  };
}

function matchOfficialPageLoginFlow(site, pageState) {
  if (!site?.cookieDomain || !pageState) {
    return null;
  }

  const enrichedState = decorateOfficialPageAuthState(site, pageState);
  const flowMatchers = [
    {
      id: 'official-login-page',
      label: '站点登录页直登',
      entryMode: 'login-page',
      matches: () => enrichedState.isTargetLoginPage &&
        enrichedState.hasLinuxDoLoginEntry &&
        (!enrichedState.hasSecurityCheck || canBypassOfficialPageSecurityCheck(enrichedState))
    },
    {
      id: 'official-current-page-entry',
      label: '当前页 LinuxDO 登录入口',
      entryMode: 'current-page',
      matches: () => shouldAutoLoginFromOfficialPageState(enrichedState)
    }
  ];

  const matched = flowMatchers.find((flow) => flow.matches());
  if (!matched) {
    return null;
  }

  return {
    ...matched,
    pageState: enrichedState,
    loginUrl: enrichedState.url || getOfficialPageLoginUrl(site),
    postLoginUrl: getOfficialPagePostLoginUrl(site),
    requiresAgreement: Boolean(
      enrichedState.hasAgreementCheckbox &&
      enrichedState.disabledLinuxDoLoginEntryCount > 0
    )
  };
}

function isOfficialPageOAuthPendingUrl(url, domain) {
  try {
    const parsed = new URL(url || '');
    if (domain && parsed.hostname !== domain) {
      return false;
    }
    return /^\/oauth(?:\/|$)/i.test(parsed.pathname) ||
      (/\/oauth\//i.test(parsed.pathname) && parsed.searchParams.has('code')) ||
      isNewApiOAuthCallbackUrl(parsed.toString());
  } catch (e) {
    return false;
  }
}

function hasOfficialPageAuthenticatedEvidence(pageState, session, url = '') {
  // OAuth 回调页即使带 code，也还没完成会话建立
  if (isOfficialPageOAuthPendingUrl(url) || isNewApiOAuthCallbackUrl(url)) {
    return false;
  }
  // 以 /api/user/self 实探为准；仅有本地残留 token/user 不够
  if (session?.userAuthenticated) {
    return true;
  }
  if (pageState?.hasLogoutEntry || pageState?.hasCheckInButton || pageState?.checkedInStateText) {
    return true;
  }
  try {
    const parsed = new URL(url || '');
    if (/^\/oauth(?:\/|$)/i.test(parsed.pathname)) {
      return false;
    }
    if (/^\/(?:dashboard|profile|console|user|wallet|check-?in)(?:\/|$)/i.test(parsed.pathname) &&
      !pageState?.looksUnauthenticated &&
      !pageState?.isTargetLoginPage &&
      !pageState?.hasLinuxDoLoginEntry) {
      return true;
    }
  } catch (e) {}
  return false;
}

async function waitForOfficialPageLoginSettled(site, tabId, timeout = 15000) {
  const startedAt = Date.now();
  let lastState = null;
  let lastUrl = '';
  let oauthPendingSince = 0;
  let manualCallbackAttempted = false;

  while (Date.now() - startedAt < timeout) {
    let tabInfo;
    try {
      tabInfo = await chrome.tabs.get(tabId);
    } catch (e) {
      return { settled: false, pageState: lastState, url: lastUrl };
    }

    const currentUrl = tabInfo.url || tabInfo.pendingUrl || '';
    lastUrl = currentUrl || lastUrl;
    if (!currentUrl) {
      await sleep(500);
      continue;
    }

    if (isOfficialPageOAuthPendingUrl(currentUrl, site?.cookieDomain)) {
      if (!oauthPendingSince) {
        oauthPendingSince = Date.now();
      }
      if (!manualCallbackAttempted && Date.now() - oauthPendingSince >= 2500) {
        manualCallbackAttempted = true;
        await appendCheckInLog(site?.siteName || '系统', '登录中', '检测到 OAuth 回调页停留，尝试手动完成回调');
        const callbackResult = await processNewApiOAuthCallback(tabId, '页面签到登录');
        const callbackAccepted = Boolean(
          callbackResult?.success &&
          (
            callbackResult?.hasUser ||
            callbackResult?.accessToken ||
            callbackResult?.apiResponse?.success ||
            callbackResult?.wroteStorage
          )
        );
        if (callbackAccepted) {
          const postLoginUrl = getOfficialPagePostLoginUrl(site);
          await appendCheckInLog(site?.siteName || '系统', '登录中', '手动 OAuth 回调已触发，尝试进入登录后页面');
          try {
            await chrome.tabs.update(tabId, { url: postLoginUrl, active: false });
            await ensureTabPageReady(tabId, postLoginUrl, 15000);
          } catch (e) {
            console.warn(`[页面签到登录] ${site?.siteName || ''} 手动回调后跳转登录后页面失败:`, e);
          }
        } else {
          await appendCheckInLog(site?.siteName || '系统', '登录中', '手动 OAuth 回调未确认成功，继续等待站点回调');
        }
      }
      await sleep(800);
      continue;
    }
    oauthPendingSince = 0;

    const pageState = decorateOfficialPageAuthState(
      site,
      await inspectOfficialPageAuthState(tabId, site?.unauthKeywords, site?.cookieDomain)
    );
    lastState = pageState;
    let session = null;
    try {
      session = await inspectNewApiBrowserSession(tabId);
    } catch (e) {}

    if (!pageState) {
      await sleep(500);
      continue;
    }

    if (!pageState.isTargetLoginPage &&
      !pageState.hasUnauthText &&
      hasOfficialPageAuthenticatedEvidence(pageState, session, currentUrl)) {
      return { settled: true, pageState, url: currentUrl };
    }

    await sleep(800);
  }

  return { settled: false, pageState: lastState, url: lastUrl };
}

function formatOfficialPageLoginFlow(flow) {
  if (!flow) return '未知登录流';
  return flow.requiresAgreement
    ? `${flow.label}（需先勾选协议）`
    : flow.label;
}

async function executeOfficialPageLoginFlow(site, flow, tabId) {
  if (!site?.cookieDomain || !flow || !tabId) {
    return null;
  }

  if (flow.entryMode === 'login-page') {
    return startSiteLinuxDoOAuthFromLoginPage(
      tabId,
      site.cookieDomain,
      flow.postLoginUrl,
      '页面签到登录',
      flow.loginUrl
    );
  }

  if (flow.entryMode === 'current-page') {
    return startSiteLinuxDoOAuthFromCurrentPage(
      tabId,
      site.cookieDomain,
      flow.postLoginUrl,
      '页面签到登录'
    );
  }

  return null;
}

async function tryDirectNewApiOfficialLogin(site, tabSession = null) {
  if (site?.type !== 'newapi' || !site?.cookieDomain) {
    return null;
  }

  const oauthResult = await autoOAuthLogin(
    site.cookieDomain,
    site.visitUrl,
    tabSession,
    {
      disableSiteLoginFallback: true,
      logLabel: '页面签到登录直连 OAuth'
    }
  );

  // 直连 OAuth 成功需同时具备可用 tab；headers 有则更好，没有也可靠页面 cookie/refresh 继续
  if (!oauthResult?.tabId) {
    return null;
  }

  if (!oauthResult?.headers) {
    // 再探一次页面会话，避免“有 tab 无头”的假成功
    try {
      const session = await inspectNewApiBrowserSession(oauthResult.tabId);
      if (!hasNewApiUserSession(session)) {
        return null;
      }
    } catch (e) {
      return null;
    }
  }

  return {
    tabId: oauthResult.tabId,
    skipSettle: true,
    label: 'NewAPI 直连 OAuth'
  };
}

async function ensureOfficialPageLoginBeforeCheckIn(site, tab, tabSession = null) {
  if (!tab?.id) {
    return tab;
  }
  if (site.type === 'sota-agent') {
    return tab;
  }

  let pageState = await inspectOfficialPageAuthState(tab.id, site.unauthKeywords, site.cookieDomain);
  const loginFlow = matchOfficialPageLoginFlow(site, pageState);
  if (!loginFlow) {
    return tab;
  }

  const postLoginUrl = loginFlow.postLoginUrl;
  const flowLabel = formatOfficialPageLoginFlow(loginFlow);
  await appendCheckInLog(site.siteName, '待登录', `匹配登录流：${flowLabel}`);
  if (loginFlow.requiresAgreement) {
    await appendCheckInLog(site.siteName, '待登录', '检测到协议勾选要求，准备自动勾选后继续登录');
  }

  const ldCookies = await chrome.cookies.getAll({ domain: 'linux.do' });
  if (!ldCookies.length) {
    console.warn(`[页面签到登录] ${site.siteName} 已匹配 ${flowLabel}，但 linux.do 未登录，跳过自动登录`);
    await appendCheckInLog(site.siteName, '未登录', `已匹配 ${flowLabel}，但浏览器未登录 linux.do`);
    return tab;
  }

  let loginResult = null;
  if (site.type === 'newapi') {
    await appendCheckInLog(site.siteName, '登录中', '站点识别为 NewAPI，优先尝试直连 OAuth 登录');
    loginResult = await tryDirectNewApiOfficialLogin(site, tabSession);
    if (loginResult?.tabId) {
      console.log(`[页面签到登录] ${site.siteName} 已通过 ${loginResult.label} 完成授权`);
      await appendCheckInLog(site.siteName, '登录中', `${loginResult.label} 已完成，准备返回登录后页面`);
    } else {
      await appendCheckInLog(site.siteName, '登录中', '直连 OAuth 未完成，回退站点页面登录入口');
    }
  }

  if (!loginResult?.tabId) {
    console.log(`[页面签到登录] ${site.siteName} 匹配登录流: ${flowLabel}`);
    await appendCheckInLog(site.siteName, '登录中', `开始执行登录流：${flowLabel}`);
    loginResult = await executeOfficialPageLoginFlow(site, loginFlow, tab.id);
  }

  if (!loginResult?.tabId) {
    console.warn(`[页面签到登录] ${site.siteName} 登录流未完成: ${flowLabel}`);
    await appendCheckInLog(site.siteName, '登录失败', `登录流未完成：${flowLabel}`);
    return tab;
  }

  if (!loginResult.skipSettle) {
    await appendCheckInLog(site.siteName, '登录中', '等待站点完成 OAuth 回调并建立登录态');
    const settledLogin = await waitForOfficialPageLoginSettled(site, loginResult.tabId, 20000);
    if (!settledLogin.settled) {
      console.warn(`[页面签到登录] ${site.siteName} OAuth 回调完成超时: ${settledLogin.url || 'unknown'}`);
      await appendCheckInLog(site.siteName, '登录失败', 'OAuth 回调完成超时，未等到已登录页面');
      return tab;
    }
  }

  try {
    if (!tabSession?.owns(loginResult.tabId)) {
      await chrome.tabs.update(loginResult.tabId, { active: false }).catch(() => {});
    }

    await chrome.tabs.update(loginResult.tabId, { url: postLoginUrl, active: false });
    await ensureTabPageReady(loginResult.tabId, postLoginUrl, 20000);
    await sleep(1500);
  } catch (e) {
    console.warn(`[页面签到登录] ${site.siteName} 登录后返回签到页失败:`, e);
  }

  pageState = await inspectOfficialPageAuthState(loginResult.tabId, site.unauthKeywords, site.cookieDomain);
  const postLoginState = decorateOfficialPageAuthState(site, pageState);
  const loginCompleted = Boolean(loginResult.skipSettle) || Boolean(
    postLoginState && !shouldAutoLoginFromOfficialPageState(postLoginState)
  );
  if (!loginCompleted) {
    console.warn(`[页面签到登录] ${site.siteName} 登录后仍检测到登录入口`);
    await appendCheckInLog(site.siteName, '登录失败', `登录后仍停留在登录态页面：${flowLabel}`);
  } else {
    console.log(`[页面签到登录] ${site.siteName} 自动登录完成`);
    await appendCheckInLog(site.siteName, '登录成功', `登录流完成：${flowLabel}，返回签到页继续执行`);
  }

  try {
    const nextTab = await ensureOfficialPageTabAlive(
      site,
      { id: loginResult.tabId, _autoCreated: tab?._autoCreated },
      tabSession,
      postLoginUrl
    );
    nextTab._autoCreated = tab?._autoCreated || nextTab._autoCreated;
    nextTab._officialLoginCompleted = loginCompleted;
    return nextTab;
  } catch (e) {
    console.warn(`[页面签到登录] ${site.siteName} 登录后标签页已失效:`, e);
    return tab;
  }
}

function getOfficialPagePostLoginUrl(site) {
  if (!site?.visitUrl || !site?.cookieDomain) {
    return site?.visitUrl || '';
  }

  try {
    const parsed = new URL(site.visitUrl);
    if (!isTargetDomainLoginPage(site.visitUrl, site.cookieDomain)) {
      return site.visitUrl;
    }
    const hashRoute = String(parsed.hash || '')
      .replace(/^#!?/, '')
      .trim();
    const useHashRoute = /^\/(?:login|sign-?in)(?:\/|$|\?)/i.test(hashRoute);

    const directRedirect = parsed.searchParams.get('redirect');
    if (directRedirect && directRedirect.startsWith('/')) {
      return buildOfficialPageRedirectUrl(site.cookieDomain, directRedirect, { useHashRoute });
    }

    const hash = String(parsed.hash || '');
    const hashQuery = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '';
    const hashParams = new URLSearchParams(hashQuery);
    const hashRedirect = hashParams.get('redirect');
    if (hashRedirect && hashRedirect.startsWith('/')) {
      return buildOfficialPageRedirectUrl(site.cookieDomain, hashRedirect, { useHashRoute });
    }
  } catch (e) {}

  return site.visitUrl;
}

function buildOfficialPageRedirectUrl(domain, redirectPath, { useHashRoute = false } = {}) {
  const normalizedPath = String(redirectPath || '').trim();
  if (!normalizedPath.startsWith('/')) {
    return `https://${domain}/`;
  }
  return useHashRoute
    ? `https://${domain}/#${normalizedPath}`
    : `https://${domain}${normalizedPath}`;
}

async function inspectOfficialPageAuthState(tabId, unauthKeywords = [], domain = '') {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (keywords, targetDomain) => {
        const linuxDoEntryPattern = /linux\s*\.?\s*do|linuxdo|linux\s*do|使用.*linux|linux.*登录|登录.*linux/i;
        const loginRoutePattern = /^\/(?:login|sign-?in)(?:\/|$|\?)/i;
        const checkInPattern = /Check in now|Checked in|check.?in|checkin|daily check.?in|Daily Check-in|daily reward|claim reward|领取奖励|领取额度|每日领取|签到领取|每日福利|今日福利|立即签到|现在签到|每日签到|^签$|^签到$|^领取$/i;
        const alreadyPattern = /^(Checked in|Already checked|Already signed|已签到|已签|已签过|今日已签|今日已签到|今天已签|今天已签到|已经签到)$/i;
        const logoutPattern = /退出登录|退出账号|注销登录|登出|log\s*out|logout|sign\s*out|\bquit\b/i;
        const agreementPattern = /同意|协议|条款|政策|服务条款|使用政策|隐私|agree|terms|policy|consent/i;
        const bodyText = document.body?.innerText || '';
        const normalizedText = bodyText.replace(/\s+/g, ' ').trim();
        const visibleSelector = [
          'a[href]',
          'button',
          '[role="button"]',
          'input[type="button"]',
          'input[type="submit"]',
          '[onclick]',
          '[class*="cursor-pointer"]',
          '[tabindex]:not([tabindex="-1"])'
        ].join(', ');

        function isVisible(el) {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            rect.width > 0 &&
            rect.height > 0;
        }

        function isDisabled(el) {
          return el.disabled ||
            el.getAttribute('aria-disabled') === 'true' ||
            el.closest('[disabled], [aria-disabled="true"]');
        }

        function collectText(el) {
          return [
            el.textContent,
            el.value,
            el.getAttribute('aria-label'),
            el.getAttribute('title'),
            el.getAttribute('href')
          ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
        }

        const visibleCandidates = Array.from(document.querySelectorAll(visibleSelector))
          .filter((el) => isVisible(el));
        const linuxDoCandidates = visibleCandidates
          .map((el) => ({
            text: collectText(el),
            disabled: isDisabled(el)
          }))
          .filter((item) => item.text && linuxDoEntryPattern.test(item.text));
        const enabledCandidateTexts = visibleCandidates
          .filter((el) => !isDisabled(el))
          .map(collectText)
          .filter(Boolean);
        const hashRoute = String(location.hash || '')
          .replace(/^#!?/, '')
          .trim();
        const isTargetLoginPage = Boolean(
          targetDomain &&
          location.hostname === targetDomain &&
          (
            loginRoutePattern.test(location.pathname) ||
            loginRoutePattern.test(hashRoute)
          )
        );
        const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'))
          .filter((checkbox) => isVisible(checkbox) && !checkbox.disabled);
        const hasAgreementCheckbox = checkboxes.some((checkbox) => {
          if (checkbox.checked) return false;
          const label = checkbox.closest('label') ||
            document.querySelector(`label[for="${CSS.escape(checkbox.id || '')}"]`) ||
            checkbox.parentElement;
          const text = collectText(label || checkbox);
          return agreementPattern.test(text) || checkboxes.length === 1;
        });

        const hasLinuxDoLoginEntry = linuxDoCandidates.length > 0;
        const hasLogoutEntry = enabledCandidateTexts.some((text) => logoutPattern.test(text));
        const hasCheckInButton = enabledCandidateTexts.some((text) => {
          return checkInPattern.test(text) && !alreadyPattern.test(text);
        });
        const checkedInStateText = enabledCandidateTexts.find(text => alreadyPattern.test(text)) || '';
        const hasSecurityCheck = /Security Check|安全验证|人机验证|Turnstile|captcha|验证码|请完成验证|verify you are human/i.test(bodyText) ||
          Boolean(document.querySelector([
            'iframe[src*="challenges.cloudflare.com"]',
            'iframe[src*="turnstile"]',
            'iframe[src*="google.com/recaptcha"]',
            'iframe[src*="recaptcha.net/recaptcha"]',
            'iframe[src*="hcaptcha.com"]',
            '.cf-turnstile',
            '.g-recaptcha',
            '.h-captcha',
            '[data-sitekey]'
          ].join(', ')));
        const hasUnauthText = Array.isArray(keywords) && keywords.some((keyword) => {
          const normalizedKeyword = String(keyword || '').trim();
          return normalizedKeyword && normalizedText.includes(normalizedKeyword);
        });

        return {
          url: location.href,
          isTargetLoginPage,
          hasLinuxDoLoginEntry,
          hasLogoutEntry,
          enabledLinuxDoLoginEntryCount: linuxDoCandidates.filter((item) => !item.disabled).length,
          disabledLinuxDoLoginEntryCount: linuxDoCandidates.filter((item) => item.disabled).length,
          hasCheckInButton,
          checkedInStateText,
          hasSecurityCheck,
          hasUnauthText,
          hasAgreementCheckbox
        };
      },
      args: [Array.isArray(unauthKeywords) ? unauthKeywords : [], domain]
    });
    return results[0]?.result || null;
  } catch (e) {
    console.warn('[页面签到登录] 检查页面登录态失败:', e);
    return null;
  }
}

function shouldRefreshOfficialPageBeforeBalance(pageResult = {}) {
  return Boolean(pageResult.clickedText || pageResult.data?.clickedText);
}

async function refreshTabBeforeReadingBalance(tabId, site) {
  if (!tabId) return;
  try {
    console.log(`${site.siteName} 兜底签到后刷新页面以读取最新余额`);
    await chrome.tabs.reload(tabId);
    await ensureTabPageReady(tabId, site.visitUrl, 20000);
    await sleep(1000);
  } catch (e) {
    console.warn(`${site.siteName} 兜底签到后刷新页面失败，继续尝试读取余额:`, e);
  }
}

async function autoZenApiOAuthLogin(domain, tabId = null) {
  console.log(`[ZenAPI OAuth] 开始登录: ${domain}`);

  const ldCookies = await chrome.cookies.getAll({ domain: 'linux.do' });
  if (ldCookies.length === 0) {
    console.warn('[ZenAPI OAuth] linux.do 未登录');
    return null;
  }

  let tab;
  const ownsTab = !tabId;
  try {
    tab = tabId ? await chrome.tabs.get(tabId) : await createTemporaryBackgroundTab(`https://${domain}/login`);
    await chrome.tabs.update(tab.id, { url: buildZenApiLoginUrl(domain) });
    await ensureTabPageReady(tab.id, buildZenApiLoginUrl(domain), 20000);
    await sleep(1000);

    let tabInfo = await chrome.tabs.get(tab.id);
    console.log(`[ZenAPI OAuth] 当前页面: ${tabInfo.url}`);

    if (isTargetDomainLoginPage(tabInfo.url, domain)) {
      const clickResult = await clickSiteLinuxDoLoginButton(tab.id, 'ZenAPI OAuth');
      if (clickResult?.clicked) {
        await sleep(1000);
        await waitForTabUrlChange(tab.id, tabInfo.url, 10000);
        await waitForTabComplete(tab.id, 20000);
        await waitForUsableTabPage(tab.id, 20000);
        tabInfo = await chrome.tabs.get(tab.id);
        console.log(`[ZenAPI OAuth] 点击站点登录入口后页面: ${tabInfo.url}`);
      }
    }

    if (tabInfo.url && tabInfo.url.includes('connect.linux.do')) {
      await clickLinuxDoAuthorizeButton(tab.id);
      const redirected = await waitForTabUrlMatch(tab.id, domain, 30000);
      if (!redirected) {
        console.warn('[ZenAPI OAuth] 等待回跳 ZenAPI 超时');
        if (ownsTab) await closeTabQuietly(tab.id);
        return null;
      }
      await ensureTabPageReady(tab.id, `https://${domain}/user`, 20000);
      await sleep(1000);
      tabInfo = await chrome.tabs.get(tab.id);
    }

    const callbackToken = extractZenApiLinuxDoToken(tabInfo.url || '');
    if (callbackToken) {
      console.log('[ZenAPI OAuth] 从回调 URL 读取到 linuxdo_token');
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (token) => {
          localStorage.setItem('user_token', token);
          history.replaceState(null, '', '/user');
        },
        args: [callbackToken]
      });
    }

    await sleep(1000);
    const headers = await readStorageTokenAuthHeadersFromTab(tab.id, ['user_token'], null, 'ZenAPI');
    if (!hasAuthorizationHeader(headers) && callbackToken) {
      const fallbackHeaders = mergeZenApiTokenHeader({}, callbackToken);
      fallbackHeaders._tabId = tab.id;
      return { headers: fallbackHeaders, tabId: tab.id };
    }

    if (!hasAuthorizationHeader(headers)) {
      console.warn('[ZenAPI OAuth] 未能读取 user_token');
      if (ownsTab) await closeTabQuietly(tab.id);
      return null;
    }

    return { headers, tabId: tab.id };
  } catch (e) {
    console.warn('[ZenAPI OAuth] 登录失败:', e);
    if (ownsTab) await closeTabQuietly(tab?.id);
    return null;
  }
}

function isTargetDomainLoginPage(url, domain) {
  return isNewApiTargetLoginPage(url, domain);
}

async function autoInfiniteCanvasOAuthLogin(domain, tabId = null, visitUrl = null) {
  console.log(`[Infinite Canvas OAuth] 开始登录: ${domain}`);

  const ldCookies = await chrome.cookies.getAll({ domain: 'linux.do' });
  if (ldCookies.length === 0) {
    console.warn('[Infinite Canvas OAuth] linux.do 未登录');
    return null;
  }

  let tab;
  const ownsTab = !tabId;
  const startUrl = buildInfiniteCanvasLinuxDoOAuthStartUrl(domain, visitUrl);
  try {
    tab = tabId ? await chrome.tabs.get(tabId) : await createTemporaryBackgroundTab(startUrl);
    console.log(`[Infinite Canvas OAuth] 打开 OAuth start 入口: ${startUrl}`);
    await chrome.tabs.update(tab.id, { url: startUrl, active: false });

    await waitForTabComplete(tab.id, 20000);
    await waitForUsableTabPage(tab.id, 20000);
    let tabInfo = await chrome.tabs.get(tab.id);
    console.log(`[Infinite Canvas OAuth] OAuth start 后页面: ${tabInfo.url}`);

    if (tabInfo.url && tabInfo.url.includes('connect.linux.do')) {
      await clickLinuxDoAuthorizeButton(tab.id);
      const redirected = await waitForTabUrlMatch(tab.id, domain, 30000);
      if (!redirected) {
        console.warn('[Infinite Canvas OAuth] 等待回跳目标站点超时');
        if (ownsTab) await closeTabQuietly(tab.id);
        return null;
      }
      await waitForTabComplete(tab.id, 20000);
      await waitForUsableTabPage(tab.id, 20000);
      await sleep(1000);
      tabInfo = await chrome.tabs.get(tab.id);
    }

    for (let retry = 0; retry < 10; retry++) {
      const headers = await readInfiniteCanvasAuthHeadersFromTab(tab.id, null);
      if (hasAuthorizationHeader(headers)) {
        console.log('[Infinite Canvas OAuth] 已读取登录令牌');
        return { headers, tabId: tab.id };
      }
      await sleep(1000);
    }

    console.warn('[Infinite Canvas OAuth] 未能读取登录令牌');
    if (ownsTab) await closeTabQuietly(tab.id);
    return null;
  } catch (e) {
    console.warn('[Infinite Canvas OAuth] 登录失败:', e);
    if (ownsTab) await closeTabQuietly(tab?.id);
    return null;
  }
}

function buildInfiniteCanvasLinuxDoOAuthStartUrl(domain, visitUrl = null) {
  const redirect = getInfiniteCanvasOAuthRedirect(visitUrl);
  const params = new URLSearchParams({ redirect });
  return `https://${domain}/api/auth/linux-do/authorize?${params.toString()}`;
}

function getInfiniteCanvasOAuthRedirect(currentUrl = '') {
  try {
    const parsed = new URL(currentUrl || '');
    const redirect = parsed.searchParams.get('redirect');
    if (redirect && redirect.startsWith('/')) return redirect;

    if (parsed.pathname && !/^\/login(?:\/|$)/i.test(parsed.pathname)) {
      return `${parsed.pathname}${parsed.search || ''}${parsed.hash || ''}` || '/check-in';
    }

    return '/check-in';
  } catch (e) {
    return '/check-in';
  }
}

function hasSub2ApiUsableAuth(headers) {
  return hasAuthorizationHeader(headers) || Boolean(headers?._sub2ApiSessionAuth && headers?._tabId);
}

async function autoSub2ApiOAuthLogin(domain, tabId = null, visitUrl = null) {
  console.log(`[Sub2API OAuth] 开始登录: ${domain}`);

  const ldCookies = await chrome.cookies.getAll({ domain: 'linux.do' });
  if (ldCookies.length === 0) {
    console.warn('[Sub2API OAuth] linux.do 未登录');
    return null;
  }

  let tab;
  const ownsTab = !tabId;
  const startUrl = buildSub2ApiLinuxDoOAuthStartUrl(domain, visitUrl);
  try {
    tab = tabId ? await chrome.tabs.get(tabId) : await createTemporaryBackgroundTab(startUrl);
    console.log(`[Sub2API OAuth] 打开 OAuth start 入口: ${startUrl}`);
    await chrome.tabs.update(tab.id, { url: startUrl, active: false });

    await waitForTabComplete(tab.id, 20000);
    await waitForUsableTabPage(tab.id, 20000);
    let tabInfo = await chrome.tabs.get(tab.id);
    console.log(`[Sub2API OAuth] OAuth start 后页面: ${tabInfo.url}`);

    if (tabInfo.url && tabInfo.url.includes('connect.linux.do')) {
      await clickLinuxDoAuthorizeButton(tab.id);
      const redirected = await waitForTabUrlMatch(tab.id, domain, 30000);
      if (!redirected) {
        console.warn('[Sub2API OAuth] 等待回跳 Sub2API 超时');
        if (ownsTab) await closeTabQuietly(tab.id);
        return null;
      }
      await ensureTabPageReady(tab.id, `https://${domain}/`, 20000);
      await sleep(1000);
      tabInfo = await chrome.tabs.get(tab.id);
    }

    for (let retry = 0; retry < 10; retry++) {
      const headers = await readSub2ApiAuthHeadersFromTab(tab.id, null);
      if (hasAuthorizationHeader(headers)) {
        console.log('[Sub2API OAuth] 已读取 Sub2API 登录令牌');
        return { headers, tabId: tab.id };
      }
      await sleep(1000);
    }

    tabInfo = await chrome.tabs.get(tab.id);
    if (tabInfo.url?.includes(domain) && !isTargetDomainLoginPage(tabInfo.url, domain)) {
      console.log('[Sub2API OAuth] 未读取到 auth_token，改用当前标签页 session 签到');
      return { headers: { _tabId: tab.id, _sub2ApiSessionAuth: true }, tabId: tab.id };
    }

    console.warn('[Sub2API OAuth] 未能读取 auth_token');
    if (ownsTab) await closeTabQuietly(tab.id);
    return null;
  } catch (e) {
    console.warn('[Sub2API OAuth] 登录失败:', e);
    if (ownsTab) await closeTabQuietly(tab?.id);
    return null;
  }
}

function buildSub2ApiLinuxDoOAuthStartUrl(domain, visitUrl = null) {
  const redirect = getSub2ApiOAuthRedirect(visitUrl);
  const params = new URLSearchParams({ redirect });
  return `https://${domain}/api/v1/auth/oauth/linuxdo/start?${params.toString()}`;
}

function getSub2ApiOAuthRedirect(currentUrl = '') {
  try {
    const parsed = new URL(currentUrl || '');
    const redirect = parsed.searchParams.get('redirect');
    if (redirect && redirect.startsWith('/')) return redirect;

    if (parsed.pathname && !/^\/login(?:\/|$)/i.test(parsed.pathname)) {
      return `${parsed.pathname}${parsed.search || ''}${parsed.hash || ''}` || '/check-in';
    }

    return '/check-in';
  } catch (e) {
    return '/check-in';
  }
}

async function clickSiteLinuxDoLoginButton(tabId, logLabel = 'OAuth') {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async () => {
        const loginPattern = /linux\s*\.?\s*do|linuxdo|linux\s*do|使用.*linux|linux.*登录|登录.*linux/i;
        const selectors = [
          'a[href]',
          'button',
          '[role="button"]',
          'input[type="button"]',
          'input[type="submit"]',
          '[onclick]',
          '[class*="cursor-pointer"]'
        ];

        function isVisible(el) {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            rect.width > 0 &&
            rect.height > 0;
        }

        function collectText(el) {
          const attrs = [];
          for (const attr of Array.from(el.attributes || [])) {
            if (/^(class|id|name|data-|href|title|aria-label)/i.test(attr.name)) {
              attrs.push(`${attr.name}=${attr.value}`);
            }
          }
          return [
            el.textContent,
            el.value,
            el.getAttribute('aria-label'),
            el.getAttribute('title'),
            el.getAttribute('href'),
            ...attrs
          ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
        }

        const agreementPattern = /同意|协议|条款|政策|服务条款|使用政策|agree|terms|policy/i;
        let checkedAgreementCount = 0;
        const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
        for (const checkbox of checkboxes) {
          if (checkbox.checked || checkbox.disabled || !isVisible(checkbox)) continue;
          const label = checkbox.closest('label') ||
            document.querySelector(`label[for="${CSS.escape(checkbox.id || '')}"]`) ||
            checkbox.parentElement;
          const text = collectText(label || checkbox);
          if (agreementPattern.test(text) || checkboxes.length === 1) {
            checkbox.click();
            checkbox.dispatchEvent(new Event('input', { bubbles: true }));
            checkbox.dispatchEvent(new Event('change', { bubbles: true }));
            if (!checkbox.checked && label && label !== checkbox) {
              label.click();
            }
            checkedAgreementCount += 1;
          }
        }

        if (checkedAgreementCount > 0) {
          await new Promise(resolve => setTimeout(resolve, 350));
        }

        const originalOpen = typeof window.open === 'function' ? window.open.bind(window) : null;
        const popupUrls = [];
        let sameTabNavigateUrl = '';
        const popupStub = {
          closed: false,
          focus() {},
          blur() {},
          close() {
            this.closed = true;
          },
          postMessage() {},
          location: {
            set href(value) {
              const next = String(value || '').trim();
              if (next) sameTabNavigateUrl = next;
            },
            replace(value) {
              const next = String(value || '').trim();
              if (next) sameTabNavigateUrl = next;
            },
            assign(value) {
              const next = String(value || '').trim();
              if (next) sameTabNavigateUrl = next;
            }
          }
        };

        function normalizeOpenTarget(target) {
          const value = String(target || '').trim().toLowerCase();
          return !value || value === '_self' || value === '_top' || value === '_parent';
        }

        if (originalOpen) {
          window.open = (...args) => {
            const popupUrl = String(args?.[0] || '').trim();
            const target = args?.[1];
            if (!popupUrl) return popupStub;
            // NewAPI rc.22 常见 window.open(url, "_self")：应同页跳转，不能当弹窗 stub 掉
            if (normalizeOpenTarget(target)) {
              sameTabNavigateUrl = popupUrl;
              try {
                location.assign(popupUrl);
              } catch (e) {
                try { location.href = popupUrl; } catch (err) {}
              }
              return window;
            }
            popupUrls.push(popupUrl);
            // 真正的弹窗：不在页面上下文打开，改由扩展外层接管
            return popupStub;
          };
        }

        const candidates = Array.from(document.querySelectorAll(selectors.join(',')));
        try {
          for (const el of candidates) {
            if (!isVisible(el)) continue;
            if (el.disabled ||
              el.getAttribute('aria-disabled') === 'true' ||
              el.closest('[disabled], [aria-disabled="true"]')) {
              continue;
            }
            const text = collectText(el);

            if (loginPattern.test(text)) {
              const beforeUrl = location.href;
              el.click();
              // NewAPI 站点会先异步获取 OAuth state，再调用 window.open；保留拦截直到授权地址出现。
              const captureDeadline = Date.now() + 5000;
              while (!popupUrls.length && !sameTabNavigateUrl && Date.now() < captureDeadline) {
                await new Promise(resolve => setTimeout(resolve, 100));
              }
              const navigatedUrl = sameTabNavigateUrl ||
                (location.href !== beforeUrl ? location.href : '');
              return {
                clicked: true,
                text: text.slice(0, 100),
                checkedAgreementCount,
                popupUrl: popupUrls[0] || '',
                sameTabUrl: navigatedUrl || '',
                stayedOnSamePage: !navigatedUrl && location.href === beforeUrl
              };
            }
          }
        } finally {
          if (originalOpen) {
            window.open = originalOpen;
          }
        }

        return {
          clicked: false,
          text: 'no linux.do login entry found',
          checkedAgreementCount,
          popupUrl: popupUrls[0] || '',
          sameTabUrl: sameTabNavigateUrl || ''
        };
      }
    });
    const result = results[0]?.result;
    console.log(`[${logLabel}] 站点登录页点击结果:`, result);
    return result || { clicked: false };
  } catch (e) {
    console.warn(`[${logLabel}] 点击站点 Linux.do 登录入口失败:`, e);
    return { clicked: false, error: e.message };
  }
}

async function getOpenTabIds() {
  try {
    const tabs = await chrome.tabs.query({});
    return new Set(tabs.map(tab => tab.id).filter(Boolean));
  } catch (e) {
    return new Set();
  }
}

async function waitForNewLinuxDoTab(knownTabIds, timeout = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    try {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find(candidate => {
        const url = candidate.url || candidate.pendingUrl || '';
        return candidate.id &&
          !knownTabIds.has(candidate.id) &&
          url.includes('connect.linux.do');
      });
      if (tab?.id) return tab;
    } catch (e) {
      return null;
    }
    await sleep(500);
  }
  return null;
}

async function startSiteLinuxDoOAuthFromLoginPage(tabId, domain, readyUrl, logLabel = 'OAuth', loginUrl = `https://${domain}/login`) {
  const knownTabIds = await getOpenTabIds();
  const startedAt = Date.now();
  let activeTabId = tabId;
  let lastUrl = '';

  while (Date.now() - startedAt < 20000) {
    let tabInfo;
    try {
      tabInfo = await chrome.tabs.get(activeTabId);
      lastUrl = tabInfo.url || lastUrl;
    } catch (e) {
      return null;
    }

    if (lastUrl.includes('connect.linux.do')) {
      await clickLinuxDoAuthorizeButton(activeTabId);
      const redirected = await waitForTabUrlMatch(activeTabId, domain, 30000);
      if (!redirected) {
        console.warn(`[${logLabel}] 等待回跳目标站点超时`);
        return null;
      }
      await ensureTabPageReady(activeTabId, readyUrl || `https://${domain}/`, 20000);
      await sleep(1000);
      return { tabId: activeTabId };
    }

    if (lastUrl.includes(domain) && !isTargetDomainLoginPage(lastUrl, domain)) {
      return { tabId: activeTabId };
    }

    if (!isTargetDomainLoginPage(lastUrl, domain)) {
      await chrome.tabs.update(activeTabId, { url: loginUrl, active: false });
      await ensureTabPageReady(activeTabId, loginUrl, 20000);
      await sleep(1000);
      continue;
    }

    const clickResult = await clickSiteLinuxDoLoginButton(activeTabId, logLabel);
    if (!clickResult?.clicked) {
      await sleep(500);
      continue;
    }

    await sleep(1000);
    const newLinuxDoTab = await waitForNewLinuxDoTab(knownTabIds, 3000);
    if (newLinuxDoTab?.id) {
      if (newLinuxDoTab.active) {
        await chrome.tabs.update(newLinuxDoTab.id, { active: false }).catch(() => {});
      }
      activeTabId = newLinuxDoTab.id;
      continue;
    }

    // 同页跳转（window.open(url,"_self") / location.assign）：继续等当前 tab
    if (clickResult?.sameTabUrl) {
      console.log(`[${logLabel}] 站点同页跳转授权: ${clickResult.sameTabUrl}`);
      if (clickResult.sameTabUrl.includes('connect.linux.do') ||
        clickResult.sameTabUrl.includes(domain)) {
        try {
          const current = await chrome.tabs.get(activeTabId);
          const currentUrl = current.url || current.pendingUrl || '';
          if (currentUrl !== clickResult.sameTabUrl &&
            !currentUrl.includes('connect.linux.do') &&
            !isOfficialPageOAuthPendingUrl(currentUrl, domain)) {
            await chrome.tabs.update(activeTabId, { url: clickResult.sameTabUrl, active: false });
          }
        } catch (e) {}
      }
      await waitForTabComplete(activeTabId, 20000);
      await waitForUsableTabPage(activeTabId, 20000);
      continue;
    }

    if (clickResult?.popupUrl && clickResult.popupUrl.includes('connect.linux.do')) {
      console.log(`[${logLabel}] 检测到站点通过 window.open 打开授权页，改由扩展直接打开: ${clickResult.popupUrl}`);
      try {
        const popupTab = await createTemporaryBackgroundTab(clickResult.popupUrl, 20000);
        activeTabId = popupTab.id;
        continue;
      } catch (e) {
        console.warn(`[${logLabel}] 扩展直接打开授权页失败:`, e);
      }
    }

    await waitForTabUrlChange(activeTabId, lastUrl, 10000);
    await waitForTabComplete(activeTabId, 20000);
    await waitForUsableTabPage(activeTabId, 20000);
  }

  console.warn(`[${logLabel}] 未能从登录页启动 linux.do OAuth`);
  return null;
}

async function startSiteLinuxDoOAuthFromCurrentPage(tabId, domain, readyUrl, logLabel = 'OAuth') {
  const knownTabIds = await getOpenTabIds();
  const startedAt = Date.now();
  let activeTabId = tabId;

  while (Date.now() - startedAt < 30000) {
    let tabInfo;
    try {
      tabInfo = await chrome.tabs.get(activeTabId);
    } catch (e) {
      return null;
    }

    const currentUrl = tabInfo.url || tabInfo.pendingUrl || '';
    if (currentUrl.includes('connect.linux.do')) {
      await clickLinuxDoAuthorizeButton(activeTabId);
      const redirected = await waitForTabUrlMatch(activeTabId, domain, 30000);
      if (!redirected) {
        console.warn(`[${logLabel}] 等待回跳目标站点超时`);
        return null;
      }
      await ensureTabPageReady(activeTabId, readyUrl || `https://${domain}/`, 20000);
      await sleep(1000);
      continue;
    }

    const pageState = await inspectOfficialPageAuthState(activeTabId, [], domain);
    if (currentUrl.includes(domain) && !pageState?.hasLinuxDoLoginEntry && !isTargetDomainLoginPage(currentUrl, domain)) {
      return { tabId: activeTabId };
    }

    if (!pageState?.hasLinuxDoLoginEntry) {
      await sleep(500);
      continue;
    }

    const previousUrl = currentUrl;
    const clickResult = await clickSiteLinuxDoLoginButton(activeTabId, logLabel);
    if (!clickResult?.clicked) {
      await sleep(500);
      continue;
    }

    await sleep(1000);
    const newLinuxDoTab = await waitForNewLinuxDoTab(knownTabIds, 3000);
    if (newLinuxDoTab?.id) {
      if (newLinuxDoTab.active) {
        await chrome.tabs.update(newLinuxDoTab.id, { active: false }).catch(() => {});
      }
      activeTabId = newLinuxDoTab.id;
      await waitForTabComplete(activeTabId, 20000);
      await waitForUsableTabPage(activeTabId, 20000);
      continue;
    }

    if (clickResult?.sameTabUrl) {
      console.log(`[${logLabel}] 站点同页跳转授权: ${clickResult.sameTabUrl}`);
      if (clickResult.sameTabUrl.includes('connect.linux.do') ||
        clickResult.sameTabUrl.includes(domain)) {
        try {
          const current = await chrome.tabs.get(activeTabId);
          const currentUrl = current.url || current.pendingUrl || '';
          if (currentUrl !== clickResult.sameTabUrl &&
            !currentUrl.includes('connect.linux.do') &&
            !isOfficialPageOAuthPendingUrl(currentUrl, domain)) {
            await chrome.tabs.update(activeTabId, { url: clickResult.sameTabUrl, active: false });
          }
        } catch (e) {}
      }
      await waitForTabComplete(activeTabId, 20000);
      await waitForUsableTabPage(activeTabId, 20000);
      continue;
    }

    if (clickResult?.popupUrl && clickResult.popupUrl.includes('connect.linux.do')) {
      console.log(`[${logLabel}] 检测到站点通过 window.open 打开授权页，改由扩展直接打开: ${clickResult.popupUrl}`);
      try {
        const popupTab = await createTemporaryBackgroundTab(clickResult.popupUrl, 20000);
        activeTabId = popupTab.id;
        continue;
      } catch (e) {
        console.warn(`[${logLabel}] 扩展直接打开授权页失败:`, e);
      }
    }

    await waitForTabUrlChange(activeTabId, previousUrl, 10000);
    await waitForTabComplete(activeTabId, 20000);
    await waitForUsableTabPage(activeTabId, 20000);
  }

  console.warn(`[${logLabel}] 未能从当前页面启动 linux.do OAuth`);
  return null;
}

function extractProviderFromNewApiOAuthUrl(url) {
  try {
    const parsed = new URL(url || '');
    const pathMatch = parsed.pathname.match(/\/oauth\/([^/]+)\/?$/i);
    if (pathMatch?.[1]) return pathMatch[1];
  } catch (e) {}
  return 'linuxdo';
}

async function processNewApiOAuthCallback(tabId, logLabel = 'OAuth') {
  let tabInfo;
  try {
    tabInfo = await chrome.tabs.get(tabId);
  } catch (e) {
    console.warn(`[${logLabel}] 读取 OAuth 回调页面失败:`, e);
    return null;
  }

  let code = null;
  let state = '';
  let provider = 'linuxdo';
  try {
    const oauthUrl = new URL(tabInfo.url || '');
    code = oauthUrl.searchParams.get('code');
    state = oauthUrl.searchParams.get('state') || '';
    provider = extractProviderFromNewApiOAuthUrl(oauthUrl.toString()) || 'linuxdo';
  } catch (e) {
    return null;
  }

  if (!code) return null;

  console.log(`[${logLabel}] 手动调用 OAuth 回调 API...`);
  try {
    const callbackResults = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (authCode, authState, authProvider) => {
        function readAccessToken() {
          return localStorage.getItem('access_token') ||
            localStorage.getItem('token') ||
            localStorage.getItem('auth_token') ||
            '';
        }

        function writeAuthBundle(bundle) {
          if (!bundle || typeof bundle !== 'object') return false;
          let wrote = false;
          const accessToken = bundle.access_token || bundle.accessToken || bundle.token || '';
          const user = bundle.user || null;
          const session = bundle.session || null;

          if (user) {
            try {
              localStorage.setItem('user', JSON.stringify(user));
              wrote = true;
            } catch (e) {}
            const userId = user?.id || user?.user_id || user?.uid;
            if (userId != null) {
              try {
                localStorage.setItem('uid', String(userId));
                wrote = true;
              } catch (e) {}
            }
          } else if (bundle.id || bundle.user_id || bundle.uid) {
            // 旧版回调：data 直接是 user 对象
            try {
              localStorage.setItem('user', JSON.stringify(bundle));
              wrote = true;
            } catch (e) {}
            const legacyId = bundle.id || bundle.user_id || bundle.uid;
            try {
              localStorage.setItem('uid', String(legacyId));
              wrote = true;
            } catch (e) {}
          }

          if (accessToken) {
            try {
              localStorage.setItem('access_token', String(accessToken));
              localStorage.setItem('token', String(accessToken));
              wrote = true;
            } catch (e) {}
          }

          if (accessToken || user || session) {
            try {
              let existing = {};
              try {
                existing = JSON.parse(localStorage.getItem('new-api-auth-session') || '{}') || {};
              } catch (e) {}
              const next = {
                ...existing,
                state: {
                  ...(existing.state || {}),
                  auth: {
                    ...((existing.state && existing.state.auth) || {}),
                    user: user || existing?.state?.auth?.user || null,
                    accessToken: accessToken || existing?.state?.auth?.accessToken || null,
                    accessExpiresAt: bundle.access_expires_at || bundle.accessExpiresAt ||
                      existing?.state?.auth?.accessExpiresAt || null,
                    session: session || existing?.state?.auth?.session || null,
                    bootstrapState: 'complete'
                  }
                },
                version: typeof existing.version === 'number' ? existing.version : 0
              };
              localStorage.setItem('new-api-auth-session', JSON.stringify(next));
              wrote = true;
            } catch (e) {}
          }
          return wrote;
        }

        try {
          const params = new URLSearchParams({ code: authCode });
          if (authState) {
            params.set('state', authState);
          }
          const providerPath = encodeURIComponent(authProvider || 'linuxdo');
          const resp = await fetch(`/api/oauth/${providerPath}?${params.toString()}`, {
            method: 'GET',
            credentials: 'include'
          });
          const data = await resp.json();
          console.log('[OAuth 回调] API 响应:', data);

          let wroteStorage = false;
          if (data?.success && data.data) {
            wroteStorage = writeAuthBundle(data.data);
            console.log('[OAuth 回调] 已写入页面登录态');
          }

          await new Promise(r => setTimeout(r, 1000));

          const bundleToken = (data?.data && typeof data.data === 'object')
            ? (data.data.access_token || data.data.accessToken || data.data.token || null)
            : null;
          const accessToken = readAccessToken() || bundleToken;
          const hasUser = localStorage.getItem('user') !== null;
          return {
            success: Boolean(data?.success),
            apiResponse: data,
            hasUser,
            accessToken: accessToken || null,
            wroteStorage,
            httpStatus: resp.status
          };
        } catch (e) {
          return { success: false, error: e.message };
        }
      },
      args: [code, state, provider]
    });
    const callbackResult = callbackResults[0]?.result;
    console.log(`[${logLabel}] 回调 API 结果:`, JSON.stringify(callbackResult).substring(0, 300));
    return callbackResult || null;
  } catch (e) {
    console.warn(`[${logLabel}] 手动调用回调 API 失败:`, e.message);
    return null;
  }
}

async function buildNewApiHeadersFromTabSession(domain, tabId, { baseHeaders = null, captureTimeout = 5000 } = {}) {
  let session = null;
  try {
    session = await inspectNewApiBrowserSession(tabId);
  } catch (e) {}

  let headers = baseHeaders && Object.keys(baseHeaders).length > 0
    ? { ...baseHeaders }
    : {};
  if (!headers.Cookie && !headers.cookie && !headers.Authorization) {
    const capturedHeaders = await captureAuthHeaders(domain, tabId, { timeout: captureTimeout });
    headers = { ...headers, ...(capturedHeaders || {}) };
  }

  const cookies = await chrome.cookies.getAll({ domain });
  headers = buildNewApiExistingSessionHeaders({
    cookies,
    user: session?.user,
    userId: session?.userId,
    token: session?.token,
    tabId,
    baseHeaders: headers
  });

  if (!headers.Cookie && !headers.cookie && !headers.Authorization) {
    return null;
  }

  return { headers, session };
}

async function collectNewApiAuthHeadersFromCandidates(domain, visitUrl, tabId, logLabel = 'OAuth') {
  const candidateUrls = [];

  try {
    const tabInfo = await chrome.tabs.get(tabId);
    const currentUrl = tabInfo.url || tabInfo.pendingUrl || '';
    if (currentUrl.includes(domain) && !isTargetDomainLoginPage(currentUrl, domain)) {
      candidateUrls.push(currentUrl);
    }
  } catch (e) {}

  for (const url of getNewApiPostLoginUrlCandidates(domain, visitUrl)) {
    if (!candidateUrls.includes(url)) {
      candidateUrls.push(url);
    }
  }

  for (const url of candidateUrls) {
    try {
      const tabInfo = await chrome.tabs.get(tabId);
      const currentUrl = tabInfo.url || tabInfo.pendingUrl || '';
      if (currentUrl !== url) {
        await chrome.tabs.update(tabId, { url, active: false });
        await ensureTabPageReady(tabId, url, 15000);
        await sleep(1500);
      }

      const built = await buildNewApiHeadersFromTabSession(domain, tabId, { captureTimeout: 8000 });
      if (built?.headers) {
        return built;
      }
    } catch (e) {
      console.warn(`[${logLabel}] 尝试 NewAPI 候选页面失败: ${url}`, e);
    }
  }

  return null;
}

async function buildNewApiLoggedInTabHeaders(domain, visitUrl, tabId, logLabel = 'OAuth') {
  let tabInfo = await chrome.tabs.get(tabId);
  if (!tabInfo.url || !tabInfo.url.includes(domain) || isTargetDomainLoginPage(tabInfo.url, domain)) {
    console.warn(`[${logLabel}] OAuth 后未进入已登录目标页面: ${tabInfo.url}`);
    return null;
  }

  await processNewApiOAuthCallback(tabId, logLabel);

  let session = null;
  for (let retry = 0; retry < 5; retry++) {
    await sleep(2000);
    session = await inspectNewApiBrowserSession(tabId);
    console.log(`[${logLabel}] session 检查 (${retry + 1}/5):`, JSON.stringify({
      hasUser: session?.hasUser,
      userAuthenticated: session?.userAuthenticated,
      selfStatus: session?.selfStatus,
      hasToken: Boolean(session?.token)
    }));
    if (session?.success && hasNewApiUserSession(session)) break;

    tabInfo = await chrome.tabs.get(tabId).catch(() => tabInfo);
    if (isTargetDomainLoginPage(tabInfo?.url, domain)) {
      console.warn(`[${logLabel}] session 检查时又回到登录页`);
      return null;
    }
  }

  if (!session?.success || !hasNewApiUserSession(session)) {
    console.warn(`[${logLabel}] OAuth 后仍未检测到 NewAPI 登录态`);
    return null;
  }

  const built = await collectNewApiAuthHeadersFromCandidates(domain, visitUrl, tabId, logLabel);
  if (!built?.headers) {
    console.warn(`[${logLabel}] 未能构建 NewAPI 认证头`);
    return null;
  }

  return { headers: built.headers, tabId };
}

async function tryNewApiSiteLoginOAuth(domain, visitUrl, tab, tabSession = null) {
  if (!tab?.id) return null;
  try {
    for (const loginUrl of getNewApiLoginUrlCandidates(domain, visitUrl)) {
      let tabInfo = await chrome.tabs.get(tab.id);
      if (tabInfo.url !== loginUrl) {
        await chrome.tabs.update(tab.id, { url: loginUrl, active: false });
        await ensureTabPageReady(tab.id, loginUrl, 20000);
        await sleep(1000);
        tabInfo = await chrome.tabs.get(tab.id);
      }

      const pageState = await inspectOfficialPageAuthState(tab.id, [], domain);
      if (!pageState?.hasLinuxDoLoginEntry && !pageState?.isTargetLoginPage) {
        console.log(`[OAuth] 登录页候选未发现 Linux.do 登录入口，尝试下一个: ${loginUrl}`);
        continue;
      }

      const started = await startSiteLinuxDoOAuthFromLoginPage(
        tab.id,
        domain,
        getNewApiPostLoginUrl(domain, visitUrl),
        'OAuth',
        loginUrl
      );
      if (!started?.tabId) {
        continue;
      }

      const built = await buildNewApiLoggedInTabHeaders(domain, visitUrl, started.tabId, 'OAuth');
      if (built?.headers) {
        return built;
      }
    }
    console.warn('[OAuth] 所有 NewAPI 登录页候选均未完成授权');
    return null;
  } catch (e) {
    console.warn('[OAuth] 站点登录页 OAuth 失败:', e);
    await closeTabUnlessInSession(tab?.id, tabSession);
    return null;
  }
}

async function clickLinuxDoAuthorizeButton(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const selectors = [
          'button',
          'input[type="submit"]',
          'a[class*="btn"]',
          '[role="button"]'
        ];
        const candidates = document.querySelectorAll(selectors.join(','));
        for (const el of candidates) {
          const text = (el.textContent || el.value || '').trim();
          if (/allow|允许|授权|approve|accept|Authorize|同意/i.test(text)) {
            el.click();
            return `clicked: ${text}`;
          }
        }

        const form = document.querySelector('form');
        const submit = form?.querySelector('button, input[type="submit"]');
        if (submit) {
          submit.click();
          return 'clicked form submit';
        }

        return 'no authorize button found';
      }
    });
    console.log('[ZenAPI OAuth] 授权页点击结果:', results[0]?.result);
  } catch (e) {
    console.warn('[ZenAPI OAuth] 点击授权按钮失败:', e);
  }
}

async function readInfiniteCanvasAuthHeadersFromTab(tabId, baseHeaders = {}) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (storageKey) => {
        function pickTokenFromPersistedValue(value) {
          const text = String(value || '').trim();
          if (!text) return null;

          try {
            const parsed = JSON.parse(text);
            const token =
              parsed?.state?.token ||
              parsed?.token ||
              parsed?.data?.token ||
              parsed?.accessToken ||
              parsed?.access_token;
            if (typeof token === 'string' && token.trim()) return token.trim();
          } catch (e) {}

          if (!text.startsWith('{') && text.length >= 20) return text;
          return null;
        }

        function persistToken(token) {
          if (!token) return;
          let current = {};
          try {
            current = JSON.parse(localStorage.getItem(storageKey) || '{}') || {};
          } catch (e) {}
          const next = {
            ...current,
            state: {
              ...(current.state || {}),
              token
            },
            version: typeof current.version === 'number' ? current.version : 0
          };
          localStorage.setItem(storageKey, JSON.stringify(next));
        }

        const urlToken = new URL(location.href).searchParams.get('token');
        if (urlToken) {
          persistToken(urlToken);
          return urlToken;
        }

        const stored =
          localStorage.getItem(storageKey) ||
          sessionStorage.getItem(storageKey);
        return pickTokenFromPersistedValue(stored);
      },
      args: [INFINITE_CANVAS_AUTH_TOKEN_KEY]
    });

    const token = results[0]?.result;
    const headers = mergeAuthorizationHeader(baseHeaders || {}, token);
    headers._tabId = tabId;
    return headers;
  } catch (e) {
    console.warn('[Infinite Canvas] 读取页面登录令牌失败:', e);
    return baseHeaders || {};
  }
}

async function readSub2ApiAuthHeadersFromTab(tabId, baseHeaders = {}) {
  return readStorageTokenAuthHeadersFromTab(tabId, ['auth_token', 'access_token', 'token'], baseHeaders, 'Sub2API');
}

async function readStorageTokenAuthHeadersFromTab(tabId, tokenKeys, baseHeaders = {}, logLabel = 'Auth') {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (keys) => {
        const tokenKeys = Array.isArray(keys) ? keys : [];
        for (const key of tokenKeys) {
          const token = localStorage.getItem(key) || sessionStorage.getItem(key);
          if (token) return token;
        }
        return null;
      },
      args: [tokenKeys]
    });

    const token = results[0]?.result;
    const headers = mergeAuthorizationHeader(baseHeaders || {}, token);
    headers._tabId = tabId;
    return headers;
  } catch (e) {
    console.warn(`[${logLabel}] 读取页面登录令牌失败:`, e);
    return baseHeaders || {};
  }
}

function formatResult(execResult) {
  if (execResult.invalidSite) {
    return { status: 'invalid', message: execResult.message || '站点页面失效' };
  }
  if (execResult.error) {
    return { status: 'failed', message: execResult.error };
  }
  if (execResult.fallbackClicked && execResult.success) {
    return { status: 'success', message: execResult.message };
  }
  if (execResult.alreadyCheckedIn) {
    return { status: 'already', message: execResult.message };
  }
  return {
    status: execResult.success ? 'success' : 'failed',
    message: execResult.message
  };
}

async function buildResultWithLatestBalance(site, execResult, authHeaders, tabId = null) {
  const result = formatResult(execResult);
  const balance = await fetchLatestBalance(site, authHeaders, tabId, execResult);
  if (balance) result.balance = balance;
  return result;
}

async function fetchLatestBalance(site, authHeaders, tabId = null, execResult = null) {
  const fromResponse = site.type === 'localapi'
    ? extractLocalApiBalance(execResult?.data)
    : extractBalanceFromCheckInResult(execResult);
  if (fromResponse) return fromResponse;

  const candidates = getBalanceQueryUrls(site);
  for (const url of candidates) {
    try {
      const response = await doFetchWithHeaders(url, 'GET', null, authHeaders || {});
      const fromData = site.type === 'localapi'
        ? (extractLocalApiBalance(response?.data) || extractBalanceFromData(response?.data))
        : extractBalanceFromData(response?.data);
      if (fromData) return fromData;
    } catch (e) {
      console.warn(`${site.siteName} 余额接口读取失败 ${url}:`, e);
    }
  }

  if (tabId) {
    const fromPage = await readBalanceFromTab(tabId, site);
    if (fromPage) return fromPage;
  }

  return null;
}

function getBalanceQueryUrls(site) {
  const urls = [
    site.signQueryUrl,
    site.type === 'localapi' ? `https://${site.cookieDomain}/user/api/me` : null,
    `https://${site.cookieDomain}/api/user/self`,
    `https://${site.cookieDomain}/api/status`,
    `https://${site.cookieDomain}/api/u/dashboard`,
    `https://${site.cookieDomain}/api/v1/user/info`,
    `https://${site.cookieDomain}/api/v1/user`
  ];
  return [...new Set(urls.filter(Boolean))];
}

async function readBalanceFromTab(tabId, site) {
  try {
    await chrome.tabs.get(tabId);
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.body?.innerText || ''
    });
    return extractBalanceFromText(results[0]?.result || '');
  } catch (e) {
    console.warn(`${site.siteName} 页面余额读取失败:`, e);
    return null;
  }
}

// 通过 webRequest 捕获页面真实请求头
function captureAuthHeaders(domain, tabId, { timeout = 25000 } = {}) {
  return new Promise(async (resolve) => {
    let resolved = false;

    function onCapture(headers) {
      if (resolved) return;
      resolved = true;
      chrome.webRequest.onSendHeaders.removeListener(listener);
      headers._tabId = tabId; // 保存tabId用于后续在标签页中执行请求
      resolve(headers);
    }

    function listener(details) {
      if (resolved || details.tabId !== tabId) return;

      const headers = {};
      for (const h of (details.requestHeaders || [])) {
        headers[h.name] = h.value;
      }

      console.log(`[webRequest] 捕获到 ${details.url} 的请求头:`, Object.keys(headers));
      onCapture(headers);
    }

    // 监听目标域名的 API 请求
    chrome.webRequest.onSendHeaders.addListener(
      listener,
      { urls: [`https://${domain}/api/*`], tabId: tabId },
      ['requestHeaders', 'extraHeaders']
    );

    // 检查当前URL，如果是登录页面，先导航到登录页
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.url && (tab.url.includes('/login') || tab.url.includes('expired=true'))) {
        console.log(`[webRequest] 标签页在登录页面，先导航到登录页...`);
        await chrome.tabs.update(tabId, { url: `https://${domain}/login` });
        await sleep(20000); // 等待Cloudflare验证完成（20秒）
      }
    } catch (e) {
      console.warn('检查标签页URL失败:', e);
    }

    // 刷新页面以触发 API 请求
    console.log(`[webRequest] 刷新标签页 ${tabId} 以捕获请求头...`);
    try {
      await chrome.tabs.reload(tabId);
    } catch (e) {
      console.warn('刷新标签页失败:', e);
    }

    // 等待页面加载完成 + API 请求发出
    await sleep(timeout);

    // 超时
    if (!resolved) {
      resolved = true;
      chrome.webRequest.onSendHeaders.removeListener(listener);
      console.warn(`[webRequest] 超时未捕获到 ${domain} 的 API 请求`);
      resolve(null);
    }
  });
}

// 用捕获的头发起签到请求（从 service worker 发起）
async function doCheckInRequest(url, method, params, capturedHeaders) {
  // 优先使用 service worker fetch（更快），只有在需要时才使用标签页
  // 如果有 _needsTabExecution 标记，说明该站点需要在标签页中执行
  const needsTabExecution = capturedHeaders._needsTabExecution;
  let tabId = capturedHeaders._tabId;

  // 检查标签页是否存在
  if (tabId && needsTabExecution) {
    try {
      await chrome.tabs.get(tabId);
      // 标签页存在，可以使用
    } catch (e) {
      // 标签页不存在，移除 tabId
      console.log(`[fetch-in-tab] 标签页 ${tabId} 不存在，回退到 service worker fetch`);
      tabId = null;
    }
  }

  if (tabId && needsTabExecution) {
    console.log(`[fetch-in-tab] 站点需要 Cloudflare 绕过，在标签页 ${tabId} 中执行: ${method} ${url}`);

    // 提取认证相关的头
    const headers = { 'Content-Type': 'application/json' };
    const authKeys = ['authorization', 'cookie', 'session', 'token', 'x-token', 'x-auth', 'new-api', 'x-user-token'];

    for (const [name, value] of Object.entries(capturedHeaders)) {
      if (name.startsWith('_')) continue; // 跳过临时标记
      const lower = name.toLowerCase();
      if (authKeys.some(k => lower.includes(k))) {
        headers[name] = value;
      }
    }
    if (capturedHeaders._localApiUserToken) {
      headers['x-user-token'] = capturedHeaders._localApiUserToken;
    }

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: async (fetchUrl, fetchMethod, fetchParams, fetchHeaders, successOnHttpOk, fetchTimeoutMs) => {
          try {
            const options = {
              method: fetchMethod,
              headers: fetchHeaders,
              credentials: 'include'
            };
            if (fetchMethod === 'POST' && fetchParams && Object.keys(fetchParams).length > 0) {
              options.body = JSON.stringify(fetchParams);
            }

            // AbortController 防止页面 fetch 挂起拖垮外层 executeScript（进而 keepalive service worker）
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
            let response;
            try {
              response = await fetch(fetchUrl, { ...options, signal: controller.signal });
            } finally {
              clearTimeout(timer);
            }
            if (response.status === 404 || response.status === 410) {
              return {
                success: false,
                invalidSite: true,
                message: '站点页面失效',
                httpStatus: response.status
              };
            }
            const text = await response.text();

            // 尝试解析JSON
            let data;
            try {
              data = JSON.parse(text);
            } catch (e) {
              return { error: 'Response is not JSON: ' + text.substring(0, 100), httpStatus: response.status };
            }

            const zenApiAlreadyCheckedIn = data?.already_checked_in === true;
            const success =
              data.success === true ||
              data.status === 'success' ||
              data.ret === 1 ||
              data.code === 0 ||
              data.ok === true ||
              (successOnHttpOk === true && response.ok);
            const reward = Number(data?.reward);
            const message =
              data.message ||
              data.msg ||
              (zenApiAlreadyCheckedIn ? '今日已签到' : null) ||
              (Number.isFinite(reward) ? `签到成功，获得 $${reward.toFixed(2)}` : null) ||
              data.data ||
              '签到完成';
            const msgStr = typeof message === 'string' ? message : JSON.stringify(message);

            const alreadyKeywords = ['已签到', '已经签到', '已签过', '今日已签', 'already', '重复签到'];
            const alreadyCheckedIn = zenApiAlreadyCheckedIn || alreadyKeywords.some(k => msgStr.includes(k));

            return {
              success: success || alreadyCheckedIn,
              alreadyCheckedIn,
              message: msgStr,
              httpStatus: response.status,
              data
            };
          } catch (e) {
            return {
              error: e?.name === 'AbortError' ? `请求超时（${fetchTimeoutMs}ms）` : e.message,
              success: false,
              httpStatus: 0
            };
          }
        },
        args: [url, method, params, headers, capturedHeaders._successOnHttpOk === true, SITE_FETCH_TIMEOUT_MS]
      });

      const result = results[0]?.result;
      console.log(`[fetch-in-tab] 结果:`, result);
      return result || { error: 'No result from tab', success: false };
    } catch (e) {
      console.warn(`[fetch-in-tab] 失败，回退到 service worker fetch:`, e);
      // 回退到background fetch
    }
  }

  // 回退：在background中执行
  return doFetchWithHeaders(url, method, params, capturedHeaders);
}

function buildNonJsonFetchResult(responseText, httpStatus, contentType = '') {
  const text = String(responseText || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return {
      error: '接口返回为空',
      success: false,
      httpStatus
    };
  }

  const preview = text.substring(0, 120);
  const normalizedType = String(contentType || '').toLowerCase();
  const looksLikeHtml =
    normalizedType.includes('text/html') ||
    /^<!doctype html/i.test(text) ||
    /^<html/i.test(text);

  return {
    error: looksLikeHtml
      ? `接口返回 HTML 页面，可能命中了登录页或 Cloudflare 校验: ${preview}`
      : `Response is not JSON: ${preview}`,
    success: false,
    httpStatus
  };
}

async function doFetchWithHeaders(url, method, params, capturedHeaders) {
  // 提取认证相关的头
  const headers = { 'Content-Type': 'application/json' };
  const authKeys = ['authorization', 'cookie', 'session', 'token', 'x-token', 'x-auth', 'new-api', 'x-user-token'];

  for (const [name, value] of Object.entries(capturedHeaders)) {
    if (name.startsWith('_')) continue;
    const lower = name.toLowerCase();
    if (authKeys.some(k => lower.includes(k))) {
      headers[name] = value;
    }
  }
  if (capturedHeaders._localApiUserToken) {
    headers['x-user-token'] = capturedHeaders._localApiUserToken;
  }

  // 也保留 user-agent 和 referer
  if (capturedHeaders['User-Agent']) headers['User-Agent'] = capturedHeaders['User-Agent'];
  if (capturedHeaders['Referer']) headers['Referer'] = capturedHeaders['Referer'];

  console.log(`[fetch] ${method} ${url} 使用头:`, Object.keys(headers));
  console.log(`[fetch] 认证头已脱敏，数量:`, Object.keys(headers).length);

  const options = { method, headers };
  if (method === 'POST' && params && Object.keys(params).length > 0) {
    options.body = JSON.stringify(params);
  }

  // AbortController 真正中止挂起的 fetch，防止其 keepalive 拖垮 service worker。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SITE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (isInvalidHttpStatus(response.status)) {
      return { success: false, invalidSite: true, message: '站点页面失效', httpStatus: response.status };
    }
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      return buildNonJsonFetchResult(text, response.status, response.headers.get('content-type'));
    }

    if (!data) {
      return buildNonJsonFetchResult(text, response.status, response.headers.get('content-type'));
    }

    console.log(`[fetch] 响应状态: ${response.status}, 数据:`, JSON.stringify(data).substring(0, 200));

    return parseCheckInResponse(data, response.status, capturedHeaders._successOnHttpOk === true);
  } catch (e) {
    const aborted = e?.name === 'AbortError';
    console.warn(`[fetch] 请求失败（已捕获，转结构化返回）:`, e);
    return {
      error: aborted ? `请求超时（${SITE_FETCH_TIMEOUT_MS}ms）` : e.message,
      success: false,
      httpStatus: 0
    };
  } finally {
    clearTimeout(timer);
  }
}

// 缓存/读取认证头
async function cacheHeaders(siteId, headers) {
  const data = await chrome.storage.local.get('authHeadersCache');
  const cache = data.authHeadersCache || {};
  const payload = await encryptAuthHeadersForCache(headers);
  if (!payload) {
    console.warn('认证缓存加密不可用，跳过缓存写入');
    return;
  }
  cache[siteId] = {
    cachedAt: Date.now(),
    payload
  };
  await chrome.storage.local.set({ authHeadersCache: cache });
}

async function getCachedHeaders(siteId) {
  const data = await chrome.storage.local.get('authHeadersCache');
  const cache = data.authHeadersCache || {};
  const entry = cache[siteId];
  if (!entry) return null;

  // 缓存 7 天过期（401 时会自动刷新）
  if (Date.now() - entry.cachedAt > 7 * 24 * 60 * 60 * 1000) {
    return null;
  }

  const headers = await decryptAuthHeadersFromCache(entry.payload || entry);
  if (headers && !entry.payload && entry.headers) {
    await cacheHeaders(siteId, headers);
  }
  return headers;
}

async function clearCachedHeaders(siteId) {
  const data = await chrome.storage.local.get('authHeadersCache');
  const cache = data.authHeadersCache || {};
  delete cache[siteId];
  await chrome.storage.local.set({ authHeadersCache: cache });
}

async function getNewApiAuthHeaders(site, { forceRefresh = false, needsTabExecution = false } = {}, tabSession = null) {
  if (!forceRefresh) {
    const cachedHeaders = await getCachedHeaders(site.siteId);
    if (cachedHeaders) {
      console.log(`${site.siteName} 使用缓存认证头`);
      await appendCheckInLog(site.siteName, '已登录', '复用缓存认证信息');
      return { headers: cachedHeaders, tabToCleanup: null, source: 'cache' };
    }
  }

  console.log(`${site.siteName} 无可用缓存，先检查浏览器已有登录态...`);
  await appendCheckInLog(site.siteName, '待检查', '开始检查浏览器已有登录态');
  const existingSession = await getNewApiExistingSessionAuthHeaders(site, { needsTabExecution }, tabSession);
  if (existingSession?.headers && !shouldTryNewApiOAuth({ hasExistingSessionHeaders: true })) {
    await cacheHeaders(site.siteId, existingSession.headers);
    console.log(`${site.siteName} 已复用浏览器已有登录态`);
    await appendCheckInLog(site.siteName, '已登录', '复用浏览器已有登录态');
    return existingSession;
  }

  console.log(`${site.siteName} 未检测到可复用登录态，尝试 linux.do OAuth...`);
  await appendCheckInLog(site.siteName, '登录中', '未检测到可复用登录态，尝试 linux.do OAuth');
  const oauthResult = await autoOAuthLogin(site.cookieDomain, site.visitUrl, tabSession);
  if (oauthResult?.headers) {
    if (needsTabExecution) {
      oauthResult.headers._needsTabExecution = true;
    }
    await cacheHeaders(site.siteId, oauthResult.headers);
    console.log(`${site.siteName} OAuth 登录成功`);
    await appendCheckInLog(site.siteName, '登录成功', 'OAuth 登录成功');
    return { headers: oauthResult.headers, tabToCleanup: oauthResult.tabId || null, source: 'oauth' };
  }

  await appendCheckInLog(site.siteName, '登录失败', '无法获取接口认证信息');
  return null;
}

async function getNewApiExistingSessionAuthHeaders(site, { needsTabExecution = false } = {}, tabSession = null) {
  const tab = await openSiteSessionTab(tabSession, getNewApiPostLoginUrl(site.cookieDomain, site.visitUrl), 15000);
  try {
    await sleep(1500);
    const tabInfo = await chrome.tabs.get(tab.id);
    if (isTargetDomainLoginPage(tabInfo.url, site.cookieDomain)) {
      console.log(`${site.siteName} 当前位于登录页，跳过已有登录态复用`);
      await appendCheckInLog(site.siteName, '未登录', '当前位于登录页，直接尝试自动登录');
      await closeTabUnlessInSession(tab.id, tabSession);
      return null;
    }

    const session = await inspectNewApiBrowserSession(tab.id);
    console.log(`${site.siteName} 浏览器登录态检查:`, JSON.stringify({
      hasUser: session?.hasUser,
      userAuthenticated: session?.userAuthenticated,
      selfStatus: session?.selfStatus,
      hasToken: Boolean(session?.token)
    }));

    if (!session?.success || !hasNewApiUserSession(session)) {
      await closeTabUnlessInSession(tab.id, tabSession);
      return null;
    }

    const built = await buildNewApiHeadersFromTabSession(site.cookieDomain, tab.id, { captureTimeout: 5000 });
    const headers = built?.headers || buildNewApiExistingSessionHeaders({
      user: session.user,
      userId: session.userId,
      token: session.token,
      tabId: tab.id
    });

    if (!headers.Cookie && !headers.cookie && !headers.Authorization) {
      await closeTabUnlessInSession(tab.id, tabSession);
      return null;
    }

    if (needsTabExecution) {
      headers._needsTabExecution = true;
    }

    return { headers, tabToCleanup: tab.id, source: 'browser-session' };
  } catch (e) {
    console.warn(`${site.siteName} 检查浏览器已有登录态失败:`, e);
    await closeTabUnlessInSession(tab.id, tabSession);
    return null;
  }
}

async function inspectNewApiBrowserSession(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      function readPersistedAuth() {
        const directToken = localStorage.getItem('access_token') ||
          localStorage.getItem('token') ||
          localStorage.getItem('auth_token') ||
          sessionStorage.getItem('access_token') ||
          sessionStorage.getItem('token') ||
          '';
        let bundleUser = null;
        let bundleToken = '';
        let bundleSession = null;
        try {
          const raw = localStorage.getItem('new-api-auth-session') ||
            sessionStorage.getItem('new-api-auth-session');
          if (raw) {
            const parsed = JSON.parse(raw);
            const auth = parsed?.state?.auth || parsed?.auth || parsed?.state || parsed;
            bundleToken = auth?.accessToken || auth?.access_token || auth?.token || '';
            bundleUser = auth?.user || null;
            bundleSession = auth?.session || null;
          }
        } catch (e) {}
        return {
          token: String(directToken || bundleToken || '').trim(),
          user: localStorage.getItem('user') || (bundleUser ? JSON.stringify(bundleUser) : null),
          uid: localStorage.getItem('uid') || (bundleUser?.id != null ? String(bundleUser.id) : null),
          session: bundleSession
        };
      }

      async function fetchSelf(accessToken) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        try {
          const headers = {};
          if (accessToken) {
            headers.Authorization = /^bearer\s+/i.test(accessToken)
              ? accessToken
              : `Bearer ${accessToken}`;
          }
          const selfResp = await fetch('/api/user/self', {
            credentials: 'include',
            headers,
            signal: controller.signal
          });
          let selfData = null;
          try {
            selfData = await selfResp.json();
          } catch (e) {}
          return {
            selfStatus: selfResp.status,
            selfData,
            userAuthenticated: selfResp.ok &&
              selfResp.status !== 401 &&
              selfData?.success !== false &&
              Boolean(selfData?.data || selfData?.success === true)
          };
        } finally {
          clearTimeout(timer);
        }
      }

      async function refreshAccessToken() {
        try {
          const resp = await fetch('/api/user/auth/refresh', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' }
          });
          if (!resp.ok) return null;
          const data = await resp.json();
          const bundle = data?.data || data;
          const accessToken = bundle?.access_token || bundle?.accessToken || bundle?.token || '';
          if (!accessToken) return null;
          try {
            localStorage.setItem('access_token', accessToken);
            localStorage.setItem('token', accessToken);
          } catch (e) {}
          if (bundle?.user) {
            try {
              localStorage.setItem('user', JSON.stringify(bundle.user));
              if (bundle.user.id != null) localStorage.setItem('uid', String(bundle.user.id));
            } catch (e) {}
          }
          return {
            token: accessToken,
            user: bundle?.user ? JSON.stringify(bundle.user) : null,
            uid: bundle?.user?.id != null ? String(bundle.user.id) : null,
            bundle
          };
        } catch (e) {
          return null;
        }
      }

      try {
        let persisted = readPersistedAuth();
        let token = persisted.token;
        let user = persisted.user;
        let uid = persisted.uid;
        let selfStatus = 0;
        let selfData = null;
        let userAuthenticated = false;

        try {
          let selfResult = await fetchSelf(token);
          selfStatus = selfResult.selfStatus;
          selfData = selfResult.selfData;
          userAuthenticated = selfResult.userAuthenticated;

          // rc.22：仅 cookie 会话时，用 refresh 换 access_token 再探 self
          if (!userAuthenticated && (selfStatus === 401 || selfStatus === 0 || !token)) {
            const refreshed = await refreshAccessToken();
            if (refreshed?.token) {
              token = refreshed.token;
              user = refreshed.user || user;
              uid = refreshed.uid || uid;
              selfResult = await fetchSelf(token);
              selfStatus = selfResult.selfStatus;
              selfData = selfResult.selfData;
              userAuthenticated = selfResult.userAuthenticated;
            }
          }
        } catch (e) {}

        return {
          success: true,
          hasUser: user !== null,
          user,
          userId: uid || selfData?.data?.id || selfData?.data?.user_id || selfData?.data?.uid || null,
          token,
          accessToken: token,
          userAuthenticated,
          selfStatus,
          selfData
        };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }
  });

  return results[0]?.result || null;
}

// ============== Auto OAuth Login ==============

// 等待标签页加载完成
function waitForTabComplete(tabId, timeout = 15000) {
  return new Promise((resolve) => {
    let done = false;
    function finish(val) {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(val);
    }
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') finish(true);
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then(t => {
      if (t.status === 'complete') finish(true);
    }).catch(() => finish(false));
    setTimeout(() => finish(false), timeout);
  });
}

async function ensureTabPageReady(tabId, url, timeout = 15000) {
  const loaded = await waitForTabComplete(tabId, timeout);
  let tabInfo = await chrome.tabs.get(tabId);
  if (isInvalidTabUrl(tabInfo.url)) {
    throw createInvalidSiteError(url || tabInfo.url);
  }
  if (!loaded) {
    throw new Error('页面加载超时');
  }

  const usable = await waitForUsableTabPage(tabId, PAGE_USABLE_TIMEOUT_MS);
  tabInfo = await chrome.tabs.get(tabId);
  if (isInvalidTabUrl(tabInfo.url)) {
    throw createInvalidSiteError(url || tabInfo.url);
  }
  if (!usable) {
    throw new Error('页面空白或无响应');
  }
  return tabInfo;
}

async function waitForUsableTabPage(tabId, timeout = PAGE_USABLE_TIMEOUT_MS) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const body = document.body;
          if (!body) return { usable: false };
          const text = (body.innerText || '').replace(/\s+/g, ' ').trim();
          if (text.length > 0) return { usable: true, reason: 'text' };

          const visibleSelectors = [
            'button',
            'input',
            'textarea',
            'select',
            'a[href]',
            '[role="button"]',
            '[onclick]',
            'iframe',
            'canvas',
            'svg',
            'img[src]',
            'video',
            '[class*="spinner"]',
            '[class*="loading"]',
            '[class*="skeleton"]'
          ].join(', ');
          const candidates = Array.from(document.querySelectorAll(visibleSelectors));
          const hasVisibleElement = candidates.some((el) => {
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.visibility !== 'hidden' &&
              style.display !== 'none' &&
              rect.width > 0 &&
              rect.height > 0;
          });
          return { usable: hasVisibleElement, reason: hasVisibleElement ? 'visible-element' : 'blank' };
        }
      });
      if (results[0]?.result?.usable) return true;
    } catch (e) {
      console.warn('检查页面可用性失败:', e);
      return true;
    }
    await sleep(500);
  }
  return false;
}

// 等待标签页 URL 匹配目标域名
function waitForTabUrlMatch(tabId, domain, timeout = 20000) {
  return new Promise((resolve) => {
    let done = false;
    function finish(val) {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(val);
    }
    function listener(id, info, tab) {
      if (id === tabId && tab.url && tab.url.includes(domain)) finish(true);
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then(t => {
      if (t.url && t.url.includes(domain)) finish(true);
    }).catch(() => {});
    setTimeout(() => finish(false), timeout);
  });
}

function waitForTabUrlChange(tabId, previousUrl, timeout = 10000) {
  return new Promise((resolve) => {
    let done = false;
    function finish(val) {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(val);
    }
    function listener(id, info, tab) {
      if (id === tabId && tab.url && tab.url !== previousUrl) finish(true);
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then(t => {
      if (t.url && t.url !== previousUrl) finish(true);
    }).catch(() => {});
    setTimeout(() => finish(false), timeout);
  });
}

// 自动通过 linux.do OAuth 登录目标站点
async function autoOAuthLogin(domain, visitUrl, tabSession = null, options = {}) {
  const disableSiteLoginFallback = Boolean(options?.disableSiteLoginFallback);
  console.log(`[OAuth] 开始自动登录: ${domain}`);

  // 1. 获取 linuxdo_client_id（在标签页上下文中执行以绕过 Cloudflare）
  let clientId;
  let tab;
  async function fallbackToSiteLogin(reason) {
    if (disableSiteLoginFallback) {
      console.warn(`[OAuth] ${reason}，已禁用站点登录页回退`);
      await closeTabUnlessInSession(tab?.id, tabSession);
      return null;
    }
    console.warn(`[OAuth] ${reason}，改用站点登录页 Linux.do 入口`);
    const fallback = await tryNewApiSiteLoginOAuth(domain, visitUrl, tab, tabSession);
    if (fallback?.headers) return fallback;
    await closeTabUnlessInSession(tab?.id, tabSession);
    return null;
  }

  try {
    // 创建临时后台标签页，避免复用或打断用户正在浏览的页面
    tab = await openSiteSessionTab(tabSession, `https://${domain}/`);

    // 在标签页中执行 fetch 请求
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        try {
          const resp = await fetch('/api/status');
          const data = await resp.json();
          return { success: true, data: data };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }
    });

    const result = results[0]?.result;
    if (!result?.success) {
      console.warn(`[OAuth] 获取 status 失败:`, result?.error);
      return await fallbackToSiteLogin('获取 status 失败');
    }

    clientId = result.data?.data?.linuxdo_client_id || result.data?.linuxdo_client_id;
    if (!clientId) {
      console.warn(`[OAuth] ${domain} 无 linuxdo_client_id`);
      return await fallbackToSiteLogin('无 linuxdo_client_id');
    }
    console.log(`[OAuth] client_id: ${clientId}`);
  } catch (e) {
    console.warn(`[OAuth] 获取 status 失败:`, e);
    return await fallbackToSiteLogin('获取 status 异常');
  }

  // 2. 检查 linux.do 登录状态
  const ldCookies = await chrome.cookies.getAll({ domain: 'linux.do' });
  if (ldCookies.length === 0) {
    console.warn('[OAuth] linux.do 未登录');
    await closeTabUnlessInSession(tab.id, tabSession);
    return null;
  }
  console.log(`[OAuth] linux.do cookies: ${ldCookies.length} 个`);

  // 2.5. 获取 OAuth state (CSRF 保护) - 在标签页中执行以绕过 Cloudflare
  // NewAPI rc.22+：POST /api/oauth/state {provider,intent} -> data.flow_token
  // 旧版：GET /api/oauth/state -> data 为字符串 state
  let state;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        function pickState(payload) {
          if (payload == null) return '';
          if (typeof payload === 'string') return payload.trim();
          if (typeof payload !== 'object') return '';
          const candidates = [
            payload.flow_token,
            payload.state,
            payload.data?.flow_token,
            payload.data?.state,
            typeof payload.data === 'string' ? payload.data : ''
          ];
          for (const candidate of candidates) {
            const text = String(candidate || '').trim();
            if (text) return text;
          }
          return '';
        }

        async function readJson(resp) {
          try {
            return await resp.json();
          } catch (e) {
            return null;
          }
        }

        try {
          // 优先新协议
          const postResp = await fetch('/api/oauth/state', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: 'linuxdo', intent: 'login' })
          });
          const postData = await readJson(postResp);
          const postState = pickState(postData?.data ?? postData);
          if (postResp.ok && postData?.success !== false && postState) {
            return { success: true, state: postState, mode: 'post', data: postData };
          }

          // 兼容旧版 GET
          const getResp = await fetch('/api/oauth/state', { credentials: 'include' });
          const getData = await readJson(getResp);
          const getState = pickState(getData?.data ?? getData);
          if (getResp.ok && getData?.success !== false && getState) {
            return { success: true, state: getState, mode: 'get', data: getData };
          }

          return {
            success: false,
            error: postData?.message || getData?.message || 'Failed to initialize OAuth',
            postStatus: postResp.status,
            getStatus: getResp.status,
            postData,
            getData
          };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }
    });

    const result = results[0]?.result;
    state = String(result?.state || '').trim();
    if (!result?.success || !state) {
      console.warn('[OAuth] 获取 state 失败:', result);
      return await fallbackToSiteLogin('获取 state 失败');
    }
    console.log(`[OAuth] 获取 state(${result.mode || 'unknown'}): ${state}`);
  } catch (e) {
    console.warn('[OAuth] 获取 state 异常:', e);
    return await fallbackToSiteLogin('获取 state 异常');
  }

  // 3. 在同一个标签页中打开 OAuth 授权页面
  const oauthUrl = buildNewApiLinuxDoOAuthUrl(clientId, state);
  console.log(`[OAuth] 打开: ${oauthUrl}`);
  try {
    await chrome.tabs.update(tab.id, { url: oauthUrl });
    console.log(`[OAuth] 使用标签页 ${tab.id} 进行 OAuth 授权`);
  } catch (e) {
    console.warn('[OAuth] 更新标签页失败（已捕获，回退）:', e);
    await closeTabUnlessInSession(tab.id, tabSession);
    return null;
  }

  try {
    // 4. 等待页面加载
    await ensureTabPageReady(tab.id, oauthUrl, 15000);
    await sleep(1000);

    let tabInfo = await chrome.tabs.get(tab.id);
    console.log(`[OAuth] 页面加载完成: ${tabInfo.url}`);

    // 5. 如果还在授权页面，尝试点击"允许"按钮
    if (tabInfo.url && tabInfo.url.includes('connect.linux.do')) {
      console.log('[OAuth] 在授权页面，点击允许按钮...');
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            // 搜索所有可能的按钮元素（包括 a.btn-pill 等链接按钮）
            const btns = document.querySelectorAll('button, input[type="submit"], a[class*="btn"], [role="button"]');
            for (const btn of btns) {
              const text = (btn.textContent || btn.value || '').trim();
              if (/allow|允许|授权|approve|accept|Authorize|同意/i.test(text)) {
                btn.click();
                return 'clicked: ' + text;
              }
            }
            // 回退：查找包含允许文本的任意链接
            const links = document.querySelectorAll('a[href*="approve"], a[href*="authorize"]');
            for (const link of links) {
              link.click();
              return 'clicked approve link: ' + link.href;
            }
            // 回退：提交表单
            const form = document.querySelector('form');
            if (form) {
              const sub = form.querySelector('[type="submit"], button');
              if (sub) { sub.click(); return 'clicked form submit'; }
            }
            return 'no button found';
          }
        });
        console.log('[OAuth] 点击结果:', results[0]?.result);
      } catch (e) {
        console.warn('[OAuth] 注入脚本失败:', e);
      }

      // 等待重定向到目标域名
      const redirected = await waitForTabUrlMatch(tab.id, domain, 20000);
      if (!redirected) {
        console.warn('[OAuth] 重定向超时');
        return await fallbackToSiteLogin('OAuth 重定向超时');
      }
      await ensureTabPageReady(tab.id, `https://${domain}/`, 15000);
      tabInfo = await chrome.tabs.get(tab.id);
      if (isTargetDomainLoginPage(tabInfo.url, domain)) {
        return await fallbackToSiteLogin('OAuth 回跳后进入登录页');
      }
    }

    // 6. 验证已到达目标域名
    tabInfo = await chrome.tabs.get(tab.id);
    if (!tabInfo.url || !tabInfo.url.includes(domain)) {
      console.warn(`[OAuth] 未到达目标域: ${tabInfo.url}`);
      return await fallbackToSiteLogin('OAuth 未到达目标域');
    }
    if (isTargetDomainLoginPage(tabInfo.url, domain)) {
      return await fallbackToSiteLogin('OAuth 停在登录页');
    }
    console.log(`[OAuth] 登录完成: ${tabInfo.url}`);

    // 7. 等待前端 JS 处理 OAuth 回调（交换 code、保存 token 到 localStorage/cookie）
    console.log('[OAuth] 等待前端处理 OAuth 回调...');

    // 7.5. 手动触发 OAuth 回调处理（某些站点的前端 JS 可能不会自动执行）
    let callbackResult = null;
    if (isOfficialPageOAuthPendingUrl(tabInfo.url, domain) || isNewApiOAuthCallbackUrl(tabInfo.url)) {
      callbackResult = await processNewApiOAuthCallback(tab.id, 'OAuth');
      console.log('[OAuth] 手动回调结果:', JSON.stringify({
        success: callbackResult?.success,
        hasUser: callbackResult?.hasUser,
        hasToken: Boolean(callbackResult?.accessToken),
        httpStatus: callbackResult?.httpStatus
      }));
    }

    // 若仍停在回调页，主动进登录后页面，让前端用 refresh cookie 完成 bootstrap
    try {
      const afterCallbackTab = await chrome.tabs.get(tab.id);
      if (isOfficialPageOAuthPendingUrl(afterCallbackTab.url, domain) ||
        isNewApiOAuthCallbackUrl(afterCallbackTab.url) ||
        isTargetDomainLoginPage(afterCallbackTab.url, domain)) {
        const postLoginUrl = getNewApiPostLoginUrl(domain, visitUrl);
        console.log(`[OAuth] 回调后跳转登录后页面: ${postLoginUrl}`);
        await chrome.tabs.update(tab.id, { url: postLoginUrl, active: false });
        await ensureTabPageReady(tab.id, postLoginUrl, 15000);
        await sleep(1500);
      }
    } catch (e) {
      console.warn('[OAuth] 回调后跳转登录后页面失败:', e);
    }

    // 7.6. 验证 session 是否已建立（在页面上下文中检查）
    let sessionEstablished = false;
    for (let retry = 0; retry < 5; retry++) {
      await sleep(2000);
      console.log(`[OAuth] 验证 session 是否建立 (尝试 ${retry + 1}/5)...`);

      try {
        const currentTab = await chrome.tabs.get(tab.id);
        if (isTargetDomainLoginPage(currentTab.url, domain) && retry >= 2) {
          return await fallbackToSiteLogin('验证 session 时进入登录页');
        }

        const session = await inspectNewApiBrowserSession(tab.id);
        console.log(`[OAuth] 页面上下文检查结果:`, JSON.stringify({
          hasUser: session?.hasUser,
          userAuthenticated: session?.userAuthenticated,
          selfStatus: session?.selfStatus,
          hasToken: Boolean(session?.token || session?.accessToken)
        }));
        console.log(`[OAuth] localStorage 有 user 键: ${session?.hasUser}, /api/user/self 已认证: ${session?.userAuthenticated}`);

        if (session?.success && (session.userAuthenticated || hasNewApiUserSession(session))) {
          sessionEstablished = true;
          console.log('[OAuth] session 已建立且用户已登录');
          break;
        }

        // 回调已给出 access_token 时，直接视为可用
        if (callbackResult?.accessToken && retry >= 1) {
          const headers = buildNewApiExistingSessionHeaders({
            token: callbackResult.accessToken,
            user: callbackResult?.apiResponse?.data?.user,
            tabId: tab.id
          });
          if (headers.Authorization) {
            console.log('[OAuth] 使用回调 access_token 构建认证头');
            return { headers, tabId: tab.id };
          }
        }

        if (session?.success) {
          console.log('[OAuth] 尚未检测到已登录用户 session，继续等待...');
        }
      } catch (e) {
        console.warn(`[OAuth] 验证失败:`, e.message);
      }
    }

    if (!sessionEstablished) {
      console.warn('[OAuth] session 未建立，OAuth 可能失败');
      return await fallbackToSiteLogin('session 未建立');
    }

    const built = await collectNewApiAuthHeadersFromCandidates(domain, visitUrl, tab.id, 'OAuth');
    if (!built?.headers) {
      console.warn('[OAuth] 未能基于已建立的 session 构建认证头');
      return await fallbackToSiteLogin('未能构建认证头');
    }

    console.log('[OAuth] 已构建认证头:', JSON.stringify(Object.keys(built.headers)));
    return { headers: built.headers, tabId: tab.id };
  } catch (e) {
    console.warn('[OAuth] 失败（已捕获，回退）:', e);
    await closeTabUnlessInSession(tab?.id, tabSession);
    return null;
  }
}

async function createTemporaryBackgroundTab(url, timeout = 15000) {
  const tab = await chrome.tabs.create(getTemporaryCheckInTabCreateOptions(url));
  try {
    const tabInfo = await ensureTabPageReady(tab.id, url, timeout);
    tabInfo._autoCreated = true;
    return tabInfo;
  } catch (e) {
    await closeTabQuietly(tab.id);
    throw e;
  }
}

function createSiteTabSession() {
  let tabId = null;
  return {
    owns(id) {
      return Boolean(tabId && id && tabId === id);
    },
    async open(url, timeout = 15000) {
      if (!tabId) {
        const tab = await createTemporaryBackgroundTab(url, timeout);
        tabId = tab.id;
        return tab;
      }

      try {
        await chrome.tabs.get(tabId);
      } catch (e) {
        tabId = null;
        const tab = await createTemporaryBackgroundTab(url, timeout);
        tabId = tab.id;
        return tab;
      }

      try {
        await chrome.tabs.update(tabId, { url, active: false });
        const tabInfo = await ensureTabPageReady(tabId, url, timeout);
        tabInfo._autoCreated = true;
        return tabInfo;
      } catch (e) {
        await closeTabQuietly(tabId);
        tabId = null;
        throw e;
      }
    },
    async close() {
      if (!tabId) return;
      const id = tabId;
      tabId = null;
      await closeTabQuietly(id);
    }
  };
}

async function openSiteSessionTab(tabSession, url, timeout = 15000) {
  if (tabSession) {
    return tabSession.open(url, timeout);
  }
  return createTemporaryBackgroundTab(url, timeout);
}

async function closeTabUnlessInSession(tabId, tabSession = null) {
  if (!tabId) return;
  if (tabSession?.owns(tabId)) return;
  await closeTabQuietly(tabId);
}

async function closeTabQuietly(tabId) {
  if (!tabId) return;
  try { await chrome.tabs.remove(tabId); } catch (e) {}
}

// 发送通知
// 发送单个站点签到结果通知
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getFallbackAutoSignTime(data = {}) {
  return isValidAutoSignTime(data.autoSignTime)
    ? data.autoSignTime
    : GLOBAL_CONFIG.autoSignTime;
}

function sanitizeGroupAutoSignTimes(value) {
  return Object.fromEntries(
    Object.entries(normalizeGroupAutoSignTimes(value))
      .filter(([, time]) => isValidAutoSignTime(time))
  );
}

function resolveGroupAutoSignTime(groupAutoSignTimes, group, fallbackAutoSignTime) {
  const time = getGroupAutoSignTime(groupAutoSignTimes, group, fallbackAutoSignTime);
  return isValidAutoSignTime(time) ? time : fallbackAutoSignTime;
}

async function updateGroupAutoSignTime(group, time) {
  const normalizedGroup = normalizeSiteGroup(group);
  const [sites, data] = await Promise.all([
    loadRawSites(),
    chrome.storage.local.get([GROUP_AUTO_SIGN_TIMES_STORAGE_KEY, 'autoSignTime'])
  ]);
  const previousFallback = getFallbackAutoSignTime(data);
  const currentTimes = fillMissingGroupAutoSignTimes(
    sites,
    sanitizeGroupAutoSignTimes(data[GROUP_AUTO_SIGN_TIMES_STORAGE_KEY]),
    previousFallback
  );
  const entries = new Map(Object.entries(currentTimes));
  entries.set(normalizedGroup, time);
  const groupAutoSignTimes = Object.fromEntries(entries);
  const fallbackAutoSignTime = normalizedGroup === '' ? time : previousFallback;
  const updates = { [GROUP_AUTO_SIGN_TIMES_STORAGE_KEY]: groupAutoSignTimes };
  if (normalizedGroup === '') updates.autoSignTime = time;

  await chrome.storage.local.set(updates);
  const schedule = await refreshGroupCheckInSchedules();
  return {
    group: normalizedGroup,
    autoSignTime: time,
    fallbackAutoSignTime,
    groupAutoSignTimes: schedule?.groupAutoSignTimes || groupAutoSignTimes
  };
}

async function updateAllGroupAutoSignTimes(groupAutoSignTimes, autoSignTime) {
  const current = await chrome.storage.local.get('autoSignTime');
  const fallbackAutoSignTime = isValidAutoSignTime(autoSignTime)
    ? autoSignTime
    : getFallbackAutoSignTime(current);
  const normalizedTimes = sanitizeGroupAutoSignTimes(groupAutoSignTimes);

  await chrome.storage.local.set({
    autoSignTime: fallbackAutoSignTime,
    [GROUP_AUTO_SIGN_TIMES_STORAGE_KEY]: normalizedTimes
  });
  const schedule = await refreshGroupCheckInSchedules();
  return {
    autoSignTime: fallbackAutoSignTime,
    fallbackAutoSignTime,
    groupAutoSignTimes: schedule?.groupAutoSignTimes || normalizedTimes
  };
}

async function clearGroupCheckInAlarms() {
  const alarms = await chrome.alarms.getAll();
  const names = alarms
    .map(alarm => alarm.name)
    .filter(name => name === DAILY_CHECK_IN_ALARM || String(name).startsWith(GROUP_CHECK_IN_ALARM_PREFIX));
  await Promise.all(names.map(name => chrome.alarms.clear(name)));
}

async function scheduleAllGroupCheckIns() {
  const [sites, data] = await Promise.all([
    loadRawSites(),
    chrome.storage.local.get([GROUP_AUTO_SIGN_TIMES_STORAGE_KEY, 'autoSignTime'])
  ]);
  const fallbackAutoSignTime = getFallbackAutoSignTime(data);
  const storedGroupAutoSignTimes = sanitizeGroupAutoSignTimes(data[GROUP_AUTO_SIGN_TIMES_STORAGE_KEY]);
  const groupAutoSignTimes = fillMissingGroupAutoSignTimes(
    sites,
    storedGroupAutoSignTimes,
    fallbackAutoSignTime
  );
  const groups = groupSitesByGroup(sites).filter(item => (
    item.sites.some(site => site?.enabled !== false)
  ));
  if (JSON.stringify(groupAutoSignTimes) !== JSON.stringify(storedGroupAutoSignTimes)) {
    await chrome.storage.local.set({ [GROUP_AUTO_SIGN_TIMES_STORAGE_KEY]: groupAutoSignTimes });
  }

  await clearGroupCheckInAlarms();
  for (const item of groups) {
    const time = resolveGroupAutoSignTime(groupAutoSignTimes, item.group, fallbackAutoSignTime);
    await chrome.alarms.create(getGroupCheckInAlarmName(item.group), {
      when: getNextCheckInTimeFor(time),
      periodInMinutes: 24 * 60
    });
    console.log(`${getCheckInGroupLabel(item.group)}分组每日签到时间已设置为 ${time}`);
  }

  return { fallbackAutoSignTime, groupAutoSignTimes };
}

function refreshGroupCheckInSchedules() {
  groupScheduleRefreshRequested = true;
  if (groupScheduleRefreshPromise) return groupScheduleRefreshPromise;

  groupScheduleRefreshPromise = (async () => {
    let schedule;
    do {
      groupScheduleRefreshRequested = false;
      schedule = await scheduleAllGroupCheckIns();
    } while (groupScheduleRefreshRequested);
    return schedule;
  })().finally(() => {
    groupScheduleRefreshPromise = null;
  });
  return groupScheduleRefreshPromise;
}

function enqueueScheduledGroupCheckIn(group) {
  const normalizedGroup = normalizeSiteGroup(group);
  scheduledCheckInQueue = scheduledCheckInQueue
    .catch(() => {})
    .then(async () => {
      if (batchCheckIn) {
        try {
          await batchCheckIn.promise;
        } catch (error) {}
      }
      console.log(`开始执行 ${getCheckInGroupLabel(normalizedGroup)}分组定时签到`);
      return startCheckInRun('schedule', { group: normalizedGroup });
    })
    .catch(async error => {
      console.warn(`${getCheckInGroupLabel(normalizedGroup)}分组定时签到失败:`, error);
      try {
        await appendCheckInLog(
          '系统',
          '未知',
          `${getCheckInGroupLabel(normalizedGroup)}分组定时签到失败：${error.message}`
        );
      } catch (logError) {}
    });
  return scheduledCheckInQueue;
}
