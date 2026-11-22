import { isSearchPath, searchTerm, productAsin, isAuthPath } from './navigation.mjs';

export const searchProductSelector = '[data-component-type="s-search-result"][data-asin]:not([data-asin=""])';

export async function readSearchResults(page, { offset = 0, limit = 10 } = {}) {
  const current = new URL(page.url());
  if (current.origin !== 'https://www.amazon.co.jp' || !isSearchPath(current.pathname) || !searchTerm(current)) throw new Error('検索結果ページではありません。先にsearchを実行してください');
  await page.locator(searchProductSelector).first().waitFor({ state: 'visible', timeout: 30_000 });
  const result = await page.locator(searchProductSelector).evaluateAll((cards, { offset, limit }) => {
    const text = element => element?.textContent?.replace(/\s+/g, ' ').trim() || null;
    const imageURL = element => {
      try { const url = new URL(element?.currentSrc || element?.getAttribute('src')); return url.protocol === 'https:' ? `${url.origin}${url.pathname}` : null; } catch { return null; }
    };
    return { productCount: cards.length, products: cards.slice(offset, offset + limit).map((card, i) => {
      const asin = card.getAttribute('data-asin').toUpperCase();
      const title = text(card.querySelector('h2[aria-label]') ?? [...card.querySelectorAll('h2')].at(-1));
      const ratingLink = card.querySelector('a[href*="customerReviews"]');
      return {
        index: offset + i + 1, asin, title: title?.slice(0, 300) ?? null,
        ...(title?.length > 300 ? { titleTruncated: true } : {}),
        priceText: text(card.querySelector('.a-price:not(.a-text-price) .a-offscreen')),
        ratingText: text(card.querySelector('.a-icon-alt')),
        ratingCountText: ratingLink?.getAttribute('aria-label') || text(ratingLink),
        sponsored: !!card.querySelector('.puis-sponsored-label-text, [aria-label="スポンサー"], [aria-label="Sponsored"]'),
        url: `https://www.amazon.co.jp/dp/${asin}`, imageUrl: imageURL(card.querySelector('img.s-image')),
      };
    }) };
  }, { offset, limit });
  if (result.products.some(product => !/^[A-Z0-9]{10}$/.test(product.asin))) throw new Error('検索結果に不正なASINがあります');
  const selected = (await page.locator('.s-pagination-selected').allTextContents()).map(text => text.trim()).find(text => /^\d+$/.test(text));
  const pageNumber = Number(selected ?? current.searchParams.get('page') ?? 1);
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) throw new Error('検索結果のページ番号を取得できません');
  const next = page.locator('a.s-pagination-next[href]:not(.s-pagination-disabled)');
  if (await next.count() > 1) throw new Error('次ページのリンクを一意に取得できません');
  return { query: searchTerm(current), page: pageNumber, ...result, offset, limit,
    nextOffset: offset + result.products.length < result.productCount ? offset + result.products.length : null,
    hasNextPage: await next.count() === 1 };
}

export async function nextSearchPage(page, mouse, assertNoAuth, options) {
  await assertNoAuth();
  const before = await readSearchResults(page, options);
  if (!before.hasNextPage) return { ...before, pageChanged: false };
  const link = page.locator('a.s-pagination-next[href]:not(.s-pagination-disabled)');
  const destination = new URL(await link.getAttribute('href'), page.url());
  const nextNumber = before.page + 1;
  if (destination.origin !== 'https://www.amazon.co.jp' || !isSearchPath(destination.pathname) ||
    searchTerm(destination) !== before.query || Number(destination.searchParams.get('page')) !== nextNumber) throw new Error('次ページのURL・検索語・ページ番号が一致しません');
  await mouse.click(link, 'next search page');
  await page.waitForURL(url => isAuthPath(url.pathname) ||
    url.origin === destination.origin && isSearchPath(url.pathname) && searchTerm(url) === before.query && Number(url.searchParams.get('page')) === nextNumber,
  { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await assertNoAuth();
  const result = await readSearchResults(page, options);
  if (result.page !== nextNumber) throw new Error('移動後のページ番号が一致しません');
  return { ...result, pageChanged: true };
}

export async function readProductDetails(page, expectedAsin) {
  const current = new URL(page.url());
  if (current.origin !== 'https://www.amazon.co.jp' || productAsin(current.pathname) !== expectedAsin) throw new Error('商品詳細のASINが一致しません');
  await page.locator('#productTitle:visible').waitFor({ state: 'visible', timeout: 30_000 });
  const detail = await page.evaluate(() => {
    const text = element => element?.textContent?.replace(/\s+/g, ' ').trim() || null;
    const firstText = selector => [...document.querySelectorAll(selector)].filter(element => element.getClientRects().length).map(text).find(Boolean) ?? null;
    const priceText = firstText('#corePriceDisplay_desktop_feature_div .a-price:not(.a-text-price) .a-offscreen, #corePrice_feature_div .a-price:not(.a-text-price) .a-offscreen, #apex_desktop .a-price:not(.a-text-price) .a-offscreen, #priceblock_ourprice, #priceblock_dealprice');
    const features = [...document.querySelectorAll('#feature-bullets li .a-list-item')].filter(element => element.getClientRects().length).map(text).filter(Boolean);
    const rows = [...document.querySelectorAll('#productOverview_feature_div tr, #productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr')];
    const specifications = rows.map(row => ({ name: text(row.querySelector('th, td:first-child')), value: text(row.querySelector('td:last-child')) })).filter(row => row.name && row.value);
    // Read product controls, including choices below the fold, without clicking
    // submit inputs. AI operates these controls in the same tab.
    const variationRows = [...document.querySelectorAll('[id^="inline-twister-row-"], [id^="variation_"]')];
    const allVariations = variationRows.map(row => {
      const dimension = row.id.replace(/^(?:inline-twister-row-|variation_)/, '');
      const choices = [...row.querySelectorAll('li[data-asin], li[data-defaultasin], select option')].map(element => {
        const raw = element.getAttribute('data-asin') || element.getAttribute('data-defaultasin') || element.value;
        const asin = raw?.match(/(?:^|,)([A-Z0-9]{10})$/i)?.[1]?.toUpperCase() ?? null;
        const value = element.tagName === 'OPTION' ? text(element) : element.querySelector('img')?.alt || text(element.querySelector('.swatch-title-text-display, .a-size-base')) || element.getAttribute('title');
        const selected = element.selected === true || !!element.querySelector('.a-button-selected, [aria-checked="true"]');
        const unavailable = element.disabled === true || element.getAttribute('data-initiallyunavailable') === 'true' || !!element.querySelector('.a-button-unavailable, .a-button-disabled');
        return { value, asin, selected, availability: unavailable ? 'unavailable' : element.getAttribute('data-initiallyunavailable') === 'false' ? 'available' : 'unknown' };
      }).filter(choice => choice.value && choice.asin);
      const selected = text(row.querySelector('.inline-twister-dim-title-value, .selection')) || choices.find(choice => choice.selected)?.value || null;
      const unique = [...new Map(choices.map(choice => [`${choice.asin}:${choice.value}`, choice])).values()];
      return { dimension, selected,
        options: unique.slice(0, 30).map(choice => ({ ...choice, value: choice.value.slice(0, 120) })),
        truncated: unique.length > 30 || selected?.length > 120 || unique.some(choice => choice.value.length > 120) || false };
    });
    const variations = allVariations.slice(0, 6).map(row => ({ ...row, dimension: row.dimension.slice(0, 100), selected: row.selected?.slice(0, 120) ?? null }));
    const selectedOptions = allVariations.map(({ dimension, selected }) => ({ dimension, selected }));
    const chartTables = [...document.querySelectorAll('#sizeChartV2Data_feature_div table, #a-popover-sizeGuide table')];
    const sizeCharts = chartTables.slice(0, 3).map(table => {
      const rows = [...table.rows].map(row => [...row.cells].map(cell => text(cell) || ''));
      return { caption: (text(table.caption) || text(table.parentElement?.closest('[id^="fit-sizechartv2-"]')?.querySelector('h5')))?.slice(0, 120) ?? null,
        rows: rows.slice(0, 30).map(row => row.slice(0, 10).map(value => value.slice(0, 120))),
        truncated: rows.length > 30 || rows.some(row => row.length > 10 || row.some(value => value.length > 120)) };
    });
    const facts = document.querySelector('#productFactsDesktopExpander')?.cloneNode(true);
    facts?.querySelectorAll('script, style').forEach(element => element.remove());
    const productFactsText = text(facts);
    const image = document.querySelector('#landingImage, #imgBlkFront');
    let imageUrl = null;
    try { const url = new URL(image?.getAttribute('data-old-hires') || image?.currentSrc || image?.getAttribute('src')); if (url.protocol === 'https:') imageUrl = `${url.origin}${url.pathname}`; } catch {}
    return {
      productTitle: firstText('#productTitle'), priceText,
      availabilityText: firstText('#availability')?.slice(0, 300) ?? null,
      ratingText: firstText('#acrPopover .a-icon-alt'), ratingCountText: firstText('#acrCustomerReviewText'),
      features: features.slice(0, 8).map(value => value.slice(0, 500)),
      specifications: specifications.slice(0, 16).map(row => ({ name: row.name.slice(0, 100), value: row.value.slice(0, 300) })),
      selectedOptions, variations, variationsTruncated: variationRows.length > 6, sizeCharts, productFactsText: productFactsText?.slice(0, 4000) ?? null,
      contentTruncated: features.length > 8 || features.some(value => value.length > 500) || specifications.length > 16 || specifications.some(row => row.name.length > 100 || row.value.length > 300) || variationRows.length > 6 || variations.some(row => row.truncated) || chartTables.length > 3 || sizeCharts.some(chart => chart.truncated) || productFactsText?.length > 4000 || false,
      imageUrl,
    };
  });
  return { asin: expectedAsin, ...detail };
}
