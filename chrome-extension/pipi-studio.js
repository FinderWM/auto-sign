(function(root) {
  const PIPI_STUDIO_DOMAIN = 'img.pipiwangcom.com';
  const PIPI_STUDIO_PAGE_PATH = '/';
  const PIPI_STUDIO_CHECK_IN_PATH = '/api/v1/pc/checkin';
  const PIPI_STUDIO_ME_PATH = '/api/v1/pc/me';
  const PIPI_STUDIO_TOKEN_KEY = 'pipi_pc_token';

  function isPipiStudioDomain(domain) {
    return String(domain || '').trim().toLowerCase() === PIPI_STUDIO_DOMAIN;
  }

  function getPipiStudioCheckedIn(data) {
    return data?.already === true ||
      data?.checkedIn === true ||
      data?.checked_in === true ||
      data?.quota?.checkedIn === true ||
      data?.data?.checkedIn === true ||
      data?.data?.quota?.checkedIn === true;
  }

  // 积分钱包余额：payload.points 优先，其次 quota.points
  function getPipiStudioPoints(data) {
    const candidates = [data?.points, data?.quota?.points, data?.data?.points, data?.data?.quota?.points];
    for (const candidate of candidates) {
      if (candidate === null || candidate === undefined || candidate === '') continue;
      const value = Number(candidate);
      if (Number.isFinite(value)) return value;
    }
    return null;
  }

  // 本次签到奖励积分：grantedPoints
  function getPipiStudioReward(data) {
    const candidates = [data?.grantedPoints, data?.granted_points, data?.data?.grantedPoints, data?.reward];
    for (const candidate of candidates) {
      if (!['number', 'string'].includes(typeof candidate) || String(candidate).trim() === '') continue;
      const value = Number(candidate);
      if (Number.isFinite(value)) return value;
    }
    return null;
  }

  function getPipiStudioMessage(data) {
    const candidates = [data?.detail, data?.message, data?.msg, data?.error, data?.data?.detail, data?.data?.message];
    for (const candidate of candidates) {
      const message = String(candidate || '').trim();
      if (message) return message;
    }
    return '';
  }

  function formatPipiStudioPoints(value) {
    if (!Number.isFinite(value)) return '';
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }

  function parsePipiStudioResponse(rawResult, method = 'GET') {
    const normalizedMethod = String(method || 'GET').toUpperCase();
    const httpStatus = Number(rawResult?.httpStatus) || 0;
    const data = rawResult?.data;
    const apiMessage = getPipiStudioMessage(data);
    const missingToken = rawResult?.missingToken === true;
    const unauthenticated = missingToken ||
      httpStatus === 401 ||
      httpStatus === 403 ||
      /登录已失效|登录已过期|未登录|请登录|unauthorized|unauthenticated|not logged in/i.test(apiMessage);

    if (rawResult?.invalidSite || httpStatus === 404 || httpStatus === 410) {
      return {
        success: false,
        alreadyCheckedIn: false,
        invalidSite: true,
        message: '皮皮智绘签到接口失效',
        httpStatus,
        data
      };
    }

    if (unauthenticated) {
      return {
        success: false,
        alreadyCheckedIn: false,
        unauthenticated: true,
        message: missingToken ? '皮皮智绘页面缺少登录态' : (apiMessage || '皮皮智绘登录态已失效'),
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
    const points = getPipiStudioPoints(data);
    const reward = getPipiStudioReward(data);
    const rewardText = formatPipiStudioPoints(reward);
    const checkedIn = getPipiStudioCheckedIn(data);

    // GET /pc/me：用 checkedIn 判定今日是否已签
    if (normalizedMethod === 'GET') {
      if (httpOk && checkedIn) {
        return {
          success: true,
          alreadyCheckedIn: true,
          authenticated: true,
          message: '今日已签到',
          httpStatus,
          data,
          points,
          reward
        };
      }
      if (httpOk) {
        return {
          success: false,
          alreadyCheckedIn: false,
          authenticated: true,
          message: '待签到',
          httpStatus,
          data,
          points
        };
      }
      return {
        success: false,
        alreadyCheckedIn: false,
        authenticated: false,
        message: apiMessage || `皮皮智绘状态查询失败（HTTP ${httpStatus || 0}）`,
        httpStatus,
        data,
        points
      };
    }

    // POST /pc/checkin：{already:true} 表示此前已签；{grantedPoints:N} 表示本次成功
    if (httpOk && data?.already === true) {
      return {
        success: true,
        alreadyCheckedIn: true,
        authenticated: true,
        message: '今日已签到',
        httpStatus,
        data,
        points,
        reward
      };
    }
    const explicitSuccess = data?.success === true || Number.isFinite(reward) || checkedIn;
    const success = httpOk && data?.success !== false && explicitSuccess;
    return {
      success,
      alreadyCheckedIn: false,
      authenticated: httpOk,
      message: success
        ? (rewardText ? `签到成功 +${rewardText} 积分` : '签到成功')
        : (apiMessage || `皮皮智绘签到失败（HTTP ${httpStatus || 0}）`),
      httpStatus,
      data,
      points,
      reward
    };
  }

  async function requestPipiStudioInPage(method, endpoint, tokenKey, timeoutMs = 30000) {
    const normalizedMethod = String(method || 'GET').toUpperCase();
    const token = String(localStorage.getItem(tokenKey) || '').trim();
    if (!token) {
      return { missingToken: true, hasToken: false, httpStatus: 0, data: null };
    }

    try {
      const headers = {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`
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
          hasToken: true,
          httpStatus: response.status,
          invalidSite: response.status === 404 || response.status === 410,
          error: '皮皮智绘接口响应不是 JSON',
          data: null
        };
      }

      let data = null;
      try {
        data = JSON.parse(await response.text());
      } catch (e) {
        return {
          hasToken: true,
          httpStatus: response.status,
          error: '皮皮智绘接口响应解析失败',
          data: null
        };
      }

      return {
        hasToken: true,
        httpStatus: response.status,
        invalidSite: response.status === 404 || response.status === 410,
        data
      };
    } catch (e) {
      return {
        hasToken: true,
        httpStatus: 0,
        error: e?.name === 'AbortError' ? '皮皮智绘请求超时' : (e?.message || '皮皮智绘请求失败'),
        data: null
      };
    }
  }

  // 状态查询用 /pc/me，签到用 /pc/checkin：request(method, endpoint) 双参
  async function runPipiStudioCheckInFlow(request, onResponse = null) {
    if (typeof request !== 'function') {
      throw new TypeError('皮皮智绘请求函数无效');
    }

    const perform = async (stage, method, endpoint) => {
      const rawResult = await request(method, endpoint);
      if (typeof onResponse === 'function') onResponse(stage, rawResult);
      return parsePipiStudioResponse(rawResult, method);
    };

    const statusResult = await perform('GET 状态查询', 'GET', PIPI_STUDIO_ME_PATH);
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

    let execResult = await perform('POST 签到', 'POST', PIPI_STUDIO_CHECK_IN_PATH);
    const verifyResult = await perform('GET 结果确认', 'GET', PIPI_STUDIO_ME_PATH);
    const latestPoints = verifyResult.points != null ? verifyResult.points : execResult.points;
    if (latestPoints != null) execResult.points = latestPoints;
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

  root.PIPI_STUDIO_CHECK_IN_PATH = PIPI_STUDIO_CHECK_IN_PATH;
  root.PIPI_STUDIO_DOMAIN = PIPI_STUDIO_DOMAIN;
  root.PIPI_STUDIO_ME_PATH = PIPI_STUDIO_ME_PATH;
  root.PIPI_STUDIO_PAGE_PATH = PIPI_STUDIO_PAGE_PATH;
  root.PIPI_STUDIO_TOKEN_KEY = PIPI_STUDIO_TOKEN_KEY;
  root.formatPipiStudioPoints = formatPipiStudioPoints;
  root.getPipiStudioPoints = getPipiStudioPoints;
  root.isPipiStudioDomain = isPipiStudioDomain;
  root.parsePipiStudioResponse = parsePipiStudioResponse;
  root.requestPipiStudioInPage = requestPipiStudioInPage;
  root.runPipiStudioCheckInFlow = runPipiStudioCheckInFlow;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      PIPI_STUDIO_CHECK_IN_PATH,
      PIPI_STUDIO_DOMAIN,
      PIPI_STUDIO_ME_PATH,
      PIPI_STUDIO_PAGE_PATH,
      PIPI_STUDIO_TOKEN_KEY,
      formatPipiStudioPoints,
      getPipiStudioPoints,
      isPipiStudioDomain,
      parsePipiStudioResponse,
      requestPipiStudioInPage,
      runPipiStudioCheckInFlow
    };
  }
})(typeof self !== 'undefined' ? self : globalThis);
