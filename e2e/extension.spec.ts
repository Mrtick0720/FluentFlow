import { chromium, expect, test, type BrowserContext, type Worker } from '@playwright/test';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import path from 'node:path';

const DIST = path.resolve(process.cwd(), 'dist');

const FIXTURE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Fixture Article</title></head>
<body>
  <article>
    <h1>Learning languages while reading</h1>
    <p>Reading real articles is one of the best ways to learn a language.</p>
    <p>Subtitles and bilingual text make the process even smoother.</p>
  </article>
</body></html>`;

/**
 * One local server plays two roles:
 *  - GET /            → fixture page the extension translates
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
        const content = JSON.stringify({ translations: texts.map((t) => `译文：${t}`) });
        res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
        res.end(
          JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }),
        );
      });
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
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForSelector('#lf-host', { state: 'attached' });

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

    const firstTranslation = page.locator('.lf-trans').first();
    await expect(firstTranslation).toContainText('译文：', { timeout: 15_000 });
    await expect(page.locator('html')).toHaveAttribute('data-lf-mode', 'bilingual');

    // Original text stays in place (bilingual mode).
    await expect(page.locator('article .lf-original').first()).toBeVisible();
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
    await expect(page.getByRole('button', { name: /翻译此页/ })).toBeVisible();
    await expect(page.getByRole('radio', { name: '双语' })).toBeVisible();
  } finally {
    await context.close();
  }
});
