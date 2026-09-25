(() => {
  const HOOK_BUILD = '7.9.0';
  if (window.__ANKI_NETFLIX_TIMEDTEXT_HOOK_BUILD__ === HOOK_BUILD) return;
  window.__ANKI_NETFLIX_TIMEDTEXT_HOOK_BUILD__ = HOOK_BUILD;

  const CACHE_KEY = '__ANKI_NETFLIX_TIMEDTEXT_MANIFEST_CACHE__';
  const OVERRIDE_KEY = '__ANKI_NETFLIX_TIMEDTEXT_ID_OVERRIDES__';
  const STATUS_KEY = '__ANKI_NETFLIX_TIMEDTEXT_HOOK_STATUS__';
  const CACHE_LIMIT = 20;
  const REQUESTED_FORMATS = ['imsc1.1', 'dfxp-ls-sdh', 'webvtt-lssdh-ios8', 'simplesdh'];
  const MANIFEST_PATTERN = /manifest|licensedManifest/i;

  const cache = Array.isArray(window[CACHE_KEY]) ? window[CACHE_KEY] : [];
  window[CACHE_KEY] = cache;
  const idOverrides = window[OVERRIDE_KEY] && typeof window[OVERRIDE_KEY] === 'object'
    ? window[OVERRIDE_KEY]
    : {};
  window[OVERRIDE_KEY] = idOverrides;
  const status = window[STATUS_KEY] && typeof window[STATUS_KEY] === 'object'
    ? window[STATUS_KEY]
    : {};
  Object.assign(status, {
    build: HOOK_BUILD,
    installedAt: Date.now(),
    captures: Number(status.captures || 0),
    parseHits: Number(status.parseHits || 0),
    responseJsonHits: Number(status.responseJsonHits || 0),
    fetchManifestHits: Number(status.fetchManifestHits || 0),
    xhrManifestHits: Number(status.xhrManifestHits || 0),
    lastSource: String(status.lastSource || ''),
    lastMovieId: String(status.lastMovieId || ''),
    lastTrackCount: Number(status.lastTrackCount || 0),
    lastError: ''
  });
  window[STATUS_KEY] = status;

  function markDom() {
    try {
      const root = document.documentElement;
      if (!root) return;
      root.setAttribute('data-anki-netflix-main-hook', HOOK_BUILD);
      root.setAttribute('data-anki-netflix-main-hook-captures', String(status.captures || 0));
      root.setAttribute('data-anki-netflix-main-hook-last', `${status.lastMovieId || ''}:${status.lastTrackCount || 0}`);
    } catch {}
  }
  markDom();
  document.addEventListener('DOMContentLoaded', markDom, { once: true });

  const originalParse = JSON.parse;
  const originalStringify = JSON.stringify;
  const originalFetch = window.fetch;
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalResponseJson = Response?.prototype?.json;

  function extractUrls(downloadable) {
    if (!downloadable || typeof downloadable !== 'object') return [];
    let urls = [];
    if (downloadable.downloadUrls && typeof downloadable.downloadUrls === 'object') {
      urls = Object.values(downloadable.downloadUrls);
    } else if (Array.isArray(downloadable.urls)) {
      urls = downloadable.urls.map(item => typeof item === 'string' ? item : item?.url);
    }
    return [...new Set(urls.filter(url => typeof url === 'string' && url.length > 0))];
  }

  // Keep every subtitle format Netflix exposes. Filtering to four profile names here
  // caused valid manifests to be discarded before the background could inspect them.
  function copyTrack(track) {
    if (!track || typeof track !== 'object' || track.isNoneTrack) return null;
    const source = track.ttDownloadables && typeof track.ttDownloadables === 'object'
      ? track.ttDownloadables
      : {};
    const downloadables = {};
    for (const [format, value] of Object.entries(source)) {
      const urls = extractUrls(value);
      if (urls.length) downloadables[String(format)] = urls;
    }
    return {
      language: String(track.language || ''),
      bcp47: String(track.bcp47 || track.language || ''),
      languageDescription: String(track.languageDescription || track.displayName || track.language || ''),
      rawTrackType: String(track.rawTrackType || track.trackType || ''),
      trackVariant: String(track.trackVariant || ''),
      isForcedNarrative: !!track.isForcedNarrative,
      isNoneTrack: !!track.isNoneTrack,
      downloadables
    };
  }

  function captureResult(result, source) {
    try {
      if (!result || !Array.isArray(result.timedtexttracks) || result.movieId == null) return false;
      const tracks = result.timedtexttracks.map(copyTrack).filter(Boolean);
      const movieId = String(result.movieId);
      const now = Date.now();
      const item = { movieId, tracks, time: now, source: String(source || '') };
      const existing = cache.findIndex(entry => String(entry?.movieId || '') === movieId);
      if (existing >= 0) cache.splice(existing, 1);
      cache.push(item);
      if (cache.length > CACHE_LIMIT) cache.splice(0, cache.length - CACHE_LIMIT);

      status.captures = Number(status.captures || 0) + 1;
      status.lastSource = String(source || '');
      status.lastMovieId = movieId;
      status.lastTrackCount = tracks.length;
      status.lastCaptureAt = now;
      status.lastError = tracks.some(t => Object.keys(t.downloadables || {}).length)
        ? ''
        : 'timedtexttracks-captured-but-no-download-urls';
      markDom();
      try {
        window.dispatchEvent(new CustomEvent('anki_netflix_timedtext_manifest', {
          detail: { movieId, trackCount: tracks.length, time: now, source: String(source || '') }
        }));
      } catch {}
      return true;
    } catch (error) {
      status.lastError = String(error?.message || error || 'capture-error');
      return false;
    }
  }

  function inspectPayload(data, source) {
    try {
      if (!data || typeof data !== 'object') return false;
      if (Array.isArray(data.timedtexttracks) && data.movieId != null) return captureResult(data, source);
      if (data.result && Array.isArray(data.result.timedtexttracks) && data.result.movieId != null) {
        return captureResult(data.result, source + '.result');
      }
    } catch (error) {
      status.lastError = String(error?.message || error || 'inspect-error');
    }
    return false;
  }

  // Netflix sometimes parses the licensed manifest through the page's JSON.parse.
  JSON.parse = function (text, reviver) {
    const data = originalParse.call(JSON, text, reviver);
    try {
      if (inspectPayload(data, 'JSON.parse')) status.parseHits = Number(status.parseHits || 0) + 1;
    } catch (error) {
      status.lastError = String(error?.message || error || 'json-parse-hook-error');
    }
    return data;
  };

  // Some player paths use Response.json(), which does not have to call the overwritten
  // global JSON.parse. Inspect that result independently.
  if (originalResponseJson) {
    Response.prototype.json = async function (...args) {
      const data = await originalResponseJson.apply(this, args);
      try {
        if (inspectPayload(data, `Response.json:${String(this.url || '')}`)) {
          status.responseJsonHits = Number(status.responseJsonHits || 0) + 1;
        }
      } catch (error) {
        status.lastError = String(error?.message || error || 'response-json-hook-error');
      }
      return data;
    };
  }

  // Request the subtitle profiles before Netflix serializes its manifest request.
  JSON.stringify = function (data, replacer, space) {
    try {
      if (data && typeof data.url === 'string' && MANIFEST_PATTERN.test(data.url)) {
        for (const value of Object.values(data)) {
          try {
            if (Array.isArray(value?.profiles)) {
              for (const profile of REQUESTED_FORMATS) {
                if (!value.profiles.includes(profile)) value.profiles.unshift(profile);
              }
            }
            if (value && value.showAllSubDubTracks != null) value.showAllSubDubTracks = true;
          } catch (error) {
            if (!(error instanceof TypeError)) throw error;
          }
        }
      }
      if (data && typeof data.movieId === 'number') {
        try {
          const playerVideoId = data.params.sessionParams.uiplaycontext.video_id;
          if (typeof playerVideoId === 'number' && playerVideoId !== data.movieId) {
            idOverrides[String(playerVideoId)] = String(data.movieId);
          }
        } catch {}
      }
    } catch (error) {
      status.lastError = String(error?.message || error || 'json-stringify-hook-error');
    }
    return originalStringify.call(JSON, data, replacer, space);
  };

  // Also inspect the actual manifest network response. This catches player code that
  // parses JSON internally or in a path that bypasses the page's JSON.parse wrapper.
  if (typeof originalFetch === 'function') {
    window.fetch = function (...args) {
      const promise = originalFetch.apply(this, args);
      try {
        const requestUrl = typeof args[0] === 'string' ? args[0] : String(args[0]?.url || '');
        if (MANIFEST_PATTERN.test(requestUrl)) {
          status.fetchManifestHits = Number(status.fetchManifestHits || 0) + 1;
          Promise.resolve(promise).then(async response => {
            try {
              const clone = response.clone();
              const text = await clone.text();
              if (!text) return;
              let parsed;
              try { parsed = originalParse.call(JSON, text); } catch { return; }
              inspectPayload(parsed, `fetch:${requestUrl}`);
            } catch (error) {
              status.lastError = String(error?.message || error || 'fetch-manifest-inspect-error');
            }
          }).catch(() => {});
        }
      } catch (error) {
        status.lastError = String(error?.message || error || 'fetch-hook-error');
      }
      return promise;
    };
  }

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      const requestUrl = String(url || '');
      if (MANIFEST_PATTERN.test(requestUrl)) {
        status.xhrManifestHits = Number(status.xhrManifestHits || 0) + 1;
        this.addEventListener('load', async function () {
          try {
            let data = this.response;
            if (data instanceof Blob) data = await data.text();
            if (typeof data === 'string') {
              try { data = originalParse.call(JSON, data); } catch { return; }
            }
            inspectPayload(data, `XHR:${requestUrl}`);
          } catch (error) {
            status.lastError = String(error?.message || error || 'xhr-manifest-inspect-error');
          }
        }, { once: true });
      }
    } catch (error) {
      status.lastError = String(error?.message || error || 'xhr-hook-error');
    }
    return originalXhrOpen.call(this, method, url, ...rest);
  };
})();
