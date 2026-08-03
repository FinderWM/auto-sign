(function(root) {
  function buildCheckInRunningState({ total = 0, current = 0, currentSiteId = null, source = 'manual' } = {}) {
    return {
      running: true,
      source,
      total,
      current,
      currentSiteId,
      startedAt: new Date().toISOString()
    };
  }

  function isCheckInRunningState(state) {
    return state?.running === true;
  }

  function clearCheckInRunningState(state = {}) {
    return {
      ...state,
      running: false,
      finishedAt: new Date().toISOString()
    };
  }

  function getCheckInRunState(data = {}) {
    return data.checkInRunState || { running: false };
  }

  function countEnabledSites(sites = []) {
    if (!Array.isArray(sites)) return 0;
    return sites.filter(site => site?.enabled !== false).length;
  }

  function canStartCheckIn(sites = [], runState = {}) {
    return countEnabledSites(sites) > 0 && !isCheckInRunningState(runState);
  }

  function canClickCheckInButton(sites = [], runState = {}) {
    return isCheckInRunningState(runState) || canStartCheckIn(sites, runState);
  }

  function markSiteChecking(results = {}, siteId) {
    if (!siteId) return { ...results };
    return {
      ...results,
      [siteId]: {
        status: 'checking',
        message: '签到中'
      }
    };
  }

  function clearResultBalances(results = {}) {
    const next = {};
    for (const [siteId, result] of Object.entries(results || {})) {
      if (!result || typeof result !== 'object') {
        next[siteId] = result;
        continue;
      }
      const { balance, ...rest } = result;
      next[siteId] = rest;
    }
    return next;
  }

  function normalizeCheckInResultsForRun(results = {}) {
    const normalized = {};
    for (const [siteId, result] of Object.entries(results)) {
      normalized[siteId] = result?.status === 'checking'
        ? { status: 'failed', message: '签到中断' }
        : result;
    }
    return normalized;
  }

  root.buildCheckInRunningState = buildCheckInRunningState;
  root.isCheckInRunningState = isCheckInRunningState;
  root.clearCheckInRunningState = clearCheckInRunningState;
  root.getCheckInRunState = getCheckInRunState;
  root.countEnabledSites = countEnabledSites;
  root.canStartCheckIn = canStartCheckIn;
  root.canClickCheckInButton = canClickCheckInButton;
  root.markSiteChecking = markSiteChecking;
  root.clearResultBalances = clearResultBalances;
  root.normalizeCheckInResultsForRun = normalizeCheckInResultsForRun;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      buildCheckInRunningState,
      isCheckInRunningState,
      clearCheckInRunningState,
      getCheckInRunState,
      countEnabledSites,
      canStartCheckIn,
      canClickCheckInButton,
      markSiteChecking,
      clearResultBalances,
      normalizeCheckInResultsForRun
    };
  }
})(typeof self !== 'undefined' ? self : globalThis);
