(function(root) {
  const SOTA_AGENT_DOMAIN = 'www.sotamodel.net';
  const SOTA_AGENT_PAGE_PATH = '/agents';
  const SOTA_AGENT_CHECK_IN_PATH = '/api/user/sota-agent-checkin';
  const SOTA_AGENT_USER_HEADER = 'New-Api-User';

  function isSotaAgentDomain(domain) {
    return String(domain || '').trim().toLowerCase() === SOTA_AGENT_DOMAIN;
  }

  function getSotaAgentCheckedInToday(data) {
    return data?.checked_in_today === true ||
      data?.data?.checked_in_today === true ||
      data?.data?.status?.checked_in_today === true ||
      data?.status?.checked_in_today === true;
  }

  function getSotaAgentReward(data) {
    const candidates = [
      data?.reward,
      data?.data?.reward,
      data?.data?.reward_amount,
      data?.reward_amount
    ];
    for (const candidate of candidates) {
      if (!['number', 'string'].includes(typeof candidate) || String(candidate).trim() === '') continue;
      const value = Number(candidate);
      if (Number.isFinite(value)) return value;
    }
    return null;
  }

  function getSotaAgentMessage(data) {
    const candidates = [
      data?.message,
      data?.msg,
      data?.error,
      data?.data?.message,
      data?.data?.msg
    ];
    for (const candidate of candidates) {
      const message = String(candidate || '').trim();
      if (message) return message;
    }
    return '';
  }

  function formatSotaAgentReward(reward) {
    if (!Number.isFinite(reward)) return '';
    return Number.isInteger(reward) ? String(reward) : reward.toFixed(2);
  }

  function parseSotaAgentResponse(rawResult, method = 'GET') {
    const normalizedMethod = String(method || 'GET').toUpperCase();
    const httpStatus = Number(rawResult?.httpStatus) || 0;
    const data = rawResult?.data;
    const apiMessage = getSotaAgentMessage(data);
    const normalizedMessage = apiMessage.toLowerCase();
    const missingUserHeader = rawResult?.missingUid === true ||
      /new-api-user|missing user header|缺少.*用户.*请求头/.test(normalizedMessage);
    const unauthenticated = missingUserHeader ||
      httpStatus === 401 ||
      httpStatus === 403 ||
      /unauthorized|unauthenticated|not logged in|未登录|请登录/.test(normalizedMessage);

    if (rawResult?.invalidSite || httpStatus === 404 || httpStatus === 410) {
      return {
        success: false,
        alreadyCheckedIn: false,
        invalidSite: true,
        message: 'Sota Agent 签到接口失效',
        httpStatus,
        data
      };
    }

    if (unauthenticated) {
      return {
        success: false,
        alreadyCheckedIn: false,
        unauthenticated: true,
        message: rawResult?.missingUid ? 'Sota Agent 页面缺少登录态' : (apiMessage || 'Sota Agent 登录态已失效'),
        httpStatus,
        data
      };
    }

    if (rawResult?.error) {
      return {
        success: false,
        alreadyCheckedIn: false,
        message: rawResult.error,
        error: rawResult.error,
        httpStatus,
        data
      };
    }

    const httpOk = httpStatus >= 200 && httpStatus < 300;
    const checkedInToday = getSotaAgentCheckedInToday(data);
    const negatedCheckedIn = /\b(?:not|never|haven't|hasn't)\b.{0,32}\bchecked in\b/i.test(apiMessage);
    const alreadyByMessage = !negatedCheckedIn && /already checked|checked in today|already signed/i.test(apiMessage);
    const alreadyCheckedIn = httpOk && (
      normalizedMethod === 'GET'
        ? checkedInToday || alreadyByMessage
        : alreadyByMessage
    );
    const reward = getSotaAgentReward(data);
    const rewardText = formatSotaAgentReward(reward);

    if (alreadyCheckedIn) {
      return {
        success: true,
        alreadyCheckedIn: true,
        authenticated: true,
        message: rewardText ? `今日已签到，奖励 $${rewardText}` : (apiMessage || '今日已签到'),
        httpStatus,
        data,
        reward
      };
    }

    if (normalizedMethod === 'GET' && httpOk) {
      return {
        success: false,
        alreadyCheckedIn: false,
        authenticated: true,
        message: apiMessage || '待签到',
        httpStatus,
        data
      };
    }

    const explicitSuccess = data?.success === true ||
      data?.code === 0 ||
      data?.status === 'success' ||
      data?.ok === true ||
      /check-?in successful|successfully checked in|签到成功/.test(normalizedMessage);
    const explicitFailure = data?.success === false || data?.ok === false;
    const success = normalizedMethod === 'POST' && httpOk && !explicitFailure &&
      (explicitSuccess || checkedInToday || Number.isFinite(reward));

    return {
      success,
      alreadyCheckedIn: false,
      authenticated: httpOk,
      message: success
        ? (rewardText ? `签到成功，获得 $${rewardText}` : (apiMessage || '签到成功'))
        : (apiMessage || `Sota Agent 签到失败（HTTP ${httpStatus || 0}）`),
      httpStatus,
      data,
      reward
    };
  }

  async function requestSotaAgentInPage(method, endpoint, userHeaderName, timeoutMs = 30000) {
    const normalizedMethod = String(method || 'GET').toUpperCase();
    const uid = String(localStorage.getItem('uid') || '').trim();
    if (!uid) {
      return { missingUid: true, hasUid: false, httpStatus: 0, data: null };
    }

    try {
      const headers = {
        Accept: 'application/json',
        [userHeaderName]: uid
      };
      const options = {
        method: normalizedMethod,
        credentials: 'include',
        cache: 'no-store',
        headers
      };
      if (normalizedMethod === 'POST') {
        headers['Content-Type'] = 'application/json';
        options.body = '{}';
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetch(endpoint, { ...options, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      if (!contentType.includes('application/json')) {
        return {
          hasUid: true,
          httpStatus: response.status,
          invalidSite: response.status === 404 || response.status === 410,
          error: 'Sota Agent 接口响应不是 JSON',
          data: null
        };
      }

      let data = null;
      try {
        data = JSON.parse(await response.text());
      } catch (e) {
        return {
          hasUid: true,
          httpStatus: response.status,
          error: 'Sota Agent 接口响应解析失败',
          data: null
        };
      }

      return {
        hasUid: true,
        httpStatus: response.status,
        invalidSite: response.status === 404 || response.status === 410,
        data
      };
    } catch (e) {
      return {
        hasUid: true,
        httpStatus: 0,
        error: e?.name === 'AbortError' ? 'Sota Agent 请求超时' : (e?.message || 'Sota Agent 请求失败'),
        data: null
      };
    }
  }

  async function runSotaAgentCheckInFlow(request, onResponse = null) {
    if (typeof request !== 'function') {
      throw new TypeError('Sota Agent 请求函数无效');
    }

    const perform = async (stage, method) => {
      const rawResult = await request(method);
      if (typeof onResponse === 'function') onResponse(stage, rawResult);
      return parseSotaAgentResponse(rawResult, method);
    };

    const statusResult = await perform('GET 状态查询', 'GET');
    if (statusResult.alreadyCheckedIn || statusResult.invalidSite) {
      return {
        execResult: statusResult,
        queryVerified: statusResult.alreadyCheckedIn,
        shouldFallback: false
      };
    }
    if (!statusResult.authenticated) {
      return { execResult: statusResult, queryVerified: false, shouldFallback: true };
    }

    let execResult = await perform('POST 签到', 'POST');
    const verifyResult = await perform('GET 结果确认', 'GET');
    if (verifyResult.alreadyCheckedIn) {
      if (!execResult.success) {
        execResult = {
          ...verifyResult,
          alreadyCheckedIn: false,
          message: '签到成功，状态查询已确认'
        };
      }
      return { execResult, queryVerified: true, shouldFallback: false };
    }
    if (execResult.success || execResult.invalidSite) {
      return { execResult, queryVerified: false, shouldFallback: false };
    }
    return { execResult, queryVerified: false, shouldFallback: true };
  }

  root.SOTA_AGENT_CHECK_IN_PATH = SOTA_AGENT_CHECK_IN_PATH;
  root.SOTA_AGENT_DOMAIN = SOTA_AGENT_DOMAIN;
  root.SOTA_AGENT_PAGE_PATH = SOTA_AGENT_PAGE_PATH;
  root.SOTA_AGENT_USER_HEADER = SOTA_AGENT_USER_HEADER;
  root.isSotaAgentDomain = isSotaAgentDomain;
  root.parseSotaAgentResponse = parseSotaAgentResponse;
  root.requestSotaAgentInPage = requestSotaAgentInPage;
  root.runSotaAgentCheckInFlow = runSotaAgentCheckInFlow;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      SOTA_AGENT_CHECK_IN_PATH,
      SOTA_AGENT_DOMAIN,
      SOTA_AGENT_PAGE_PATH,
      SOTA_AGENT_USER_HEADER,
      isSotaAgentDomain,
      parseSotaAgentResponse,
      requestSotaAgentInPage,
      runSotaAgentCheckInFlow
    };
  }
})(typeof self !== 'undefined' ? self : globalThis);
