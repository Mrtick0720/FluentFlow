import { chromium, expect, test, type BrowserContext, type Worker } from '@playwright/test';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import path from 'node:path';

const DIST = path.resolve(process.cwd(), 'dist');

const FIXTURE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Fixture Article</title>
<style>
  nav { align-items: center; background: #000; color: #fff; display: flex; height: 55px; }
  nav > a { display: flex; height: 44px; width: 22px; }
  nav img { height: 44px; width: 22px; }
  nav ul { align-items: stretch; display: flex; height: 55px; list-style: none; margin: 0; }
  nav li { align-items: center; display: flex; height: 55px; margin: 0 8px; white-space: nowrap; }
  nav li > a { align-items: center; display: flex; height: 55px; }
  .dropdown { position: absolute; visibility: hidden; }
</style></head>
<body>
  <nav>
    <a id="nba-logo" href="/"><img alt="NBA Logo"></a>
    <ul>
      <li id="summer"><a href="/summer"><span id="summer-label">Summer League</span></a></li>
      <li id="weekly"><a id="weekly-link" href="/weeklyedition">Weekly edition</a></li>
      <li id="teams"><a href="/teams"><span id="teams-label">Teams</span></a>
        <div id="teams-dropdown" class="dropdown">Atlantic Boston Celtics Brooklyn Nets New York Knicks Philadelphia 76ers Toronto Raptors</div>
      </li>
    </ul>
  </nav>
  <section class="hero">
    <p id="hero">Breaking coverage of the summer league finals tonight</p>
  </section>
  <article>
    <h1>Learning languages while reading</h1>
    <p id="body">Reading real articles is one of the best ways to learn a language.</p>
    <p>Subtitles and bilingual text make the process even smoother.</p>
  </article>
  <!-- A large video element so the content script's main-video path runs
       (regression guard for a startup crash that only triggered with video). -->
  <video width="800" height="450" muted></video>
</body></html>`;

const CAPTIONS_VTT = `WEBVTT

00:00:00.000 --> 01:00:00.000
English caption
`;

// Inner frame stands in for an embedded player (e.g. youtube-nocookie): a real
// video, one English caption source, and a "native" caption element whose
// opacity mirrors the track's showing state — so hiding the track hides it.
const EMBED_INNER_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Embedded player</title>
<style>
  html, body { margin: 0; background: #000; }
  video { width: 640px; height: 360px; background: #111; }
  .native-caption {
    position: fixed; left: 50%; bottom: 6%; transform: translateX(-50%);
    color: #fff; opacity: 1;
  }
</style></head>
<body>
  <video id="player" width="640" height="360" muted>
    <track id="cc" kind="captions" srclang="en" label="English" src="/captions.vtt" default>
  </video>
  <div class="native-caption"></div>
  <script>
    const v = document.getElementById('player');
    const track = v.textTracks[0];
    track.mode = 'showing'; // a normal player shows native captions by default
    const el = document.querySelector('.native-caption');
    setInterval(() => {
      el.style.opacity = track.mode === 'showing' ? '1' : '0';
      const cue = track.activeCues && track.activeCues[0];
      if (cue) el.textContent = cue.text;
    }, 100);
  </script>
</body></html>`;

const EMBED_OUTER_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Lesson</title></head>
<body>
  <h1>Lesson with an embedded player</h1>
  <iframe id="embed" src="/embed-inner" width="640" height="360" allow="autoplay"></iframe>
</body></html>`;

/**
 * One local server plays several roles:
 *  - GET /            → fixture page the extension translates
 *  - GET /embed-outer → page hosting an embedded player in an iframe
 *  - GET /embed-inner → the embedded player frame
 *  - GET /captions.vtt → English captions for the embedded player
 *  - POST /v1/chat/completions → OpenAI-compatible mock translation endpoint
 *    (CORS-open so the service worker can call it without host permissions)
 */
function startServer(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': '*',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (req.method === 'POST' && req.url?.includes('/chat/completions')) {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
        const userMsg = parsed.messages.findLast((m) => m.role === 'user')!;
        const texts = JSON.parse(userMsg.content) as string[];
        const labels: Record<string, string> = {
          'Summer League': '夏季联赛',
          'Weekly edition': '每周版',
          Teams: '球队',
          'English caption': '中文字幕',
        };
        const content = JSON.stringify({
          translations: texts.map((t) => labels[t] ?? `译文：${t}`),
        });
        res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
        res.end(
          JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }),
        );
      });
      return;
    }
    if (req.url === '/captions.vtt') {
      res.writeHead(200, { 'Content-Type': 'text/vtt', ...cors });
      res.end(CAPTIONS_VTT);
      return;
    }
    if (req.url?.startsWith('/embed-inner')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(EMBED_INNER_HTML);
      return;
    }
    if (req.url?.startsWith('/embed-outer')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(EMBED_OUTER_HTML);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(FIXTURE_HTML);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: (server.address() as AddressInfo).port }),
    );
  });
}

async function getServiceWorker(context: BrowserContext): Promise<Worker> {
  const existing = context.serviceWorkers();
  if (existing.length > 0) return existing[0]!;
  return context.waitForEvent('serviceworker');
}

test('loads the extension and translates a page end-to-end', async () => {
  const { server, port } = await startServer();
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });

  try {
    const sw = await getServiceWorker(context);

    // Point the extension at the mock provider (plaintext settings pass
    // migration untouched; caching off for determinism).
    await sw.evaluate(async (baseUrl: string) => {
      await chrome.storage.local.set({
        'lf-settings': {
          translationProvider: 'custom',
          providers: { custom: { baseUrl, model: 'mock' } },
          cache: { enabled: false, ttlHours: 1 },
        },
      });
    }, `http://127.0.0.1:${port}/v1`);

    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForSelector('#lf-host', { state: 'attached' });
    const logoTopBefore = await page.locator('#nba-logo').evaluate((el) =>
      el.getBoundingClientRect().top,
    );
    // The content script must not throw at startup on a page with a video.
    expect(pageErrors, pageErrors.join('\n')).toEqual([]);

    // Toggle page translation the way the toolbar/hotkey does: via a message
    // from the service worker to the tab's content script.
    await sw.evaluate(async () => {
      // Without the "tabs" permission tab.url is invisible to the extension,
      // so locate the fixture tab as the active one.
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id) throw new Error('fixture tab not found');
      await chrome.tabs.sendMessage(tab.id, {
        kind: 'lf-tab-request',
        type: 'content.toggleTranslation',
        payload: null,
      });
    });

    // Wait for translation to complete. Nav labels translate in place, so the
    // DOM-first .lf-trans is a short in-place label — assert on a body "译文：".
    await expect(page.locator('.lf-trans').filter({ hasText: '译文：' }).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator('html')).toHaveAttribute('data-lf-mode', 'bilingual');

    // Body paragraph stays bilingual: both the original and the translation exist.
    await expect(page.locator('#body .lf-original')).toBeVisible();
    await expect(page.locator('#body .lf-trans')).toContainText('译文：');
    // Hero content is translated in place (original hidden, no added block).
    await expect(page.locator('#hero.lf-replaced')).toHaveCount(1);
    await expect(page.locator('#hero .lf-original')).toBeHidden();
    // NBA-style navigation translates only the visible labels. Wrapping the
    // whole <li> would hide its anchor/dropdown structure and expose a merged
    // translation of every team name.
    await expect(page.locator('#summer-label.lf-replaced')).toHaveCount(1);
    await expect(page.locator('#teams-label.lf-replaced')).toHaveCount(1);
    await expect(page.locator('#summer.lf-replaced, #weekly.lf-replaced, #teams.lf-replaced')).toHaveCount(0);
    await expect(page.locator('#teams-dropdown')).toBeHidden();
    await expect(page.locator('#teams')).not.toContainText('译文：TeamsAtlantic');

    // Economist-style nav labels are direct text children of <a>. Translate
    // the anchor itself so its href and complete clickable hit area survive.
    await expect(page.locator('#weekly-link.lf-replaced')).toHaveCount(1);
    await expect(page.locator('#weekly-link')).toHaveAttribute('href', '/weeklyedition');
    await expect(page.locator('#weekly-link .lf-trans')).toHaveText('每周版');

    // In-place labels preserve the host nav's single-line geometry and do not
    // move the adjacent NBA logo. Measure the visible translation's line boxes
    // (the hidden original is display:none and must not be counted).
    const summerLines = await page
      .locator('#summer-label .lf-trans')
      .evaluate((el) => el.getClientRects().length);
    expect(summerLines).toBe(1);
    const logoTopAfter = await page.locator('#nba-logo').evaluate((el) =>
      el.getBoundingClientRect().top,
    );
    expect(logoTopAfter).toBe(logoTopBefore);
  } finally {
    await context.close();
    server.close();
  }
});

test('embedded subtitles show two bilingual lines and hide native captions', async () => {
  const { server, port } = await startServer();
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });

  try {
    const sw = await getServiceWorker(context);
    await sw.evaluate(async (baseUrl: string) => {
      await chrome.storage.local.set({
        'lf-settings': {
          translationProvider: 'custom',
          providers: { custom: { baseUrl, model: 'mock' } },
          cache: { enabled: false, ttlHours: 1 },
        },
      });
    }, `http://127.0.0.1:${port}/v1`);

    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/embed-outer`);
    await page.waitForSelector('#lf-host', { state: 'attached' });

    // Open subtitles from the top tab, the way the toolbar/hotkey command does.
    await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id) throw new Error('fixture tab not found');
      await chrome.tabs.sendMessage(tab.id, {
        kind: 'lf-tab-request',
        type: 'content.toggleSubtitle',
        payload: null,
      });
    });

    const frame = page.frameLocator('#embed');
    await expect(frame.locator('.lf-sub-original')).toHaveText('English caption', { timeout: 15_000 });
    await expect(frame.locator('.lf-sub-translation')).toHaveText('中文字幕');
    // The player's native caption line is hidden — only the two LinguaFlow lines show.
    await expect(frame.locator('.native-caption')).toHaveCSS('opacity', '0');
    await expect(frame.locator('.lf-sub-original, .lf-sub-translation')).toHaveCount(2);
  } finally {
    await context.close();
    server.close();
  }
});

test('popup renders quick controls', async () => {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });
  try {
    const sw = await getServiceWorker(context);
    const extensionId = new URL(sw.url()).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(page.getByText('LinguaFlow')).toBeVisible();
    await expect(page.getByRole('button', { name: /沉浸翻译/ })).toBeVisible();
    await expect(page.getByRole('radio', { name: '双语' })).toBeVisible();
  } finally {
    await context.close();
  }
});
