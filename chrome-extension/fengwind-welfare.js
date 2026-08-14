(function(root) {
  const FENGWIND_WELFARE_SITE_TYPE = 'fengwind-welfare';
  const FENGWIND_WELFARE_DOMAIN = 'api-welfalre.fengwind.com';
  const FENGWIND_WELFARE_MAIN_DOMAIN = 'api.fengwind.com';
  const FENGWIND_WELFARE_PAGE_PATH = '/';
  const FENGWIND_WELFARE_STATUS_PATH = '/api/checkin/status';
  const FENGWIND_WELFARE_CHECK_IN_PATH = '/api/checkin';
  const FENGWIND_WELFARE_LOGIN_PATH = '/api/auth/login-url';
  const FENGWIND_WELFARE_EXCHANGE_PATH = '/api/auth/sso/exchange';
  const FENGWIND_WELFARE_CALLBACK_PATH = '/auth/callback';
  const FENGWIND_WELFARE_TOKEN_KEY = 'welfare_token';
  const FENGWIND_WELFARE_STATE_KEY = 'welfare_sso_state';

  function isFengwindWelfareDomain(domain) {
    return String(domain || '').trim().toLowerCase() === FENGWIND_WELFARE_DOMAIN;
  }

  function classifyFengwindWelfareLoginUrl(url) {
    try {
      const parsed = new URL(url || '');
      if (parsed.protocol !== 'https:') return 'other';
      if (isFengwindWelfareDomain(parsed.hostname)) {
        return parsed.pathname === FENGWIND_WELFARE_CALLBACK_PATH ? 'welfare-callback' : 'welfare';
      }
      if (parsed.hostname === FENGWIND_WELFARE_MAIN_DOMAIN) {
        if (/^\/login(?:\/|$)/i.test(parsed.pathname)) return 'main-login';
        if (/^\/sso\/continue(?:\/|$)/i.test(parsed.pathname)) return 'main-sso';
        if (
          /^\/auth\/linuxdo\/callback(?:\/|$)/i.test(parsed.pathname) ||
          /^\/auth\/oauth\/callback(?:\/|$)/i.test(parsed.pathname) ||
          /^\/api\/v1\/auth\/oauth\/linuxdo\/callback(?:\/|$)/i.test(parsed.pathname)
        ) {
          return 'main-oauth-callback';
        }
        return 'main';
      }
      if (parsed.hostname === 'connect.linux.do') return 'linuxdo';
      if (parsed.hostname === 'linux.do' || parsed.hostname.endsWith('.linux.do')) return 'linuxdo-login';
    } catch (e) {}
    return 'other';
  }

  function getFengwindWelfarePayload(data) {
    if (!data || typeof data !== 'object') return data;
    return Object.prototype.hasOwnProperty.call(data, 'data') ? data.data : data;
  }

  function getFengwindWelfareMessage(data) {
    const payload = getFengwindWelfarePayload(data);
    const candidates = [
      data?.message,
      data?.msg,
      data?.error,
      payload?.message,
      payload?.msg,
      payload?.error
    ];
    for (const candidate of candidates) {
      const message = String(candidate || '').trim();
      if (message) return message;
    }
    return '';
  }

  function getFengwindWelfareAmount(data) {
    const payload = getFengwindWelfarePayload(data);
    const candidates = [
      payload?.amount,
      payload?.today?.amount,
      payload?.reward,
      payload?.reward_amount
    ];
    for (const candidate of candidates) {
      if (!['number', 'string'].includes(typeof candidate) || String(candidate).trim() === '') continue;
      const amount = Number(candidate);
      if (Number.isFinite(amount)) return amount;
    }
    return null;
  }

  function formatFengwindWelfareAmount(amount) {
    if (!Number.isFinite(amount)) return '';
    return Number(amount).toFixed(2);
  }

  function isFengwindWelfareCheckedIn(data) {
    const payload = getFengwindWelfarePayload(data);
    return payload?.checked_in_today === true ||
      payload?.today?.checked_in_today === true ||
      payload?.status?.checked_in_today === true ||
      payload?.status === 'already';
  }

  async function startFengwindWelfareLoginInPage(loginPath, stateKey, mainDomain, timeoutMs = 30000) {
    function createState() {
      if (globalThis.crypto?.randomUUID) {
        return globalThis.crypto.randomUUID().replace(/-/g, '');
      }
      if (globalThis.crypto?.getRandomValues) {
        const bytes = new Uint8Array(16);
        globalThis.crypto.getRandomValues(bytes);
        return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
      }
      return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    }

    function getPayload(data) {
      if (!data || typeof data !== 'object') return data;
      return Object.prototype.hasOwnProperty.call(data, 'data') ? data.data : data;
    }

    function getMessage(data) {
      const payload = getPayload(data);
      const candidates = [data?.message, data?.msg, data?.error, payload?.message, payload?.msg, payload?.error];
      for (const candidate of candidates) {
        const message = String(candidate || '').trim();
        if (message) return message;
      }
      return '';
    }

    async function readJson(response) {
      const contentType = String(response?.headers?.get?.('content-type') || '').toLowerCase();
      if (!contentType.includes('application/json')) return null;
      try {
        return await response.json();
      } catch (e) {
        return null;
      }
    }

    const state = createState();
    sessionStorage.setItem(stateKey, state);

    try {
      const loginUrl = new URL(loginPath, location.origin);
      loginUrl.searchParams.set('state', state);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetch(loginUrl.toString(), {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
          headers: { Accept: 'application/json' },
          signal: controller.signal
        });
      } finally {
        clearTimeout(timer);
      }
      const data = await readJson(response);
      const payload = getPayload(data);
      const remoteState = String(payload?.state || state).trim();
      const redirectUrl = String(payload?.login_url || '').trim();
      let parsedRedirect = null;
      try {
        parsedRedirect = new URL(redirectUrl);
      } catch (e) {}
      const validRedirect = parsedRedirect?.protocol === 'https:' &&
        parsedRedirect.hostname === mainDomain &&
        !parsedRedirect.port &&
        parsedRedirect.pathname === '/sso/continue';
      if (!response.ok || Number(data?.code) !== 0 || !validRedirect) {
        sessionStorage.removeItem(stateKey);
        return {
          success: false,
          httpStatus: response.status,
          message: getMessage(data) || '无法获取 Fengwind 福利站登录地址'
        };
      }
      if (remoteState !== state) {
        sessionStorage.removeItem(stateKey);
        return { success: false, httpStatus: response.status, message: 'Fengwind 福利站登录状态初始化失败' };
      }
      setTimeout(() => location.assign(redirectUrl), 0);
      return { success: true, started: true, loginUrl: redirectUrl };
    } catch (e) {
      sessionStorage.removeItem(stateKey);
      const message = e?.name === 'AbortError'
        ? 'Fengwind 福利站登录地址请求超时'
        : (e?.message || 'Fengwind 福利站登录跳转失败');
      return { success: false, httpStatus: 0, message };
    }
  }

  async function completeFengwindWelfareCallbackInPage(
    exchangePath,
    tokenKey,
    stateKey,
    timeoutMs = 30000
  ) {
    function getPayload(data) {
      if (!data || typeof data !== 'object') return data;
      return Object.prototype.hasOwnProperty.call(data, 'data') ? data.data : data;
    }

    function getMessage(data) {
      const payload = getPayload(data);
      const candidates = [data?.message, data?.msg, data?.error, payload?.message, payload?.msg, payload?.error];
      for (const candidate of candidates) {
        const message = String(candidate || '').trim();
        if (message) return message;
      }
      return '';
    }

    async function readJson(response) {
      const contentType = String(response?.headers?.get?.('content-type') || '').toLowerCase();
      if (!contentType.includes('application/json')) return null;
      try {
        return await response.json();
      } catch (e) {
        return null;
      }
    }

    const callbackUrl = new URL(location.href);
    const code = String(callbackUrl.searchParams.get('code') || '').trim();
    const state = String(callbackUrl.searchParams.get('state') || '').trim();
    if (!code) return { success: false, pending: true, message: '回调页缺少授权 code' };

    const expectedState = String(sessionStorage.getItem(stateKey) || '').trim();
    if (!expectedState || !state || state !== expectedState) {
      return { success: false, stateMismatch: true, message: 'Fengwind 福利站登录状态校验失败' };
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetch(exchangePath, {
          method: 'POST',
          credentials: 'include',
          cache: 'no-store',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ code, state }),
          signal: controller.signal
        });
      } finally {
        clearTimeout(timer);
      }
      const data = await readJson(response);
      const payload = getPayload(data);
      const token = String(payload?.access_token || payload?.accessToken || '').trim();
      if (!response.ok || Number(data?.code) !== 0 || !token) {
        return {
          success: false,
          httpStatus: response.status,
          message: getMessage(data) || 'Fengwind 福利站登录态交换失败'
        };
      }

      localStorage.setItem(tokenKey, token);
      sessionStorage.removeItem(stateKey);
      return {
        success: true,
        hasToken: true,
        hasUser: Boolean(payload?.user),
        httpStatus: response.status
      };
    } catch (e) {
      const message = e?.name === 'AbortError'
        ? 'Fengwind 福利站登录态交换超时'
        : (e?.message || 'Fengwind 福利站登录态交换失败');
      return { success: false, httpStatus: 0, message };
    }
  }

  function parseFengwindWelfareResponse(rawResult, method = 'GET') {
    const normalizedMethod = String(method || 'GET').toUpperCase();
    const httpStatus = Number(rawResult?.httpStatus) || 0;
    const data = rawResult?.data;
    const payload = getFengwindWelfarePayload(data);
    const message = getFengwindWelfareMessage(data);
    const normalizedMessage = message.toLowerCase();
    const apiCode = Number(data?.code);
    const apiOk = !Number.isFinite(apiCode) || apiCode === 0;
    const authFailureByMessage =
      /missing bearer token|unauthorized|unauthenticated|未登录|请先登录|登录已过期/.test(normalizedMessage);
    const unauthenticated = rawResult?.missingToken === true ||
      httpStatus === 401 ||
      apiCode === 401 ||
      ((httpStatus === 403 || apiCode === 403) && authFailureByMessage) ||
      authFailureByMessage;

    if (rawResult?.invalidSite || httpStatus === 404 || httpStatus === 410) {
      return {
        success: false,
        alreadyCheckedIn: false,
        invalidSite: true,
        message: 'Fengwind 福利站签到接口失效',
        httpStatus,
        data
      };
    }

    if (unauthenticated) {
      return {
        success: false,
        alreadyCheckedIn: false,
        unauthenticated: true,
        message: rawResult?.missingToken ? 'Fengwind 福利站尚未登录' : (message || 'Fengwind 福利站登录态已失效'),
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
    const checkedInToday = isFengwindWelfareCheckedIn(data);
    const alreadyByMessage = /already checked|checked in today|今日已签到|已经签到|重复签到/.test(normalizedMessage);
    const alreadyCheckedIn = httpOk && apiOk && (
      alreadyByMessage ||
      (normalizedMethod === 'GET' && checkedInToday)
    );
    const amount = getFengwindWelfareAmount(data);
    const amountText = formatFengwindWelfareAmount(amount);

    if (alreadyCheckedIn) {
      return {
        success: true,
        alreadyCheckedIn: true,
        authenticated: true,
        message: amountText ? `今日已签到，获得 $${amountText}` : (message || '今日已签到'),
        httpStatus,
        data,
        amount
      };
    }

    if (normalizedMethod === 'GET' && httpOk && apiOk) {
      if (payload?.enabled === false) {
        return {
          success: false,
          alreadyCheckedIn: false,
          authenticated: true,
          disabled: true,
          message: '签到功能暂未开放',
          httpStatus,
          data
        };
      }
      return {
        success: false,
        alreadyCheckedIn: false,
        authenticated: true,
        message: message || '待签到',
        httpStatus,
        data
      };
    }

    const success = normalizedMethod === 'POST' &&
      httpOk &&
      apiOk &&
      data?.success !== false &&
      payload?.success !== false;
    const creditStatus = String(payload?.status || '').trim();
    let successMessage = message || '签到成功';
    if (success && amountText) {
      successMessage = creditStatus === 'pending_credit'
        ? `签到成功，获得 $${amountText}，正在入账`
        : creditStatus === 'credited'
        ? `签到成功，获得 $${amountText}`
        : `签到已记录，获得 $${amountText}`;
    }

    return {
      success,
      alreadyCheckedIn: false,
      authenticated: httpOk && apiOk,
      message: success ? successMessage : (message || `Fengwind 福利站签到失败（HTTP ${httpStatus || 0}）`),
      httpStatus,
      data,
      amount
    };
  }

  async function requestFengwindWelfareInPage(method, endpoint, tokenKey, timeoutMs = 30000) {
    const normalizedMethod = String(method || 'GET').toUpperCase();
    const token = String(localStorage.getItem(tokenKey) || '').trim();
    if (!token) {
      return { missingToken: true, hasToken: false, httpStatus: 0, data: null };
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetch(endpoint, {
          method: normalizedMethod,
          credentials: 'include',
          cache: 'no-store',
          headers: {
            Accept: 'application/json',
            Authorization: /^bearer\s+/i.test(token) ? token : `Bearer ${token}`
          },
          signal: controller.signal
        });
      } finally {
        clearTimeout(timer);
      }

      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      if (!contentType.includes('application/json')) {
        return {
          hasToken: true,
          httpStatus: response.status,
          invalidSite: response.status === 404 || response.status === 410,
          error: 'Fengwind 福利站接口响应不是 JSON',
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
          error: 'Fengwind 福利站接口响应解析失败',
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
        error: e?.name === 'AbortError' ? 'Fengwind 福利站请求超时' : (e?.message || 'Fengwind 福利站请求失败'),
        data: null
      };
    }
  }

  async function runFengwindWelfareCheckInFlow(request, onResponse = null) {
    if (typeof request !== 'function') {
      throw new TypeError('Fengwind 福利站请求函数无效');
    }

    const perform = async (stage, method, endpoint) => {
      const rawResult = await request(method, endpoint);
      if (typeof onResponse === 'function') onResponse(stage, rawResult);
      return parseFengwindWelfareResponse(rawResult, method);
    };

    const statusResult = await perform('GET 状态查询', 'GET', FENGWIND_WELFARE_STATUS_PATH);
    if (statusResult.alreadyCheckedIn || statusResult.invalidSite || statusResult.disabled) {
      return {
        execResult: statusResult,
        queryVerified: statusResult.alreadyCheckedIn,
        shouldLogin: false
      };
    }
    if (!statusResult.authenticated) {
      return { execResult: statusResult, queryVerified: false, shouldLogin: statusResult.unauthenticated === true };
    }

    let execResult = await perform('POST 签到', 'POST', FENGWIND_WELFARE_CHECK_IN_PATH);
    if (execResult.unauthenticated) {
      return { execResult, queryVerified: false, shouldLogin: true };
    }

    const verifyResult = await perform('GET 结果确认', 'GET', FENGWIND_WELFARE_STATUS_PATH);
    if (verifyResult.alreadyCheckedIn) {
      if (!execResult.success) {
        execResult = {
          ...verifyResult,
          alreadyCheckedIn: false,
          message: '签到成功，状态查询已确认'
        };
      }
      return { execResult, queryVerified: true, shouldLogin: false };
    }
    return { execResult, queryVerified: false, shouldLogin: verifyResult.unauthenticated === true };
  }

  root.FENGWIND_WELFARE_CHECK_IN_PATH = FENGWIND_WELFARE_CHECK_IN_PATH;
  root.FENGWIND_WELFARE_CALLBACK_PATH = FENGWIND_WELFARE_CALLBACK_PATH;
  root.FENGWIND_WELFARE_DOMAIN = FENGWIND_WELFARE_DOMAIN;
  root.FENGWIND_WELFARE_EXCHANGE_PATH = FENGWIND_WELFARE_EXCHANGE_PATH;
  root.FENGWIND_WELFARE_LOGIN_PATH = FENGWIND_WELFARE_LOGIN_PATH;
  root.FENGWIND_WELFARE_MAIN_DOMAIN = FENGWIND_WELFARE_MAIN_DOMAIN;
  root.FENGWIND_WELFARE_PAGE_PATH = FENGWIND_WELFARE_PAGE_PATH;
  root.FENGWIND_WELFARE_SITE_TYPE = FENGWIND_WELFARE_SITE_TYPE;
  root.FENGWIND_WELFARE_STATE_KEY = FENGWIND_WELFARE_STATE_KEY;
  root.FENGWIND_WELFARE_STATUS_PATH = FENGWIND_WELFARE_STATUS_PATH;
  root.FENGWIND_WELFARE_TOKEN_KEY = FENGWIND_WELFARE_TOKEN_KEY;
  root.classifyFengwindWelfareLoginUrl = classifyFengwindWelfareLoginUrl;
  root.completeFengwindWelfareCallbackInPage = completeFengwindWelfareCallbackInPage;
  root.isFengwindWelfareDomain = isFengwindWelfareDomain;
  root.parseFengwindWelfareResponse = parseFengwindWelfareResponse;
  root.requestFengwindWelfareInPage = requestFengwindWelfareInPage;
  root.runFengwindWelfareCheckInFlow = runFengwindWelfareCheckInFlow;
  root.startFengwindWelfareLoginInPage = startFengwindWelfareLoginInPage;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      FENGWIND_WELFARE_CHECK_IN_PATH,
      FENGWIND_WELFARE_CALLBACK_PATH,
      FENGWIND_WELFARE_DOMAIN,
      FENGWIND_WELFARE_EXCHANGE_PATH,
      FENGWIND_WELFARE_LOGIN_PATH,
      FENGWIND_WELFARE_MAIN_DOMAIN,
      FENGWIND_WELFARE_PAGE_PATH,
      FENGWIND_WELFARE_SITE_TYPE,
      FENGWIND_WELFARE_STATE_KEY,
      FENGWIND_WELFARE_STATUS_PATH,
      FENGWIND_WELFARE_TOKEN_KEY,
      classifyFengwindWelfareLoginUrl,
      completeFengwindWelfareCallbackInPage,
      isFengwindWelfareDomain,
      parseFengwindWelfareResponse,
      requestFengwindWelfareInPage,
      runFengwindWelfareCheckInFlow,
      startFengwindWelfareLoginInPage
    };
  }
})(typeof self !== 'undefined' ? self : globalThis);
