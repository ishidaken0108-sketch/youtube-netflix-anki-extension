importScripts('hololive-dictionary.js');

const DEFAULT_GEMINI_STUDY_NOTE_INSTRUCTION = `Vocabulary extraction policy:
- Extract generously. The learner prefers deleting extra items later rather than missing useful vocabulary.
- Favor REUSABLE learning units that can be applied in other sentences.
- Split compositional sequences into smaller reusable units when each unit has an independent meaning. Do NOT glue ordinary grammar/support words onto a content word merely because they are adjacent.
- Example: if the caption contains "have to be selfish", prefer separate items such as "have to be: ～しなければならない／～にならなければならない" and "selfish: 利己的な、自分勝手な". Do NOT output "have to be selfish" as one vocabulary item unless the whole sequence has a special idiomatic meaning.
- Keep true phrasal verbs, idioms, and fixed expressions intact when splitting would lose or distort their meaning (for example: "figure out", "take it for granted", "be into").
- When an individual word itself is useful, include it as a standalone item even if it appears inside a larger compositional phrase.
- Include ordinary conversational words, concrete nouns, adjectives, adverbs, slang, collocations, and grammar chunks when they may be useful for reuse.
- Even an elementary-looking word such as "here", "just", "get", or "kind of" may be worth including when its contextual use or nuance is not literal/obvious.
- Omit only extremely basic function words and bare forms such as articles, pronouns, and standalone be/do/have when they carry no special meaning.
- Use a natural dictionary/citation form when helpful, but keep the item clearly identifiable in the target caption.
- Give the concise Japanese meaning that fits THIS sentence.
- Do not invent vocabulary that is absent from the target caption.
- Avoid exact duplicates. If unsure whether to combine or split, prefer MORE GRANULAR items and include more rather than less.`;

const DEFAULTS = {
  ankiUrl: 'http://127.0.0.1:8765',
  deckName: 'Default',
  modelName: 'Enhanced Cloze',
  contentField: 'Content',
  audioField: 'Audio',
  sourceField: '',
  translationField: '',
  translationEnabled: false,
  aiProofreadEnabled: true,
  hololiveDictionaryEnabled: true,
  audioSeconds: 8,
  audioAlignToSentence: true,
  audioPrePadding: 2.0,
  audioPostPadding: -0.5,
  audioMaxAlignedSeconds: 18,
  captionSeconds: 8,
  captionTimingAdjustment: 0,
  minSentenceWords: 3,
  hideCaptions: true,
  autoEnableCaptions: true
};

const LOCAL_DEFAULTS = {
  geminiApiKey: '',
  geminiStudyNoteInstruction: DEFAULT_GEMINI_STUDY_NOTE_INSTRUCTION,
  hololiveDictionary: globalThis.HOLOLIVE_DICTIONARY_DEFAULT || '',
  userLearnedDictionary: [],
  dictionaryRevision: 1,
  geminiDebugLog: []
};

chrome.runtime.onInstalled.addListener(async (details) => {
  // Fresh-install build: initialize from a clean state instead of migrating old versions.
  if (details?.reason !== 'install') return;
  await Promise.all([
    chrome.storage.sync.clear(),
    chrome.storage.local.clear()
  ]);
  await Promise.all([
    chrome.storage.sync.set({ ...DEFAULTS }),
    chrome.storage.local.set({
      ...LOCAL_DEFAULTS,
      hololiveDictionary: globalThis.HOLOLIVE_DICTIONARY_DEFAULT || '',
      userLearnedDictionary: [],
      dictionaryRevision: 1,
      geminiDebugLog: []
    })
  ]);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const recordingTabId = await getRecordingTabId();
  if (recordingTabId === tabId) await stopCapture();
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'save-capture') return;
  try {
    await openTranscriptPanel(true);
  } catch (err) {
    console.error(err);
    await toastRecordingTab(`字幕パネル表示失敗: ${err.message}`, true);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target === 'offscreen') return;

  (async () => {
    switch (message.type) {
      case 'START_CAPTURE':
        return await startCapture();
      case 'STOP_CAPTURE':
        return await stopCapture();
      case 'SAVE_CAPTURE':
        return await saveCurrentCapture();
      case 'OPEN_TRANSCRIPT_PANEL':
        return await openTranscriptPanel(message.focusCurrent !== false);
      case 'TRANSCRIPT_REFRESH_REQUEST': {
        const tabId = sender?.tab?.id;
        if (!tabId) throw new Error('動画タブを特定できません');
        return await sendFullTranscriptToTab(tabId, {
          focusCurrent: !!message.focusCurrent,
          preserveSelection: message.preserveSelection !== false,
          netflixTrackId: String(message.netflixTrackId || ''),
          youtubeTrackId: String(message.youtubeTrackId || ''),
          expectedVideoId: String(message.expectedVideoId || '')
        });
      }
      case 'AUDIO_TIMELINE_SYNC': {
        const tabId = sender?.tab?.id;
        const recordingTabId = await getRecordingTabId();
        if (!tabId || tabId !== recordingTabId) return { ok: false, ignored: true };
        try {
          return await chrome.runtime.sendMessage({
            target: 'offscreen',
            type: 'OFFSCREEN_TIMELINE_SYNC',
            currentTime: Number(message.currentTime),
            playbackRate: Number(message.playbackRate || 1),
            paused: !!message.paused,
            sentAtMs: Number(message.sentAtMs || Date.now())
          });
        } catch {
          return { ok: false, ignored: true };
        }
      }
      case 'TRANSCRIPT_SELECTION_SAVE':
        return await saveTranscriptSelection(message.cues, sender?.tab?.id, String(message.transcriptVideoId || ''));
      case 'TRANSCRIPT_WORD_RANGE_SAVE':
        return await saveTranscriptWordRange(message.words, sender?.tab?.id, {
          contextBefore: message.contextBefore,
          contextAfter: message.contextAfter,
          selectionStartVideoTime: Number(message.selectionStartVideoTime),
          selectionEndVideoTime: Number(message.selectionEndVideoTime),
          selectionEndAdjusted: !!message.selectionEndAdjusted,
          transcriptVideoId: String(message.transcriptVideoId || '')
        });
      case 'TRANSCRIPT_USER_CORRECTION':
        return await saveUserTranscriptCorrection(message.words, message.replacement, sender?.tab?.id, String(message.transcriptVideoId || ''));
      case 'GET_LEARNED_DICTIONARIES':
        return await getLearnedDictionaryState();
      case 'DELETE_LEARNED_DICTIONARY_ENTRY':
        return await deleteLearnedDictionaryEntry(message.layer, message.id);
      case 'GET_GEMINI_DEBUG_LOG':
        return await getGeminiDebugLog();
      case 'CLEAR_GEMINI_DEBUG_LOG':
        return await clearGeminiDebugLog();
      case 'GET_BUILD_INFO':
        return {
          ok: true,
          manifestVersion: chrome.runtime.getManifest().version,
          backgroundBuild: EXTENSION_BUILD,
          promptVersion: GEMINI_PROMPT_VERSION,
          geminiModel: GEMINI_REVIEW_MODEL,
          reviewModel: GEMINI_REVIEW_MODEL,
          translationModel: GEMINI_TRANSLATION_MODEL
        };
      case 'CANDIDATE_SELECTED':
        return await saveSelectedCandidate(message.candidate, message.baseContext);
      case 'GET_STATUS':
        return await getStatus();
      case 'GET_CONFIG':
        return await getSettings();
      case 'SAVE_CONFIG': {
        const incoming = { ...(message.config || {}) };
        const geminiApiKey = String(incoming.geminiApiKey || '').trim();
        const geminiStudyNoteInstruction = String(incoming.geminiStudyNoteInstruction ?? DEFAULT_GEMINI_STUDY_NOTE_INSTRUCTION).trim() || DEFAULT_GEMINI_STUDY_NOTE_INSTRUCTION;
        const hololiveDictionary = String(incoming.hololiveDictionary ?? globalThis.HOLOLIVE_DICTIONARY_DEFAULT ?? '');
        delete incoming.geminiApiKey;
        delete incoming.geminiStudyNoteInstruction;
        delete incoming.defaultGeminiStudyNoteInstruction;
        delete incoming.hololiveDictionary;
        // 学習辞書はローカル専用。options側のconfigに含まれていてもsyncへ書き戻さない。
        delete incoming.userLearnedDictionary;
        delete incoming.dictionaryRevision;
        const [previousLocal, previousSynced] = await Promise.all([
          chrome.storage.local.get({ hololiveDictionary: globalThis.HOLOLIVE_DICTIONARY_DEFAULT || '', dictionaryRevision: 1 }),
          chrome.storage.sync.get({ hololiveDictionaryEnabled: true })
        ]);
        const dictionaryChanged = String(previousLocal.hololiveDictionary || '') !== hololiveDictionary;
        const holoModeChanged = Boolean(previousSynced.hololiveDictionaryEnabled !== false) !== Boolean(incoming.hololiveDictionaryEnabled !== false);
        const dictionaryRevision = dictionaryChanged ? Number(previousLocal.dictionaryRevision || 1) + 1 : Number(previousLocal.dictionaryRevision || 1);
        await Promise.all([
          chrome.storage.sync.set({ ...DEFAULTS, ...incoming }),
          chrome.storage.local.set({ geminiApiKey, geminiStudyNoteInstruction, hololiveDictionary, dictionaryRevision })
        ]);
        return { ok: true };
      }
      case 'ANKI_REFRESH':
        return await getAnkiLists(message.modelName || '');
      case 'ANKI_MODEL_FIELDS':
        return { ok: true, fields: await ankiInvoke('modelFieldNames', { modelName: message.modelName }) };
      default:
        return { ok: false, error: 'Unknown message' };
    }
  })().then(sendResponse).catch((err) => {
    console.error(err);
    sendResponse({ ok: false, error: err.message || String(err) });
  });

  return true;
});

async function getSettings() {
  const [synced, local] = await Promise.all([
    chrome.storage.sync.get(DEFAULTS),
    chrome.storage.local.get(LOCAL_DEFAULTS)
  ]);
  return { ...DEFAULTS, ...synced, ...LOCAL_DEFAULTS, ...local, defaultGeminiStudyNoteInstruction: DEFAULT_GEMINI_STUDY_NOTE_INSTRUCTION };
}

async function getRecordingTabId() {
  const data = await chrome.storage.session.get('recordingTabId');
  return data.recordingTabId || null;
}

async function getStatus() {
  const tabId = await getRecordingTabId();
  if (!tabId) return { ok: true, recording: false };
  try {
    const tab = await chrome.tabs.get(tabId);
    return { ok: true, recording: true, tabId, title: tab.title || '' };
  } catch {
    await chrome.storage.session.remove('recordingTabId');
    await chrome.action.setBadgeText({ text: '' });
    return { ok: true, recording: false };
  }
}

function getSupportedPlatform(url) {
  const value = String(url || '');
  if (value.startsWith('https://www.youtube.com/')) return 'youtube';
  if (/^https:\/\/(?:www\.)?netflix\.com\/watch\//i.test(value)) return 'netflix';
  return '';
}

function cleanPlatformTitle(title, platform = '') {
  let text = String(title || '').trim();
  if (platform === 'youtube') return text.replace(/\s*-\s*YouTube\s*$/i, '').trim();
  if (platform === 'netflix') {
    return text
      .replace(/^Watch\s+/i, '')
      .replace(/\s*[|–—-]\s*Netflix\s*$/i, '')
      .trim();
  }
  return text;
}

async function getActiveSupportedTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const platform = getSupportedPlatform(tab?.url);
  if (!tab?.id || !platform) {
    throw new Error('YouTubeまたはNetflixの再生タブを開いてください');
  }
  return { ...tab, platform };
}

async function ensureOffscreen() {
  const offscreenUrl = chrome.runtime.getURL('offscreen.html');
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl]
    });
    if (contexts.length) return;
  }
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: '動画タブの音声を短時間だけリングバッファに保持してディクテーション用に切り出すため'
    });
  } catch (err) {
    if (!String(err.message || err).includes('single offscreen')) throw err;
  }
}


async function ensureSupportedContentScript(tabId) {
  // Extension reload/update invalidates content-script contexts that were loaded
  // by the previous extension instance. Re-injecting on top of such a page leaves
  // stale DOM listeners behind, so require one real page reload instead.
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'ANKI_DICTATION_PING' });
    if (pong?.ok && String(pong.version || '') === EXTENSION_BUILD) return true;
    if (pong?.ok) {
      throw new Error(`拡張機能を更新しました（ページ側 ${pong.version || '旧版'} / Background ${EXTENSION_BUILD}）。この動画タブを1回再読み込みしてから、もう一度実行してください。`);
    }
  } catch (err) {
    const message = String(err?.message || err || '');
    if (message.includes('ページ側')) throw err;
    throw new Error('拡張機能の更新後、この動画タブには古いコンテキストが残っています。タブを1回再読み込みしてから、もう一度実行してください。');
  }
  return true;
}

async function startCapture() {
  const tab = await getActiveSupportedTab();
  await ensureSupportedContentScript(tab.id);
  const existing = await getRecordingTabId();
  if (existing === tab.id) {
    return { ok: true, recording: true, message: 'すでに録音中です' };
  }
  if (existing) await stopCapture();

  await ensureOffscreen();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  const config = await getSettings();
  // 動画を開く段階ではAI sessionを作らない。
  const offscreenResult = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'OFFSCREEN_START',
    streamId,
    maxSeconds: Math.max(60, Number(config.audioSeconds) + 10, Number(config.captionSeconds) + 35)
  });
  if (!offscreenResult?.ok) throw new Error(offscreenResult?.error || '音声録音を開始できませんでした');

  await chrome.storage.session.set({ recordingTabId: tab.id });
  // 録音バッファと動画時刻を絶対タイムコードで対応付ける。
  // Content側から250msごとに同期するが、開始直後にも1点シードしておく。
  try {
    const initialState = await getCurrentVideoState(tab.id);
    await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'OFFSCREEN_TIMELINE_SYNC',
      currentTime: Number(initialState.currentTime || 0),
      playbackRate: Number(initialState.playbackRate || 1),
      paused: !!initialState.paused,
      sentAtMs: Date.now()
    });
  } catch {}
  await chrome.action.setBadgeBackgroundColor({ color: '#b91c1c' });
  await chrome.action.setBadgeText({ text: 'ON' });

  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: 'DICTATION_START',
      hideCaptions: !!config.hideCaptions,
      autoEnableCaptions: !!config.autoEnableCaptions
    });
  } catch (err) {
    console.warn('content start failed', err);
  }

  // メイン操作はLanguage Reactor風の字幕一覧。録音開始と同時に右側へ表示する。
  sendFullTranscriptToTab(tab.id, { focusCurrent: true, preserveSelection: false }).catch(async (err) => {
    console.warn('transcript panel load failed', err);
    await toastTab(tab.id, `字幕一覧を取得できません: ${err.message}`, true);
  });

  await toastTab(tab.id, '録音開始。右側の字幕を選んでAnkiへ追加できます');
  return { ok: true, recording: true };
}

async function stopCapture() {
  const tabId = await getRecordingTabId();
  try {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'OFFSCREEN_STOP' });
  } catch (err) {
    console.warn('offscreen stop failed', err);
  }
  if (tabId) {
    try { await chrome.tabs.sendMessage(tabId, { type: 'DICTATION_STOP' }); } catch {}
  }
  await chrome.storage.session.remove('recordingTabId');
  await chrome.action.setBadgeText({ text: '' });
  return { ok: true, recording: false };
}


async function openTranscriptPanel(focusCurrent = true) {
  const activeTab = await getActiveSupportedTab();
  let recordingTabId = await getRecordingTabId();

  // tabCaptureはユーザー操作後に開始する必要があるため、ポップアップ/ショートカットから
  // パネルを開いた時点で録音も開始する。すでに別タブを録音中なら切り替える。
  if (recordingTabId !== activeTab.id) {
    await startCapture();
    recordingTabId = activeTab.id;
  } else {
    await sendFullTranscriptToTab(activeTab.id, { focusCurrent, preserveSelection: true });
  }
  return { ok: true, recording: true, tabId: recordingTabId };
}

async function getNetflixFullTranscriptTrack(tabId, preferredTrackId = '') {
  // v8.2: Netflix page MAIN world is used to read player state, list subtitle tracks, and obtain the
  // signed timed-text URL. Fetching that URL from netflix.com can fail because the
  // subtitle CDN is cross-origin. Download it from the extension service worker,
  // then parse the returned IMSC/WebVTT text in an isolated page world (DOMParser).
  let meta;
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [String(preferredTrackId || '')],
      func: async (preferredTrackId) => {
        const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
        const cleanNetflixTitle = () => String(document.title || '')
          .replace(/^Watch\s+/i, '')
          .replace(/\s*[|–—-]\s*Netflix\s*$/i, '')
          .trim();

        const getAPI = () => globalThis.netflix?.appContext?.state?.playerApp?.getAPI?.();
        const getVideoPlayer = () => getAPI()?.videoPlayer;
        const getPlayer = () => {
          const videoPlayer = getVideoPlayer();
          const sessionIds = videoPlayer?.getAllPlayerSessionIds?.() || [];
          if (!sessionIds.length) return undefined;
          return videoPlayer.getVideoPlayerBySessionId?.(sessionIds[sessionIds.length - 1]);
        };
        const timedTextUrls = () => {
          const urls = new Map();
          try {
            const videoPlayer = getVideoPlayer();
            const sessionIds = videoPlayer?.getAllPlayerSessionIds?.() || [];
            if (!sessionIds.length) return urls;
            const activeSessionId = sessionIds[sessionIds.length - 1];
            const root = globalThis.netflix?.appContext?.state?.playerApp?.getState?.()
              ?.videoPlayer?.cadmiumPlayerRepository?.playersById?.[activeSessionId];
            if (!root) return urls;
            const seen = new WeakSet();
            const stack = [{ node: root, depth: 0 }];
            while (stack.length) {
              const { node, depth } = stack.pop();
              if (node === null || typeof node !== 'object' || depth > 20 || seen.has(node)) continue;
              seen.add(node);
              if (node instanceof ArrayBuffer || ArrayBuffer.isView(node)) continue;
              try {
                if (
                  node.type === 'timedtext' &&
                  typeof node.trackId === 'string' &&
                  Array.isArray(node.urls) &&
                  node.urls.length > 0 &&
                  typeof node.urls[0]?.url === 'string' &&
                  !urls.has(node.trackId)
                ) {
                  urls.set(node.trackId, node.urls[0].url);
                }
              } catch {}
              if (Array.isArray(node)) {
                for (const value of node) {
                  if (value !== null && typeof value === 'object') stack.push({ node: value, depth: depth + 1 });
                }
              } else {
                for (const key of Object.keys(node)) {
                  let value;
                  try { value = node[key]; } catch { continue; }
                  if (value !== null && typeof value === 'object') stack.push({ node: value, depth: depth + 1 });
                }
              }
            }
          } catch {}
          return urls;
        };

        let player;
        let trackList = [];
        for (let attempt = 0; attempt < 80; attempt++) {
          player = getPlayer();
          try { trackList = player?.getTimedTextTrackList?.() || []; } catch { trackList = []; }
          if (player && trackList.length) break;
          if (attempt < 79) await sleep(250);
        }
        if (!player || !trackList.length) {
          const sessionCount = (() => { try { return getVideoPlayer()?.getAllPlayerSessionIds?.()?.length || 0; } catch { return 0; } })();
          return {
            ok: false,
            reason: `netflix-player-state-unavailable:netflix=${!!globalThis.netflix}:api=${!!getAPI()}:sessions=${sessionCount}:tracks=${trackList.length}`
          };
        }

        const isEnglish = (track) => {
          const values = [track?.language, track?.bcp47, track?.languageDescription, track?.displayName]
            .map(x => String(x || '').toLowerCase());
          return values.some(x => x === 'en' || x.startsWith('en-') || x.includes('english'));
        };
        const usableTracks = trackList.filter(t => t && t.bcp47 && !t.isNoneTrack && !t.isForcedNarrative && !t.isImageBased);
        let currentTrack;
        try { currentTrack = player.getTimedTextTrack?.(); } catch {}
        const currentTrackId = String(currentTrack?.trackId || '');
        const availableTracks = usableTracks.map(t => ({
          trackId: String(t.trackId || ''),
          bcp47: String(t.bcp47 || t.language || ''),
          language: String(t.language || ''),
          label: String(t.displayName || t.languageDescription || t.language || t.bcp47 || 'Netflix subtitles'),
          trackType: String(t.rawTrackType || ''),
          isCurrentOnNetflix: String(t.trackId || '') === currentTrackId
        }));

        // The extension subtitle track is independent from Netflix's visible subtitle.
        // Use the explicitly selected extension track when available; otherwise keep the
        // previous behavior of preferring English.
        const requestedTrackId = String(preferredTrackId || '');
        const requestedTrack = requestedTrackId
          ? usableTracks.find(t => String(t.trackId || '') === requestedTrackId)
          : undefined;
        const english = usableTracks.filter(isEnglish);
        const pool = english.length ? english : usableTracks;
        const track = requestedTrack
          || pool.find(t => String(t.rawTrackType || '').toUpperCase() === 'SUBTITLES')
          || pool.find(t => String(t.rawTrackType || '').toUpperCase() === 'CLOSEDCAPTIONS')
          || pool[0];
        if (!track) return { ok: false, reason: `netflix-no-usable-subtitle-track:all=${trackList.length}:usable=${usableTracks.length}` };

        const selectedTrackId = String(track.trackId || '');
        let urlsByTrackId = timedTextUrls();
        let selectedUrl = selectedTrackId ? String(urlsByTrackId.get(selectedTrackId) || '') : '';
        let temporarilyChangedTrack = false;
        let previousTrack;
        let previousTrackId = '';
        let previousWasNone = false;
        let restoreVerified = true;

        if (!selectedUrl && selectedTrackId) {
          try {
            previousTrack = player.getTimedTextTrack?.();
            previousTrackId = String(previousTrack?.trackId || '');
            previousWasNone = !!previousTrack?.isNoneTrack;
          } catch {}
          try {
            // Netflix may lazily expose a timed-text URL only after the track is selected.
            // Change it only long enough to obtain the URL, then restore the visible Netflix
            // subtitle by resolving a FRESH track object from the current player state.
            if (previousTrackId !== selectedTrackId) {
              await player.setTimedTextTrack?.(track);
              temporarilyChangedTrack = true;
            }
            for (let attempt = 0; attempt < 80; attempt++) {
              urlsByTrackId = timedTextUrls();
              selectedUrl = String(urlsByTrackId.get(selectedTrackId) || '');
              if (selectedUrl) break;
              await sleep(100);
            }
          } catch (err) {
            return {
              ok: false,
              reason: `netflix-subtitle-track-activation-failed:${String(err?.message || err || 'unknown')}:track=${selectedTrackId}`
            };
          } finally {
            if (temporarilyChangedTrack) {
              restoreVerified = false;
              try {
                const freshList = player.getTimedTextTrackList?.() || [];
                const restoreTrack = previousWasNone
                  ? freshList.find(t => t?.isNoneTrack)
                  : freshList.find(t => String(t?.trackId || '') === previousTrackId);
                if (restoreTrack) {
                  await player.setTimedTextTrack?.(restoreTrack);
                  for (let attempt = 0; attempt < 20; attempt++) {
                    let nowTrack;
                    try { nowTrack = player.getTimedTextTrack?.(); } catch {}
                    const nowId = String(nowTrack?.trackId || '');
                    const nowNone = !!nowTrack?.isNoneTrack;
                    if ((previousWasNone && nowNone) || (!previousWasNone && nowId === previousTrackId)) {
                      restoreVerified = true;
                      break;
                    }
                    await sleep(75);
                  }
                }
              } catch {}
            }
          }
        }

        if (!selectedUrl) {
          return {
            ok: false,
            reason: `netflix-player-state-url-not-found:track=${selectedTrackId || 'none'}:tracks=${trackList.length}:urls=${urlsByTrackId.size}`
          };
        }

        const videos = [...document.querySelectorAll('video')];
        const video = videos.sort((a, b) => {
          const sa = (a.clientWidth || 0) * (a.clientHeight || 0) + (a.readyState || 0) * 1000;
          const sb = (b.clientWidth || 0) * (b.clientHeight || 0) + (b.readyState || 0) * 1000;
          return sb - sa;
        })[0];
        const normalizePlayerSeconds = (raw, fallbackSeconds) => {
          const n = Number(raw);
          const f = Number(fallbackSeconds);
          if (!Number.isFinite(n)) return Number.isFinite(f) ? f : 0;
          if (Number.isFinite(f)) {
            const asSeconds = Math.abs(n - f);
            const asMillis = Math.abs(n / 1000 - f);
            return asMillis < asSeconds ? n / 1000 : n;
          }
          return n > 10000 ? n / 1000 : n;
        };
        let movieId = '';
        try { movieId = String(player.getMovieId?.() || ''); } catch {}
        let playerCurrentTime = Number(video?.currentTime || 0);
        let playerDuration = Number(video?.duration || 0);
        try { playerCurrentTime = normalizePlayerSeconds(player.getCurrentTime?.(), video?.currentTime); } catch {}
        try { playerDuration = normalizePlayerSeconds(player.getDuration?.(), video?.duration); } catch {}
        const watchId = String(location.pathname.match(/^\/watch\/(\d+)/i)?.[1] || '');
        let subtitleUrlHost = '';
        let subtitleUrlProtocol = '';
        try {
          const u = new URL(selectedUrl);
          subtitleUrlHost = u.hostname;
          subtitleUrlProtocol = u.protocol;
        } catch {}

        return {
          ok: true,
          selectedUrl,
          selectedTrackId,
          trackName: track.displayName || track.languageDescription || track.language || track.bcp47 || 'Netflix subtitles',
          trackLanguage: track.bcp47 || track.language || '',
          trackType: track.rawTrackType || '',
          title: cleanNetflixTitle(),
          channelName: 'Netflix',
          description: String(document.querySelector('meta[name="description"]')?.content || '').slice(0, 2200),
          url: location.href,
          currentTime: playerCurrentTime,
          duration: playerDuration,
          movieId,
          watchId,
          subtitleUrlHost,
          subtitleUrlProtocol,
          availableTracks,
          selectedTrackId,
          netflixVisibleTrackId: currentTrackId,
          playerStateDiagnostics: {
            tracks: trackList.length,
            usableTracks: usableTracks.length,
            urls: timedTextUrls().size,
            selectedTrackId,
            netflixVisibleTrackId: currentTrackId,
            temporarilyChangedTrack,
            restoreVerified
          }
        };
      }
    });
    meta = result?.result || { ok: false, reason: 'netflix-player-state-execute-failed' };
  } catch (err) {
    return { ok: false, reason: err?.message || 'netflix-player-state-unavailable', cues: [] };
  }

  if (!meta?.ok || !meta.selectedUrl) {
    return { ...(meta || {}), ok: false, cues: [] };
  }

  let subtitleBody = '';
  let fetchStatus = 0;
  let responseContentType = '';
  let finalUrl = meta.selectedUrl;
  try {
    const response = await fetch(meta.selectedUrl, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'follow',
      credentials: 'omit',
      headers: {
        'Accept': 'application/ttml+xml, application/xml, text/xml, text/vtt, text/plain, */*'
      }
    });
    fetchStatus = response.status;
    finalUrl = response.url || meta.selectedUrl;
    responseContentType = String(response.headers.get('content-type') || '');
    if (!response.ok) {
      let host = meta.subtitleUrlHost || '';
      try { host = new URL(finalUrl).hostname || host; } catch {}
      return {
        ok: false,
        reason: `netflix-subtitle-extension-http-${response.status}:host=${host || 'unknown'}`,
        cues: []
      };
    }
    subtitleBody = await response.text();
  } catch (err) {
    return {
      ok: false,
      reason: `netflix-subtitle-extension-fetch-failed:${String(err?.message || err || 'unknown')}:host=${meta.subtitleUrlHost || 'unknown'}:protocol=${meta.subtitleUrlProtocol || 'unknown'}`,
      cues: []
    };
  }

  if (!subtitleBody) {
    return {
      ok: false,
      reason: `netflix-subtitle-extension-empty:http=${fetchStatus}:host=${meta.subtitleUrlHost || 'unknown'}`,
      cues: []
    };
  }

  try {
    const [parsed] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      args: [subtitleBody, meta, responseContentType, finalUrl],
      func: (body, meta, responseContentType, finalUrl) => {
        const normalize = (text) => String(text || '')
          .replace(/[\u200b-\u200d\ufeff]/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        const decodeEntities = (text) => {
          try {
            const el = document.createElement('textarea');
            el.innerHTML = String(text || '');
            return el.value;
          } catch { return String(text || ''); }
        };
        const parseClock = (stamp) => {
          const parts = String(stamp || '').trim().replace(',', '.').split(':').map(Number);
          if (parts.some(x => !Number.isFinite(x))) return NaN;
          if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
          if (parts.length === 2) return parts[0] * 60 + parts[1];
          return NaN;
        };
        const parseVtt = (text) => {
          const src = String(text || '').replace(/^\uFEFF/, '').replace(/\r/g, '');
          if (!/WEBVTT/i.test(src) && !src.includes('-->')) return [];
          const blocks = src.split(/\n{2,}/);
          const cues = [];
          for (const block of blocks) {
            const lines = block.split('\n').map(x => x.trimEnd()).filter(Boolean);
            const ti = lines.findIndex(line => line.includes('-->'));
            if (ti < 0) continue;
            const match = lines[ti].match(/([^\s]+)\s*-->\s*([^\s]+)/);
            if (!match) continue;
            const start = parseClock(match[1]);
            const end = parseClock(match[2]);
            if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
            let cueText = lines.slice(ti + 1).join(' ')
              .replace(/<br\s*\/?\s*>/gi, ' ')
              .replace(/<[^>]+>/g, ' ');
            cueText = normalize(decodeEntities(cueText));
            if (!cueText) continue;
            cues.push({ start, end, text: cueText });
          }
          return cues;
        };
        const attrByLocalName = (el, localName) => {
          if (!el?.attributes) return '';
          for (const attr of el.attributes) {
            if (attr.localName === localName || String(attr.name || '').split(':').pop() === localName) return attr.value;
          }
          return '';
        };
        const parseTtml = (text) => {
          try {
            const doc = new DOMParser().parseFromString(String(text || ''), 'application/xml');
            if (doc.querySelector('parsererror')) return [];
            const root = doc.documentElement;
            const tickRateAttr = attrByLocalName(root, 'tickRate');
            const tickRate = Number(tickRateAttr) || undefined;
            let frameRate = Number(attrByLocalName(root, 'frameRate')) || 30;
            const multiplier = String(attrByLocalName(root, 'frameRateMultiplier') || '').trim().split(/\s+/).map(Number);
            if (multiplier.length === 2 && multiplier.every(Number.isFinite) && multiplier[1] !== 0) {
              frameRate *= multiplier[0] / multiplier[1];
            }
            const parseTtmlTime = (value) => {
              const s = String(value || '').trim();
              if (!s) return NaN;
              if (/^\d+(?:\.\d+)?ms$/i.test(s)) return parseFloat(s) / 1000;
              if (/^\d+(?:\.\d+)?s$/i.test(s)) return parseFloat(s);
              if (/^\d+(?:\.\d+)?m$/i.test(s)) return parseFloat(s) * 60;
              if (/^\d+(?:\.\d+)?h$/i.test(s)) return parseFloat(s) * 3600;
              if (/^\d+(?:\.\d+)?t$/i.test(s)) return tickRate && tickRate > 0 ? parseFloat(s) / tickRate : NaN;
              if (/^\d+(?:\.\d+)?f$/i.test(s)) return parseFloat(s) / frameRate;
              const frameClock = s.match(/^(\d+):(\d{2}):(\d{2}):(\d+(?:\.\d+)?)$/);
              if (frameClock) return Number(frameClock[1]) * 3600 + Number(frameClock[2]) * 60 + Number(frameClock[3]) + Number(frameClock[4]) / frameRate;
              const clock = parseClock(s);
              if (Number.isFinite(clock)) return clock;
              const plain = Number(s);
              return Number.isFinite(plain) ? plain : NaN;
            };
            const nodeText = (node) => {
              let out = '';
              for (const child of node.childNodes || []) {
                if (child.nodeType === Node.TEXT_NODE) out += child.nodeValue || '';
                else if (child.nodeType === Node.ELEMENT_NODE) {
                  const name = String(child.localName || child.nodeName || '').toLowerCase();
                  if (name === 'br') out += ' ';
                  else out += nodeText(child);
                }
              }
              return out;
            };
            const ps = [...doc.getElementsByTagNameNS('*', 'p')];
            const raw = [];
            for (const p of ps) {
              const start = parseTtmlTime(p.getAttribute('begin'));
              const endAttr = p.getAttribute('end');
              const durAttr = p.getAttribute('dur');
              const dur = durAttr ? parseTtmlTime(durAttr) : NaN;
              const end = endAttr ? parseTtmlTime(endAttr) : (Number.isFinite(dur) ? start + dur : NaN);
              if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
              const cueText = normalize(decodeEntities(nodeText(p)));
              if (!cueText) continue;
              raw.push({ start, end, text: cueText });
            }
            return raw.sort((a, b) => a.start - b.start);
          } catch { return []; }
        };
        const normalizeCues = (raw) => {
          const sorted = (Array.isArray(raw) ? raw : [])
            .filter(c => c?.text && Number.isFinite(Number(c.start)) && Number.isFinite(Number(c.end)))
            .map(c => ({ start: Number(c.start), end: Number(c.end), text: normalize(c.text) }))
            .filter(c => c.text && c.end > c.start)
            .sort((a, b) => a.start - b.start || a.end - b.end);
          const merged = [];
          for (const cue of sorted) {
            const last = merged[merged.length - 1];
            if (last && last.text === cue.text && cue.start <= last.end + 0.08) last.end = Math.max(last.end, cue.end);
            else merged.push({ ...cue });
          }
          return merged;
        };

        const looksVtt = /WEBVTT/i.test(String(body).slice(0, 400)) || String(body).includes('-->');
        const selectedFormat = looksVtt ? 'webvtt' : 'imsc1.1';
        const rawCues = normalizeCues(looksVtt ? parseVtt(body) : parseTtml(body));
        if (!rawCues.length) {
          return {
            ok: false,
            reason: `netflix-subtitle-parse-empty:format=${selectedFormat}:bytes=${String(body).length}:contentType=${String(responseContentType || 'unknown')}:track=${meta.selectedTrackId || 'none'}`,
            cues: []
          };
        }

        let globalIndex = 0;
        const cues = rawCues.map((cue, cueIndex) => {
          const tokens = normalize(cue.text).split(/\s+/).filter(Boolean);
          const weights = tokens.map(t => Math.max(1, String(t).replace(/[^\p{L}\p{N}]/gu, '').length || 1));
          const total = weights.reduce((a, b) => a + b, 0) || tokens.length || 1;
          let acc = 0;
          const finalWords = [];
          for (let i = 0; i < tokens.length; i++) {
            const ws = cue.start + (cue.end - cue.start) * (acc / total);
            acc += weights[i];
            const we = cue.start + (cue.end - cue.start) * (acc / total);
            finalWords.push({
              globalIndex: globalIndex++,
              text: tokens[i],
              originalText: tokens[i],
              start: ws,
              end: Math.max(ws + 0.02, we),
              timingSource: 'netflix-player-state-imsc-interpolated'
            });
          }
          return {
            cueIndex,
            id: `${cueIndex}:${Math.round(cue.start * 1000)}`,
            text: cue.text,
            rawText: cue.text,
            start: cue.start,
            end: cue.end,
            words: finalWords
          };
        });

        let finalHost = meta.subtitleUrlHost || '';
        try { finalHost = new URL(finalUrl).hostname || finalHost; } catch {}
        return {
          ok: true,
          platform: 'netflix',
          source: 'netflix-full-track',
          trackName: meta.trackName,
          trackLanguage: meta.trackLanguage,
          trackType: meta.trackType,
          availableTracks: Array.isArray(meta.availableTracks) ? meta.availableTracks : [],
          selectedTrackId: String(meta.selectedTrackId || ''),
          netflixVisibleTrackId: String(meta.netflixVisibleTrackId || ''),
          subtitleFormat: selectedFormat,
          subtitleUrlHost: finalHost,
          title: meta.title,
          channelName: meta.channelName || 'Netflix',
          description: meta.description || '',
          url: meta.url,
          currentTime: Number(meta.currentTime || 0),
          duration: Number(meta.duration || 0),
          movieId: meta.movieId || '',
          watchId: String(meta.watchId || ''),
          playerStateDiagnostics: {
            ...(meta.playerStateDiagnostics || {}),
            fetchContext: 'extension-service-worker',
            fetchStatus: Number(meta.fetchStatus || 200),
            responseContentType: String(responseContentType || ''),
            subtitleBytes: String(body).length
          },
          cues
        };
      }
    });
    const transcript = parsed?.result || { ok: false, reason: 'netflix-subtitle-parse-execute-failed', cues: [] };
    if (transcript?.ok && Array.isArray(transcript.cues) && transcript.cues.length) return transcript;
    return transcript;
  } catch (err) {
    return { ok: false, reason: `netflix-subtitle-parse-execute-failed:${String(err?.message || err || 'unknown')}`, cues: [] };
  }
}

async function getNetflixTranscriptTrack(tabId, preferredTrackId = '') {
  // Netflixは字幕トラックの全件取得のみ。表示DOM字幕へのフォールバックは行わない。
  // Netflix本体に表示している字幕とは別に、拡張機能側の取得字幕を選択できる。
  return await getNetflixFullTranscriptTrack(tabId, preferredTrackId);
}

async function sendFullTranscriptToTab(tabId, options = {}) {
  await ensureSupportedContentScript(tabId);
  const focusCurrent = options.focusCurrent !== false;
  const preserveSelection = options.preserveSelection !== false;
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'TRANSCRIPT_PANEL_LOADING', preserveSelection });
  } catch {}

  const tab = await chrome.tabs.get(tabId);
  const platform = getSupportedPlatform(tab.url);
  const requestVideoId = platform === 'youtube' ? getYouTubeVideoId(tab.url) : '';
  const requestWatchId = platform === 'netflix' ? getNetflixWatchId(tab.url) : '';
  const expectedVideoId = String(options.expectedVideoId || '');
  if (platform === 'youtube' && expectedVideoId && requestVideoId && expectedVideoId !== requestVideoId) {
    throw new Error(`youtube-navigation-changed-before-fetch:${expectedVideoId}->${requestVideoId}`);
  }

  let transcript = platform === 'netflix'
    ? await getNetflixTranscriptTrack(tabId, String(options.netflixTrackId || ''))
    : await getFullTranscriptTrack(tabId, String(options.youtubeTrackId || ''));

  // v8.8: SPA遷移中の古い字幕取得要求が、後から新動画のパネルを上書きしないようにする。
  // executeScript内でもvideoIdを検証しているが、その後の辞書補正・メッセージ送信までの間に
  // 動画が切り替わる競合があり得るため、Background側でも取得直後と送信直前の二重ロックを行う。
  if (platform === 'youtube' && transcript?.ok) {
    const transcriptVideoId = String(transcript.videoId || '');
    if (requestVideoId && transcriptVideoId && transcriptVideoId !== requestVideoId) {
      transcript = { ok: false, platform: 'youtube', videoId: requestVideoId, cues: [], reason: `youtube-transcript-video-mismatch:${transcriptVideoId}->${requestVideoId}` };
    }
  }
  if (platform === 'netflix' && transcript?.ok) {
    const transcriptWatchId = String(transcript.watchId || getNetflixWatchId(transcript.url) || '');
    if (requestWatchId && transcriptWatchId && transcriptWatchId !== requestWatchId) {
      transcript = { ok: false, platform: 'netflix', watchId: requestWatchId, cues: [], reason: `netflix-transcript-watch-mismatch:${transcriptWatchId}->${requestWatchId}` };
    }
  }

  if (platform === 'youtube') {
    const afterFetchTab = await chrome.tabs.get(tabId);
    const afterFetchVideoId = getYouTubeVideoId(afterFetchTab.url);
    if (requestVideoId && afterFetchVideoId && requestVideoId !== afterFetchVideoId) {
      throw new Error(`youtube-navigation-changed-after-fetch:${requestVideoId}->${afterFetchVideoId}`);
    }
  }
  if (platform === 'netflix') {
    const afterFetchTab = await chrome.tabs.get(tabId);
    const afterFetchWatchId = getNetflixWatchId(afterFetchTab.url);
    if (requestWatchId && afterFetchWatchId && requestWatchId !== afterFetchWatchId) {
      throw new Error(`netflix-navigation-changed-after-fetch:${requestWatchId}->${afterFetchWatchId}`);
    }
  }

  if (!transcript?.ok || !Array.isArray(transcript.cues) || !transcript.cues.length) {
    const reason = transcript?.reason || '字幕トラックがありません';
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: 'SHOW_TRANSCRIPT_PANEL',
        transcript: { ...(transcript || {}), ok: false, platform, cues: [] },
        focusCurrent,
        preserveSelection
      });
    } catch {}
    // Netflix has no DOM-caption fallback. Keep the diagnostic visible instead of
    // silently treating a missing manifest as success. The content script will retry
    // automatically when/if the manifest arrives.
    throw new Error(reason === 'no-caption-track' ? 'この動画に取得可能な字幕がありません' : `字幕取得失敗: ${reason}`);
  }

  // 動画を開いた時点ではAIを一切使わない。
  // 既に確定しているユーザー辞書と、安全なHOLO標準辞書の完全一致補正だけを即時適用する。
  transcript = await applyKnownDictionaryCorrectionsToTranscript(transcript);
  transcript.platform = platform;
  transcript.aiReviewStatus = 'dictionary-only';
  transcript.aiSuspectCount = 0;
  transcript.aiCorrectionCount = 0;

  if (platform === 'youtube') {
    const latestTab = await chrome.tabs.get(tabId);
    const latestVideoId = getYouTubeVideoId(latestTab.url);
    const transcriptVideoId = String(transcript.videoId || '');
    if ((requestVideoId && latestVideoId && requestVideoId !== latestVideoId)
        || (transcriptVideoId && latestVideoId && transcriptVideoId !== latestVideoId)) {
      // 古い要求の結果は表示しない。content側の新しいnavigation refreshに任せる。
      throw new Error(`youtube-navigation-changed-before-display:${requestVideoId || transcriptVideoId || 'none'}->${latestVideoId || 'none'}`);
    }
  }
  if (platform === 'netflix') {
    const latestTab = await chrome.tabs.get(tabId);
    const latestWatchId = getNetflixWatchId(latestTab.url);
    const transcriptWatchId = String(transcript.watchId || getNetflixWatchId(transcript.url) || '');
    if ((requestWatchId && latestWatchId && requestWatchId !== latestWatchId)
        || (transcriptWatchId && latestWatchId && transcriptWatchId !== latestWatchId)) {
      throw new Error(`netflix-navigation-changed-before-display:${requestWatchId || transcriptWatchId || 'none'}->${latestWatchId || 'none'}`);
    }
  }

  await chrome.tabs.sendMessage(tabId, {
    type: 'SHOW_TRANSCRIPT_PANEL',
    transcript,
    focusCurrent,
    preserveSelection
  });

  return { ok: true, cueCount: transcript.cues.length, language: transcript.trackLanguage, isLive: !!transcript.isLive };
}

async function getFullTranscriptTrack(tabId, preferredTrackId = '') {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [String(preferredTrackId || '')],
    func: async (preferredTrackId) => {
      const normalize = (x) => String(x || '')
        .replace(/\u200b/g, '')
        .replace(/\n+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const key = (x) => normalize(x)
        .toLowerCase()
        .replace(/[“”"'’]/g, '')
        .replace(/[^\p{L}\p{N}\s]/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
      const wordCount = (x) => normalize(String(x || '').replace(/\[[^\]]{1,80}\]/g, ' '))
        .split(/\s+/).filter(Boolean).length;

      const video = document.querySelector('video');
      const now = Number(video?.currentTime || 0);
      const currentId = new URL(location.href).searchParams.get('v');
      const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

      // v8.5: YouTubeはSPA遷移するため、前動画のplayer responseがしばらく残る。
      // currentIdが分かっている場合、別videoIdのresponseへは絶対にフォールバックしない。
      // 字幕が未提供の動画でも、前動画の字幕を誤表示するより「字幕なし」と判定する方を優先する。
      let pr = null;
      let fallbackPr = null;
      let lastSeenVideoIds = [];
      for (let attempt = 0; attempt < 12; attempt++) {
        const responses = [];
        try {
          const p = document.getElementById('movie_player');
          if (typeof p?.getPlayerResponse === 'function') responses.push(p.getPlayerResponse());
        } catch {}
        try { if (window.ytInitialPlayerResponse) responses.push(window.ytInitialPlayerResponse); } catch {}
        try {
          const raw = window.ytplayer?.config?.args?.player_response;
          if (raw) responses.push(typeof raw === 'string' ? JSON.parse(raw) : raw);
        } catch {}

        lastSeenVideoIds = [...new Set(responses.map(r => String(r?.videoDetails?.videoId || '')).filter(Boolean))];
        if (currentId) {
          const exact = responses.find(r => String(r?.videoDetails?.videoId || '') === String(currentId));
          if (exact) { pr = exact; break; }
        } else {
          const anyWithTracks = responses.find(r => r?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length);
          if (anyWithTracks) { fallbackPr = anyWithTracks; break; }
        }
        if (attempt < 11) await sleep(250);
      }
      if (!pr && !currentId) pr = fallbackPr;
      if (!pr && currentId) {
        return {
          ok: false,
          reason: `youtube-player-response-not-current:current=${currentId}:seen=${lastSeenVideoIds.join(',') || 'none'}`,
          videoId: currentId,
          cues: []
        };
      }

      const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      const trackLabel = (t) => String(t?.name?.simpleText || t?.name?.runs?.map(r => r?.text || '').join('') || t?.languageCode || '字幕');
      const trackId = (t, index = 0) => String(t?.vssId || `${t?.languageCode || 'und'}|${t?.kind || 'manual'}|${trackLabel(t)}|${index}`);
      const availableTracks = tracks
        .map((t, index) => ({
          trackId: trackId(t, index),
          languageCode: String(t?.languageCode || ''),
          label: trackLabel(t),
          kind: String(t?.kind || 'manual'),
          isAutoGenerated: String(t?.kind || '') === 'asr',
          isTranslatable: t?.isTranslatable !== false
        }))
        .filter(t => t.trackId);

      // YouTube本体に表示している字幕とは独立して、拡張機能側の取得字幕を選ぶ。
      // 明示選択がある場合は、そのトラック以外へフォールバックしない。
      const requestedTrackId = String(preferredTrackId || '');
      const requestedIndex = requestedTrackId
        ? tracks.findIndex((t, index) => trackId(t, index) === requestedTrackId)
        : -1;
      const requestedTrack = requestedIndex >= 0 ? tracks[requestedIndex] : null;
      const english = tracks.filter(t => t.languageCode === 'en' || String(t.languageCode || '').startsWith('en'));
      const namedEnglish = tracks.filter(t => trackLabel(t).toLowerCase().includes('english'));
      const candidatePool = requestedTrack
        ? [requestedTrack]
        : (english.length ? english : (namedEnglish.length ? namedEnglish : (tracks.length ? [tracks[0]] : [])));
      const captionUrlMatchesCurrentVideo = (rawUrl) => {
        if (!currentId || !rawUrl) return true;
        try {
          const u = new URL(rawUrl, location.href);
          const v = u.searchParams.get('v') || u.searchParams.get('video_id') || '';
          return !v || String(v) === String(currentId);
        } catch {
          return false;
        }
      };
      const candidates = candidatePool
        .filter((t, i, arr) => t?.baseUrl && arr.indexOf(t) === i && captionUrlMatchesCurrentVideo(t.baseUrl))
        .slice(0, 4);
      const targetTrack = requestedTrack || candidates[0] || null;
      const targetLanguage = String(targetTrack?.languageCode || '');
      const targetKind = String(targetTrack?.kind || '');

      // YouTube timedtext は同じbaseUrlでも動画/字幕種別によって、json3指定時に
      // HTTP 200 + 空本文/JSON以外を返すことがある。json3だけに決め打ちしない。
      // JSON3 -> SRV3/XML -> VTT -> baseUrl既定形式 の順に試し、すべて内部のJSON3風構造へ正規化する。
      const decodeEntities = (text) => {
        const el = document.createElement('textarea');
        el.innerHTML = String(text || '');
        return el.value;
      };
      const parseXmlTimedText = (text) => {
        try {
          const doc = new DOMParser().parseFromString(text, 'text/xml');
          if (doc.querySelector('parsererror')) return null;
          const events = [];
          const textNodes = [...doc.querySelectorAll('text')];
          for (const node of textNodes) {
            const start = Number(node.getAttribute('start'));
            const dur = Number(node.getAttribute('dur'));
            const utf8 = normalize(node.textContent || '');
            if (!Number.isFinite(start) || !utf8) continue;
            events.push({
              tStartMs: Math.round(start * 1000),
              dDurationMs: Math.max(120, Math.round((Number.isFinite(dur) ? dur : 2.2) * 1000)),
              segs: [{ utf8 }]
            });
          }
          if (events.length) return { events, _sourceFormat: 'xml-text' };

          const pNodes = [...doc.querySelectorAll('p')];
          for (const node of pNodes) {
            const t = Number(node.getAttribute('t'));
            const d = Number(node.getAttribute('d'));
            if (!Number.isFinite(t)) continue;
            const sNodes = [...node.querySelectorAll(':scope > s')];
            let segs = [];
            if (sNodes.length) {
              segs = sNodes.map(sn => {
                const st = Number(sn.getAttribute('t'));
                const utf8 = String(sn.textContent || '');
                const seg = { utf8 };
                if (Number.isFinite(st)) seg.tOffsetMs = st;
                return seg;
              }).filter(seg => normalize(seg.utf8));
            } else {
              const utf8 = normalize(node.textContent || '');
              if (utf8) segs = [{ utf8 }];
            }
            if (!segs.length) continue;
            events.push({
              tStartMs: t,
              dDurationMs: Math.max(120, Number.isFinite(d) ? d : 2200),
              segs
            });
          }
          return events.length ? { events, _sourceFormat: 'srv3' } : null;
        } catch {
          return null;
        }
      };
      const parseVttTime = (stamp) => {
        const parts = String(stamp || '').trim().split(':').map(Number);
        if (parts.some(x => !Number.isFinite(x))) return NaN;
        if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
        if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
        return NaN;
      };
      const parseVttTimedText = (text) => {
        const src = String(text || '').replace(/^\uFEFF/, '');
        if (!/^WEBVTT/i.test(src.trimStart())) return null;
        const blocks = src.replace(/\r/g, '').split(/\n{2,}/);
        const events = [];
        for (const block of blocks) {
          const lines = block.split('\n').map(x => x.trimEnd()).filter(Boolean);
          const ti = lines.findIndex(line => line.includes('-->'));
          if (ti < 0) continue;
          const m = lines[ti].match(/([^\s]+)\s+-->\s+([^\s]+)/);
          if (!m) continue;
          const startMs = parseVttTime(m[1]);
          const endMs = parseVttTime(m[2]);
          if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
          let body = lines.slice(ti + 1).join(' ')
            .replace(/<c(?:\.[^>]*)?>|<\/c>/gi, '')
            .replace(/<v[^>]*>|<\/v>/gi, '')
            .replace(/<[^>]+>/g, ' ');
          body = normalize(decodeEntities(body));
          if (!body) continue;
          events.push({
            tStartMs: startMs,
            dDurationMs: Math.max(120, endMs - startMs),
            segs: [{ utf8: body }]
          });
        }
        return events.length ? { events, _sourceFormat: 'vtt' } : null;
      };
      const parseTimedTextBody = (body, contentType = '') => {
        let text = String(body || '').replace(/^\uFEFF/, '').trim();
        if (!text) return null;
        if (text.startsWith(")]}'")) {
          const nl = text.indexOf('\n');
          text = nl >= 0 ? text.slice(nl + 1).trim() : '';
        }
        if (!text) return null;
        if (text.startsWith('{') || String(contentType).includes('json')) {
          try {
            const obj = JSON.parse(text);
            if (Array.isArray(obj?.events)) {
              obj._sourceFormat = 'json3';
              return obj;
            }
          } catch {}
        }
        if (text.startsWith('<')) {
          const xml = parseXmlTimedText(text);
          if (xml) return xml;
        }
        if (/^WEBVTT/i.test(text)) {
          const vtt = parseVttTimedText(text);
          if (vtt) return vtt;
        }
        return null;
      };
      // v2.4: YouTube自身が実際に取得した字幕レスポンスを最優先で利用する。
      // 近年のYouTubeは字幕URLにPO Token(pot)を要求する場合があり、player responseの
      // baseUrlをそのまま再fetchするとHTTP 200でも本文0 bytesになることがある。
      // page-hook.jsがdocument_startからfetch/XHRを監視し、実際のURLとresponse cloneを保存している。
      const getCapturedTimedText = () => {
        try {
          const list = Array.isArray(window.__ANKI_YT_TIMEDTEXT_CACHE__)
            ? window.__ANKI_YT_TIMEDTEXT_CACHE__.slice()
            : [];
          return list.filter(x => x?.url).sort((a, b) => Number(b.time || 0) - Number(a.time || 0));
        } catch {
          return [];
        }
      };
      const scoreTimedTextUrl = (rawUrl) => {
        try {
          const u = new URL(rawUrl, location.href);
          let score = 0;
          const v = u.searchParams.get('v') || u.searchParams.get('video_id') || '';
          const lang = u.searchParams.get('lang') || '';
          const fmt = u.searchParams.get('fmt') || '';
          // v8.5: 前動画のtimedtext cacheを絶対に採用しない。
          // 以前はvideoId不一致でも言語一致の加点でscore>0になり、SPA遷移後に
          // 別動画の英語字幕が右パネルへ出ることがあった。
          if (currentId) {
            if (v) {
              if (String(v) !== String(currentId)) return -100000;
              score += 1000;
            } else if (String(rawUrl).includes(String(currentId))) {
              score += 500;
            } else {
              return -100000;
            }
          }
          if (targetTrack) {
            // 画面側の字幕とは独立して、拡張側で選んだ実字幕トラックだけを採用する。
            // YouTube自動翻訳は lang=en&tlang=ja のようになるので、tlang付きキャッシュは除外する。
            if (targetLanguage && lang !== targetLanguage) return -100000;
            const rawKind = u.searchParams.get('kind') || '';
            if (targetKind === 'asr' && rawKind !== 'asr') return -100000;
            if (targetKind !== 'asr' && rawKind === 'asr') return -100000;
            if (u.searchParams.get('tlang')) return -100000;
            score += requestedTrack ? 1200 : 700;
          } else if (lang === 'en' || lang.startsWith('en')) {
            score += 200;
          }
          if (u.searchParams.has('pot')) score += 300;
          if (fmt === 'json3') score += 60;
          else if (fmt === 'srv3') score += 40;
          else if (fmt === 'vtt') score += 20;
          if (u.searchParams.get('kind') === 'asr') score += 5;
          return score;
        } catch {
          return 0;
        }
      };
      const tryCapturedTimedText = async () => {
        // CCをONにした直後は字幕リクエストが数百ms遅れて発生するので短く待つ。
        for (let attempt = 0; attempt < 8; attempt++) {
          const captured = getCapturedTimedText()
            .filter(x => scoreTimedTextUrl(x.url) > 0)
            .sort((a, b) => {
              const ds = scoreTimedTextUrl(b.url) - scoreTimedTextUrl(a.url);
              return ds || Number(b.time || 0) - Number(a.time || 0);
            });

          for (const item of captured.slice(0, 12)) {
            // まずYouTube本体が受け取ったresponse bodyをそのまま解析する。
            const direct = parseTimedTextBody(item.body || '', item.contentType || '');
            if (direct?.events?.length) {
              return {
                data: direct,
                url: item.url,
                format: `captured-${direct._sourceFormat || 'unknown'}`,
                source: item.source || 'page-hook'
              };
            }

            // bodyをcloneできなかった場合でも、実際にYouTubeが使用したpot付きURLを再利用する。
            try {
              const exact = new URL(item.url, location.href);
              const response = await fetch(exact.toString(), { credentials: 'include', cache: 'no-store' });
              const body = await response.text();
              const parsed = parseTimedTextBody(body, response.headers.get('content-type') || '');
              if (response.ok && parsed?.events?.length) {
                return {
                  data: parsed,
                  url: exact.toString(),
                  format: `observed-${parsed._sourceFormat || 'unknown'}`,
                  source: 'observed-url'
                };
              }

              // pot等の認証パラメータは保持したままformatだけ変更して試す。
              for (const fmt of ['json3', 'srv3', 'vtt']) {
                const alt = new URL(exact.toString());
                alt.searchParams.set('fmt', fmt);
                const rr = await fetch(alt.toString(), { credentials: 'include', cache: 'no-store' });
                const bb = await rr.text();
                const pp = parseTimedTextBody(bb, rr.headers.get('content-type') || '');
                if (rr.ok && pp?.events?.length) {
                  return {
                    data: pp,
                    url: alt.toString(),
                    format: `observed-${pp._sourceFormat || fmt}`,
                    source: 'observed-url'
                  };
                }
              }
            } catch {}
          }
          if (attempt < 7) await sleep(300);
        }
        return null;
      };

      const fetchCandidateData = async (candidate) => {
        const formats = ['json3', 'srv3', 'vtt', ''];
        let lastStatus = 0;
        let lastLength = 0;
        const baseUrls = [];
        try {
          const original = new URL(candidate.baseUrl);
          // 画面側で別字幕を表示していても、観測済みPO Tokenだけは選択トラックのURLへ再利用する。
          const observedWithPot = getCapturedTimedText().find(x => {
            try {
              const observedUrl = new URL(x.url, location.href);
              return scoreTimedTextUrl(observedUrl.toString()) > 0 && !!observedUrl.searchParams.get('pot');
            } catch { return false; }
          });
          if (observedWithPot) {
            try {
              const observed = new URL(observedWithPot.url, location.href);
              const pot = observed.searchParams.get('pot');
              if (pot && !original.searchParams.get('pot')) {
                const withPot = new URL(original.toString());
                withPot.searchParams.set('pot', pot);
                baseUrls.push(withPot);
              }
            } catch {}
          }
          baseUrls.push(original);
        } catch {}
        for (const base of baseUrls) {
          for (const fmt of formats) {
            try {
              const cu = new URL(base.toString());
              if (fmt) cu.searchParams.set('fmt', fmt);
              else cu.searchParams.delete('fmt');
              const cr = await fetch(cu.toString(), { credentials: 'include', cache: 'no-store' });
              lastStatus = cr.status;
              const body = await cr.text();
              lastLength = body.length;
              if (!cr.ok) continue;
              const parsed = parseTimedTextBody(body, cr.headers.get('content-type') || '');
              if (parsed?.events?.length) return { data: parsed, status: cr.status, format: parsed._sourceFormat || fmt || 'default' };
            } catch {}
          }
        }
        return { data: null, status: lastStatus, bodyLength: lastLength, format: '' };
      };

      // 単語時刻を細分化するため、まずYouTube自身が使った実字幕レスポンスを優先。
      // それが取れない場合だけplayer responseのbaseUrlを従来方式で試す。
      let bestTrack = null;
      let bestData = null;
      let bestScore = -Infinity;
      let lastHttpStatus = 0;
      let lastBodyLength = 0;
      let bestFormat = '';

      const capturedData = await tryCapturedTimedText();
      if (capturedData?.data?.events?.length) {
        bestData = capturedData.data;
        bestFormat = capturedData.format || 'captured';
        let observedLang = 'en';
        let observedKind = 'captured';
        try {
          const observedUrl = new URL(capturedData.url, location.href);
          observedLang = observedUrl.searchParams.get('lang') || 'en';
          observedKind = observedUrl.searchParams.get('kind') || 'captured';
        } catch {}
        bestTrack = requestedTrack
          || candidates.find(c => c.languageCode === observedLang)
          || candidates[0]
          || { languageCode: observedLang, name: { simpleText: 'YouTube Captions' }, kind: observedKind };
        bestScore = Number.POSITIVE_INFINITY;
      }

      for (const candidate of (bestData ? [] : candidates)) {
        const fetched = await fetchCandidateData(candidate);
        lastHttpStatus = fetched.status || lastHttpStatus;
        lastBodyLength = fetched.bodyLength || lastBodyLength;
        const cd = fetched.data;
        if (!cd) continue;
        const segs = (cd?.events || []).flatMap(ev => Array.isArray(ev?.segs) ? ev.segs : []);
        const visibleSegs = segs.filter(seg => normalize(seg?.utf8));
        const timedSegs = visibleSegs.filter(seg => Number.isFinite(Number(seg?.tOffsetMs))).length;
        const timedRatio = visibleSegs.length ? timedSegs / visibleSegs.length : 0;
        // 細かい時刻を最優先。手動字幕は同点時だけ少し優先。
        const score = timedRatio * 10000 + timedSegs + (candidate.kind === 'asr' ? 0 : 0.25);
        if (score > bestScore) {
          bestScore = score;
          bestTrack = candidate;
          bestData = cd;
          bestFormat = fetched.format || '';
        }
      }
      // timedtextが空本文(HTTP 200 / 0 bytes)になる動画もあるため、
      // YouTube自身の「文字起こし」パネルが使うget_transcript endpointを第二経路として使う。
      // ここでは非公開URLを固定せず、現在のページに埋め込まれたendpoint paramsと
      // ytcfgのINNERTUBE設定をそのまま利用する。
      const findTranscriptParamsInObject = (root) => {
        if (!root || typeof root !== 'object') return '';
        const seen = new WeakSet();
        const stack = [root];
        let visited = 0;
        while (stack.length && visited < 60000) {
          const node = stack.pop();
          if (!node || typeof node !== 'object') continue;
          if (seen.has(node)) continue;
          seen.add(node);
          visited++;
          try {
            const p = node?.getTranscriptEndpoint?.params;
            if (typeof p === 'string' && p) return p;
          } catch {}
          if (Array.isArray(node)) {
            for (let i = node.length - 1; i >= 0; i--) {
              const v = node[i];
              if (v && typeof v === 'object') stack.push(v);
            }
          } else {
            for (const k of Object.keys(node)) {
              let v;
              try { v = node[k]; } catch { continue; }
              if (v && typeof v === 'object') stack.push(v);
            }
          }
        }
        return '';
      };
      const getTranscriptParams = async () => {
        const roots = [];
        try { if (window.ytInitialData) roots.push(window.ytInitialData); } catch {}
        try {
          const flexy = document.querySelector('ytd-watch-flexy');
          if (flexy?.data) roots.push(flexy.data);
        } catch {}
        try {
          const app = document.querySelector('ytd-app');
          if (app?.data) roots.push(app.data);
        } catch {}
        for (const root of roots) {
          const found = findTranscriptParamsInObject(root);
          if (found) return found;
        }

        // SPA状態にendpointが露出していない場合は、同じwatchページHTMLからparamsだけ拾う。
        try {
          const pageResp = await fetch(location.href, { credentials: 'include', cache: 'no-store' });
          const html = await pageResp.text();
          const m = html.match(/"getTranscriptEndpoint"\s*:\s*\{\s*"params"\s*:\s*"((?:\\.|[^"\\])*)"/);
          if (m?.[1]) {
            try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; }
          }
        } catch {}
        return '';
      };
      const collectTranscriptRenderers = (root) => {
        const out = [];
        if (!root || typeof root !== 'object') return out;
        const seen = new WeakSet();
        const stack = [root];
        let visited = 0;
        while (stack.length && visited < 90000) {
          const node = stack.pop();
          if (!node || typeof node !== 'object') continue;
          if (seen.has(node)) continue;
          seen.add(node);
          visited++;
          try {
            if (node.transcriptSegmentRenderer) out.push(node.transcriptSegmentRenderer);
          } catch {}
          if (Array.isArray(node)) {
            for (let i = node.length - 1; i >= 0; i--) {
              const v = node[i];
              if (v && typeof v === 'object') stack.push(v);
            }
          } else {
            for (const k of Object.keys(node)) {
              let v;
              try { v = node[k]; } catch { continue; }
              if (v && typeof v === 'object') stack.push(v);
            }
          }
        }
        return out;
      };
      const fetchTranscriptEndpointData = async () => {
        try {
          const params = await getTranscriptParams();
          if (!params) return null;
          const apiKey = window.ytcfg?.get?.('INNERTUBE_API_KEY') || '';
          const context = window.ytcfg?.get?.('INNERTUBE_CONTEXT') || null;
          if (!apiKey || !context) return null;
          const endpoint = `https://www.youtube.com/youtubei/v1/get_transcript?key=${encodeURIComponent(apiKey)}&prettyPrint=false`;
          const response = await fetch(endpoint, {
            method: 'POST',
            credentials: 'include',
            cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ context, params })
          });
          if (!response.ok) return null;
          const json = await response.json();
          const renderers = collectTranscriptRenderers(json)
            .map(r => ({
              startMs: Number(r?.startMs),
              endMs: Number(r?.endMs),
              text: normalize(r?.snippet?.runs?.map(x => x?.text || '').join('') || r?.snippet?.simpleText || '')
            }))
            .filter(x => Number.isFinite(x.startMs) && x.text)
            .sort((a, b) => a.startMs - b.startMs);
          if (!renderers.length) return null;
          const events = renderers.map((r, i) => {
            const nextStart = Number(renderers[i + 1]?.startMs);
            let endMs = Number.isFinite(r.endMs) && r.endMs > r.startMs ? r.endMs : NaN;
            if (!Number.isFinite(endMs) && Number.isFinite(nextStart) && nextStart > r.startMs) endMs = nextStart;
            if (!Number.isFinite(endMs)) endMs = r.startMs + 2200;
            return {
              tStartMs: r.startMs,
              dDurationMs: Math.max(120, endMs - r.startMs),
              segs: [{ utf8: r.text }]
            };
          });
          return { events, _sourceFormat: 'youtubei-transcript' };
        } catch {
          return null;
        }
      };

      let track = bestTrack;
      let data = bestData;
      if (!data && !requestedTrack) {
        const transcriptData = await fetchTranscriptEndpointData();
        if (transcriptData?.events?.length) {
          data = transcriptData;
          bestFormat = 'youtubei-transcript';
          track = track || {
            languageCode: 'en',
            name: { simpleText: 'YouTube Transcript' },
            kind: 'transcript'
          };
        }
      }
      if (!track || !data) {
        const noTrack = !tracks.length;
        return {
          ok: false,
          reason: requestedTrack
            ? `selected-youtube-caption-track-unavailable:${requestedTrackId}:${lastHttpStatus || 'failed'}:${lastBodyLength || 0}bytes`
            : (noTrack
              ? 'caption-metadata-and-transcript-endpoint-unavailable'
              : `timedtext-empty-and-transcript-fallback-failed-${lastHttpStatus || 'failed'}-${lastBodyLength || 0}bytes`),
          availableTracks,
          selectedTrackId: requestedTrack ? requestedTrackId : '',
          cues: []
        };
      }

      // v2.1: YouTube timedtext の seg.tOffsetMs がある場合は、それを単語時刻の最優先ソースにする。
      // tOffsetMs がない字幕は、event/segment の時間幅の中で単語長に応じて補間する。
      // 文章への再構成後も各単語の元タイムコードを保持し、ユーザーが単語範囲を選べるようにする。
      const tokenizeWords = (text) => normalize(text).split(/\s+/).filter(Boolean);
      const tokenKey = (text) => String(text || '').toLowerCase()
        .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
        .replace(/[’]/g, "'");
      const distributeWords = (text, start, end, timingSource, rawIndex) => {
        const tokens = tokenizeWords(text);
        if (!tokens.length) return [];
        const safeStart = Math.max(0, Number(start) || 0);
        const safeEnd = Math.max(safeStart + 0.02, Number(end) || safeStart + 0.02);
        const weights = tokens.map(token => {
          const core = String(token || '').replace(/[^\p{L}\p{N}]/gu, '');
          return Math.max(1, core.length || 1);
        });
        const total = weights.reduce((a, b) => a + b, 0) || tokens.length;
        let acc = 0;
        return tokens.map((token, index) => {
          const ws = acc / total;
          acc += weights[index];
          const we = acc / total;
          return {
            text: token,
            start: safeStart + (safeEnd - safeStart) * ws,
            end: safeStart + (safeEnd - safeStart) * we,
            timingSource,
            rawIndex
          };
        });
      };
      const buildEventWords = (ev, rawIndex, start, end) => {
        const segs = (ev?.segs || []).map((seg, segIndex) => ({
          text: String(seg?.utf8 || ''),
          offsetMs: Number(seg?.tOffsetMs),
          segIndex
        })).filter(seg => normalize(seg.text) && normalize(seg.text) !== '\\n');
        if (!segs.length) return [];

        const hasTimedSegment = segs.some(seg => Number.isFinite(seg.offsetMs));
        if (!hasTimedSegment) {
          return distributeWords(segs.map(seg => seg.text).join(''), start, end, 'cue-interpolated', rawIndex);
        }

        // 同じ offset のsegや、offsetを持たない補助segを一つの時間グループへまとめる。
        const groups = [];
        let group = null;
        for (const seg of segs) {
          const hasOffset = Number.isFinite(seg.offsetMs);
          const segStart = hasOffset ? start + Math.max(0, seg.offsetMs) / 1000 : null;
          if (hasOffset && (!group || Math.abs(segStart - group.start) > 0.001)) {
            if (group) groups.push(group);
            group = { start: segStart, texts: [seg.text], exactStart: true };
          } else if (group) {
            group.texts.push(seg.text);
          } else {
            // 最初のtOffsetMsより前にuntimed segが来る例への保険。
            group = { start, texts: [seg.text], exactStart: false };
          }
        }
        if (group) groups.push(group);

        const words = [];
        for (let i = 0; i < groups.length; i++) {
          const g = groups[i];
          const nextStart = Number(groups[i + 1]?.start);
          const groupStart = Math.max(start, Number(g.start) || start);
          const groupEnd = Number.isFinite(nextStart) && nextStart > groupStart
            ? Math.min(end, nextStart)
            : end;
          const text = normalize(g.texts.join(''));
          const tokens = tokenizeWords(text);
          const source = g.exactStart
            ? (tokens.length === 1 ? 'youtube-segment' : 'segment-interpolated')
            : 'cue-interpolated';
          words.push(...distributeWords(text, groupStart, Math.max(groupStart + 0.02, groupEnd), source, rawIndex));
        }
        return words;
      };
      const mergeWordSequences = (leftWords, rightWords) => {
        const left = Array.isArray(leftWords) ? leftWords : [];
        const right = Array.isArray(rightWords) ? rightWords : [];
        if (!left.length) return right.map(w => ({ ...w }));
        if (!right.length) return left.map(w => ({ ...w }));
        const max = Math.min(20, left.length, right.length);
        let overlap = 0;
        for (let n = max; n >= 2; n--) {
          const a = left.slice(-n).map(w => tokenKey(w.text)).join(' ');
          const b = right.slice(0, n).map(w => tokenKey(w.text)).join(' ');
          if (a && a === b) { overlap = n; break; }
        }
        return [...left.map(w => ({ ...w })), ...right.slice(overlap).map(w => ({ ...w }))];
      };

      let cues = (data?.events || [])
        .filter(ev => Array.isArray(ev?.segs) && ev.tStartMs !== undefined)
        .map((ev, rawIndex) => {
          const start = Number(ev.tStartMs) / 1000;
          const duration = Math.max(0.12, Number(ev.dDurationMs || 2200) / 1000);
          const end = start + duration;
          const text = normalize(ev.segs.map(s => s?.utf8 || '').join(''));
          const words = buildEventWords(ev, rawIndex, start, end);
          return { start, end, text, rawIndex, words };
        })
        .filter(c => c.text && c.text !== '\\n');

      // 隣接する完全重複だけ除去。異なるテキストは「別の字幕行」として残す。
      // これにより真ん中の字幕が推測処理で消える問題を避ける。
      const deduped = [];
      for (const cue of cues) {
        const last = deduped[deduped.length - 1];
        if (last && key(last.text) && key(last.text) === key(cue.text)
            && Math.abs(cue.start - last.start) < 0.35) {
          last.end = Math.max(last.end, cue.end);
          last.words = mergeWordSequences(last.words, cue.words);
          continue;
        }
        deduped.push({ ...cue });
      }
      cues = deduped;

      // v1.3: YouTubeの「字幕行」をそのまま見せず、読み込み時に文章へ再構成する。
      // 句読点がある場合は最優先。句読点がない自動字幕では、時間差・文頭らしい語・長さを補助にする。
      // これにより、1文が複数のYouTube字幕eventへ分割されていても、パネル上では原則1文1行になる。
      const endsSentence = (text) => /[.!?…]+["'”’）)\]]*$/.test(normalize(text));
      const isNonSpeechOnly = (text) => /^\s*\[[^\]]{1,100}\]\s*$/.test(String(text || ''));
      const firstWord = (text) => (normalize(text).match(/^["'“‘(\[]*([A-Za-z]+(?:'[A-Za-z]+)?)/)?.[1] || '').toLowerCase();
      const continuationWords = new Set([
        'and','but','or','because','that','which','who','whom','whose','if','then','than','as',
        'to','of','in','on','at','for','with','from','by','into','onto','about','after','before',
        'is','are','am','was','were','be','been','being','have','has','had','do','does','did',
        'can','could','will','would','should','may','might','must','not','just','also','even'
      ]);
      const likelySentenceStarters = new Set([
        'i','you','he','she','we','they','it','this','these','those','there','what','why','how','when',
        'where','who','okay','ok','yeah','yes','no','well','so','such','anyway','actually','honestly'
      ]);
      const hangingEndWords = new Set([
        'a','an','the','to','of','in','on','at','for','with','from','by','into','onto','about','and','or','but',
        'because','that','which','who','whom','whose','if','than','as','my','your','his','her','our','their',
        'is','are','am','was','were','be','been','being','have','has','had','do','does','did','can','could',
        'will','would','should','may','might','must'
      ]);
      const mergeNoOverlap = (a, b) => {
        a = normalize(a); b = normalize(b);
        if (!a) return b;
        if (!b) return a;
        if (key(a) === key(b)) return b.length >= a.length ? b : a;
        const aw = a.split(/\s+/), bw = b.split(/\s+/);
        const normWord = (w) => String(w || '').toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
        const max = Math.min(16, aw.length, bw.length);
        for (let n = max; n >= 2; n--) {
          const left = aw.slice(-n).map(normWord).join(' ');
          const right = bw.slice(0, n).map(normWord).join(' ');
          if (left && left === right) return normalize([...aw, ...bw.slice(n)].join(' '));
        }
        return normalize(`${a} ${b}`);
      };
      const splitCue = (cue) => {
        const text = normalize(cue.text);
        if (!text) return [];
        let parts = [];
        try {
          if (Intl?.Segmenter) {
            const seg = new Intl.Segmenter('en', { granularity: 'sentence' });
            parts = [...seg.segment(text)].map(x => normalize(x.segment)).filter(Boolean);
          }
        } catch {}
        if (!parts.length) {
          parts = text.match(/[^.!?…]+(?:[.!?…]+["'”’）)\]]*|$)/g)?.map(normalize).filter(Boolean) || [text];
        }
        if (parts.length === 1) return [{ ...cue, text: parts[0], words: (cue.words || []).map(w => ({ ...w })) }];

        const cueWords = Array.isArray(cue.words) ? cue.words : [];
        const counts = parts.map(part => Math.max(1, wordCount(part)));
        const total = counts.reduce((a, b) => a + b, 0);
        const duration = Math.max(0.12, cue.end - cue.start);
        let cursor = cue.start;
        let wordCursor = 0;
        return parts.map((part, i) => {
          const count = counts[i];
          const partWords = cueWords.slice(wordCursor, wordCursor + count).map(w => ({ ...w }));
          wordCursor += count;
          const fallbackSpan = i === parts.length - 1
            ? Math.max(0.08, cue.end - cursor)
            : Math.max(0.08, duration * (count / total));
          const fallbackStart = cursor;
          const fallbackEnd = Math.min(cue.end, cursor + fallbackSpan);
          cursor += fallbackSpan;
          const partStart = partWords.length ? Number(partWords[0].start) : fallbackStart;
          const partEnd = partWords.length ? Number(partWords[partWords.length - 1].end) : fallbackEnd;
          return {
            start: Number.isFinite(partStart) ? partStart : fallbackStart,
            end: Number.isFinite(partEnd) ? partEnd : fallbackEnd,
            text: part,
            rawIndex: cue.rawIndex,
            words: partWords.length ? partWords : distributeWords(part, fallbackStart, fallbackEnd, 'sentence-interpolated', cue.rawIndex)
          };
        });
      };

      const display = [];
      let buffer = null;
      let previousPiece = null;
      const flushBuffer = () => {
        if (!buffer) return;
        const text = normalize(buffer.text);
        if (text && wordCount(text) > 0) display.push({ ...buffer, text });
        buffer = null;
      };

      for (const cue of cues) {
        const pieces = splitCue(cue);
        for (const piece of pieces) {
          // [laughter] 等は学習本文には入れない。ただし発話の途中にあれば音声範囲には含める。
          if (isNonSpeechOnly(piece.text)) {
            if (buffer) buffer.end = Math.max(buffer.end, piece.end);
            previousPiece = piece;
            continue;
          }

          const gap = buffer ? Math.max(0, piece.start - buffer.end) : Infinity;
          const bw = buffer ? wordCount(buffer.text) : 0;
          const bufferDuration = buffer ? Math.max(0, buffer.end - buffer.start) : 0;
          const starter = firstWord(piece.text);
          const startsCapitalized = /^[\s"'“‘(\[]*[A-Z]/.test(String(piece.text || ''));
          const bufferWords = buffer ? normalize(buffer.text).split(/\s+/).filter(Boolean) : [];
          const bufferLast = bufferWords.length
            ? bufferWords[bufferWords.length - 1].toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
            : '';
          const startsNewThought = buffer
            && bw >= 3
            && likelySentenceStarters.has(starter)
            && !continuationWords.has(starter)
            && !hangingEndWords.has(bufferLast)
            && bufferDuration >= 0.8
            // YouTube ASRは文末の無音をほぼ作らないことがある。
            // その場合でも「大文字の主語/疑問語で新cueが始まる」なら新文候補とする。
            && (gap >= 0.35 || startsCapitalized);

          // 明確な時間差は文章の切れ目として扱う。句読点がないASRへのフォールバック。
          if (buffer && ((gap >= 1.45 && bw >= 3) || startsNewThought)) flushBuffer();

          if (!buffer) {
            buffer = {
              start: piece.start,
              end: piece.end,
              text: piece.text,
              rawIndex: piece.rawIndex,
              words: (piece.words || []).map(w => ({ ...w }))
            };
          } else {
            buffer.words = mergeWordSequences(buffer.words, piece.words);
            buffer.text = buffer.words?.length
              ? normalize(buffer.words.map(w => w.text).join(' '))
              : mergeNoOverlap(buffer.text, piece.text);
            buffer.end = Math.max(buffer.end, piece.end);
          }

          const currentWords = wordCount(buffer.text);
          const currentDuration = Math.max(0, buffer.end - buffer.start);
          if (endsSentence(piece.text)) {
            flushBuffer();
          } else if (currentWords >= 32 || (currentWords >= 22 && currentDuration >= 8.5)) {
            // 句読点がまったく来ない自動字幕でも、極端に巨大な1行にはしない。
            flushBuffer();
          }
          previousPiece = piece;
        }
      }
      flushBuffer();

      // 自動字幕の重複eventで同じ文章が隣接して生成された場合だけ最終的に除去。
      const sentenceDisplay = [];
      for (const item of display) {
        const last = sentenceDisplay[sentenceDisplay.length - 1];
        if (last && key(last.text) && key(last.text) === key(item.text)
            && Math.abs(item.start - last.start) < 1.2) {
          last.end = Math.max(last.end, item.end);
          last.words = mergeWordSequences(last.words, item.words);
          last.text = last.words?.length ? normalize(last.words.map(w => w.text).join(' ')) : last.text;
          continue;
        }
        sentenceDisplay.push(item);
      }

      const finalLocationVideoId = new URL(location.href).searchParams.get('v');
      if (currentId && finalLocationVideoId !== currentId) {
        return {
          ok: false,
          reason: `youtube-navigation-changed:${currentId}->${finalLocationVideoId || 'none'}`,
          videoId: finalLocationVideoId || '',
          cues: []
        };
      }

      const url = new URL(location.href);
      url.searchParams.set('t', `${Math.max(0, Math.floor(now))}s`);
      return {
        ok: true,
        currentTime: now,
        duration: Number(video?.duration || 0),
        playbackRate: Number(video?.playbackRate || 1),
        paused: !!video?.paused,
        title: document.title.replace(/\s*-\s*YouTube\s*$/, ''),
        channelName: (document.querySelector('ytd-watch-metadata ytd-channel-name a, #owner #channel-name a, #upload-info #channel-name a')?.textContent || '').trim(),
        description: String(pr?.videoDetails?.shortDescription || document.querySelector('meta[name="description"]')?.content || '').slice(0, 2200),
        url: url.toString(),
        videoId: currentId || pr?.videoDetails?.videoId || '',
        isLive: !!pr?.videoDetails?.isLiveContent || !Number.isFinite(Number(video?.duration)),
        availableTracks,
        selectedTrackId: (() => {
          const index = tracks.indexOf(track);
          return index >= 0 ? trackId(track, index) : String(requestedTrackId || '');
        })(),
        trackLanguage: track.languageCode || '',
        trackName: track.name?.simpleText || track.name?.runs?.map(r => r.text).join('') || '',
        trackKind: track.kind || 'manual',
        trackFormat: bestFormat || 'unknown',
        // v2.4: YouTube自身のPO Token付き字幕レスポンスを最優先し、可能な限り細かいタイムコードを付与する。
        // 1) YouTube seg.tOffsetMs がある単語: そのオフセットを使用
        // 2) 同一segment内に複数語: segment幅の中で補間
        // 3) segment時刻がない字幕: cue幅の中で補間
        // 最後の単語の終了は、字幕自身の終了と次文章開始の早い方で上限を切る。
        cues: (() => {
          let globalWordIndex = 0;
          return sentenceDisplay.map((c, index) => {
            const rawStart = Math.max(0, Number(c.start));
            const nextStart = Number(sentenceDisplay[index + 1]?.start);
            const rawSourceEnd = Number(c.end);
            const hasSourceEnd = Number.isFinite(rawSourceEnd) && rawSourceEnd > rawStart + 0.01;
            const sourceEnd = hasSourceEnd ? rawSourceEnd : Number.POSITIVE_INFINITY;
            const cappedNextStart = Number.isFinite(nextStart) && nextStart >= rawStart
              ? nextStart
              : Number.POSITIVE_INFINITY;
            let cueEnd = Math.min(sourceEnd, cappedNextStart);
            if (!Number.isFinite(cueEnd)) cueEnd = hasSourceEnd ? rawSourceEnd : rawStart + 0.12;
            cueEnd = Math.max(rawStart + 0.02, cueEnd);

            let words = Array.isArray(c.words) && c.words.length
              ? c.words.map(w => ({ ...w }))
              : distributeWords(c.text, rawStart, cueEnd, 'sentence-interpolated', c.rawIndex);
            if (!words.length) words = distributeWords(c.text, rawStart, cueEnd, 'sentence-interpolated', c.rawIndex);

            // 各単語の終了を「次単語の開始」で上限化し、最後だけcueEndで止める。
            words = words.map((word, wi) => {
              const nextWordStart = Number(words[wi + 1]?.start);
              let ws = Math.max(rawStart, Number(word.start) || rawStart);
              let we = Number(word.end);
              if (!Number.isFinite(we)) we = Number.isFinite(nextWordStart) ? nextWordStart : cueEnd;
              if (Number.isFinite(nextWordStart) && nextWordStart >= ws) we = Math.min(we, nextWordStart);
              we = Math.min(cueEnd, Math.max(ws + 0.015, we));
              const globalIndex = globalWordIndex++;
              return {
                globalIndex,
                text: normalize(word.text),
                start: ws,
                end: we,
                timingSource: word.timingSource || 'sentence-interpolated'
              };
            }).filter(w => w.text);

            const start = words.length ? words[0].start : rawStart;
            const end = words.length ? words[words.length - 1].end : cueEnd;
            return {
              id: `${index}:${Math.round(start * 1000)}`,
              start,
              end,
              text: normalize(c.text),
              words
            };
          });
        })()
      };
    }
  });
  const transcript = result?.result || { ok: false, reason: 'execute-failed', cues: [] };
  if (!transcript?.ok || !Array.isArray(transcript.cues) || !transcript.cues.length) return transcript;

  // タイムコード付きの生字幕をそのまま保持する。
  // 動画を開く段階では辞書補正以外のAI処理を行わず、Gemini校閲はAnki保存時の選択範囲だけに限定する。
  return transcript;
}

async function getCurrentVideoState(tabId) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const video = document.querySelector('video');
        const host = location.hostname.toLowerCase();
        const isNetflix = host === 'netflix.com' || host.endsWith('.netflix.com');
        let pr = null;
        if (!isNetflix) {
          try {
            const player = document.getElementById('movie_player');
            pr = player?.getPlayerResponse?.() || window.ytInitialPlayerResponse || null;
          } catch {}
        }
        let title = '';
        let channelName = '';
        let description = '';
        let videoId = '';
        if (isNetflix) {
          title = String(document.title || '')
            .replace(/^Watch\s+/i, '')
            .replace(/\s*[|–—-]\s*Netflix\s*$/i, '')
            .trim();
          channelName = 'Netflix';
          description = String(document.querySelector('meta[name="description"]')?.content || '').slice(0, 2200);
          videoId = location.pathname.split('/').filter(Boolean).pop() || '';
        } else {
          title = String(pr?.videoDetails?.title || document.title || '').replace(/\s*-\s*YouTube\s*$/i, '');
          channelName = String(pr?.videoDetails?.author || document.querySelector('ytd-watch-metadata ytd-channel-name a, #owner #channel-name a')?.textContent || '').trim();
          description = String(pr?.videoDetails?.shortDescription || document.querySelector('meta[name="description"]')?.content || '').slice(0, 2200);
          videoId = String(pr?.videoDetails?.videoId || new URL(location.href).searchParams.get('v') || '');
        }
        let currentTime = Number(video?.currentTime || 0);
        let duration = Number(video?.duration || 0);
        let playbackRate = Number(video?.playbackRate || 1);
        let paused = !!video?.paused;
        if (isNetflix) {
          try {
            const videoPlayer = globalThis.netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer;
            const sessionIds = videoPlayer?.getAllPlayerSessionIds?.() || [];
            const player = sessionIds.length ? videoPlayer.getVideoPlayerBySessionId?.(sessionIds[sessionIds.length - 1]) : undefined;
            const normalizeSeconds = (raw, fallback) => {
              const n = Number(raw), f = Number(fallback);
              if (!Number.isFinite(n)) return Number.isFinite(f) ? f : 0;
              if (Number.isFinite(f)) return Math.abs(n / 1000 - f) < Math.abs(n - f) ? n / 1000 : n;
              return n > 10000 ? n / 1000 : n;
            };
            currentTime = normalizeSeconds(player?.getCurrentTime?.(), currentTime);
            duration = normalizeSeconds(player?.getDuration?.(), duration);
            try {
              const r = Number(player?.getPlaybackRate?.());
              if (Number.isFinite(r) && r > 0) playbackRate = r;
            } catch {}
            try {
              const p = player?.isPaused?.();
              if (typeof p === 'boolean') paused = p;
            } catch {}
          } catch {}
        }
        return {
          currentTime, duration, playbackRate, paused,
          title, channelName, description, url: location.href, videoId,
          platform: isNetflix ? 'netflix' : 'youtube'
        };
      }
    });
    return result?.result || {};
  } catch (err) {
    console.warn('getCurrentVideoState failed', err);
    return {};
  }
}

function getNetflixWatchId(url) {
  try {
    const u = new URL(String(url || ''));
    if (!/(^|\.)netflix\.com$/i.test(u.hostname)) return '';
    return String(u.pathname.match(/^\/watch\/(\d+)/i)?.[1] || '');
  } catch {
    return '';
  }
}

function getYouTubeVideoId(url) {
  try {
    const u = new URL(String(url || ''));
    if (!/^(?:www\.)?youtube\.com$/i.test(u.hostname)) return '';
    return String(u.searchParams.get('v') || '');
  } catch { return ''; }
}

async function assertTranscriptVideoMatchesCurrentTab(tabId, transcriptVideoId = '') {
  const expected = String(transcriptVideoId || '');
  if (!expected) return '';
  const tab = await chrome.tabs.get(tabId);
  if (getSupportedPlatform(tab.url) !== 'youtube') return '';
  const current = getYouTubeVideoId(tab.url);
  if (current && current !== expected) {
    throw new Error('動画が切り替わったため、この字幕は保存できません。現在の動画の字幕を再取得してください');
  }
  return current;
}

async function saveTranscriptSelection(cues, senderTabId, transcriptVideoId = '') {
  const tabId = await getRecordingTabId();
  if (!tabId) throw new Error('先に「録音＋字幕パネル開始」を押してください');
  if (!senderTabId || senderTabId !== tabId) throw new Error('録音中の動画タブから選択してください');
  await assertTranscriptVideoMatchesCurrentTab(tabId, transcriptVideoId);
  if (!Array.isArray(cues) || !cues.length || cues.length > 50) throw new Error('文章を1つ以上選択してください');

  const valid = cues
    .map(c => ({
      text: cleanCaptionText(c?.text || ''),
      start: Number(c?.start),
      end: Number(c?.end)
    }))
    .filter(c => c.text && Number.isFinite(c.start) && Number.isFinite(c.end) && c.start >= 0 && c.end >= c.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  if (!valid.length) throw new Error('選択した字幕を読み取れませんでした');

  const state = await getCurrentVideoState(tabId);
  const sentenceStart = valid[0].start;
  const sentenceEnd = Math.max(...valid.map(c => c.end));
  if (Number.isFinite(state.currentTime) && sentenceEnd > state.currentTime + 1.2) {
    throw new Error('まだ再生していない字幕です。再生後にAnkiへ追加してください');
  }

  const text = joinSelectedTranscriptTexts(valid.map(c => c.text));
  if (!text) throw new Error('選択した字幕に英文がありません');

  const config = await getSettings();
  const bufferSeconds = Math.min(90, Math.max(60,
    Number(config.audioSeconds || 8) + 10, Number(config.captionSeconds || 8) + 35));
  if (Number.isFinite(state.currentTime)
      && state.currentTime - sentenceStart > bufferSeconds - 1) {
    throw new Error(`この字幕は録音バッファ（約${Math.floor(bufferSeconds)}秒）より前です。時刻を押して再生し直してから追加してください`);
  }
  const tab = await chrome.tabs.get(tabId);
  const platform = getSupportedPlatform(tab.url);
  const u = new URL(tab.url || (platform === 'netflix' ? 'https://www.netflix.com/' : 'https://www.youtube.com/'));
  if (platform === 'youtube') u.searchParams.set('t', `${Math.max(0, Math.floor(sentenceStart))}s`);
  const context = {
    text,
    sentenceStart,
    sentenceEnd,
    currentTime: sentenceStart,
    playbackRate: Number(state.playbackRate || 1),
    paused: !!state.paused,
    title: cleanPlatformTitle(state.title || tab.title || '', getSupportedPlatform(tab.url)),
    channelName: String(state.channelName || ''),
    description: String(state.description || ''),
    url: u.toString(),
    videoId: String(transcriptVideoId || (platform === 'youtube' ? getYouTubeVideoId(tab.url) : '')),
    captionSource: 'transcript-panel-selection',
    timingSource: 'youtube-timedtext-track'
  };
  return await finalizeCapture(tabId, config, tab, context);
}


function buildDictionaryRootSourceTextFromSelectedWords(words) {
  const list = Array.isArray(words) ? words : [];
  if (!list.length) return '';
  const out = [];
  const normalized = (x) => normalizeCorrectionText(cleanCaptionText(x || ''));

  for (let i = 0; i < list.length;) {
    const w = list[i] || {};
    const layer = String(w.dictionaryLayer || '');
    const original = cleanCaptionText(w.originalText || '');
    const note = String(w.correctionNote || '');

    // standard/user辞書で置換された「表示語のまとまり」が選択範囲に完全に入っている場合だけ、
    // そのまとまりを配信元の生字幕(originalText)へ戻す。
    // 例: Zara -> Zeta / Flo Glee -> FLOW GLOW。
    // replacementの途中だけを選んだ場合は、範囲外の原文まで勝手に広げない。
    if (w.dictionaryCorrected === true && (layer === 'standard' || layer === 'user') && original) {
      const arrow = note.lastIndexOf('→');
      const target = arrow >= 0 ? cleanCaptionText(note.slice(arrow + 1)) : '';
      const targetWordCount = target ? target.split(/\s+/).filter(Boolean).length : 0;
      if (targetWordCount > 0 && i + targetWordCount <= list.length) {
        const group = list.slice(i, i + targetWordCount);
        const sameCorrection = group.every(x =>
          x?.dictionaryCorrected === true
          && String(x?.dictionaryLayer || '') === layer
          && normalized(x?.originalText) === normalized(original)
          && String(x?.correctionNote || '') === note
        );
        const visibleGroup = joinTranscriptWords(group.map(x => ({ text: String(x?.text || '') })));
        if (sameCorrection && normalized(visibleGroup) === normalized(target)) {
          out.push({ text: original });
          i += targetWordCount;
          continue;
        }
      }
    }

    out.push({ text: String(w.text || '') });
    i++;
  }
  return joinTranscriptWords(out);
}


async function saveTranscriptWordRange(words, senderTabId, surroundingContext = {}) {
  const tabId = await getRecordingTabId();
  if (!tabId) throw new Error('先に「録音＋字幕パネル開始」を押してください');
  if (!senderTabId || senderTabId !== tabId) throw new Error('録音中の動画タブから選択してください');
  const transcriptVideoId = String(surroundingContext?.transcriptVideoId || '');
  await assertTranscriptVideoMatchesCurrentTab(tabId, transcriptVideoId);
  if (!Array.isArray(words) || !words.length || words.length > 180) {
    throw new Error('開始単語と終了単語を選択してください');
  }

  const valid = words
    .map(w => ({
      globalIndex: Number(w?.globalIndex),
      text: cleanCaptionText(w?.text || ''),
      start: Number(w?.start),
      end: Number(w?.end),
      timingSource: String(w?.timingSource || ''),
      // 字幕パネルで辞書補正された語でも、配信元の生字幕をAnki保存まで保持する。
      dictionaryCorrected: w?.dictionaryCorrected === true,
      dictionaryLayer: String(w?.dictionaryLayer || ''),
      originalText: cleanCaptionText(w?.originalText || ''),
      correctionNote: String(w?.correctionNote || '')
    }))
    .filter(w => w.text && Number.isFinite(w.start) && Number.isFinite(w.end) && w.start >= 0 && w.end >= w.start)
    .sort((a, b) => {
      const ai = Number.isFinite(a.globalIndex) ? a.globalIndex : Number.MAX_SAFE_INTEGER;
      const bi = Number.isFinite(b.globalIndex) ? b.globalIndex : Number.MAX_SAFE_INTEGER;
      return ai - bi || a.start - b.start;
    });
  if (!valid.length) throw new Error('選択した単語を読み取れませんでした');

  const state = await getCurrentVideoState(tabId);
  const requestedStart = Number(surroundingContext?.selectionStartVideoTime);
  const requestedEnd = Number(surroundingContext?.selectionEndVideoTime);
  const sentenceStart = Number.isFinite(requestedStart)
    ? Math.max(valid[0].start, Math.min(valid[valid.length - 1].end, requestedStart))
    : valid[0].start;
  const rawSentenceEnd = valid[valid.length - 1].end;
  const sentenceEnd = Number.isFinite(requestedEnd)
    ? Math.max(sentenceStart + 0.02, Math.min(rawSentenceEnd, requestedEnd))
    : rawSentenceEnd;
  if (Number.isFinite(state.currentTime) && sentenceEnd > state.currentTime + 1.2) {
    throw new Error('まだ再生していない単語が含まれています。再生後にAnkiへ追加してください');
  }

  const text = cleanCaptionText(valid.map(w => w.text).join(' '))
    .replace(/\s+([,.;:!?…])/g, '$1')
    .replace(/([\(\[\{“‘])\s+/g, '$1');
  if (!text) throw new Error('選択した単語に英文がありません');
  // Geminiへ渡す本文は辞書補正後の読みやすいtextのまま。
  // ユーザー辞書学習だけは、ここで復元した配信元の生字幕を起点にする。
  const dictionaryRootSourceText = buildDictionaryRootSourceTextFromSelectedWords(valid) || text;

  const config = await getSettings();
  const bufferSeconds = Math.min(90, Math.max(60,
    Number(config.audioSeconds || 8) + 10, Number(config.captionSeconds || 8) + 35));
  if (Number.isFinite(state.currentTime)
      && state.currentTime - sentenceStart > bufferSeconds - 1) {
    throw new Error(`この単語範囲は録音バッファ（約${Math.floor(bufferSeconds)}秒）より前です。時刻を押して再生し直してから追加してください`);
  }

  const tab = await chrome.tabs.get(tabId);
  const platform = getSupportedPlatform(tab.url);
  const u = new URL(tab.url || (platform === 'netflix' ? 'https://www.netflix.com/' : 'https://www.youtube.com/'));
  if (platform === 'youtube') u.searchParams.set('t', `${Math.max(0, Math.floor(sentenceStart))}s`);
  const timingSources = [...new Set(valid.map(w => w.timingSource).filter(Boolean))];
  const context = {
    text,
    dictionaryRootSourceText,
    sentenceStart,
    sentenceEnd,
    currentTime: sentenceStart,
    playbackRate: Number(state.playbackRate || 1),
    paused: !!state.paused,
    title: cleanPlatformTitle(state.title || tab.title || '', getSupportedPlatform(tab.url)),
    channelName: String(state.channelName || ''),
    description: String(state.description || ''),
    url: u.toString(),
    videoId: String(transcriptVideoId || (platform === 'youtube' ? getYouTubeVideoId(tab.url) : '')),
    contextBefore: cleanCaptionText(surroundingContext?.contextBefore || ''),
    contextAfter: cleanCaptionText(surroundingContext?.contextAfter || ''),
    captionSource: 'transcript-word-range',
    selectionEndAdjusted: !!surroundingContext?.selectionEndAdjusted,
    rawSentenceEnd,
    timingSource: getSupportedPlatform(tab.url) === 'netflix'
      ? (timingSources.includes('netflix-timedtext-interpolated') ? 'netflix-timedtext-track' : 'netflix-visible-cue-interpolated')
      : (timingSources.includes('youtube-segment') ? 'youtube-word-segment+fallback' : 'youtube-word-interpolated')
  };
  return await finalizeCapture(tabId, config, tab, context);
}

function joinSelectedTranscriptTexts(texts) {
  const clean = texts.map(t => cleanCaptionText(t)).filter(Boolean);
  if (!clean.length) return '';
  let out = clean[0];
  for (let i = 1; i < clean.length; i++) {
    const next = clean[i];
    const a = out.split(/\s+/);
    const b = next.split(/\s+/);
    const norm = w => String(w || '').toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    let overlap = 0;
    const max = Math.min(16, a.length, b.length);
    for (let n = max; n >= 1; n--) {
      const tail = a.slice(-n).map(norm).join(' ');
      const head = b.slice(0, n).map(norm).join(' ');
      if (tail && tail === head) { overlap = n; break; }
    }
    out = `${out} ${b.slice(overlap).join(' ')}`.replace(/\s+/g, ' ').trim();
  }
  return out;
}

async function saveCurrentCapture() {
  const recordingTabIdForPlatform = await getRecordingTabId();
  if (recordingTabIdForPlatform) {
    const recordingTabForPlatform = await chrome.tabs.get(recordingTabIdForPlatform).catch(() => null);
    if (getSupportedPlatform(recordingTabForPlatform?.url) === 'netflix') {
      throw new Error('Netflixでは右側の字幕パネルから範囲を選んでAnkiへ保存してください');
    }
  }
  const tabId = await getRecordingTabId();
  if (!tabId) throw new Error('先に拡張機能を開いて「録音開始」を押してください');

  const config = await getSettings();
  const tab = await chrome.tabs.get(tabId);
  if (!getSupportedPlatform(tab.url)) throw new Error('録音対象がYouTube/Netflixではありません');

  const minSentenceWords = Math.max(1, Math.min(20, Number(config.minSentenceWords) || 3));
  const captionTimingAdjustment = Math.max(0, Math.min(10, Number(config.captionTimingAdjustment) || 0));
  const lookbackSeconds = Math.max(2, Math.min(20, Number(config.captionSeconds) || 8));

  // Language Reactorのように、まずYouTubeが持つ字幕トラック全体（text + timecode）を取得し、
  // ボタン時刻の直前N秒に重なる字幕単位を候補にする。
  // DOM上の「今表示中の字幕」や字幕ウィンドウの更新タイミングには依存しない。
  let timed = null;
  try {
    timed = await getTimedTextCandidateSet(tabId, lookbackSeconds, minSentenceWords, captionTimingAdjustment);
  } catch (err) {
    console.warn('timedtext candidate generation failed', err);
  }

  const timedCandidates = Array.isArray(timed?.candidates)
    ? timed.candidates.filter(c => cleanCaptionText(c?.text || ''))
    : [];

  if (timedCandidates.length === 1) {
    const context = {
      ...timed,
      ...timedCandidates[0],
      text: timedCandidates[0].text,
      captionSource: 'youtube-timedtext-candidate'
    };
    return await finalizeCapture(tabId, config, tab, context);
  }

  if (timedCandidates.length > 1) {
    await chrome.tabs.sendMessage(tabId, {
      type: 'SHOW_CANDIDATE_PICKER',
      candidates: timedCandidates,
      baseContext: {
        currentTime: timed.currentTime,
        targetTime: timed.targetTime,
        captionTimingAdjustment: timed.captionTimingAdjustment,
        playbackRate: timed.playbackRate,
        paused: timed.paused,
        title: timed.title,
        url: timed.url,
        captionSource: 'youtube-timedtext'
      }
    });
    return { ok: true, pendingSelection: true, source: 'youtube-timedtext', candidates: timedCandidates.map(c => c.text) };
  }

  // timedtextが取れない配信・ライブ・仕様変更時のみ、従来のDOM字幕履歴をフォールバックとして使う。
  let candidateResult = null;
  try {
    candidateResult = await chrome.tabs.sendMessage(tabId, {
      type: 'GET_CAPTURE_CANDIDATES',
      lookbackSeconds,
      minSentenceWords,
      captionTimingAdjustment
    });
  } catch (err) {
    console.warn('DOM candidate generation failed', err);
  }

  const candidates = Array.isArray(candidateResult?.candidates)
    ? candidateResult.candidates.filter(c => cleanCaptionText(c?.text || ''))
    : [];

  if (candidates.length === 1) {
    const context = {
      ...candidateResult,
      ...candidates[0],
      text: candidates[0].text,
      captionSource: 'dom-candidate-fallback'
    };
    return await finalizeCapture(tabId, config, tab, context);
  }

  if (candidates.length > 1) {
    await chrome.tabs.sendMessage(tabId, {
      type: 'SHOW_CANDIDATE_PICKER',
      candidates,
      baseContext: {
        currentTime: candidateResult.currentTime,
        targetTime: candidateResult.targetTime,
        captionTimingAdjustment: candidateResult.captionTimingAdjustment,
        playbackRate: candidateResult.playbackRate,
        paused: candidateResult.paused,
        title: candidateResult.title,
        url: candidateResult.url,
        captionSource: 'dom-fallback'
      }
    });
    return { ok: true, pendingSelection: true, source: 'dom-fallback', candidates: candidates.map(c => c.text) };
  }

  let context = await getYouTubeContext(tabId, lookbackSeconds, minSentenceWords, captionTimingAdjustment);
  if (!cleanCaptionText(context.text || '')) {
    const fallback = await getTimedTextFallback(tabId, lookbackSeconds, minSentenceWords, captionTimingAdjustment);
    if (fallback?.text) {
      context = { ...context, ...fallback, text: fallback.text, captionSource: fallback.captionSource || 'timedtext-fallback' };
    }
  }
  return await finalizeCapture(tabId, config, tab, context);
}

async function getTimedTextCandidateSet(tabId, lookbackSeconds, minSentenceWords = 3, captionTimingAdjustment = 0) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [lookbackSeconds, minSentenceWords, captionTimingAdjustment],
    func: async (lookbackArg, minWordsArg, timingAdjustmentArg) => {
      const normalize = (x) => String(x || '')
        .replace(/\u200b/g, '')
        .replace(/\n+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const wordKey = (token) => String(token || '')
        .toLowerCase()
        .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      const words = (x) => normalize(x).split(/\s+/).map(wordKey).filter(Boolean);
      const contentWordCount = (x) => words(String(x || '').replace(/\[[^\]]{1,60}\]/g, ' ')).length;
      const key = (x) => normalize(x)
        .toLowerCase()
        .replace(/[“”"'’]/g, '')
        .replace(/[^\p{L}\p{N}\s]/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
      const metadataOnly = (x) => {
        const t = normalize(x);
        return !t || /^(?:\[[^\]]+\]|♪+|\([^)]*\))$/.test(t);
      };
      const commonSuffixPrefix = (aText, bText) => {
        const a = words(aText), b = words(bText);
        const max = Math.min(24, a.length, b.length);
        for (let n = max; n >= 1; n--) {
          if (a.slice(-n).join(' ') === b.slice(0, n).join(' ')) return n;
        }
        return 0;
      };
      const startsWithWords = (longText, shortText) => {
        const a = words(longText), b = words(shortText);
        if (!b.length || b.length > a.length) return false;
        return b.every((w, i) => w === a[i]);
      };
      const containsWordSequence = (longText, shortText) => {
        const a = words(longText), b = words(shortText);
        if (!b.length || b.length > a.length) return false;
        outer: for (let i = 0; i <= a.length - b.length; i++) {
          for (let j = 0; j < b.length; j++) if (a[i + j] !== b[j]) continue outer;
          return true;
        }
        return false;
      };

      const video = document.querySelector('video');
      const now = Number(video?.currentTime || 0);
      const adjustment = Math.max(0, Math.min(10, Number(timingAdjustmentArg) || 0));
      const targetTime = Math.max(0, now - adjustment);
      const lookback = Math.max(2, Math.min(20, Number(lookbackArg) || 8));
      const minWords = Math.max(1, Math.min(20, Number(minWordsArg) || 3));
      const currentId = new URL(location.href).searchParams.get('v');

      const responses = [];
      try {
        const p = document.getElementById('movie_player');
        if (typeof p?.getPlayerResponse === 'function') responses.push(p.getPlayerResponse());
      } catch {}
      try { if (window.ytInitialPlayerResponse) responses.push(window.ytInitialPlayerResponse); } catch {}
      try {
        const raw = window.ytplayer?.config?.args?.player_response;
        if (raw) responses.push(typeof raw === 'string' ? JSON.parse(raw) : raw);
      } catch {}

      const pr = responses.find(r => r?.videoDetails?.videoId === currentId && r?.captions?.playerCaptionsTracklistRenderer?.captionTracks)
        || responses.find(r => r?.captions?.playerCaptionsTracklistRenderer?.captionTracks);
      const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      if (!tracks.length) return { ok: false, reason: 'no-caption-track', candidates: [] };

      // 英語字幕を優先。手動字幕がある場合は自動字幕より先に使う。
      const english = tracks.filter(t => t.languageCode === 'en' || String(t.languageCode || '').startsWith('en'));
      const track = english.find(t => t.kind !== 'asr')
        || english[0]
        || tracks.find(t => String(t.name?.simpleText || '').toLowerCase().includes('english'))
        || tracks[0];
      if (!track?.baseUrl) return { ok: false, reason: 'no-caption-url', candidates: [] };

      const u = new URL(track.baseUrl);
      u.searchParams.set('fmt', 'json3');
      const resp = await fetch(u.toString(), { credentials: 'include' });
      if (!resp.ok) return { ok: false, reason: `timedtext-http-${resp.status}`, candidates: [] };
      const data = await resp.json();

      let raw = (data?.events || [])
        .filter(ev => Array.isArray(ev?.segs) && ev.tStartMs !== undefined)
        .map(ev => {
          const start = Number(ev.tStartMs) / 1000;
          const duration = Math.max(0.15, Number(ev.dDurationMs || 2500) / 1000);
          return {
            start,
            end: start + duration,
            text: normalize(ev.segs.map(s => s?.utf8 || '').join(''))
          };
        })
        .filter(c => c.text && c.text !== '\n');

      // json3の自動字幕は、同じ字幕の途中状態が連続イベントとして出る場合がある。
      // ここでは「画面更新のスナップショット」を候補にはせず、字幕トラックの時系列単位へ整理する。
      const units = [];
      for (const cue of raw) {
        const last = units[units.length - 1];
        if (!last) {
          units.push({ ...cue });
          continue;
        }
        const a = normalize(last.text), b = normalize(cue.text);
        const ak = key(a), bk = key(b);
        const near = cue.start <= last.end + 1.25;

        if (ak && ak === bk) {
          last.end = Math.max(last.end, cue.end);
          continue;
        }
        // 逐次追記: "I remember" -> "I remember the booth ..."
        if (near && (startsWithWords(b, a) || containsWordSequence(b, a)) && words(a).length >= 2) {
          last.text = b;
          last.end = Math.max(last.end, cue.end);
          continue;
        }
        // 逆方向の短縮・表示領域スクロールは、古い長い字幕を維持する。
        if (near && (startsWithWords(a, b) || containsWordSequence(a, b)) && words(b).length >= 2) {
          last.end = Math.max(last.end, cue.end);
          continue;
        }
        // ローリング字幕で末尾と先頭が重なる場合は、1つの字幕単位としてつなぐ。
        const overlap = commonSuffixPrefix(a, b);
        if (near && overlap >= 2) {
          const aw = normalize(a).split(/\s+/);
          const bw = normalize(b).split(/\s+/);
          last.text = normalize([...aw, ...bw.slice(overlap)].join(' '));
          last.end = Math.max(last.end, cue.end);
          continue;
        }
        units.push({ ...cue });
      }

      // 1つのYouTube字幕単位に複数の文が入っている場合だけ、句読点で文候補へ分割する。
      // 例: "I remember ... so tiny. Such a tiny booth." を2候補にする。
      // 時刻は同じ字幕cue内で単語数に比例して概算する（音声にはさらに余白を足す）。
      const candidateUnits = [];
      for (const unit of units) {
        const text = normalize(unit.text);
        const matches = text.match(/[^.!?…]+(?:[.!?…]+(?:[\"'”’）)\]]*)|$)/g) || [];
        const parts = matches.map(normalize).filter(Boolean);
        if (parts.length >= 2) {
          const counts = parts.map(part => Math.max(1, contentWordCount(part)));
          const total = counts.reduce((a, b) => a + b, 0);
          const duration = Math.max(0.2, Number(unit.end) - Number(unit.start));
          let cursor = Number(unit.start);
          parts.forEach((part, idx) => {
            const span = idx === parts.length - 1
              ? Number(unit.end) - cursor
              : duration * (counts[idx] / total);
            if (contentWordCount(part) >= minWords) {
              candidateUnits.push({
                text: part,
                start: cursor,
                end: Math.max(cursor + 0.15, cursor + span)
              });
            }
            cursor += span;
          });
        } else {
          candidateUnits.push(unit);
        }
      }

      // 直前N秒に「存在した字幕単位」を全て候補にする。
      // 字幕開始時刻の推測ではなく、YouTube字幕トラック自身のstart/endを使う。
      const windowStart = Math.max(0, targetTime - lookback);
      const windowEnd = targetTime + 0.35;
      const seen = new Map();
      for (const unit of candidateUnits) {
        if (unit.end < windowStart || unit.start > windowEnd) continue;
        if (metadataOnly(unit.text) || contentWordCount(unit.text) < minWords) continue;
        const k = key(unit.text);
        if (!k) continue;
        const candidate = {
          text: normalize(unit.text),
          sentenceStart: Math.max(0, Number(unit.start)),
          sentenceEnd: Math.max(Number(unit.start), Number(unit.end)),
          timingSource: 'youtube-timedtext-track',
          score: 0
        };
        const prev = seen.get(k);
        if (!prev || candidate.sentenceEnd > prev.sentenceEnd) seen.set(k, candidate);
      }

      let candidates = [...seen.values()]
        .sort((a, b) => a.sentenceStart - b.sentenceStart || a.sentenceEnd - b.sentenceEnd);

      // 似た候補が残った場合、短い途中版を除き、より完全な字幕を残す。
      candidates = candidates.filter((c, i, arr) => {
        const ck = key(c.text);
        return !arr.some((o, j) => {
          if (i === j) return false;
          const ok = key(o.text);
          if (!ck || !ok || ck === ok) return false;
          const cWords = words(c.text).length, oWords = words(o.text).length;
          const almostSameTime = Math.abs(c.sentenceStart - o.sentenceStart) <= 1.5
            || Math.abs(c.sentenceEnd - o.sentenceEnd) <= 1.5;
          return almostSameTime && oWords >= cWords + 2 && (ok.includes(ck) || containsWordSequence(o.text, c.text));
        });
      });

      // 選択画面で扱える数だけ、直近の候補を残す。時系列順は維持する。
      if (candidates.length > 8) candidates = candidates.slice(-8);

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
        channelName: (document.querySelector('ytd-watch-metadata ytd-channel-name a, #owner #channel-name a, #upload-info #channel-name a')?.textContent || '').trim(),
        url: url.toString(),
        trackLanguage: track.languageCode || '',
        trackKind: track.kind || 'manual',
        windowStart,
        windowEnd,
        candidates
      };
    }
  });
  return result?.result || { ok: false, reason: 'execute-failed', candidates: [] };
}

async function saveSelectedCandidate(candidate, baseContext) {
  const tabId = await getRecordingTabId();
  if (!tabId) throw new Error('録音が停止しています');
  if (!candidate?.text) throw new Error('文章候補がありません');

  const config = await getSettings();
  const tab = await chrome.tabs.get(tabId);
  const context = {
    ...(baseContext || {}),
    ...candidate,
    text: candidate.text,
    captionSource: 'extension-candidate-selected'
  };
  return await finalizeCapture(tabId, config, tab, context);
}


const EXTENSION_BUILD = '9.4.0';
const GEMINI_PROMPT_VERSION = 'entity-context-v4-study-v2-editable';
const GEMINI_REVIEW_MODEL = 'gemini-3.5-flash-lite';
const GEMINI_TRANSLATION_MODEL = 'gemini-3.1-flash-lite';
const GEMINI_REVIEW_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_REVIEW_MODEL}:generateContent`;
const GEMINI_TRANSLATION_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TRANSLATION_MODEL}:generateContent`;

function normalizeGeminiDiffToken(text) {
  return String(text || '').toLowerCase().replace(/[’]/g, "'")
    .replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '');
}

function normalizeGeminiPhrase(text) {
  return String(text || '').toLowerCase().replace(/[’]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function diffGeminiCaptionTokens(sourceText, correctedText) {
  const a = String(sourceText || '').trim().split(/\s+/).filter(Boolean);
  const b = String(correctedText || '').trim().split(/\s+/).filter(Boolean);
  const an = a.map(normalizeGeminiDiffToken);
  const bn = b.map(normalizeGeminiDiffToken);
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = an[i] && an[i] === bn[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const diffs = [];
  let i = 0, j = 0, pendingA = [], pendingB = [];
  const flush = () => {
    if (!pendingA.length && !pendingB.length) return;
    diffs.push({ from: pendingA.join(' '), to: pendingB.join(' ') });
    pendingA = []; pendingB = [];
  };
  while (i < n || j < m) {
    if (i < n && j < m && an[i] && an[i] === bn[j]) {
      flush(); i++; j++; continue;
    }
    if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
      pendingB.push(b[j++]);
    } else if (i < n) {
      pendingA.push(a[i++]);
    }
  }
  flush();
  return diffs.filter(d => normalizeGeminiPhrase(d.from) !== normalizeGeminiPhrase(d.to));
}

function isConservativeGeminiRewrite(sourceText, correctedText, diffs) {
  const sourceWords = String(sourceText || '').trim().split(/\s+/).filter(Boolean);
  const correctedWords = String(correctedText || '').trim().split(/\s+/).filter(Boolean);
  if (!sourceWords.length || !correctedWords.length) return false;
  const lengthRatio = correctedWords.length / sourceWords.length;
  if (lengthRatio < 0.58 || lengthRatio > 1.45) return false;
  const changed = (diffs || []).reduce((sum, d) => {
    const a = String(d.from || '').trim().split(/\s+/).filter(Boolean).length;
    const b = String(d.to || '').trim().split(/\s+/).filter(Boolean).length;
    return sum + Math.max(a, b);
  }, 0);
  const maxWords = Math.max(sourceWords.length, correctedWords.length);
  const limit = maxWords <= 6 ? 0.67 : (maxWords <= 12 ? 0.50 : 0.40);
  return changed / maxWords <= limit;
}

function isLikelyGeminiTwoWordRestart(normalizedPair) {
  if (!Array.isArray(normalizedPair) || normalizedPair.length !== 2) return false;
  const [first, secondRaw] = normalizedPair;
  const second = String(secondRaw || '').replace(/'/g, '');
  if (!first || !second) return false;
  const subjectStarters = new Set(['i','you','we','they','he','she','it','this','that','there','who','what']);
  if (!subjectStarters.has(first)) return false;
  const auxiliaryLike = new Set([
    'am','is','are','was','were','be','been','have','has','had','do','does','did',
    'dont','doesnt','didnt','cant','cannot','couldnt','wont','wouldnt','shouldnt','isnt','arent','wasnt','werent','havent','hasnt','hadnt',
    'can','could','will','would','should','may','might','must','m','re','ve','ll','d'
  ]);
  return auxiliaryLike.has(second);
}

function collapseGeminiImmediateRepeatedPhrases(text, minWords = 2, maxWords = 8) {
  let tokens = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length < minWords * 2) return String(text || '').trim();
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 12) {
    changed = false;
    outer: for (let size = Math.min(maxWords, Math.floor(tokens.length / 2)); size >= minWords; size--) {
      for (let i = 0; i + size * 2 <= tokens.length; i++) {
        const left = tokens.slice(i, i + size).map(normalizeGeminiDiffToken);
        const right = tokens.slice(i + size, i + size * 2).map(normalizeGeminiDiffToken);
        if (!left.every((v, k) => v && v === right[k])) continue;
        if (size === 2 && !isLikelyGeminiTwoWordRestart(left)) continue;
        tokens.splice(i + size, size);
        changed = true;
        break outer;
      }
    }
  }
  return tokens.join(' ').replace(/\s+([,.;:!?…])/g, '$1').trim();
}

function extractGeminiResponseText(json) {
  const parts = json?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map(p => typeof p?.text === 'string' ? p.text : '').join('').trim();
}

function geminiCorrectionMatchesDiff(correction, diff) {
  const cf = normalizeGeminiPhrase(correction?.from || '');
  const ct = normalizeGeminiPhrase(correction?.to || '');
  const df = normalizeGeminiPhrase(diff?.from || '');
  const dt = normalizeGeminiPhrase(diff?.to || '');
  if (cf === df && ct === dt) return true;
  if (!cf || !df) return false;
  return cf.includes(df) && ct === dt || df.includes(cf) && dt === ct;
}

async function callGeminiCaptionReview(apiKey, payload, timeoutMs = 30000) {
  const key = String(apiKey || '').trim();
  if (!key) return { ok: false, reason: 'gemini-key-missing', error: 'Gemini APIキーが設定されていません' };

  const sourceText = String(payload.text || '').replace(/\s+/g, ' ').trim();
  const title = String(payload.title || '').slice(0, 500);
  const channelName = String(payload.channelName || '').slice(0, 300);
  const url = String(payload.url || '').slice(0, 800);
  const description = String(payload.description || '').slice(0, 2600);
  const contextBefore = String(payload.contextBefore || '').replace(/\s+/g, ' ').trim().slice(-1800);
  const contextAfter = String(payload.contextAfter || '').replace(/\s+/g, ' ').trim().slice(0, 1800);

  const systemInstruction = `You correct automatic speech-recognition (ASR) captions for English listening and dictation study.
Recover what the speaker most likely actually said; do not improve their English.
Preserve genuine grammar, wording, slang, contractions, fillers, hesitation, accent effects, and intentional repetition.
Use the supplied video identity and nearby transcript as context. You are not given any correction dictionary and must not assume the video belongs to any specific fandom, company, or topic.
IMPORTANT: the nearby transcript is also automatic ASR and can repeat the SAME systematic misspelling as SOURCE TEXT. Repetition of a spelling in nearby transcript is NOT independent evidence that the spelling is correct.
For likely named entities, actively resolve the canonical real-world spelling using the video identity, topic, phonetic fit, surrounding meaning, and your general knowledge. The canonical name does NOT need to appear literally in the title or description.
Treat organizations, teams, leagues, companies, groups, games, series, events, and other entities named in VIDEO TITLE / CHANNEL / DESCRIPTION as STRONG DISAMBIGUATING CONTEXT. When that context narrows who or what can plausibly be mentioned, use it to resolve a phonetically close ASR name to the canonical real-world spelling. Do not require the correct name itself to be written in metadata.
Never invent a named entity merely because it fits the topic. But do not preserve a plausible-looking noncanonical spelling when a specific real entity is strongly identified and the source is phonetically compatible. When identity is genuinely uncertain, make no lexical edit.
Named-entity extraction is a required part of the task, not optional metadata. After correcting the caption, perform a separate exhaustive entity audit over the final corrected caption before returning JSON.
Use normal written capitalization for sentence starts, the pronoun I, and named entities, without changing the spoken words.`;

  const prompt = `[PROMPT VERSION: ${GEMINI_PROMPT_VERSION}]\nRecover the most likely spoken wording of ONE short English video caption immediately before it is saved as an Anki listening card.\n
This is ASR TRANSCRIPTION CLEANUP, not rewriting or English-composition correction.

Required behavior:
1. Read the VIDEO identity/context and nearby transcript before deciding. Treat VIDEO TITLE, CHANNEL and DESCRIPTION as identity/topic evidence. Treat NEARBY TRANSCRIPT as noisy ASR evidence, not as a spelling authority.
2. Check the SOURCE TEXT token by token for ASR misspellings, sound-alike substitutions, and named terms whose spelling is wrong.
3. Named terms may be people, nicknames, groups, channels, games, brands, projects, events, songs/shows, Japanese products/foods/terms, or any other conventional named entity. Do not assume any particular fandom or domain.
4. For every phrase that plausibly denotes a named entity, actively ask: "What specific real-world entity is this most likely referring to, and what is its canonical spelling?" Use phonetic similarity plus the supplied video identity/topic and your general knowledge. The correct entity name does NOT need to be written in the title/description.
5. ORGANIZATION-CONTEXT RULE: if VIDEO TITLE / CHANNEL / DESCRIPTION names a sports team, league, company, creator group, game, event, show, project, location, or other organization/domain, treat that as strong identity evidence. Use it to narrow the set of plausible people/products/terms. A phonetically close ASR name that looks superficially valid must be corrected when a specific canonical entity within that context is strongly identifiable.
6. Nearby transcript can contain the same ASR error repeatedly. If SOURCE TEXT and nearby transcript both use the same suspicious spelling, do NOT count that repetition as independent confirmation. Repeated nearby-ASR spellings must NEVER outweigh stronger video-identity evidence.
7. A source token can be a real English word or a plausible-looking name and still be the wrong ASR result. For a strongly identified named entity with strong phonetic compatibility, use the canonical spelling. For ordinary lexical changes, remain conservative.
8. Inspect immediate repeated words and phrases VERY carefully. When the speaker immediately restarts and repeats the same word/phrase without adding meaning, collapse the restart to ONE copy. This includes both single-word and multi-word stumbles. For example:
   - "They're like they're like the members that I don't talk to that often" -> "They're like the members that I don't talk to that often"
   - "especially especially Ame Senpai" -> "especially Ame Senpai"
   - "I I think it's fine" -> "I think it's fine"
   Do NOT remove repetition that is clearly intentional emphasis, contrast, quotation, counting, or meaning-bearing rhetoric (for example, "very very good" when the repetition is deliberate).
9. Correct obvious ASR spelling mistakes and ordinary punctuation/capitalization.
10. Do not change the speaker's grammar.
11. In corrections, classify each lexical edit. Use proper_noun only when the TO phrase is a conventional named entity. Set sourceUsesValidWords=true when the FROM phrase consists of ordinary valid English words that would be unsafe to replace globally without context.
12. In entityChecks, include EVERY SOURCE TEXT phrase that plausibly denotes a named entity, even when you decide to keep it. For each one, state the exact source phrase, the canonical candidate, keep/replace, confidence, and a short reason. This diagnostic list is mandatory and must reflect an explicit identity/spelling check.
13. AFTER correctedText is complete, perform a MANDATORY SECOND PASS devoted only to named-entity extraction. Scan correctedText from left to right and explicitly inspect EVERY token and EVERY plausible 1-to-5-word span. Consider people, nicknames, creators/streamers, groups, channels, companies, brands, products, foods, places, games, projects, events, songs, shows, titles, and other conventional names.
14. namedTerms MUST contain EVERY high-confidence conventional named entity that actually appears in correctedText. Do not omit a term merely because it needed no correction, was already capitalized correctly, looks like an ordinary word, is a Japanese/foreign term, or seems obvious from context. For example, if correctedText contains a confidently identified person name and a confidently identified product/food name, BOTH must be present in namedTerms even when SOURCE TEXT already spelled them correctly.
15. Be conservative about whether something truly is a named entity: omit uncertain candidates rather than inventing them. But once you are highly confident it is a named entity, inclusion in namedTerms is mandatory.
16. Before returning JSON, verify the entity audit is complete. Set namedTermsAuditComplete=true only after you have performed that full second pass.
17. correctedText must begin with normal sentence capitalization. Also capitalize standalone pronoun I and named entities.

Do NOT paraphrase, summarize, translate, formalize, or naturalize the English.
When uncertain about a lexical change, keep the source wording.
Return the COMPLETE caption in correctedText.

VIDEO URL / IDENTITY: ${url || '(unknown)'}
VIDEO TITLE: ${title || '(unknown)'}
CHANNEL: ${channelName || '(unknown)'}
VIDEO DESCRIPTION: ${description || '(none)'}

NEARBY TRANSCRIPT BEFORE SOURCE:
${contextBefore || '(none)'}

SOURCE TEXT:
${sourceText}

NEARBY TRANSCRIPT AFTER SOURCE:
${contextAfter || '(none)'}`;

  const responseJsonSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      correctedText: {
        type: 'string',
        description: 'Complete cleaned caption. Preserve the spoken wording except for high-confidence ASR/orthographic cleanup.'
      },
      corrections: {
        type: 'array',
        maxItems: 12,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            from: { type: 'string' },
            to: { type: 'string' },
            category: { type: 'string', enum: ['proper_noun', 'asr_substitution', 'duplicate', 'orthography'] },
            sourceUsesValidWords: { type: 'boolean' },
            confidence: { type: 'number', minimum: 0, maximum: 1 }
          },
          required: ['from', 'to', 'category', 'sourceUsesValidWords', 'confidence']
        }
      },
      entityChecks: {
        type: 'array',
        maxItems: 12,
        description: 'Diagnostic audit of every phrase in SOURCE TEXT that plausibly denotes a named entity. This is for debugging/verification only and is not used to generate dictionary mappings.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sourceText: { type: 'string', description: 'Exact phrase as it appears in SOURCE TEXT.' },
            canonicalText: { type: 'string', description: 'Most likely canonical real-world spelling; same as sourceText if keeping it.' },
            action: { type: 'string', enum: ['keep', 'replace'] },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            reason: { type: 'string', description: 'Short reason based on phonetics and supplied video context. Remember nearby transcript may repeat the same ASR error.' }
          },
          required: ['sourceText', 'canonicalText', 'action', 'confidence', 'reason']
        }
      },
      namedTerms: {
        type: 'array',
        maxItems: 20,
        description: 'EXHAUSTIVE list of all high-confidence conventional named entities actually present in correctedText after a mandatory second-pass entity audit. Include already-correct terms too.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', description: 'Canonical spelling/capitalization of the named entity as it should appear in correctedText.' },
            confidence: { type: 'number', minimum: 0, maximum: 1 }
          },
          required: ['text', 'confidence']
        }
      },
      namedTermsAuditComplete: {
        type: 'boolean',
        description: 'True only after a separate exhaustive token/span scan of correctedText for named entities.'
      }
    },
    required: ['correctedText', 'corrections', 'entityChecks', 'namedTerms', 'namedTermsAuditComplete']
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(3000, Number(timeoutMs) || 20000));
  try {
    const response = await fetch(GEMINI_REVIEW_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          thinkingConfig: { thinkingLevel: 'MEDIUM' },
          responseMimeType: 'application/json',
          responseJsonSchema
        }
      }),
      signal: controller.signal
    });

    let json = null;
    try { json = await response.json(); } catch {}
    if (!response.ok) {
      const apiMessage = String(json?.error?.message || `${response.status} ${response.statusText}` || 'Gemini API error');
      const reason = response.status === 429 ? 'gemini-rate-limit'
        : (response.status === 401 || response.status === 403) ? 'gemini-auth-failed'
          : 'gemini-api-failed';
      return { ok: false, reason, error: apiMessage, httpStatus: response.status, debug: { customInstruction, systemInstruction, requestPrompt: prompt, apiError: json?.error || null } };
    }

    const rawText = extractGeminiResponseText(json);
    if (!rawText) return { ok: false, reason: 'gemini-empty-response', error: 'Geminiの応答本文が空です', debug: { requestPrompt: prompt, usageMetadata: json?.usageMetadata || null } };
    let value = null;
    try { value = JSON.parse(rawText); } catch {
      return { ok: false, reason: 'gemini-invalid-response', error: 'GeminiのJSON応答を解析できませんでした', debug: { requestPrompt: prompt, rawResponseText: rawText, usageMetadata: json?.usageMetadata || null } };
    }
    if (!value || typeof value.correctedText !== 'string' || !Array.isArray(value.corrections)) {
      return { ok: false, reason: 'gemini-invalid-response', error: 'Geminiの応答形式が不正です', debug: { rawResponseText: rawText, requestPrompt: prompt } };
    }
    return {
      ok: true,
      value,
      debug: {
        model: GEMINI_REVIEW_MODEL,
        requestPrompt: prompt,
        rawResponseText: rawText,
        usageMetadata: json?.usageMetadata || null
      }
    };
  } catch (err) {
    const timedOut = String(err?.name || '') === 'AbortError';
    return {
      ok: false,
      reason: timedOut ? 'gemini-timeout' : 'gemini-network-failed',
      error: err?.message || String(err),
      debug: { customInstruction, systemInstruction, requestPrompt: prompt }
    };
  } finally {
    clearTimeout(timer);
  }
}


async function appendGeminiDebugLog(entry) {
  try {
    const data = await chrome.storage.local.get({ geminiDebugLog: [] });
    const log = Array.isArray(data.geminiDebugLog) ? data.geminiDebugLog : [];
    const safeEntry = {
      id: `gemini:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      ...entry
    };
    // APIキーは絶対にログへ保存しない。直近30件だけ保持する。
    log.push(safeEntry);
    await chrome.storage.local.set({ geminiDebugLog: log.slice(-30) });
  } catch (err) {
    console.warn('Failed to save Gemini debug log', err);
  }
}

async function getGeminiDebugLog() {
  const data = await chrome.storage.local.get({ geminiDebugLog: [] });
  return { ok: true, entries: Array.isArray(data.geminiDebugLog) ? data.geminiDebugLog : [] };
}

async function clearGeminiDebugLog() {
  await chrome.storage.local.set({ geminiDebugLog: [] });
  return { ok: true };
}

function normalizeCaptionSentenceCapitalization(text) {
  let out = cleanCaptionText(text || '');
  if (!out) return out;
  // 字幕カードは通常の英文表記に統一。語彙・文法は変えず、文頭と代名詞 I だけ機械的に大文字化する。
  out = out.replace(/(^|[.!?…]+\s+)(["'“‘(\[]*)([a-z])/g, (m, lead, quote, ch) => `${lead}${quote}${ch.toUpperCase()}`);
  out = out.replace(/\bi\b/g, 'I');
  return out;
}

function compactNamedTermKey(text) {
  return String(text || '').toLowerCase().replace(/[’]/g, "'").replace(/[^\p{L}\p{N}]+/gu, '');
}

function sanitizeGeminiNamedTerms(rawTerms) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(rawTerms) ? rawTerms : []) {
    const text = cleanCaptionText(raw?.text || '');
    const confidence = Math.max(0, Math.min(1, Number(raw?.confidence) || 0));
    const key = compactNamedTermKey(text);
    const words = text.split(/\s+/).filter(Boolean);
    if (!text || confidence < 0.9 || key.length < 3 || words.length > 5 || text.length > 80 || seen.has(key)) continue;
    seen.add(key);
    out.push({ text, confidence });
  }
  return out;
}

function findNamedTermSurface(text, canonical) {
  const tokens = cleanCaptionText(text || '').split(/\s+/).filter(Boolean);
  const wanted = compactNamedTermKey(canonical);
  if (!wanted || !tokens.length) return '';
  const maxWindow = Math.min(5, tokens.length);
  for (let size = 1; size <= maxWindow; size++) {
    for (let i = 0; i + size <= tokens.length; i++) {
      const slice = tokens.slice(i, i + size);
      const cores = slice.map(t => splitWordPunctuation(t).core).join(' ');
      if (compactNamedTermKey(cores) !== wanted) continue;
      return joinTranscriptWords(slice.map(t => ({ text: t })));
    }
  }
  return '';
}

function sanitizeGeminiEntityChecks(rawChecks) {
  const out = [];
  for (const raw of Array.isArray(rawChecks) ? rawChecks : []) {
    const sourceText = cleanCaptionText(raw?.sourceText || '');
    const canonicalText = cleanCaptionText(raw?.canonicalText || '');
    const action = String(raw?.action || '').toLowerCase();
    const confidence = Math.max(0, Math.min(1, Number(raw?.confidence) || 0));
    const reason = String(raw?.reason || '').trim();
    if (!sourceText || !canonicalText || confidence < 0.9) continue;
    if (!['keep', 'replace'].includes(action)) continue;
    out.push({ sourceText, canonicalText, action, confidence, reason });
  }
  return out;
}

function replaceCaptionPhraseExactish(text, sourcePhrase, replacementPhrase) {
  const tokens = cleanCaptionText(text || '').split(/\s+/).filter(Boolean);
  const sourceTokens = cleanCaptionText(sourcePhrase || '').split(/\s+/).filter(Boolean);
  if (!tokens.length || !sourceTokens.length || !replacementPhrase) return cleanCaptionText(text || '');
  const wanted = sourceTokens.map(normalizeGeminiDiffToken);
  if (wanted.some(x => !x)) return cleanCaptionText(text || '');

  for (let i = 0; i + sourceTokens.length <= tokens.length; i++) {
    const actual = tokens.slice(i, i + sourceTokens.length).map(normalizeGeminiDiffToken);
    if (!actual.every((x, j) => x === wanted[j])) continue;
    const first = splitWordPunctuation(tokens[i]);
    const last = splitWordPunctuation(tokens[i + sourceTokens.length - 1]);
    const replacement = `${first.prefix || ''}${cleanCaptionText(replacementPhrase)}${last.suffix || ''}`;
    tokens.splice(i, sourceTokens.length, replacement);
    return cleanCaptionText(tokens.join(' ')).replace(/\s+([,.;:!?…%])/g, '$1');
  }
  return cleanCaptionText(text || '');
}

function applyGeminiEntityCheckCanonicalization(text, rawChecks) {
  let out = cleanCaptionText(text || '');
  for (const check of sanitizeGeminiEntityChecks(rawChecks)) {
    if (check.action !== 'replace') continue;
    if (normalizeGeminiPhrase(check.sourceText) === normalizeGeminiPhrase(check.canonicalText)) continue;
    out = replaceCaptionPhraseExactish(out, check.sourceText, check.canonicalText);
  }
  return out;
}

function mergeNamedTermsWithEntityChecks(rawTerms, rawChecks) {
  const merged = [...sanitizeGeminiNamedTerms(rawTerms)];
  const seen = new Set(merged.map(x => compactNamedTermKey(x.text)));
  for (const check of sanitizeGeminiEntityChecks(rawChecks)) {
    const text = check.action === 'replace' ? check.canonicalText : check.sourceText;
    const key = compactNamedTermKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push({ text, confidence: check.confidence });
  }
  return merged;
}

function applyGeminiNamedTermCanonicalization(text, namedTerms) {
  let tokens = cleanCaptionText(text || '').split(/\s+/).filter(Boolean);
  if (!tokens.length) return '';
  for (const term of sanitizeGeminiNamedTerms(namedTerms)) {
    const canonical = term.text;
    const wanted = compactNamedTermKey(canonical);
    if (!wanted) continue;
    let replaced = false;
    const maxWindow = Math.min(5, tokens.length);
    for (let size = 1; size <= maxWindow && !replaced; size++) {
      for (let i = 0; i + size <= tokens.length; i++) {
        const slice = tokens.slice(i, i + size);
        const first = splitWordPunctuation(slice[0]);
        const last = splitWordPunctuation(slice[slice.length - 1]);
        const cores = slice.map(t => splitWordPunctuation(t).core).join(' ');
        if (compactNamedTermKey(cores) !== wanted) continue;
        const surface = joinTranscriptWords(slice.map(t => ({ text: t })));
        const surfaceCore = `${first.prefix ? '' : ''}${cores}`;
        // 同じ表記なら何もしない。異なるのが大小文字・区切りだけならcanonicalへ統一。
        if (surfaceCore !== canonical) {
          const replacement = `${first.prefix || ''}${canonical}${last.suffix || ''}`;
          tokens.splice(i, size, replacement);
        }
        replaced = true;
        break;
      }
    }
  }
  return cleanCaptionText(tokens.join(' ')).replace(/\s+([,.;:!?…%])/g, '$1');
}

function tokenizeDirectLearningText(text) {
  return cleanCaptionText(text || '').split(/\s+/).filter(Boolean).map((raw, index) => {
    const parts = splitWordPunctuation(raw);
    return { raw, core: cleanCaptionText(parts.core || raw), index };
  });
}

function alignSourceAndFinalTokensForLearning(sourceText, correctedText) {
  const source = tokenizeDirectLearningText(sourceText);
  const final = tokenizeDirectLearningText(correctedText);
  const n = source.length, m = final.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const same = normalizeGeminiDiffToken(source[i - 1].core) === normalizeGeminiDiffToken(final[j - 1].core);
      const sub = dp[i - 1][j - 1] + (same ? 0 : 1);
      const del = dp[i - 1][j] + 1;
      const ins = dp[i][j - 1] + 1;
      dp[i][j] = Math.min(sub, del, ins);
    }
  }

  const reversed = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const same = normalizeGeminiDiffToken(source[i - 1].core) === normalizeGeminiDiffToken(final[j - 1].core);
      const cost = same ? 0 : 1;
      if (dp[i][j] === dp[i - 1][j - 1] + cost) {
        reversed.push({ type: same ? 'match' : 'substitute', sourceIndex: i - 1, finalIndex: j - 1 });
        i--; j--; continue;
      }
    }
    if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      reversed.push({ type: 'delete', sourceIndex: i - 1, finalIndex: null });
      i--; continue;
    }
    reversed.push({ type: 'insert', sourceIndex: null, finalIndex: j - 1 });
    j--;
  }
  return { source, final, ops: reversed.reverse() };
}

function findFinalNamedTermSpans(finalTokens, namedTerms) {
  const spans = [];
  const seen = new Set();
  for (const term of sanitizeGeminiNamedTerms(namedTerms)) {
    const wanted = compactNamedTermKey(term.text || '');
    if (!wanted) continue;
    const maxWindow = Math.min(5, finalTokens.length);
    for (let size = 1; size <= maxWindow; size++) {
      for (let start = 0; start + size <= finalTokens.length; start++) {
        const cores = finalTokens.slice(start, start + size).map(t => t.core).join(' ');
        if (compactNamedTermKey(cores) !== wanted) continue;
        const key = `${start}:${start + size - 1}:${wanted}`;
        if (!seen.has(key)) {
          seen.add(key);
          spans.push({ start, end: start + size - 1, confidence: term.confidence, text: term.text });
        }
      }
    }
  }
  return spans;
}

function rawProperCorrectionMetadataForDirectPair(rawCorrections, from, to) {
  const direct = (Array.isArray(rawCorrections) ? rawCorrections : []).find(c =>
    String(c?.category || '') === 'proper_noun'
    && normalizeGeminiPhrase(c?.from || '') === normalizeGeminiPhrase(from)
    && compactNamedTermKey(c?.to || '') === compactNamedTermKey(to)
  );
  if (!direct) return null;
  return {
    confidence: Math.max(0, Math.min(1, Number(direct.confidence) || 0)),
    sourceUsesValidWords: direct.sourceUsesValidWords === true
  };
}

function sourceSpanForFinalNamedTerm(aligned, span) {
  // 語数が変わる固有名詞は、編集距離の1語ずつの対応を信用しない。
  // named term の直前・直後にある「原文と最終文で同一の語」をアンカーにし、
  // そのアンカー間の SOURCE TEXT 全体を、最終文の named term に1対1で対応させる。
  // 例: someone [bi boo] cute -> someone [Bijou] cute なら bi boo -> Bijou。
  let prevMatch = null;
  let nextMatch = null;
  for (const op of aligned.ops) {
    if (op.type !== 'match' || op.sourceIndex === null || op.finalIndex === null) continue;
    if (op.finalIndex < span.start) prevMatch = op;
    if (op.finalIndex > span.end) { nextMatch = op; break; }
  }

  const finalGapStart = prevMatch ? prevMatch.finalIndex + 1 : 0;
  const finalGapEnd = nextMatch ? nextMatch.finalIndex - 1 : aligned.final.length - 1;
  if (finalGapStart === span.start && finalGapEnd === span.end) {
    const sourceStart = prevMatch ? prevMatch.sourceIndex + 1 : 0;
    const sourceEnd = nextMatch ? nextMatch.sourceIndex - 1 : aligned.source.length - 1;
    if (sourceStart <= sourceEnd) {
      return { sourceStart, sourceEnd, method: 'unchanged-boundary-anchors' };
    }
  }

  // 複数の変更箇所が隣接していてアンカー区間を固有名詞だけに限定できない場合のみ、
  // 従来のtoken alignmentへフォールバックする。
  const opIndexes = [];
  for (let oi = 0; oi < aligned.ops.length; oi++) {
    const fj = aligned.ops[oi].finalIndex;
    if (fj !== null && fj >= span.start && fj <= span.end) opIndexes.push(oi);
  }
  if (!opIndexes.length) return null;
  const firstOp = Math.min(...opIndexes), lastOp = Math.max(...opIndexes);
  const sourceIndexes = aligned.ops.slice(firstOp, lastOp + 1)
    .map(op => op.sourceIndex).filter(idx => idx !== null);
  if (!sourceIndexes.length) return null;
  return {
    sourceStart: Math.min(...sourceIndexes),
    sourceEnd: Math.max(...sourceIndexes),
    method: 'token-alignment-fallback'
  };
}

function buildDirectProperNameLearningPairs(sourceText, correctedText, namedTerms, rawCorrections = []) {
  const aligned = alignSourceAndFinalTokensForLearning(sourceText, correctedText);
  const spans = findFinalNamedTermSpans(aligned.final, namedTerms);
  const pairs = [];
  const seen = new Set();

  for (const span of spans) {
    const sourceSpan = sourceSpanForFinalNamedTerm(aligned, span);
    if (!sourceSpan) continue;
    const { sourceStart, sourceEnd } = sourceSpan;
    const from = cleanCaptionText(aligned.source.slice(sourceStart, sourceEnd + 1).map(t => t.core).join(' '));
    const to = cleanCaptionText(aligned.final.slice(span.start, span.end + 1).map(t => t.core).join(' '));
    if (!from || !to || from === to) continue;

    // from は必ず SOURCE TEXT から、to は必ず最終 correctedText から切り出す。
    // namedTerms やGeminiの中間表記から alias を生成しない。
    const meta = rawProperCorrectionMetadataForDirectPair(rawCorrections, from, to);
    const confidence = Math.max(Number(span.confidence || 0), Number(meta?.confidence || 0));
    if (confidence < 0.9) continue;
    const key = `${from}\u0000${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({
      from,
      to,
      category: 'proper_noun',
      reusable: true,
      sourceUsesValidWords: meta?.sourceUsesValidWords === true,
      reason: 'Gemini direct SOURCE→FINAL proper-noun correction',
      confidence,
      alignmentMethod: sourceSpan.method
    });
  }
  return pairs;
}

async function reviewCaptionTextBeforeAnki(tabId, config, context, captionText) {
  const text = cleanCaptionText(captionText || '');
  if (!text) return { text, corrected: false, corrections: [], status: 'reviewed' };
  // Geminiの校閲入力は表示中の補正済み字幕。
  // 辞書学習だけは配信元の生字幕→最終字幕の1対1対応を使う。
  const dictionaryRootSourceText = cleanCaptionText(context?.dictionaryRootSourceText || text) || text;

  const result = await callGeminiCaptionReview(config.geminiApiKey, {
    text,
    title: String(context?.title || ''),
    channelName: String(context?.channelName || ''),
    url: String(context?.url || ''),
    description: String(context?.description || ''),
    contextBefore: String(context?.contextBefore || ''),
    contextAfter: String(context?.contextAfter || '')
  });

  if (!result?.ok) {
    console.warn('Gemini card review unavailable', result?.reason || result?.error || '');
    await appendGeminiDebugLog({
      kind: 'review',
      ok: false,
      status: String(result?.reason || 'failed'),
      buildInfo: {
        manifestVersion: chrome.runtime.getManifest().version,
        backgroundBuild: EXTENSION_BUILD,
        promptVersion: GEMINI_PROMPT_VERSION,
        geminiModel: GEMINI_REVIEW_MODEL,
        reviewModel: GEMINI_REVIEW_MODEL,
        translationModel: GEMINI_TRANSLATION_MODEL
      },
      error: String(result?.error || ''),
      sourceText: text,
      dictionaryRootSourceText,
      video: { title: String(context?.title || ''), channelName: String(context?.channelName || ''), url: String(context?.url || '') },
      contextSent: {
        title: String(context?.title || ''),
        channelName: String(context?.channelName || ''),
        description: String(context?.description || ''),
        contextBefore: String(context?.contextBefore || ''),
        contextAfter: String(context?.contextAfter || '')
      },
      requestPrompt: String(result?.debug?.requestPrompt || ''),
      rawResponseText: String(result?.debug?.rawResponseText || ''),
      apiError: result?.debug?.apiError || null,
      usageMetadata: result?.debug?.usageMetadata || null
    });
    return { text, corrected: false, corrections: [], userDictionaryLearnedCount: 0, status: String(result?.reason || 'failed') };
  }

  const rawEntityChecks = Array.isArray(result.value?.entityChecks) ? result.value.entityChecks : [];
  const namedTerms = mergeNamedTermsWithEntityChecks(result.value?.namedTerms || [], rawEntityChecks);
  let correctedText = cleanCaptionText(result.value?.correctedText || text) || text;
  // entityChecks はデバッグ専用で終わらせず、高確信度 replace を最終文へ強制反映する。
  // from は必ず SOURCE TEXT の実際の表記、to はcanonicalText。途中aliasは生成しない。
  correctedText = applyGeminiEntityCheckCanonicalization(correctedText, rawEntityChecks);
  correctedText = collapseGeminiImmediateRepeatedPhrases(correctedText, 2, 8);
  correctedText = normalizeCaptionSentenceCapitalization(correctedText);
  correctedText = applyGeminiNamedTermCanonicalization(correctedText, namedTerms);

  const initialDiffs = diffGeminiCaptionTokens(text, correctedText);
  if (!isConservativeGeminiRewrite(text, correctedText, initialDiffs)) {
    console.warn('Rejected broad Gemini card rewrite', { sourceText: text, correctedText, diffs: initialDiffs });
    correctedText = applyGeminiEntityCheckCanonicalization(text, rawEntityChecks);
    correctedText = collapseGeminiImmediateRepeatedPhrases(correctedText, 2, 8);
    correctedText = normalizeCaptionSentenceCapitalization(correctedText);
    correctedText = applyGeminiNamedTermCanonicalization(correctedText, namedTerms);
  }

  const finalDiffs = diffGeminiCaptionTokens(text, correctedText);
  const rawReturnedCorrections = Array.isArray(result.value?.corrections) ? result.value.corrections : [];
  // entityChecksでreplace判定された固有名詞も、辞書学習・差分分類では正式なproper_noun修正として扱う。
  const entityCheckCorrections = sanitizeGeminiEntityChecks(rawEntityChecks)
    .filter(c => c.action === 'replace' && normalizeGeminiPhrase(c.sourceText) !== normalizeGeminiPhrase(c.canonicalText))
    .map(c => ({
      from: c.sourceText,
      to: c.canonicalText,
      category: 'proper_noun',
      sourceUsesValidWords: false,
      confidence: c.confidence
    }));
  const returnedCorrections = [...rawReturnedCorrections];
  for (const ec of entityCheckCorrections) {
    if (!returnedCorrections.some(c => normalizeGeminiPhrase(c?.from) === normalizeGeminiPhrase(ec.from) && normalizeGeminiPhrase(c?.to) === normalizeGeminiPhrase(ec.to))) {
      returnedCorrections.push(ec);
    }
  }
  const corrections = finalDiffs.map(diff => {
    const meta = returnedCorrections.find(c => geminiCorrectionMatchesDiff(c, diff)) || {};
    const from = String(diff.from || '');
    const to = String(diff.to || '');
    const category = !to ? 'duplicate'
      : String(meta.category || '') === 'proper_noun' ? 'proper_noun'
        : String(meta.category || '') === 'orthography' ? 'orthography'
          : 'asr_substitution';
    const confidence = Math.max(0, Math.min(1, Number(meta.confidence) || (category === 'proper_noun' ? 0.9 : 0.95)));
    return {
      from,
      to,
      category,
      reusable: category === 'proper_noun' && confidence >= 0.9,
      sourceUsesValidWords: meta.sourceUsesValidWords === true,
      reason: category === 'proper_noun' ? 'Gemini named-term ASR correction at Anki save' : 'Gemini Anki pre-save ASR correction',
      confidence
    };
  });

  // 自動辞書学習は SOURCE TEXT と最終 correctedText の直接対応だけを使う。
  // namedTerms は「最終文のどの範囲が固有名詞か」を示すフィルタにだけ使い、
  // from/to の文字列生成には使わない。
  const learnPairs = buildDirectProperNameLearningPairs(
    dictionaryRootSourceText,
    correctedText,
    namedTerms,
    returnedCorrections
  );
  const learningDiagnostics = [];
  let userDictionaryLearnedCount = 0;
  if (learnPairs.length) {
    userDictionaryLearnedCount = await learnUserCorrectionPairs(
      learnPairs,
      'gemini-card-proper',
      { sourceText: dictionaryRootSourceText, correctedText },
      learningDiagnostics
    );
    if (userDictionaryLearnedCount) {
      console.info('Gemini named-term knowledge saved to user dictionary', learnPairs);
    }
  }

  await appendGeminiDebugLog({
    kind: 'review',
    ok: true,
    status: 'reviewed',
    buildInfo: {
      manifestVersion: chrome.runtime.getManifest().version,
      backgroundBuild: EXTENSION_BUILD,
      promptVersion: GEMINI_PROMPT_VERSION,
      geminiModel: GEMINI_REVIEW_MODEL,
      reviewModel: GEMINI_REVIEW_MODEL,
      translationModel: GEMINI_TRANSLATION_MODEL
    },
    sourceText: text,
    dictionaryRootSourceText,
    correctedTextRaw: cleanCaptionText(result.value?.correctedText || ''),
    correctedTextFinal: correctedText,
    video: { title: String(context?.title || ''), channelName: String(context?.channelName || ''), url: String(context?.url || '') },
    contextSent: {
      title: String(context?.title || ''),
      channelName: String(context?.channelName || ''),
      description: String(context?.description || ''),
      contextBefore: String(context?.contextBefore || ''),
      contextAfter: String(context?.contextAfter || '')
    },
    namedTermsAuditComplete: result.value?.namedTermsAuditComplete === true,
    rawEntityChecks,
    rawNamedTerms: Array.isArray(result.value?.namedTerms) ? result.value.namedTerms : [],
    acceptedNamedTerms: namedTerms,
    rawCorrections: rawReturnedCorrections,
    effectiveCorrectionMetadata: returnedCorrections,
    finalCorrections: corrections,
    learningCandidates: learnPairs,
    learningDiagnostics,
    userDictionaryLearnedCount,
    requestPrompt: String(result?.debug?.requestPrompt || ''),
    rawResponseText: String(result?.debug?.rawResponseText || ''),
    usageMetadata: result?.debug?.usageMetadata || null
  });

  return {
    text: correctedText,
    corrected: correctedText !== text,
    corrections,
    userDictionaryLearnedCount,
    status: 'reviewed'
  };
}

async function finalizeCapture(tabId, config, tab, context) {
  if (String(context?.videoId || '')) {
    await assertTranscriptVideoMatchesCurrentTab(tabId, String(context.videoId || ''));
  }
  let captionText = cleanCaptionText(context.text || '');
  let subtitleMissing = false;
  if (!captionText) {
    subtitleMissing = true;
    captionText = '[字幕取得失敗：あとで原文を入力]';
  }

  const captured = await captureAudioForContext(tabId, config, context, subtitleMissing);
  const { audio, audioAligned, audioRangeCapped } = captured;

  // Gemini APIはAnkiカード保存時だけ実行する。
  // 動画URL・タイトル・チャンネル・説明欄と前後字幕を考慮し、固有名詞のASR誤認識、
  // 明らかな噛み/false start/誤重複など、実際の音声転写ミスだけを直す。
  // Geminiが高確信度の固有名詞を修正した場合だけユーザー辞書へ学習する。
  // 失敗/タイムアウト/無料枠制限時は元字幕のままAnkiへ保存する。
  let cardAi = { text: captionText, corrected: false, corrections: [], userDictionaryLearnedCount: 0, status: 'not-run' };
  if (!subtitleMissing && config.aiProofreadEnabled !== false) {
    try {
      await toastTab(tabId, 'Anki保存前にGeminiで最終校閲中…');
      cardAi = await reviewCaptionTextBeforeAnki(tabId, config, context, captionText);
      captionText = cleanCaptionText(cardAi.text || captionText) || captionText;
    } catch (err) {
      console.warn('Anki pre-save Gemini review failed; using original caption', err);
      cardAi = { text: captionText, corrected: false, corrections: [], userDictionaryLearnedCount: 0, status: 'failed' };
    }
  }

  return await commitCaptureToAnki(tabId, config, tab, context, audio, captionText, {
    subtitleMissing,
    audioAligned,
    audioRangeCapped,
    cardAiCorrected: !!cardAi.corrected,
    cardAiCorrectionCount: Array.isArray(cardAi.corrections) ? cardAi.corrections.length : 0,
    cardAiStatus: String(cardAi.status || 'not-run'),
    userDictionaryLearnedCount: Number(cardAi.userDictionaryLearnedCount || 0)
  });
}

async function captureAudioForContext(tabId, config, context, subtitleMissing) {
  let audio = null;
  let audioAligned = false;
  let audioRangeCapped = false;
  if (!subtitleMissing && config.audioAlignToSentence !== false
      && Number.isFinite(Number(context.sentenceStart)) && Number.isFinite(Number(context.sentenceEnd))) {
    try {
      const sentenceStart = Math.max(0, Number(context.sentenceStart));
      const sentenceEnd = Math.max(sentenceStart, Number(context.sentenceEnd));
      const explicitTranscriptSelection = ['transcript-word-range', 'transcript-panel-selection']
        .includes(String(context?.captionSource || ''));

      // 明示選択は字幕パネルの絶対動画タイムコードを基準にする。
      // 「保存時点から何秒前」という逆算は使わないため、一時停止後に待ってから保存してもズレない。
      // その正確な選択範囲に対して、手動選択でも文頭・文末の音声余裕を追加する。
      // 手動選択時は「調整」ではなく安全余裕として扱い、設定値の絶対値ぶんだけ
      // 開始を前へ・v7.1で補正済みの終了を後ろへ広げる。
      const prePadding = explicitTranscriptSelection
        ? Math.max(0, Math.min(8, Math.abs(Number(config.audioPrePadding) || 0)))
        : Math.max(-8, Math.min(8, Number(config.audioPrePadding) || 0));
      const postPadding = explicitTranscriptSelection
        ? Math.max(0, Math.min(8, Math.abs(Number(config.audioPostPadding) || 0)))
        : Math.max(-8, Math.min(8, Number(config.audioPostPadding) || 0));
      let desiredStart = Math.max(0, sentenceStart - prePadding);
      let desiredEnd = Math.max(0, sentenceEnd + postPadding);
      if (desiredEnd < desiredStart + 0.08) desiredEnd = desiredStart + 0.08;

      const maxAlignedSeconds = Math.max(8, Math.min(35, Number(config.audioMaxAlignedSeconds) || 18));
      if (!explicitTranscriptSelection && desiredEnd - desiredStart > maxAlignedSeconds) {
        desiredStart = Math.max(0, desiredEnd - maxAlignedSeconds);
        audioRangeCapped = true;
      }

      // 選択範囲の終端がまだ未来なら、そこまで再生された後でタイムライン同期点を得る。
      let state = await getCurrentVideoState(tabId);
      let captureNow = Number.isFinite(state.currentTime) ? state.currentTime : Number(context.currentTime) || 0;
      let playbackRate = Math.max(0.25, Number(state.playbackRate || context.playbackRate) || 1);
      const needFutureVideoSeconds = Math.max(0, desiredEnd - captureNow);
      if (!state.paused && needFutureVideoSeconds > 0) {
        const waitMs = Math.min(3500, Math.ceil((needFutureVideoSeconds / playbackRate) * 1000) + 300);
        if (waitMs > 0) await delay(waitMs);
      }

      // 待機後の動画位置を必ず取り直し、保存ボタンを押した瞬間の同期点もoffscreenへ送る。
      // Content側は250ms周期なので、字幕終端付近で一時停止して即保存すると、最後の同期点が
      // 選択終端より少し手前のままになることがある。ここで最新点を追加して境界欠落を防ぐ。
      state = await getCurrentVideoState(tabId);
      captureNow = Number.isFinite(state.currentTime) ? state.currentTime : captureNow;
      playbackRate = Math.max(0.25, Number(state.playbackRate || playbackRate) || 1);
      try {
        await chrome.runtime.sendMessage({
          target: 'offscreen',
          type: 'OFFSCREEN_TIMELINE_SYNC',
          currentTime: captureNow,
          playbackRate,
          paused: !!state.paused,
          sentAtMs: Date.now()
        });
      } catch {}

      const captureVideoRange = async (startVideoTime, endVideoTime) => {
        return await chrome.runtime.sendMessage({
          target: 'offscreen',
          type: 'OFFSCREEN_CAPTURE_VIDEO_RANGE',
          startVideoTime,
          endVideoTime
        });
      };

      // まずv7.2どおり、選択範囲＋設定した前後paddingを完全な形で切り出す。
      audio = await captureVideoRange(desiredStart, desiredEnd);
      audioAligned = !!audio?.ok;

      if ((!audio?.ok || !audio.data) && explicitTranscriptSelection) {
        // 手動選択ではpadding部分がまだ再生されていないだけで、本文自体は録音済みというケースがある。
        // 例: 文末で一時停止して即保存したとき、+0.5秒のpost paddingだけ未来になる。
        // その場合にカード全体を失敗させず、まず「実際に再生済みの範囲までpaddingを縮める」。
        const playedEnd = Number.isFinite(captureNow) ? Math.max(0, captureNow) : sentenceEnd;
        const reducedEnd = Math.max(sentenceEnd, Math.min(desiredEnd, playedEnd));
        if (reducedEnd > desiredStart + 0.08 && reducedEnd < desiredEnd - 0.01) {
          const reduced = await captureVideoRange(desiredStart, reducedEnd);
          if (reduced?.ok && reduced.data) {
            audio = reduced;
            audioAligned = true;
          }
        }

        // pre/post paddingのどちらかが録音開始前・シーク境界・一時停止後にはみ出していても、
        // 選択した本文そのものが連続再生済みなら、その正確な本文範囲で最後に救済する。
        // 本文のstart/endは変更しないので、別時刻の音声へフォールバックすることはない。
        if (!audio?.ok || !audio.data) {
          const core = await captureVideoRange(sentenceStart, sentenceEnd);
          if (core?.ok && core.data) {
            audio = core;
            audioAligned = true;
          }
        }
      }

      if (!audio?.ok || !audio.data) {
        // 自動取得のみ旧方式へフォールバック。明示選択では本文範囲まで試しても
        // タイムラインが無い場合だけエラーにする。
        if (explicitTranscriptSelection) {
          throw new Error(audio?.error || '選択した動画タイムコードを録音バッファに対応付けられませんでした');
        }
        state = await getCurrentVideoState(tabId);
        captureNow = Number.isFinite(state.currentTime) ? state.currentTime : captureNow;
        playbackRate = Math.max(0.25, Number(state.playbackRate || playbackRate) || 1);
        const startAgoVideo = Math.max(0, captureNow - desiredStart);
        const endAgoVideo = Math.max(0, captureNow - desiredEnd);
        audio = await chrome.runtime.sendMessage({
          target: 'offscreen',
          type: 'OFFSCREEN_CAPTURE_RANGE',
          startAgoSeconds: startAgoVideo / playbackRate,
          endAgoSeconds: endAgoVideo / playbackRate
        });
        audioAligned = !!audio?.ok;
      }
    } catch (err) {
      console.warn('sentence-aligned audio failed', err);
      const explicitTranscriptSelection = ['transcript-word-range', 'transcript-panel-selection']
        .includes(String(context?.captionSource || ''));
      if (explicitTranscriptSelection) throw err;
    }
  }

  if (!audio?.ok || !audio.data) {
    audio = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'OFFSCREEN_CAPTURE',
      seconds: Math.max(2, Math.min(30, Number(config.audioSeconds) || 8))
    });
    audioAligned = false;
  }
  if (!audio?.ok || !audio.data) throw new Error(audio?.error || '音声を切り出せませんでした');
  return { audio, audioAligned, audioRangeCapped };
}

async function commitCaptureToAnki(tabId, config, tab, context, audio, captionText, meta = {}) {
  const subtitleMissing = !!meta.subtitleMissing;
  const audioAligned = !!meta.audioAligned;
  const audioRangeCapped = !!meta.audioRangeCapped;
  const cardAiCorrected = !!meta.cardAiCorrected;
  const cardAiCorrectionCount = Number(meta.cardAiCorrectionCount || 0);
  const cardAiStatus = String(meta.cardAiStatus || 'not-run');
  const userDictionaryLearnedCount = Number(meta.userDictionaryLearnedCount || 0);

  let translation = '';
  let vocabulary = [];
  let mnemonicsHtml = '';
  let translationError = '';
  let mnemonicsField = '';

  // v8.4: 日本語訳と単語・熟語はNote等の任意フィールドではなく、
  // Enhanced ClozeのMnemonicsフィールドへ一本化する。
  // API呼び出しを増やさず、Gemini 3.1 Flash-Liteの1回の応答で両方を生成する。
  if (!subtitleMissing && config.translationEnabled) {
    try {
      const modelFields = await ankiInvoke('modelFieldNames', { modelName: config.modelName });
      mnemonicsField = (modelFields || []).find(x => String(x) === 'Mnemonics')
        || (modelFields || []).find(x => String(x).toLowerCase() === 'mnemonics')
        || '';
      if (!mnemonicsField) {
        throw new Error(`ノートタイプ「${config.modelName}」にMnemonicsフィールドがありません`);
      }
      if ([config.contentField, config.audioField].includes(mnemonicsField)) {
        throw new Error('Mnemonicsフィールドを本文または音声フィールドと共用することはできません');
      }

      const translationPayload = {
        text: captionText,
        title: String(context?.title || ''),
        channelName: String(context?.channelName || ''),
        url: String(context?.url || ''),
        description: String(context?.description || ''),
        contextBefore: String(context?.contextBefore || ''),
        contextAfter: String(context?.contextAfter || ''),
        customInstruction: String(config.geminiStudyNoteInstruction || DEFAULT_GEMINI_STUDY_NOTE_INSTRUCTION)
      };
      const translated = await translateWithGemini(config.geminiApiKey, translationPayload);
      await appendGeminiDebugLog({
        kind: 'translation',
        ok: !!translated?.ok,
        status: String(translated?.reason || (translated?.ok ? 'translated+vocabulary' : 'failed')),
        buildInfo: {
          manifestVersion: chrome.runtime.getManifest().version,
          backgroundBuild: EXTENSION_BUILD,
          translationModel: GEMINI_TRANSLATION_MODEL
        },
        sourceText: captionText,
        translatedText: String(translated?.translation || ''),
        vocabulary: Array.isArray(translated?.vocabulary) ? translated.vocabulary : [],
        video: { title: translationPayload.title, channelName: translationPayload.channelName, url: translationPayload.url },
        contextSent: {
          title: translationPayload.title,
          channelName: translationPayload.channelName,
          description: translationPayload.description,
          contextBefore: translationPayload.contextBefore,
          contextAfter: translationPayload.contextAfter
        },
        customInstruction: String(translated?.debug?.customInstruction || translationPayload.customInstruction || ''),
        systemInstruction: String(translated?.debug?.systemInstruction || ''),
        requestPrompt: String(translated?.debug?.requestPrompt || ''),
        rawResponseText: String(translated?.debug?.rawResponseText || ''),
        usageMetadata: translated?.debug?.usageMetadata || null,
        error: String(translated?.error || '')
      });
      if (!translated?.ok) throw new Error(translated?.error || translated?.reason || 'Gemini翻訳・語彙抽出に失敗しました');
      translation = String(translated.translation || '').trim();
      vocabulary = normalizeVocabularyItems(translated.vocabulary);
      mnemonicsHtml = buildMnemonicsHtml(translation, vocabulary);
    } catch (err) {
      translationError = err.message || String(err);
      console.warn('Gemini translation/vocabulary failed', err);
    }
  }

  const clozed = toWordCloze(captionText);
  const videoId = getVideoId(context.url || tab.url || '') || 'video';
  const sec = Math.max(0, Math.floor(Number(context.currentTime) || Number(context.sentenceStart) || 0));
  const sourcePrefix = getSupportedPlatform(context.url || tab.url || '') === 'netflix' ? 'nf' : 'yt';
  const filename = `${sourcePrefix}_dictation_${sanitizeFilePart(videoId)}_${sec}_${Date.now()}.wav`;
  const fields = {};
  const combinedContentAudio = config.contentField === config.audioField;

  if (combinedContentAudio) {
    await ankiInvoke('storeMediaFile', { filename, data: audio.data });
    fields[config.contentField] = `[sound:${filename}]<br><br>${clozed}`;
  } else {
    fields[config.contentField] = clozed;
    fields[config.audioField] = '';
  }
  if (mnemonicsField) fields[mnemonicsField] = mnemonicsHtml;
  if (config.sourceField) {
    const sourceHtml = buildSourceHtml(context, sec);
    if (config.sourceField === mnemonicsField) {
      fields[mnemonicsField] = [fields[mnemonicsField], sourceHtml].filter(Boolean).join('<br><br>');
    } else {
      fields[config.sourceField] = sourceHtml;
    }
  }

  const note = {
    deckName: config.deckName,
    modelName: config.modelName,
    fields,
    options: { allowDuplicate: true }
  };
  if (!combinedContentAudio) {
    note.audio = { filename, data: audio.data, fields: [config.audioField] };
  }

  const noteId = await ankiInvoke('addNote', { note });
  const preview = captionText.length > 74 ? captionText.slice(0, 74) + '…' : captionText;
  const geminiLabel = cardAiCorrected
    ? `・Gemini校閲${cardAiCorrectionCount ? `(${cardAiCorrectionCount}件)` : ''}`
    : cardAiStatus === 'reviewed'
      ? '・Gemini確認済(修正なし)'
      : cardAiStatus === 'gemini-timeout'
        ? '・Geminiタイムアウト(原文保存)'
        : cardAiStatus === 'gemini-rate-limit'
          ? '・Gemini上限到達(原文保存)'
          : cardAiStatus === 'gemini-key-missing'
            ? '・Geminiキー未設定(原文保存)'
            : (cardAiStatus !== 'not-run' ? '・Gemini失敗(原文保存)' : '');
  const dictionaryLearnLabel = userDictionaryLearnedCount > 0 ? `・ユーザー辞書登録${userDictionaryLearnedCount}件` : '';
  const alignmentLabel = `${audioAligned ? '・文に合わせた音声' : ''}${geminiLabel}${dictionaryLearnLabel}`;
  const toastMessage = subtitleMissing
    ? `Ankiへ保存（字幕なし）: ${preview}`
    : translationError
      ? `Ankiへ保存（翻訳失敗${alignmentLabel}）: ${preview}`
      : translation
        ? `Ankiへ保存＋訳/語彙${alignmentLabel}: ${preview}`
        : `Ankiへ保存${alignmentLabel}: ${preview}`;
  await toastTab(tabId, toastMessage, subtitleMissing || !!translationError);
  return { ok: true, noteId, captionText, clozed, translation, vocabulary, mnemonicsHtml, translationError, subtitleMissing, audioAligned, audioRangeCapped, cardAiCorrected, cardAiCorrectionCount, cardAiStatus, userDictionaryLearnedCount, audioSeconds: audio.seconds };
}

function refineTranscriptText(transcript, dictionaryText) {
  const out = { ...transcript, cues: (transcript.cues || []).map(c => ({ ...c, words: (c.words || []).map(w => ({ ...w })) })) };
  const corrections = [];

  // 1) まず各文の「明らかなASR重複・言い直し」を除去する。
  for (const cue of out.cues) {
    const before = joinTranscriptWords(cue.words || []);
    cue.rawText = cue.rawText || cue.text || before;
    cue.words = collapseObviousAsrRepeats(cue.words || [], corrections, cue.start);
    cue.text = joinTranscriptWords(cue.words);
    if (!cue.text) cue.text = cleanCaptionText(cue.rawText || '');
  }

  const entries = dictionaryText ? parseHololiveDictionary(dictionaryText) : [];
  if (entries.length) {
    // 2) 辞書の完全一致・既知の認識揺れを文章表示の段階で補正する。
    const phraseEntries = buildDictionaryPhraseEntries(entries);
    for (const cue of out.cues) {
      cue.words = applyDictionaryToWordObjects(cue.words || [], phraseEntries, corrections, cue.start);
      cue.text = joinTranscriptWords(cue.words);
    }

    // 3) 動画全体を一度見てから、タイトル/チャンネル/同一動画内頻度を使い、
    //    Holo固有名詞らしい綴り間違いだけを保守的に補正する。
    const corpusCounts = new Map();
    for (const cue of out.cues) {
      for (const word of cue.words || []) {
        const k = transcriptWordKeyForCorrection(word.text);
        if (k) corpusCounts.set(k, (corpusCounts.get(k) || 0) + 1);
      }
    }
    const contextText = `${out.title || ''} ${out.channelName || ''}`.trim();
    const contextKeyText = ` ${normalizeCorrectionText(contextText)} `;
    const tokenCandidates = buildHololiveTokenCandidates(entries);
    const knownContextHits = tokenCandidates.filter(c => contextKeyText.includes(` ${c.key} `)).length;
    const channelLooksHolo = /\b(?:hololive|holoen|holo\s*english|cover\s*corp|holostars)\b/i.test(contextText)
      || /hololive|ホロライブ/i.test(out.channelName || '')
      || knownContextHits > 0;
    const corpusKnownHits = tokenCandidates.reduce((n, c) => n + ((corpusCounts.get(c.key) || 0) >= 2 ? 1 : 0), 0);
    const holoContext = channelLooksHolo || corpusKnownHits >= 2;
    // 曖昧補正は、タイトル/チャンネルに実名が出ているか、同じ動画内で正しい綴りが
    // 複数回確認できた固有名詞だけを候補にする。長時間動画でも全辞書との総当たりを避ける。
    const contextualCandidates = tokenCandidates.filter(c =>
      contextKeyText.includes(` ${c.key} `) || (corpusCounts.get(c.key) || 0) >= 2
    );

    for (const cue of out.cues) {
      cue.words = cue.words.map(word => {
        const corrected = fuzzyCorrectHololiveWord(word, contextualCandidates, corpusCounts, contextKeyText, holoContext);
        if (corrected && corrected.text !== word.text) {
          corrections.push({
            type: 'holo-context',
            from: word.text,
            to: corrected.text,
            at: Number(word.start || cue.start || 0)
          });
          return corrected;
        }
        return word;
      });
      cue.text = joinTranscriptWords(cue.words);
    }
  }

  // 最終的な単語番号を振り直す。開始/終了時刻は元YouTube字幕の情報を維持する。
  let globalIndex = 0;
  out.cues = out.cues.filter(cue => Array.isArray(cue.words) && cue.words.length).map(cue => {
    const words = cue.words.map(word => ({ ...word, globalIndex: globalIndex++ }));
    const text = joinTranscriptWords(words);
    return {
      ...cue,
      text,
      start: Number.isFinite(Number(words[0]?.start)) ? Number(words[0].start) : cue.start,
      end: Number.isFinite(Number(words[words.length - 1]?.end)) ? Number(words[words.length - 1].end) : cue.end,
      words
    };
  });
  out.correctionCount = corrections.length;
  out.corrections = corrections.slice(0, 120);
  out.captionRefined = true;
  return out;
}

function normalizeCorrectionText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function transcriptWordKeyForCorrection(text) {
  return normalizeCorrectionText(String(text || '').replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, ''));
}

function splitWordPunctuation(text) {
  const raw = String(text || '');
  const m = raw.match(/^([^\p{L}\p{N}']*)(.*?)([^\p{L}\p{N}']*)$/u);
  return m ? { prefix: m[1] || '', core: m[2] || '', suffix: m[3] || '' } : { prefix: '', core: raw, suffix: '' };
}

function joinTranscriptWords(words) {
  return cleanCaptionText((words || []).map(w => String(w?.text || '')).filter(Boolean).join(' '))
    .replace(/\s+([,.;:!?…%])/g, '$1')
    .replace(/([\(\[\{“‘])\s+/g, '$1')
    .replace(/\s+([’']s)\b/gi, '$1')
    .trim();
}

function collapseObviousAsrRepeats(inputWords, corrections, cueStart = 0) {
  let words = (inputWords || []).map(w => ({ ...w }));
  const keyAt = i => transcriptWordKeyForCorrection(words[i]?.text);
  const singleRepeatSafe = new Set([
    'i','you','he','she','we','they','it','this','that','what','why','how','when','where','who',
    'a','an','the','to','of','in','on','at','for','with','from','and','but','or','so','because',
    'is','are','am','was','were','be','been','have','has','had','do','does','did','can','could',
    'will','would','should','may','might','must','um','uh','erm','hmm'
  ]);

  let guard = 0;
  while (guard++ < 80) {
    let changed = false;

    // 「I might have I might have」のような、2語以上の直後反復は後半を残す。
    outer: for (let i = 0; i < words.length; i++) {
      const maxN = Math.min(10, Math.floor((words.length - i) / 2));
      for (let n = maxN; n >= 2; n--) {
        const a = words.slice(i, i + n).map(w => transcriptWordKeyForCorrection(w.text));
        const b = words.slice(i + n, i + 2 * n).map(w => transcriptWordKeyForCorrection(w.text));
        if (a.some(x => !x) || b.some(x => !x)) continue;
        if (a.every((x, j) => x === b[j])) {
          const from = joinTranscriptWords(words.slice(i, i + 2 * n));
          const to = joinTranscriptWords(words.slice(i + n, i + 2 * n));
          corrections.push({ type: 'repeat-phrase', from, to, at: Number(words[i]?.start || cueStart || 0) });
          words.splice(i, n); // 言い直し前の前半を削る
          changed = true;
          break outer;
        }
      }
    }
    if (changed) continue;

    for (let i = 0; i < words.length - 1; i++) {
      const a = keyAt(i), b = keyAt(i + 1);
      if (!a || !b) continue;
      const leftRaw = String(words[i]?.text || '');
      const partial = /[-–—]$/.test(leftRaw) && (b.startsWith(a) || a.startsWith(b));
      const triple = i + 2 < words.length && b === transcriptWordKeyForCorrection(words[i + 2]?.text);
      if (partial || (a === b && (singleRepeatSafe.has(a) || triple))) {
        corrections.push({
          type: partial ? 'false-start' : 'repeat-word',
          from: `${words[i].text} ${words[i + 1].text}`,
          to: words[i + 1].text,
          at: Number(words[i]?.start || cueStart || 0)
        });
        words.splice(i, 1); // 後から言い直した方を残す
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }
  return words;
}

function buildDictionaryPhraseEntries(entries) {
  const seen = new Set();
  const out = [];
  for (const entry of entries || []) {
    const aliasTokens = normalizeCorrectionText(entry.alias).split(/\s+/).filter(Boolean);
    if (!aliasTokens.length) continue;
    const id = `${entry.canonical}\u0000${aliasTokens.join(' ')}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ canonical: entry.canonical, alias: entry.alias, aliasTokens });
  }
  return out.sort((a, b) => b.aliasTokens.length - a.aliasTokens.length || b.alias.length - a.alias.length);
}

function distributeReplacementWords(canonical, sourceWords, correctionNote) {
  const canonicalTokens = String(canonical || '').trim().split(/\s+/).filter(Boolean);
  if (!canonicalTokens.length || !sourceWords.length) return sourceWords;
  const start = Number(sourceWords[0].start || 0);
  const end = Math.max(start + 0.015, Number(sourceWords[sourceWords.length - 1].end || start + 0.02));
  const prefix = splitWordPunctuation(sourceWords[0].text).prefix;
  const suffix = splitWordPunctuation(sourceWords[sourceWords.length - 1].text).suffix;
  const weights = canonicalTokens.map(t => Math.max(1, transcriptWordKeyForCorrection(t).length || 1));
  const total = weights.reduce((a, b) => a + b, 0) || canonicalTokens.length;
  let acc = 0;
  return canonicalTokens.map((token, i) => {
    const ws = start + (end - start) * (acc / total);
    acc += weights[i];
    const we = start + (end - start) * (acc / total);
    let text = token;
    if (i === 0 && prefix) text = prefix + text;
    if (i === canonicalTokens.length - 1 && suffix && !text.endsWith(suffix)) text += suffix;
    return {
      ...sourceWords[Math.min(i, sourceWords.length - 1)],
      text,
      start: ws,
      end: Math.max(ws + 0.015, we),
      correctionNote,
      originalText: joinTranscriptWords(sourceWords)
    };
  });
}

function applyDictionaryToWordObjects(inputWords, phraseEntries, corrections, cueStart = 0) {
  const words = (inputWords || []).map(w => ({ ...w }));
  let i = 0;
  while (i < words.length) {
    let matched = false;
    for (const entry of phraseEntries) {
      const n = entry.aliasTokens.length;
      if (i + n > words.length) continue;
      const seq = words.slice(i, i + n).map(w => transcriptWordKeyForCorrection(w.text));
      if (!seq.every((x, j) => x === entry.aliasTokens[j])) continue;
      const original = joinTranscriptWords(words.slice(i, i + n));
      const originalKey = normalizeCorrectionText(original);
      const canonicalKey = normalizeCorrectionText(entry.canonical);
      const exactSurface = original.replace(/[.,!?…]+$/,'') === entry.canonical;
      if (exactSurface) { i += n; matched = true; break; }
      const replacement = distributeReplacementWords(entry.canonical, words.slice(i, i + n), `${original} → ${entry.canonical}`);
      words.splice(i, n, ...replacement);
      if (originalKey !== canonicalKey || original !== entry.canonical) {
        corrections.push({ type: 'holo-dictionary', from: original, to: entry.canonical, at: Number(replacement[0]?.start || cueStart || 0) });
      }
      i += replacement.length;
      matched = true;
      break;
    }
    if (!matched) i++;
  }
  return words;
}

function buildHololiveTokenCandidates(entries) {
  const excluded = new Set([
    'english','indonesia','project','friend','corp','corporation','current','official','roster',
    'myth','promise','advent','justice','council','hope','staff','alumni','group','terms','hololive'
  ]);
  const map = new Map();
  for (const { canonical } of entries || []) {
    for (const token of String(canonical || '').split(/\s+/)) {
      const key = transcriptWordKeyForCorrection(token);
      if (key.length < 4 || excluded.has(key)) continue;
      const clean = splitWordPunctuation(token).core || token;
      if (!map.has(key)) map.set(key, { key, text: clean });
    }
  }
  return [...map.values()];
}

function correctionEditDistance(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const cur = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

function correctionPhoneticKey(text) {
  return transcriptWordKeyForCorrection(text)
    .replace(/l/g, 'r')
    .replace(/y/g, 'i')
    .replace(/ph/g, 'f')
    .replace(/[cq]/g, 'k')
    .replace(/b/g, 'v')
    .replace(/(.)\1+/g, '$1');
}

function fuzzyCorrectHololiveWord(word, candidates, corpusCounts, contextKeyText, holoContext) {
  const originalKey = transcriptWordKeyForCorrection(word?.text);
  if (!originalKey || originalKey.length < 4 || /\d/.test(originalKey)) return null;
  if (candidates.some(c => c.key === originalKey)) return null;

  let best = null;
  let second = null;
  for (const candidate of candidates) {
    if (Math.abs(candidate.key.length - originalKey.length) > 2) continue;
    const distance = correctionEditDistance(originalKey, candidate.key);
    const phonetic = correctionPhoneticKey(originalKey) === correctionPhoneticKey(candidate.key);
    const inContext = contextKeyText.includes(` ${candidate.key} `);
    const count = corpusCounts.get(candidate.key) || 0;
    if (distance > 2 && !phonetic) continue;
    // 呼び出し側ですでに「タイトル/チャンネルにある」または「同一動画で2回以上確認」の
    // 候補だけへ絞っているため、辞書にあるだけの一般語へは寄せない。
    if (!inContext && count < 2) continue;
    let score = 30 - distance * 6;
    if (phonetic) score += 8;
    if (inContext) score += 15;
    if (count >= 2) score += Math.min(10, 2 + count);
    if (holoContext) score += 2;
    const item = { ...candidate, score, distance };
    if (!best || item.score > best.score) { second = best; best = item; }
    else if (!second || item.score > second.score) second = item;
  }
  if (!best || best.score < 33) return null;
  if (second && best.score - second.score < 4) return null;

  const parts = splitWordPunctuation(word.text);
  const text = `${parts.prefix}${best.text}${parts.suffix}`;
  return {
    ...word,
    text,
    originalText: word.text,
    correctionNote: `${word.text} → ${text}（動画文脈/Holo辞書）`
  };
}

function parseHololiveDictionary(text) {
  const entries = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    const canonical = (eq >= 0 ? line.slice(0, eq) : line).trim();
    if (!canonical) continue;
    const aliases = eq >= 0 ? line.slice(eq + 1).split(',').map(x => x.trim()).filter(Boolean) : [];
    const all = [canonical, ...aliases];
    for (const alias of all) {
      if (!alias) continue;
      entries.push({ canonical, alias });
    }
  }
  // Longest phrases first so "hololive English" is corrected before "hololive".
  entries.sort((a, b) => b.alias.split(/\s+/).length - a.alias.split(/\s+/).length || b.alias.length - a.alias.length);
  return entries;
}

function applyHololiveDictionary(text, dictionaryText) {
  let out = cleanCaptionText(text || '');
  if (!out) return out;
  const entries = parseHololiveDictionary(dictionaryText || globalThis.HOLOLIVE_DICTIONARY_DEFAULT || '');
  // Replacement results are protected with placeholders until every alias has
  // been tested. This prevents a short alias inside a canonical name from being
  // expanded a second time (e.g. "Ninomae Ina'nis" -> "Ninomae Ninomae Ina'nis").
  const protectedValues = [];
  for (const { canonical, alias } of entries) {
    const escaped = escapeRegExp(alias).replace(/[’']/g, "['’]");
    try {
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${escaped})(?=$|[^\\p{L}\\p{N}])`, 'giu');
      out = out.replace(re, (_, prefix) => {
        const index = protectedValues.push(canonical) - 1;
        return `${prefix}\uE000${index}\uE001`;
      });
    } catch {}
  }
  out = out.replace(/\uE000(\d+)\uE001/g, (_, index) => protectedValues[Number(index)] ?? '');
  return out.replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
}


const STANDARD_AUTOCORRECT_RISKY_ALIASES = new Set([
  'crony', 'bales', 'pebble', 'ruffian', 'hope', 'myth', 'promise', 'council',
  'friend', 'callie', 'cali', 'ame', 'kfp', 'deadbeats', 'bay'
]);

function normalizeLearnedEntry(raw, layer = '') {
  if (!raw || typeof raw !== 'object') return null;
  const from = cleanCaptionText(raw.from || '');
  const to = cleanCaptionText(raw.to || '');
  if (!from || !to || from === to) return null;
  return {
    id: String(raw.id || `${layer}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`),
    from,
    to,
    layer: layer || String(raw.layer || ''),
    createdAt: Number(raw.createdAt || Date.now()),
    updatedAt: Number(raw.updatedAt || raw.createdAt || Date.now()),
    count: Math.max(1, Number(raw.count || 1)),
    confidence: Number(raw.confidence || 0),
    reason: String(raw.reason || '').slice(0, 180),
    origin: String(raw.origin || (layer === 'user' ? 'manual' : layer || 'unknown')).slice(0, 40)
  };
}

function isSafeStandardAutocorrectAlias(alias, canonical) {
  const a = normalizeCorrectionText(alias);
  const c = normalizeCorrectionText(canonical);
  if (!a || !c || a === c) return false;
  if (STANDARD_AUTOCORRECT_RISKY_ALIASES.has(a)) return false;
  const at = a.split(/\s+/).filter(Boolean);
  const ct = c.split(/\s+/).filter(Boolean);
  if (!at.length || !ct.length || at.length > 4 || ct.length > 4) return false;

  // 同じ語数で各語が近いものは、Lyona→Riona / Zetha→Zeta / Flo Glee→FLOW GLOW のような
  // ASR綴り揺れとして安全に自動補正する。
  if (at.length === ct.length) {
    let totalDistance = 0;
    let allClose = true;
    for (let i = 0; i < at.length; i++) {
      const d = correctionEditDistance(at[i], ct[i]);
      const close = d <= (Math.max(at[i].length, ct[i].length) <= 6 ? 2 : 3)
        || correctionPhoneticKey(at[i]) === correctionPhoneticKey(ct[i]);
      if (!close) { allClose = false; break; }
      totalDistance += d;
    }
    if (allClose && totalDistance <= Math.max(3, at.length * 3)) return true;
  }

  // re gloss→ReGLOSS / holo-live→hololive のような分かち書き・記号差。
  const ac = a.replace(/\s+/g, '');
  const cc = c.replace(/\s+/g, '');
  const compactDistance = correctionEditDistance(ac, cc);
  if (Math.max(ac.length, cc.length) >= 5 && compactDistance <= Math.max(2, Math.floor(Math.max(ac.length, cc.length) * 0.28))) return true;
  return false;
}

function buildAutoDictionaryEntries(config) {
  const out = [];
  const seen = new Set();
  const push = (from, to, layer, priority, id = '') => {
    const source = cleanCaptionText(from || '');
    const target = cleanCaptionText(to || '');
    const key = normalizeCorrectionText(source);
    if (!source || !target || !key || source === target || seen.has(key)) return;
    seen.add(key);
    out.push({ from: source, to: target, layer, priority, id, tokens: key.split(/\s+/).filter(Boolean) });
  };

  // 1. ユーザー修正（最優先・ユーザーが明示したため完全一致なら常に適用）
  for (const raw of Array.isArray(config.userLearnedDictionary) ? config.userLearnedDictionary : []) {
    const e = normalizeLearnedEntry(raw, 'user');
    if (e) push(e.from, e.to, 'user', 300, e.id);
  }

  // 2. HOLO標準辞書。canonicalそのものではなく、安全と判定できる認識揺れだけ即時適用。
  if (config.hololiveDictionaryEnabled !== false) {
    const parsed = parseHololiveDictionary(String(config.hololiveDictionary || globalThis.HOLOLIVE_DICTIONARY_DEFAULT || ''));
    for (const e of parsed) {
      if (normalizeCorrectionText(e.alias) === normalizeCorrectionText(e.canonical)) continue;
      if (!isSafeStandardAutocorrectAlias(e.alias, e.canonical)) continue;
      push(e.alias, e.canonical, 'standard', 200);
    }
  }

  return out.sort((a, b) => b.tokens.length - a.tokens.length || b.priority - a.priority || b.from.length - a.from.length);
}

function applyCorrectionEntriesToWords(inputWords, entries, corrections, cueStart = 0) {
  const words = (inputWords || []).map(w => ({ ...w }));
  let i = 0;
  while (i < words.length) {
    let match = null;
    for (const entry of entries) {
      const n = entry.tokens.length;
      if (!n || i + n > words.length) continue;
      const seq = words.slice(i, i + n).map(w => transcriptWordKeyForCorrection(w.text));
      if (seq.every((x, j) => x === entry.tokens[j])) { match = entry; break; }
    }
    if (!match) { i++; continue; }
    const n = match.tokens.length;
    const sourceWords = words.slice(i, i + n);
    const original = joinTranscriptWords(sourceWords);
    const exactSurface = original.replace(/[.,!?…]+$/,'') === match.to;
    if (exactSurface) { i += n; continue; }
    const noteLabel = match.layer === 'user' ? 'ユーザー辞書' : 'HOLO標準辞書';
    const note = `${noteLabel}: ${original} → ${match.to}`;
    const replacement = distributeReplacementWords(match.to, sourceWords, note).map(w => ({
      ...w,
      dictionaryCorrected: true,
      dictionaryLayer: match.layer,
      originalText: original,
      correctionNote: note
    }));
    words.splice(i, n, ...replacement);
    corrections.push({
      type: `dictionary-${match.layer}`,
      from: original,
      to: match.to,
      at: Number(replacement[0]?.start || cueStart || 0),
      layer: match.layer
    });
    i += replacement.length;
  }
  return words;
}

async function applyKnownDictionaryCorrectionsToTranscript(transcript) {
  const config = await getSettings();
  const entries = buildAutoDictionaryEntries(config);
  const newCorrections = [];
  const out = {
    ...transcript,
    cues: (transcript.cues || []).map((cue, cueIndex) => ({
      ...cue,
      words: (cue.words || []).map(word => ({ ...word, _cueIndex: cueIndex }))
    }))
  };

  const flat = out.cues.flatMap(cue => cue.words || []);
  let i = 0;
  while (i < flat.length) {
    let match = null;
    for (const entry of entries) {
      const n = entry.tokens.length;
      if (!n || i + n > flat.length) continue;
      const seq = flat.slice(i, i + n).map(w => transcriptWordKeyForCorrection(w.text));
      if (seq.every((x, j) => x === entry.tokens[j])) { match = entry; break; }
    }
    if (!match) { i++; continue; }

    const n = match.tokens.length;
    const sourceWords = flat.slice(i, i + n);
    const original = joinTranscriptWords(sourceWords);
    const exactSurface = original.replace(/[.,!?…]+$/,'') === match.to;
    if (exactSurface) { i += n; continue; }
    const noteLabel = match.layer === 'user' ? 'ユーザー辞書' : 'HOLO標準辞書';
    const note = `${noteLabel}: ${original} → ${match.to}`;
    const replacement = distributeReplacementWords(match.to, sourceWords, note).map(w => ({
      ...w,
      _cueIndex: Number(sourceWords[0]?._cueIndex || 0),
      dictionaryCorrected: true,
      dictionaryLayer: match.layer,
      originalText: original,
      correctionNote: note
    }));
    flat.splice(i, n, ...replacement);
    newCorrections.push({
      type: `dictionary-${match.layer}`,
      from: original,
      to: match.to,
      at: Number(replacement[0]?.start || sourceWords[0]?.start || 0),
      layer: match.layer
    });
    i += replacement.length;
  }

  const byCue = new Map();
  for (const word of flat) {
    const cueIndex = Number(word._cueIndex || 0);
    if (!byCue.has(cueIndex)) byCue.set(cueIndex, []);
    byCue.get(cueIndex).push(word);
  }
  let globalIndex = 0;
  out.cues = out.cues.map((cue, cueIndex) => {
    const words = (byCue.get(cueIndex) || []).map(w => {
      const copy = { ...w, globalIndex: globalIndex++ };
      delete copy._cueIndex;
      return copy;
    });
    if (!words.length) return null;
    return {
      ...cue,
      words,
      text: joinTranscriptWords(words),
      start: Number(words[0]?.start ?? cue.start),
      end: Number(words[words.length - 1]?.end ?? cue.end)
    };
  }).filter(Boolean);

  const existing = Array.isArray(out.corrections) ? out.corrections : [];
  out.corrections = [...existing, ...newCorrections].slice(-240);
  out.dictionaryCorrectionCount = Number(out.dictionaryCorrectionCount || 0) + newCorrections.length;
  out.correctionCount = out.corrections.length;
  out.dictionaryRevision = Number(config.dictionaryRevision || 1);
  return out;
}

function looksLikeReusableTermCorrection(from, to, reason = '', category = '', confidence = 0) {
  const source = cleanCaptionText(from || '');
  const target = cleanCaptionText(to || '');
  if (!source || !target) return false;
  const sf = normalizeCorrectionText(source), st = normalizeCorrectionText(target);
  if (!sf || !st) return false;
  const explicitHighConfidenceProperNoun = String(category || '') === 'proper_noun' && Number(confidence || 0) >= 0.9;
  if (sf === st) {
    // zeta→Zeta / josé ramírez→José Ramírez のような表記統一を許可。
    // Unicodeの大文字も認識する。
    return source !== target && (explicitHighConfidenceProperNoun || /\p{Lu}/u.test(target));
  }
  const sTokens = sf.split(/\s+/), tTokens = st.split(/\s+/);
  if (sTokens.length > 4 || tTokens.length > 4 || source.length > 80 || target.length > 80) return false;
  const reasonText = String(reason || '').toLowerCase();
  if (/repeat|duplicate|false start|grammar|punctuation|filler/.test(reasonText)) return false;
  const targetRawTokens = target.split(/\s+/).filter(Boolean);
  // José / Ramírez / Fami-Chiki などASCII外のラテン文字も固有名詞らしい表記として扱う。
  const properLooking = targetRawTokens.some(t => /^\p{Lu}[\p{L}\p{M}\p{N}_+'’.-]*$/u.test(t));
  const compactDistance = correctionEditDistance(sf.replace(/\s/g,''), st.replace(/\s/g,''));
  const nearSpelling = compactDistance <= Math.max(2, Math.floor(Math.max(sf.length, st.length) * 0.35));
  const reasonLooksTerm = /name|proper|spelling|term|hololive|holo|asr|recognition/.test(reasonText);
  // Geminiがproper_nounを高確信度で明示した場合は、日本語など大文字概念のない固有名詞も許可する。
  return (properLooking || explicitHighConfidenceProperNoun) && (nearSpelling || reasonLooksTerm || explicitHighConfidenceProperNoun);
}

async function incrementDictionaryRevision() {
  const data = await chrome.storage.local.get({ dictionaryRevision: 1 });
  const revision = Number(data.dictionaryRevision || 1) + 1;
  await chrome.storage.local.set({ dictionaryRevision: revision });
  return revision;
}

function expandContextualCardDictionaryPair(pair, context = {}) {
  let from = cleanCaptionText(pair?.from || '');
  let to = cleanCaptionText(pair?.to || '');
  if (!from || !to) return { from, to, reusable: false };
  let reusable = pair?.reusable === true;
  const sourceUsesValidWords = pair?.sourceUsesValidWords === true; // diagnostic / AI self-report
  const fromTokens = from.split(/\s+/).filter(Boolean);
  const toTokens = to.split(/\s+/).filter(Boolean);

  // Anki最終校閲で『実在する普通の1語→固有語』をグローバル辞書化すると危険。
  // AIが whole→Holo のような1語差分を返した場合は、隣の変わっていない語を含めて
  // whole university→Holo university のような最小の安全なフレーズへ自動拡張する。
  if (originIsCard(context) && reusable && sourceUsesValidWords && fromTokens.length === 1 && toTokens.length === 1) {
    const sourceTokens = cleanCaptionText(context.sourceText || '').split(/\s+/).filter(Boolean);
    const correctedTokens = cleanCaptionText(context.correctedText || '').split(/\s+/).filter(Boolean);
    const key = transcriptWordKeyForCorrection(fromTokens[0]);
    let idx = sourceTokens.findIndex(t => transcriptWordKeyForCorrection(t) === key);
    if (idx >= 0 && sourceTokens.length === correctedTokens.length) {
      // 右隣を優先。例 whole university→Holo university。
      if (idx + 1 < sourceTokens.length
          && transcriptWordKeyForCorrection(sourceTokens[idx + 1]) === transcriptWordKeyForCorrection(correctedTokens[idx + 1])) {
        from = `${fromTokens[0]} ${sourceTokens[idx + 1]}`;
        to = `${toTokens[0]} ${correctedTokens[idx + 1]}`;
      } else if (idx > 0
          && transcriptWordKeyForCorrection(sourceTokens[idx - 1]) === transcriptWordKeyForCorrection(correctedTokens[idx - 1])) {
        from = `${sourceTokens[idx - 1]} ${fromTokens[0]}`;
        to = `${correctedTokens[idx - 1]} ${toTokens[0]}`;
      } else {
        reusable = false;
      }
    } else {
      reusable = false;
    }
  }
  return { from, to, reusable };
}

function originIsCard(context) {
  return String(context?.origin || 'gemini-card-proper').startsWith('gemini-card');
}

async function learnUserCorrectionPairs(pairs, origin = 'gemini-card', context = {}, diagnostics = null) {
  context = { ...(context || {}), origin };
  const debugRows = Array.isArray(diagnostics) ? diagnostics : null;
  const raw = await chrome.storage.local.get({ userLearnedDictionary: [] });
  let user = (Array.isArray(raw.userLearnedDictionary) ? raw.userLearnedDictionary : [])
    .map(e => normalizeLearnedEntry(e, 'user')).filter(Boolean);
  let changed = 0;
  let touched = false;

  for (const pair of pairs || []) {
    const row = {
      input: {
        from: cleanCaptionText(pair?.from || ''),
        to: cleanCaptionText(pair?.to || ''),
        category: String(pair?.category || ''),
        reusable: pair?.reusable === true,
        sourceUsesValidWords: pair?.sourceUsesValidWords === true,
        confidence: Number(pair?.confidence || 0),
        reason: String(pair?.reason || '')
      },
      status: 'pending'
    };
    const finish = (status, detail = '') => {
      row.status = status;
      if (detail) row.detail = detail;
      if (debugRows) debugRows.push(row);
    };

    // Gemini由来の自動学習は固有名詞修正だけ。
    if (String(origin).startsWith('gemini-card') && String(pair?.category || '') !== 'proper_noun') {
      finish('skipped', 'category is not proper_noun');
      continue;
    }
    const stabilized = expandContextualCardDictionaryPair(pair, context);
    row.stabilized = { from: stabilized.from, to: stabilized.to, reusable: stabilized.reusable === true };
    if (stabilized.reusable !== true) {
      finish('skipped', 'reusable=false after contextual safety check');
      continue;
    }
    const from = cleanCaptionText(stabilized.from || '');
    const to = cleanCaptionText(stabilized.to || '');
    const reason = String(pair?.reason || '');
    if (!looksLikeReusableTermCorrection(from, to, reason, pair?.category, pair?.confidence)) {
      finish('skipped', 'looksLikeReusableTermCorrection=false');
      continue;
    }
    const sourceKey = normalizeCorrectionText(from);
    const targetKey = normalizeCorrectionText(to);
    if (!sourceKey || !targetKey) {
      finish('skipped', 'normalized source/target is empty');
      continue;
    }

    const existing = user.find(e => normalizeCorrectionText(e.from) === sourceKey);
    if (existing) {
      row.existing = { from: existing.from, to: existing.to, count: Number(existing.count || 1) };
      if (normalizeCorrectionText(existing.to) === targetKey) {
        existing.count = Number(existing.count || 1) + 1;
        existing.updatedAt = Date.now();
        existing.confidence = Math.max(Number(existing.confidence || 0), Number(pair?.confidence || 0));
        touched = true;
        finish('confirmed-existing', 'same normalized mapping already exists');
      } else {
        finish('skipped', 'same source already maps to a different target');
      }
      continue;
    }

    user.push(normalizeLearnedEntry({
      id: `user:${Date.now()}:${Math.random().toString(36).slice(2,8)}`,
      from,
      to,
      count: 1,
      confidence: Number(pair?.confidence || 0),
      reason,
      origin,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }, 'user'));
    changed++;
    touched = true;
    finish('added', 'new user-dictionary mapping');
  }

  if (touched) {
    user = user.slice(-700);
    await chrome.storage.local.set({ userLearnedDictionary: user });
  }
  if (changed) await incrementDictionaryRevision();
  return changed;
}


async function saveUserTranscriptCorrection(words, replacement, senderTabId, transcriptVideoId = '') {
  const tabId = await getRecordingTabId();
  if (!tabId) throw new Error('先に「録音＋字幕パネル開始」を押してください');
  if (!senderTabId || senderTabId !== tabId) throw new Error('録音中の動画タブから修正してください');
  await assertTranscriptVideoMatchesCurrentTab(tabId, transcriptVideoId);
  if (!Array.isArray(words) || !words.length || words.length > 24) throw new Error('修正する単語範囲を選択してください（最大24語）');
  const visibleSource = joinTranscriptWords(words.map(w => ({ text: String(w?.text || '') })));
  const target = cleanCaptionText(replacement || '');
  if (!visibleSource || !target) throw new Error('修正前と修正後の文字列が必要です');
  if (normalizeCorrectionText(visibleSource) === normalizeCorrectionText(target) && visibleSource === target) throw new Error('修正前と修正後が同じです');

  const data = await chrome.storage.local.get({ userLearnedDictionary: [] });
  let user = (Array.isArray(data.userLearnedDictionary) ? data.userLearnedDictionary : []).map(e => normalizeLearnedEntry(e, 'user')).filter(Boolean);
  const visibleKey = normalizeCorrectionText(visibleSource);
  const targetKey = normalizeCorrectionText(target);
  const now = Date.now();

  // 辞書補正後の表示をユーザーが再修正するとき、中間表記をfromにしない。
  // 必ず「配信元原文（辞書適用前）→ ユーザーが指定した最新表記」にする。
  // 例1: user辞書 one → two の表示 two を three に直す => one → three。
  // 例2: HOLO標準辞書 Flo Glee → FLOW GLOW の表示 FLOW GLOW を FLOWGLOW に直す
  //      => Flo Glee → FLOWGLOW。FLOW GLOW → FLOWGLOW は作らない。
  //
  // replacement tokenには originalText / dictionaryLayer が残る。
  // ただし部分選択で誤って広い原文を拾わないよう、選択範囲全体がその辞書のtoと一致するときだけ採用する。
  const originalMetaCandidates = [];
  for (const w of (words || [])) {
    const layer = String(w?.dictionaryLayer || '');
    if (layer !== 'user' && layer !== 'standard') continue;
    const original = cleanCaptionText(w?.originalText || '');
    if (!original) continue;
    originalMetaCandidates.push({ layer, original });
  }
  const uniqueOriginalMeta = [...new Map(originalMetaCandidates.map(x => [`${x.layer}\u0000${normalizeCorrectionText(x.original)}`, x])).values()];

  let rootEntry = null;
  let standardRootSource = '';

  // 既存ユーザー辞書 A→B のB全体を選択してCへ直した場合は A→C。
  const userOriginals = uniqueOriginalMeta.filter(x => x.layer === 'user');
  if (userOriginals.length === 1) {
    const originalKey = normalizeCorrectionText(userOriginals[0].original);
    rootEntry = user.find(e =>
      normalizeCorrectionText(e.from) === originalKey
      && normalizeCorrectionText(e.to) === visibleKey
    ) || null;
  }

  // HOLO標準辞書 alias→canonical のcanonical全体を選択して再修正した場合は、
  // alias（実際の配信元原文）をfromとしてユーザー辞書に保存する。
  const standardOriginals = uniqueOriginalMeta.filter(x => x.layer === 'standard');
  if (!rootEntry && standardOriginals.length === 1) {
    const original = standardOriginals[0].original;
    const originalKey = normalizeCorrectionText(original);
    const parsedStandard = parseHololiveDictionary(String((await getSettings()).hololiveDictionary || globalThis.HOLOLIVE_DICTIONARY_DEFAULT || ''));
    const standardMatch = parsedStandard.find(e =>
      normalizeCorrectionText(e.alias) === originalKey
      && normalizeCorrectionText(e.canonical) === visibleKey
    );
    if (standardMatch) standardRootSource = original;
  }

  let effectiveFrom = standardRootSource || visibleSource;
  if (rootEntry) {
    // A → B を A → C へ直接更新。B → C という中間チェーンは作らない。
    rootEntry.to = target;
    rootEntry.updatedAt = now;
    rootEntry.count = Number(rootEntry.count || 1) + 1;
    rootEntry.origin = 'manual';
    rootEntry.reason = 'ユーザー再修正（最初の入力から最新表記へ更新）';
    rootEntry.confidence = 1;
    effectiveFrom = rootEntry.from;

  } else {
    const sourceForSave = standardRootSource || visibleSource;
    const sourceForSaveKey = normalizeCorrectionText(sourceForSave);
    const existing = user.find(e => normalizeCorrectionText(e.from) === sourceForSaveKey);
    if (existing) {
      existing.to = target;
      existing.updatedAt = now;
      existing.count = Number(existing.count || 1) + 1;
      existing.origin = 'manual';
      existing.reason = standardRootSource
        ? 'ユーザー修正（HOLO標準辞書適用前の原文から最新表記へ）'
        : 'ユーザー修正';
      existing.confidence = 1;
      effectiveFrom = existing.from;
    } else {
      user.push(normalizeLearnedEntry({
        id: `user:${now}:${Math.random().toString(36).slice(2,8)}`,
        from: sourceForSave, to: target, count: 1, confidence: 1,
        reason: standardRootSource ? 'ユーザー修正（HOLO標準辞書適用前の原文から最新表記へ）' : 'ユーザー修正',
        origin: 'manual', createdAt: now, updatedAt: now
      }, 'user'));
      effectiveFrom = sourceForSave;
    }

  }

  user = user.slice(-700);
  await chrome.storage.local.set({ userLearnedDictionary: user });
  const revision = await incrementDictionaryRevision();
  return { ok: true, from: effectiveFrom, to: target, dictionaryRevision: revision };
}


function isPlausibleLearnedAsrPair(fromText, toText) {
  const from = normalizeCorrectionText(fromText);
  const to = normalizeCorrectionText(toText);
  if (!from || !to || from === to) return false;

  // HOLO標準辞書に明示された alias -> canonical は許可。
  const parsed = parseHololiveDictionary(globalThis.HOLOLIVE_DICTIONARY_DEFAULT || '');
  for (const e of parsed) {
    if (normalizeCorrectionText(e.alias) === from && normalizeCorrectionText(e.canonical) === to) return true;
  }

  const fw = from.split(/\s+/).filter(Boolean);
  const tw = to.split(/\s+/).filter(Boolean);
  if (fw.length === 1 && tw.length !== 1) return false;
  if (Math.abs(fw.length - tw.length) > 1) return false;
  const a = from.replace(/\s+/g, '');
  const b = to.replace(/\s+/g, '');
  if (!a || !b) return false;
  const ratio = b.length / a.length;
  if (ratio < 0.62 || ratio > 1.55) return false;
  const d = correctionEditDistance(a, b);
  const maxLen = Math.max(a.length, b.length);
  const allowed = maxLen <= 4 ? 1 : (maxLen <= 8 ? 2 : Math.max(2, Math.floor(maxLen * 0.28)));
  return d <= allowed || (correctionPhoneticKey(a) === correctionPhoneticKey(b) && Math.abs(a.length - b.length) <= 2);
}

async function getLearnedDictionaryState() {
  const data = await chrome.storage.local.get({ userLearnedDictionary: [], dictionaryRevision: 1 });
  return {
    ok: true,
    user: (Array.isArray(data.userLearnedDictionary) ? data.userLearnedDictionary : []).map(e => normalizeLearnedEntry(e, 'user')).filter(Boolean),
    revision: Number(data.dictionaryRevision || 1)
  };
}

async function deleteLearnedDictionaryEntry(layer, id) {
  if (String(layer) !== 'user') throw new Error('削除対象の辞書が不正です');
  const data = await chrome.storage.local.get({ userLearnedDictionary: [] });
  const before = Array.isArray(data.userLearnedDictionary) ? data.userLearnedDictionary : [];
  const after = before.filter(e => String(e?.id || '') !== String(id || ''));
  if (after.length === before.length) return { ok: true, deleted: false };
  await chrome.storage.local.set({ userLearnedDictionary: after });
  await incrementDictionaryRevision();
  return { ok: true, deleted: true };
}

async function getYouTubeContext(tabId, lookbackSeconds, minSentenceWords = 3, captionTimingAdjustment = 0) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'GET_CAPTURE_CONTEXT',
      lookbackSeconds,
      minSentenceWords,
      captionTimingAdjustment
    });
    if (response?.ok) return response;
  } catch (err) {
    console.warn('caption history unavailable', err);
  }

  const [fallback] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      const video = document.querySelector('video');
      return {
        ok: true,
        currentTime: video?.currentTime || 0,
        playbackRate: video?.playbackRate || 1,
        paused: !!video?.paused,
        title: document.title.replace(/\s*-\s*YouTube\s*$/, ''),
        url: location.href,
        text: '',
        captionSource: 'none'
      };
    }
  });
  return fallback?.result || { ok: true, currentTime: 0, title: '', url: '', text: '' };
}

async function getTimedTextFallback(tabId, lookbackSeconds, minSentenceWords = 3, captionTimingAdjustment = 0) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [lookbackSeconds, minSentenceWords, captionTimingAdjustment],
      func: async (lookback, minWordsArg, timingAdjustmentArg) => {
        const video = document.querySelector('video');
        const now = Number(video?.currentTime || 0);
        const timingAdjustment = Math.max(0, Math.min(10, Number(timingAdjustmentArg) || 0));
        const targetTime = Math.max(0, now - timingAdjustment);
        const currentId = new URL(location.href).searchParams.get('v');
        const responses = [];
        try {
          const p = document.getElementById('movie_player');
          if (typeof p?.getPlayerResponse === 'function') responses.push(p.getPlayerResponse());
        } catch {}
        try { if (window.ytInitialPlayerResponse) responses.push(window.ytInitialPlayerResponse); } catch {}
        try {
          const raw = window.ytplayer?.config?.args?.player_response;
          if (raw) responses.push(typeof raw === 'string' ? JSON.parse(raw) : raw);
        } catch {}

        let pr = responses.find(r => r?.videoDetails?.videoId === currentId && r?.captions?.playerCaptionsTracklistRenderer?.captionTracks)
          || responses.find(r => r?.captions?.playerCaptionsTracklistRenderer?.captionTracks);
        const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
        const track = tracks.find(t => t.languageCode === 'en')
          || tracks.find(t => String(t.languageCode || '').startsWith('en'))
          || tracks.find(t => String(t.name?.simpleText || '').toLowerCase().includes('english'))
          || tracks[0];
        if (!track?.baseUrl) return { text: '', captionSource: 'none' };

        try {
          const u = new URL(track.baseUrl);
          u.searchParams.set('fmt', 'json3');
          const resp = await fetch(u.toString(), { credentials: 'include' });
          if (!resp.ok) return { text: '', captionSource: 'timedtext-http-' + resp.status };
          const data = await resp.json();
          const cues = (data?.events || [])
            .filter(ev => ev?.segs && ev.tStartMs !== undefined)
            .map(ev => ({
              start: ev.tStartMs / 1000,
              end: (ev.tStartMs + (ev.dDurationMs || 3000)) / 1000,
              text: ev.segs.map(s => s.utf8 || '').join('').replace(/\s+/g, ' ').trim()
            }))
            .filter(c => c.text && c.text !== '\n');
          const picked = cues.filter(c => c.end >= targetTime - lookback && c.start <= targetTime + 0.25);
          const extended = cues.filter(c => c.end >= targetTime - Math.max(30, Number(lookback || 6) + 20) && c.start <= targetTime + 0.25);
          const merge = (a, b) => {
            if (!a) return b;
            if (!b || a === b) return a;
            if (b.startsWith(a)) return b;
            if (a.startsWith(b)) return a;
            const aw = a.split(/\s+/), bw = b.split(/\s+/);
            const max = Math.min(16, aw.length, bw.length);
            for (let n = max; n >= 1; n--) {
              if (aw.slice(-n).join(' ').toLowerCase() === bw.slice(0, n).join(' ').toLowerCase()) {
                return [...aw, ...bw.slice(n)].join(' ');
              }
            }
            return a + ' ' + b;
          };
          const normalize = (x) => String(x || '').replace(/\s+/g, ' ').trim();
          const key = (token) => String(token || '').toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
          const tokens = (x) => normalize(x).split(/\s+/).map(key).filter(Boolean);
          const minWords = Math.max(1, Math.min(20, Number(minWordsArg) || 3));
          const recentText = normalize(picked.map(c => c.text).reduce(merge, ''));
          const extendedText = normalize(extended.map(c => c.text).reduce(merge, ''));

          const complete = [];
          const re = /[^.!?…]+[.!?…]+(?:["'”’）)\]]*)/g;
          let m;
          while ((m = re.exec(extendedText))) {
            const sentence = normalize(m[0]);
            if (sentence && tokens(sentence).length >= minWords) complete.push(sentence);
          }

          const longestCommon = (aText, bText) => {
            const a = tokens(aText), b = tokens(bText);
            let best = 0;
            let prev = new Array(b.length + 1).fill(0);
            for (let i = 1; i <= a.length; i++) {
              const cur = new Array(b.length + 1).fill(0);
              for (let j = 1; j <= b.length; j++) {
                if (a[i - 1] && a[i - 1] === b[j - 1]) {
                  cur[j] = prev[j - 1] + 1;
                  best = Math.max(best, cur[j]);
                }
              }
              prev = cur;
            }
            return best;
          };

          let text = recentText;
          let sentenceStart = Math.max(0, targetTime - Number(lookback || 6));
          let sentenceEnd = targetTime;
          let timingSource = 'timedtext-lookback';

          if (complete.length) {
            text = complete[complete.length - 1];
            const matches = extended.filter(c => longestCommon(c.text, text) >= Math.min(2, Math.max(1, tokens(c.text).length)));
            if (matches.length) {
              sentenceStart = Math.min(...matches.map(c => c.start));
              sentenceEnd = Math.max(...matches.map(c => c.end));
              timingSource = 'timedtext-cue';
            }
          } else if (extended.length) {
            const recentStart = targetTime - Number(lookback || 6);
            let first = extended.findIndex(c => c.end >= recentStart);
            if (first < 0) first = Math.max(0, extended.length - 1);
            let startIndex = first;
            while (startIndex > 0) {
              const cur = extended[startIndex];
              const prev = extended[startIndex - 1];
              if (cur.start - prev.end >= 1.2 || targetTime - prev.start > 18) break;
              startIndex--;
            }
            let chosen = extended.slice(startIndex);
            let utterance = normalize(chosen.map(c => c.text).reduce(merge, '')) || recentText;
            while (startIndex > 0 && tokens(utterance).length < minWords) {
              startIndex--;
              chosen = extended.slice(startIndex);
              utterance = normalize(chosen.map(c => c.text).reduce(merge, ''));
            }
            text = utterance || recentText;
            sentenceStart = chosen[0]?.start ?? sentenceStart;
            sentenceEnd = chosen[chosen.length - 1]?.end ?? sentenceEnd;
            timingSource = 'timedtext-pause';
          }

          return {
            text,
            sentenceStart,
            sentenceEnd,
            timingSource,
            currentTime: now,
            targetTime,
            captionTimingAdjustment: timingAdjustment,
            playbackRate: Number(video?.playbackRate || 1),
            paused: !!video?.paused,
            captionSource: 'timedtext-sentence'
          };
        } catch {
          return { text: '', captionSource: 'timedtext-error' };
        }
      }
    });
    return result?.result || { text: '', captionSource: 'none' };
  } catch (err) {
    console.warn('timedtext fallback failed', err);
    return { text: '', captionSource: 'none' };
  }
}

function cleanCaptionText(text) {
  return String(text || '')
    .replace(/\[[^\]]{1,40}\]/g, ' ')
    .replace(/♪+/g, ' ')
    .replace(/>>\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toWordCloze(text) {
  const wrapped = String(text || '').replace(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu, (word) => `{{c1::${word}}}`);
  return wrapped
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function translateWithGemini(apiKey, payload, timeoutMs = 25000) {
  const key = String(apiKey || '').trim();
  if (!key) return { ok: false, reason: 'gemini-key-missing', error: 'Gemini APIキーが設定されていません' };

  const targetText = cleanCaptionText(payload?.text || '');
  if (!targetText) return { ok: true, translation: '', vocabulary: [] };
  const title = String(payload?.title || '').slice(0, 500);
  const channelName = String(payload?.channelName || '').slice(0, 300);
  const url = String(payload?.url || '').slice(0, 800);
  const description = String(payload?.description || '').slice(0, 2200);
  const contextBefore = String(payload?.contextBefore || '').replace(/\s+/g, ' ').trim().slice(-1600);
  const contextAfter = String(payload?.contextAfter || '').replace(/\s+/g, ' ').trim().slice(0, 1600);

  const customInstruction = String(payload?.customInstruction || DEFAULT_GEMINI_STUDY_NOTE_INSTRUCTION).trim() || DEFAULT_GEMINI_STUDY_NOTE_INSTRUCTION;

  const systemInstruction = `You create study notes for an English listening Anki card.
Work ONLY on the TARGET CAPTION. Nearby transcript and video metadata are context only.

Do both tasks in ONE response:
1. Translate the target caption into natural Japanese, preserving the speaker's tone, slang, omitted subjects, and intended nuance.
2. Extract useful English vocabulary from the target caption: words, grammar chunks, phrasal verbs, idioms, fixed expressions, slang, and collocations.

USER-EDITABLE STUDY NOTE INSTRUCTIONS:
${customInstruction}

Fixed requirements that the editable instructions must not break:
- Analyze only the TARGET CAPTION; use nearby transcript and metadata only as context.
- Do not create vocabulary that does not occur in the target caption.
- Proper names should normally be omitted unless the expression itself has reusable linguistic value.
- Return valid JSON only, exactly with this shape:
{"translation":"自然な日本語訳","vocabulary":[{"term":"English term or phrase","meaning":"この文脈での簡潔な日本語の意味"}]}
- No Markdown, no code fence, and no commentary outside JSON.`;

  const prompt = `Create the translation and vocabulary notes for the TARGET CAPTION using the context below.\n\nVIDEO URL: ${url || '(unknown)'}\nVIDEO TITLE: ${title || '(unknown)'}\nCHANNEL: ${channelName || '(unknown)'}\nVIDEO DESCRIPTION: ${description || '(none)'}\n\nNEARBY TRANSCRIPT BEFORE TARGET (context only; noisy ASR):\n${contextBefore || '(none)'}\n\nTARGET CAPTION (the only text to translate/analyze):\n${targetText}\n\nNEARBY TRANSCRIPT AFTER TARGET (context only; noisy ASR):\n${contextAfter || '(none)'}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(3000, Number(timeoutMs) || 25000));
  try {
    const response = await fetch(GEMINI_TRANSLATION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.15,
          maxOutputTokens: 1400,
          responseMimeType: 'application/json'
        }
      }),
      signal: controller.signal
    });

    let json = null;
    try { json = await response.json(); } catch {}
    if (!response.ok) {
      const apiMessage = String(json?.error?.message || `${response.status} ${response.statusText}` || 'Gemini API error');
      const reason = response.status === 429 ? 'gemini-translation-rate-limit'
        : (response.status === 401 || response.status === 403) ? 'gemini-auth-failed'
          : 'gemini-translation-api-failed';
      return { ok: false, reason, error: apiMessage, httpStatus: response.status, debug: { customInstruction, systemInstruction, requestPrompt: prompt, apiError: json?.error || null, usageMetadata: json?.usageMetadata || null } };
    }

    const raw = extractGeminiResponseText(json).replace(/^```(?:json|text)?\s*|\s*```$/g, '').trim();
    if (!raw) return { ok: false, reason: 'gemini-translation-empty', error: 'Gemini翻訳・語彙抽出の応答が空です', debug: { customInstruction, systemInstruction, requestPrompt: prompt, rawResponseText: '', usageMetadata: json?.usageMetadata || null } };

    const parsed = parseTranslationVocabularyResponse(raw);
    if (!parsed.translation) {
      return { ok: false, reason: 'gemini-translation-json-invalid', error: 'Geminiの日本語訳をJSONから読み取れませんでした', debug: { customInstruction, systemInstruction, requestPrompt: prompt, rawResponseText: raw, usageMetadata: json?.usageMetadata || null } };
    }
    return {
      ok: true,
      translation: parsed.translation,
      vocabulary: parsed.vocabulary,
      model: GEMINI_TRANSLATION_MODEL,
      debug: { customInstruction, systemInstruction, requestPrompt: prompt, rawResponseText: raw, usageMetadata: json?.usageMetadata || null }
    };
  } catch (err) {
    const timedOut = String(err?.name || '') === 'AbortError';
    return {
      ok: false,
      reason: timedOut ? 'gemini-translation-timeout' : 'gemini-translation-network-failed',
      error: err?.message || String(err),
      debug: { customInstruction, systemInstruction, requestPrompt: prompt }
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseTranslationVocabularyResponse(rawText) {
  let text = String(rawText || '').trim();
  let obj = null;
  try { obj = JSON.parse(text); } catch {}
  if (!obj) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { obj = JSON.parse(text.slice(start, end + 1)); } catch {}
    }
  }
  if (!obj || typeof obj !== 'object') return { translation: '', vocabulary: [] };
  return {
    translation: String(obj.translation || '').trim(),
    vocabulary: normalizeVocabularyItems(obj.vocabulary)
  };
}

function normalizeVocabularyItems(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of items) {
    let term = '';
    let meaning = '';
    if (raw && typeof raw === 'object') {
      term = String(raw.term || raw.word || raw.phrase || '').replace(/\s+/g, ' ').trim();
      meaning = String(raw.meaning || raw.japanese || raw.definition || '').replace(/\s+/g, ' ').trim();
    } else if (typeof raw === 'string') {
      const m = raw.match(/^(.+?)\s*[:：]\s*(.+)$/);
      if (m) { term = m[1].trim(); meaning = m[2].trim(); }
    }
    if (!term || !meaning) continue;
    const key = term.toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ term, meaning });
    if (out.length >= 30) break;
  }
  return out;
}

function buildMnemonicsHtml(translation, vocabulary) {
  const lines = [];
  const ja = String(translation || '').trim();
  if (ja) lines.push(`日本語訳:${escapeHtml(ja)}`);
  const items = normalizeVocabularyItems(vocabulary);
  if (items.length) {
    if (lines.length) lines.push('');
    lines.push('単語・熟語:');
    for (const item of items) {
      lines.push(`${escapeHtml(item.term)}: ${escapeHtml(item.meaning)}`);
    }
  }
  return lines.join('<br>');
}

function buildSourceHtml(context, sec) {
  try {
    const u = new URL(context.url || 'https://www.youtube.com/');
    const platform = getSupportedPlatform(u.toString());
    if (platform === 'youtube') u.searchParams.set('t', `${sec}s`);
    const title = escapeHtml(context.title || (platform === 'netflix' ? 'Netflix' : 'YouTube'));
    const href = escapeHtml(u.toString());
    return `<a href="${href}">${title} @ ${formatTime(sec)}</a>`;
  } catch {
    return escapeHtml(context.url || '');
  }
}

function getVideoId(url) {
  try {
    const u = new URL(url);
    return u.searchParams.get('v') || u.pathname.split('/').filter(Boolean).pop();
  } catch { return ''; }
}

function sanitizeFilePart(s) {
  return String(s || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60) || 'video';
}

function formatTime(total) {
  total = Math.max(0, Math.floor(total));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function toastRecordingTab(message, isError = false) {
  const tabId = await getRecordingTabId();
  if (tabId) return toastTab(tabId, message, isError);
}

async function toastTab(tabId, message, isError = false) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'SHOW_TOAST', message, isError });
  } catch {}
}

async function ankiInvoke(action, params = {}) {
  const { ankiUrl } = await getSettings();
  let response;
  try {
    response = await fetch(ankiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, version: 6, params })
    });
  } catch (err) {
    throw new Error('AnkiConnectに接続できません。Ankiを起動してください');
  }
  const data = await response.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

async function getAnkiLists(preferredModel) {
  try {
    await ankiInvoke('requestPermission');
    const [decks, models] = await Promise.all([
      ankiInvoke('deckNames'),
      ankiInvoke('modelNames')
    ]);
    const model = preferredModel && models.includes(preferredModel)
      ? preferredModel
      : (models.includes(DEFAULTS.modelName) ? DEFAULTS.modelName : models[0]);
    const fields = model ? await ankiInvoke('modelFieldNames', { modelName: model }) : [];
    return { ok: true, decks, models, model, fields };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}
