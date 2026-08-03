// 默认站点配置（首次安装时写入 storage）
const DEFAULT_SITES = [];

// 全局配置
const GLOBAL_CONFIG = {
  autoSignTime: '09:00',
  retryTimes: 2,
  requestTimeout: 10000
};

function normalizeSiteType(type) {
  return ['auto', 'newapi', 'sub2api', 'zenapi', 'infinite-canvas', 'deeix-chat', 'points-checkin', 'localapi'].includes(type) ? type : 'newapi';
}

function normalizeSiteMode(mode) {
  return ['visit', 'login', 'relogin'].includes(mode) ? mode : 'checkin';
}

function dedupeSitesByDomain(sites) {
  if (!Array.isArray(sites)) return [];
  const seen = new Set();
  const deduped = [];
  for (const site of sites) {
    const domain = String(site?.domain || '').trim().toLowerCase();
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    deduped.push({ ...site, domain });
  }
  return deduped;
}

function normalizeSitePageUrlForType(pageUrl, domain, type, defaultPagePath) {
  const defaultUrl = `https://${domain}${defaultPagePath}`;
  if (!pageUrl) return defaultUrl;

  if (type === 'deeix-chat') {
    try {
      const parsed = new URL(pageUrl);
      if (
        parsed.hostname === domain &&
        (
          parsed.pathname === '/' ||
          parsed.pathname === '/console/personal' ||
          /^\/(?:login|sign-?in)(?:\/|$)/i.test(parsed.pathname)
        )
      ) {
        return defaultUrl;
      }
    } catch (e) {}
  }

  if (type === 'points-checkin') {
    try {
      const parsed = new URL(pageUrl);
      if (parsed.hostname === domain) {
        const hashRoute = String(parsed.hash || '').replace(/^#/, '').split('?')[0] || '';
        if (
          /^\/(?:login|sign-?in)(?:\/|$)/i.test(hashRoute) ||
          parsed.pathname === '/' ||
          parsed.pathname === '/console/personal' ||
          /^\/(?:login|sign-?in)(?:\/|$)/i.test(parsed.pathname)
        ) {
          return defaultUrl;
        }
      }
    } catch (e) {}
  }

  if (type === 'localapi') {
    try {
      const parsed = new URL(pageUrl);
      if (
        parsed.hostname === domain &&
        (
          parsed.pathname === '/' ||
          parsed.pathname === '/console/personal' ||
          /^\/(?:login|sign-?in)(?:\/|$)/i.test(parsed.pathname)
        )
      ) {
        return defaultUrl;
      }
    } catch (e) {}
  }

  return pageUrl;
}

// 从域名生成完整站点配置（多类型站点通用）
function buildSiteConfig(site) {
  const d = site.domain;
  const mode = normalizeSiteMode(site.mode);
  const type = mode === 'visit' ? 'visit' : normalizeSiteType(site.type);
  const apiBasePathByType = {
    sub2api: '/api/v1/user/check-in',
    zenapi: '/api/u/checkin',
    'infinite-canvas': '/api/auth/check-in',
    'deeix-chat': '/api/v1/billing/checkin',
    // Cookie 会话 + LinuxDO OAuth + /api/points/checkin（WisArt 等同协议站点）
    'points-checkin': '/api/points/checkin',
    localapi: '/user/api/checkin'
  };
  const defaultPagePathByType = {
    sub2api: '/check-in',
    zenapi: '/user',
    'infinite-canvas': '/check-in',
    'deeix-chat': '/chat',
    'points-checkin': '/#/checkin',
    localapi: '/checkin'
  };
  const queryPathByType = {
    zenapi: '/api/u/dashboard',
    'infinite-canvas': '/api/auth/me',
    'deeix-chat': '/api/v1/billing/overview',
    'points-checkin': '/api/auth/me',
    localapi: '/user/api/dashboard'
  };
  const apiBasePath = apiBasePathByType[type] || '/api/user/checkin';
  const defaultPagePath = defaultPagePathByType[type] || '/console/personal';
  const queryPath = queryPathByType[type] || apiBasePath;
  const defaultUseApi = ['infinite-canvas', 'deeix-chat', 'points-checkin', 'localapi'].includes(type) && site.useApi !== false;
  const unauthKeywords = ['login', 'relogin'].includes(mode)
    ? ['未登录', '请登录', '登录后', 'Sign in', 'Log in', 'Login']
    : type === 'localapi'
    ? ['未登录', '请登录', '登录后查看余额', 'Sign in to view balance']
    : ['未登录', '请登录'];
  return {
    siteId: d.replace(/\./g, '_'),
    siteName: site.name || d,
    enabled: site.enabled !== false,
    useApi: defaultUseApi || site.useApi === true,  // 默认 false：仅页面点击，避免封号风险
    mode,
    type,
    visitUrl: normalizeSitePageUrlForType(site.pageUrl, d, type, defaultPagePath),
    cookieDomain: d,
    signExecUrl: `https://${d}${apiBasePath}`,
    signExecMethod: 'POST',
    signExecParams: {},
    signQueryUrl: `https://${d}${queryPath}`,
    signQueryMethod: 'GET',
    cookieTestUrl: `https://${d}/`,
    unauthKeywords
  };
}

// 从 storage 加载站点列表
async function loadSitesConfig() {
  const data = await chrome.storage.local.get('userSites');
  const sites = Array.isArray(data.userSites) ? data.userSites : [...DEFAULT_SITES];
  return dedupeSitesByDomain(sites).map(buildSiteConfig);
}

// 保存站点列表到 storage
async function saveSitesConfig(sites) {
  await chrome.storage.local.set({ userSites: dedupeSitesByDomain(sites) });
}

// 读取原始站点列表（简化格式）
async function loadRawSites() {
  const data = await chrome.storage.local.get('userSites');
  const sites = Array.isArray(data.userSites) ? data.userSites : [...DEFAULT_SITES];
  return dedupeSitesByDomain(sites);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DEFAULT_SITES,
    buildSiteConfig,
    dedupeSitesByDomain,
    normalizeSiteMode,
    normalizeSiteType
  };
}
