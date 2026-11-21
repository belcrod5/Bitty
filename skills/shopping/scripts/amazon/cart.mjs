import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { authentication, isCartPath, isAddPath, productAsin, safeValue } from './navigation.mjs';

export async function readOperation(directory, id) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id ?? '')) throw new Error('--operation は英数字・ハイフン・下線で1〜80文字を指定してください');
  return JSON.parse(await readFile(join(directory, `${id}.json`), 'utf8'));
}
export async function listOperations(directory) {
  const files = await readdir(directory).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
  const records = [];
  for (const file of files.filter(f => f.endsWith('.json')).sort()) records.push(await readOperation(directory, file.slice(0, -5)));
  return records;
}
export async function openOperation(directory, id, asin) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id ?? '')) throw new Error('--operation を指定してください（英数字・ハイフン・下線、1〜80文字）');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, `${id}.lock`);
  try { await mkdir(lock); } catch { throw new Error('OPERATION_LOCKED: 同じ操作を実行中か、前回異常終了のロックがあります。自動解除・新しいIDでの再追加はしません'); }
  let data;
  const release = () => rm(lock, { recursive: true });
  try {
    try { data = await readOperation(directory, id); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      data = { operation: id, asin, quantity: 1, addition: 'not_started', cart: 'not_opened', retryAdd: true, createdAt: new Date().toISOString() };
    }
    if (data.operation !== id || !['not_started', 'submitted', 'unknown', 'confirmed'].includes(data.addition)) throw new Error('操作記録が不正です。追加せず停止します');
    if (data.asin !== asin || data.quantity !== 1) throw new Error('操作IDに記録されたASIN・数量が異なります');
    async function update(fields) {
      data = safeValue({ ...data, ...fields, updatedAt: new Date().toISOString() });
      const temporary = join(directory, `${id}.json.tmp`);
      const file = await open(temporary, 'w', 0o600);
      try { await file.writeFile(JSON.stringify(data, null, 2)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, join(directory, `${id}.json`));
      // Make the rename durable before any mouse-down can submit a request.
      const dir = await open(directory, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
      return data;
    }
    await update({});
    return { get data() { return data; }, update, release };
  } catch (e) { await release(); throw e; }
}

export async function cartView(page) {
  const auth = await authentication(page);
  if (auth) return { cart: auth };
  if (!isCartPath(new URL(page.url()).pathname)) return null;
  const root = page.locator('#sc-active-cart, #sc-empty-cart');
  if (!await root.count() || !await root.first().isVisible()) return null;
  const items = await page.locator('#sc-active-cart .sc-list-item[data-asin]').evaluateAll(elements => elements.map(e => ({
    asin: e.getAttribute('data-asin'),
    title: e.querySelector('.sc-product-title')?.textContent?.trim() ?? '',
    quantity: e.querySelector('select[name="quantity"], input[name="quantityBox"], input.sc-quantity-textfield')?.value ?? e.querySelector('[data-a-selector="value"]')?.textContent?.trim() ?? null,
  })));
  return { cart: 'visible', items };
}
export async function openCart(page, mouse, log, timeout = 20_000) {
  let view = await cartView(page);
  if (view) return view;
  const current = new URL(page.url());
  if (current.hostname !== 'www.amazon.co.jp') await page.goto('https://www.amazon.co.jp/', { waitUntil: 'domcontentloaded' });
  view = await cartView(page);
  if (view) return view;
  const successLink = page.getByRole('link', { name: 'カートに移動', exact: true });
  const link = await successLink.count() ? successLink.first() : page.locator('#nav-cart');
  const destination = new URL(await link.getAttribute('href'), page.url());
  if (destination.hostname !== 'www.amazon.co.jp' || !isCartPath(destination.pathname)) throw new Error('カートへのリンクを確認できません');
  await mouse.click(link, 'cart link');
  const deadline = Date.now() + timeout;
  do {
    view = await cartView(page);
    if (view) { log('cart-view', view); return view; }
    await sleep(200);
  } while (Date.now() < deadline);
  throw new Error('カート内容・認証画面を確認できません（追加操作は再実行しません）');
}
async function additionConfirmed(page, asin) {
  if (await authentication(page)) return false;
  const scopes = page.locator('#sw-atc-details-single-container, #huc-v2-order-row, #attach-added-to-cart-message');
  for (let i = 0; i < await scopes.count(); i++) {
    const scope = scopes.nth(i);
    if (await scope.isVisible() && /カートに入れました|Added to Cart/i.test(await scope.innerText()) && await scope.locator(`a[href*="/dp/${asin}"]`).count()) return true;
  }
  if (!isAddPath(new URL(page.url()).pathname)) return false;
  return /カートに入れました|Added to Cart/i.test(await page.locator('body').innerText()) && await page.locator(`a[href*="/dp/${asin}"]`).count() > 0;
}
export async function runCartAddition({ page, mouse, log, operation, attempt, identity, timeout = 20_000 }) {
  const { asin } = operation.data;
  if (operation.data.addition === 'submitted' || operation.data.addition === 'unknown') {
    return operation.update({ addition: 'unknown', retryAdd: false, code: 'ADDITION_UNKNOWN' });
  }
  if (operation.data.addition !== 'confirmed') {
    if (operation.data.browserIdentity && operation.data.browserIdentity !== identity) throw new Error('操作途中でブラウザ接続先が変わっています');
    const auth = await authentication(page);
    if (auth) return operation.update({ cart: auth, code: 'AUTH_REQUIRED' });
    if (productAsin(new URL(page.url()).pathname) !== asin) throw new Error('対象ASINの商品ページではありません');
    const title = (await page.locator('#productTitle:visible').innerText()).trim();
    const button = page.locator('#add-to-cart-button');
    await button.waitFor({ state: 'visible' });
    if (!await button.isEnabled()) throw new Error('カート追加ボタンが無効です');
    const form = await button.evaluate(button => {
      const form = button.form;
      const quantity = document.querySelector('#quantity') ?? form?.elements.namedItem('quantity');
      return { action: button.getAttribute('formaction') ? button.formAction : form?.action, method: (button.getAttribute('formmethod') ?? form?.method ?? '').toUpperCase(), quantity: quantity?.value, asin: form?.elements.namedItem('ASIN')?.value ?? form?.elements.namedItem('ASIN.1')?.value };
    });
    const action = new URL(form.action);
    if (form.asin?.toUpperCase() !== asin) throw new Error('カート追加フォームの商品ASINが一致しません');
    if (form.quantity !== '1') throw new Error('数量が1であることを確認できません。数量変更や追加は行いません');
    if (action.origin !== 'https://www.amazon.co.jp' || !isAddPath(action.pathname) || form.method !== 'POST') throw new Error('未対応のカート追加フォームです');
    await operation.update({ title, browserIdentity: identity, quantity: 1 });
    log('quantity-confirmed', { asin, quantity: 1 });
    await mouse.click(button, 'add to cart', { beforeMouseDown: async () => {
      // Record the point of no automatic retry BEFORE submitting any event.
      await operation.update({ addition: 'submitted', retryAdd: false, submittedAt: new Date().toISOString() });
      attempt.action = action.href;
      attempt.armed = true;
    } });
    const deadline = Date.now() + timeout;
    let confirmed = false;
    do {
      if (await authentication(page)) break;
      if (attempt.consumed && await additionConfirmed(page, asin)) { confirmed = true; break; }
      await sleep(200);
    } while (Date.now() < deadline);
    attempt.armed = false;
    if (!confirmed) return operation.update({ addition: 'unknown', retryAdd: false, cart: await authentication(page) ?? 'not_opened', code: 'ADDITION_UNKNOWN' });
    await operation.update({ addition: 'confirmed', confirmedAt: new Date().toISOString(), retryAdd: false, code: null });
    log('addition-confirmed', { operation: operation.data.operation, asin, quantity: 1 });
  }
  // A confirmed operation only resumes this read-only step, including after restart.
  try {
    const view = await openCart(page, mouse, log, timeout);
    const targetPresent = view.cart === 'visible' ? view.items.some(item => item.asin === asin) : null;
    return await operation.update({ ...view, targetPresent, code: view.cart !== 'visible' ? 'AUTH_REQUIRED' : targetPresent ? null : 'ITEM_NOT_IN_CART' });
  } catch (e) {
    await operation.update({ cart: 'unknown', code: 'CART_VIEW_FAILED' });
    throw e;
  }
}
