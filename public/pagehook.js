// LinguaFlow page hook (MAIN world, YouTube only): observes the URLs the
// player itself uses to fetch caption data, so the extension can reuse a
// valid (POT-signed) timedtext URL for the full transcript. Observation
// only — no request is modified, blocked, or forged.
(() => {
  'use strict';
  let lastUrl = '';

  const post = (url) => {
    lastUrl = url;
    try {
      window.postMessage(
        { source: 'linguaflow-pagehook', type: 'timedtext-url', url },
        window.location.origin,
      );
    } catch (e) {
      /* ignore */
    }
  };

  const check = (value) => {
    try {
      const url = typeof value === 'string' ? value : value && value.url;
      if (typeof url === 'string' && url.indexOf('/api/timedtext') !== -1) post(url);
    } catch (e) {
      /* ignore */
    }
  };

  const originalFetch = window.fetch;
  window.fetch = function (input) {
    check(input);
    return originalFetch.apply(this, arguments);
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (_method, url) {
    check(url);
    return originalOpen.apply(this, arguments);
  };

  // The extension's content script loads later and asks for anything we saw.
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (data && data.source === 'linguaflow' && data.type === 'timedtext-query' && lastUrl) {
      post(lastUrl);
    }
  });
})();
