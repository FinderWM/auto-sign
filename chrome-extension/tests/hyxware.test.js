const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const {
  HYXWARE_CHECK_IN_PATH,
  HYXWARE_REFRESH_PATH,
  HYXWARE_USER_PATH,
  formatHyxwareQuota,
  getHyxwareCurrentMonth,
  isHyxwareDomain,
  parseHyxwareRefreshResponse,
  parseHyxwareResponse,
  requestHyxwareInPage,
  runHyxwareCheckInFlow
} = require('../hyxware.js');
const { buildSiteConfig } = require('../config.js');
const { getSitePageUrl, parseSiteInput } = require('../site-url.js');

function installPageStubs(t, responseData) {
  const previousLocation = global.location;
  const previousFetch = global.fetch;
  const calls = [];

  global.location = { origin: 'https://hyxware.com' };
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      status: 200,
      headers: { get: () => 'application/json; charset=utf-8' },
      text: async () => JSON.stringify(responseData)
    };
  };

  t.after(() => {
    if (previousLocation === undefined) delete global.location;
    else global.location = previousLocation;
    if (previousFetch === undefined) delete global.fetch;
    else global.fetch = previousFetch;
  });

  return calls;
}

function createInjectedPageRequest(overrides) {
  const context = vm.createContext({
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    location: { origin: 'https://hyxware.com' },
    ...overrides
  });
  return vm.runInContext(`(${requestHyxwareInPage.toString()})`, context);
}

function loadBackgroundContext() {
  const event = { addListener() {} };
  const context = vm.createContext({
    URL,
    console: { log() {}, warn() {} },
    chrome: {
      runtime: { onInstalled: event, onStartup: event, onMessage: event },
      storage: { local: { get: async () => ({}) }, onChanged: event },
      alarms: { onAlarm: event }
    }
  });
  context.self = context;
  context.importScripts = (...names) => {
    for (const name of names) {
      vm.runInContext(readFileSync(join(__dirname, '..', name), 'utf8'), context, { filename: name });
    }
  };
  vm.runInContext(readFileSync(join(__dirname, '..', 'background.js'), 'utf8'), context, {
    filename: 'background.js'
  });
  return context;
}

test('HyxAPI 识别只命中精确域名', () => {
  assert.equal(isHyxwareDomain('hyxware.com'), true);
  assert.equal(isHyxwareDomain('HYXWARE.COM'), true);
  assert.equal(isHyxwareDomain('www.hyxware.com'), false);
  assert.equal(isHyxwareDomain('hyxware.com.example.com'), false);
});

test('HyxAPI 配置使用 /topup 页面与独立端点，且外域名降级为 NewAPI', () => {
  const hyxware = buildSiteConfig({ domain: 'hyxware.com', type: 'hyxware' });

  assert.equal(hyxware.type, 'hyxware');
  assert.equal(hyxware.visitUrl, 'https://hyxware.com/topup');
  assert.equal(hyxware.signExecUrl, 'https://hyxware.com/api/user/checkin');
  assert.equal(hyxware.signQueryUrl, 'https://hyxware.com/api/user/checkin');
  assert.equal(hyxware.useApi, true);

  const foreignPage = buildSiteConfig({
    domain: 'hyxware.com',
    type: 'hyxware',
    pageUrl: 'https://example.com/foo'
  });
  assert.equal(foreignPage.visitUrl, 'https://hyxware.com/topup');

  const mismatchedDomain = buildSiteConfig({ domain: 'example.com', type: 'hyxware' });
  assert.equal(mismatchedDomain.type, 'newapi');
  assert.equal(mismatchedDomain.signExecUrl, 'https://example.com/api/user/checkin');
});

test('HyxAPI 页面地址固定为 /topup', () => {
  assert.equal(getSitePageUrl({ domain: 'hyxware.com', type: 'hyxware' }), 'https://hyxware.com/topup');
  assert.equal(
    getSitePageUrl({ domain: 'hyxware.com', type: 'hyxware', pageUrl: 'https://hyxware.com/console' }),
    'https://hyxware.com/topup'
  );
  assert.equal(parseSiteInput('https://hyxware.com/topup', 'checkin', 'auto').type, 'hyxware');
});

test('HyxAPI 默认开启 API，但尊重显式关闭', () => {
  const disabled = buildSiteConfig({ domain: 'hyxware.com', type: 'hyxware', useApi: false });
  assert.equal(disabled.useApi, false);
});

test('refresh 从 data.data 提取 access_token', () => {
  const result = parseHyxwareRefreshResponse({
    httpStatus: 200,
    data: { success: true, data: { access_token: 'tok-1', token_type: 'Bearer' } }
  });

  assert.equal(result.authenticated, true);
  assert.equal(result.accessToken, 'tok-1');
});

test('refresh 401 判为未登录', () => {
  const result = parseHyxwareRefreshResponse({
    httpStatus: 401,
    data: { success: false, code: 'AUTH_UNAUTHORIZED', message: 'Unauthorized, invalid access token' }
  });

  assert.equal(result.authenticated, false);
  assert.equal(result.unauthenticated, true);
  assert.equal(result.success, false);
});

test('GET 状态查询读取 stats.checked_in_today', () => {
  const already = parseHyxwareResponse({
    httpStatus: 200,
    data: { success: true, data: { enabled: true, stats: { checked_in_today: true } } }
  }, 'GET');
  assert.equal(already.authenticated, true);
  assert.equal(already.alreadyCheckedIn, true);
  assert.equal(already.success, true);

  const pending = parseHyxwareResponse({
    httpStatus: 200,
    data: { success: true, data: { enabled: true, stats: { checked_in_today: false } } }
  }, 'GET');
  assert.equal(pending.authenticated, true);
  assert.equal(pending.alreadyCheckedIn, false);
  assert.equal(pending.disabled, false);

  const disabled = parseHyxwareResponse({
    httpStatus: 200,
    data: { success: true, data: { enabled: false, stats: { checked_in_today: false } } }
  }, 'GET');
  assert.equal(disabled.disabled, true);
  assert.equal(disabled.message, '站点未开启签到');
});

test('401 且 code=AUTH_UNAUTHORIZED 判为未登录', () => {
  const result = parseHyxwareResponse({
    httpStatus: 401,
    data: { success: false, code: 'AUTH_UNAUTHORIZED', message: 'Unauthorized, invalid access token' }
  }, 'GET');

  assert.equal(result.unauthenticated, true);
  assert.equal(result.success, false);
});

test('POST 返回 quota_awarded 记为本次签到成功并按 500000 换算美元', () => {
  const result = parseHyxwareResponse({
    httpStatus: 200,
    data: { success: true, data: { checkin_date: '2026-10-25', quota_awarded: 10000 } }
  }, 'POST');

  assert.equal(result.success, true);
  assert.equal(result.alreadyCheckedIn, false);
  assert.equal(result.reward, 10000);
  assert.match(result.message, /\$0\.02/);
});

test('404/410 判为接口失效', () => {
  const result = parseHyxwareResponse({ httpStatus: 404, data: { message: 'Not Found' } }, 'GET');
  assert.equal(result.invalidSite, true);
  assert.equal(result.success, false);
});

test('页面请求：refresh 无需 token，业务请求带 Bearer', async (t) => {
  const calls = installPageStubs(t, { success: true, data: { access_token: 'tok-2' } });

  const refresh = await requestHyxwareInPage('REFRESH', HYXWARE_REFRESH_PATH, '');
  assert.equal(parseHyxwareRefreshResponse(refresh).accessToken, 'tok-2');
  assert.equal(calls[0].url, 'https://hyxware.com/api/user/auth/refresh');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.credentials, 'include');
  assert.equal(Object.hasOwn(calls[0].options.headers, 'Authorization'), false);

  await requestHyxwareInPage('GET', `${HYXWARE_CHECK_IN_PATH}?month=2026-10`, 'tok-2');
  assert.equal(calls[1].options.method, 'GET');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer tok-2');
});

test('页面请求：POST 带 JSON body 和 Content-Type', async (t) => {
  const calls = installPageStubs(t, { success: true, data: { quota_awarded: 1 } });

  await requestHyxwareInPage('POST', HYXWARE_CHECK_IN_PATH, 'tok-3');

  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.body, '{}');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer tok-3');
});

test('页面请求：缺少 token 时不发送业务请求', async (t) => {
  const calls = installPageStubs(t, {});

  const result = await requestHyxwareInPage('GET', HYXWARE_CHECK_IN_PATH, '');
  const parsed = parseHyxwareResponse(result, 'GET');

  assert.equal(calls.length, 0);
  assert.equal(result.missingToken, true);
  assert.equal(parsed.unauthenticated, true);
});

test('页面请求序列化注入后能完成 refresh、签到、复核和余额查询', async () => {
  const calls = [];
  const responses = [
    { success: true, data: { access_token: 'injected-token' } },
    { success: true, data: { stats: { checked_in_today: false } } },
    { success: true, data: { quota_awarded: 10000 } },
    { success: true, data: { stats: { checked_in_today: true } } },
    { success: true, data: { quota: 2510000 } }
  ];
  const request = createInjectedPageRequest({
    fetch: async (url, options) => {
      calls.push({ url, method: options.method, authorization: options.headers.Authorization });
      return {
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify(responses.shift())
      };
    }
  });

  const result = await runHyxwareCheckInFlow(request);

  assert.equal(result.shouldFallback, false);
  assert.equal(result.execResult.success, true);
  assert.equal(result.execResult.quota, 2510000);
  assert.equal(result.queryVerified, true);
  assert.deepEqual(calls.map(call => call.method), ['POST', 'GET', 'POST', 'GET', 'GET']);
  assert.equal(calls[0].authorization, undefined);
  assert.ok(calls.slice(1).every(call => call.authorization === 'Bearer injected-token'));
});

test('响应头已收到但响应体未读完时，超时仍中止请求', async () => {
  let triggerTimeout;
  let timerCleared = false;
  let aborted = false;
  const request = createInjectedPageRequest({
    setTimeout: callback => { triggerTimeout = callback; return 1; },
    clearTimeout: () => { timerCleared = true; },
    fetch: async (url, { signal }) => ({
      status: 200,
      headers: { get: () => 'application/json' },
      text: () => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        }, { once: true });
        if (timerCleared) resolve('{"success":true}');
        else triggerTimeout();
      })
    })
  });

  const result = await request('GET', HYXWARE_CHECK_IN_PATH, 'token', 5);

  assert.equal(aborted, true);
  assert.equal(result.error, 'HyxAPI 请求超时');
  assert.equal(timerCleared, true);
});

test('非 JSON 和损坏 JSON 响应保留错误提示，并清理超时定时器', async () => {
  const cases = [
    { contentType: 'text/html', body: '<html></html>', error: 'HyxAPI 接口响应不是 JSON' },
    { contentType: 'application/json', body: '{', error: 'HyxAPI 接口响应解析失败' }
  ];
  for (const item of cases) {
    let timerCleared = false;
    const request = createInjectedPageRequest({
      setTimeout: () => 1,
      clearTimeout: () => { timerCleared = true; },
      fetch: async () => ({
        status: 200,
        headers: { get: () => item.contentType },
        text: async () => item.body
      })
    });

    const result = await request('GET', HYXWARE_CHECK_IN_PATH, 'token');

    assert.equal(result.error, item.error);
    assert.equal(timerCleared, true);
  }
});

for (const status of ['success', 'already', 'failed']) {
  test(`页面兜底${status}结果保留本轮余额，并关闭临时标签页`, async () => {
    const context = loadBackgroundContext();
    const closedTabs = [];
    context.chrome.tabs = { remove: async tabId => { closedTabs.push(tabId); } };
    context.checkInFromOfficialPage = async () => ({
      result: {
        success: status !== 'failed',
        alreadyCheckedIn: status === 'already',
        message: '页面签到结果',
        balance: '$5.02'
      },
      tabId: 7,
      keepTabOpen: false
    });
    const site = buildSiteConfig({ domain: 'hyxware.com', type: 'hyxware', useApi: false });

    const result = await context.checkInHyxwareSite(site);

    assert.equal(result.status, status);
    assert.equal(result.balance, '$5.02');
    assert.deepEqual(closedTabs, [7]);
  });
}

test('流程：refresh 失败只请求一次并进入页面兜底', async () => {
  const methods = [];
  const flowResult = await runHyxwareCheckInFlow(async (method) => {
    methods.push(method);
    return { httpStatus: 401, data: { success: false, message: 'Unauthorized' } };
  });

  assert.deepEqual(methods, ['REFRESH']);
  assert.equal(flowResult.execResult.unauthenticated, true);
  assert.equal(flowResult.shouldFallback, true);
});

test('流程：今日已签不发送 POST，并读取余额', async () => {
  const calls = [];
  const responses = [
    { httpStatus: 200, data: { success: true, data: { access_token: 'tok' } } },
    { httpStatus: 200, data: { success: true, data: { enabled: true, stats: { checked_in_today: true } } } },
    { httpStatus: 200, data: { success: true, data: { quota: 1250000 } } }
  ];
  const flowResult = await runHyxwareCheckInFlow(async (method, endpoint) => {
    calls.push({ method, endpoint });
    return responses.shift();
  }, null, new Date(2026, 9, 25));

  assert.deepEqual(calls.map(c => c.method), ['REFRESH', 'GET', 'GET']);
  assert.equal(calls[1].endpoint, '/api/user/checkin?month=2026-10');
  assert.equal(calls[2].endpoint, HYXWARE_USER_PATH);
  assert.equal(flowResult.execResult.alreadyCheckedIn, true);
  assert.equal(flowResult.execResult.quota, 1250000);
  assert.equal(flowResult.queryVerified, true);
  assert.equal(flowResult.shouldFallback, false);
});

test('流程：未开启签到时不发 POST，也不进入页面兜底', async () => {
  const methods = [];
  const responses = [
    { httpStatus: 200, data: { success: true, data: { access_token: 'tok' } } },
    { httpStatus: 200, data: { success: true, data: { enabled: false, stats: { checked_in_today: false } } } }
  ];
  const flowResult = await runHyxwareCheckInFlow(async (method) => {
    methods.push(method);
    return responses.shift();
  });

  assert.deepEqual(methods, ['REFRESH', 'GET']);
  assert.equal(flowResult.execResult.disabled, true);
  assert.equal(flowResult.shouldFallback, false);
});

test('流程：未签时按 refresh、GET、POST、GET、余额 执行并复核', async () => {
  const calls = [];
  const responses = [
    { httpStatus: 200, data: { success: true, data: { access_token: 'tok' } } },
    { httpStatus: 200, data: { success: true, data: { enabled: true, stats: { checked_in_today: false } } } },
    { httpStatus: 200, data: { success: true, data: { checkin_date: '2026-10-25', quota_awarded: 10000 } } },
    { httpStatus: 200, data: { success: true, data: { enabled: true, stats: { checked_in_today: true } } } },
    { httpStatus: 200, data: { success: true, data: { quota: 2510000 } } }
  ];
  const flowResult = await runHyxwareCheckInFlow(async (method, endpoint) => {
    calls.push({ method, endpoint });
    return responses.shift();
  });

  assert.deepEqual(calls.map(c => c.method), ['REFRESH', 'GET', 'POST', 'GET', 'GET']);
  assert.equal(calls[2].endpoint, HYXWARE_CHECK_IN_PATH);
  assert.equal(flowResult.execResult.success, true);
  assert.equal(flowResult.execResult.quota, 2510000);
  assert.equal(flowResult.queryVerified, true);
  assert.equal(flowResult.shouldFallback, false);
});

test('流程：POST 未确认时进入页面兜底', async () => {
  const responses = [
    { httpStatus: 200, data: { success: true, data: { access_token: 'tok' } } },
    { httpStatus: 200, data: { success: true, data: { enabled: true, stats: { checked_in_today: false } } } },
    { httpStatus: 500, data: { success: false, message: 'server error' } },
    { httpStatus: 200, data: { success: true, data: { enabled: true, stats: { checked_in_today: false } } } }
  ];
  const flowResult = await runHyxwareCheckInFlow(async () => responses.shift());

  assert.equal(flowResult.execResult.success, false);
  assert.equal(flowResult.queryVerified, false);
  assert.equal(flowResult.shouldFallback, true);
});

test('月份按本地时间生成，与站点查询参数一致', () => {
  assert.equal(getHyxwareCurrentMonth(new Date(2026, 0, 9)), '2026-01');
  assert.equal(getHyxwareCurrentMonth(new Date(2026, 11, 31)), '2026-12');
});

test('余额按 500000 quota = 1 USD 格式化', () => {
  assert.equal(formatHyxwareQuota(500000), '$1.00');
  assert.equal(formatHyxwareQuota(2510000), '$5.02');
  assert.equal(formatHyxwareQuota(null), '');
});
