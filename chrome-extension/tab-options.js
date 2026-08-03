(function(root) {
  function getTemporaryCheckInTabCreateOptions(url) {
    return {
      url,
      active: false
    };
  }

  function shouldKeepOfficialPageFallbackTabOpen() {
    return false;
  }

  function getOfficialPageFallbackFailureMessage(pageResult = {}) {
    if (pageResult.kind === 'security-check') {
      return '站点要求完成 Turnstile 安全验证，自动签到已停止';
    }
    if (pageResult.kind === 'no-button') {
      return '未找到官方页面签到按钮，自动签到失败';
    }
    if (pageResult.kind === 'timeout') {
      return '官方页面签到请求超时，自动签到失败';
    }
    return '官方页面签到失败，自动签到已停止';
  }

  root.getTemporaryCheckInTabCreateOptions = getTemporaryCheckInTabCreateOptions;
  root.shouldKeepOfficialPageFallbackTabOpen = shouldKeepOfficialPageFallbackTabOpen;
  root.getOfficialPageFallbackFailureMessage = getOfficialPageFallbackFailureMessage;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      getTemporaryCheckInTabCreateOptions,
      getOfficialPageFallbackFailureMessage,
      shouldKeepOfficialPageFallbackTabOpen
    };
  }
})(typeof self !== 'undefined' ? self : globalThis);
