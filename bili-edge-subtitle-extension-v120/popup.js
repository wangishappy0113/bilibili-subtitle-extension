const DEFAULT_SETTINGS = {
  enabled: false,
  fontSize: 40,
  fontWeight: 700,
  bottomPercent: 10,
  widthPercent: 80,
  bgOpacity: 0.16,
  encoding: 'utf-8'
};

const $ = (id) => document.getElementById(id);

const state = {
  settings: { ...DEFAULT_SETTINGS },
  activeTabId: null,
  connected: false
};

document.addEventListener('DOMContentLoaded', init);

async function init() {
  await loadStoredSettings();
  bindBasicUI();
  fillSettingsUI();
  await connectActiveTab();
}

async function loadStoredSettings() {
  const result = await chrome.storage.local.get('biliSubtitleSettings');
  const saved = result.biliSubtitleSettings || {};
  state.settings = {
    ...DEFAULT_SETTINGS,
    enabled: false,
    fontSize: Number(saved.fontSize) || DEFAULT_SETTINGS.fontSize,
    fontWeight: Number(saved.fontWeight) || DEFAULT_SETTINGS.fontWeight,
    bottomPercent: Number(saved.bottomPercent) || DEFAULT_SETTINGS.bottomPercent,
    widthPercent: Number(saved.widthPercent) || DEFAULT_SETTINGS.widthPercent,
    bgOpacity: typeof saved.bgOpacity === 'number' ? saved.bgOpacity : Number(saved.bgOpacity) || DEFAULT_SETTINGS.bgOpacity,
    encoding: saved.encoding || DEFAULT_SETTINGS.encoding
  };
}

function getPersistedSettings() {
  const { fontSize, fontWeight, bottomPercent, widthPercent, bgOpacity, encoding } = state.settings;
  return { fontSize, fontWeight, bottomPercent, widthPercent, bgOpacity, encoding };
}

function bindBasicUI() {
  $('loadBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', onFileSelected);
  $('clearBtn').addEventListener('click', clearSubtitles);
  $('resetBtn').addEventListener('click', resetSettings);
  $('enabled').addEventListener('change', syncSettingsFromUIAndSend);
  $('encoding').addEventListener('change', syncSettingsFromUIAndSaveOnly);

  bindRange('fontSize', v => String(v));
  bindRange('fontWeight', v => String(v));
  bindRange('bottomPercent', v => `${v}%`);
  bindRange('widthPercent', v => `${v}%`);
  bindRange('bgOpacity', v => String(v));
}

function bindRange(id, formatter) {
  const input = $(id);
  const output = $(`${id}Val`);

  const update = async () => {
    output.textContent = formatter(input.value);
    await syncSettingsFromUIAndSend();
  };

  input.addEventListener('input', update);
  output.textContent = formatter(input.value);
}

function fillSettingsUI() {
  $('enabled').checked = state.settings.enabled;
  $('encoding').value = state.settings.encoding;
  $('fontSize').value = state.settings.fontSize;
  $('fontWeight').value = state.settings.fontWeight;
  $('bottomPercent').value = state.settings.bottomPercent;
  $('widthPercent').value = state.settings.widthPercent;
  $('bgOpacity').value = state.settings.bgOpacity;

  $('fontSizeVal').textContent = String(state.settings.fontSize);
  $('fontWeightVal').textContent = String(state.settings.fontWeight);
  $('bottomPercentVal').textContent = `${state.settings.bottomPercent}%`;
  $('widthPercentVal').textContent = `${state.settings.widthPercent}%`;
  $('bgOpacityVal').textContent = String(state.settings.bgOpacity);
}

function readSettingsFromUI() {
  return {
    enabled: $('enabled').checked,
    fontSize: Number($('fontSize').value),
    fontWeight: Number($('fontWeight').value),
    bottomPercent: Number($('bottomPercent').value),
    widthPercent: Number($('widthPercent').value),
    bgOpacity: Number($('bgOpacity').value),
    encoding: $('encoding').value
  };
}

async function saveSettings() {
  await chrome.storage.local.set({ biliSubtitleSettings: getPersistedSettings() });
}

async function syncSettingsFromUIAndSaveOnly() {
  state.settings = readSettingsFromUI();
  await saveSettings();
  setStatus(`编码已切换为 ${state.settings.encoding}`);
}

async function syncSettingsFromUIAndSend() {
  state.settings = readSettingsFromUI();
  await saveSettings();
  if (!state.connected) {
    const reconnected = await connectActiveTab();
    if (!reconnected) return;
    state.settings = readSettingsFromUI();
  }

  const pageState = await sendMessageToTab({
    type: 'UPDATE_SETTINGS',
    settings: state.settings
  });
  applyPageState(pageState);
}

async function connectActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    setDisconnected('未找到当前标签页');
    return false;
  }

  state.activeTabId = tab.id;
  const isBilibili = /^https:\/\/www\.bilibili\.com\/(video|bangumi\/play)\//.test(tab.url || '');
  $('siteHint').textContent = isBilibili ? 'B站页面' : '非B站页面';

  if (!isBilibili) {
    setDisconnected('请先打开一个 B 站视频或番剧页面');
    return false;
  }

  let response = null;
  try {
    response = await sendMessageToTab({ type: 'PING' });
  } catch (_) {
    response = null;
  }

  if (!response?.ok) {
    const injected = await ensureContentScriptInjected(tab.id);
    if (!injected) {
      setDisconnected('页面尚未建立连接。请刷新视频页后重试');
      return false;
    }

    try {
      response = await sendMessageToTab({ type: 'PING' });
    } catch (_) {
      response = null;
    }
  }

  if (!response?.ok) {
    setDisconnected('无法连接到页面，请刷新当前视频页后再试');
    return false;
  }

  state.connected = true;
  const pageState = await sendMessageToTab({ type: 'GET_STATE' });
  applyPageState(pageState);

  await sendMessageToTab({
    type: 'UPDATE_SETTINGS',
    settings: state.settings
  });

  return true;
}

function applyPageState(pageState) {
  if (!pageState?.ok) return;

  state.settings.enabled = !!pageState.enabled;
  $('enabled').checked = state.settings.enabled;

  if (pageState.subtitleFileName) {
    setStatus(`已加载：${pageState.subtitleFileName}（${pageState.subtitleCount} 条）`);
  } else {
    setStatus('当前视频未加载字幕；切到新视频会自动清空并关闭旧字幕');
  }
}

async function ensureContentScriptInjected(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
    await new Promise(resolve => setTimeout(resolve, 150));
    return true;
  } catch (error) {
    console.warn('[BiliSubtitle] inject content script failed:', error);
    return false;
  }
}

function setDisconnected(message) {
  state.connected = false;
  setStatus(message, true);
}

function setStatus(message, isError = false) {
  const el = $('status');
  el.textContent = message;
  el.classList.toggle('danger', isError);
}

async function sendMessageToTab(message) {
  return chrome.tabs.sendMessage(state.activeTabId, message);
}

async function onFileSelected(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  if (!state.connected) {
    const reconnected = await connectActiveTab();
    if (!reconnected) {
      setDisconnected('页面尚未建立连接，请先刷新视频页一次');
      event.target.value = '';
      return;
    }
  }

  try {
    const buffer = await file.arrayBuffer();
    let text;
    try {
      text = new TextDecoder(state.settings.encoding).decode(buffer);
    } catch {
      text = new TextDecoder('utf-8').decode(buffer);
    }

    const response = await sendMessageToTab({
      type: 'LOAD_SUBTITLES',
      fileName: file.name,
      text
    });

    if (response?.ok) {
      state.settings.enabled = !!response.enabled;
      $('enabled').checked = state.settings.enabled;
      setStatus(`已加载：${file.name}（${response.count} 条）`);
    } else {
      setDisconnected(`加载失败：${response?.error || '未知错误'}`);
    }
  } catch (error) {
    setDisconnected(`读取文件失败：${String(error)}`);
  } finally {
    event.target.value = '';
  }
}

async function clearSubtitles() {
  if (!state.connected) {
    const reconnected = await connectActiveTab();
    if (!reconnected) return;
  }
  await sendMessageToTab({ type: 'CLEAR_SUBTITLES' });
  state.settings.enabled = false;
  $('enabled').checked = false;
  setStatus('字幕已清空并关闭');
}

async function resetSettings() {
  const keepEnabled = $('enabled').checked;
  state.settings = { ...DEFAULT_SETTINGS, enabled: keepEnabled };
  await saveSettings();
  fillSettingsUI();
  if (state.connected) {
    const pageState = await sendMessageToTab({
      type: 'UPDATE_SETTINGS',
      settings: state.settings
    });
    applyPageState(pageState);
  } else {
    setStatus('已恢复默认样式');
  }
}
