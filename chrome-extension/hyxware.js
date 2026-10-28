(function(root) {
  const HYXWARE_DOMAIN = 'hyxware.com';
  const HYXWARE_PAGE_PATH = '/topup';
  const HYXWARE_CHECK_IN_PATH = '/api/user/checkin';
  const HYXWARE_REFRESH_PATH = '/api/user/auth/refresh';
  const HYXWARE_USER_PATH = '/api/user/self';
  // HyxAPI 与 NewAPI 一致：500000 quota 记作 1 USD
  const HYXWARE_QUOTA_UNIT = 500000;

  function isHyxwareDomain(domain) {
    return String(domain || '').trim().toLowerCase() === HYXWARE_DOMAIN;
  }

  function getHyxwarePayload(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    if (data.data && typeof data.data === 'object' && !Array.isArray(data.data)) {
      return data.data;
    }
    return data;
  }

  function getHyxwareMessage(data) {
    if (!data || typeof data !== 'object') return '';
    const candidates = [data.message, data.msg, data.error, data.detail, data.data?.message, data.data?.msg];
    for (const candidate of candidates) {
      const message = String(candidate || '').trim();
      if (message) return message;
    }
    return '';
  }

  function getHyxwareAccessToken(data) {
    const payload = getHyxwarePayload(data);
    const candidates = [
      payload?.access_token,
      payload?.accessToken,
      payload?.token,
      data?.access_token,
      data?.accessToken
    ];
    for (const candidate of candidates) {
      const token = String(candidate || '').trim();
      if (token) return token;
    }
    return '';
  }

  function getHyxwareCheckedIn(data) {
    const payload = getHyxwarePayload(data);
    if (!payload) return false;
    return payload.stats?.checked_in_today === true ||
      payload.checked_in_today === true ||
      payload.today?.checked_in === true;
  }

  function getHyxwareEnabled(data) {
    const payload = getHyxwarePayload(data);
    if (!payload || typeof payload !== 'object') return true;
    return payload.enabled !== false;
  }

  function getHyxwareReward(data) {
    const payload = getHyxwarePayload(data);
    const candidates = [
      payload?.quota_awarded,
      payload?.reward,
      data?.quota_awarded
    ];
    for (const candidate of candidates) {
      if (candidate === null || candidate === undefined || candidate === '') continue;
      const value = Number(candidate);
      if (Number.isFinite(value)) return value;
    }
    return null;
  }

  function getHyxwareQuota(data) {
    const payload = getHyxwarePayload(data);
    const candidates = [payload?.quota, payload?.user?.quota, data?.quota];
    for (const candidate of candidates) {
      if (candidate === null || candidate === undefined || candidate === '') continue;
      const value = Number(candidate);
      if (Number.isFinite(value)) return value;
    }
    return null;
  }

  function formatHyxwareQuota(value) {
    if (!Number.isFinite(value)) return '';
    return `$${(value / HYXWARE_QUOTA_UNIT).toFixed(2)}`;
  }

  function getHyxwareCurrentMonth(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }

  function parseHyxwareRefreshResponse(rawResult) {
    const httpStatus = Number(rawResult?.httpStatus) || 0;
    const data = rawResult?.data;
    const accessToken = getHyxwareAccessToken(data);
    const httpOk = httpStatus >= 200 && httpStatus < 300;

    if (httpOk && accessToken) {
      return { success: true, authenticated: true, accessToken, httpStatus, data };
    }
    if (rawResult?.error) {
      return {
        success: false,
        authenticated: false,
        message: rawResult.error,
        error: rawResult.error,
        httpStatus,
        data
      };
    }
    return {
      success: false,
      authenticated: false,
      unauthenticated: httpStatus === 401 || httpStatus === 403,
      message: getHyxwareMessage(data) || `HyxAPI 登录态刷新失败（HTTP ${httpStatus || 0}）`,
      httpStatus,
      data
    };
  }

  function parseHyxwareQuotaResponse(rawResult) {
    const httpStatus = Number(rawResult?.httpStatus) || 0;
    const httpOk = httpStatus >= 200 && httpStatus < 300;
    return {
      authenticated: httpOk,
      quota: httpOk ? getHyxwareQuota(rawResult?.data) : null,
      httpStatus,
      data: rawResult?.data
    };
  }

  function parseHyxwareResponse(rawResult, method = 'GET') {
    const normalizedMethod = String(method || 'GET').toUpperCase();
    const httpStatus = Number(rawResult?.httpStatus) || 0;
    const data = rawResult?.data;
    const apiMessage = getHyxwareMessage(data);
    const apiRejected = data && typeof data === 'object' && data.success === false;
    const unauthenticated = rawResult?.missingToken === true ||
      httpStatus === 401 ||
      httpStatus === 403 ||
      /unauthorized|invalid access token|not logged in|未登录|请登录|登录已过期|登录已失效|登录状态已失效/i.test(apiMessage);

    if (rawResult?.invalidSite || httpStatus === 404 || httpStatus === 410) {
      return {
        success: false,
        alreadyCheckedIn: false,
        invalidSite: true,
        message: 'HyxAPI 签到接口失效',
        httpStatus,
        data
      };
    }

    if (unauthenticated) {
      return {
        success: false,
        alreadyCheckedIn: false,
        unauthenticated: true,
        message: rawResult?.missingToken ? 'HyxAPI 页面缺少登录态' : (apiMessage || 'HyxAPI 登录态已失效'),
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
    const checkedIn = getHyxwareCheckedIn(data);
    const enabled = getHyxwareEnabled(data);
    const reward = getHyxwareReward(data);
    const quota = getHyxwareQuota(data);
    const alreadyText = /already|已签到|已经签到|重复签到|今日已签/i.test(apiMessage);
    const rewardText = formatHyxwareQuota(reward);

    if (normalizedMethod === 'GET') {
      if (httpOk && !apiRejected && checkedIn) {
        return {
          success: true,
          alreadyCheckedIn: true,
          authenticated: true,
          message: '今日已签到',
          httpStatus,
          data,
          reward,
          quota
        };
      }
      if (httpOk && !apiRejected) {
        return {
          success: false,
          alreadyCheckedIn: false,
          authenticated: true,
          disabled: enabled === false,
          message: enabled === false ? '站点未开启签到' : '待签到',
          httpStatus,
          data,
          reward,
          quota
        };
      }
      return {
        success: false,
        alreadyCheckedIn: false,
        authenticated: false,
        message: apiMessage || `HyxAPI 状态查询失败（HTTP ${httpStatus || 0}）`,
        httpStatus,
        data
      };
    }

    if (httpOk && checkedIn) {
      return {
        success: true,
        alreadyCheckedIn: true,
        authenticated: true,
        message: '今日已签到',
        httpStatus,
        data,
        reward,
        quota
      };
    }

    const payload = getHyxwarePayload(data);
    const success = httpOk && !apiRejected &&
      (data?.success === true || Number.isFinite(reward) || Boolean(payload?.checkin_date));
    return {
      success,
      alreadyCheckedIn: alreadyText,
      authenticated: httpOk,
      message: success
        ? (rewardText ? `签到成功 +${rewardText}` : '签到成功')
        : (alreadyText ? '今日已签到' : (apiMessage || `HyxAPI 签到失败（HTTP ${httpStatus || 0}）`)),
      httpStatus,
      data,
      reward,
      quota
    };
  }

  // 页面上下文发请求：HyxAPI 只把 access token 放在内存（不落 localStorage），
  // 必须先用 Cookie 会话调用 /api/user/auth/refresh 现场换一个 Bearer token。
  async function requestHyxwareInPage(method, endpoint, token, timeoutMs = 30000) {
    const normalizedMethod = String(method || 'GET').toUpperCase();
    const isRefresh = normalizedMethod === 'REFRESH';
    const accessToken = String(token || '').trim();

    if (!isRefresh && !accessToken) {
      return { missingToken: true, httpStatus: 0, data: null };
    }

    let timer = null;
    try {
      const url = new URL(endpoint, location.origin).toString();
      const headers = { Accept: 'application/json' };
      const options = {
        method: isRefresh ? 'POST' : normalizedMethod,
        credentials: 'include',
        cache: 'no-store',
        headers
      };
      if (!isRefresh) {
        headers.Authorization = `Bearer ${accessToken}`;
        if (normalizedMethod !== 'GET') {
          headers['Content-Type'] = 'application/json';
          options.body = '{}';
        }
      }

      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetch(url, { ...options, signal: controller.signal });

      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      if (!contentType.includes('application/json')) {
        return {
          httpStatus: response.status,
          invalidSite: response.status === 404 || response.status === 410,
          error: 'HyxAPI 接口响应不是 JSON',
          data: null
        };
      }

      const text = await response.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch (e) {
        return {
          httpStatus: response.status,
          error: 'HyxAPI 接口响应解析失败',
          data: null
        };
      }

      return {
        httpStatus: response.status,
        invalidSite: response.status === 404 || response.status === 410,
        hasToken: Boolean(accessToken),
        data
      };
    } catch (e) {
      return {
        httpStatus: 0,
        error: e?.name === 'AbortError' ? 'HyxAPI 请求超时' : (e?.message || 'HyxAPI 请求失败'),
        data: null
      };
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  async function attachHyxwareQuota(execResult, request, token, onResponse) {
    const rawResult = await request('GET', HYXWARE_USER_PATH, token);
    if (typeof onResponse === 'function') onResponse('GET 余额查询', rawResult);
    const quotaResult = parseHyxwareQuotaResponse(rawResult);
    if (Number.isFinite(quotaResult.quota)) execResult.quota = quotaResult.quota;
    return execResult;
  }

  // 流程：refresh 换取 token → GET 状态 → 未签则 POST → GET 复核 → 读取余额
  async function runHyxwareCheckInFlow(request, onResponse = null, now = new Date()) {
    if (typeof request !== 'function') {
      throw new TypeError('HyxAPI 请求函数无效');
    }

    const perform = async (stage, method, endpoint, token) => {
      const rawResult = await request(method, endpoint, token);
      if (typeof onResponse === 'function') onResponse(stage, rawResult);
      return parseHyxwareResponse(rawResult, method);
    };
    const month = getHyxwareCurrentMonth(now);
    const statusEndpoint = `${HYXWARE_CHECK_IN_PATH}?month=${month}`;

    const refreshRaw = await request('REFRESH', HYXWARE_REFRESH_PATH, '');
    if (typeof onResponse === 'function') onResponse('登录态刷新', refreshRaw);
    const refreshResult = parseHyxwareRefreshResponse(refreshRaw);
    if (!refreshResult.authenticated) {
      return { execResult: refreshResult, queryVerified: false, shouldFallback: true };
    }
    const token = refreshResult.accessToken;

    let execResult = await perform('GET 状态查询', 'GET', statusEndpoint, token);
    if (execResult.invalidSite) {
      return { execResult, queryVerified: false, shouldFallback: false };
    }
    if (execResult.alreadyCheckedIn) {
      await attachHyxwareQuota(execResult, request, token, onResponse);
      return { execResult, queryVerified: true, shouldFallback: false };
    }
    if (!execResult.authenticated || execResult.disabled) {
      return {
        execResult,
        queryVerified: false,
        shouldFallback: !execResult.disabled
      };
    }

    execResult = await perform('POST 签到', 'POST', HYXWARE_CHECK_IN_PATH, token);
    const verifyResult = await perform('GET 结果确认', 'GET', statusEndpoint, token);
    if (verifyResult.alreadyCheckedIn) {
      if (!execResult.success) {
        execResult = {
          ...verifyResult,
          alreadyCheckedIn: false,
          message: '签到成功，状态查询已确认'
        };
      }
      await attachHyxwareQuota(execResult, request, token, onResponse);
      return { execResult, queryVerified: true, shouldFallback: false };
    }
    if (execResult.success || execResult.invalidSite) {
      await attachHyxwareQuota(execResult, request, token, onResponse);
      return { execResult, queryVerified: false, shouldFallback: false };
    }
    return { execResult, queryVerified: false, shouldFallback: true };
  }

  root.HYXWARE_CHECK_IN_PATH = HYXWARE_CHECK_IN_PATH;
  root.HYXWARE_DOMAIN = HYXWARE_DOMAIN;
  root.HYXWARE_PAGE_PATH = HYXWARE_PAGE_PATH;
  root.HYXWARE_REFRESH_PATH = HYXWARE_REFRESH_PATH;
  root.HYXWARE_USER_PATH = HYXWARE_USER_PATH;
  root.formatHyxwareQuota = formatHyxwareQuota;
  root.getHyxwareCurrentMonth = getHyxwareCurrentMonth;
  root.isHyxwareDomain = isHyxwareDomain;
  root.parseHyxwareRefreshResponse = parseHyxwareRefreshResponse;
  root.parseHyxwareResponse = parseHyxwareResponse;
  root.requestHyxwareInPage = requestHyxwareInPage;
  root.runHyxwareCheckInFlow = runHyxwareCheckInFlow;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      HYXWARE_CHECK_IN_PATH,
      HYXWARE_DOMAIN,
      HYXWARE_PAGE_PATH,
      HYXWARE_REFRESH_PATH,
      HYXWARE_USER_PATH,
      formatHyxwareQuota,
      getHyxwareCurrentMonth,
      isHyxwareDomain,
      parseHyxwareRefreshResponse,
      parseHyxwareResponse,
      requestHyxwareInPage,
      runHyxwareCheckInFlow
    };
  }
})(typeof self !== 'undefined' ? self : globalThis);
