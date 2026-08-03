(function(root) {
  function buildAuthorizationValue(token) {
    const trimmed = String(token || '').trim();
    if (!trimmed) return null;
    return /^bearer\s+/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
  }

  function buildZenApiLoginUrl(domain) {
    return `https://${domain}/api/u/auth/linuxdo`;
  }

  function extractZenApiLinuxDoToken(url) {
    try {
      const parsed = new URL(url);
      return parsed.searchParams.get('linuxdo_token');
    } catch (e) {
      return null;
    }
  }

  function mergeZenApiTokenHeader(headers, token) {
    if (root.mergeAuthorizationHeader) {
      return root.mergeAuthorizationHeader(headers, token);
    }

    const nextHeaders = { ...(headers || {}) };
    const hasAuthorization = Object.entries(nextHeaders).some(([name, value]) => {
      return name.toLowerCase() === 'authorization' && String(value || '').trim() !== '';
    });
    if (hasAuthorization) return nextHeaders;

    const authorization = buildAuthorizationValue(token);
    if (authorization) {
      nextHeaders.Authorization = authorization;
    }
    return nextHeaders;
  }

  root.buildZenApiLoginUrl = buildZenApiLoginUrl;
  root.extractZenApiLinuxDoToken = extractZenApiLinuxDoToken;
  root.mergeZenApiTokenHeader = mergeZenApiTokenHeader;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      buildZenApiLoginUrl,
      extractZenApiLinuxDoToken,
      mergeZenApiTokenHeader
    };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
