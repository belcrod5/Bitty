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
