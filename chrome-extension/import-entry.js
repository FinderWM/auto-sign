// 页面内快捷导入入口
// 当用户浏览的页面存在签到按钮时，在按钮旁注入一个入口，
// 点击即可把当前站点一键导入签到助手（写入 userSites）。
// 该功能完全独立，不影响自动签到流程。
(function () {
  'use strict';

  const ENTRY_CLASS = 'gs-checkin-import-entry';
  const ENTRY_FLAG = 'gsCheckinImportInjected';
  const ENTRY_LABELS = {
    idle: '＋ 加入签到助手',
    added: '－ 移出签到助手'
  };
  const EXTENSION_RELOAD_HINT = '扩展已更新，请刷新页面后重试';
  // 仅接受完整的主动签到按钮文案；禁止在较长说明文字中命中签到关键词。
  const CHECKIN_TEXT = /^(?:立即签到|现在签到|每日签到|每日领取|签到领取|领取奖励|Check in now|daily check.?in|签到|签|领取)$/i;
  const CHECKED_IN_TEXT = /^(?:已签到|已签|今日已签到|今日已签|checked in today|already checked in)$/i;
  const NEGATIVE_TEXT = /设置|配置|settings?|enable|minimum|maximum|quota|已签到|已签|今日已签|already|历史|记录|说明|规则/i;
  const IS_SOTA_AGENT_PAGE = location.hostname === 'www.sotamodel.net' && location.pathname === '/agents';
  const IS_PIPI_STUDIO_PAGE = location.hostname === 'img.pipiwangcom.com';

  let injectedButton = null;
  let cachedDomain = location.hostname.toLowerCase();
  let pollTimer = null;
  let pollDeadline = 0;
  let extensionContextValid = true;
  let reloadHintShown = false;

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      rect.width > 0 &&
      rect.height > 0;
  }

  function getText(el) {
    return [
      el.textContent,
      el.getAttribute && el.getAttribute('aria-label'),
      el.getAttribute && el.getAttribute('title'),
      el.value
    ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }

  function getButtonText(el) {
    const text = getText(el);
    if (!text || text.length > 40) return '';
    return text;
  }

  function isCheckInText(text) {
    if (IS_SOTA_AGENT_PAGE && /^Check in$/i.test(text)) return true;
    return Boolean(text) && CHECKIN_TEXT.test(text) && !NEGATIVE_TEXT.test(text);
  }

  function isCheckedInText(text) {
    if (IS_SOTA_AGENT_PAGE && /^Checked in$/i.test(text)) return true;
    return Boolean(text) && CHECKED_IN_TEXT.test(text);
  }

  // 在页面中查找签到按钮
  // 先用窄选择器粗筛候选，再做文本/可见性判定，避免全量遍历
  function findCheckInButton() {
    // 皮皮智绘：签到按钮文案带动态奖励后缀（如“签到 +100~200”），通用文案启发式不命中；
    // 用稳定的 #checkinBtn / [data-act="checkin"] 精确定位（已签/未签状态均适用）。
    if (IS_PIPI_STUDIO_PAGE) {
      const pipiBtn = document.querySelector('#checkinBtn, [data-act="checkin"]');
      if (pipiBtn && !pipiBtn.classList.contains(ENTRY_CLASS) && isVisible(pipiBtn)) return pipiBtn;
    }

    // gift 图标仍是强特征，但必须同时带有签到/已签到文案，
    // 避免把“奖励中心”这类普通菜单项误判成签到按钮。
    const giftIcons = document.querySelectorAll('.lucide-gift, svg.lucide-gift');
    for (const icon of giftIcons) {
      const btn = icon.closest('button, [role="button"], a');
      if (isGiftCheckInButton(btn)) return btn;
    }

    // 回退：按文案匹配可点击元素（此路径需排除已签到等否定文案）
    const candidates = document.querySelectorAll('button, [role="button"], a, input[type="button"], input[type="submit"]');
    for (const el of candidates) {
      if (isCheckInButton(el)) return el;
      if (IS_SOTA_AGENT_PAGE && isAlreadyCheckedInButton(el)) return el;
    }
    return null;
  }

  function isCheckInButton(el) {
    if (!el || el.classList.contains(ENTRY_CLASS)) return false;
    const text = getButtonText(el);
    if (!isCheckInText(text)) return false;
    return isVisible(el);
  }

  function isAlreadyCheckedInButton(el) {
    if (!el || el.classList.contains(ENTRY_CLASS)) return false;
    const text = getButtonText(el);
    if (!isCheckedInText(text)) return false;
    return isVisible(el);
  }

  function isGiftCheckInButton(el) {
    if (!el || el.classList.contains(ENTRY_CLASS)) return false;
    const text = getButtonText(el);
    if (!text) return false;
    if (!isCheckInText(text) && !isCheckedInText(text)) return false;
    return isVisible(el);
  }

  function createEntryButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = ENTRY_CLASS;
    btn.textContent = ENTRY_LABELS.idle;
    btn.style.cssText = [
      'margin-right:8px',
      'padding:0 14px',
      'font-size:13px',
      'line-height:1',
      'color:#fff',
      'background:#667eea',
      'border:none',
      'border-radius:6px',
      'cursor:pointer',
      'vertical-align:middle',
      'white-space:nowrap',
      'box-shadow:0 1px 3px rgba(0,0,0,0.15)'
    ].join(';');
    btn.addEventListener('click', onEntryClick);
    return btn;
  }

  // 高度对齐签到按钮
  function matchButtonHeight(refBtn) {
    if (!injectedButton || !refBtn) return;
    const rect = refBtn.getBoundingClientRect();
    if (rect.height > 0) {
      injectedButton.style.height = rect.height + 'px';
    }
  }

  function setEntryState(state, label) {
    if (!injectedButton) return;
    injectedButton.dataset.state = state;
    injectedButton.textContent = label || ENTRY_LABELS[state] || ENTRY_LABELS.idle;
    if (state === 'pending') {
      injectedButton.disabled = true;
      injectedButton.style.background = '#9aa3c0';
      injectedButton.style.cursor = 'default';
    } else {
      injectedButton.disabled = false;
      injectedButton.style.background = state === 'added' ? '#dc3545' : '#667eea';
      injectedButton.style.cursor = 'pointer';
    }
  }

  function isExtensionContextInvalidMessage(message) {
    return typeof message === 'string' && /Extension context invalidated/i.test(message);
  }

  function getRuntimeLastErrorMessage() {
    try {
      return chrome.runtime?.lastError?.message || '';
    } catch (error) {
      return error?.message || '';
    }
  }

  function markExtensionContextInvalid(message) {
    if (!isExtensionContextInvalidMessage(message)) return false;
    extensionContextValid = false;
    stopPolling();
    if (injectedButton) {
      injectedButton.dataset.state = 'invalid';
      injectedButton.disabled = true;
      injectedButton.textContent = '扩展已更新，刷新页面';
      injectedButton.style.background = '#9aa3c0';
      injectedButton.style.cursor = 'default';
      injectedButton.title = EXTENSION_RELOAD_HINT;
    }
    if (!reloadHintShown) {
      reloadHintShown = true;
      flash(EXTENSION_RELOAD_HINT, false);
    }
    return true;
  }

  async function onEntryClick() {
    if (!injectedButton || injectedButton.disabled) return;
    if (!extensionContextValid) {
      flash(EXTENSION_RELOAD_HINT, false);
      return;
    }
    const removing = injectedButton.dataset.state === 'added';
    let siteName = '';
    if (!removing) {
      const defaultSiteName = pickSiteName();
      const input = window.prompt('请输入站点名称：', defaultSiteName);
      if (input === null) return;
      siteName = input.trim() || defaultSiteName;
    }
    setEntryState('pending', removing ? '正在移出…' : '正在加入…');

    const site = {
      domain: cachedDomain,
      name: removing ? pickSiteName() : siteName,
      pageUrl: location.href
    };

    try {
      chrome.runtime.sendMessage({ action: removing ? 'removeCurrentSite' : 'importCurrentSite', site }, (response) => {
        const lastErrorMessage = getRuntimeLastErrorMessage();
        if (markExtensionContextInvalid(lastErrorMessage)) return;
        if (lastErrorMessage || !response || !response.success) {
          const msg = (response && response.error) || lastErrorMessage || '加入失败';
          setEntryState(removing ? 'added' : 'idle');
          flash(msg, false);
          return;
        }
        if (removing) {
          setEntryState('idle');
          flash(response.notFound ? '该站点已不在签到列表' : '已移出签到助手', true);
          return;
        }
        setEntryState('added');
        flash(response.alreadyExists ? '该站点已在签到列表' : '已加入签到助手', true);
      });
    } catch (error) {
      if (markExtensionContextInvalid(error?.message)) return;
      if (error?.message) {
        setEntryState(removing ? 'added' : 'idle');
        flash(error.message, false);
        return;
      }
      setEntryState(removing ? 'added' : 'idle');
      flash('加入失败', false);
    }
  }

  function pickSiteName() {
    const og = document.querySelector('meta[property="og:site_name"]');
    if (og && og.content) return og.content.trim();
    const title = (document.title || '').replace(/\s+/g, ' ').trim();
    if (title) return title.slice(0, 60);
    return cachedDomain;
  }

  // 轻量提示，自动消失
  function flash(message, ok) {
    const tip = document.createElement('div');
    tip.textContent = message;
    tip.style.cssText = [
      'position:fixed',
      'right:20px',
      'bottom:20px',
      'z-index:2147483647',
      'padding:10px 16px',
      'font-size:13px',
      'color:#fff',
      'border-radius:8px',
      'box-shadow:0 2px 8px rgba(0,0,0,0.2)',
      'background:' + (ok ? '#28a745' : '#dc3545')
    ].join(';');
    document.body.appendChild(tip);
    setTimeout(() => tip.remove(), 2600);
  }

  // 判断当前域名是否已在签到列表，决定入口初始状态
  function refreshAddedState() {
    if (!injectedButton || !extensionContextValid) return;
    try {
      chrome.storage.local.get('userSites', (data) => {
        const lastErrorMessage = getRuntimeLastErrorMessage();
        if (markExtensionContextInvalid(lastErrorMessage) || lastErrorMessage) return;
        const sites = Array.isArray(data.userSites) ? data.userSites : [];
        const exists = sites.some(s => String(s && s.domain || '').toLowerCase() === cachedDomain);
        if (exists) {
          setEntryState('added');
        } else if (injectedButton.dataset.state !== 'pending') {
          setEntryState('idle');
        }
      });
    } catch (error) {
      markExtensionContextInvalid(error?.message);
    }
  }

  function ensureEntry() {
    // 已注入且仍在文档中，视为完成
    if (injectedButton && injectedButton.isConnected) return true;
    // 引用失效（被 React 重渲染移除），清掉以便重新注入
    injectedButton = null;

    const checkInBtn = findCheckInButton();
    if (!checkInBtn) return false;
    if (checkInBtn.dataset[ENTRY_FLAG] && checkInBtn.previousElementSibling?.classList.contains(ENTRY_CLASS)) {
      return true;
    }

    injectedButton = createEntryButton();
    checkInBtn.dataset[ENTRY_FLAG] = '1';
    matchButtonHeight(checkInBtn);
    // 注入到签到按钮之前（左侧）
    if (checkInBtn.parentNode) {
      checkInBtn.parentNode.insertBefore(injectedButton, checkInBtn);
    }
    refreshAddedState();
    return true;
  }

  // 两阶段轮询：
  // 1) 进入页面后高频(800ms)找按钮注入，最多 15 秒；
  // 2) 注入成功后转入低频(2.5s)守护——签到后 React 会替换按钮并移除入口，
  //    守护负责重新注入。开销极低（几个 querySelector），不会拖慢页面。
  function startPolling() {
    if (!extensionContextValid) return;
    pollDeadline = Date.now() + 15000;
    tick();
  }

  function tick() {
    if (!extensionContextValid) return;
    const injected = ensureEntry();
    if (injected) {
      // 转入低频守护，持续检测入口是否被移除
      pollTimer = setTimeout(tick, 2500);
      return;
    }
    if (Date.now() >= pollDeadline) {
      // 初次未找到按钮：停高频，转入低频守护（页面后续可能异步出现按钮）
      pollTimer = setTimeout(tick, 2500);
      return;
    }
    pollTimer = setTimeout(tick, 800);
  }

  function stopPolling() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  // userSites 变化时同步入口状态（例如在 popup 里删除了站点）
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.userSites) refreshAddedState();
  });

  // 后台标签页暂停守护轮询，回到前台恢复，避免无谓开销
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopPolling();
    } else if (!pollTimer) {
      startPolling();
    }
  });

  function init() {
    startPolling();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
