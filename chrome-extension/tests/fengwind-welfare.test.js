const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FENGWIND_WELFARE_CHECK_IN_PATH,
  FENGWIND_WELFARE_DOMAIN,
  FENGWIND_WELFARE_EXCHANGE_PATH,
  FENGWIND_WELFARE_LOGIN_PATH,
  FENGWIND_WELFARE_MAIN_DOMAIN,
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
} = require('../fengwind-welfare.js');
const { buildSiteConfig } = require('../config.js');
const { getSitePageUrl, parseSiteInput } = require('../site-url.js');

function createMemoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, String(value));
    }
  };
}

function createJsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json; charset=utf-8' },
    json: async () => data,
    text: async () => JSON.stringify(data)
  };
}

function installPageGlobals(t, options = {}) {
  const previous = {
    fetch: global.fetch,
    localStorage: global.localStorage,
    location: global.location,
    sessionStorage: global.sessionStorage
  };
  global.localStorage = createMemoryStorage(options.localStorage);
  global.sessionStorage = createMemoryStorage(options.sessionStorage);
  global.location = {
    href: options.href || `https://${FENGWIND_WELFARE_DOMAIN}/`,
    origin: `https://${FENGWIND_WELFARE_DOMAIN}`,
    assign(url) {
      this.href = String(url);
    }
  };
  global.fetch = options.fetch || (async () => createJsonResponse({ code: 0, data: {} }));

  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete global[key];
      else global[key] = value;
    }
  });
}

test('Fengwind 福利站识别仅命中精确域名', () => {
  assert.equal(isFengwindWelfareDomain(FENGWIND_WELFARE_DOMAIN), true);
  assert.equal(isFengwindWelfareDomain(`www.${FENGWIND_WELFARE_DOMAIN}`), false);
  assert.equal(isFengwindWelfareDomain(`${FENGWIND_WELFARE_DOMAIN}.example.com`), false);
});

test('登录跳转阶段能区分福利站、主站和 LinuxDo', () => {
  assert.equal(classifyFengwindWelfareLoginUrl(`https://${FENGWIND_WELFARE_DOMAIN}/`), 'welfare');
  assert.equal(
    classifyFengwindWelfareLoginUrl(`https://${FENGWIND_WELFARE_DOMAIN}/auth/callback?code=x`),
    'welfare-callback'
  );
  assert.equal(
    classifyFengwindWelfareLoginUrl(`https://${FENGWIND_WELFARE_MAIN_DOMAIN}/sso/continue`),
    'main-sso'
  );
  assert.equal(
    classifyFengwindWelfareLoginUrl(`https://${FENGWIND_WELFARE_MAIN_DOMAIN}/auth/linuxdo/callback`),
    'main-oauth-callback'
  );
  assert.equal(classifyFengwindWelfareLoginUrl('https://connect.linux.do/oauth2/authorize'), 'linuxdo');
  assert.equal(
    classifyFengwindWelfareLoginUrl(`http://${FENGWIND_WELFARE_MAIN_DOMAIN}/sso/continue`),
    'other'
  );
});

test('页面请求使用 welfare_token 构造 Bearer 认证且不返回令牌', async (t) => {
  const calls = [];
  installPageGlobals(t, {
    localStorage: { [FENGWIND_WELFARE_TOKEN_KEY]: 'secret-token' },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return createJsonResponse({ code: 0, data: { checked_in_today: false } });
    }
  });

  const result = await requestFengwindWelfareInPage(
    'GET',
    FENGWIND_WELFARE_STATUS_PATH,
    FENGWIND_WELFARE_TOKEN_KEY
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, FENGWIND_WELFARE_STATUS_PATH);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret-token');
  assert.equal(result.hasToken, true);
  assert.equal(Object.hasOwn(result, 'token'), false);
});

test('缺少福利站令牌时不发送请求', async (t) => {
  let called = false;
  installPageGlobals(t, {
    fetch: async () => {
      called = true;
      return createJsonResponse({});
    }
  });

  const result = await requestFengwindWelfareInPage(
    'GET',
    FENGWIND_WELFARE_STATUS_PATH,
    FENGWIND_WELFARE_TOKEN_KEY
  );

  assert.equal(called, false);
  assert.equal(result.missingToken, true);
  assert.equal(result.hasToken, false);
});

test('福利站登录初始化保存 state 并只接受主站 SSO 地址', async (t) => {
  let requestedState = '';
  installPageGlobals(t, {
    fetch: async (url) => {
      const parsed = new URL(url);
      requestedState = parsed.searchParams.get('state');
      return createJsonResponse({
        code: 0,
        data: {
          login_url: `https://${FENGWIND_WELFARE_MAIN_DOMAIN}/sso/continue?state=${requestedState}`,
          state: requestedState
        }
      });
    }
  });

  const result = await startFengwindWelfareLoginInPage(
    FENGWIND_WELFARE_LOGIN_PATH,
    FENGWIND_WELFARE_STATE_KEY,
    FENGWIND_WELFARE_MAIN_DOMAIN
  );
  await new Promise(resolve => setTimeout(resolve, 5));

  assert.equal(result.success, true);
  assert.equal(global.sessionStorage.getItem(FENGWIND_WELFARE_STATE_KEY), requestedState);
  assert.match(global.location.href, new RegExp(`^https://${FENGWIND_WELFARE_MAIN_DOMAIN}/sso/continue`));
});

test('福利站回调交换令牌后只写入页面存储', async (t) => {
  let requestBody = null;
  installPageGlobals(t, {
    href: `https://${FENGWIND_WELFARE_DOMAIN}/auth/callback?code=code-1&state=state-1`,
    sessionStorage: { [FENGWIND_WELFARE_STATE_KEY]: 'state-1' },
    fetch: async (url, options) => {
      assert.equal(url, FENGWIND_WELFARE_EXCHANGE_PATH);
      requestBody = JSON.parse(options.body);
      return createJsonResponse({
        code: 0,
        data: { access_token: 'new-secret-token', user: { id: 1 } }
      });
    }
  });

  const result = await completeFengwindWelfareCallbackInPage(
    FENGWIND_WELFARE_EXCHANGE_PATH,
    FENGWIND_WELFARE_TOKEN_KEY,
    FENGWIND_WELFARE_STATE_KEY
  );

  assert.deepEqual(requestBody, { code: 'code-1', state: 'state-1' });
  assert.equal(global.localStorage.getItem(FENGWIND_WELFARE_TOKEN_KEY), 'new-secret-token');
  assert.equal(global.sessionStorage.getItem(FENGWIND_WELFARE_STATE_KEY), null);
  assert.equal(result.success, true);
  assert.equal(result.hasToken, true);
  assert.equal(Object.hasOwn(result, 'token'), false);
  assert.equal(Object.hasOwn(result, 'accessToken'), false);
});

test('福利站回调 state 不一致时拒绝交换', async (t) => {
  let called = false;
  installPageGlobals(t, {
    href: `https://${FENGWIND_WELFARE_DOMAIN}/auth/callback?code=code-1&state=wrong-state`,
    sessionStorage: { [FENGWIND_WELFARE_STATE_KEY]: 'expected-state' },
    fetch: async () => {
      called = true;
      return createJsonResponse({});
    }
  });

  const result = await completeFengwindWelfareCallbackInPage(
    FENGWIND_WELFARE_EXCHANGE_PATH,
    FENGWIND_WELFARE_TOKEN_KEY,
    FENGWIND_WELFARE_STATE_KEY
  );

  assert.equal(called, false);
  assert.equal(result.success, false);
  assert.equal(result.stateMismatch, true);
});

test('福利站回调缺少本地 state 时拒绝交换', async (t) => {
  let called = false;
  installPageGlobals(t, {
    href: `https://${FENGWIND_WELFARE_DOMAIN}/auth/callback?code=code-1&state=state-1`,
    fetch: async () => {
      called = true;
      return createJsonResponse({});
    }
  });

  const result = await completeFengwindWelfareCallbackInPage(
    FENGWIND_WELFARE_EXCHANGE_PATH,
    FENGWIND_WELFARE_TOKEN_KEY,
    FENGWIND_WELFARE_STATE_KEY
  );

  assert.equal(called, false);
  assert.equal(result.success, false);
  assert.equal(result.stateMismatch, true);
});

test('福利站登录地址请求支持超时中止', async (t) => {
  installPageGlobals(t, {
    fetch: async (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    })
  });

  const result = await startFengwindWelfareLoginInPage(
    FENGWIND_WELFARE_LOGIN_PATH,
    FENGWIND_WELFARE_STATE_KEY,
    FENGWIND_WELFARE_MAIN_DOMAIN,
    5
  );

  assert.equal(result.success, false);
  assert.equal(result.message, 'Fengwind 福利站登录地址请求超时');
  assert.equal(global.sessionStorage.getItem(FENGWIND_WELFARE_STATE_KEY), null);
});

test('状态接口确认今日已签并格式化奖励金额', () => {
  const result = parseFengwindWelfareResponse({
    httpStatus: 200,
    data: {
      code: 0,
      data: { checked_in_today: true, today: { amount: 1.25 } }
    }
  }, 'GET');

  assert.equal(result.authenticated, true);
  assert.equal(result.alreadyCheckedIn, true);
  assert.equal(result.message, '今日已签到，获得 $1.25');
});

test('POST 返回已签字段仍记为本次签到成功', () => {
  const result = parseFengwindWelfareResponse({
    httpStatus: 200,
    data: {
      code: 0,
      data: { checked_in_today: true, status: 'credited', amount: 2 }
    }
  }, 'POST');

  assert.equal(result.success, true);
  assert.equal(result.alreadyCheckedIn, false);
  assert.equal(result.message, '签到成功，获得 $2.00');
});

test('资格不足的 403 不误判为登录过期', () => {
  const result = parseFengwindWelfareResponse({
    httpStatus: 403,
    data: { code: 403, message: 'checkin not eligible' }
  }, 'GET');

  assert.equal(result.success, false);
  assert.equal(result.unauthenticated, undefined);
  assert.equal(result.message, 'checkin not eligible');
});

test('未登录流程只查询一次并请求登录', async () => {
  const methods = [];
  const result = await runFengwindWelfareCheckInFlow(async (method) => {
    methods.push(method);
    return { httpStatus: 401, data: { code: 401, message: 'missing bearer token' } };
  });

  assert.deepEqual(methods, ['GET']);
  assert.equal(result.shouldLogin, true);
  assert.equal(result.queryVerified, false);
});

test('登录后按 GET、POST、GET 执行签到并复核', async () => {
  const calls = [];
  const responses = [
    { httpStatus: 200, data: { code: 0, data: { checked_in_today: false } } },
    { httpStatus: 200, data: { code: 0, data: { status: 'credited', amount: 1 } } },
    { httpStatus: 200, data: { code: 0, data: { checked_in_today: true, today: { amount: 1 } } } }
  ];
  const result = await runFengwindWelfareCheckInFlow(async (method, endpoint) => {
    calls.push([method, endpoint]);
    return responses.shift();
  });

  assert.deepEqual(calls, [
    ['GET', FENGWIND_WELFARE_STATUS_PATH],
    ['POST', FENGWIND_WELFARE_CHECK_IN_PATH],
    ['GET', FENGWIND_WELFARE_STATUS_PATH]
  ]);
  assert.equal(result.execResult.success, true);
  assert.equal(result.execResult.alreadyCheckedIn, false);
  assert.equal(result.queryVerified, true);
  assert.equal(result.shouldLogin, false);
});

test('福利站配置使用独立端点、根页面和默认 API 模式', () => {
  const site = buildSiteConfig({
    domain: FENGWIND_WELFARE_DOMAIN,
    type: 'fengwind-welfare',
    pageUrl: `https://${FENGWIND_WELFARE_DOMAIN}/console/personal`
  });

  assert.equal(site.type, 'fengwind-welfare');
  assert.equal(site.visitUrl, `https://${FENGWIND_WELFARE_DOMAIN}/`);
  assert.equal(site.signExecUrl, `https://${FENGWIND_WELFARE_DOMAIN}${FENGWIND_WELFARE_CHECK_IN_PATH}`);
  assert.equal(site.signQueryUrl, `https://${FENGWIND_WELFARE_DOMAIN}${FENGWIND_WELFARE_STATUS_PATH}`);
  assert.equal(site.useApi, true);

  const pageMode = buildSiteConfig({
    domain: FENGWIND_WELFARE_DOMAIN,
    type: 'fengwind-welfare',
    useApi: false
  });
  assert.equal(pageMode.useApi, false);
});

test('福利站类型不能应用到其他域名', () => {
  const site = buildSiteConfig({ domain: 'example.com', type: 'fengwind-welfare' });
  assert.equal(site.type, 'newapi');
  assert.equal(site.visitUrl, 'https://example.com/console/personal');
  assert.equal(site.signExecUrl, 'https://example.com/api/user/checkin');
});

test('添加福利站时自动识别类型并固定根页面', () => {
  const site = parseSiteInput(`https://${FENGWIND_WELFARE_DOMAIN}/anything`);

  assert.equal(site.type, 'fengwind-welfare');
  assert.equal(getSitePageUrl(site), `https://${FENGWIND_WELFARE_DOMAIN}/`);
  assert.equal(getSitePageUrl({
    domain: FENGWIND_WELFARE_DOMAIN,
    type: 'fengwind-welfare'
  }), `https://${FENGWIND_WELFARE_DOMAIN}/`);
});
