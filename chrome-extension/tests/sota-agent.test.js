const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SOTA_AGENT_CHECK_IN_PATH,
  SOTA_AGENT_USER_HEADER,
  isSotaAgentDomain,
  parseSotaAgentResponse,
  requestSotaAgentInPage,
  runSotaAgentCheckInFlow
} = require('../sota-agent.js');
const { buildSiteConfig } = require('../config.js');
const { getSitePageUrl } = require('../site-url.js');

function installPageRequestStubs(t, uid, responseData) {
  const previousLocalStorage = global.localStorage;
  const previousFetch = global.fetch;
  const calls = [];

  global.localStorage = {
    getItem(key) {
      return key === 'uid' ? uid : null;
    }
  };
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      status: 200,
      headers: { get: () => 'application/json; charset=utf-8' },
      text: async () => JSON.stringify(responseData)
    };
  };

  t.after(() => {
    if (previousLocalStorage === undefined) delete global.localStorage;
    else global.localStorage = previousLocalStorage;
    if (previousFetch === undefined) delete global.fetch;
    else global.fetch = previousFetch;
  });

  return calls;
}

test('Sota 识别只命中精确域名', () => {
  assert.equal(isSotaAgentDomain('www.sotamodel.net'), true);
  assert.equal(isSotaAgentDomain('sotamodel.net'), false);
  assert.equal(isSotaAgentDomain('www.sotamodel.net.example.com'), false);
});

test('页面状态请求使用 uid 和 New-Api-User，不添加通用认证头', async (t) => {
  const calls = installPageRequestStubs(t, '12345', {
    success: true,
    data: { checked_in_today: true, reward: 100 }
  });

  const result = await requestSotaAgentInPage('GET', SOTA_AGENT_CHECK_IN_PATH, SOTA_AGENT_USER_HEADER);

  assert.equal(result.hasUid, true);
  assert.equal(result.httpStatus, 200);
  assert.equal(Object.hasOwn(result, 'uid'), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/user/sota-agent-checkin');
  assert.equal(calls[0].options.credentials, 'include');
  assert.equal(calls[0].options.headers['New-Api-User'], '12345');
  assert.equal(Object.hasOwn(calls[0].options.headers, 'Authorization'), false);
});

test('缺少 uid 时不发送请求并判为未登录', async (t) => {
  const calls = installPageRequestStubs(t, '', {});
  const rawResult = await requestSotaAgentInPage('GET', SOTA_AGENT_CHECK_IN_PATH, SOTA_AGENT_USER_HEADER);
  const parsed = parseSotaAgentResponse(rawResult, 'GET');

  assert.equal(calls.length, 0);
  assert.equal(parsed.unauthenticated, true);
  assert.equal(parsed.success, false);
});

test('今日已签流程只查询一次，不发送 POST', async () => {
  const methods = [];
  const flowResult = await runSotaAgentCheckInFlow(async (method) => {
    methods.push(method);
    return {
      httpStatus: 200,
      data: { success: true, data: { checked_in_today: true, reward: 100 } }
    };
  });

  assert.deepEqual(methods, ['GET']);
  assert.equal(flowResult.execResult.alreadyCheckedIn, true);
  assert.equal(flowResult.queryVerified, true);
  assert.equal(flowResult.shouldFallback, false);
});

test('接口确认未登录时只查询一次并进入页面兜底', async () => {
  const methods = [];
  const flowResult = await runSotaAgentCheckInFlow(async (method) => {
    methods.push(method);
    return {
      httpStatus: 401,
      data: { message: 'Unauthorized, not logged in and no access token provided', success: false }
    };
  });

  assert.deepEqual(methods, ['GET']);
  assert.equal(flowResult.execResult.unauthenticated, true);
  assert.equal(flowResult.shouldFallback, true);
});

test('只有确认今日未签后才按 GET、POST、GET 执行并复核', async () => {
  const methods = [];
  const responses = [
    { httpStatus: 200, data: { success: true, data: { checked_in_today: false } } },
    { httpStatus: 200, data: { success: true, data: { reward: 100 } } },
    { httpStatus: 200, data: { success: true, data: { checked_in_today: true, reward: 100 } } }
  ];
  const flowResult = await runSotaAgentCheckInFlow(async (method) => {
    methods.push(method);
    return responses.shift();
  });

  assert.deepEqual(methods, ['GET', 'POST', 'GET']);
  assert.equal(flowResult.execResult.success, true);
  assert.equal(flowResult.execResult.alreadyCheckedIn, false);
  assert.equal(flowResult.queryVerified, true);
  assert.equal(flowResult.shouldFallback, false);
});

test('GET 200 且 checked_in_today=true 判为已登录且今日已签', () => {
  const result = parseSotaAgentResponse({
    httpStatus: 200,
    data: { success: true, data: { checked_in_today: true, reward: 100 } }
  }, 'GET');

  assert.equal(result.authenticated, true);
  assert.equal(result.alreadyCheckedIn, true);
  assert.equal(result.reward, 100);
});

test('GET 200 且今日未签只确认登录态，交给 POST', () => {
  const result = parseSotaAgentResponse({
    httpStatus: 200,
    data: { success: true, data: { checked_in_today: false } }
  }, 'GET');

  assert.equal(result.authenticated, true);
  assert.equal(result.success, false);
  assert.equal(result.alreadyCheckedIn, false);
});

test('POST 返回 checked_in_today=true 记为本次签到成功而非此前已签', () => {
  const result = parseSotaAgentResponse({
    httpStatus: 200,
    data: { success: true, data: { checked_in_today: true, reward: 100 } }
  }, 'POST');

  assert.equal(result.success, true);
  assert.equal(result.alreadyCheckedIn, false);
  assert.equal(result.reward, 100);
});

test('POST 的空奖励字段不会被当作数值零和成功证据', () => {
  const result = parseSotaAgentResponse({
    httpStatus: 200,
    data: { data: { checked_in_today: false, reward: null } }
  }, 'POST');

  assert.equal(result.success, false);
  assert.equal(result.reward, null);
});

test('非 2xx 响应即使带已签字段也不会判为成功', () => {
  const result = parseSotaAgentResponse({
    httpStatus: 500,
    data: { data: { checked_in_today: true, reward: 100 } }
  }, 'GET');

  assert.equal(result.success, false);
  assert.equal(result.alreadyCheckedIn, false);
  assert.equal(result.authenticated, false);
});

test('裸请求的真实 401 响应判为未登录', () => {
  const result = parseSotaAgentResponse({
    httpStatus: 401,
    data: { success: false, message: 'Unauthorized, not logged in and no access token provided' }
  }, 'GET');

  assert.equal(result.unauthenticated, true);
  assert.equal(result.success, false);
});

test('Sota 配置使用独立端点且不改变普通 NewAPI 默认配置', () => {
  const sota = buildSiteConfig({
    domain: 'www.sotamodel.net',
    type: 'sota-agent'
  });
  const newApi = buildSiteConfig({
    domain: 'example.com',
    type: 'newapi'
  });

  assert.equal(sota.visitUrl, 'https://www.sotamodel.net/agents');
  assert.equal(sota.signExecUrl, 'https://www.sotamodel.net/api/user/sota-agent-checkin');
  assert.equal(sota.signQueryUrl, 'https://www.sotamodel.net/api/user/sota-agent-checkin');
  assert.equal(sota.useApi, true);

  const sotaWithForeignPage = buildSiteConfig({
    domain: 'www.sotamodel.net',
    type: 'sota-agent',
    pageUrl: 'https://example.com/agents'
  });
  assert.equal(sotaWithForeignPage.visitUrl, 'https://www.sotamodel.net/agents');

  assert.equal(newApi.visitUrl, 'https://example.com/console/personal');
  assert.equal(newApi.signExecUrl, 'https://example.com/api/user/checkin');
  assert.equal(newApi.signQueryUrl, 'https://example.com/api/user/checkin');
  assert.equal(newApi.useApi, false);

  const mismatchedDomain = buildSiteConfig({
    domain: 'www.sotamodel.net.example.com',
    type: 'sota-agent'
  });
  assert.equal(mismatchedDomain.type, 'newapi');
  assert.equal(mismatchedDomain.signExecUrl, 'https://www.sotamodel.net.example.com/api/user/checkin');
});

test('Sota 页面地址分支不影响其他站点页面地址', () => {
  assert.equal(getSitePageUrl({
    domain: 'www.sotamodel.net',
    type: 'sota-agent',
    pageUrl: 'https://example.com/agents'
  }), 'https://www.sotamodel.net/agents');
  assert.equal(getSitePageUrl({
    domain: 'example.com',
    type: 'newapi'
  }), 'https://example.com/console/personal');
});

test('原有站点类型的默认配置保持不变', () => {
  const cases = [
    ['auto', '/console/personal', '/api/user/checkin', '/api/user/checkin', false],
    ['newapi', '/console/personal', '/api/user/checkin', '/api/user/checkin', false],
    ['sub2api', '/check-in', '/api/v1/user/check-in', '/api/v1/user/check-in', false],
    ['zenapi', '/user', '/api/u/checkin', '/api/u/dashboard', false],
    ['infinite-canvas', '/check-in', '/api/auth/check-in', '/api/auth/me', true],
    ['deeix-chat', '/chat', '/api/v1/billing/checkin', '/api/v1/billing/overview', true],
    ['points-checkin', '/#/checkin', '/api/points/checkin', '/api/auth/me', true],
    ['localapi', '/checkin', '/user/api/checkin', '/user/api/dashboard', true]
  ];

  for (const [type, pagePath, execPath, queryPath, useApi] of cases) {
    const site = buildSiteConfig({ domain: 'example.com', type });
    assert.equal(site.type, type);
    assert.equal(site.visitUrl, `https://example.com${pagePath}`);
    assert.equal(site.signExecUrl, `https://example.com${execPath}`);
    assert.equal(site.signQueryUrl, `https://example.com${queryPath}`);
    assert.equal(site.useApi, useApi);
    assert.equal(getSitePageUrl({ domain: 'example.com', type }), `https://example.com${pagePath}`);
  }
});

test('默认开启 API 的类型仍尊重显式关闭接口调用', () => {
  const cases = [
    ['infinite-canvas', 'example.com'],
    ['deeix-chat', 'example.com'],
    ['points-checkin', 'example.com'],
    ['localapi', 'example.com'],
    ['sota-agent', 'www.sotamodel.net']
  ];
  for (const [type, domain] of cases) {
    const site = buildSiteConfig({ domain, type, useApi: false });
    assert.equal(site.useApi, false);
  }
});
