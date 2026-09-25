(() => {
  if (window.__ANKI_YT_TIMEDTEXT_HOOK_INSTALLED__) return;
  window.__ANKI_YT_TIMEDTEXT_HOOK_INSTALLED__ = true;

  const CACHE_KEY = '__ANKI_YT_TIMEDTEXT_CACHE__';
  const cache = Array.isArray(window[CACHE_KEY]) ? window[CACHE_KEY] : [];
  window[CACHE_KEY] = cache;

  try { performance.setResourceTimingBufferSize(5000); } catch {}

  const isTimedText = (url) => {
    const s = String(url || '');
    return s.includes('/api/timedtext') || s.includes('timedtext?');
  };

  const upsert = (url, body = '', contentType = '', source = '') => {
    if (!isTimedText(url)) return;
    const now = Date.now();
    const sUrl = String(url || '');
    const sBody = typeof body === 'string' ? body : '';
    let item = cache.find(x => x && x.url === sUrl);
    if (!item) {
      item = { url: sUrl, body: sBody, contentType: String(contentType || ''), source: String(source || ''), time: now };
      cache.push(item);
    } else {
      if (sBody.length >= String(item.body || '').length) item.body = sBody;
      if (contentType) item.contentType = String(contentType);
      if (source) item.source = String(source);
      item.time = now;
    }
    cache.sort((a, b) => Number(a.time || 0) - Number(b.time || 0));
    if (cache.length > 80) cache.splice(0, cache.length - 80);
  };

  // YouTube自身のfetchを壊さず、レスポンスのcloneだけを非同期で保存する。
  try {
    const originalFetch = window.fetch;
    if (typeof originalFetch === 'function') {
      window.fetch = async function (...args) {
        const response = await originalFetch.apply(this, args);
        try {
          const req = args[0];
          const url = typeof req === 'string' ? req : (req?.url || response?.url || '');
          if (isTimedText(url)) {
            const clone = response.clone();
            clone.text().then(body => {
              upsert(url, body, clone.headers.get('content-type') || '', 'fetch');
            }).catch(() => upsert(url, '', '', 'fetch-url'));
          }
        } catch {}
        return response;
      };
    }
  } catch {}

  // 字幕取得がXHR経由のA/Bテストにも対応する。
  try {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      try { this.__ankiTimedTextUrl = String(url || ''); } catch {}
      return originalOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...args) {
      try {
        if (isTimedText(this.__ankiTimedTextUrl)) {
          this.addEventListener('load', () => {
            try {
              let body = '';
              if (!this.responseType || this.responseType === 'text') body = String(this.responseText || '');
              else if (typeof this.response === 'string') body = this.response;
              upsert(this.__ankiTimedTextUrl, body, this.getResponseHeader('content-type') || '', 'xhr');
            } catch {
              upsert(this.__ankiTimedTextUrl, '', '', 'xhr-url');
            }
          }, { once: true });
        }
      } catch {}
      return originalSend.apply(this, args);
    };
  } catch {}

  // 既に発生済み、またはfetch/XHR以外で発生した字幕URLも保持する。
  const collectPerformance = () => {
    try {
      for (const entry of performance.getEntriesByType('resource')) {
        if (isTimedText(entry?.name)) upsert(entry.name, '', '', 'performance');
      }
    } catch {}
  };
  collectPerformance();
  try {
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (isTimedText(entry?.name)) upsert(entry.name, '', '', 'performance-observer');
      }
    });
    observer.observe({ type: 'resource', buffered: true });
    window.__ANKI_YT_TIMEDTEXT_PERF_OBSERVER__ = observer;
  } catch {}
})();
