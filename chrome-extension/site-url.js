(function(root) {
  const DEFAULT_SITE_PAGE_PATH = '/console/personal';
  const FENGWIND_WELFARE_DOMAIN = 'api-welfalre.fengwind.com';

  function normalizeUrlInput(input) {
    const trimmed = String(input || '').trim();
    if (!trimmed) return null;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    if (trimmed.includes('/')) return `https://${trimmed}`;
    return null;
  }

  function applySiteMode(site, mode) {
    const normalizedMode = ['visit', 'login', 'relogin'].includes(mode) ? mode : 'checkin';
    return normalizedMode === 'checkin' ? site : { ...site, mode: normalizedMode };
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
      'sota-agent',
      'fengwind-welfare'
    ].includes(type) ? type : 'auto';
  }

  function applySiteType(site, type) {
    if (site?.mode === 'visit') return site;
    const normalizedType = normalizeSiteType(type);
    if (normalizedType !== 'auto' || type === 'auto') {
      return { ...site, type: normalizedType };
    }
    return site;
  }

  function inferSiteType(domain, type) {
    return type === 'auto' && domain === FENGWIND_WELFARE_DOMAIN
      ? 'fengwind-welfare'
      : type;
  }

  function parseSiteInput(input, mode = 'checkin', type = 'auto') {
    const rawInput = String(input || '').trim();
    const trimmed = rawInput.toLowerCase();
    if (!trimmed) return null;

    const normalizedUrl = normalizeUrlInput(rawInput);
    if (normalizedUrl) {
      try {
        const url = new URL(normalizedUrl);
        if (!url.hostname || !url.hostname.includes('.')) return null;
        const domain = url.hostname.toLowerCase();
        return applySiteType(applySiteMode({
          domain,
          name: domain,
          enabled: true,
          pageUrl: url.href
        }, mode), inferSiteType(domain, type));
      } catch (e) {
        return null;
      }
    }

    const domain = trimmed.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!domain || !domain.includes('.')) return null;
    return applySiteType(applySiteMode({
      domain,
      name: domain,
      enabled: true
    }, mode), inferSiteType(domain, type));
  }

  function getPointsCheckinDefaultPageUrl(domain) {
    return `https://${domain}/#/checkin`;
  }

  function getLocalApiDefaultPageUrl(domain) {
    return `https://${domain}/checkin`;
  }

  function isPointsCheckinLoginLikeUrl(pageUrl, domain) {
    try {
      const parsed = new URL(pageUrl);
      if (parsed.hostname !== domain) return false;
      const hashRoute = String(parsed.hash || '').replace(/^#/, '').split('?')[0] || '';
      if (/^\/(?:login|sign-?in)(?:\/|$)/i.test(hashRoute)) return true;
      if (
        parsed.pathname === '/' ||
        parsed.pathname === '/console/personal' ||
        /^\/(?:login|sign-?in)(?:\/|$)/i.test(parsed.pathname)
      ) {
        return true;
      }
    } catch (e) {}
    return false;
  }

  function getSitePageUrl(site) {
    if (site?.pageUrl) {
      if (site?.type === 'deeix-chat') {
        try {
          const parsed = new URL(site.pageUrl);
          if (
            parsed.hostname === site.domain &&
            (
              parsed.pathname === '/' ||
              parsed.pathname === '/console/personal' ||
              /^\/(?:login|sign-?in)(?:\/|$)/i.test(parsed.pathname)
            )
          ) {
            return `https://${site.domain}/chat`;
          }
        } catch (e) {}
      }
      if (site?.type === 'points-checkin' && isPointsCheckinLoginLikeUrl(site.pageUrl, site.domain)) {
        return getPointsCheckinDefaultPageUrl(site.domain);
      }
      if (site?.type === 'localapi') {
        try {
          const parsed = new URL(site.pageUrl);
          if (parsed.hostname === site.domain && (parsed.pathname === '/' || /^\/login(?:\/|$)/i.test(parsed.pathname))) {
            return getLocalApiDefaultPageUrl(site.domain);
          }
        } catch (e) {}
      }
      if (site?.type === 'sota-agent' && site.domain === 'www.sotamodel.net') {
        return `https://${site.domain}/agents`;
      }
      if (site?.type === 'fengwind-welfare' && site.domain === 'api-welfalre.fengwind.com') {
        return `https://${site.domain}/`;
      }
      return site.pageUrl;
    }
    if (site?.type === 'deeix-chat') return `https://${site.domain}/chat`;
    if (site?.type === 'infinite-canvas') return `https://${site.domain}/check-in`;
    if (site?.type === 'zenapi') return `https://${site.domain}/user`;
    if (site?.type === 'sub2api') return `https://${site.domain}/check-in`;
    if (site?.type === 'points-checkin') return getPointsCheckinDefaultPageUrl(site.domain);
    if (site?.type === 'localapi') return getLocalApiDefaultPageUrl(site.domain);
    if (site?.type === 'sota-agent' && site.domain === 'www.sotamodel.net') return `https://${site.domain}/agents`;
    if (site?.type === 'fengwind-welfare' && site.domain === 'api-welfalre.fengwind.com') {
      return `https://${site.domain}/`;
    }
    return `https://${site.domain}${DEFAULT_SITE_PAGE_PATH}`;
  }

  function getSiteTabCreateOptions(site) {
    return {
      url: getSitePageUrl(site),
      active: false
    };
  }

  root.parseSiteInput = parseSiteInput;
  root.getSitePageUrl = getSitePageUrl;
  root.getSiteTabCreateOptions = getSiteTabCreateOptions;
  root.normalizeSiteType = normalizeSiteType;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      getSiteTabCreateOptions,
      normalizeSiteType,
      parseSiteInput,
      getSitePageUrl
    };
  }
})(typeof self !== 'undefined' ? self : globalThis);
