(function(root) {
  const NEW_API_LOGIN_PATHS = ['/sign-in', '/login'];
  const NEW_API_POST_LOGIN_PATHS = ['/profile/', '/dashboard/', '/wallet/', '/console/personal', '/'];

  function appendUniqueUrl(urls, value) {
    const url = String(value || '').trim();
    if (!url || urls.includes(url)) return;
    urls.push(url);
  }

  function isSafeNewApiPath(path) {
    return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//');
  }

  function buildNewApiUrl(domain, path) {
    return `https://${domain}${path}`;
  }

  function getNewApiPreferredRedirectPath(domain, visitUrl) {
    try {
      const parsed = new URL(visitUrl || '');
      if (parsed.hostname !== domain) return '';

      const directRedirect = parsed.searchParams.get('redirect');
      if (isSafeNewApiPath(directRedirect)) {
        return directRedirect;
      }

      const hash = String(parsed.hash || '');
      const hashQuery = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '';
      const hashRedirect = new URLSearchParams(hashQuery).get('redirect');
      if (isSafeNewApiPath(hashRedirect)) {
        return hashRedirect;
      }

      const currentPath = `${parsed.pathname || ''}${parsed.search || ''}${parsed.hash || ''}`;
      if (!isNewApiTargetLoginPage(parsed.toString(), domain) && isSafeNewApiPath(parsed.pathname)) {
        return currentPath || '/';
      }
    } catch (e) {}

    return '';
  }

  function getNewApiPostLoginUrl(domain, visitUrl) {
    return getNewApiPostLoginUrlCandidates(domain, visitUrl)[0] || `https://${domain}/`;
  }

  function hasNewApiUserSession(session) {
    // 优先信任 /api/user/self 实探；本地残留 user/token 仅作弱证据
    if (session?.userAuthenticated) return true;
    if (session?.selfStatus && session.selfStatus !== 401 && (session?.hasUser || session?.accessToken || session?.token)) {
      return true;
    }
    return Boolean(session?.hasUser && (session?.accessToken || session?.token));
  }

  function extractNewApiOAuthState(payload) {
    if (payload == null) return '';
    if (typeof payload === 'string') {
      const text = payload.trim();
      return text || '';
    }
    if (typeof payload !== 'object') return '';
    const candidates = [
      payload.flow_token,
      payload.state,
      payload.data?.flow_token,
      payload.data?.state,
      typeof payload.data === 'string' ? payload.data : ''
    ];
    for (const candidate of candidates) {
      const text = String(candidate || '').trim();
      if (text) return text;
    }
    return '';
  }

  function extractNewApiAccessToken(payload) {
    if (!payload || typeof payload !== 'object') return '';
    const candidates = [
      payload.access_token,
      payload.accessToken,
      payload.token,
      payload.data?.access_token,
      payload.data?.accessToken,
      payload.data?.token
    ];
    for (const candidate of candidates) {
      const text = String(candidate || '').trim();
      if (text) return text;
    }
    return '';
  }

  function buildNewApiLinuxDoOAuthUrl(clientId, state) {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      state
    });
    return `https://connect.linux.do/oauth2/authorize?${params.toString()}`;
  }

  function isNewApiOAuthCallbackUrl(url) {
    try {
      const parsed = new URL(url || '');
      if (!parsed.searchParams.has('code')) return false;
      // 仅把 OAuth 回调页当回调；登录页带 redirect 等不应误判
      return /^\/oauth(?:\/|$)/i.test(parsed.pathname) ||
        /\/oauth\//i.test(parsed.pathname) ||
        parsed.searchParams.has('state');
    } catch (e) {
      return false;
    }
  }

  function isNewApiTargetLoginPage(url, domain) {
    try {
      const parsed = new URL(url || '');
      const hashRoute = String(parsed.hash || '')
        .replace(/^#!?/, '')
        .trim();
      const loginPattern = /^\/(?:login|sign-?in)(?:\/|$|\?)/i;
      return parsed.hostname === domain &&
        (
          loginPattern.test(parsed.pathname) ||
          loginPattern.test(hashRoute)
        ) &&
        !isNewApiOAuthCallbackUrl(url);
    } catch (e) {
      return false;
    }
  }

  function classifyNewApiDailyLoginAuthState({ url, domain, pageState, session } = {}) {
    let parsed = null;
    try {
      parsed = new URL(url || '');
    } catch (e) {}

    const isTargetDomain = Boolean(parsed && (!domain || parsed.hostname === domain));
    const isLoginPage = Boolean(
      pageState?.isTargetLoginPage ||
      (isTargetDomain && isNewApiTargetLoginPage(parsed.toString(), domain || parsed.hostname))
    );
    const isOAuthCallback = Boolean(parsed && isNewApiOAuthCallbackUrl(parsed.toString()));
    const isAuthenticatedRoute = Boolean(
      isTargetDomain &&
      /^\/(?:console|dashboard|profile|wallet|user)(?:\/|$)/i.test(parsed.pathname)
    );
    const hasPersistedUser = Boolean(session?.hasUser);
    const hasAuthenticatedPageControl = Boolean(
      pageState?.hasLogoutEntry ||
      pageState?.hasCheckInButton ||
      pageState?.checkedInStateText
    );

    let reason = 'unknown';
    let authenticated = false;
    if (!isLoginPage && !isOAuthCallback && session?.userAuthenticated) {
      authenticated = true;
      reason = 'verified-session';
    } else if (!isLoginPage && !isOAuthCallback && hasAuthenticatedPageControl) {
      authenticated = true;
      reason = 'authenticated-page-control';
    } else if (!isLoginPage && !isOAuthCallback && isAuthenticatedRoute && hasPersistedUser) {
      authenticated = true;
      reason = 'persisted-user-on-authenticated-route';
    }

    let unauthenticated = false;
    if (!authenticated && isLoginPage) {
      unauthenticated = true;
      reason = 'login-page';
    } else if (!authenticated && !isOAuthCallback && pageState?.hasLinuxDoLoginEntry && !hasPersistedUser) {
      unauthenticated = true;
      reason = 'login-entry-without-user';
    }

    return {
      authenticated,
      unauthenticated,
      reason,
      isAuthenticatedRoute,
      isLoginPage,
      isOAuthCallback
    };
  }

  function getNewApiLoginUrl(domain, visitUrl) {
    return getNewApiLoginUrlCandidates(domain, visitUrl)[0] || `https://${domain}/sign-in`;
  }

  function getNewApiLoginUrlCandidates(domain, visitUrl) {
    const urls = [];
    const redirectPath = getNewApiPreferredRedirectPath(domain, visitUrl);

    try {
      const parsed = new URL(visitUrl || '');
      if (parsed.hostname === domain && isNewApiTargetLoginPage(parsed.toString(), domain)) {
        appendUniqueUrl(urls, parsed.toString());
      }
    } catch (e) {}

    for (const path of NEW_API_LOGIN_PATHS) {
      if (redirectPath) {
        appendUniqueUrl(urls, buildNewApiUrl(domain, `${path}?redirect=${encodeURIComponent(redirectPath)}`));
      }
      appendUniqueUrl(urls, buildNewApiUrl(domain, path));
    }

    return urls;
  }

  function getNewApiPostLoginUrlCandidates(domain, visitUrl) {
    const urls = [];

    try {
      const parsed = new URL(visitUrl || '');
      if (parsed.hostname === domain && !isNewApiTargetLoginPage(parsed.toString(), domain)) {
        appendUniqueUrl(urls, parsed.toString());
      }
    } catch (e) {}

    const redirectPath = getNewApiPreferredRedirectPath(domain, visitUrl);
    if (redirectPath) {
      appendUniqueUrl(urls, buildNewApiUrl(domain, redirectPath));
    }

    for (const path of NEW_API_POST_LOGIN_PATHS) {
      appendUniqueUrl(urls, buildNewApiUrl(domain, path));
    }

    return urls;
  }

  function parseNewApiUserId(user, fallbackUserId = null) {
    if (fallbackUserId !== null && fallbackUserId !== undefined && String(fallbackUserId).trim()) {
      return String(fallbackUserId).trim();
    }

    if (!user) return null;
    let parsed = user;
    if (typeof user === 'string') {
      try {
        parsed = JSON.parse(user);
      } catch (e) {
        return null;
      }
    }
    return parsed?.id ||
      parsed?.user_id ||
      parsed?.uid ||
      parsed?.data?.id ||
      parsed?.data?.user_id ||
      parsed?.data?.uid ||
      null;
  }

  function buildNewApiExistingSessionHeaders({ cookies, user, userId, token, tabId, baseHeaders } = {}) {
    const headers = { ...(baseHeaders || {}) };
    if (!headers.Cookie && !headers.cookie && Array.isArray(cookies) && cookies.length > 0) {
      headers.Cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    }

    const resolvedUserId = parseNewApiUserId(user, userId);
    const hasUserHeader = Object.keys(headers).some(name => name.toLowerCase() === 'new-api-user');
    if (resolvedUserId && !hasUserHeader) {
      headers['New-API-User'] = String(resolvedUserId);
    }

    if (token && !Object.keys(headers).some(name => name.toLowerCase() === 'authorization')) {
      headers.Authorization = /^bearer\s+/i.test(String(token)) ? String(token) : `Bearer ${token}`;
    }

    if (tabId) {
      headers._tabId = tabId;
    }
    return headers;
  }

  function shouldTryNewApiOAuth({ hasCachedHeaders, hasExistingSessionHeaders } = {}) {
    return !hasCachedHeaders && !hasExistingSessionHeaders;
  }

  root.buildNewApiExistingSessionHeaders = buildNewApiExistingSessionHeaders;
  root.buildNewApiLinuxDoOAuthUrl = buildNewApiLinuxDoOAuthUrl;
  root.classifyNewApiDailyLoginAuthState = classifyNewApiDailyLoginAuthState;
  root.extractNewApiAccessToken = extractNewApiAccessToken;
  root.extractNewApiOAuthState = extractNewApiOAuthState;
  root.getNewApiLoginUrl = getNewApiLoginUrl;
  root.getNewApiLoginUrlCandidates = getNewApiLoginUrlCandidates;
  root.getNewApiPostLoginUrl = getNewApiPostLoginUrl;
  root.getNewApiPostLoginUrlCandidates = getNewApiPostLoginUrlCandidates;
  root.hasNewApiUserSession = hasNewApiUserSession;
  root.isNewApiOAuthCallbackUrl = isNewApiOAuthCallbackUrl;
  root.isNewApiTargetLoginPage = isNewApiTargetLoginPage;
  root.parseNewApiUserId = parseNewApiUserId;
  root.shouldTryNewApiOAuth = shouldTryNewApiOAuth;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      buildNewApiExistingSessionHeaders,
      buildNewApiLinuxDoOAuthUrl,
      classifyNewApiDailyLoginAuthState,
      extractNewApiAccessToken,
      extractNewApiOAuthState,
      getNewApiLoginUrl,
      getNewApiLoginUrlCandidates,
      getNewApiPostLoginUrl,
      getNewApiPostLoginUrlCandidates,
      hasNewApiUserSession,
      isNewApiOAuthCallbackUrl,
      isNewApiTargetLoginPage,
      parseNewApiUserId,
      shouldTryNewApiOAuth
    };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
