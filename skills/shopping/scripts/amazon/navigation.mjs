export const isSearchPath = pathname => /^\/s(?:\/ref=[^/]+)?\/?$/.test(pathname);
export const searchTerm = url => url.searchParams.get('k') ?? url.searchParams.get('field-keywords');
export const productAsin = pathname => pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i)?.[1]?.toUpperCase();
export const isOrdersPath = pathname => /^\/(?:gp\/(?:css|your-account)\/order-history|your-orders\/(?:orders|order-history|search))(?:\/|$)/.test(pathname);
export const isAuthPath = pathname => /^(?:\/ap\/|\/checkpoint(?:\/|$)|\/errors\/validateCaptcha)/i.test(pathname);
export const isCartPath = pathname => /^\/(?:cart(?:\/ref=[^/]+)?\/?|gp\/cart\/view\.html)$/.test(pathname);
export const isAddPath = pathname => /^\/(?:cart\/add-to-cart|gp\/product\/handle-buy-box)(?:\/|$)/.test(pathname);
export const safeURL = value => {
  try { const u = new URL(value); return `${u.protocol}//${u.host}${u.pathname}`; }
  catch { return value; }
};
// Sanitize nested fields, including URLs embedded in Playwright exception messages.
export function safeValue(value) {
  if (typeof value === 'string') return value.replace(/(?:https?|wss?):\/\/[^\s"'<>]+/g, safeURL);
  if (Array.isArray(value)) return value.map(safeValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, safeValue(v)]));
  return value;
}
export async function authentication(page) {
  const pathname = new URL(page.url()).pathname;
  if (isAuthPath(pathname)) return pathname.startsWith('/ap/') ? 'login_required' : 'verification_required';
  const body = await page.locator('body').innerText({ timeout: 1500 }).catch(() => '');
  if (/私は人間です|ロボットではないこと|not a robot|Enter the characters you see below/i.test(body)) return 'verification_required';
  if (await page.locator('input#captchacharacters, iframe[src*="captcha"], iframe[src*="checkpoint"]').count()) return 'verification_required';
  return null;
}
export function forbiddenPath(pathname) {
  return /\/(?:cart|checkout)(?:\/|$)|\/gp\/(?:buy|cart|checkout|aw\/c)(?:\/|$)|\/hz\/checkout|add-to-cart|handle-buy-box|buy-now/i.test(pathname);
}
export function allowNavigation(url, method, command) {
  if (url.hostname !== 'www.amazon.co.jp' || url.protocol !== 'https:') return false;
  if (isAuthPath(url.pathname)) return ['GET', 'HEAD'].includes(method);
  if (!['GET', 'HEAD'].includes(method)) return false;
  const cartCommand = ['cart', 'cart-add', 'cart-remove'].includes(command);
  if (cartCommand && isCartPath(url.pathname)) return true;
  if (cartCommand && url.pathname === '/cart/smart-wagon') return true;
  if (cartCommand && url.pathname === '/cart/ewc/compact') return true;
  if (cartCommand && isAddPath(url.pathname) && ![...url.searchParams.keys()].some(k => /asin|quantity|offerlisting/i.test(k))) return true;
  if (forbiddenPath(url.pathname)) return false;
  if (url.pathname === '/') return true;
  if (['search', 'search-next', 'search-results', 'detail'].includes(command) && isSearchPath(url.pathname)) return true;
  if (['detail', 'detail-current', 'cart-add'].includes(command) && (productAsin(url.pathname) || url.pathname === '/sspa/click')) return true;
  if (['orders', 'orders-search', 'orders-results', 'orders-next', 'orders-resume'].includes(command) && isOrdersPath(url.pathname)) return true;
  return false;
}
export function addDataError(data, asin, action) {
  const asins = [...data.entries()].filter(([k]) => /^ASIN(?:\.\d+)?$/i.test(k)).map(([,v]) => v.toUpperCase());
  const quantities = [...data.entries()].filter(([k]) => /^quantity(?:\.\d+)?$/i.test(k)).map(([,v]) => v);
  if (asins.length !== 1 || asins[0] !== asin || quantities.length !== 1 || quantities[0] !== '1') return 'asin_or_quantity_mismatch';
  // Ordinary Amazon forms can contain isBuyNow=1. It is safe only with the
  // explicit add submitter AND the dedicated cart endpoint, never buy-box.
  const explicitAdd = /^\/cart\/add-to-cart(?:\/|$)/.test(action.pathname) && data.has('submit.add-to-cart');
  if ([...data.entries()].some(([key, value]) => /buy.?now|checkout/i.test(key) &&
    !(key === 'isBuyNow' && (['0', 'false'].includes(value) || explicitAdd && ['1', 'true'].includes(value))))) return 'purchase_control';
  return null;
}
export function authorizeAdd(request, attempt, asin) {
  attempt.blockedReason = 'not_armed';
  if (!attempt.armed || attempt.consumed || request.method() !== 'POST') return false;
  const url = new URL(request.url());
  attempt.blockedReason = 'form_action_mismatch';
  if (url.origin !== 'https://www.amazon.co.jp' || !isAddPath(url.pathname) || url.href !== attempt.action) return false;
  const type = request.headers()['content-type'] ?? '';
  attempt.blockedReason = 'unsupported_content_type';
  if (!type.startsWith('application/x-www-form-urlencoded')) return false;
  const data = new URLSearchParams(request.postData() ?? '');
  attempt.blockedReason = addDataError(data, asin, url);
  if (attempt.blockedReason) return false;
  attempt.consumed = true;
  attempt.armed = false;
  return true;
}

export function authorizeRemoval(request, removal) {
  if (!removal?.armed || !removal.action || removal.consumed || request.method() !== 'POST') return false;
  const url = new URL(request.url());
  if (url.origin !== 'https://www.amazon.co.jp' || !(isCartPath(url.pathname) || ['/gp/cart/ajax-update.html', '/cart/preview/action'].includes(url.pathname))) return false;
  if (!(request.headers()['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) return false;
  const data = new URLSearchParams(request.postData() ?? '');
  if ([...data.keys()].some(key => /buy.?now|checkout/i.test(key))) return false;
  const submitters = [...data.keys()].filter(key => key.startsWith('submit.'));
  const sameAction = url.href === removal.action || isCartPath(url.pathname) && isCartPath(new URL(removal.action).pathname);
  let matches = sameAction && submitters.length === 1 && submitters[0] === `submit.delete-active.${removal.itemId}`;
  if (!submitters.length && data.get('pageAction') === 'delete-active') {
    try { const payload = JSON.parse(data.get('actionPayload')); matches = (payload.itemId ?? payload.itemID) === removal.itemId; } catch { return false; }
  }
  if (submitters.length === 1 && submitters[0] === 'submit.cart-actions' && data.get('pageAction') === 'cart-actions') {
    try {
      const actions = JSON.parse(data.get('actionPayload'));
      const action = Array.isArray(actions) && actions.length === 1 ? actions[0] : null;
      matches = action?.type === 'DELETE_START' && action.payload?.itemId === removal.itemId &&
        action.payload.list === 'activeItems' && Array.isArray(action.payload.relatedItemIds) && action.payload.relatedItemIds.length === 0;
    } catch { return false; }
  }
  if (!matches) return false;
  removal.consumed = true; removal.armed = false;
  return true;
}

export function createRouteHandler(command, attempt, asin, log) {
  const cartCommand = ['cart', 'cart-add', 'cart-remove'].includes(command);
  return async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (command === 'cart-remove' && authorizeRemoval(request, attempt.remove)) return route.fallback();
    if (command === 'cart-add' && isAddPath(url.pathname) && request.method() === 'POST' && authorizeAdd(request, attempt, asin)) return route.fallback();
    const cartRead = cartCommand && ['GET', 'HEAD'].includes(request.method()) && allowNavigation(url, request.method(), command);
    if (forbiddenPath(url.pathname) && !cartRead) {
      log('blocked-request', { method: request.method(), path: url.pathname,
        ...(cartCommand && isAddPath(url.pathname) && request.method() === 'POST' ? { reason: attempt.blockedReason } : {}) });
      return route.abort('blockedbyclient');
    }
    if (request.isNavigationRequest() && request.frame().parentFrame() === null && !allowNavigation(url, request.method(), command)) {
      log('blocked-navigation', { method: request.method(), path: url.pathname });
      return route.abort('blockedbyclient');
    }
    return route.fallback();
  };
}
