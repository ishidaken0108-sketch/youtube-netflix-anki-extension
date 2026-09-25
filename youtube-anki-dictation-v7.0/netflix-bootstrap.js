(() => {
  if (window.__ANKI_NETFLIX_BOOTSTRAP_INSTALLED__) return;
  window.__ANKI_NETFLIX_BOOTSTRAP_INSTALLED__ = true;

  const inject = () => {
    try {
      const root = document.head || document.documentElement;
      if (!root) return false;
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('netflix-page-hook.js');
      script.dataset.ankiNetflixPageHook = '7.7.0';
      script.onload = () => script.remove();
      script.onerror = () => script.remove();
      root.appendChild(script);
      return true;
    } catch {
      return false;
    }
  };

  if (inject()) return;
  const observer = new MutationObserver(() => {
    if (inject()) observer.disconnect();
  });
  observer.observe(document, { childList: true, subtree: true });
})();
