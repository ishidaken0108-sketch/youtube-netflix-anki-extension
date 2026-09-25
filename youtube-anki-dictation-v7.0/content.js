(() => {
const CONTENT_BUILD = '9.4.0';
const CONTENT_MARKER_ATTR = 'data-anki-dictation-content-build';
try { document.documentElement?.setAttribute(CONTENT_MARKER_ATTR, CONTENT_BUILD); } catch {}

function isCurrentContentInstance() {
  try {
    return document.documentElement?.getAttribute(CONTENT_MARKER_ATTR) === CONTENT_BUILD && !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

async function sendRuntimeMessage(message) {
  if (!isCurrentContentInstance()) {
    throw new Error('拡張機能が更新されています。YouTubeページを1回再読み込みしてください。');
  }
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (err) {
    const text = String(err?.message || err || '');
    if (/Extension context invalidated/i.test(text)) {
      throw new Error('拡張機能が更新されています。YouTubeページを1回再読み込みしてください。');
    }
    throw err;
  }
}

function sendRuntimeMessageQuiet(message) {
  sendRuntimeMessage(message).catch(() => {});
}

let running = false;
let pollTimer = null;
let hideCaptions = true;
let autoEnableCaptions = true;
let enabledByUs = false;
let history = [];
let lastText = '';

const transcriptPanelState = {
  host: null,
  shadow: null,
  root: null,
  list: null,
  cues: [],
  selected: new Set(),
  anchorIndex: -1,
  wordStartIndex: null,
  wordEndIndex: null,
  wordMap: new Map(),
  wordMetaMap: new Map(),
  currentIndex: -1,
  rowMap: new Map(),
  follow: true,
  manualScrollUntil: 0,
  updateTimer: null,
  liveRefreshTimer: null,
  videoId: '',
  isLive: false,
  loading: false,
  currentTranscript: null,
  preferredTrackId: '',
  trackSelect: null,
  trackRow: null,
  navigationRefreshTimer: null,
  refreshSerial: 0,
  pendingVideoId: ''
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isCurrentContentInstance() || !message) return;
  if (message.type === 'ANKI_DICTATION_PING') {
    sendResponse({ ok: true, version: CONTENT_BUILD });
    return;
  }
  if (message.type === 'DICTATION_START') {
    start(message);
    sendResponse({ ok: true });
    return;
  }
  if (message.type === 'DICTATION_STOP') {
    stop();
    sendResponse({ ok: true });
    return;
  }
  if (message.type === 'GET_CAPTURE_CONTEXT') {
    sendResponse(getCaptureContext(
      Number(message.lookbackSeconds) || 6,
      Math.max(1, Math.min(20, Number(message.minSentenceWords) || 3)),
      Math.max(0, Math.min(10, Number(message.captionTimingAdjustment) || 0))
    ));
    return;
  }
  if (message.type === 'GET_CAPTURE_CANDIDATES') {
    sendResponse(getCaptureCandidates(
      Number(message.lookbackSeconds) || 6,
      Math.max(1, Math.min(20, Number(message.minSentenceWords) || 3)),
      Math.max(0, Math.min(10, Number(message.captionTimingAdjustment) || 0))
    ));
    return;
  }
  if (message.type === 'SHOW_CANDIDATE_PICKER') {
    showCandidatePicker(message.candidates || [], message.baseContext || {});
    sendResponse({ ok: true });
    return;
  }
  if (message.type === 'TRANSCRIPT_PANEL_LOADING') {
    setTranscriptPanelLoading(true, message.preserveSelection !== false);
    sendResponse({ ok: true });
    return;
  }
  if (message.type === 'SHOW_TRANSCRIPT_PANEL') {
    showTranscriptPanel(message.transcript || {}, {
      focusCurrent: message.focusCurrent !== false,
      preserveSelection: message.preserveSelection !== false
    });
    sendResponse({ ok: true });
    return;
  }
  if (message.type === 'HIDE_TRANSCRIPT_PANEL') {
    destroyTranscriptPanel();
    sendResponse({ ok: true });
    return;
  }
  if (message.type === 'SHOW_TOAST') {
    showToast(message.message, !!message.isError);
    sendResponse({ ok: true });
  }
});

function syncAudioTimeline() {
  if (!running) return;
  guardTranscriptAgainstCurrentVideo();
  const video = document.querySelector('video');
  if (!video) return;
  const currentTime = Number(video.currentTime);
  const playbackRate = Number(video.playbackRate || 1);
  if (!Number.isFinite(currentTime) || !Number.isFinite(playbackRate)) return;
  sendRuntimeMessageQuiet({
    type: 'AUDIO_TIMELINE_SYNC',
    currentTime,
    playbackRate,
    paused: !!video.paused,
    sentAtMs: Date.now()
  });
}

function start(options) {
  running = true;
  hideCaptions = options.hideCaptions !== false;
  autoEnableCaptions = options.autoEnableCaptions !== false;
  history = [];
  lastText = '';
  enabledByUs = false;
  applyHiddenCaptionStyle();
  ensureCaptionsEnabled();
  syncAudioTimeline();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (!running) return;
    syncAudioTimeline();
    ensureCaptionsEnabled();
    sampleCaption();
  }, 250);
}

function stop() {
  running = false;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  document.getElementById('anki-dictation-hide-captions')?.remove();
  if (enabledByUs) {
    const button = document.querySelector('.ytp-subtitles-button');
    if (button?.getAttribute('aria-pressed') === 'true') {
      try { button.click(); } catch {}
    }
  }
  enabledByUs = false;
  destroyTranscriptPanel();
}

function applyHiddenCaptionStyle() {
  document.getElementById('anki-dictation-hide-captions')?.remove();
  if (!hideCaptions) return;
  const style = document.createElement('style');
  style.id = 'anki-dictation-hide-captions';
  style.textContent = `
    .ytp-caption-window-container,
    .caption-window,
    #ytp-caption-window-container {
      opacity: 0 !important;
      pointer-events: none !important;
    }
  `;
  document.documentElement.appendChild(style);
}

function ensureCaptionsEnabled() {
  if (!autoEnableCaptions) return;
  const button = document.querySelector('.ytp-subtitles-button');
  if (!button || button.disabled) return;
  const pressed = button.getAttribute('aria-pressed');
  if (pressed === 'false') {
    try {
      button.click();
      enabledByUs = true;
    } catch {}
  }
}

function sampleCaption() {
  const video = document.querySelector('video');
  if (!video) return;
  const segments = [...document.querySelectorAll('.ytp-caption-segment')]
    .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const text = normalizeText(segments.join(' '));
  if (!text) return;

  const now = Number(video.currentTime || 0);
  const last = history[history.length - 1];

  // YouTubeの自動字幕は、同じ字幕ウィンドウを1語ずつ書き換える。
  // 完成途中のスナップショットを別発言として扱わないよう、近い字幕は同じ項目にまとめる。
  if (last && text === last.text) {
    last.end = now;
  } else if (last && now - last.end < 2.5 && isSameRollingCaption(last.text, text)) {
    const merged = mergeRollingText(last.text, text);
    last.text = merged;
    last.end = now;
    last.versions ||= [];
    const prevVersion = last.versions[last.versions.length - 1];
    if (!prevVersion || prevVersion.text !== merged) last.versions.push({ time: now, text: merged });
  } else {
    history.push({ text, start: now, end: now, versions: [{ time: now, text }] });
  }

  lastText = text;
  if (history.length > 120) history = history.slice(-120);
  const floor = now - 90;
  history = history.filter(item => item.end >= floor || item.start > now + 2);
}

function getCaptureContext(lookbackSeconds, minSentenceWords = 3, captionTimingAdjustment = 0) {
  sampleCaption();
  const video = document.querySelector('video');
  const now = Number(video?.currentTime || 0);
  const adjustment = Math.max(0, Math.min(10, Number(captionTimingAdjustment) || 0));
  // +2.5なら「ボタンを押した時刻より2.5秒前」を字幕選択の基準にする。
  const targetTime = Math.max(0, now - adjustment);
  const historyAtTarget = buildHistoryViewAt(targetTime);
  const picked = historyAtTarget.filter(item => item.end >= targetTime - lookbackSeconds && item.start <= targetTime + 0.25);

  let recentText = '';
  for (const item of picked) recentText = mergeRollingText(recentText, item.text);
  if (!recentText) {
    // 補正中に現在の字幕を使うと、せっかく過去へずらしても「先の字幕」が再混入する。
    // 補正なしの時だけ現在のDOM字幕を最後の保険として使う。
    if (adjustment === 0) {
      recentText = lastText || normalizeText(
        [...document.querySelectorAll('.ytp-caption-segment')].map(x => x.textContent || '').join(' ')
      );
    }
  }

  const selection = pickSentenceForWindow(targetTime, lookbackSeconds, recentText, minSentenceWords, historyAtTarget);
  const text = selection?.text || recentText;
  const fallbackStart = Math.max(0, targetTime - Number(lookbackSeconds || 6));
  const sentenceStart = Number.isFinite(selection?.start) ? selection.start : fallbackStart;
  const sentenceEnd = Number.isFinite(selection?.end) ? selection.end : targetTime;

  const url = new URL(location.href);
  url.searchParams.set('t', `${Math.max(0, Math.floor(now))}s`);
  return {
    ok: true,
    currentTime: now,
    targetTime,
    captionTimingAdjustment: adjustment,
    playbackRate: Number(video?.playbackRate || 1),
    paused: !!video?.paused,
    title: document.title.replace(/\s*-\s*YouTube\s*$/, ''),
    url: url.toString(),
    text,
    sentenceStart,
    sentenceEnd,
    timingSource: selection?.timingSource || 'caption-window',
    captionSource: text ? 'live-dom-sentence' : 'none'
  };
}

// YouTubeの自動字幕は同じ字幕窓を後から書き換えるため、
// 現在の最終テキストだけを見ると「ボタンを押した時点より先」の単語が混ざることがある。
// versions から指定時刻時点の字幕スナップショットを復元する。
function buildHistoryViewAt(targetTime) {
  const out = [];
  for (const item of history) {
    if (item.start > targetTime + 0.25) continue;
    const versions = Array.isArray(item.versions) && item.versions.length
      ? item.versions
      : [{ time: item.start, text: item.text }];
    let chosen = null;
    for (const version of versions) {
      if (Number(version.time) <= targetTime + 0.05) chosen = version;
      else break;
    }
    if (!chosen) continue;
    out.push({
      text: chosen.text,
      start: item.start,
      end: Math.min(Number(item.end) || targetTime, targetTime),
      // targetTimeより後の更新は除外しつつ、文頭・文末の出現時刻推定に使う。
      versions: versions
        .filter(v => Number(v.time) <= targetTime + 0.05)
        .map(v => ({ time: Number(v.time), text: v.text }))
    });
  }
  return out;
}

function pickSentenceForWindow(now, lookbackSeconds, recentText, minSentenceWords = 3, sourceHistory = history) {
  const extendedSeconds = Math.max(30, Number(lookbackSeconds || 6) + 20);
  const extendedItems = sourceHistory.filter(item => item.end >= now - extendedSeconds && item.start <= now + 0.25);
  let extendedText = '';
  for (const item of extendedItems) extendedText = mergeRollingText(extendedText, item.text);
  extendedText = normalizeText(extendedText);
  recentText = normalizeText(recentText);
  if (!extendedText) {
    return {
      text: recentText,
      start: Math.max(0, now - Number(lookbackSeconds || 6)),
      end: now,
      timingSource: 'lookback-fallback'
    };
  }

  const minWords = Math.max(1, Math.min(20, Number(minSentenceWords) || 3));
  const complete = extractCompleteSentences(extendedText)
    .filter(sentence => countContentWords(sentence) >= minWords);
  if (complete.length) {
    // 「押した時点の直前の完成文」を優先。短すぎる Yes. / Oh. 等は除外済み。
    const text = complete[complete.length - 1];
    const timing = estimateSentenceTiming(text, extendedItems, now, lookbackSeconds);
    return { text, ...timing, timingSource: 'caption-history-estimate' };
  }

  // 自動字幕に句読点がまだ付いていない場合は、字幕の休止区間まで遡る。
  const recentStart = now - Number(lookbackSeconds || 6);
  let first = extendedItems.findIndex(item => item.end >= recentStart);
  if (first < 0) first = Math.max(0, extendedItems.length - 1);
  let start = first;
  while (start > 0) {
    const cur = extendedItems[start];
    const prev = extendedItems[start - 1];
    const gap = cur.start - prev.end;
    if (gap >= 1.2 || now - prev.start > 18) break;
    start--;
  }
  let utterance = '';
  for (const item of extendedItems.slice(start)) utterance = mergeRollingText(utterance, item.text);
  utterance = normalizeText(utterance);

  // 句読点が付いていないライブ字幕でも、1〜2語だけのカードにはしない。
  let widenedStart = start;
  while (countContentWords(utterance) < minWords && widenedStart > 0) {
    widenedStart--;
    utterance = '';
    for (const item of extendedItems.slice(widenedStart)) utterance = mergeRollingText(utterance, item.text);
    utterance = normalizeText(utterance);
  }

  const chosenItems = extendedItems.slice(widenedStart);
  return {
    text: utterance || recentText,
    start: chosenItems[0]?.start ?? Math.max(0, now - Number(lookbackSeconds || 6)),
    end: chosenItems[chosenItems.length - 1]?.end ?? now,
    timingSource: 'caption-pause-estimate'
  };
}


function getCaptureCandidates(lookbackSeconds, minSentenceWords = 3, captionTimingAdjustment = 0) {
  sampleCaption();
  const video = document.querySelector('video');
  const now = Number(video?.currentTime || 0);
  const adjustment = Math.max(0, Math.min(10, Number(captionTimingAdjustment) || 0));
  const targetTime = Math.max(0, now - adjustment);
  const historyAtTarget = buildHistoryViewAt(targetTime);
  const extendedSeconds = Math.max(32, Number(lookbackSeconds || 6) + 24);
  const items = historyAtTarget.filter(item => item.end >= targetTime - extendedSeconds && item.start <= targetTime + 0.35);
  const minWords = Math.max(1, Math.min(20, Number(minSentenceWords) || 3));

  let transcript = '';
  for (const item of items) transcript = mergeRollingText(transcript, item.text);
  transcript = normalizeText(transcript);

  const rawCandidates = [];
  const addCandidate = (text, start, end, source, extraScore = 0) => {
    text = normalizeText(text);
    if (!text || countContentWords(text) < minWords) return;
    const timing = (Number.isFinite(start) && Number.isFinite(end))
      ? { start: Math.max(0, Number(start)), end: Math.max(Number(start), Number(end)) }
      : estimateSentenceTiming(text, items, targetTime, lookbackSeconds);
    const score = scoreCandidate(text, timing.start, timing.end, targetTime, extraScore);
    rawCandidates.push({
      text,
      sentenceStart: timing.start,
      sentenceEnd: timing.end,
      timingSource: source,
      score
    });
  };

  // 1) 句読点を使った文候補。
  for (const sentence of extractCompleteSentences(transcript)) {
    const timing = estimateSentenceTiming(sentence, items, targetTime, lookbackSeconds);
    // 押下時点の少し先までに終了している／押下時点を跨いでいる文だけ候補にする。
    if (timing.start <= targetTime + 1.0 && timing.end >= targetTime - 10) {
      addCandidate(sentence, timing.start, timing.end, 'punctuation', 10);
    }
  }

  // 2) 字幕更新間の休止を使った発話候補。
  const groups = [];
  let group = [];
  for (const item of items) {
    if (group.length) {
      const prev = group[group.length - 1];
      const gap = Number(item.start) - Number(prev.end);
      if (gap >= 1.05 || Number(item.start) - Number(group[0].start) > 16) {
        groups.push(group);
        group = [];
      }
    }
    group.push(item);
  }
  if (group.length) groups.push(group);

  for (const g of groups) {
    let text = '';
    for (const item of g) text = mergeRollingText(text, item.text);
    const start = Number(g[0]?.start ?? targetTime - lookbackSeconds);
    const end = Number(g[g.length - 1]?.end ?? targetTime);
    if (start <= targetTime + 0.5 && end >= targetTime - 10) {
      addCandidate(text, start, end, 'pause-group', 4);
    }
  }

  // 3) 既存ロジックの最良推定。候補が割れた時の比較対象として残す。
  const current = getCaptureContext(lookbackSeconds, minWords, adjustment);
  if (current?.text) {
    addCandidate(current.text, current.sentenceStart, current.sentenceEnd, current.timingSource || 'legacy-best', 8);
  }

  // 同一文をまとめ、時刻が近い方／スコアが高い方を残す。
  const byKey = new Map();
  for (const c of rawCandidates) {
    const key = candidateKey(c.text);
    const prev = byKey.get(key);
    if (!prev || c.score > prev.score) byKey.set(key, c);
  }
  let candidates = [...byKey.values()]
    .sort((a, b) => b.score - a.score || Math.abs(targetTime - b.sentenceEnd) - Math.abs(targetTime - a.sentenceEnd));

  // 文の一部だけを含む候補が、より完全な候補とほぼ同点なら完全な方を優先。
  candidates = candidates.filter((c, idx, arr) => {
    return !arr.some((other, j) => {
      if (j === idx || other.score + 8 < c.score) return false;
      const ck = candidateKey(c.text), ok = candidateKey(other.text);
      return ok.includes(ck) && ok !== ck && countContentWords(other.text) <= countContentWords(c.text) + 8;
    });
  });

  // 候補選択が毎回出ないよう、明確に1位なら自動確定。
  if (candidates.length > 1) {
    const best = candidates[0];
    const second = candidates[1];
    if (best.score - second.score >= 22) {
      candidates = [best];
    } else {
      candidates = candidates.filter(c => c.score >= best.score - 18).slice(0, 3);
    }
  } else {
    candidates = candidates.slice(0, 1);
  }

  const url = new URL(location.href);
  url.searchParams.set('t', `${Math.max(0, Math.floor(now))}s`);
  return {
    ok: true,
    currentTime: now,
    targetTime,
    captionTimingAdjustment: adjustment,
    playbackRate: Number(video?.playbackRate || 1),
    paused: !!video?.paused,
    title: document.title.replace(/\s*-\s*YouTube\s*$/, ''),
    url: url.toString(),
    candidates
  };
}

function scoreCandidate(text, start, end, targetTime, extra = 0) {
  const words = countContentWords(text);
  const before = targetTime - end;
  const after = start - targetTime;
  let score = Number(extra) || 0;
  if (start <= targetTime + 0.45 && end >= targetTime - 0.9) score += 100;
  else if (before >= -0.5 && before <= 8) score += Math.max(18, 82 - before * 10);
  else if (after > 0) score += Math.max(0, 20 - after * 12);
  if (/[.!?…]["'”’）)\]]*$/.test(text)) score += 12;
  if (words >= 4 && words <= 18) score += 8;
  else if (words > 26) score -= Math.min(24, words - 26);
  if (/^(um+|uh+|er+|hmm+)[,.!?]?$/i.test(text.trim())) score -= 30;
  return score;
}

function candidateKey(text) {
  return normalizeText(text)
    .toLowerCase()
    .replace(/[“”"'’]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function showCandidatePicker(candidates, baseContext) {
  document.getElementById('anki-dictation-candidate-picker')?.remove();
  if (!Array.isArray(candidates) || !candidates.length) {
    showToast('字幕候補を作れませんでした', true);
    return;
  }
  if (candidates.length === 1) {
    sendRuntimeMessageQuiet({ type: 'CANDIDATE_SELECTED', candidate: candidates[0], baseContext });
    return;
  }

  const visibleCandidates = candidates.slice(0, 8);
  const overlay = document.createElement('div');
  overlay.id = 'anki-dictation-candidate-picker';
  Object.assign(overlay.style, {
    position: 'fixed', inset: '0', zIndex: '2147483647',
    background: 'rgba(0,0,0,.58)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontFamily: 'system-ui, sans-serif'
  });

  const panel = document.createElement('div');
  Object.assign(panel.style, {
    width: 'min(820px, calc(100vw - 40px))', maxHeight: '82vh', overflow: 'auto',
    background: '#111827', color: '#fff', borderRadius: '14px', padding: '18px',
    boxShadow: '0 20px 60px rgba(0,0,0,.55)'
  });

  const title = document.createElement('div');
  title.textContent = '直前の字幕から選択';
  Object.assign(title.style, { fontSize: '18px', fontWeight: '700', marginBottom: '6px' });
  panel.appendChild(title);

  const sub = document.createElement('div');
  const sourceLabel = baseContext?.captionSource === 'youtube-timedtext'
    ? 'YouTubeの字幕トラック全体から、ボタン直前の時間帯にあった字幕を表示しています。'
    : 'YouTube画面上の字幕履歴から候補を表示しています。';
  sub.textContent = `${sourceLabel} 選択後、その字幕のタイムコードに余裕を足して音声を切り出します。`;
  Object.assign(sub.style, { fontSize: '13px', opacity: '.78', marginBottom: '14px', lineHeight: '1.55' });
  panel.appendChild(sub);

  const formatTime = (sec) => {
    if (!Number.isFinite(Number(sec))) return '';
    let total = Math.max(0, Math.floor(Number(sec)));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  };

  const choose = (candidate) => {
    overlay.remove();
    document.removeEventListener('keydown', keyHandler, true);
    sendRuntimeMessageQuiet({ type: 'CANDIDATE_SELECTED', candidate, baseContext });
  };

  visibleCandidates.forEach((candidate, index) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.index = String(index);
    const start = formatTime(candidate.sentenceStart);
    const end = formatTime(candidate.sentenceEnd);
    const timeLabel = start ? `${start}${end && end !== start ? `–${end}` : ''}` : '';

    const top = document.createElement('div');
    top.textContent = `${index + 1}${timeLabel ? `  ${timeLabel}` : ''}`;
    Object.assign(top.style, { fontSize: '12px', opacity: '.62', marginBottom: '4px' });

    const text = document.createElement('div');
    text.textContent = candidate.text;
    Object.assign(text.style, { fontSize: '16px', lineHeight: '1.55' });

    Object.assign(btn.style, {
      display: 'block', width: '100%', textAlign: 'left', border: '1px solid rgba(255,255,255,.18)',
      background: 'rgba(255,255,255,.06)', color: '#fff', padding: '11px 14px', margin: '8px 0',
      borderRadius: '10px', cursor: 'pointer'
    });
    btn.append(top, text);
    btn.addEventListener('mouseenter', () => btn.style.background = 'rgba(255,255,255,.13)');
    btn.addEventListener('mouseleave', () => btn.style.background = 'rgba(255,255,255,.06)');
    btn.addEventListener('click', () => choose(candidate));
    panel.appendChild(btn);
  });

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'キャンセル（Esc）';
  Object.assign(cancel.style, {
    display: 'block', margin: '14px 0 0 auto', border: '0', background: 'transparent',
    color: '#cbd5e1', cursor: 'pointer', fontSize: '13px'
  });
  cancel.addEventListener('click', () => {
    overlay.remove();
    document.removeEventListener('keydown', keyHandler, true);
  });
  panel.appendChild(cancel);
  overlay.appendChild(panel);
  document.documentElement.appendChild(overlay);

  const keyHandler = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      overlay.remove();
      document.removeEventListener('keydown', keyHandler, true);
      return;
    }
    const idx = Number(event.key) - 1;
    if (idx >= 0 && idx < visibleCandidates.length) {
      event.preventDefault();
      choose(visibleCandidates[idx]);
    }
  };
  document.addEventListener('keydown', keyHandler, true);
}

// DOM字幕は単語単位の正確なタイムコードを持たないため、
// 選んだ文と単語列が重なる字幕履歴の最初〜最後を文の時刻として見積もる。
// 音声側ではさらに前後に余白を足すので、多少広めでも切れにくい。
function estimateSentenceTiming(sentence, items, now, lookbackSeconds) {
  const sentenceWords = splitWords(sentence);
  if (!sentenceWords.length) {
    return { start: Math.max(0, now - Number(lookbackSeconds || 6)), end: now };
  }

  // まず字幕の「更新履歴」を使う。YouTubeライブ字幕は同じ表示窓を
  // 1語ずつ書き換えるため、item.start は前の発話まで含んで古すぎることがある。
  // 文頭2〜3語と文末2〜3語が最初に現れた時刻を使う方が実発話に近い。
  const anchorLen = Math.max(1, Math.min(3, sentenceWords.length));
  const startAnchor = sentenceWords.slice(0, anchorLen);
  const endAnchor = sentenceWords.slice(-anchorLen);
  const startHits = [];
  const endHits = [];

  items.forEach((item, itemIndex) => {
    const versions = Array.isArray(item.versions) && item.versions.length
      ? item.versions
      : [{ time: item.start, text: item.text }];
    for (const version of versions) {
      const words = splitWords(version.text);
      const t = Number(version.time);
      if (!Number.isFinite(t)) continue;
      if (containsWordSequence(words, startAnchor)) startHits.push({ time: t, itemIndex });
      if (containsWordSequence(words, endAnchor)) endHits.push({ time: t, itemIndex });
    }
  });

  // 押下時刻に最も近い「文末」を選び、それより前の最も近い「文頭」と組み合わせる。
  // 24秒を超える組み合わせは誤対応の可能性が高いので採用しない。
  const eligibleEnds = endHits
    .filter(x => x.time <= now + 1.5 && x.time >= now - 24)
    .sort((a, b) => Math.abs(now - a.time) - Math.abs(now - b.time));
  for (const e of eligibleEnds) {
    const starts = startHits
      .filter(s => s.time <= e.time + 0.4 && e.time - s.time <= 24)
      .sort((a, b) => b.time - a.time);
    if (starts.length) {
      return {
        start: Math.max(0, starts[0].time),
        end: Math.max(starts[0].time, e.time)
      };
    }
  }

  // 更新履歴だけで決められない場合は、2語程度の一致を全期間でmin/maxするのではなく、
  // 「時間的に連続した一致クラスタ」のうち押下時刻に最も近いものだけを使う。
  const matched = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const itemWords = splitWords(item.text);
    const common = longestCommonBlock(itemWords, sentenceWords);
    const threshold = Math.min(2, Math.max(1, Math.min(itemWords.length, sentenceWords.length)));
    if (common.length >= threshold) {
      matched.push({
        index: i,
        item,
        overlap: common.length,
        start: Number(item.start) || 0,
        end: Number(item.end) || Number(item.start) || 0
      });
    }
  }

  if (matched.length) {
    const clusters = [];
    let cluster = [];
    for (const m of matched) {
      const prev = cluster[cluster.length - 1];
      if (prev && (m.index - prev.index > 1 || m.start - prev.end > 3.0)) {
        clusters.push(cluster);
        cluster = [];
      }
      cluster.push(m);
    }
    if (cluster.length) clusters.push(cluster);

    const scored = clusters.map(g => {
      const start = Math.min(...g.map(x => x.start));
      const end = Math.max(...g.map(x => x.end));
      const overlap = g.reduce((sum, x) => sum + x.overlap, 0);
      const distance = Math.max(0, now - end);
      const durationPenalty = Math.max(0, end - start - 12) * 2;
      return { start, end, score: overlap * 10 - distance * 2 - durationPenalty };
    }).sort((a, b) => b.score - a.score);

    if (scored.length) return { start: Math.max(0, scored[0].start), end: scored[0].end };
  }

  return {
    start: Math.max(0, now - Number(lookbackSeconds || 6)),
    end: now
  };
}

function containsWordSequence(words, sequence) {
  if (!Array.isArray(words) || !Array.isArray(sequence) || !sequence.length || words.length < sequence.length) return false;
  outer: for (let i = 0; i <= words.length - sequence.length; i++) {
    for (let j = 0; j < sequence.length; j++) {
      if (String(words[i]).toLowerCase() !== String(sequence[j]).toLowerCase()) continue outer;
    }
    return true;
  }
  return false;
}

function extractCompleteSentences(text) {
  text = normalizeText(text);
  if (!text) return [];
  const out = [];
  const re = /[^.!?…]+[.!?…]+(?:["'”’）)\]]*)/g;
  let match;
  while ((match = re.exec(text))) {
    const sentence = normalizeText(match[0]);
    if (sentence) out.push(sentence);
  }
  return out;
}

function contentWordKeys(text) {
  return splitWords(text)
    .map(wordKey)
    .filter(w => w && (w.length >= 2 || /^(i|a)$/i.test(w)));
}

function countContentWords(text) {
  return splitWords(text)
    .map(wordKey)
    .filter(Boolean)
    .length;
}

function isSameRollingCaption(a, b) {
  a = normalizeText(a);
  b = normalizeText(b);
  if (!a || !b) return false;
  if (a === b || a.startsWith(b) || b.startsWith(a) || a.includes(b) || b.includes(a)) return true;

  const aw = splitWords(a);
  const bw = splitWords(b);
  const common = longestCommonBlock(aw, bw);
  const shorter = Math.min(aw.length, bw.length);
  return common.length >= 3 && common.length / Math.max(1, shorter) >= 0.45;
}

function mergeRollingText(a, b) {
  a = normalizeText(a);
  b = normalizeText(b);
  if (!a) return b;
  if (!b || a === b) return a;
  if (b.includes(a)) return b;
  if (a.includes(b)) return a;

  const aw = splitWords(a);
  const bw = splitWords(b);
  const common = longestCommonBlock(aw, bw);
  const shorter = Math.min(aw.length, bw.length);

  if (common.length >= 2) {
    // 旧字幕の末尾と新字幕の先頭が重なる: 通常の字幕スクロール。
    if (common.aIndex + common.length === aw.length && common.bIndex === 0) {
      return [...aw, ...bw.slice(common.length)].join(' ');
    }

    // 同じ先頭を持ち、新しい方に単語が追加・修正された: 最新スナップショットを採用。
    if (common.aIndex === 0 && common.bIndex === 0 && common.length / Math.max(1, shorter) >= 0.35) {
      return bw.length >= aw.length ? b : a;
    }

    // 古い字幕の途中から新しい字幕が始まる: 古い先頭だけ残して新しい字幕へ接続。
    if (common.bIndex === 0 && common.length / Math.max(1, shorter) >= 0.35) {
      return [...aw.slice(0, common.aIndex), ...bw].join(' ');
    }

    // 自動字幕の逐次修正（末尾に単語が挿入される等）。大部分が同じなら最新を採用。
    if (common.length >= 3 && common.length / Math.max(1, shorter) >= 0.5) {
      if (common.aIndex === 0) return b;
      return [...aw.slice(0, common.aIndex), ...bw].join(' ');
    }
  }

  // 最後の保険: 厳密な「末尾→先頭」重複を最大24語まで除去。
  const max = Math.min(24, aw.length, bw.length);
  for (let n = max; n >= 1; n--) {
    if (wordKeys(aw.slice(-n)).join(' ') === wordKeys(bw.slice(0, n)).join(' ')) {
      return [...aw, ...bw.slice(n)].join(' ');
    }
  }
  return `${a} ${b}`;
}

function splitWords(text) {
  return normalizeText(text).split(/\s+/).filter(Boolean);
}

function wordKey(token) {
  return String(token || '')
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

function wordKeys(words) {
  return words.map(wordKey);
}

function longestCommonBlock(aWords, bWords) {
  const a = wordKeys(aWords);
  const b = wordKeys(bWords);
  let bestLength = 0;
  let bestA = 0;
  let bestB = 0;
  let prev = new Array(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] && a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > bestLength) {
          bestLength = cur[j];
          bestA = i - cur[j];
          bestB = j - cur[j];
        }
      }
    }
    prev = cur;
  }
  return { aIndex: bestA, bIndex: bestB, length: bestLength };
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\u200b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}


function currentYouTubeVideoId() {
  try {
    if (!/^\/watch\/?$/i.test(location.pathname)) return '';
    return String(new URL(location.href).searchParams.get('v') || '');
  } catch { return ''; }
}

function clearTranscriptForVideoChange(message = '動画が切り替わりました。字幕を再取得中…') {
  // v8.8: YouTube SPA遷移中は前動画の字幕を一瞬でも操作可能な状態で残さない。
  history = [];
  lastText = '';
  if (!transcriptPanelState.root) return;
  transcriptPanelState.loading = true;
  transcriptPanelState.cues = [];
  transcriptPanelState.currentTranscript = null;
  transcriptPanelState.videoId = '';
  transcriptPanelState.isLive = false;
  transcriptPanelState.selected = new Set();
  transcriptPanelState.anchorIndex = -1;
  transcriptPanelState.wordStartIndex = null;
  transcriptPanelState.wordEndIndex = null;
  transcriptPanelState.wordMap.clear();
  transcriptPanelState.wordMetaMap.clear();
  transcriptPanelState.currentIndex = -1;
  transcriptPanelState.rowMap.clear();
  const status = transcriptPanelState.root.querySelector('[data-ytanki="status"]');
  if (status) status.textContent = message;
  if (transcriptPanelState.list) {
    transcriptPanelState.list.innerHTML = `<div style="padding:22px 12px;color:#aaa;line-height:1.6">${message}</div>`;
  }
  if (transcriptPanelState.trackSelect) transcriptPanelState.trackSelect.disabled = true;
  const copyAll = transcriptPanelState.root.querySelector('[data-ytanki="copy-all"]');
  if (copyAll) {
    copyAll.disabled = true;
    copyAll.style.opacity = '.55';
  }
  updateTranscriptFooter();
}

function scheduleTranscriptRefreshAfterNavigation(delayMs = 350) {
  if (!transcriptPanelState.root) return;
  if (transcriptPanelState.navigationRefreshTimer) clearTimeout(transcriptPanelState.navigationRefreshTimer);
  transcriptPanelState.navigationRefreshTimer = setTimeout(() => {
    transcriptPanelState.navigationRefreshTimer = null;
    requestTranscriptRefresh(true, false).catch(() => {});
  }, Math.max(0, Number(delayMs) || 0));
}

function guardTranscriptAgainstCurrentVideo() {
  if (!transcriptPanelState.root) return true;
  const pageVideoId = currentYouTubeVideoId();
  const transcriptVideoId = String(transcriptPanelState.videoId || '');
  if (pageVideoId && transcriptVideoId && pageVideoId !== transcriptVideoId) {
    clearTranscriptForVideoChange();
    scheduleTranscriptRefreshAfterNavigation(250);
    return false;
  }
  return true;
}

function transcriptIsCurrentForAction() {
  const pageVideoId = currentYouTubeVideoId();
  const transcriptVideoId = String(transcriptPanelState.videoId || '');
  if (pageVideoId && transcriptVideoId && pageVideoId !== transcriptVideoId) {
    clearTranscriptForVideoChange();
    scheduleTranscriptRefreshAfterNavigation(150);
    showToast('動画が切り替わったため、現在の動画の字幕を再取得します', true);
    return false;
  }
  return !!transcriptPanelState.cues.length;
}

function setTranscriptPanelLoading(loading, preserveSelection = true) {
  transcriptPanelState.loading = !!loading;
  if (!transcriptPanelState.root) createTranscriptPanelShell();
  const status = transcriptPanelState.root?.querySelector('[data-ytanki="status"]');
  if (status) status.textContent = loading ? '字幕を読み込み中…' : '';
  if (transcriptPanelState.trackSelect) transcriptPanelState.trackSelect.disabled = !!loading;
  const copyAll = transcriptPanelState.root?.querySelector('[data-ytanki="copy-all"]');
  if (copyAll) {
    copyAll.disabled = !!loading || !transcriptPanelState.cues.length;
    copyAll.style.opacity = copyAll.disabled ? '.55' : '1';
  }
  if (!preserveSelection) clearTranscriptSelection();
}

function createTranscriptPanelShell() {
  // YouTube本体のCSSやクリック処理から字幕パネルを分離する。
  // Shadow DOM内に置くことで、YouTube側のbutton/cursor/user-select指定が入り込まない。
  transcriptPanelState.host?.remove();
  transcriptPanelState.root?.remove();

  const host = document.createElement('div');
  host.id = 'yt-anki-transcript-host';
  host.style.setProperty('all', 'initial', 'important');
  host.style.setProperty('position', 'fixed', 'important');
  host.style.setProperty('inset', '0', 'important');
  host.style.setProperty('z-index', '2147483647', 'important');
  host.style.setProperty('pointer-events', 'none', 'important');

  const shadow = host.attachShadow({ mode: 'open' });
  const isolateStyle = document.createElement('style');
  isolateStyle.textContent = `
    :host { all: initial !important; }
    *, *::before, *::after { box-sizing: border-box; }
    button, input { font: inherit; }
    button { appearance: auto; -webkit-appearance: auto; }
    [data-ytanki="save"], [data-ytanki="save"] * {
      cursor: pointer !important;
      user-select: none !important;
      -webkit-user-select: none !important;
    }
    [data-ytanki="word"] {
      cursor: pointer !important;
      border-radius: 4px;
      padding: 1px 2px;
      margin: 0 -1px;
      transition: background .08s, color .08s, box-shadow .08s;
      user-select: none !important;
      -webkit-user-select: none !important;
    }
    [data-ytanki="word"]:hover { background: #3a3a3a; }
    [data-ytanki="word"].ytanki-word-anchor {
      background: #b45309 !important;
      color: #fff !important;
      box-shadow: inset 0 0 0 1px #f59e0b;
    }
    [data-ytanki="word"].ytanki-word-range {
      background: #2563eb !important;
      color: #fff !important;
    }
  `;

  const root = document.createElement('aside');
  root.id = 'yt-anki-transcript-panel';
  Object.assign(root.style, {
    position: 'absolute', top: '64px', right: '12px', width: '430px',
    height: 'calc(100vh - 78px)', zIndex: '1', background: '#101010',
    color: '#f5f5f5', border: '1px solid rgba(255,255,255,.15)', borderRadius: '12px',
    boxShadow: '0 18px 60px rgba(0,0,0,.45)', display: 'flex', flexDirection: 'column',
    overflow: 'hidden', fontFamily: 'Arial, system-ui, sans-serif', pointerEvents: 'auto'
  });

  const header = document.createElement('div');
  Object.assign(header.style, {
    padding: '11px 12px', borderBottom: '1px solid rgba(255,255,255,.12)',
    display: 'flex', alignItems: 'center', gap: '8px', background: '#181818', flex: '0 0 auto'
  });

  const titleWrap = document.createElement('div');
  titleWrap.style.minWidth = '0';
  titleWrap.style.flex = '1';
  const title = document.createElement('div');
  title.textContent = 'YouTube 字幕 → Anki';
  Object.assign(title.style, { fontSize: '15px', fontWeight: '700', lineHeight: '1.25' });
  const status = document.createElement('div');
  status.dataset.ytanki = 'status';
  Object.assign(status.style, {
    fontSize: '11px', color: '#aaa', marginTop: '2px', whiteSpace: 'nowrap',
    overflow: 'hidden', textOverflow: 'ellipsis'
  });
  const trackRow = document.createElement('div');
  Object.assign(trackRow.style, { display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px', minWidth: '0' });
  const trackLabel = document.createElement('span');
  trackLabel.textContent = '取得字幕';
  Object.assign(trackLabel.style, { fontSize: '10px', color: '#aaa', flex: '0 0 auto' });
  const trackSelect = document.createElement('select');
  trackSelect.dataset.ytanki = 'track-select';
  Object.assign(trackSelect.style, {
    height: '27px', minWidth: '0', width: '190px', maxWidth: '100%',
    border: '1px solid rgba(255,255,255,.15)', borderRadius: '6px',
    background: '#252525', color: '#f5f5f5', padding: '0 24px 0 7px',
    fontSize: '11px', cursor: 'pointer'
  });
  trackSelect.title = 'YouTube画面に表示する字幕とは別に、この拡張機能で取得する字幕を選択します';
  trackSelect.addEventListener('change', () => {
    transcriptPanelState.preferredTrackId = String(trackSelect.value || '');
    clearTranscriptSelection();
    requestTranscriptRefresh(true, false);
  });

  trackRow.append(trackLabel, trackSelect);
  titleWrap.append(title, status, trackRow);

  const follow = document.createElement('button');
  follow.type = 'button';
  follow.dataset.ytanki = 'follow';
  follow.textContent = '追従 ON';
  stylePanelButton(follow);
  follow.style.background = '#263b2c';
  follow.addEventListener('click', () => {
    transcriptPanelState.follow = !transcriptPanelState.follow;
    follow.textContent = transcriptPanelState.follow ? '追従 ON' : '追従 OFF';
    follow.style.background = transcriptPanelState.follow ? '#263b2c' : '#2a2a2a';
    if (transcriptPanelState.follow) focusCurrentTranscriptCue(true);
  });

  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.textContent = '↻';
  refresh.title = '字幕を更新';
  stylePanelButton(refresh);
  refresh.style.fontSize = '18px';
  refresh.addEventListener('click', () => requestTranscriptRefresh(true));

  const collapse = document.createElement('button');
  collapse.type = 'button';
  collapse.textContent = '−';
  collapse.title = '折りたたむ';
  stylePanelButton(collapse);
  collapse.style.fontSize = '18px';

  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.title = '閉じる';
  stylePanelButton(close);
  close.style.fontSize = '18px';
  close.addEventListener('click', destroyTranscriptPanel);

  header.append(titleWrap, follow, refresh, collapse, close);

  const list = document.createElement('div');
  list.dataset.ytanki = 'list';
  Object.assign(list.style, {
    flex: '1 1 auto', overflowY: 'auto', overscrollBehavior: 'contain',
    padding: '8px 8px 110px 8px', scrollbarWidth: 'thin'
  });
  list.addEventListener('wheel', (event) => {
    // 字幕リストをスクロールしてもYouTube本体へホイールイベントを伝播させない。
    event.stopPropagation();
    transcriptPanelState.manualScrollUntil = Date.now() + 5000;
  }, { passive: true });
  list.addEventListener('pointerdown', () => transcriptPanelState.manualScrollUntil = Date.now() + 5000, { passive: true });

  const footer = document.createElement('div');
  footer.dataset.ytanki = 'footer';
  Object.assign(footer.style, {
    position: 'absolute', left: '0', right: '0', bottom: '0', padding: '10px 12px 12px',
    borderTop: '1px solid rgba(255,255,255,.12)', background: 'rgba(20,20,20,.97)',
    backdropFilter: 'blur(8px)', zIndex: '10', pointerEvents: 'auto'
  });

  const selectedInfo = document.createElement('div');
  selectedInfo.dataset.ytanki = 'selected-info';
  Object.assign(selectedInfo.style, { fontSize: '12px', color: '#bbb', marginBottom: '7px' });
  selectedInfo.textContent = '開始単語をクリック → 終了単語をクリック';

  const actions = document.createElement('div');
  Object.assign(actions.style, { display: 'flex', gap: '8px' });
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.textContent = '選択解除';
  styleFooterButton(clear, false);
  clear.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    clearTranscriptSelection();
  });

  const copyAll = document.createElement('button');
  copyAll.type = 'button';
  copyAll.dataset.ytanki = 'copy-all';
  copyAll.textContent = '全字幕コピー';
  copyAll.title = '現在取得している字幕トラックの全文を、タイムコードなしでコピー';
  styleFooterButton(copyAll, false);
  copyAll.style.whiteSpace = 'nowrap';
  copyAll.disabled = true;
  copyAll.style.opacity = '.55';
  copyAll.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    await copyAllTranscriptToClipboard(copyAll);
  });

  const correct = document.createElement('button');
  correct.type = 'button';
  correct.dataset.ytanki = 'correct';
  correct.textContent = '字幕修正';
  correct.title = '選択範囲を手動修正し、ユーザー辞書へ登録';
  styleFooterButton(correct, false);
  correct.style.setProperty('cursor', 'pointer', 'important');
  correct.setAttribute('aria-disabled', 'true');
  correct.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    await correctSelectedTranscriptRange();
  }, true);

  // Shadow DOM内のネイティブbuttonを使う。YouTube側のCSSとイベント干渉を受けにくく、
  // カーソルも必ずポインターになる。disabled属性は使わず、チェック状態は押下時に再取得する。
  const save = document.createElement('button');
  save.type = 'button';
  save.dataset.ytanki = 'save';
  save.textContent = '選択範囲をAnkiへ';
  styleFooterButton(save, true);
  Object.assign(save.style, {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    position: 'relative', zIndex: '20', pointerEvents: 'auto',
    userSelect: 'none', WebkitUserSelect: 'none', touchAction: 'manipulation'
  });
  save.style.setProperty('cursor', 'pointer', 'important');
  save.setAttribute('aria-disabled', 'true');

  const triggerSave = async (event) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    if (save.dataset.busy === '1') return;
    await saveTranscriptSelectionFromPanel();
  };
  save.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    save.style.transform = 'translateY(1px)';
  }, true);
  save.addEventListener('pointerup', (event) => {
    event.preventDefault();
    event.stopPropagation();
    save.style.transform = '';
  }, true);
  save.addEventListener('pointercancel', () => { save.style.transform = ''; }, true);
  save.addEventListener('click', triggerSave, true);
  save.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') triggerSave(event);
  });

  actions.append(clear, copyAll, correct, save);
  footer.append(selectedInfo, actions);

  collapse.addEventListener('click', () => {
    const collapsed = root.dataset.collapsed === '1';
    if (collapsed) {
      root.dataset.collapsed = '0';
      root.style.height = 'calc(100vh - 78px)';
      list.style.display = 'block';
      footer.style.display = 'block';
      collapse.textContent = '−';
    } else {
      root.dataset.collapsed = '1';
      root.style.height = '48px';
      list.style.display = 'none';
      footer.style.display = 'none';
      collapse.textContent = '+';
    }
  });

  root.append(header, list, footer);
  shadow.append(isolateStyle, root);
  document.documentElement.appendChild(host);
  transcriptPanelState.host = host;
  transcriptPanelState.shadow = shadow;
  transcriptPanelState.root = root;
  transcriptPanelState.list = list;
  transcriptPanelState.trackSelect = trackSelect;
  transcriptPanelState.trackRow = trackRow;

  if (transcriptPanelState.updateTimer) clearInterval(transcriptPanelState.updateTimer);
  transcriptPanelState.updateTimer = setInterval(() => updateCurrentTranscriptCue(), 350);
}
function getAllTranscriptPlainText() {
  return transcriptPanelState.cues
    .map(cue => normalizeText(cue?.text || joinSelectedTranscriptWords(Array.isArray(cue?.words) ? cue.words : [])))
    .filter(Boolean)
    .join('\n');
}

async function writeTextToClipboard(text) {
  const value = String(text || '');
  if (!value) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {}

  // Clipboard APIがページ側の権限等で使えない場合のフォールバック。
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  Object.assign(textarea.style, {
    position: 'fixed', left: '-10000px', top: '0', width: '1px', height: '1px',
    opacity: '0', pointerEvents: 'none'
  });
  document.documentElement.appendChild(textarea);
  textarea.focus();
  textarea.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  textarea.remove();
  return ok;
}

async function copyAllTranscriptToClipboard(button) {
  const text = getAllTranscriptPlainText();
  if (!text) {
    showToast('コピーできる字幕がありません', true);
    return;
  }
  const original = button?.textContent || '全字幕コピー';
  if (button) {
    button.disabled = true;
    button.style.opacity = '.65';
    button.textContent = 'コピー中…';
  }
  try {
    const ok = await writeTextToClipboard(text);
    if (!ok) throw new Error('クリップボードへ書き込めませんでした');
    const lineCount = text.split('\n').filter(Boolean).length;
    showToast(`全字幕をコピーしました（${lineCount}行）`, false);
    if (button) button.textContent = 'コピー済み';
  } catch (err) {
    showToast(`字幕コピー失敗: ${err?.message || err}`, true);
    if (button) button.textContent = '失敗';
  } finally {
    setTimeout(() => {
      if (!button?.isConnected) return;
      button.textContent = original;
      button.disabled = transcriptPanelState.loading || !transcriptPanelState.cues.length;
      button.style.opacity = button.disabled ? '.55' : '1';
    }, 1200);
  }
}

function stylePanelButton(button) {
  Object.assign(button.style, {
    border: '1px solid rgba(255,255,255,.12)', background: '#2a2a2a', color: '#eee',
    borderRadius: '7px', height: '30px', minWidth: '30px', padding: '0 8px',
    cursor: 'pointer', fontSize: '11px'
  });
}

function styleFooterButton(button, primary) {
  Object.assign(button.style, {
    flex: primary ? '1' : '0 0 auto', height: '38px', padding: '0 13px', borderRadius: '8px',
    border: primary ? '0' : '1px solid rgba(255,255,255,.15)',
    background: primary ? '#2563eb' : '#2a2a2a', color: '#fff', cursor: 'pointer',
    fontWeight: primary ? '700' : '500', boxSizing: 'border-box', pointerEvents: 'auto'
  });
}

function showTranscriptPanel(transcript, options = {}) {
  const incomingVideoId = String(transcript?.videoId || '');
  const pageVideoId = currentYouTubeVideoId();
  if (incomingVideoId && pageVideoId && incomingVideoId !== pageVideoId) {
    // 遅れて到着した前動画の取得結果は描画しない。
    clearTranscriptForVideoChange();
    scheduleTranscriptRefreshAfterNavigation(150);
    return;
  }
  if (!transcriptPanelState.root) createTranscriptPanelShell();
  transcriptPanelState.loading = false;

  const oldStartWord = options.preserveSelection && transcriptPanelState.wordStartIndex !== null
    ? transcriptPanelState.wordMetaMap.get(transcriptPanelState.wordStartIndex)
    : null;
  const oldEndWord = options.preserveSelection && transcriptPanelState.wordEndIndex !== null
    ? transcriptPanelState.wordMetaMap.get(transcriptPanelState.wordEndIndex)
    : null;
  const oldStartKey = oldStartWord ? transcriptWordKey(oldStartWord) : '';
  const oldEndKey = oldEndWord ? transcriptWordKey(oldEndWord) : '';

  transcriptPanelState.currentTranscript = transcript && typeof transcript === 'object' ? structuredClone(transcript) : null;
  transcriptPanelState.cues = Array.isArray(transcript?.cues) ? transcript.cues : [];
  transcriptPanelState.videoId = incomingVideoId;
  transcriptPanelState.isLive = !!transcript?.isLive;
  transcriptPanelState.selected = new Set();
  transcriptPanelState.anchorIndex = -1;
  transcriptPanelState.wordStartIndex = null;
  transcriptPanelState.wordEndIndex = null;
  transcriptPanelState.wordMap.clear();
  transcriptPanelState.wordMetaMap.clear();
  transcriptPanelState.currentIndex = -1;
  transcriptPanelState.rowMap.clear();

  const status = transcriptPanelState.root.querySelector('[data-ytanki="status"]');
  const copyAll = transcriptPanelState.root.querySelector('[data-ytanki="copy-all"]');
  if (copyAll) {
    copyAll.disabled = !transcriptPanelState.cues.length;
    copyAll.style.opacity = copyAll.disabled ? '.55' : '1';
  }

  // YouTube本体の表示字幕と、拡張機能が取得する字幕は独立。
  if (transcriptPanelState.trackSelect) {
    const tracks = Array.isArray(transcript?.availableTracks) ? transcript.availableTracks : [];
    const selectedId = String(transcript?.selectedTrackId || transcriptPanelState.preferredTrackId || '');
    transcriptPanelState.trackSelect.innerHTML = '';
    for (const t of tracks) {
      const opt = document.createElement('option');
      opt.value = String(t.trackId || '');
      const auto = t.isAutoGenerated || String(t.kind || '') === 'asr';
      opt.textContent = `${String(t.label || t.languageCode || '字幕')}${auto ? ' [自動生成]' : ''}`;
      transcriptPanelState.trackSelect.appendChild(opt);
    }
    if (selectedId && [...transcriptPanelState.trackSelect.options].some(o => o.value === selectedId)) {
      transcriptPanelState.trackSelect.value = selectedId;
    }
    transcriptPanelState.preferredTrackId = String(transcriptPanelState.trackSelect.value || selectedId || '');
    transcriptPanelState.trackSelect.disabled = tracks.length < 2;
    if (transcriptPanelState.trackRow) transcriptPanelState.trackRow.style.display = tracks.length ? 'flex' : 'none';
  }

  if (!transcript?.ok || !transcriptPanelState.cues.length) {
    if (status) status.textContent = transcript?.reason === 'no-caption-track'
      ? '字幕トラックがありません' : '字幕を取得できませんでした';
    transcriptPanelState.list.innerHTML = '<div style="padding:22px 12px;color:#aaa;line-height:1.6">取得可能な字幕がありません。YouTube側で字幕が提供されている動画で試してください。</div>';
    updateTranscriptFooter();
    return;
  }

  const allWords = transcriptPanelState.cues.flatMap(c => Array.isArray(c.words) ? c.words : []);
  const directWords = allWords.filter(w => w.timingSource === 'youtube-segment').length;
  if (status) {
    const live = transcriptPanelState.isLive ? '・LIVE' : '';
    const lang = transcript?.trackName || transcript?.trackLanguage || '字幕';
    const refined = Number(transcript?.correctionCount || 0) > 0 ? `・補正${Number(transcript.correctionCount)}件` : '';
    const ai = '';
    const precision = allWords.length
      ? `・${allWords.length}語（直接時刻${Math.round(directWords / allWords.length * 100)}%）`
      : '';
    status.textContent = `${lang}・${transcriptPanelState.cues.length}行${precision}${refined}${ai}${live}`;
  }

  transcriptPanelState.list.innerHTML = '';
  const fragment = document.createDocumentFragment();
  transcriptPanelState.cues.forEach((cue, index) => {
    const row = createTranscriptRow(cue, index);
    transcriptPanelState.rowMap.set(index, row);
    fragment.appendChild(row);
  });
  transcriptPanelState.list.appendChild(fragment);

  if (oldStartKey) transcriptPanelState.wordStartIndex = findTranscriptWordIndexByKey(oldStartKey);
  if (oldEndKey) transcriptPanelState.wordEndIndex = findTranscriptWordIndexByKey(oldEndKey);
  if (transcriptPanelState.wordStartIndex === null) transcriptPanelState.wordEndIndex = null;
  if (transcriptPanelState.wordEndIndex !== null && transcriptPanelState.wordStartIndex !== null
      && transcriptPanelState.wordEndIndex < transcriptPanelState.wordStartIndex) {
    [transcriptPanelState.wordStartIndex, transcriptPanelState.wordEndIndex] =
      [transcriptPanelState.wordEndIndex, transcriptPanelState.wordStartIndex];
  }

  refreshTranscriptWordStyles();
  updateTranscriptFooter();

  if (options.focusCurrent !== false) setTimeout(() => focusCurrentTranscriptCue(true), 60);
  scheduleLiveTranscriptRefresh();
}

function createTranscriptRow(cue, index) {
  const row = document.createElement('div');
  row.dataset.index = String(index);
  Object.assign(row.style, {
    display: 'grid', gridTemplateColumns: '66px 1fr 42px', gap: '8px', alignItems: 'start',
    padding: '9px 9px', margin: '0 0 4px', borderRadius: '7px',
    border: '1px solid transparent', background: '#202020', cursor: 'default',
    transition: 'background .12s, border-color .12s'
  });

  const time = document.createElement('button');
  time.type = 'button';
  time.textContent = formatPanelTimePrecise(cue.start);
  time.title = 'この位置から再生';
  Object.assign(time.style, {
    border: '0', background: 'transparent', color: '#9bbcff', padding: '2px 0', cursor: 'pointer',
    textAlign: 'left', fontSize: '10px', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap'
  });
  time.addEventListener('click', (event) => {
    event.stopPropagation();
    seekVideoToCue(cue);
  });

  const text = document.createElement('div');
  Object.assign(text.style, {
    fontSize: '14px', lineHeight: '1.62', wordBreak: 'break-word', userSelect: 'none', WebkitUserSelect: 'none'
  });

  const words = Array.isArray(cue.words) && cue.words.length
    ? cue.words
    : [{ globalIndex: index * 10000, text: cue.text, start: cue.start, end: cue.end, timingSource: 'sentence-interpolated' }];
  words.forEach((word, wi) => {
    const span = document.createElement('span');
    const globalIndex = Number(word.globalIndex);
    span.dataset.ytanki = 'word';
    span.dataset.wordIndex = String(globalIndex);
    span.textContent = word.text;
    span.title = `${formatPanelTimePrecise(word.start)}〜${formatPanelTimePrecise(word.end)}・${timingSourceLabel(word.timingSource)}${word.correctionNote ? `\n補正: ${word.correctionNote}` : ''}`;
    span.tabIndex = 0;
    span.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      handleTranscriptWordClick(globalIndex);
    });
    span.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.stopPropagation();
        handleTranscriptWordClick(globalIndex);
      }
    });
    transcriptPanelState.wordMap.set(globalIndex, span);
    transcriptPanelState.wordMetaMap.set(globalIndex, { ...word, globalIndex, cueIndex: index });
    text.appendChild(span);
    if (wi < words.length - 1) text.appendChild(document.createTextNode(' '));
  });

  const oneClick = document.createElement('button');
  oneClick.type = 'button';
  oneClick.textContent = 'Anki';
  oneClick.title = 'この行全体をAnkiへ';
  Object.assign(oneClick.style, {
    border: '1px solid rgba(255,255,255,.14)', background: '#292929', color: '#ddd',
    borderRadius: '6px', height: '27px', padding: '0 6px', cursor: 'pointer', fontSize: '10px'
  });
  oneClick.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const cueWords = (Array.isArray(cue.words) ? cue.words : []).filter(w => Number.isFinite(Number(w.globalIndex)));
    if (cueWords.length) {
      transcriptPanelState.wordStartIndex = Number(cueWords[0].globalIndex);
      transcriptPanelState.wordEndIndex = Number(cueWords[cueWords.length - 1].globalIndex);
      refreshTranscriptWordStyles();
      updateTranscriptFooter();
      await saveTranscriptSelectionFromPanel();
    } else {
      const response = await sendRuntimeMessage({
        type: 'TRANSCRIPT_SELECTION_SAVE',
        cues: [cue],
        transcriptVideoId: String(transcriptPanelState.videoId || '')
      });
      if (!response?.ok) showToast(response?.error || 'Ankiへの保存に失敗しました', true);
    }
  });

  row.append(time, text, oneClick);
  return row;
}

function timingSourceLabel(source) {
  if (source === 'youtube-segment') return 'YouTube単語時刻';
  if (source === 'segment-interpolated') return 'segment内補間';
  if (source === 'cue-interpolated') return '字幕区間内補間';
  if (source === 'sentence-interpolated') return '文章区間内補間';
  return '推定時刻';
}

function transcriptWordKey(word) {
  return `${Math.round(Number(word?.start || 0) * 100)}|${String(word?.text || '').toLowerCase()}`;
}

function findTranscriptWordIndexByKey(key) {
  if (!key) return null;
  for (const [index, word] of transcriptPanelState.wordMetaMap.entries()) {
    if (transcriptWordKey(word) === key) return index;
  }
  return null;
}

function handleTranscriptWordClick(globalIndex) {
  if (!Number.isFinite(globalIndex) || !transcriptPanelState.wordMetaMap.has(globalIndex)) return;
  transcriptPanelState.manualScrollUntil = Date.now() + 5000;

  if (transcriptPanelState.wordStartIndex === null || transcriptPanelState.wordEndIndex !== null) {
    transcriptPanelState.wordStartIndex = globalIndex;
    transcriptPanelState.wordEndIndex = null;
  } else {
    const anchor = transcriptPanelState.wordStartIndex;
    transcriptPanelState.wordStartIndex = Math.min(anchor, globalIndex);
    transcriptPanelState.wordEndIndex = Math.max(anchor, globalIndex);
  }
  refreshTranscriptWordStyles();
  updateTranscriptFooter();
}

function getSelectedTranscriptWords(requireComplete = true) {
  const start = transcriptPanelState.wordStartIndex;
  const end = transcriptPanelState.wordEndIndex;
  if (start === null) return [];
  if (requireComplete && end === null) return [];
  const last = end === null ? start : end;
  const out = [];
  for (let i = Math.min(start, last); i <= Math.max(start, last); i++) {
    const word = transcriptPanelState.wordMetaMap.get(i);
    if (word) out.push(word);
  }
  return out;
}

function getSelectedTranscriptSurroundingContext(words, radius = 45) {
  const valid = (Array.isArray(words) ? words : []).filter(w => Number.isFinite(Number(w?.globalIndex)));
  if (!valid.length) return { before: '', after: '' };
  const start = Math.min(...valid.map(w => Number(w.globalIndex)));
  const end = Math.max(...valid.map(w => Number(w.globalIndex)));
  const before = [];
  const after = [];
  for (let i = Math.max(0, start - radius); i < start; i++) {
    const w = transcriptPanelState.wordMetaMap.get(i);
    if (w?.text) before.push(w);
  }
  for (let i = end + 1; i <= end + radius; i++) {
    const w = transcriptPanelState.wordMetaMap.get(i);
    if (w?.text) after.push(w);
  }
  return {
    before: joinSelectedTranscriptWords(before),
    after: joinSelectedTranscriptWords(after)
  };
}

function refreshTranscriptWordStyles() {
  const start = transcriptPanelState.wordStartIndex;
  const end = transcriptPanelState.wordEndIndex;
  for (const [index, span] of transcriptPanelState.wordMap.entries()) {
    span.classList.remove('ytanki-word-anchor', 'ytanki-word-range');
    if (start === null) continue;
    if (end === null) {
      if (index === start) span.classList.add('ytanki-word-anchor');
    } else if (index >= Math.min(start, end) && index <= Math.max(start, end)) {
      span.classList.add('ytanki-word-range');
    }
  }
}

function applyTranscriptRowStyle(index) {
  const row = transcriptPanelState.rowMap.get(index);
  if (!row) return;
  const current = transcriptPanelState.currentIndex === index;
  if (current) {
    row.style.background = '#30331d';
    row.style.borderColor = '#7a7d34';
  } else {
    row.style.background = '#202020';
    row.style.borderColor = 'transparent';
  }
}

function estimateManualSelectionEnd(words) {
  const valid = (Array.isArray(words) ? words : [])
    .filter(w => Number.isFinite(Number(w?.start)) && Number.isFinite(Number(w?.end)))
    .slice()
    .sort((a, b) => Number(a.globalIndex ?? 0) - Number(b.globalIndex ?? 0));
  if (!valid.length) return NaN;

  const last = valid[valid.length - 1];
  const lastStart = Number(last.start);
  let nominalEnd = Math.max(lastStart + 0.02, Number(last.end));
  const next = Number.isFinite(Number(last.globalIndex))
    ? transcriptPanelState.wordMetaMap.get(Number(last.globalIndex) + 1)
    : null;
  const nextStart = Number(next?.start);
  if (Number.isFinite(nextStart) && nextStart > lastStart) {
    nominalEnd = Math.min(nominalEnd, nextStart);
  }

  const nominalSpan = nominalEnd - lastStart;
  if (!(nominalSpan > 0)) return lastStart + 0.12;

  // YouTube timedtext は多くの場合「単語/segmentの開始」はかなり正確だが、
  // 最後のsegmentの終了を次cue開始まで引き延ばすことがある。
  // 選択範囲内の直近の単語開始間隔から局所的な発話速度を推定し、
  // 明らかに長い末尾だけを「最後の語の発音時間」に縮める。
  const charWeight = (text) => {
    const core = String(text || '').replace(/[^\p{L}\p{N}]/gu, '');
    return Math.max(2, Math.min(14, core.length || 2));
  };
  const rates = [];
  const sampleStart = Math.max(0, valid.length - 10);
  for (let i = sampleStart; i < valid.length - 1; i++) {
    const a = valid[i];
    const b = valid[i + 1];
    const dt = Number(b.start) - Number(a.start);
    if (dt >= 0.08 && dt <= 1.15) {
      rates.push(dt / charWeight(a.text));
    }
  }
  rates.sort((a, b) => a - b);
  const medianRate = rates.length
    ? rates[Math.floor(rates.length / 2)]
    : 0.055;
  const secPerChar = Math.max(0.035, Math.min(0.11, medianRate));
  const estimatedSpeech = Math.max(0.18, Math.min(1.05,
    secPerChar * charWeight(last.text) + 0.10
  ));

  // 普通の短いspanはYouTube時刻をそのまま採用する。
  // 「次の字幕開始まで1秒以上空いている」等、推定発音時間に比べて
  // 不自然に長いときだけ trailing gap を除去する。
  const suspiciousTail = nominalSpan > Math.max(0.90, estimatedSpeech * 1.85);
  if (!suspiciousTail) return nominalEnd;

  // 語尾を切らないため約80msの安全余白を残す。
  return Math.min(nominalEnd, lastStart + estimatedSpeech + 0.08);
}

function getManualSelectionTiming(words) {
  const valid = (Array.isArray(words) ? words : [])
    .filter(w => Number.isFinite(Number(w?.start)) && Number.isFinite(Number(w?.end)));
  if (!valid.length) return { start: NaN, end: NaN, adjustedEnd: false };
  const start = Number(valid[0].start);
  const rawEnd = Number(valid[valid.length - 1].end);
  const end = estimateManualSelectionEnd(valid);
  return {
    start,
    end: Number.isFinite(end) ? Math.max(start + 0.02, end) : rawEnd,
    adjustedEnd: Number.isFinite(end) && Number.isFinite(rawEnd) && end < rawEnd - 0.08
  };
}

function updateTranscriptFooter() {
  const root = transcriptPanelState.root;
  if (!root) return;
  const info = root.querySelector('[data-ytanki="selected-info"]');
  const save = root.querySelector('[data-ytanki="save"]');
  const correct = root.querySelector('[data-ytanki="correct"]');
  const start = transcriptPanelState.wordStartIndex;
  const end = transcriptPanelState.wordEndIndex;

  if (info) {
    if (start === null) {
      info.textContent = '開始単語をクリック → 終了単語をクリック';
    } else if (end === null) {
      const word = transcriptPanelState.wordMetaMap.get(start);
      info.textContent = `開始 ${formatPanelTimePrecise(word?.start)}「${word?.text || ''}」・終了単語をクリック`;
    } else {
      const words = getSelectedTranscriptWords(true);
      const first = words[0];
      const rangeTiming = getManualSelectionTiming(words);
      const direct = words.filter(w => w.timingSource === 'youtube-segment').length;
      const timing = direct === words.length ? 'YouTube単語時刻' : '一部補間';
      const endNote = rangeTiming.adjustedEnd ? '・末尾無音補正' : '';
      info.textContent = `${words.length}語・${formatPanelTimePrecise(first?.start)}〜${formatPanelTimePrecise(rangeTiming.end)}・${timing}${endNote}`;
    }
  }
  const ready = start !== null && end !== null;
  if (save) {
    save.setAttribute('aria-disabled', ready ? 'false' : 'true');
    save.style.opacity = ready ? '1' : '.45';
    save.style.setProperty('cursor', 'pointer', 'important');
  }
  if (correct) {
    correct.setAttribute('aria-disabled', ready ? 'false' : 'true');
    correct.style.opacity = ready ? '1' : '.45';
    correct.style.setProperty('cursor', 'pointer', 'important');
  }
}

function clearTranscriptSelection() {
  transcriptPanelState.selected.clear();
  transcriptPanelState.anchorIndex = -1;
  transcriptPanelState.wordStartIndex = null;
  transcriptPanelState.wordEndIndex = null;
  refreshTranscriptWordStyles();
  updateTranscriptFooter();
}


function joinSelectedTranscriptWords(words) {
  return (words || []).map(w => String(w?.text || '')).join(' ')
    .replace(/\s+([,.;:!?…])/g, '$1')
    .replace(/([\[(“‘])\s+/g, '$1')
    .replace(/\s+([\])”’])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

async function correctSelectedTranscriptRange() {
  if (!transcriptIsCurrentForAction()) return;
  const words = getSelectedTranscriptWords(true);
  if (!words.length) {
    showToast('修正する範囲の開始単語と終了単語を選択してください', true);
    return;
  }
  if (words.length > 24) {
    showToast('辞書修正は24語以内の範囲にしてください', true);
    return;
  }
  const source = joinSelectedTranscriptWords(words);
  const replacement = window.prompt(`誤字幕を修正してユーザー辞書へ登録します。\n\n修正前: ${source}\n\n正しい表記:`, source);
  if (replacement === null) return;
  const target = String(replacement || '').trim().replace(/\s+/g, ' ');
  if (!target) {
    showToast('修正後の文字列を入力してください', true);
    return;
  }
  if (target === source) {
    showToast('修正前と修正後が同じです', true);
    return;
  }

  const button = transcriptPanelState.root?.querySelector('[data-ytanki="correct"]');
  const originalLabel = button?.textContent || '字幕修正';
  if (button) {
    button.textContent = '登録中…';
    button.style.opacity = '.7';
  }
  try {
    const response = await sendRuntimeMessage({
      type: 'TRANSCRIPT_USER_CORRECTION',
      words,
      replacement: target,
      transcriptVideoId: String(transcriptPanelState.videoId || '')
    });
    if (!response?.ok) throw new Error(response?.error || 'ユーザー辞書への登録に失敗しました');
    showToast(`ユーザー辞書: ${response.from} → ${response.to}`, false);
    // 手動修正は選択箇所だけローカル反映し、字幕全体の再処理は行わない。
    applyLocalTranscriptUserCorrection(words, target, response.from);
  } catch (err) {
    showToast(`字幕修正失敗: ${err?.message || err}`, true);
  } finally {
    if (button) {
      button.textContent = originalLabel;
      button.style.opacity = '1';
      updateTranscriptFooter();
    }
  }
}


function applyLocalTranscriptUserCorrection(selectedWords, replacementText, dictionaryRootSource = '') {
  const current = transcriptPanelState.currentTranscript;
  if (!current || !Array.isArray(current.cues) || !current.cues.length) {
    clearTranscriptSelection();
    return;
  }
  const selected = (selectedWords || []).filter(w => Number.isFinite(Number(w?.globalIndex)));
  if (!selected.length) {
    clearTranscriptSelection();
    return;
  }
  const startIndex = Math.min(...selected.map(w => Number(w.globalIndex)));
  const endIndex = Math.max(...selected.map(w => Number(w.globalIndex)));
  const sourceText = joinSelectedTranscriptWords(selected);
  const rootSourceText = String(dictionaryRootSource || '').trim().replace(/\s+/g, ' ') || sourceText;
  const tokens = String(replacementText || '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return;

  const patched = structuredClone(current);
  const flat = [];
  patched.cues.forEach((cue, cueIndex) => {
    (Array.isArray(cue.words) ? cue.words : []).forEach((word, wordPos) => {
      flat.push({ cueIndex, wordPos, word });
    });
  });
  const affected = flat.filter(x => {
    const gi = Number(x.word?.globalIndex);
    return Number.isFinite(gi) && gi >= startIndex && gi <= endIndex;
  });
  if (!affected.length) {
    clearTranscriptSelection();
    return;
  }

  const first = affected[0];
  const startTime = Number(affected[0].word?.start || 0);
  const endTimeRaw = Number(affected[affected.length - 1].word?.end || startTime);
  const endTime = Math.max(startTime + 0.01, endTimeRaw);
  const total = Math.max(0.01, endTime - startTime);
  const note = `ユーザー修正: ${rootSourceText} → ${replacementText}`;
  const replacementWords = tokens.map((text, i) => ({
    ...structuredClone(first.word),
    text,
    start: startTime + total * (i / tokens.length),
    end: startTime + total * ((i + 1) / tokens.length),
    timingSource: first.word?.timingSource || 'cue-interpolated',
    dictionaryCorrected: true,
    dictionaryLayer: 'user',
    originalText: rootSourceText,
    correctionNote: note
  }));

  const affectedSet = new Set(affected.map(x => `${x.cueIndex}:${x.wordPos}`));
  const firstKey = `${first.cueIndex}:${first.wordPos}`;
  patched.cues.forEach((cue, cueIndex) => {
    const nextWords = [];
    (Array.isArray(cue.words) ? cue.words : []).forEach((word, wordPos) => {
      const key = `${cueIndex}:${wordPos}`;
      if (key === firstKey) nextWords.push(...replacementWords);
      if (!affectedSet.has(key)) nextWords.push(word);
    });
    cue.words = nextWords;
    cue.text = joinSelectedTranscriptWords(nextWords);
    if (nextWords.length) {
      cue.start = Math.min(Number(cue.start || nextWords[0].start || 0), ...nextWords.map(w => Number(w.start || 0)));
      cue.end = Math.max(Number(cue.end || nextWords[nextWords.length - 1].end || cue.start || 0), ...nextWords.map(w => Number(w.end || 0)));
    }
  });
  patched.cues = patched.cues.filter(cue => Array.isArray(cue.words) && cue.words.length);

  let globalIndex = 0;
  patched.cues.forEach(cue => {
    cue.words.forEach(word => { word.globalIndex = globalIndex++; });
    cue.text = joinSelectedTranscriptWords(cue.words);
  });
  patched.correctionCount = Number(patched.correctionCount || 0) + 1;
  patched.corrections = Array.isArray(patched.corrections) ? patched.corrections.slice() : [];
  patched.corrections.push({ type: 'dictionary-user', from: rootSourceText, to: replacementText, at: startTime, layer: 'user' });

  showTranscriptPanel(patched, { focusCurrent: false, preserveSelection: false });
}

async function saveTranscriptSelectionFromPanel() {
  if (!transcriptIsCurrentForAction()) return;
  const words = getSelectedTranscriptWords(true);
  if (!words.length) {
    updateTranscriptFooter();
    const message = transcriptPanelState.wordStartIndex === null
      ? '開始単語と終了単語をクリックしてください'
      : '終了単語をクリックしてください。同じ単語をもう一度押すと1語だけ選べます';
    showToast(message, true);
    return;
  }

  const save = transcriptPanelState.root?.querySelector('[data-ytanki="save"]');
  const original = save?.textContent || '選択範囲をAnkiへ';
  if (save) {
    save.setAttribute('aria-busy', 'true');
    save.dataset.busy = '1';
    save.style.opacity = '.7';
    save.textContent = '保存中…';
  }
  const info = transcriptPanelState.root?.querySelector('[data-ytanki="selected-info"]');
  if (info) info.textContent = `${words.length}語をAnkiへ送信中…`;

  try {
    const surrounding = getSelectedTranscriptSurroundingContext(words, 45);
    const rangeTiming = getManualSelectionTiming(words);
    const response = await Promise.race([
      sendRuntimeMessage({
        type: 'TRANSCRIPT_WORD_RANGE_SAVE',
        words,
        selectionStartVideoTime: rangeTiming.start,
        selectionEndVideoTime: rangeTiming.end,
        selectionEndAdjusted: rangeTiming.adjustedEnd,
        contextBefore: surrounding.before,
        contextAfter: surrounding.after,
        transcriptVideoId: String(transcriptPanelState.videoId || '')
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('保存処理が2分以内に完了しませんでした')), 120000))
    ]);
    if (!response?.ok) throw new Error(response?.error || 'Ankiへの保存に失敗しました');
    showToast(`Ankiへ保存: ${response.captionText}`, false);
    clearTranscriptSelection();
  } catch (err) {
    const message = err?.message || String(err);
    if (info) info.textContent = `保存失敗: ${message}`;
    showToast(`保存失敗: ${message}`, true);
  } finally {
    if (save) {
      save.removeAttribute('aria-busy');
      delete save.dataset.busy;
      save.style.pointerEvents = 'auto';
      save.style.opacity = '1';
      save.textContent = original;
      if (!info || !String(info.textContent || '').startsWith('保存失敗:')) {
        updateTranscriptFooter();
      } else {
        setTimeout(() => updateTranscriptFooter(), 4500);
      }
    }
  }
}

function scrollTranscriptRowWithinList(index, behavior = 'smooth') {
  const list = transcriptPanelState.list;
  const row = transcriptPanelState.rowMap.get(index);
  if (!list || !row) return;

  // scrollIntoView() はページ全体のスクロールコンテナまで動かすことがある。
  // 字幕リスト内の相対位置だけ計算し、list.scrollTo() のみを使う。
  const listRect = list.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const rowTopInScrollContent = list.scrollTop + (rowRect.top - listRect.top);
  const targetTop = rowTopInScrollContent - Math.max(0, (list.clientHeight - rowRect.height) / 2);
  const maxTop = Math.max(0, list.scrollHeight - list.clientHeight);
  list.scrollTo({
    top: Math.max(0, Math.min(maxTop, targetTop)),
    behavior
  });
}

function updateCurrentTranscriptCue() {
  const cues = transcriptPanelState.cues;
  if (!cues.length || !transcriptPanelState.root) return;
  const video = document.querySelector('video');
  if (!video) return;
  const t = Number(video.currentTime || 0);
  let lo = 0, hi = cues.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (Number(cues[mid].start) <= t + 0.05) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (best >= 0 && Number(cues[best].end) < t - 0.2
      && best + 1 < cues.length && Number(cues[best + 1].start) <= t + 0.2) best++;
  if (best === transcriptPanelState.currentIndex) return;
  const old = transcriptPanelState.currentIndex;
  transcriptPanelState.currentIndex = best;
  if (old >= 0) applyTranscriptRowStyle(old);
  if (best >= 0) applyTranscriptRowStyle(best);
  if (transcriptPanelState.follow && Date.now() > transcriptPanelState.manualScrollUntil && best >= 0) {
    scrollTranscriptRowWithinList(best, 'smooth');
  }
}

function focusCurrentTranscriptCue(force = false) {
  updateCurrentTranscriptCue();
  const index = transcriptPanelState.currentIndex;
  if (index >= 0) {
    if (force) transcriptPanelState.manualScrollUntil = 0;
    scrollTranscriptRowWithinList(index, 'smooth');
  }
}

function seekVideoToCue(cue) {
  const video = document.querySelector('video');
  if (!video) return;
  video.currentTime = Math.max(0, Number(cue.start || 0) - 0.35);
  video.play().catch(() => {});
  transcriptPanelState.manualScrollUntil = 0;
}

async function requestTranscriptRefresh(focusCurrent = false, preserveSelection = true) {
  if (!transcriptPanelState.root) return null;
  const expectedVideoId = currentYouTubeVideoId();
  const serial = ++transcriptPanelState.refreshSerial;
  transcriptPanelState.pendingVideoId = expectedVideoId;
  setTranscriptPanelLoading(true, preserveSelection);
  try {
    const result = await sendRuntimeMessage({
      type: 'TRANSCRIPT_REFRESH_REQUEST',
      focusCurrent,
      preserveSelection,
      youtubeTrackId: String(transcriptPanelState.preferredTrackId || ''),
      expectedVideoId
    });
    if (serial === transcriptPanelState.refreshSerial) transcriptPanelState.pendingVideoId = '';
    return result;
  } catch (err) {
    if (serial === transcriptPanelState.refreshSerial) transcriptPanelState.pendingVideoId = '';
    const message = String(err?.message || err || '');
    if (/youtube-navigation-changed|youtube-transcript-video-mismatch/i.test(message)) {
      clearTranscriptForVideoChange();
      scheduleTranscriptRefreshAfterNavigation(250);
      return null;
    }
    showToast(`字幕更新失敗: ${message}`, true);
    return null;
  }
}

function scheduleLiveTranscriptRefresh() {
  if (transcriptPanelState.liveRefreshTimer) clearInterval(transcriptPanelState.liveRefreshTimer);
  transcriptPanelState.liveRefreshTimer = null;
  if (!transcriptPanelState.isLive || !transcriptPanelState.root) return;
  transcriptPanelState.liveRefreshTimer = setInterval(() => requestTranscriptRefresh(false), 15000);
}

function destroyTranscriptPanel() {
  transcriptPanelState.host?.remove();
  transcriptPanelState.host = null;
  transcriptPanelState.shadow = null;
  transcriptPanelState.root = null;
  transcriptPanelState.list = null;
  transcriptPanelState.cues = [];
  transcriptPanelState.selected.clear();
  transcriptPanelState.wordStartIndex = null;
  transcriptPanelState.wordEndIndex = null;
  transcriptPanelState.wordMap.clear();
  transcriptPanelState.wordMetaMap.clear();
  transcriptPanelState.rowMap.clear();
  transcriptPanelState.currentIndex = -1;
  transcriptPanelState.anchorIndex = -1;
  transcriptPanelState.currentTranscript = null;
  transcriptPanelState.trackSelect = null;
  transcriptPanelState.trackRow = null;
  transcriptPanelState.pendingVideoId = '';
  transcriptPanelState.refreshSerial++;
  if (transcriptPanelState.navigationRefreshTimer) clearTimeout(transcriptPanelState.navigationRefreshTimer);
  transcriptPanelState.navigationRefreshTimer = null;
  if (transcriptPanelState.updateTimer) clearInterval(transcriptPanelState.updateTimer);
  if (transcriptPanelState.liveRefreshTimer) clearInterval(transcriptPanelState.liveRefreshTimer);
  transcriptPanelState.updateTimer = null;
  transcriptPanelState.liveRefreshTimer = null;
}

function transcriptCueKey(cue) {
  return `${Math.round(Number(cue?.start || 0) * 10)}|${String(cue?.text || '').toLowerCase().replace(/\s+/g, ' ').trim()}`;
}

function formatPanelTimePrecise(sec) {
  const value = Math.max(0, Number(sec) || 0);
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = value % 60;
  const secText = s.toFixed(2).padStart(5, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${secText}` : `${m}:${secText}`;
}

function formatPanelTime(sec) {
  let total = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

// YouTubeはSPA遷移するため、旧動画の字幕を即座に無効化してから新動画を取得する。
// finishだけを待つと、その間に旧字幕を選択・保存できてしまい、旧字幕タイムコードと
// 新動画の録音タイムラインが食い違って「録音バッファにありません」になるため、start時点で消す。
document.addEventListener('yt-navigate-start', () => {
  clearTranscriptForVideoChange();
});

document.addEventListener('yt-navigate-finish', () => {
  clearTranscriptForVideoChange();
  scheduleTranscriptRefreshAfterNavigation(300);
});

document.addEventListener('yt-page-data-updated', () => {
  if (!transcriptPanelState.root) return;
  guardTranscriptAgainstCurrentVideo();
});


function showToast(message, isError) {
  let toast = document.getElementById('anki-dictation-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'anki-dictation-toast';
    Object.assign(toast.style, {
      position: 'fixed',
      right: '20px',
      bottom: '24px',
      zIndex: '2147483647',
      maxWidth: '520px',
      padding: '12px 16px',
      borderRadius: '9px',
      color: '#fff',
      font: '14px/1.5 system-ui, sans-serif',
      boxShadow: '0 5px 22px rgba(0,0,0,.35)',
      transition: 'opacity .2s ease',
      // 通知は表示専用。透明化後もクリックを奪わないよう常にポインターイベントを通す。
      pointerEvents: 'none'
    });
    document.documentElement.appendChild(toast);
  }
  toast.style.pointerEvents = 'none';
  toast.style.background = isError ? 'rgba(153,27,27,.95)' : 'rgba(17,24,39,.95)';
  toast.textContent = message;
  toast.style.opacity = '1';
  clearTimeout(showToast.timer);
  clearTimeout(showToast.removeTimer);
  showToast.timer = setTimeout(() => {
    toast.style.opacity = '0';
    // 透明な要素自体も残さず、後続UIへの干渉を完全に防ぐ。
    showToast.removeTimer = setTimeout(() => toast.remove(), 250);
  }, 3200);
}

})();
