/**
 * Injects a LinguaFlow button into the YouTube player control bar (next to
 * settings / captions), matching the native control styling. Clicking it
 * reports the button's on-screen rect so the caller can open a menu anchored
 * to it. Re-injects across YouTube's SPA navigations.
 */
export function injectYouTubePlayerButton(onClick: (rect: DOMRect) => void): () => void {
  const BTN_ID = 'lf-yt-button';
  let disposed = false;

  function ensure(): void {
    if (disposed) return;
    const controls = document.querySelector('.ytp-right-controls');
    if (!controls || controls.querySelector(`#${BTN_ID}`)) return;

    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.className = 'ytp-button';
    btn.title = 'LinguaFlow 翻译 / 字幕';
    btn.setAttribute('aria-label', 'LinguaFlow');
    Object.assign(btn.style, {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      verticalAlign: 'top',
    });

    const img = document.createElement('img');
    img.src = chrome.runtime.getURL('icons/icon48.png');
    img.alt = '';
    Object.assign(img.style, {
      width: '24px',
      height: '24px',
      borderRadius: '5px',
    });
    btn.appendChild(img);

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick(btn.getBoundingClientRect());
    });

    // Place at the far-right end of the control bar (after fullscreen).
    controls.appendChild(btn);
  }

  ensure();
  // YouTube rebuilds the player on navigation; keep the button present.
  const observer = new MutationObserver(() => ensure());
  observer.observe(document.body, { childList: true, subtree: true });
  const onNav = () => setTimeout(ensure, 300);
  window.addEventListener('yt-navigate-finish', onNav);

  return () => {
    disposed = true;
    observer.disconnect();
    window.removeEventListener('yt-navigate-finish', onNav);
    document.querySelector(`#${BTN_ID}`)?.remove();
  };
}
