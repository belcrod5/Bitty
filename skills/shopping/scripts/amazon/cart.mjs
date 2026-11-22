import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { authentication, isCartPath, isAddPath, productAsin, safeValue, addDataError, addQuantityEvidence } from './navigation.mjs';
import { readProductDetails } from './catalog.mjs';
import { pause } from './motion.mjs';

function yenAmount(value) {
  const match = value?.normalize('NFKC').match(/^[¥￥]\s*([\d,]+)$/);
  const n = match ? Number(match[1].replaceAll(',', '')) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

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
export async function openOperation(directory, id, asin, constraints = {}, removal) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id ?? '')) throw new Error('--operation を指定してください（英数字・ハイフン・下線、1〜80文字）');
  const kind = removal ? 'cart-remove' : 'cart-add';
  const quantity = removal?.quantity ?? 1;
  if (removal && (!/^[\w-]{1,80}$/.test(removal.itemId ?? '') || !Number.isSafeInteger(quantity) || quantity < 1)) throw new Error('削除対象の行ID・数量が不正です');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, `${id}.lock`);
  try { await mkdir(lock); } catch { throw new Error('OPERATION_LOCKED: 同じ操作を実行中か、前回異常終了のロックがあります。自動解除・新しいIDでの再追加はしません'); }
  let data;
  const release = () => rm(lock, { recursive: true });
  try {
    try { data = await readOperation(directory, id); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      data = { operation: id, kind, asin, quantity, cart: 'not_opened', ...(removal ? { itemId: removal.itemId, removal: 'not_started', retryAdd: false } : { addition: 'not_started', retryAdd: true }), createdAt: new Date().toISOString() };
    }
    if (data.fromAsin) throw new Error('旧色変更記録はcart-statusで確認してください。汎用操作として再実行できません');
    if ((data.kind ?? 'cart-add') !== kind) throw new Error('操作IDに記録された操作種別が異なります');
    const state = removal ? data.removal : data.addition;
    if (data.operation !== id || !['not_started', 'submitted', 'unknown', 'confirmed'].includes(state)) throw new Error('操作記録が不正です。停止します');
    if (data.asin !== asin || data.quantity !== quantity || removal && data.itemId !== removal.itemId) throw new Error('操作IDに記録されたASIN・行ID・数量が異なります');
    if (state === 'not_started' && (data.constraints?.color || data.constraints?.size)) throw new Error('旧色・サイズ条件の未送信記録です。内容を確認してから移行してください');
    if (Object.entries(constraints).some(([key, value]) => data.constraints?.[key] !== undefined ? data.constraints[key] !== value : state !== 'not_started')) throw new Error('操作IDに記録された条件を変更できません');
    data.constraints = { ...data.constraints, ...constraints };
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
  const items = await page.locator('#sc-active-cart .sc-list-item[data-asin]').evaluateAll(elements => elements.filter(e => e.getClientRects().length && !['true','1'].includes(e.getAttribute('data-removed')) && e.getAttribute('data-itemtype') !== 'removed').map(e => ({
    asin: e.getAttribute('data-asin'),
    itemId: e.getAttribute('data-itemid'),
    productUrl: /^[A-Z0-9]{10}$/i.test(e.getAttribute('data-asin') ?? '') ? `https://www.amazon.co.jp/dp/${e.getAttribute('data-asin').toUpperCase()}` : null,
    title: (e.getAttribute('data-producttitle') || e.querySelector('.sc-product-title .a-truncate-full, .sc-product-title')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500),
    quantity: e.querySelector('select[name="quantity"], input[name="quantityBox"], input.sc-quantity-textfield')?.value ?? e.querySelector('[data-a-selector="value"]')?.textContent?.trim() ?? null,
    priceText: e.querySelector('[data-feature-id="sc-item-price"] .apex-price-to-pay-value .a-offscreen, .sc-product-price')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
    variantText: [...e.querySelectorAll('.sc-product-variation')].slice(0, 10).map(element => element.textContent.replace(/\s+/g, ' ').trim().slice(0, 300)),
    selected: e.hasAttribute('data-isselected') ? e.getAttribute('data-isselected') === '1' : e.querySelector('.sc-item-check-checkbox-selector input')?.checked ?? null,
  })));
  const subtotalText = (await page.locator('#sc-subtotal-amount-buybox').allTextContents())[0]?.replace(/\s+/g, ' ').trim() ?? null;
  const subtotalLabel = (await page.locator('#sc-subtotal-label-buybox').allTextContents())[0]?.replace(/\s+/g, ' ').trim() ?? null;
  const quantitiesComplete = items.every(item => /^[1-9]\d*$/.test(item.quantity ?? ''));
  const complete = quantitiesComplete && items.every(item => yenAmount(item.priceText) !== null);
  const allItemsSubtotalYen = complete ? items.reduce((sum, item) => sum + yenAmount(item.priceText) * Number(item.quantity), 0) : null;
  const selectedItemsSubtotalYen = complete && items.every(item => item.selected !== null) ? items.filter(item => item.selected).reduce((sum, item) => sum + yenAmount(item.priceText) * Number(item.quantity), 0) : null;
  return { cart: 'visible', items, subtotalText, subtotalYen: yenAmount(subtotalText), subtotalLabel,
    allItemsSubtotalYen, allItemsQuantity: quantitiesComplete ? items.reduce((sum, item) => sum + Number(item.quantity), 0) : null,
    selectedItemsSubtotalYen, subtotalMatchesSelectedItems: selectedItemsSubtotalYen !== null && yenAmount(subtotalText) !== null ? selectedItemsSubtotalYen === yenAmount(subtotalText) : null,
    totalsComplete: complete, subtotalScope: 'selected-items', includesShipping: false };
}
export async function openCart(page, mouse, log, timeout = 20_000) {
  let view = await cartView(page);
  if (view) return view;
  const current = new URL(page.url());
  if (current.hostname !== 'www.amazon.co.jp') {
    await pause(log, 'before opening Amazon home', 1500, 3000);
    await page.goto('https://www.amazon.co.jp/', { waitUntil: 'domcontentloaded' });
  }
  view = await cartView(page);
  if (view) return view;
  const successLink = page.getByRole('link', { name: 'カートに移動', exact: true });
  const header = page.locator('#nav-cart:visible');
  const link = await header.count() ? header : successLink.first();
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
  const productLink = `a[href*="/dp/${asin}"], a[href*="/gp/product/${asin}"]`;
  const scopes = page.locator('#sw-atc-details-single-container, #huc-v2-order-row, #attach-added-to-cart-message');
  for (let i = 0; i < await scopes.count(); i++) {
    const scope = scopes.nth(i);
    if (await scope.isVisible() && /カートに入れました|Added to Cart/i.test(await scope.innerText()) && await scope.locator(productLink).count()) return true;
  }
  if (!isAddPath(new URL(page.url()).pathname)) return false;
  return /カートに入れました|Added to Cart/i.test(await page.locator('body').innerText()) && await page.locator(productLink).count() > 0;
}
export async function runCartAddition({ page, mouse, log, operation, attempt, identity, timeout = 20_000 }) {
  const { asin } = operation.data;
  if (operation.data.addition === 'submitted' || operation.data.addition === 'unknown') {
    // Recover only from the target's existing success display on this browser.
    // Merely finding an item in the cart is not proof of this submission.
    if (!page || operation.data.browserIdentity !== identity || !await additionConfirmed(page, asin)) {
      return operation.update({ addition: 'unknown', retryAdd: false, code: 'ADDITION_UNKNOWN' });
    }
    await operation.update({ addition: 'confirmed', confirmedAt: new Date().toISOString(), retryAdd: false, code: null });
    log('addition-confirmed', { operation: operation.data.operation, asin, quantity: 1, source: 'existing-success-display' });
  }
  if (operation.data.addition !== 'confirmed') {
    if (operation.data.browserIdentity && operation.data.browserIdentity !== identity) throw new Error('操作途中でブラウザ接続先が変わっています');
    const auth = await authentication(page);
    if (auth) return operation.update({ cart: auth, code: 'AUTH_REQUIRED' });
    if (productAsin(new URL(page.url()).pathname) !== asin) throw new Error('対象ASINの商品ページではありません');
    const title = (await page.locator('#productTitle:visible').innerText()).trim();
    async function verifySelection() {
      const detail = await readProductDetails(page, asin);
      const constraints = operation.data.constraints ?? {};
      if (constraints.maxPrice !== undefined) {
        const amount = yenAmount(detail.priceText);
        if (amount === null || amount > constraints.maxPrice) throw new Error('表示価格を確認できないか、--max-price を超えています');
      }
      return { options: detail.selectedOptions, priceText: detail.priceText };
    }
    const selection = await verifySelection();
    const button = page.locator('#add-to-cart-button:visible');
    await button.waitFor({ state: 'visible' });
    if (!await button.isEnabled()) throw new Error('カート追加ボタンが無効です');
    async function verifyForm(stage = 'initial') {
      const form = await button.evaluate(button => {
        const form = button.form;
        const entries = form ? [...new FormData(form, button)].map(([key, value]) => [key, typeof value === 'string' ? value : '']) : [];
        const describe = element => ({ tag: element.tagName, id: element.id.slice(0, 120),
          name: (element.name ?? '').slice(0, 120), type: element.type ?? null,
          value: typeof element.value === 'string' ? element.value.slice(0, 100) : null,
          disabled: element.matches(':disabled'), belongsToForm: !!form && element.form === form });
        const controls = form ? [...form.elements].filter(element => /quantity|qty/i.test(element.name ?? '') || element.id === 'quantity') : [];
        const pageQuantity = [...document.querySelectorAll('[id="quantity"]')];
        return { action: button.getAttribute('formaction') ? button.formAction : form?.action,
          method: (button.getAttribute('formmethod') ?? form?.method ?? '').toUpperCase(),
          target: button.getAttribute('formtarget') ?? form?.target ?? '',
          encoding: button.getAttribute('formenctype') ?? form?.enctype,
          ordinaryAdd: button.type === 'submit' && !button.closest('#sns-atc-container') &&
            /^(カートに入れる|Add to Cart|Add to Basket)$/i.test((button.value || button.textContent).trim()),
          entries, asin: entries.find(([key]) => /^ASIN(?:\.\d+)?$/i.test(key) || key === 'items[0.base][asin]')?.[1],
          diagnostics: { formPresent: !!form, formId: form?.id?.slice(0, 120) ?? null,
            submitterId: button.id, submitterName: button.name,
            quantityControls: controls.slice(0, 20).map(describe), quantityControlCount: controls.length,
            pageQuantity: pageQuantity.slice(0, 20).map(describe), pageQuantityCount: pageQuantity.length,
            fieldNames: entries.map(([key]) => key.slice(0, 120)).slice(0, 100), fieldCount: entries.length } };
      });
      const data = new URLSearchParams(form.entries);
      const quantity = addQuantityEvidence(data, asin);
      log('cart-add-form-check', { stage, asin, ...form.diagnostics,
        quantity: { ...quantity, fields: quantity.fields.slice(0, 20).map(([key, value]) => [key.slice(0, 120), value.slice(0, 100)]) } });
      const action = new URL(form.action);
      if (form.asin?.toUpperCase() !== asin) throw new Error('カート追加フォームの商品ASINが一致しません');
      if (quantity.reason) throw Object.assign(new Error(`数量が1であることを確認できません。数量変更や追加は行いません (${quantity.reason})`), { code: 'QUANTITY_UNVERIFIED' });
      if (action.origin !== 'https://www.amazon.co.jp' || !isAddPath(action.pathname) || form.method !== 'POST' ||
        !form.ordinaryAdd || !['', '_self'].includes(form.target) || form.encoding !== 'application/x-www-form-urlencoded') throw new Error('未対応のカート追加フォームです');
      const formError = addDataError(data, asin, action);
      if (formError) throw new Error(`カート追加フォームを送信できません: ${formError}`);
      return action;
    }
    const action = await verifyForm();
    await operation.update({ title, browserIdentity: identity, quantity: 1, selection });
    log('quantity-confirmed', { asin, quantity: 1 });
    await mouse.click(button, 'add to cart', { beforeMouseDown: async () => {
      if ((await verifyForm('before_mouse_down')).href !== action.href) throw new Error('クリック直前に追加先が変わりました');
      if (JSON.stringify(await verifySelection()) !== JSON.stringify(selection)) throw new Error('クリック直前に選択項目・価格が変わりました');
      // Record the point of no automatic retry BEFORE submitting any event.
      await operation.update({ addition: 'submitted', retryAdd: false, submittedAt: new Date().toISOString() });
      attempt.action = action.href;
      attempt.armed = true;
    } });
    const deadline = Date.now() + timeout;
    let confirmed = false;
    do {
      if (await authentication(page)) break;
      // Service Workers can hide the POST from page.route. Confirm the actual
      // target's success display, rather than requiring an interception event.
      if (await additionConfirmed(page, asin)) { confirmed = true; break; }
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

// Delete exactly the user-selected server cart line. Product data is retained
// before submission so AI can reopen/reconsider the product after removal.
export async function runCartRemoval({ page, mouse, log, operation, attempt, identity, timeout = 20_000 }) {
  const { asin, itemId, quantity } = operation.data;
  if (operation.data.kind !== 'cart-remove') throw new Error('削除操作の記録ではありません');
  if (operation.data.browserIdentity && operation.data.browserIdentity !== identity) throw new Error('操作途中でブラウザ接続先が変わっています');
  if (['submitted', 'unknown'].includes(operation.data.removal)) {
    const auth = await authentication(page);
    if (auth) return operation.update({ cart: auth, code: 'AUTH_REQUIRED' });
    // Explicit GET, never reload a possibly submitted POST.
    await pause(log, 'before refreshing cart for removal confirmation', 1500, 3000);
    const latestAuth = await authentication(page);
    if (latestAuth) return operation.update({ cart: latestAuth, code: 'AUTH_REQUIRED' });
    await page.goto('https://www.amazon.co.jp/cart', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  }
  let view = await openCart(page, mouse, log, timeout);
  if (view.cart !== 'visible') return operation.update({ cart: view.cart, code: 'AUTH_REQUIRED' });
  const checkCart = async (current) => {
    current ??= await cartView(page);
    if (current?.cart !== 'visible') throw new Error('削除前にカートを確認できません');
    const originals = current.items.filter(item => item.itemId === itemId);
    if (originals.length > 1 || originals.some(item => item.asin !== asin || Number(item.quantity) !== quantity)) throw new Error('削除対象の行・数量が変わったため削除しません');
    return { view: current, originals };
  };
  let { originals } = await checkCart(view);
  if (!originals.length) {
    if (!operation.data.removedItem) throw new Error('指定したカート行が見つかりません。削除済みと推測しません');
    return operation.update({ ...view, removal: 'confirmed', targetPresent: false, code: null });
  }
  if (operation.data.removal === 'confirmed') return operation.update({ ...view, targetPresent: true, code: 'ITEM_REAPPEARED' });
  await operation.update({ removedItem: operation.data.removedItem ?? originals[0], browserIdentity: identity });
  const row = page.locator(`#sc-active-cart .sc-list-item[data-asin="${asin}"][data-itemid="${itemId}"]:visible`);
  const button = row.locator('input[type="submit"][data-action="delete-active"][data-feature-id="item-delete-button"]:visible');
  const verify = async () => {
    const { originals } = await checkCart();
    if (originals.length !== 1 || await row.count() !== 1 || await button.count() !== 1) throw new Error('削除対象を一意に確認できません');
    if (await row.getAttribute('data-related-item-ids')) throw new Error('関連する商品行を伴う削除は未対応です');
    const control = await button.evaluate(button => ({ name: button.name, value: button.value,
      method: (button.getAttribute('formmethod') ?? button.form?.method)?.toLowerCase(),
      action: button.getAttribute('formaction') ? button.formAction : button.form?.action,
      target: button.getAttribute('formtarget') ?? button.form?.target,
      encoding: button.getAttribute('formenctype') ?? button.form?.enctype,
      entries: button.form ? [...new FormData(button.form, button)].map(([key,value])=>[key,typeof value==='string'?value:'']) : [] }));
    const action = new URL(control.action);
    if (control.name !== `submit.delete-active.${itemId}` || !/^(削除|Delete)$/i.test(control.value) ||
      action.origin !== 'https://www.amazon.co.jp' || !isCartPath(action.pathname) || control.method !== 'post' ||
      !['', '_self'].includes(control.target) || control.encoding !== 'application/x-www-form-urlencoded') throw new Error('未対応の単品削除ボタンです');
    const submitters = control.entries.filter(([key]) => key.startsWith('submit.'));
    if (submitters.length !== 1 || submitters[0][0] !== control.name || control.entries.some(([key]) => /buy.?now|checkout/i.test(key))) throw new Error('削除以外の送信項目が含まれています');
    return action;
  };
  const action = await verify();
  await mouse.click(button, 'remove cart item', { beforeMouseDown: async () => {
    if ((await verify()).href !== action.href) throw new Error('削除先が変わりました');
    await operation.update({ removal: 'submitted', removalSubmittedAt: new Date().toISOString(), targetPresent: true });
    attempt.remove = { itemId, action: action.href, armed: true, consumed: false };
  } });
  const deadline = Date.now() + timeout;
  do {
    const auth = await authentication(page);
    if (auth) { if (attempt.remove) attempt.remove.armed = false; return operation.update({ removal: 'unknown', cart: auth, code: 'REMOVAL_UNKNOWN' }); }
    const current = await cartView(page);
    if (current?.cart === 'visible') {
      ({ view, originals } = await checkCart(current));
      if (!originals.length && view.subtotalMatchesSelectedItems !== false) { if (attempt.remove) attempt.remove.armed = false; return operation.update({ ...view, removal: 'confirmed', removalConfirmedAt: new Date().toISOString(), targetPresent: false, code: null }); }
    }
    await sleep(200);
  } while (Date.now() < deadline);
  if (attempt.remove) attempt.remove.armed = false;
  return operation.update({ removal: 'unknown', targetPresent: true, code: 'REMOVAL_UNKNOWN' });
}
