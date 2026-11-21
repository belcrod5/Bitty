// Self-contained so the same function can run in the documented browser REPL.
// This helper only reads the selected existing tab; it never navigates or clicks.
export async function inspectExistingCart(tab, targetAsin) {
  if (targetAsin !== undefined && !/^[A-Z0-9]{10}$/.test(targetAsin)) throw new Error('対象ASINが不正です');
  const current = new URL(await tab.url());
  if (current.origin !== 'https://www.amazon.co.jp') throw new Error('Amazon.co.jpの既存タブを選択してください');
  const url = `${current.origin}${current.pathname}`;
  const base = { browser: 'existing-chrome-extension', url, readOnly: true };
  if (/^\/ap\//i.test(current.pathname)) return { ...base, cart: 'login_required', code: 'AUTH_REQUIRED' };
  if (/^(?:\/checkpoint(?:\/|$)|\/errors\/validateCaptcha)/i.test(current.pathname)) return { ...base, cart: 'verification_required', code: 'AUTH_REQUIRED' };
  const page = tab.playwright;
  const body = await page.locator('body').innerText({ timeoutMs: 1500 });
  if (/私は人間です|ロボットではないこと|not a robot|Enter the characters you see below/i.test(body)
      || await page.locator('input#captchacharacters, iframe[src*="captcha"], iframe[src*="checkpoint"]').count()) {
    return { ...base, cart: 'verification_required', code: 'AUTH_REQUIRED' };
  }
  const root = page.locator('#sc-active-cart, #sc-empty-cart');
  if (!/^\/(?:cart(?:\/ref=[^/]+)?\/?|gp\/cart\/view\.html)$/.test(current.pathname)
      || !await root.count() || !await root.first().isVisible()) {
    return { ...base, cart: 'unknown', code: 'CART_NOT_VISIBLE' };
  }
  const items = await page.locator('#sc-active-cart .sc-list-item[data-asin]').evaluateAll(elements => elements.map(e => ({
    asin: e.getAttribute('data-asin'),
    title: (e.querySelector('.sc-product-title .a-truncate-full') ?? e.querySelector('.sc-product-title'))?.textContent?.trim() ?? '',
    quantity: e.getAttribute('data-quantity') ?? e.querySelector('select[name="quantity"], input[name="quantityBox"], input.sc-quantity-textfield')?.value ?? e.querySelector('[data-a-selector="value"]')?.textContent?.trim() ?? null,
  })));
  const targetPresent = targetAsin === undefined ? null : items.some(item => item.asin === targetAsin);
  return { ...base, cart: 'visible', items, targetPresent, code: targetPresent === false ? 'ITEM_NOT_IN_CART' : null };
}

// Run in the browser tool's REPL, alongside inspectExistingCart above.
// Uses only the extension's documented locator APIs; no page-side interactions.
export async function runExistingChrome(tab, options = {}) {
  const { command = 'search', query = 'ボールペン', asin, index = 1, timeoutMs = 30_000 } = options;
  const events = [];
  const page = tab.playwright;
  const productAsin = path => path.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i)?.[1]?.toUpperCase();
  const cartPath = path => /^\/(?:cart(?:\/ref=[^/]+)?\/?|gp\/cart\/view\.html)$/.test(path);
  const searchPath = path => /^\/s(?:\/ref=[^/]+)?\/?$/.test(path);
  const ordersPath = path => /^\/(?:gp\/(?:css|your-account)\/order-history|your-orders\/(?:orders|order-history))(?:\/|$)/.test(path);
  async function currentURL() {
    const url = new URL(await tab.url());
    if (url.origin !== 'https://www.amazon.co.jp') throw new Error('OFFSITE_PAGE: Amazon.co.jpのタブを使用してください');
    return url;
  }
  async function result(fields) {
    const url = await currentURL();
    return { command, browser: 'existing-chrome-extension', motion: 'locator', bezier: false,
      url: `${url.origin}${url.pathname}`, events, ...fields, readOnly: events.length === 0 };
  }
  async function pause(type, target) {
    const delayMs = 500 + Math.floor(Math.random() * 501);
    await page.waitForTimeout(delayMs);
    events.push({ type, target, delayMs });
  }
  async function click(locator, label, beforeClick) {
    try { await locator.waitFor({ state: 'visible', timeoutMs }); }
    catch { throw new Error(`ELEMENT_NOT_FOUND: ${label}`); }
    if (await locator.count() !== 1 || !await locator.isEnabled()) throw new Error(`ELEMENT_UNAVAILABLE: ${label}`);
    await pause('click', label);
    await beforeClick?.();
    await locator.click({ timeoutMs });
  }
  async function clickLink(locator, label, permitted) {
    await click(locator, label, async () => {
      const href = await locator.getAttribute('href', { timeoutMs });
      if (!href) throw new Error(`INVALID_LINK: ${label}`);
      const destination = new URL(href, await tab.url());
      if (destination.origin !== 'https://www.amazon.co.jp' || !permitted(destination.pathname)) throw new Error(`INVALID_LINK: ${label}`);
    });
  }
  async function waitFor(read) {
    const deadline = Date.now() + timeoutMs;
    do {
      const state = await inspectExistingCart(tab);
      if (state.code === 'AUTH_REQUIRED') return result({ success: false, status: state.cart, code: state.code });
      const found = await read();
      if (found) return result({ success: true, ...found });
      await page.waitForTimeout(200);
    } while (Date.now() < deadline);
    throw new Error('RESULT_NOT_FOUND: 操作後の画面を確認できません');
  }
  async function search() {
    const input = page.locator('#twotabsearchtextbox');
    await click(input, 'search-input');
    if (!await input.evaluate(e => e === document.activeElement)) throw new Error('FOCUS_FAILED: 検索欄');
    await input.fill('', { timeoutMs });
    for (const character of query) {
      await pause('input', 'search-input');
      if (!await input.evaluate(e => e === document.activeElement)) throw new Error('FOCUS_LOST: 検索欄');
      await input.pressSequentially(character, { timeoutMs });
    }
    if (await input.evaluate(e => e.value) !== query) throw new Error('INPUT_MISMATCH: 検索文字列');
    const button = page.locator('#nav-search-submit-button');
    await click(button, 'search-submit', async () => {
      if (await input.evaluate(e => e.value) !== query) throw new Error('INPUT_MISMATCH: 検索文字列');
      const form = await button.evaluate(e => ({
        action: e.getAttribute('formaction') ? e.formAction : e.form?.action,
        method: (e.getAttribute('formmethod') ?? e.form?.method ?? '').toUpperCase(),
        sameForm: !!e.form?.querySelector('#twotabsearchtextbox'),
      }));
      const action = new URL(form.action);
      if (!form.sameForm || form.method !== 'GET' || action.origin !== 'https://www.amazon.co.jp' || !searchPath(action.pathname)) throw new Error('INVALID_SEARCH_FORM');
    });
    return waitFor(async () => {
      const url = await currentURL();
      if (!searchPath(url.pathname) || (url.searchParams.get('k') ?? url.searchParams.get('field-keywords')) !== query) return null;
      const rows = page.locator('[data-component-type="s-search-result"][data-asin]');
      const products = await rows.evaluateAll(elements => elements.filter(e => /^[A-Z0-9]{10}$/i.test(e.getAttribute('data-asin') ?? '')).map(e => ({
        asin: e.getAttribute('data-asin').toUpperCase(), title: e.querySelector('h2')?.textContent?.trim() ?? '',
      })));
      if (!products.length) {
        const empty = page.getByText(/検索に一致する商品はありません|No results/i);
        if (!await empty.count()) return null;
      }
      return { status: 'search_results', query, products, count: products.length };
    });
  }
  try {
    if (!['search', 'detail', 'orders', 'cart'].includes(command)) throw new Error('UNSUPPORTED_COMMAND: search・detail・orders・cartのみ対応');
    if (typeof query !== 'string' || !query.trim()) throw new Error('検索語を指定してください');
    if (!Number.isInteger(index) || index < 1) throw new Error('商品番号は1以上の整数で指定してください');
    if (asin !== undefined && !/^[A-Z0-9]{10}$/.test(asin)) throw new Error('対象ASINが不正です');
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error('タイムアウトは1〜30000msで指定してください');
    await currentURL();
    const initial = await inspectExistingCart(tab, command === 'cart' ? asin : undefined);
    if (initial.code === 'AUTH_REQUIRED') return result({ success: false, status: initial.cart, code: initial.code });
    if (command === 'cart') {
      if (initial.cart === 'visible') return result({ success: initial.code === null, status: 'cart', ...initial });
      const success = page.getByRole('link', { name: 'カートに移動', exact: true }).filter({ visible: true });
      const link = await success.count() ? success.first() : page.locator('#nav-cart');
      await clickLink(link, 'cart-link', cartPath);
      return await waitFor(async () => {
        const view = await inspectExistingCart(tab, asin);
        return view.cart === 'visible' ? { success: view.code === null, status: 'cart', ...view } : null;
      });
    }
    if (command === 'orders') {
      await clickLink(page.locator('#nav-orders'), 'orders-link', ordersPath);
      return await waitFor(async () => {
        if (!ordersPath((await currentURL()).pathname)) return null;
        const heading = page.getByRole('heading', { name: '注文履歴', exact: true }).first();
        return await heading.count() && await heading.isVisible() ? { status: 'orders' } : null;
      });
    }
    let expectedAsin = asin;
    if (command === 'search' || !asin) {
      const found = await search();
      if (!found.success || command === 'search') return found;
      expectedAsin = found.products[index - 1]?.asin;
      if (!expectedAsin) throw new Error('PRODUCT_INDEX_OUT_OF_RANGE');
      const row = page.locator(`[data-component-type="s-search-result"][data-asin="${expectedAsin}"]`).nth(found.products.slice(0, index - 1).filter(p => p.asin === expectedAsin).length);
      const link = row.locator(`a[href*="/dp/${expectedAsin}"], a[href*="/gp/product/${expectedAsin}"]`).filter({ visible: true }).first();
      await clickLink(link, 'product-link', path => productAsin(path) === expectedAsin);
    } else if (productAsin((await currentURL()).pathname) !== asin) {
      await pause('navigation', 'product-detail');
      await tab.goto(`https://www.amazon.co.jp/dp/${asin}`);
    }
    return await waitFor(async () => {
      const actual = productAsin((await currentURL()).pathname);
      if (actual && actual !== expectedAsin) throw new Error('ASIN_MISMATCH');
      const title = page.locator('#productTitle:visible');
      if (actual !== expectedAsin || !await title.count()) return null;
      return { status: 'product_detail', asin: actual, title: (await title.innerText({ timeoutMs })).trim() };
    });
  } catch (error) {
    // Extension exceptions may include authenticated URLs; never return their tokens.
    const message = String(error?.message ?? error).replace(/(?:https?|wss?):\/\/[^\s"'<>]+/g, value => {
      try { const u = new URL(value); return `${u.protocol}//${u.host}${u.pathname}`; } catch { return '[URL]'; }
    });
    throw new Error(message);
  }
}
