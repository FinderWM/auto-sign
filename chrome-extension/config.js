// 默认站点配置（首次安装时写入 storage）
const DEFAULT_SITES = [];

// 全局配置
const GLOBAL_CONFIG = {
  autoSignTime: '09:00',
  retryTimes: 2,
  requestTimeout: 10000
};

const SOTA_AGENT_SITE_TYPE = 'sota-agent';
const SOTA_AGENT_PAGE_PATH = '/agents';
const SOTA_AGENT_CHECK_IN_PATH = '/api/user/sota-agent-checkin';
const FENGWIND_WELFARE_SITE_TYPE = 'fengwind-welfare';
const FENGWIND_WELFARE_DOMAIN = 'api-welfalre.fengwind.com';
const FENGWIND_WELFARE_PAGE_PATH = '/';
const FENGWIND_WELFARE_CHECK_IN_PATH = '/api/checkin';
const FENGWIND_WELFARE_STATUS_PATH = '/api/checkin/status';
const PIPI_STUDIO_SITE_TYPE = 'pipi-studio';
const PIPI_STUDIO_DOMAIN = 'img.pipiwangcom.com';
const PIPI_STUDIO_PAGE_PATH = '/';
const PIPI_STUDIO_CHECK_IN_PATH = '/api/v1/pc/checkin';
const PIPI_STUDIO_ME_PATH = '/api/v1/pc/me';
const DEFAULT_SITE_GROUP_LABEL = '默认';
const GROUP_CHECK_IN_ALARM_PREFIX = 'dailyCheckIn:';

function normalizeSiteGroup(value) {
  const group = String(value || '').trim();
  return group === DEFAULT_SITE_GROUP_LABEL ? '' : group;
}

function filterSitesByGroup(sites = [], group = '') {
  if (!Array.isArray(sites)) return [];
  const normalizedGroup = normalizeSiteGroup(group);
  return sites.filter(site => normalizeSiteGroup(site?.group) === normalizedGroup);
}

function groupSitesByGroup(sites = []) {
  const groups = new Map([['', []]]);
  for (const site of Array.isArray(sites) ? sites : []) {
    const group = normalizeSiteGroup(site?.group);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(site);
  }
  return Array.from(groups, ([group, groupSites]) => ({ group, sites: groupSites }));
}

function normalizeGroupAutoSignTimes(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries = new Map();
  for (const [group, rawTime] of Object.entries(value)) {
    const time = typeof rawTime === 'string' ? rawTime.trim() : '';
    if (!time) continue;
    entries.set(normalizeSiteGroup(group), time);
  }
  return Object.fromEntries(entries);
}

function getGroupAutoSignTime(groupAutoSignTimes, group, fallback = '') {
  const normalizedTimes = normalizeGroupAutoSignTimes(groupAutoSignTimes);
  const normalizedGroup = normalizeSiteGroup(group);
  return Object.prototype.hasOwnProperty.call(normalizedTimes, normalizedGroup)
    ? normalizedTimes[normalizedGroup]
    : fallback;
}

function fillMissingGroupAutoSignTimes(sites, groupAutoSignTimes, fallback) {
  const entries = new Map(Object.entries(normalizeGroupAutoSignTimes(groupAutoSignTimes)));
  for (const item of groupSitesByGroup(sites)) {
    if (!entries.has(item.group)) entries.set(item.group, fallback);
  }
  return Object.fromEntries(entries);
}

function getGroupCheckInAlarmName(group) {
  return `${GROUP_CHECK_IN_ALARM_PREFIX}${encodeURIComponent(normalizeSiteGroup(group))}`;
}

function parseGroupCheckInAlarmName(alarmName) {
  const name = String(alarmName || '');
  if (!name.startsWith(GROUP_CHECK_IN_ALARM_PREFIX)) return null;
  try {
    return { group: normalizeSiteGroup(decodeURIComponent(name.slice(GROUP_CHECK_IN_ALARM_PREFIX.length))) };
  } catch (error) {
    return null;
  }
}

function normalizeSiteType(type) {
  return [
    'auto',
    'newapi',
    'sub2api',
    'zenapi',
    'infinite-canvas',
    'deeix-chat',
    'points-checkin',
    'localapi',
    SOTA_AGENT_SITE_TYPE,
    FENGWIND_WELFARE_SITE_TYPE,
    PIPI_STUDIO_SITE_TYPE
  ].includes(type) ? type : 'newapi';
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

  if (type === SOTA_AGENT_SITE_TYPE || type === FENGWIND_WELFARE_SITE_TYPE || type === PIPI_STUDIO_SITE_TYPE) {
    return defaultUrl;
  }

  return pageUrl;
}

// 从域名生成完整站点配置（多类型站点通用）
function buildSiteConfig(site) {
  const d = site.domain;
  const mode = normalizeSiteMode(site.mode);
  const normalizedType = normalizeSiteType(site.type);
  let exactSiteType = normalizedType;
  if (normalizedType === SOTA_AGENT_SITE_TYPE && d !== 'www.sotamodel.net') {
    exactSiteType = 'newapi';
  }
  if (normalizedType === FENGWIND_WELFARE_SITE_TYPE && d !== FENGWIND_WELFARE_DOMAIN) {
    exactSiteType = 'newapi';
  }
  if (normalizedType === PIPI_STUDIO_SITE_TYPE && d !== PIPI_STUDIO_DOMAIN) {
    exactSiteType = 'newapi';
  }
  const type = mode === 'visit' ? 'visit' : exactSiteType;
  const apiBasePathByType = {
    sub2api: '/api/v1/user/check-in',
    zenapi: '/api/u/checkin',
    'infinite-canvas': '/api/auth/check-in',
    'deeix-chat': '/api/v1/billing/checkin',
    // Cookie 会话 + LinuxDO OAuth + /api/points/checkin（WisArt 等同协议站点）
    'points-checkin': '/api/points/checkin',
    localapi: '/user/api/checkin',
    [SOTA_AGENT_SITE_TYPE]: SOTA_AGENT_CHECK_IN_PATH,
    [FENGWIND_WELFARE_SITE_TYPE]: FENGWIND_WELFARE_CHECK_IN_PATH,
    [PIPI_STUDIO_SITE_TYPE]: PIPI_STUDIO_CHECK_IN_PATH
  };
  const defaultPagePathByType = {
    sub2api: '/check-in',
    zenapi: '/user',
    'infinite-canvas': '/check-in',
    'deeix-chat': '/chat',
    'points-checkin': '/#/checkin',
    localapi: '/checkin',
    [SOTA_AGENT_SITE_TYPE]: SOTA_AGENT_PAGE_PATH,
    [FENGWIND_WELFARE_SITE_TYPE]: FENGWIND_WELFARE_PAGE_PATH,
    [PIPI_STUDIO_SITE_TYPE]: PIPI_STUDIO_PAGE_PATH
  };
  const queryPathByType = {
    zenapi: '/api/u/dashboard',
    'infinite-canvas': '/api/auth/me',
    'deeix-chat': '/api/v1/billing/overview',
    'points-checkin': '/api/auth/me',
    localapi: '/user/api/dashboard',
    [SOTA_AGENT_SITE_TYPE]: SOTA_AGENT_CHECK_IN_PATH,
    [FENGWIND_WELFARE_SITE_TYPE]: FENGWIND_WELFARE_STATUS_PATH,
    [PIPI_STUDIO_SITE_TYPE]: PIPI_STUDIO_ME_PATH
  };
  const apiBasePath = apiBasePathByType[type] || '/api/user/checkin';
  const defaultPagePath = defaultPagePathByType[type] || '/console/personal';
  const queryPath = queryPathByType[type] || apiBasePath;
  const defaultUseApi =
    [
      'infinite-canvas',
      'deeix-chat',
      'points-checkin',
      'localapi',
      SOTA_AGENT_SITE_TYPE,
      FENGWIND_WELFARE_SITE_TYPE,
      PIPI_STUDIO_SITE_TYPE
    ].includes(type) &&
    site.useApi !== false;
  const unauthKeywords = ['login', 'relogin'].includes(mode)
    ? ['未登录', '请登录', '登录后', 'Sign in', 'Log in', 'Login']
    : type === 'localapi'
    ? ['未登录', '请登录', '登录后查看余额', 'Sign in to view balance']
    : ['未登录', '请登录'];
  return {
    siteId: d.replace(/\./g, '_'),
    siteName: site.name || d,
    group: normalizeSiteGroup(site.group),
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
    FENGWIND_WELFARE_SITE_TYPE,
    SOTA_AGENT_SITE_TYPE,
    PIPI_STUDIO_SITE_TYPE,
    buildSiteConfig,
    dedupeSitesByDomain,
    fillMissingGroupAutoSignTimes,
    filterSitesByGroup,
    getGroupAutoSignTime,
    getGroupCheckInAlarmName,
    groupSitesByGroup,
    normalizeGroupAutoSignTimes,
    normalizeSiteGroup,
    normalizeSiteMode,
    normalizeSiteType,
    parseGroupCheckInAlarmName
  };
}
