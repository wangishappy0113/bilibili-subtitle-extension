(() => {
  'use strict';

  const DEFAULT_SETTINGS = {
    fontSize: 40,
    fontWeight: 700,
    bottomPercent: 10,
    widthPercent: 80,
    bgOpacity: 0.16
  };

  const REFERENCE_PLAYER_WIDTH = 1280;
  const REFERENCE_PLAYER_HEIGHT = 720;
  const MIN_SCALE = 0.6;
  const MAX_SCALE = 2.2;

  let settings = { ...DEFAULT_SETTINGS };
  let subtitles = [];
  let subtitleFileName = '';
  let subtitleEnabled = false;
  let currentVideo = null;
  let currentContainer = null;
  let subtitleDiv = null;
  let lastSubtitleIndex = -1;
  let lastUrl = location.href;
  let currentResizeObserver = null;
  let lastLayoutKey = '';
  let currentMediaKey = extractMediaKey(location.href);

  init();

  async function init() {
    await loadSettings();
    ensurePlayerBinding();
    startObservers();
    startRenderLoop();
  }

  async function loadSettings() {
    try {
      const result = await chrome.storage.local.get('biliSubtitleSettings');
      const saved = result.biliSubtitleSettings || {};
      settings = {
        ...DEFAULT_SETTINGS,
        fontSize: Number(saved.fontSize) || DEFAULT_SETTINGS.fontSize,
        fontWeight: Number(saved.fontWeight) || DEFAULT_SETTINGS.fontWeight,
        bottomPercent: Number(saved.bottomPercent) || DEFAULT_SETTINGS.bottomPercent,
        widthPercent: Number(saved.widthPercent) || DEFAULT_SETTINGS.widthPercent,
        bgOpacity: typeof saved.bgOpacity === 'number' ? saved.bgOpacity : Number(saved.bgOpacity) || DEFAULT_SETTINGS.bgOpacity
      };
    } catch (error) {
      console.warn('[BiliSubtitle] loadSettings failed:', error);
      settings = { ...DEFAULT_SETTINGS };
    }
  }

  function startObservers() {
    const observer = new MutationObserver(() => {
      handleRouteChange();
      ensurePlayerBinding();
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    window.addEventListener('resize', () => applySubtitleStyle(true));
    window.addEventListener('fullscreenchange', () => applySubtitleStyle(true));
    window.addEventListener('popstate', handleRouteChange);
    window.addEventListener('hashchange', handleRouteChange);
  }

  function startRenderLoop() {
    const loop = () => {
      handleRouteChange();
      ensurePlayerBinding();
      applySubtitleStyle();
      renderCurrentSubtitle(false);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  function extractMediaKey(url) {
    try {
      const parsed = new URL(url, location.origin);
      const path = parsed.pathname;
      let m = path.match(/^\/video\/(BV[0-9A-Za-z]+)/i);
      if (m) return m[1].toUpperCase();
      m = path.match(/^\/video\/(av\d+)/i);
      if (m) return m[1].toLowerCase();
      m = path.match(/^\/bangumi\/play\/(ep\d+)/i);
      if (m) return m[1].toLowerCase();
      m = path.match(/^\/bangumi\/play\/(ss\d+)/i);
      if (m) return m[1].toLowerCase();
      return '';
    } catch {
      return '';
    }
  }

  function handleRouteChange() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
    }

    const nextMediaKey = extractMediaKey(location.href);
    if (nextMediaKey !== currentMediaKey) {
      currentMediaKey = nextMediaKey;
      resetSubtitlesForNewVideo();
      currentVideo = null;
      currentContainer = null;
      lastLayoutKey = '';
      if (currentResizeObserver) {
        currentResizeObserver.disconnect();
        currentResizeObserver = null;
      }
      if (!nextMediaKey && subtitleDiv && subtitleDiv.isConnected) {
        subtitleDiv.remove();
      }
    }
  }

  function resetSubtitlesForNewVideo() {
    subtitles = [];
    subtitleFileName = '';
    subtitleEnabled = false;
    lastSubtitleIndex = -1;
    if (subtitleDiv) {
      subtitleDiv.innerHTML = '';
      subtitleDiv.style.display = 'none';
    }
  }

  function ensurePlayerBinding() {
    const video = document.querySelector('video');
    const container = findVideoContainer(video);

    if (!video || !container) {
      if (subtitleDiv) subtitleDiv.style.display = 'none';
      return;
    }

    const videoChanged = currentVideo !== video;
    const containerChanged = currentContainer !== container;

    if (videoChanged) {
      currentVideo = video;
      lastSubtitleIndex = -1;
    }

    if (containerChanged || !subtitleDiv || !subtitleDiv.isConnected) {
      currentContainer = container;
      ensureSubtitleDiv(container);
      observeContainerResize(container);
    }

    applySubtitleStyle();
  }

  function findVideoContainer(video) {
    const selectors = [
      '.bpx-player-video-wrap',
      '.bpx-player-video-area',
      '.bilibili-player-video-wrap',
      '.bilibili-player-video',
      '.bpx-player-container'
    ];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element) return element;
    }

    return video?.parentElement || null;
  }

  function ensureSubtitleDiv(container) {
    if (subtitleDiv && subtitleDiv.isConnected) {
      subtitleDiv.remove();
    }

    subtitleDiv = document.createElement('div');
    subtitleDiv.id = 'bili-local-subtitle-overlay';

    const style = subtitleDiv.style;
    style.position = 'absolute';
    style.left = '50%';
    style.transform = 'translateX(-50%)';
    style.color = '#fff';
    style.textAlign = 'center';
    style.pointerEvents = 'none';
    style.zIndex = '999999';
    style.minHeight = '30px';
    style.padding = '4px 10px';
    style.borderRadius = '8px';
    style.lineHeight = '1.55';
    style.wordBreak = 'break-word';
    style.whiteSpace = 'pre-wrap';
    style.boxSizing = 'border-box';
    style.fontFamily = '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif';

    const computed = window.getComputedStyle(container);
    if (computed.position === 'static') {
      container.style.position = 'relative';
    }

    container.appendChild(subtitleDiv);
    applySubtitleStyle(true);
  }

  function observeContainerResize(container) {
    if (currentResizeObserver) {
      currentResizeObserver.disconnect();
      currentResizeObserver = null;
    }

    if (!container || typeof ResizeObserver === 'undefined') return;

    currentResizeObserver = new ResizeObserver(() => {
      applySubtitleStyle(true);
    });
    currentResizeObserver.observe(container);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function getResponsiveScale() {
    if (!currentContainer) return 1;

    const rect = currentContainer.getBoundingClientRect();
    if (!rect.width || !rect.height) return 1;

    const widthScale = rect.width / REFERENCE_PLAYER_WIDTH;
    const heightScale = rect.height / REFERENCE_PLAYER_HEIGHT;
    return clamp(Math.min(widthScale, heightScale), MIN_SCALE, MAX_SCALE);
  }

  function buildLayoutKey(scale) {
    if (!currentContainer) return '';
    const rect = currentContainer.getBoundingClientRect();
    return [
      Math.round(rect.width),
      Math.round(rect.height),
      subtitleEnabled,
      subtitles.length,
      settings.fontSize,
      settings.fontWeight,
      settings.bottomPercent,
      settings.widthPercent,
      settings.bgOpacity,
      scale.toFixed(3)
    ].join('|');
  }

  function applySubtitleStyle(force = false) {
    if (!subtitleDiv) return;

    const scale = getResponsiveScale();
    const layoutKey = buildLayoutKey(scale);
    if (!force && layoutKey === lastLayoutKey) return;
    lastLayoutKey = layoutKey;

    const fontSize = Math.round(settings.fontSize * scale * 10) / 10;
    const paddingY = Math.max(3, Math.round(4 * scale));
    const paddingX = Math.max(8, Math.round(10 * scale));
    const borderRadius = Math.max(6, Math.round(8 * scale));
    const minHeight = Math.max(24, Math.round(30 * scale));
    const strokeWidth = Math.max(1, Math.round(scale * 10) / 10);
    const shadowBlur1 = Math.max(2, Math.round(2 * scale));
    const shadowBlur2 = Math.max(4, Math.round(4 * scale));
    const shadowBlur3 = Math.max(2, Math.round(2 * scale));
    const shadowBlur4 = Math.max(4, Math.round(4 * scale));
    const shadowOffset1 = Math.max(1, Math.round(scale));
    const shadowOffset2 = Math.max(2, Math.round(2 * scale));

    subtitleDiv.style.display = subtitleEnabled && subtitles.length ? 'block' : 'none';
    subtitleDiv.style.bottom = `${settings.bottomPercent}%`;
    subtitleDiv.style.width = `${settings.widthPercent}%`;
    subtitleDiv.style.fontSize = `${fontSize}px`;
    subtitleDiv.style.fontWeight = String(settings.fontWeight);
    subtitleDiv.style.minHeight = `${minHeight}px`;
    subtitleDiv.style.padding = `${paddingY}px ${paddingX}px`;
    subtitleDiv.style.borderRadius = `${borderRadius}px`;
    subtitleDiv.style.background = `rgba(0, 0, 0, ${settings.bgOpacity})`;
    subtitleDiv.style.textShadow = [
      `0 0 ${shadowBlur1}px rgba(0,0,0,0.98)`,
      `0 0 ${shadowBlur2}px rgba(0,0,0,0.98)`,
      `${shadowOffset1}px ${shadowOffset1}px ${shadowBlur3}px rgba(0,0,0,0.98)`,
      `${shadowOffset2}px ${shadowOffset2}px ${shadowBlur4}px rgba(0,0,0,0.95)`
    ].join(', ');
    subtitleDiv.style.webkitTextStroke = `${strokeWidth}px rgba(0,0,0,0.72)`;
  }

  function renderCurrentSubtitle(force) {
    if (!subtitleDiv || !currentVideo || !subtitleEnabled || !subtitles.length) {
      if (subtitleDiv && (!subtitleEnabled || !subtitles.length)) subtitleDiv.innerHTML = '';
      return;
    }

    const time = currentVideo.currentTime;
    let matchIndex = -1;

    if (
      lastSubtitleIndex >= 0 &&
      subtitles[lastSubtitleIndex] &&
      time >= subtitles[lastSubtitleIndex].start &&
      time <= subtitles[lastSubtitleIndex].end
    ) {
      matchIndex = lastSubtitleIndex;
    } else {
      for (let i = 0; i < subtitles.length; i++) {
        const item = subtitles[i];
        if (time >= item.start && time <= item.end) {
          matchIndex = i;
          break;
        }
      }
    }

    if (!force && matchIndex === lastSubtitleIndex) return;

    lastSubtitleIndex = matchIndex;
    subtitleDiv.innerHTML = matchIndex >= 0 ? subtitles[matchIndex].text : '';
  }

  function parseTime(timeStr) {
    const clean = timeStr.trim().replace(',', '.');
    const parts = clean.split(':');
    if (parts.length !== 3) return NaN;

    const hours = Number(parts[0]);
    const minutes = Number(parts[1]);
    const seconds = Number(parts[2]);

    if ([hours, minutes, seconds].some(Number.isNaN)) return NaN;
    return hours * 3600 + minutes * 60 + seconds;
  }

  function escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normalizeSubtitleText(text) {
    return escapeHtml(text)
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\N/g, '<br>')
      .replace(/\\n/g, '<br>')
      .replace(/\r?\n/g, '<br>');
  }

  function parseSRT(text) {
    const blocks = text
      .replace(/^\uFEFF/, '')
      .split(/\r?\n\r?\n+/)
      .map(block => block.trim())
      .filter(Boolean);

    const result = [];

    for (const block of blocks) {
      const lines = block.split(/\r?\n/);
      if (!lines.length) continue;

      let timeLineIndex = 0;
      if (/^\d+$/.test(lines[0].trim()) && lines[1]?.includes('-->')) {
        timeLineIndex = 1;
      }

      const timeLine = lines[timeLineIndex];
      if (!timeLine || !timeLine.includes('-->')) continue;

      const [startRaw, endRaw] = timeLine.split('-->');
      const start = parseTime(startRaw.trim());
      const end = parseTime(endRaw.trim().split(/\s+/)[0]);
      if (Number.isNaN(start) || Number.isNaN(end)) continue;

      const contentLines = lines.slice(timeLineIndex + 1);
      const content = contentLines.join('\n').trim();
      if (!content) continue;

      result.push({
        start,
        end,
        text: normalizeSubtitleText(content)
      });
    }

    return result;
  }

  function parseVTT(text) {
    const normalized = text
      .replace(/^\uFEFF/, '')
      .replace(/^WEBVTT[^\r\n]*\r?\n+/i, '');
    const blocks = normalized
      .split(/\r?\n\r?\n+/)
      .map(block => block.trim())
      .filter(Boolean);

    const result = [];

    for (const block of blocks) {
      const lines = block.split(/\r?\n/);
      if (!lines.length) continue;

      let timeLineIndex = 0;
      if (!lines[0].includes('-->') && lines[1]?.includes('-->')) {
        timeLineIndex = 1;
      }

      const timeLine = lines[timeLineIndex];
      if (!timeLine || !timeLine.includes('-->')) continue;

      const [startRaw, endRaw] = timeLine.split('-->');
      const start = parseTime(startRaw.trim());
      const end = parseTime(endRaw.trim().split(/\s+/)[0]);
      if (Number.isNaN(start) || Number.isNaN(end)) continue;

      const content = lines.slice(timeLineIndex + 1).join('\n').trim();
      if (!content) continue;

      result.push({ start, end, text: normalizeSubtitleText(content) });
    }

    return result;
  }

  function splitAssDialogue(line) {
    const fields = [];
    let current = '';
    let commas = 0;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === ',' && commas < 9) {
        fields.push(current);
        current = '';
        commas += 1;
      } else {
        current += ch;
      }
    }
    fields.push(current);
    return fields;
  }

  function parseASSTime(timeStr) {
    const m = timeStr.trim().match(/^(\d+):(\d{1,2}):(\d{1,2})[.](\d{1,2})$/);
    if (!m) return NaN;
    const hours = Number(m[1]);
    const minutes = Number(m[2]);
    const seconds = Number(m[3]);
    const centiseconds = Number(m[4]);
    return hours * 3600 + minutes * 60 + seconds + centiseconds / 100;
  }

  function parseASS(text) {
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
    const result = [];

    for (const line of lines) {
      if (!line.startsWith('Dialogue:')) continue;
      const payload = line.slice('Dialogue:'.length).trim();
      const fields = splitAssDialogue(payload);
      if (fields.length < 10) continue;

      const start = parseASSTime(fields[1]);
      const end = parseASSTime(fields[2]);
      const content = fields.slice(9).join(',').trim();

      if (Number.isNaN(start) || Number.isNaN(end) || !content) continue;

      result.push({
        start,
        end,
        text: normalizeSubtitleText(content)
      });
    }

    return result;
  }

  function parseSubtitleFile(text, fileName) {
    const lower = (fileName || '').toLowerCase();
    if (lower.endsWith('.ass') || text.includes('[Script Info]') || text.includes('[Events]')) {
      return parseASS(text);
    }
    if (lower.endsWith('.vtt') || text.trimStart().startsWith('WEBVTT')) {
      return parseVTT(text);
    }
    return parseSRT(text);
  }

  function getState() {
    return {
      ok: true,
      settings,
      enabled: subtitleEnabled,
      subtitleFileName,
      subtitleCount: subtitles.length,
      mediaKey: currentMediaKey,
      url: location.href
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== 'object') return;

    if (message.type === 'PING') {
      sendResponse({ ok: true, url: location.href, mediaKey: currentMediaKey });
      return true;
    }

    if (message.type === 'LOAD_SUBTITLES') {
      try {
        subtitles = parseSubtitleFile(message.text || '', message.fileName || '');
        subtitleFileName = message.fileName || '未命名字幕';
        subtitleEnabled = subtitles.length > 0;
        lastSubtitleIndex = -1;
        applySubtitleStyle(true);
        renderCurrentSubtitle(true);
        sendResponse({ ok: true, count: subtitles.length, fileName: subtitleFileName, enabled: subtitleEnabled, mediaKey: currentMediaKey });
      } catch (error) {
        sendResponse({ ok: false, error: String(error) });
      }
      return true;
    }

    if (message.type === 'CLEAR_SUBTITLES') {
      resetSubtitlesForNewVideo();
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === 'UPDATE_SETTINGS') {
      const incoming = message.settings || {};
      settings = {
        ...settings,
        fontSize: Number(incoming.fontSize) || settings.fontSize,
        fontWeight: Number(incoming.fontWeight) || settings.fontWeight,
        bottomPercent: Number(incoming.bottomPercent) || settings.bottomPercent,
        widthPercent: Number(incoming.widthPercent) || settings.widthPercent,
        bgOpacity: typeof incoming.bgOpacity === 'number' ? incoming.bgOpacity : Number(incoming.bgOpacity) || settings.bgOpacity
      };
      if (typeof incoming.enabled === 'boolean') {
        subtitleEnabled = incoming.enabled && subtitles.length > 0;
      }
      chrome.storage.local.set({ biliSubtitleSettings: settings }).catch(() => {});
      applySubtitleStyle(true);
      renderCurrentSubtitle(true);
      sendResponse(getState());
      return true;
    }

    if (message.type === 'GET_STATE') {
      sendResponse(getState());
      return true;
    }
  });
})();
