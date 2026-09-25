const ids = [
  'ankiUrl', 'deckName', 'modelName', 'contentField', 'audioField', 'sourceField',
'audioSeconds', 'audioAlignToSentence', 'audioPrePadding', 'audioPostPadding', 'audioMaxAlignedSeconds', 'captionSeconds', 'captionTimingAdjustment', 'minSentenceWords', 'autoEnableCaptions', 'hideCaptions',
  'translationEnabled', 'geminiStudyNoteInstruction',
  'aiProofreadEnabled', 'geminiApiKey', 'hololiveDictionaryEnabled', 'hololiveDictionary'
];
let config = {};
let currentModelFields = [];

init();

async function init() {
  await loadBuildInfo();
  config = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
  document.getElementById('ankiUrl').value = config.ankiUrl;
  document.getElementById('audioSeconds').value = config.audioSeconds;
  document.getElementById('audioAlignToSentence').checked = config.audioAlignToSentence !== false;
  document.getElementById('audioPrePadding').value = config.audioPrePadding ?? 2.0;
  document.getElementById('audioPostPadding').value = config.audioPostPadding ?? -0.5;
  document.getElementById('audioMaxAlignedSeconds').value = config.audioMaxAlignedSeconds ?? 18;
  document.getElementById('captionSeconds').value = config.captionSeconds;
  document.getElementById('captionTimingAdjustment').value = config.captionTimingAdjustment ?? 0;
  document.getElementById('minSentenceWords').value = config.minSentenceWords || 3;
  document.getElementById('autoEnableCaptions').checked = !!config.autoEnableCaptions;
  document.getElementById('hideCaptions').checked = !!config.hideCaptions;
  document.getElementById('translationEnabled').checked = !!config.translationEnabled;
  document.getElementById('geminiStudyNoteInstruction').value = config.geminiStudyNoteInstruction || '';
  document.getElementById('aiProofreadEnabled').checked = config.aiProofreadEnabled !== false;
  document.getElementById('geminiApiKey').value = config.geminiApiKey || '';
  document.getElementById('hololiveDictionaryEnabled').checked = config.hololiveDictionaryEnabled !== false;
  document.getElementById('hololiveDictionary').value = config.hololiveDictionary || globalThis.HOLOLIVE_DICTIONARY_DEFAULT || '';

  setSelect('deckName', [config.deckName], config.deckName);
  setSelect('modelName', [config.modelName], config.modelName);
  const initialFields = [...new Set([
    config.contentField, config.audioField, config.sourceField, 'Mnemonics'
  ].filter(Boolean))];
  setFieldSelects(initialFields);
  await loadLearnedDictionaries();
  await loadGeminiDebugLog();
}

async function loadBuildInfo() {
  const el = document.getElementById('buildInfoStatus');
  if (!el) return;
  const uiVersion = String(chrome.runtime.getManifest()?.version || 'unknown');
  try {
    const r = await chrome.runtime.sendMessage({ type: 'GET_BUILD_INFO' });
    if (!r?.ok) {
      el.textContent = `UI v${uiVersion} / Background: 旧版または応答なし。chrome://extensions でこの拡張機能を「再読み込み」してください。`;
      el.className = 'message error';
      return;
    }
    const backgroundVersion = String(r.backgroundBuild || r.manifestVersion || 'unknown');
    const manifestVersion = String(r.manifestVersion || 'unknown');
    const promptVersion = String(r.promptVersion || 'unknown');
    const reviewModel = String(r.reviewModel || r.geminiModel || 'unknown');
    const translationModel = String(r.translationModel || 'unknown');
    const matched = uiVersion === backgroundVersion && uiVersion === manifestVersion;
    el.textContent = `UI v${uiVersion} / Background v${backgroundVersion} / Prompt ${promptVersion} / 校閲 ${reviewModel} / 翻訳 ${translationModel}` +
      (matched ? '' : '  ← バージョン不一致。chrome://extensions で「再読み込み」してください。');
    el.className = matched ? 'message' : 'message error';
  } catch (err) {
    el.textContent = `UI v${uiVersion} / Background確認失敗: ${err?.message || err}。chrome://extensions で「再読み込み」してください。`;
    el.className = 'message error';
  }
}

document.getElementById('refreshAnki').addEventListener('click', async () => {
  const status = document.getElementById('ankiStatus');
  status.textContent = '接続中…';
  status.className = 'message';

  await chrome.runtime.sendMessage({
    type: 'SAVE_CONFIG',
    config: {
      ...config,
      ankiUrl: document.getElementById('ankiUrl').value.trim(),
      geminiApiKey: document.getElementById('geminiApiKey').value.trim(),
      hololiveDictionary: document.getElementById('hololiveDictionary').value
    }
  });
  config.ankiUrl = document.getElementById('ankiUrl').value.trim();

  const currentModel = document.getElementById('modelName').value || config.modelName;
  const r = await chrome.runtime.sendMessage({ type: 'ANKI_REFRESH', modelName: currentModel });
  if (!r.ok) {
    status.textContent = r.error;
    status.className = 'message error';
    return;
  }
  status.textContent = 'Ankiに接続しました。';
  setSelect('deckName', r.decks, config.deckName);
  setSelect('modelName', r.models, config.modelName || r.model);
  const selectedModel = document.getElementById('modelName').value;
  const fieldsResponse = await chrome.runtime.sendMessage({ type: 'ANKI_MODEL_FIELDS', modelName: selectedModel });
  if (fieldsResponse.ok) setFieldSelects(fieldsResponse.fields);
});

document.getElementById('modelName').addEventListener('change', async (e) => {
  const r = await chrome.runtime.sendMessage({ type: 'ANKI_MODEL_FIELDS', modelName: e.target.value });
  if (r.ok) setFieldSelects(r.fields);
});

document.getElementById('resetHololiveDictionary').addEventListener('click', () => {
  document.getElementById('hololiveDictionary').value = globalThis.HOLOLIVE_DICTIONARY_DEFAULT || '';
  const status = document.getElementById('saveStatus');
  status.textContent = '初期HOLO標準辞書を読み込みました。保存ボタンで確定してください。';
  status.className = 'message';
});


document.getElementById('resetGeminiStudyNoteInstruction').addEventListener('click', async () => {
  try {
    const latest = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
    const fallback = String(latest?.defaultGeminiStudyNoteInstruction || '');
    document.getElementById('geminiStudyNoteInstruction').value = fallback || String(config.geminiStudyNoteInstruction || '');
    const status = document.getElementById('saveStatus');
    status.textContent = fallback ? '語彙抽出指令を初期値に戻しました。保存ボタンで確定してください。' : '初期指令を取得できませんでした。';
    status.className = `message${fallback ? '' : ' error'}`;
  } catch (err) {
    const status = document.getElementById('saveStatus');
    status.textContent = `初期指令を取得できませんでした: ${err?.message || err}`;
    status.className = 'message error';
  }
});


let geminiDebugEntries = [];

async function loadGeminiDebugLog() {
  const select = document.getElementById('geminiDebugLogSelect');
  const view = document.getElementById('geminiDebugLogView');
  if (!select || !view) return;
  const r = await chrome.runtime.sendMessage({ type: 'GET_GEMINI_DEBUG_LOG' });
  if (!r?.ok) {
    view.textContent = r?.error || 'デバッグログを取得できませんでした。';
    return;
  }
  geminiDebugEntries = Array.isArray(r.entries) ? [...r.entries].reverse() : [];
  select.innerHTML = '';
  if (!geminiDebugEntries.length) {
    const op = document.createElement('option');
    op.value = '';
    op.textContent = 'ログなし';
    select.appendChild(op);
    view.textContent = 'まだログがありません。Ankiカードを1枚作成するとここに記録されます。';
    return;
  }
  geminiDebugEntries.forEach((entry, i) => {
    const op = document.createElement('option');
    op.value = String(i);
    const dt = entry?.timestamp ? new Date(Number(entry.timestamp)).toLocaleString('ja-JP') : '時刻不明';
    const src = String(entry?.sourceText || '').replace(/\s+/g, ' ').slice(0, 70);
    const kind = entry?.kind === 'translation' ? '翻訳' : '校閲';
    op.textContent = `${dt} | ${kind} | ${entry?.ok ? 'OK' : 'ERROR'} | ${src || '(字幕なし)'}`;
    select.appendChild(op);
  });
  select.value = '0';
  renderGeminiDebugEntry(0);
}

function renderGeminiDebugEntry(index) {
  const view = document.getElementById('geminiDebugLogView');
  const entry = geminiDebugEntries[Number(index) || 0];
  if (!view) return;
  if (!entry) {
    view.textContent = 'ログがありません。';
    return;
  }
  view.textContent = JSON.stringify(entry, null, 2);
}

const geminiDebugSelect = document.getElementById('geminiDebugLogSelect');
if (geminiDebugSelect) {
  geminiDebugSelect.addEventListener('change', e => renderGeminiDebugEntry(e.target.value));
}

const refreshGeminiDebugLog = document.getElementById('refreshGeminiDebugLog');
if (refreshGeminiDebugLog) {
  refreshGeminiDebugLog.addEventListener('click', async () => {
    await loadGeminiDebugLog();
    const status = document.getElementById('geminiDebugStatus');
    if (status) {
      status.textContent = 'ログを更新しました。';
      status.className = 'message';
    }
  });
}

const copyGeminiDebugLog = document.getElementById('copyGeminiDebugLog');
if (copyGeminiDebugLog) {
  copyGeminiDebugLog.addEventListener('click', async () => {
    const status = document.getElementById('geminiDebugStatus');
    const text = document.getElementById('geminiDebugLogView')?.textContent || '';
    try {
      await navigator.clipboard.writeText(text);
      if (status) {
        status.textContent = '表示中のログをコピーしました。';
        status.className = 'message';
      }
    } catch (err) {
      if (status) {
        status.textContent = `コピーに失敗しました: ${err?.message || err}`;
        status.className = 'message error';
      }
    }
  });
}

const clearGeminiDebugLog = document.getElementById('clearGeminiDebugLog');
if (clearGeminiDebugLog) {
  clearGeminiDebugLog.addEventListener('click', async () => {
    const r = await chrome.runtime.sendMessage({ type: 'CLEAR_GEMINI_DEBUG_LOG' });
    const status = document.getElementById('geminiDebugStatus');
    if (r?.ok) {
      await loadGeminiDebugLog();
      if (status) {
        status.textContent = 'デバッグログを消去しました。';
        status.className = 'message';
      }
    } else if (status) {
      status.textContent = r?.error || 'ログ消去に失敗しました。';
      status.className = 'message error';
    }
  });
}

async function loadLearnedDictionaries() {
  const r = await chrome.runtime.sendMessage({ type: 'GET_LEARNED_DICTIONARIES' });
  if (!r?.ok) return;
  renderLearnedDictionary('userLearnedDictionaryList', r.user || [], 'user');
}

function renderLearnedDictionary(containerId, entries, layer) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.textContent = 'まだ登録されていません。';
    Object.assign(empty.style, { color: '#777', fontSize: '13px', padding: '6px 0' });
    container.appendChild(empty);
    return;
  }
  const sorted = [...entries].sort((a,b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  for (const entry of sorted) {
    const row = document.createElement('div');
    Object.assign(row.style, {
      display: 'grid', gridTemplateColumns: '1fr auto', gap: '10px', alignItems: 'center',
      border: '1px solid #ddd', borderRadius: '8px', padding: '8px 10px', background: '#fff'
    });
    const text = document.createElement('div');
    text.style.minWidth = '0';
    const pair = document.createElement('div');
    pair.textContent = `${entry.from} → ${entry.to}`;
    Object.assign(pair.style, { fontFamily: 'Consolas, monospace', fontSize: '13px', overflowWrap: 'anywhere' });
    const meta = document.createElement('div');
    const origin = String(entry.origin || 'manual');
    const sourceLabel = origin === 'manual'
      ? 'ユーザー修正'
      : origin.startsWith('gemini-card')
        ? 'Gemini（Anki作成時・固有名詞）'
        : '自動学習';
    meta.textContent = `${sourceLabel}・登録/確認 ${Number(entry.count || 1)}回${entry.confidence ? `・確信度 ${Math.round(Number(entry.confidence) * 100)}%` : ''}`;
    Object.assign(meta.style, { color: '#777', fontSize: '11px', marginTop: '3px' });
    text.append(pair, meta);
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '削除';
    del.addEventListener('click', async () => {
      const r = await chrome.runtime.sendMessage({ type: 'DELETE_LEARNED_DICTIONARY_ENTRY', layer, id: entry.id });
      const status = document.getElementById('dictionaryStatus');
      status.textContent = r?.ok ? '辞書項目を削除しました。' : (r?.error || '削除に失敗しました。');
      status.className = `message${r?.ok ? '' : ' error'}`;
      if (r?.ok) await loadLearnedDictionaries();
    });
    row.append(text, del);
    container.appendChild(row);
  }
}

document.getElementById('save').addEventListener('click', async () => {
  const out = {};
  for (const id of ids) {
    const el = document.getElementById(id);
    out[id] = el.type === 'checkbox' ? el.checked : el.value;
  }
  out.audioSeconds = Number(out.audioSeconds);
  out.audioPrePadding = Math.max(-8, Math.min(8, Number(out.audioPrePadding) || 0));
  out.audioPostPadding = Math.max(-8, Math.min(8, Number(out.audioPostPadding) || 0));
  out.audioMaxAlignedSeconds = Math.max(8, Math.min(35, Number(out.audioMaxAlignedSeconds) || 18));
  out.captionSeconds = Number(out.captionSeconds);
  out.captionTimingAdjustment = Math.max(0, Math.min(10, Number(out.captionTimingAdjustment) || 0));
  out.minSentenceWords = Math.max(1, Math.min(20, Number(out.minSentenceWords) || 3));
  out.geminiApiKey = String(out.geminiApiKey || '').trim();
  out.geminiStudyNoteInstruction = String(out.geminiStudyNoteInstruction || '').trim();
  out.hololiveDictionary = String(out.hololiveDictionary || '');

  const status = document.getElementById('saveStatus');
  if (!out.deckName || !out.modelName || !out.contentField || !out.audioField) {
    status.textContent = 'デッキ、ノートタイプ、本文フィールド、音声フィールドを設定してください。';
    status.className = 'message error';
    return;
  }
  if (out.translationEnabled && !currentModelFields.some(x => String(x).toLowerCase() === 'mnemonics')) {
    status.textContent = '日本語訳・単語/熟語を使う場合は、ノートタイプにMnemonicsフィールドが必要です。Ankiへ接続してフィールド一覧を更新してください。';
    status.className = 'message error';
    return;
  }
  if ((out.aiProofreadEnabled || out.translationEnabled) && !out.geminiApiKey) {
    status.textContent = 'Gemini校閲またはGemini翻訳を使う場合は、Gemini APIキーを設定してください。';
    status.className = 'message error';
    return;
  }
  const r = await chrome.runtime.sendMessage({ type: 'SAVE_CONFIG', config: out });
  status.textContent = r.ok ? '保存しました。' : r.error;
  status.className = `message${r.ok ? '' : ' error'}`;
  config = { ...config, ...out };
});

function setSelect(id, values, preferred) {
  const el = document.getElementById(id);
  const unique = [...new Set((values || []).filter(Boolean))];
  el.innerHTML = '';
  for (const value of unique) {
    const op = document.createElement('option');
    op.value = value;
    op.textContent = value;
    el.appendChild(op);
  }
  if (preferred && unique.includes(preferred)) el.value = preferred;
}

function setOptionalFieldSelect(id, fields, preferred) {
  const el = document.getElementById(id);
  el.innerHTML = '<option value="">使用しない</option>';
  for (const field of fields || []) {
    const op = document.createElement('option');
    op.value = field;
    op.textContent = field;
    el.appendChild(op);
  }
  if (preferred && (fields || []).includes(preferred)) el.value = preferred;
}

function setFieldSelects(fields) {
  currentModelFields = Array.isArray(fields) ? [...fields] : [];
  const content = document.getElementById('contentField');
  const audio = document.getElementById('audioField');
  const source = document.getElementById('sourceField');
  const previous = {
    content: content.value || config.contentField,
    audio: audio.value || config.audioField,
    source: source.value || config.sourceField
  };
  setSelect('contentField', fields, previous.content);
  setSelect('audioField', fields, previous.audio);
  setOptionalFieldSelect('sourceField', fields, previous.source);

  if ((fields || []).includes('Content')) content.value = previous.content && (fields || []).includes(previous.content) ? previous.content : 'Content';
  if ((fields || []).includes('Audio')) audio.value = previous.audio && (fields || []).includes(previous.audio) ? previous.audio : 'Audio';
}
