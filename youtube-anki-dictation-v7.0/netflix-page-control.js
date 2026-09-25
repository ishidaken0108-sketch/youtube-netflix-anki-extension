(() => {
  const BUILD = '9.3.0';
  const ROOT = document.documentElement;
  const ACTIVE_ATTR = 'data-anki-netflix-control-active';
  const BUILD_ATTR = 'data-anki-netflix-main-control-build';
  const TIME_ATTR = 'data-anki-netflix-player-time';
  const RATE_ATTR = 'data-anki-netflix-player-rate';
  const PAUSED_ATTR = 'data-anki-netflix-player-paused';
  const MOVIE_ATTR = 'data-anki-netflix-player-movie-id';
  const SEEK_ATTR = 'data-anki-netflix-seek-seconds';
  const SEEK_STATUS_ATTR = 'data-anki-netflix-seek-status';
  let stateTimer = null;
  let lastSeekAt = 0;
  let queuedSeek = null;
  let queuedTimer = null;

  try { ROOT?.setAttribute(BUILD_ATTR, BUILD); } catch {}

  const getVideoPlayer = () => globalThis.netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer;
  const getPlayer = () => {
    try {
      const vp = getVideoPlayer();
      const ids = vp?.getAllPlayerSessionIds?.() || [];
      if (!ids.length) return undefined;
      return vp.getVideoPlayerBySessionId?.(ids[ids.length - 1]);
    } catch { return undefined; }
  };
  const bestVideo = () => {
    const videos = [...document.querySelectorAll('video')];
    videos.sort((a,b)=>{
      const sa=(a.clientWidth||0)*(a.clientHeight||0)+(a.readyState||0)*1000+(!a.paused?500:0);
      const sb=(b.clientWidth||0)*(b.clientHeight||0)+(b.readyState||0)*1000+(!b.paused?500:0);
      return sb-sa;
    });
    return videos[0] || null;
  };
  const normalizeSeconds = (raw, fallback) => {
    const n=Number(raw), f=Number(fallback);
    if(!Number.isFinite(n)) return Number.isFinite(f)?f:0;
    if(Number.isFinite(f)) return Math.abs(n/1000-f)<Math.abs(n-f)?n/1000:n;
    return n>10000?n/1000:n;
  };
  const publishState = () => {
    if (ROOT?.getAttribute(ACTIVE_ATTR) !== '1') return;
    const player = getPlayer();
    const video = bestVideo();
    let time = Number(video?.currentTime || 0);
    let rate = Number(video?.playbackRate || 1);
    let paused = !!video?.paused;
    let movieId = '';
    try { time = normalizeSeconds(player?.getCurrentTime?.(), time); } catch {}
    try {
      const r = Number(player?.getPlaybackRate?.());
      if (Number.isFinite(r) && r > 0) rate = r;
    } catch {}
    try {
      const p = player?.isPaused?.();
      if (typeof p === 'boolean') paused = p;
    } catch {}
    try { movieId = String(player?.getMovieId?.() || ''); } catch {}
    try {
      ROOT.setAttribute(TIME_ATTR, String(Number.isFinite(time) ? time : 0));
      ROOT.setAttribute(RATE_ATTR, String(Number.isFinite(rate) && rate > 0 ? rate : 1));
      ROOT.setAttribute(PAUSED_ATTR, paused ? '1' : '0');
      if (movieId) ROOT.setAttribute(MOVIE_ATTR, movieId); else ROOT.removeAttribute(MOVIE_ATTR);
    } catch {}
  };
  const startState = () => {
    if (stateTimer) clearInterval(stateTimer);
    publishState();
    stateTimer = setInterval(publishState, 120);
  };
  const stopState = () => {
    if (stateTimer) clearInterval(stateTimer);
    stateTimer = null;
  };
  const doSeek = async (seconds) => {
    const sec = Math.max(0, Number(seconds) || 0);
    const player = getPlayer();
    if (!player || typeof player.seek !== 'function') {
      try { ROOT?.setAttribute(SEEK_STATUS_ATTR, 'player-unavailable'); } catch {}
      return;
    }
    try {
      // Netflix player API expects milliseconds. Avoid directly mutating HTMLMediaElement.currentTime;
      // with DRM playback that can desynchronize Cadmium/player state and trigger M7375.
      player.seek(Math.round(sec * 1000));
      try { ROOT?.setAttribute(SEEK_STATUS_ATTR, 'ok'); } catch {}
      setTimeout(() => { try { player.play?.(); } catch {} }, 120);
      setTimeout(publishState, 180);
    } catch (err) {
      try { ROOT?.setAttribute(SEEK_STATUS_ATTR, `error:${String(err?.message || err || 'unknown').slice(0,120)}`); } catch {}
    }
  };
  const requestSeek = () => {
    const sec = Number(ROOT?.getAttribute(SEEK_ATTR));
    if (!Number.isFinite(sec)) return;
    const now = Date.now();
    const minGap = 900;
    if (now - lastSeekAt >= minGap) {
      lastSeekAt = now;
      queuedSeek = null;
      if (queuedTimer) { clearTimeout(queuedTimer); queuedTimer = null; }
      doSeek(sec);
      return;
    }
    // Coalesce rapid clicks to one final seek instead of hammering Netflix with multiple skips.
    queuedSeek = sec;
    if (!queuedTimer) {
      queuedTimer = setTimeout(() => {
        queuedTimer = null;
        if (queuedSeek === null) return;
        const target = queuedSeek;
        queuedSeek = null;
        lastSeekAt = Date.now();
        doSeek(target);
      }, Math.max(0, minGap - (now - lastSeekAt)));
    }
  };

  window.addEventListener('anki_netflix_control_start', startState);
  window.addEventListener('anki_netflix_control_stop', stopState);
  window.addEventListener('anki_netflix_seek_request', requestSeek);
  if (ROOT?.getAttribute(ACTIVE_ATTR) === '1') startState();
})();
