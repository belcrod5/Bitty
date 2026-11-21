export const isSearchPath = pathname => /^\/s(?:\/ref=[^/]+)?\/?$/.test(pathname);
export const searchTerm = url => url.searchParams.get('k') ?? url.searchParams.get('field-keywords');
export const productAsin = pathname => pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i)?.[1]?.toUpperCase();
export const isOrdersPath = pathname => /^\/(?:gp\/(?:css|your-account)\/order-history|your-orders\/(?:orders|order-history))(?:\/|$)/.test(pathname);
export const isAuthPath = pathname => pathname.startsWith('/ap/');

export function forbiddenPath(pathname) {
  return /\/(?:cart|checkout)(?:\/|$)|\/gp\/(?:buy|cart|checkout|aw\/c)(?:\/|$)|\/hz\/checkout|add-to-cart|handle-buy-box|buy-now/i.test(pathname);
}

export function allowNavigation(url, method, command) {
  if (url.hostname !== 'www.amazon.co.jp' || url.protocol !== 'https:' || forbiddenPath(url.pathname)) return false;
  const auth = isAuthPath(url.pathname) && command === 'orders';
  if (!['GET', 'HEAD'].includes(method)) return false;
  if (url.pathname === '/') return true;
  if (['search', 'detail'].includes(command) && isSearchPath(url.pathname)) return true;
  if (command === 'detail' && (productAsin(url.pathname) || url.pathname === '/sspa/click')) return true;
  if (command === 'orders' && (isOrdersPath(url.pathname) || auth)) return true;
  return false;
}
