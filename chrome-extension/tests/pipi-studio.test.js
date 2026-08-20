const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PIPI_STUDIO_CHECK_IN_PATH,
  PIPI_STUDIO_ME_PATH,
  PIPI_STUDIO_TOKEN_KEY,
  isPipiStudioDomain,
  parsePipiStudioResponse,
  requestPipiStudioInPage,
  runPipiStudioCheckInFlow
} = require('../pipi-studio.js');
const { buildSiteConfig } = require('../config.js');
const { getSitePageUrl } = require('../site-url.js');

function installPageRequestStubs(t, token, responseData) {
  const previousLocalStorage = global.localStorage;
  const previousFetch = global.fetch;
  const calls = [];

  global.localStorage = {
    getItem(key) {
      return key === PIPI_STUDIO_TOKEN_KEY ? token : null;
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

test('皮皮智绘识别只命中精确域名', () => {
  assert.equal(isPipiStudioDomain('img.pipiwangcom.com'), true);
  assert.equal(isPipiStudioDomain('IMG.PIPIWANGCOM.COM'), true);
  assert.equal(isPipiStudioDomain('pipiwangcom.com'), false);
  assert.equal(isPipiStudioDomain('img.pipiwangcom.com.example.com'), false);
});

test('页面请求使用 token 和 Authorization: Bearer', async (t) => {
  const calls = installPageRequestStubs(t, 'tok-123', { checkedIn: true, points: 120 });

  const result = await requestPipiStudioInPage('GET', PIPI_STUDIO_ME_PATH, PIPI_STUDIO_TOKEN_KEY);

  assert.equal(result.hasToken, true);
  assert.equal(result.httpStatus, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/v1/pc/me');
  assert.equal(calls[0].options.credentials, 'include');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer tok-123');
  assert.equal(Object.hasOwn(calls[0].options.headers, 'New-Api-User'), false);
});

test('POST 请求带 JSON body 和 Content-Type', async (t) => {
  const calls = installPageRequestStubs(t, 'tok-123', { grantedPoints: 10 });

  await requestPipiStudioInPage('POST', PIPI_STUDIO_CHECK_IN_PATH, PIPI_STUDIO_TOKEN_KEY);

  assert.equal(calls[0].url, '/api/v1/pc/checkin');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.body, '{}');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
});

test('缺少 token 时不发送请求并判为未登录', async (t) => {
  const calls = installPageRequestStubs(t, '', {});
  const rawResult = await requestPipiStudioInPage('GET', PIPI_STUDIO_ME_PATH, PIPI_STUDIO_TOKEN_KEY);
  const parsed = parsePipiStudioResponse(rawResult, 'GET');

  assert.equal(calls.length, 0);
  assert.equal(rawResult.missingToken, true);
  assert.equal(parsed.unauthenticated, true);
  assert.equal(parsed.success, false);
});

test('今日已签流程只查询一次，不发送 POST', async () => {
  const calls = [];
  const flowResult = await runPipiStudioCheckInFlow(async (method, endpoint) => {
    calls.push({ method, endpoint });
    return { httpStatus: 200, data: { checkedIn: true, points: 120 } };
  });

  assert.deepEqual(calls.map(c => c.method), ['GET']);
  assert.equal(calls[0].endpoint, PIPI_STUDIO_ME_PATH);
  assert.equal(flowResult.execResult.alreadyCheckedIn, true);
  assert.equal(flowResult.queryVerified, true);
  assert.equal(flowResult.shouldFallback, false);
});

test('接口确认未登录时只查询一次并进入页面兜底', async () => {
  const methods = [];
  const flowResult = await runPipiStudioCheckInFlow(async (method) => {
    methods.push(method);
    return { httpStatus: 401, data: { detail: '登录已失效' } };
  });

  assert.deepEqual(methods, ['GET']);
  assert.equal(flowResult.execResult.unauthenticated, true);
  assert.equal(flowResult.shouldFallback, true);
});

test('确认今日未签后按 GET、POST、GET 执行并复核，积分取自复核结果', async () => {
  const methods = [];
  const responses = [
    { httpStatus: 200, data: { checkedIn: false, points: 100 } },
    { httpStatus: 200, data: { grantedPoints: 10 } },
    { httpStatus: 200, data: { checkedIn: true, points: 110 } }
  ];
  const flowResult = await runPipiStudioCheckInFlow(async (method) => {
    methods.push(method);
    return responses.shift();
  });

  assert.deepEqual(methods, ['GET', 'POST', 'GET']);
  assert.equal(flowResult.execResult.success, true);
  assert.equal(flowResult.execResult.points, 110);
  assert.equal(flowResult.queryVerified, true);
  assert.equal(flowResult.shouldFallback, false);
});

test('GET 200 且 checkedIn=true 判为已登录且今日已签，并读取积分', () => {
  const result = parsePipiStudioResponse({
    httpStatus: 200,
    data: { checkedIn: true, points: 120 }
  }, 'GET');

  assert.equal(result.authenticated, true);
  assert.equal(result.alreadyCheckedIn, true);
  assert.equal(result.points, 120);
});

test('GET 200 且今日未签只确认登录态，交给 POST', () => {
  const result = parsePipiStudioResponse({
    httpStatus: 200,
    data: { checkedIn: false, points: 100 }
  }, 'GET');

  assert.equal(result.authenticated, true);
  assert.equal(result.success, false);
  assert.equal(result.alreadyCheckedIn, false);
});

test('POST 返回 grantedPoints 记为本次签到成功', () => {
  const result = parsePipiStudioResponse({
    httpStatus: 200,
    data: { grantedPoints: 10, points: 110 }
  }, 'POST');

  assert.equal(result.success, true);
  assert.equal(result.alreadyCheckedIn, false);
  assert.equal(result.reward, 10);
  assert.match(result.message, /\+10/);
});

test('POST 返回 already=true 记为今日已签', () => {
  const result = parsePipiStudioResponse({
    httpStatus: 200,
    data: { already: true }
  }, 'POST');

  assert.equal(result.alreadyCheckedIn, true);
  assert.equal(result.success, true);
});

test('nested quota.points 也能读取积分', () => {
  const result = parsePipiStudioResponse({
    httpStatus: 200,
    data: { checkedIn: false, quota: { points: 88 } }
  }, 'GET');

  assert.equal(result.points, 88);
});

test('401 响应判为未登录', () => {
  const result = parsePipiStudioResponse({
    httpStatus: 401,
    data: { detail: '登录已失效' }
  }, 'GET');

  assert.equal(result.unauthenticated, true);
  assert.equal(result.success, false);
});

test('404/410 判为接口失效', () => {
  const notFound = parsePipiStudioResponse({ httpStatus: 404, data: { detail: 'Not Found' } }, 'GET');
  assert.equal(notFound.invalidSite, true);
  assert.equal(notFound.success, false);
});

test('皮皮智绘配置使用独立端点，且外域名降级为 NewAPI', () => {
  const pipi = buildSiteConfig({
    domain: 'img.pipiwangcom.com',
    type: 'pipi-studio'
  });

  assert.equal(pipi.type, 'pipi-studio');
  assert.equal(pipi.visitUrl, 'https://img.pipiwangcom.com/');
  assert.equal(pipi.signExecUrl, 'https://img.pipiwangcom.com/api/v1/pc/checkin');
  assert.equal(pipi.signQueryUrl, 'https://img.pipiwangcom.com/api/v1/pc/me');
  assert.equal(pipi.useApi, true);
  assert.equal(getSitePageUrl({ domain: 'img.pipiwangcom.com', type: 'pipi-studio' }), 'https://img.pipiwangcom.com/');

  const foreignPage = buildSiteConfig({
    domain: 'img.pipiwangcom.com',
    type: 'pipi-studio',
    pageUrl: 'https://example.com/foo'
  });
  assert.equal(foreignPage.visitUrl, 'https://img.pipiwangcom.com/');

  const mismatchedDomain = buildSiteConfig({
    domain: 'example.com',
    type: 'pipi-studio'
  });
  assert.equal(mismatchedDomain.type, 'newapi');
  assert.equal(mismatchedDomain.signExecUrl, 'https://example.com/api/user/checkin');
});

test('皮皮智绘默认开启 API，但尊重显式关闭', () => {
  const disabled = buildSiteConfig({ domain: 'img.pipiwangcom.com', type: 'pipi-studio', useApi: false });
  assert.equal(disabled.useApi, false);
});
