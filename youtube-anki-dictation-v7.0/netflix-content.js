(() => {
const CONTENT_BUILD = '9.4.0';
const CONTENT_MARKER_ATTR = 'data-anki-dictation-netflix-build';
try { document.documentElement?.setAttribute(CONTENT_MARKER_ATTR, CONTENT_BUILD); } catch {}

function isCurrentContentInstance() {
  try {
    return document.documentElement?.getAttribute(CONTENT_MARKER_ATTR) === CONTENT_BUILD && !!chrome.runtime?.id;
  } catch { return false; }
}

async function sendRuntimeMessage(message) {
  if (!isCurrentContentInstance()) throw new Error('拡張機能が更新されています。Netflixページを1回再読み込みしてください。');
  try { return await chrome.runtime.sendMessage(message); }
  catch (err) {
    const text = String(err?.message || err || '');
    if (/Extension context invalidated/i.test(text)) throw new Error('拡張機能が更新されています。Netflixページを1回再読み込みしてください。');
    throw err;
  }
}
function sendRuntimeMessageQuiet(message) { sendRuntimeMessage(message).catch(() => {}); }

let running = false;
let pollTimer = null;
let hideCaptions = false;
let fullTranscriptLoaded = false;
let lastSeekRequestAt = 0;
const NF_CONTROL_ACTIVE_ATTR = 'data-anki-netflix-control-active';
const NF_CONTROL_BUILD_ATTR = 'data-anki-netflix-main-control-build';
const NF_PLAYER_TIME_ATTR = 'data-anki-netflix-player-time';
const NF_PLAYER_RATE_ATTR = 'data-anki-netflix-player-rate';
const NF_PLAYER_PAUSED_ATTR = 'data-anki-netflix-player-paused';
const NF_SEEK_SECONDS_ATTR = 'data-anki-netflix-seek-seconds';

// v9.3: Netflix only. Reserve the transcript-panel area instead of covering the video.
// The rendered picture is pinned to the LEFT/TOP edge so the unused black area remains below it.
// Native Netflix timed-text keeps its own vertical placement; we only shift it horizontally so
// its center lines up with the resized video area. Do not change timed-text width/height.
const NF_VIDEO_FIT_ATTR = 'data-anki-netflix-video-fit';
const NF_VIDEO_FIT_STYLE_ID = 'anki-netflix-video-fit-style';
const NF_PANEL_RIGHT_PX = 12;
const NF_VIDEO_PANEL_GAP_PX = 12;
let videoFitTarget = null;
let videoFitOriginal = null;
let videoFitTimer = null;
let videoFitResizeHandler = null;
let videoFitFullscreenHandler = null;
let videoFitVisualViewportHandler = null;
let videoFitResizeObserver = null;
let videoFitObservedVideo = null;
let videoFitRaf = 0;
let videoFitSettleTimers = [];
let videoFitApplying = false;

function currentWatchId() {
  return String(location.pathname.match(/^\/watch\/(\d+)/i)?.[1] || '');
}

function bestNetflixVideo() {
  const videos = [...document.querySelectorAll('video')];
  videos.sort((a,b)=>{
    const sa=(a.clientWidth||0)*(a.clientHeight||0)+(a.readyState||0)*1000+(!a.paused?500:0);
    const sb=(b.clientWidth||0)*(b.clientHeight||0)+(b.readyState||0)*1000+(!b.paused?500:0);
    return sb-sa;
  });
  return videos[0] || null;
}

function netflixPlayerState() {
  const root = document.documentElement;
  const bridgedTime = Number(root?.getAttribute(NF_PLAYER_TIME_ATTR));
  const bridgedRate = Number(root?.getAttribute(NF_PLAYER_RATE_ATTR));
  const pausedAttr = root?.getAttribute(NF_PLAYER_PAUSED_ATTR);
  const video = bestNetflixVideo();
  return {
    currentTime: Number.isFinite(bridgedTime) ? bridgedTime : Number(video?.currentTime || 0),
    playbackRate: Number.isFinite(bridgedRate) && bridgedRate > 0 ? bridgedRate : Number(video?.playbackRate || 1),
    paused: pausedAttr === '1' ? true : (pausedAttr === '0' ? false : !!video?.paused)
  };
}

const panel = {
  host: null,
  shadow: null,
  root: null,
  list: null,
  status: null,
  info: null,
  save: null,
  correct: null,
  trackSelect: null,
  trackRow: null,
  preferredTrackId: '',
  cues: [],
  wordMap: new Map(),
  wordMetaMap: new Map(),
  wordStartIndex: null,
  wordEndIndex: null,
  currentTranscript: null,
  loading: false,
  preserveSelection: true,
  rowMap: new Map(),
  currentIndex: -1,
  follow: true,
  manualScrollUntil: 0,
  updateTimer: null
};

window.addEventListener('anki_netflix_timedtext_manifest', () => {
  if (!running || fullTranscriptLoaded) return;
  // 開始時のmanifestが取れたら、エピソード全字幕を一度だけ取り直す。
  setTimeout(() => requestPanelRefresh(true), 180);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isCurrentContentInstance() || !message) return;
  if (message.type === 'ANKI_DICTATION_PING') {
    sendResponse({ ok: true, version: CONTENT_BUILD, platform: 'netflix' });
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
  if (message.type === 'TRANSCRIPT_PANEL_LOADING') {
    ensurePanel();
    setLoading(true, message.preserveSelection !== false);
    sendResponse({ ok: true });
    return;
  }
  if (message.type === 'SHOW_TRANSCRIPT_PANEL') {
    renderTranscript(message.transcript || {}, {
      preserveSelection: message.preserveSelection !== false,
      focusCurrent: message.focusCurrent !== false
    });
    sendResponse({ ok: true });
    return;
  }
  if (message.type === 'HIDE_TRANSCRIPT_PANEL') {
    destroyPanel();
    sendResponse({ ok: true });
    return;
  }
  if (message.type === 'SHOW_TOAST') {
    showToast(message.message, !!message.isError);
    sendResponse({ ok: true });
  }
});

function start(options = {}) {
  running = true;
  fullTranscriptLoaded = false;
  // Netflix本体の表示字幕は、拡張機能側の取得字幕とは独立して維持する。
  // 共通設定の「字幕を隠す」はYouTube側だけに適用し、Netflixでは日本語字幕などを消さない。
  hideCaptions = false;
  applyCaptionVisibility();
  try {
    document.documentElement?.setAttribute(NF_CONTROL_ACTIVE_ATTR, '1');
    window.dispatchEvent(new Event('anki_netflix_control_start'));
  } catch {}
  syncAudioTimeline();
  if (pollTimer) clearInterval(pollTimer);
  // 音声タイムライン同期だけを継続する。Netflix字幕は開始時に全件取得し、DOM字幕は監視しない。
  pollTimer = setInterval(() => {
    if (!running) return;
    syncAudioTimeline();
  }, 120);
  ensurePanel();
  // The full manifest can arrive shortly after the player starts. Retry a few times,
  // but never fall back to accumulating visible DOM captions.
  setTimeout(() => { if (running && !fullTranscriptLoaded) requestPanelRefresh(true); }, 1500);
  setTimeout(() => { if (running && !fullTranscriptLoaded) requestPanelRefresh(true); }, 4000);
  setTimeout(() => { if (running && !fullTranscriptLoaded) requestPanelRefresh(true); }, 8000);
}

function stop() {
  running = false;
  fullTranscriptLoaded = false;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  document.getElementById('anki-dictation-netflix-hide-captions')?.remove();
  try {
    document.documentElement?.removeAttribute(NF_CONTROL_ACTIVE_ATTR);
    window.dispatchEvent(new Event('anki_netflix_control_stop'));
  } catch {}
  stopNetflixVideoFit();
  destroyPanel();
}

function applyCaptionVisibility() {
  // Netflix native captions must remain untouched. The user may display Japanese on Netflix
  // while fetching English in the extension, so hiding .player-timedtext would break that workflow.
  document.getElementById('anki-dictation-netflix-hide-captions')?.remove();
}

function ensureNetflixVideoFitStyle() {
  // v9.3: never resize/reflow Netflix's native subtitle box. We only translate it horizontally.
  // v9.1 changed its width and that could make Netflix stop rendering subtitles.
  let style = document.getElementById(NF_VIDEO_FIT_STYLE_ID);
  if (!style) {
    style = document.createElement('style');
    style.id = NF_VIDEO_FIT_STYLE_ID;
    style.textContent = `
      html[${NF_VIDEO_FIT_ATTR}="1"] .player-timedtext {
        translate: var(--anki-netflix-native-subtitle-shift-x, 0px) 0px !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }
  return style;
}

function currentNetflixPanelWidth() {
  const rect = panel.root?.getBoundingClientRect?.();
  const width = Number(rect?.width || panel.root?.offsetWidth || 430);
  return Math.max(280, Math.min(window.innerWidth * 0.75, Number.isFinite(width) ? width : 430));
}

function currentNetflixReservedWidth() {
  return currentNetflixPanelWidth() + NF_PANEL_RIGHT_PX + NF_VIDEO_PANEL_GAP_PX;
}

function rememberVideoFitStyle(video) {
  if (!video) return null;
  const names = ['scale','transform-origin','translate','object-fit','object-position'];
  const saved = {};
  for (const cssName of names) {
    saved[cssName] = {
      value: video.style.getPropertyValue(cssName),
      priority: video.style.getPropertyPriority(cssName)
    };
  }
  return saved;
}

function restoreVideoFitTarget() {
  const video = videoFitTarget;
  const saved = videoFitOriginal;
  if (video && saved) {
    for (const [name, state] of Object.entries(saved)) {
      if (state?.value) video.style.setProperty(name, state.value, state.priority || '');
      else video.style.removeProperty(name);
    }
  }
  videoFitTarget = null;
  videoFitOriginal = null;
}

function panelIsExpanded() {
  return !!(panel.root?.isConnected && panel.root.dataset.collapsed !== '1');
}

function applyNetflixVideoFit() {
  if (videoFitApplying) return;
  videoFitApplying = true;
  try {
  if (!running || !panelIsExpanded()) {
    document.documentElement?.removeAttribute(NF_VIDEO_FIT_ATTR);
    document.documentElement?.style.removeProperty('--anki-netflix-native-subtitle-shift-x');
    restoreVideoFitTarget();
    return;
  }

  // Native Netflix subtitles are intentionally left completely untouched.
  ensureNetflixVideoFitStyle();
  const video = bestNetflixVideo();
  if (!video?.isConnected) return;

  if (videoFitTarget !== video) {
    restoreVideoFitTarget();
    videoFitTarget = video;
    videoFitOriginal = rememberVideoFitStyle(video);
  }

  const viewportWidth = Math.max(1, Number(window.innerWidth || document.documentElement?.clientWidth || 1));
  const viewportHeight = Math.max(1, Number(window.innerHeight || document.documentElement?.clientHeight || 1));
  const panelRect = panel.root?.getBoundingClientRect?.();
  const panelLeft = Number(panelRect?.left);
  // Use the panel's actual left edge instead of a cached viewport/panel calculation. This is stable
  // when Chrome is snapped/resized and is also ready for future drag-resizing of the transcript panel.
  const availableWidth = Math.max(320, Math.min(
    viewportWidth,
    Number.isFinite(panelLeft) && panelLeft > 0
      ? panelLeft - NF_VIDEO_PANEL_GAP_PX
      : viewportWidth - currentNetflixReservedWidth()
  ));

  // IMPORTANT: offsetWidth/offsetHeight are layout dimensions BEFORE CSS transform/scale.
  // Unlike the old cached getBoundingClientRect(), these values update whenever Netflix/Chrome
  // relayouts after a window resize. The stale cached base width was why the movie could remain
  // unnecessarily small after resizing the browser.
  const baseWidth = Math.max(1, Number(video.offsetWidth || video.clientWidth || viewportWidth));
  const baseHeight = Math.max(1, Number(video.offsetHeight || video.clientHeight || viewportHeight));
  const widthScale = availableWidth / baseWidth;
  const heightScale = viewportHeight / baseHeight;
  const scale = Math.min(1, Math.max(0.35, Math.min(widthScale, heightScale)));
  const reservedWidth = Math.max(0, viewportWidth - availableWidth);

  // Preserve Netflix's own transform and compose with it using individual transform properties.
  // object-position:left top is the key v9.3 change: the actual movie picture uses the top-left
  // of the available area, rather than sitting vertically centered with a large black band above it.
  video.style.setProperty('transform-origin', 'left top', 'important');
  video.style.setProperty('scale', String(scale), 'important');
  video.style.setProperty('object-fit', 'contain', 'important');
  video.style.setProperty('object-position', 'left top', 'important');

  // Netflix can center the <video> element itself. Compensate in both axes without replacing
  // Netflix's transform, so the scaled video box begins at viewport (0,0).
  video.style.setProperty('translate', '0px 0px', 'important');
  let shiftX = 0;
  let shiftY = 0;
  for (let i = 0; i < 7; i++) {
    const rect = video.getBoundingClientRect();
    const left = Number(rect.left || 0);
    const top = Number(rect.top || 0);
    const dx = Number.isFinite(left) ? -left : 0;
    const dy = Number.isFinite(top) ? -top : 0;
    if (Math.abs(dx) < 0.75 && Math.abs(dy) < 0.75) break;
    shiftX += dx;
    shiftY += dy;
    video.style.setProperty('translate', `${shiftX}px ${shiftY}px`, 'important');
  }

  // Keep Netflix's own subtitle Y-position (normally low in the viewport), which now places it
  // in the black area below the top-aligned movie. Shift only X so it is centered under the movie,
  // not under the whole browser viewport. This uses the *actual* panel width, so future panel
  // resizing can drive the video/subtitle layout without rewriting this calculation.
  const subtitleShiftX = -Math.max(0, reservedWidth) / 2;
  document.documentElement?.style.setProperty('--anki-netflix-native-subtitle-shift-x', `${subtitleShiftX}px`);
  document.documentElement?.setAttribute(NF_VIDEO_FIT_ATTR, '1');
  } finally {
    videoFitApplying = false;
  }
}

function clearVideoFitSettleTimers() {
  for (const id of videoFitSettleTimers) clearTimeout(id);
  videoFitSettleTimers = [];
}

function scheduleNetflixVideoFit(settle = true) {
  if (videoFitRaf) cancelAnimationFrame(videoFitRaf);
  videoFitRaf = requestAnimationFrame(() => {
    videoFitRaf = 0;
    applyNetflixVideoFit();
  });
  if (!settle) return;
  clearVideoFitSettleTimers();
  // Chrome/Netflix resize in stages (viewport -> player shell -> video). Re-run after each stage
  // so the final size is based on the settled layout rather than the first transient dimensions.
  for (const delay of [70, 160, 320, 650]) {
    videoFitSettleTimers.push(setTimeout(() => applyNetflixVideoFit(), delay));
  }
}

function refreshVideoFitObserver() {
  const video = bestNetflixVideo();
  if (!videoFitResizeObserver || videoFitObservedVideo === video) return;
  try { if (videoFitObservedVideo) videoFitResizeObserver.unobserve(videoFitObservedVideo); } catch {}
  videoFitObservedVideo = video || null;
  try { if (videoFitObservedVideo) videoFitResizeObserver.observe(videoFitObservedVideo); } catch {}
}

function startNetflixVideoFit() {
  if (videoFitTimer) clearInterval(videoFitTimer);
  scheduleNetflixVideoFit(true);
  // Slow fallback for Netflix replacing/reconfiguring the <video> element without a window resize.
  videoFitTimer = setInterval(() => {
    refreshVideoFitObserver();
    applyNetflixVideoFit();
  }, 900);
  if (!videoFitResizeHandler) {
    videoFitResizeHandler = () => scheduleNetflixVideoFit(true);
    window.addEventListener('resize', videoFitResizeHandler, { passive: true });
  }
  if (!videoFitFullscreenHandler) {
    videoFitFullscreenHandler = () => scheduleNetflixVideoFit(true);
    document.addEventListener('fullscreenchange', videoFitFullscreenHandler, { passive: true });
  }
  if (!videoFitVisualViewportHandler && window.visualViewport) {
    videoFitVisualViewportHandler = () => scheduleNetflixVideoFit(true);
    window.visualViewport.addEventListener('resize', videoFitVisualViewportHandler, { passive: true });
  }
  if (!videoFitResizeObserver && typeof ResizeObserver !== 'undefined') {
    videoFitResizeObserver = new ResizeObserver(() => scheduleNetflixVideoFit(false));
    try { if (panel.root) videoFitResizeObserver.observe(panel.root); } catch {}
  }
  refreshVideoFitObserver();
}

function stopNetflixVideoFit() {
  if (videoFitTimer) clearInterval(videoFitTimer);
  videoFitTimer = null;
  if (videoFitRaf) cancelAnimationFrame(videoFitRaf);
  videoFitRaf = 0;
  clearVideoFitSettleTimers();
  if (videoFitResizeHandler) window.removeEventListener('resize', videoFitResizeHandler);
  if (videoFitFullscreenHandler) document.removeEventListener('fullscreenchange', videoFitFullscreenHandler);
  if (videoFitVisualViewportHandler && window.visualViewport) {
    window.visualViewport.removeEventListener('resize', videoFitVisualViewportHandler);
  }
  videoFitResizeHandler = null;
  videoFitFullscreenHandler = null;
  videoFitVisualViewportHandler = null;
  if (videoFitResizeObserver) {
    try { videoFitResizeObserver.disconnect(); } catch {}
  }
  videoFitResizeObserver = null;
  videoFitObservedVideo = null;
  document.documentElement?.removeAttribute(NF_VIDEO_FIT_ATTR);
  document.documentElement?.style.removeProperty('--anki-netflix-native-subtitle-shift-x');
  restoreVideoFitTarget();
  document.getElementById(NF_VIDEO_FIT_STYLE_ID)?.remove();
}

function syncAudioTimeline() {
  if (!running) return;
  const state = netflixPlayerState();
  const currentTime = Number(state.currentTime);
  const playbackRate = Number(state.playbackRate || 1);
  if (!Number.isFinite(currentTime) || !Number.isFinite(playbackRate)) return;
  sendRuntimeMessageQuiet({
    type: 'AUDIO_TIMELINE_SYNC', currentTime, playbackRate,
    paused: !!state.paused, sentAtMs: Date.now()
  });
}

function normalizeText(text) {
  return String(text || '')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function ensurePanel() {
  if (panel.host?.isConnected) return panel.root;

  const host = document.createElement('div');
  host.id = 'anki-netflix-transcript-host';
  host.style.setProperty('all', 'initial', 'important');
  host.style.setProperty('position', 'fixed', 'important');
  host.style.setProperty('inset', '0', 'important');
  host.style.setProperty('z-index', '2147483647', 'important');
  host.style.setProperty('pointer-events', 'none', 'important');

  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial !important; }
    *, *::before, *::after { box-sizing: border-box; }
    button, input, select { font: inherit; }
    button { appearance: auto; -webkit-appearance: auto; }
    [data-nfanki="save"], [data-nfanki="save"] * { cursor:pointer!important; user-select:none!important; -webkit-user-select:none!important; }
    [data-nfanki="word"] { cursor:pointer!important; border-radius:4px; padding:1px 2px; margin:0 -1px; transition:background .08s,color .08s,box-shadow .08s; user-select:none!important; -webkit-user-select:none!important; }
    [data-nfanki="word"]:hover { background:#3a3a3a; }
    [data-nfanki="word"].anchor { background:#b45309!important; color:#fff!important; box-shadow:inset 0 0 0 1px #f59e0b; }
    [data-nfanki="word"].range { background:#2563eb!important; color:#fff!important; }
  `;

  const root = document.createElement('aside');
  Object.assign(root.style, {
    position:'absolute', top:'64px', right:'12px', width:'430px', height:'calc(100vh - 78px)',
    zIndex:'1', background:'#101010', color:'#f5f5f5', border:'1px solid rgba(255,255,255,.15)',
    borderRadius:'12px', boxShadow:'0 18px 60px rgba(0,0,0,.45)', display:'flex', flexDirection:'column',
    overflow:'hidden', fontFamily:'Arial, system-ui, sans-serif', pointerEvents:'auto'
  });

  const header = document.createElement('div');
  Object.assign(header.style, { padding:'11px 12px', borderBottom:'1px solid rgba(255,255,255,.12)', display:'flex', alignItems:'center', gap:'8px', background:'#181818', flex:'0 0 auto' });
  const titleWrap = document.createElement('div');
  titleWrap.style.minWidth='0'; titleWrap.style.flex='1';
  const title=document.createElement('div');
  title.textContent='Netflix 字幕 → Anki';
  Object.assign(title.style,{fontSize:'15px',fontWeight:'700',lineHeight:'1.25'});
  const status=document.createElement('div');
  status.dataset.nfanki='status';
  Object.assign(status.style,{fontSize:'11px',color:'#aaa',marginTop:'2px',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'});
  const trackRow=document.createElement('div');
  Object.assign(trackRow.style,{display:'flex',alignItems:'center',gap:'6px',marginTop:'6px',minWidth:'0'});
  const trackLabel=document.createElement('span');
  trackLabel.textContent='取得字幕';
  Object.assign(trackLabel.style,{fontSize:'10px',color:'#aaa',flex:'0 0 auto'});
  const trackSelect=document.createElement('select');
  trackSelect.dataset.nfanki='track-select';
  Object.assign(trackSelect.style,{height:'27px',minWidth:'0',width:'190px',maxWidth:'100%',border:'1px solid rgba(255,255,255,.15)',borderRadius:'6px',background:'#252525',color:'#f5f5f5',padding:'0 24px 0 7px',fontSize:'11px',cursor:'pointer'});
  trackSelect.title='Netflix画面に表示する字幕とは別に、この拡張機能で取得する字幕を選択します';
  trackSelect.addEventListener('change',()=>{
    panel.preferredTrackId=String(trackSelect.value||'');
    clearSelection();
    requestPanelRefresh(true,false);
  });
  trackRow.append(trackLabel,trackSelect);
  titleWrap.append(title,status,trackRow);

  const panelButton=(text,titleText)=>{const b=document.createElement('button');b.type='button';b.textContent=text;b.title=titleText||'';Object.assign(b.style,{border:'1px solid rgba(255,255,255,.12)',background:'#2a2a2a',color:'#eee',borderRadius:'7px',height:'30px',minWidth:'30px',padding:'0 8px',cursor:'pointer',fontSize:'11px'});return b;};
  const follow=panelButton('追従 ON','再生位置へ自動追従');
  follow.style.background='#263b2c';
  follow.addEventListener('click',()=>{panel.follow=!panel.follow;follow.textContent=panel.follow?'追従 ON':'追従 OFF';follow.style.background=panel.follow?'#263b2c':'#2a2a2a';if(panel.follow)focusCurrentRow(true);});
  const refresh=panelButton('↻','字幕を更新'); refresh.style.fontSize='18px'; refresh.addEventListener('click',()=>requestPanelRefresh(true));
  const collapse=panelButton('−','折りたたむ'); collapse.style.fontSize='18px';
  const close=panelButton('×','閉じる'); close.style.fontSize='18px'; close.addEventListener('click',destroyPanel);
  header.append(titleWrap,follow,refresh,collapse,close);

  const list=document.createElement('div');
  Object.assign(list.style,{flex:'1 1 auto',overflowY:'auto',overscrollBehavior:'contain',padding:'8px 8px 110px 8px',scrollbarWidth:'thin'});
  list.addEventListener('wheel',(event)=>{event.stopPropagation();panel.manualScrollUntil=Date.now()+5000;},{passive:true});
  list.addEventListener('pointerdown',()=>panel.manualScrollUntil=Date.now()+5000,{passive:true});

  const footer=document.createElement('div');
  Object.assign(footer.style,{position:'absolute',left:'0',right:'0',bottom:'0',padding:'10px 12px 12px',borderTop:'1px solid rgba(255,255,255,.12)',background:'rgba(20,20,20,.97)',backdropFilter:'blur(8px)',zIndex:'10',pointerEvents:'auto'});
  const info=document.createElement('div'); info.dataset.nfanki='selected-info';
  Object.assign(info.style,{fontSize:'12px',color:'#bbb',marginBottom:'7px'}); info.textContent='開始単語をクリック → 終了単語をクリック';
  const actions=document.createElement('div'); Object.assign(actions.style,{display:'flex',gap:'8px'});
  const footerButton=(text,primary=false)=>{const b=document.createElement('button');b.type='button';b.textContent=text;Object.assign(b.style,{flex:primary?'1':'0 0 auto',height:'38px',padding:'0 13px',borderRadius:'8px',border:primary?'0':'1px solid rgba(255,255,255,.15)',background:primary?'#2563eb':'#2a2a2a',color:'#fff',cursor:'pointer',fontWeight:primary?'700':'500',boxSizing:'border-box',pointerEvents:'auto'});return b;};
  const clear=footerButton('選択解除'); clear.addEventListener('click',(e)=>{e.preventDefault();e.stopPropagation();clearSelection();});
  const correct=footerButton('字幕修正'); correct.dataset.nfanki='correct'; correct.setAttribute('aria-disabled','true'); correct.addEventListener('click',async(e)=>{e.preventDefault();e.stopPropagation();await correctSelectedRange();});
  const save=footerButton('選択範囲をAnkiへ',true); save.dataset.nfanki='save'; save.setAttribute('aria-disabled','true');
  save.addEventListener('click',async(e)=>{e.preventDefault();e.stopPropagation();if(save.dataset.busy==='1')return;await saveSelectedRange();});
  actions.append(clear,correct,save); footer.append(info,actions);

  collapse.addEventListener('click',()=>{const collapsed=root.dataset.collapsed==='1';if(collapsed){root.dataset.collapsed='0';root.style.height='calc(100vh - 78px)';list.style.display='block';footer.style.display='block';collapse.textContent='−';startNetflixVideoFit();}else{root.dataset.collapsed='1';root.style.height='48px';list.style.display='none';footer.style.display='none';collapse.textContent='+';scheduleNetflixVideoFit(true);}});

  root.append(header,list,footer); shadow.append(style,root); document.documentElement.appendChild(host);
  panel.host=host; panel.shadow=shadow; panel.root=root; panel.list=list; panel.status=status; panel.info=info; panel.save=save; panel.correct=correct; panel.trackSelect=trackSelect; panel.trackRow=trackRow;
  if(panel.updateTimer)clearInterval(panel.updateTimer);
  panel.updateTimer=setInterval(updateCurrentRow,350);
  startNetflixVideoFit();
  return root;
}

function destroyPanel() {
  stopNetflixVideoFit();
  panel.host?.remove();
  panel.host=null; panel.shadow=null; panel.root=null; panel.list=null; panel.status=null; panel.info=null; panel.save=null; panel.correct=null; panel.trackSelect=null; panel.trackRow=null;
  panel.wordMap.clear(); panel.wordMetaMap.clear(); panel.rowMap.clear(); panel.wordStartIndex=null; panel.wordEndIndex=null; panel.cues=[]; panel.currentTranscript=null; panel.currentIndex=-1;
  if (panel.updateTimer) clearInterval(panel.updateTimer); panel.updateTimer=null;
}

function requestPanelRefresh(focusCurrent=false, preserveSelection=true) {
  sendRuntimeMessageQuiet({
    type:'TRANSCRIPT_REFRESH_REQUEST',
    focusCurrent,
    preserveSelection,
    netflixTrackId:String(panel.preferredTrackId||'')
  });
}

function setLoading(loading, preserveSelection=true) {
  ensurePanel();
  panel.loading=!!loading; panel.preserveSelection=preserveSelection;
  if (panel.status) panel.status.textContent = loading ? '字幕を更新中…' : panel.status.textContent;
  if (panel.trackSelect) panel.trackSelect.disabled=!!loading;
}

function wordKey(word) { return `${Math.round(Number(word?.start||0)*100)}|${String(word?.originalText || word?.text || '').toLowerCase()}`; }

function renderTranscript(transcript, options={}) {
  ensurePanel();
  const transcriptWatchId=String(transcript?.watchId||(()=>{try{return new URL(String(transcript?.url||''),location.href).pathname.match(/^\/watch\/(\d+)/i)?.[1]||''}catch{return''}})());
  const nowWatchId=currentWatchId();
  if(transcript?.ok && transcriptWatchId && nowWatchId && transcriptWatchId!==nowWatchId){
    // Netflix is an SPA. Never let a slow previous-episode fetch overwrite the new episode panel.
    return;
  }
  panel.loading=false;
  const preserve=options.preserveSelection!==false;
  const oldStart=preserve&&panel.wordStartIndex!==null?panel.wordMetaMap.get(panel.wordStartIndex):null;
  const oldEnd=preserve&&panel.wordEndIndex!==null?panel.wordMetaMap.get(panel.wordEndIndex):null;
  const oldStartKey=oldStart?wordKey(oldStart):'';
  const oldEndKey=oldEnd?wordKey(oldEnd):'';

  panel.currentTranscript=transcript;
  panel.cues=Array.isArray(transcript?.cues)?transcript.cues:[];

  // Netflix's visible subtitle and the extension's fetched subtitle are independent.
  // Populate the selector from the player track list returned by Background.
  if(panel.trackSelect){
    const tracks=Array.isArray(transcript?.availableTracks)?transcript.availableTracks:[];
    const selectedId=String(transcript?.selectedTrackId||panel.preferredTrackId||'');
    panel.trackSelect.innerHTML='';
    for(const t of tracks){
      const opt=document.createElement('option');
      opt.value=String(t.trackId||'');
      const type=String(t.trackType||'').toUpperCase();
      const suffix=type==='CLOSEDCAPTIONS'?' [CC]':(type&&type!=='SUBTITLES'?` [${type}]`:'');
      opt.textContent=`${String(t.label||t.bcp47||t.language||'字幕')}${suffix}`;
      panel.trackSelect.appendChild(opt);
    }
    if(selectedId && [...panel.trackSelect.options].some(o=>o.value===selectedId)) panel.trackSelect.value=selectedId;
    panel.preferredTrackId=String(panel.trackSelect.value||selectedId||'');
    panel.trackSelect.disabled=tracks.length<2;
    if(panel.trackRow) panel.trackRow.style.display=tracks.length?'flex':'none';
  }

  panel.wordMap.clear(); panel.wordMetaMap.clear(); panel.rowMap.clear();
  panel.wordStartIndex=null; panel.wordEndIndex=null; panel.currentIndex=-1;

  if(!panel.cues.length){
    fullTranscriptLoaded=false;
    panel.list.innerHTML=`<div style="padding:22px 12px;color:#aaa;line-height:1.6">${escapeHtml(transcript?.reason||'Netflixの全字幕トラックを取得できませんでした。')}<br><br>英語字幕をONにしてNetflixページを再読み込みしてください。表示字幕を随時蓄積するフォールバックは使用しません。</div>`;
    if(panel.status)panel.status.textContent=String(transcript?.reason||'字幕を取得できませんでした').slice(0,180);
    updateFooter(); return;
  }

  fullTranscriptLoaded=transcript?.source==='netflix-full-track';
  panel.list.innerHTML='';
  const frag=document.createDocumentFragment();
  let foundStart=null,foundEnd=null;
  panel.cues.forEach((cue,ci)=>{
    const row=document.createElement('div'); row.dataset.index=String(ci);
    Object.assign(row.style,{display:'grid',gridTemplateColumns:'66px 1fr 42px',gap:'8px',alignItems:'start',padding:'9px 9px',margin:'0 0 4px',borderRadius:'7px',border:'1px solid transparent',background:'#202020',cursor:'default',transition:'background .12s,border-color .12s'});

    const time=document.createElement('button'); time.type='button'; time.textContent=formatTime(cue.start); time.title='この位置から再生';
    Object.assign(time.style,{border:'0',background:'transparent',color:'#9bbcff',padding:'2px 0',cursor:'pointer',textAlign:'left',fontSize:'10px',fontVariantNumeric:'tabular-nums',whiteSpace:'nowrap'});
    time.addEventListener('click',(e)=>{e.stopPropagation();seekTo(cue.start)});

    const text=document.createElement('div'); Object.assign(text.style,{fontSize:'14px',lineHeight:'1.62',wordBreak:'break-word',userSelect:'none',WebkitUserSelect:'none'});
    const words=Array.isArray(cue.words)&&cue.words.length?cue.words:[{globalIndex:ci*10000,text:cue.text,start:cue.start,end:cue.end,timingSource:'netflix-timedtext-interpolated'}];
    words.forEach((word,wi)=>{
      const idx=Number(word.globalIndex); const span=document.createElement('span'); span.dataset.nfanki='word'; span.textContent=word.text;
      const source=String(word.timingSource||'').includes('timedtext')?'Netflix字幕時刻から補間':'表示字幕区間から補間';
      span.title=`${formatTime(word.start)}〜${formatTime(word.end)}・${source}`;
      span.addEventListener('click',(e)=>{e.stopPropagation();handleWordClick(idx)});
      panel.wordMap.set(idx,span); panel.wordMetaMap.set(idx,{...word,globalIndex:idx,cueIndex:ci});
      if(oldStartKey&&wordKey(word)===oldStartKey)foundStart=idx;
      if(oldEndKey&&wordKey(word)===oldEndKey)foundEnd=idx;
      text.appendChild(span); if(wi<words.length-1)text.appendChild(document.createTextNode(' '));
    });

    const anki=document.createElement('button'); anki.type='button'; anki.textContent='Anki';
    Object.assign(anki.style,{border:'1px solid rgba(255,255,255,.12)',background:'#2a2a2a',color:'#eee',borderRadius:'6px',height:'28px',padding:'0 6px',cursor:'pointer',fontSize:'10px'});
    anki.addEventListener('click',async(e)=>{e.stopPropagation();if(words.length){panel.wordStartIndex=Number(words[0].globalIndex);panel.wordEndIndex=Number(words[words.length-1].globalIndex);refreshWordStyles();updateFooter();await saveSelectedRange();}});
    row.append(time,text,anki); panel.rowMap.set(ci,row); frag.appendChild(row);
  });
  panel.list.appendChild(frag);

  if(foundStart!==null)panel.wordStartIndex=foundStart;
  if(foundEnd!==null)panel.wordEndIndex=foundEnd;
  if(panel.wordStartIndex!==null&&panel.wordEndIndex!==null&&panel.wordEndIndex<panel.wordStartIndex)[panel.wordStartIndex,panel.wordEndIndex]=[panel.wordEndIndex,panel.wordStartIndex];

  const correctionCount=Number(transcript?.correctionCount||0);
  const allWords=panel.cues.flatMap(c=>Array.isArray(c.words)?c.words:[]);
  const lang=transcript?.trackName||transcript?.trackLanguage||'Netflix字幕';
  const format=transcript?.subtitleFormat?`・${transcript.subtitleFormat}`:'';
  if(panel.status)panel.status.textContent=`取得: ${lang}・${panel.cues.length}行・${allWords.length}語・全字幕${format}${correctionCount?`・補正${correctionCount}件`:''}`;

  refreshWordStyles(); updateFooter(); updateCurrentRow();
  if(options.focusCurrent!==false)setTimeout(()=>focusCurrentRow(true),60);
}

function handleWordClick(idx) {
  if (!Number.isFinite(idx)||!panel.wordMetaMap.has(idx)) return;
  panel.manualScrollUntil=Date.now()+5000;
  if (panel.wordStartIndex===null || panel.wordEndIndex!==null) { panel.wordStartIndex=idx; panel.wordEndIndex=null; }
  else { const a=panel.wordStartIndex; panel.wordStartIndex=Math.min(a,idx); panel.wordEndIndex=Math.max(a,idx); }
  refreshWordStyles(); updateFooter();
}
function refreshWordStyles(){
  for(const [idx,span] of panel.wordMap){span.classList.remove('anchor','range'); if(panel.wordStartIndex===null)continue; if(panel.wordEndIndex===null){if(idx===panel.wordStartIndex)span.classList.add('anchor')}else if(idx>=Math.min(panel.wordStartIndex,panel.wordEndIndex)&&idx<=Math.max(panel.wordStartIndex,panel.wordEndIndex))span.classList.add('range');}
}
function selectedWords(requireComplete=true){
  if(panel.wordStartIndex===null || (requireComplete&&panel.wordEndIndex===null)) return [];
  const end=panel.wordEndIndex===null?panel.wordStartIndex:panel.wordEndIndex; const out=[];
  for(let i=Math.min(panel.wordStartIndex,end);i<=Math.max(panel.wordStartIndex,end);i++){const w=panel.wordMetaMap.get(i);if(w)out.push(w)} return out;
}
function surroundingContext(words,radius=40){
  if(!words.length)return{before:'',after:''}; const start=Number(words[0].globalIndex),end=Number(words[words.length-1].globalIndex); const before=[],after=[];
  for(let i=Math.max(0,start-radius);i<start;i++){const w=panel.wordMetaMap.get(i);if(w?.text)before.push(w.text)}
  for(let i=end+1;i<=end+radius;i++){const w=panel.wordMetaMap.get(i);if(w?.text)after.push(w.text)}
  return{before:joinWords(before),after:joinWords(after)};
}
function updateFooter(){
  if(!panel.info)return;
  const words=selectedWords(false);
  if(panel.wordStartIndex===null){
    panel.info.textContent='開始単語をクリック → 終了単語をクリック';
  }else if(panel.wordEndIndex===null){
    const w=panel.wordMetaMap.get(panel.wordStartIndex);
    panel.info.textContent=`開始 ${formatTime(w?.start)}「${w?.text||''}」・終了単語をクリック`;
  }else if(words.length){
    panel.info.textContent=`${words.length}語・${formatTime(words[0].start)}〜${formatTime(words[words.length-1].end)}・Netflix字幕時刻から単語時刻を補間`;
  }
  const ready=panel.wordStartIndex!==null&&panel.wordEndIndex!==null;
  if(panel.save){panel.save.setAttribute('aria-disabled',ready?'false':'true');panel.save.style.opacity=ready?'1':'.45';}
  if(panel.correct){panel.correct.setAttribute('aria-disabled',ready?'false':'true');panel.correct.style.opacity=ready?'1':'.45';}
}
function clearSelection(){
  panel.wordStartIndex=null; panel.wordEndIndex=null; refreshWordStyles(); updateFooter();
}

async function saveSelectedRange(){
  const words=selectedWords(true); if(!words.length){showToast('開始単語と終了単語を選択してください',true);return}
  const ctx=surroundingContext(words);
  try{
    const r=await sendRuntimeMessage({type:'TRANSCRIPT_WORD_RANGE_SAVE',words,contextBefore:ctx.before,contextAfter:ctx.after,selectionStartVideoTime:Number(words[0].start),selectionEndVideoTime:Number(words[words.length-1].end),selectionEndAdjusted:false});
    if(!r?.ok)throw new Error(r?.error||'Anki保存に失敗しました');
    showToast('Ankiへ保存しました');
  }catch(err){showToast(err?.message||String(err),true)}
}
async function correctSelectedRange(){
  const words=selectedWords(true); if(!words.length){showToast('修正する単語範囲を選択してください',true);return}
  if(words.length>24){showToast('辞書修正は24語以内にしてください',true);return}
  const source=joinWords(words.map(w=>w.text)); const replacement=window.prompt(`誤字幕を修正してユーザー辞書へ登録します。\n\n修正前: ${source}\n\n正しい表記:`,source); if(replacement===null)return;
  const target=normalizeText(replacement); if(!target){showToast('修正後を入力してください',true);return}
  try{const r=await sendRuntimeMessage({type:'TRANSCRIPT_USER_CORRECTION',words,replacement:target});if(!r?.ok)throw new Error(r?.error||'辞書登録に失敗しました');showToast(`ユーザー辞書: ${r.from||source} → ${r.to||target}`);requestPanelRefresh(false)}catch(err){showToast(err?.message||String(err),true)}
}
function seekTo(sec){
  const target=Math.max(0,Number(sec)||0);
  const now=Date.now();
  if(now-lastSeekRequestAt<850){
    showToast('Netflix保護のため、連続シークは少し間隔を空けてください',true);
    return;
  }
  lastSeekRequestAt=now;
  try{
    const root=document.documentElement;
    if(!root?.getAttribute(NF_CONTROL_BUILD_ATTR)){
      showToast('Netflix制御ブリッジが未読込です。ページを1回再読み込みしてください',true);
      return;
    }
    root.setAttribute(NF_SEEK_SECONDS_ATTR,String(target));
    window.dispatchEvent(new Event('anki_netflix_seek_request'));
  }catch(err){showToast(err?.message||'Netflixの再生位置を変更できませんでした',true)}
}
function updateCurrentRow(){
  if(!panel.root||!panel.cues.length)return;
  const t=Number(netflixPlayerState().currentTime||0);
  let index=-1;
  for(let i=0;i<panel.cues.length;i++){
    const c=panel.cues[i];
    if(t>=Number(c.start)-0.08&&t<=Number(c.end)+0.12){index=i;break;}
    if(Number(c.start)<=t)index=i;
    else if(index>=0)break;
  }
  if(index===panel.currentIndex)return;
  const old=panel.rowMap.get(panel.currentIndex); if(old){old.style.background='#202020';old.style.borderColor='transparent';}
  panel.currentIndex=index;
  const row=panel.rowMap.get(index); if(row){row.style.background='#30331d';row.style.borderColor='#7a7d34';}
  if(panel.follow&&Date.now()>panel.manualScrollUntil)focusCurrentRow(false);
}
function focusCurrentRow(force=false){
  if(!panel.list)return;
  const row=panel.rowMap.get(panel.currentIndex);
  if(row){if(force||Date.now()>panel.manualScrollUntil)row.scrollIntoView({block:'center'});return;}
  if(force)panel.list.firstElementChild?.scrollIntoView({block:'start'});
}
function joinWords(parts){return normalizeText((parts||[]).join(' ')).replace(/\s+([,.;:!?…])/g,'$1')}
function formatTime(value){const total=Math.max(0,Number(value)||0);const m=Math.floor(total/60),s=total-m*60;return `${m}:${s.toFixed(2).padStart(5,'0')}`}
function escapeHtml(s){return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function showToast(message,isError=false){
  const old=document.getElementById('anki-netflix-dictation-toast');old?.remove();const el=document.createElement('div');el.id='anki-netflix-dictation-toast';el.className=`toast${isError?' error':''}`;el.textContent=String(message||'');
  Object.assign(el.style,{position:'fixed',right:'455px',bottom:'22px',maxWidth:'520px',background:'#151515',color:isError?'#ffdada':'#fff',border:`1px solid ${isError?'#b33':'#444'}`,borderRadius:'8px',padding:'10px 13px',zIndex:'2147483647',fontSize:'13px',boxShadow:'0 6px 24px rgba(0,0,0,.5)'});document.documentElement.appendChild(el);setTimeout(()=>el.remove(),4200);
}

// NetflixはSPA遷移する。watch IDが変わったら、その動画の全字幕を取り直す。
let lastWatchPath=location.pathname;
setInterval(()=>{
  if(location.pathname!==lastWatchPath){
    lastWatchPath=location.pathname;
    fullTranscriptLoaded=false;
    clearSelection();
    panel.currentIndex=-1;
    panel.currentTranscript=null;
    panel.cues=[];
    panel.wordMap.clear(); panel.wordMetaMap.clear(); panel.rowMap.clear();
    if(panel.list) panel.list.innerHTML='<div style="padding:22px 12px;color:#aaa;line-height:1.6">新しい動画の字幕を取得中…</div>';
    if(running){
      setLoading(true,false);
      setTimeout(()=>{if(running&&!fullTranscriptLoaded)requestPanelRefresh(true,false)},350);
      setTimeout(()=>{if(running&&!fullTranscriptLoaded)requestPanelRefresh(true,false)},1400);
      setTimeout(()=>{if(running&&!fullTranscriptLoaded)requestPanelRefresh(true,false)},3600);
    }
  }
},500);
})();
