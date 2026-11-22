import { randomInt } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

export const random = (min, max) => min + (randomInt(0, 1_000_001) / 1_000_000) * (max - min);
export const integer = (min, max) => randomInt(min, max + 1);
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

export async function pause(log, reason, min = 500, max = 1000) {
  const milliseconds = integer(min, max);
  log('pause', { reason, milliseconds });
  await sleep(milliseconds);
}

// Activate the same tab; never navigate, reconnect or replace a selected page.
export async function activateTab(page, log) {
  const read = () => page.evaluate(() => ({ visible: document.visibilityState === 'visible', focused: document.hasFocus() }));
  const before = await read();
  if (before.visible && before.focused) return;
  let after = before;
  try {
    await page.bringToFront();
    const deadline = performance.now() + 2000;
    do {
      after = await read();
      if (after.visible && after.focused) break;
      await sleep(50);
    } while (performance.now() < deadline);
    if (after.visible && after.focused) {
      await pause(log, 'after activating tab');
      after = await read();
    }
    if (!after.visible || !after.focused) throw new Error('Tab did not become active');
  } catch (cause) {
    log('tab-activation', { before, after, success: false });
    throw Object.assign(new Error('対象タブを自動でアクティブにできませんでした。入力・クリックを送信せず停止します'), { code: 'TAB_ACTIVATION_FAILED', cause });
  }
  log('tab-activation', { before, after, success: true });
}

// ControlOrMeta+A did not select all text in the live extension session.
// Select only the focused input's contents, then use real key events.
export async function typeSearchQuery(page, input, query, log) {
  const focused = () => input.evaluate(element => document.activeElement === element);
  await pause(log, 'before editing search input', 750, 1500);
  await activateTab(page, log);
  if (!await focused()) throw new Error('Search input did not receive focus');
  await input.evaluate(element => element.select());
  const selected = await input.evaluate(element => element.selectionStart === 0 && element.selectionEnd === element.value.length);
  if (!selected) throw new Error('Search input contents were not selected');
  await page.keyboard.press('Backspace');
  if (await input.inputValue() !== '') throw new Error('Search input was not cleared');
  for (const { segment: character } of new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(query)) {
    await pause(log, 'before character');
    await activateTab(page, log);
    if (!await focused()) throw new Error('Search input lost focus');
    await page.keyboard.type(character);
    log('typed-character', { character });
  }
  await pause(log, 'after entering search query', 1000, 2000);
  if (!await focused()) throw new Error('Search input lost focus');
  if (await input.inputValue() !== query) throw new Error('Search input does not match requested query');
}

function bezier(a, b, c, d, t) {
  const u = 1 - t;
  return {
    x: u ** 3 * a.x + 3 * u ** 2 * t * b.x + 3 * u * t ** 2 * c.x + t ** 3 * d.x,
    y: u ** 3 * a.y + 3 * u ** 2 * t * b.y + 3 * u * t ** 2 * c.y + t ** 3 * d.y,
  };
}

export class RandomMouse {
  constructor(page, log) {
    this.page = page;
    this.log = log;
    // A fresh Playwright page starts its mouse at (0, 0).
    this.position = { x: 0, y: 0 };
  }

  async moveTo(destination) {
    const viewport = this.page.viewportSize() ?? await this.page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const start = { ...this.position };
    const bound = p => ({ x: clamp(p.x, 1, viewport.width - 2), y: clamp(p.y, 1, viewport.height - 2) });
    const dx = destination.x - start.x;
    const dy = destination.y - start.y;
    const distance = Math.hypot(dx, dy) || 1;
    const stops = integer(2, 4);
    const waypoints = [];
    // Each intermediate anchor is displaced sideways from the direct line.
    for (let i = 1; i <= stops; i++) {
      const t = i / (stops + 1);
      const offset = random(25, Math.min(130, distance * 0.25 + 25)) * (integer(0, 1) ? 1 : -1);
      waypoints.push(bound({ x: start.x + dx * t - dy / distance * offset, y: start.y + dy * t + dx / distance * offset }));
    }
    waypoints.push(destination);
    this.log('mouse-path', { start, destination, waypoints });
    const pending = [];
    let moveError, maxAckMs = 0;
    try {
      for (let segment = 0; segment < waypoints.length; segment++) {
        const a = { ...this.position };
        const d = waypoints[segment];
        const b = bound({ x: a.x + (d.x - a.x) * random(0.15, 0.4) + random(-45, 45), y: a.y + (d.y - a.y) * random(0.15, 0.4) + random(-45, 45) });
        const c = bound({ x: a.x + (d.x - a.x) * random(0.6, 0.85) + random(-45, 45), y: a.y + (d.y - a.y) * random(0.6, 0.85) + random(-45, 45) });
        const frames = integer(15, 28);
        // Unequal progress increments + ease-in/out + frame jitter give varying speed.
        const weights = Array.from({ length: frames }, () => random(0.3, 2.1));
        const total = weights.reduce((sum, v) => sum + v, 0);
        let accumulated = 0;
        const stopAt = integer(4, frames - 4);
        this.log('mouse-segment', { segment, a, b, c, d, frames });
        for (let i = 0; i < frames; i++) {
          accumulated += weights[i];
          const progress = i === frames - 1 ? 1 : accumulated / total;
          const t = progress * progress * (3 - 2 * progress);
          const p = bezier(a, b, c, d, t);
          if (moveError) throw moveError;
          // Background Chrome sessions can defer movement acknowledgements.
          // Pace delivery here; drain all acknowledgements before any click.
          const sent = performance.now();
          pending.push(this.page.mouse.move(p.x, p.y).then(() => {
            maxAckMs = Math.max(maxAckMs, performance.now() - sent);
          }, error => { moveError ??= error; }));
          this.position = p;
          await sleep(integer(8, 30));
          if (i === stopAt && segment < waypoints.length - 1) {
            await pause(this.log, 'mid-movement stop', 150, 650);
          }
        }
      }
    } finally {
      await Promise.all(pending);
    }
    if (moveError) throw moveError;
    this.log('mouse-move-delivery', { moves: pending.length, maxAckMs: Math.round(maxAckMs) });
  }

  async click(locator, label, { beforeMouseDown } = {}) {
    await activateTab(this.page, this.log);
    const clickStarted = performance.now();
    for (let reaim = 0; reaim < 2; reaim++) {
      await locator.waitFor({ state: 'visible' });
      if (reaim === 0) await pause(this.log, `before preparing ${label}`, 1000, 2000);
      let box = await locator.boundingBox();
      const viewport = this.page.viewportSize() ?? await this.page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      const needed = Boolean(box && (box.x < 0 || box.y < 0 || box.x + box.width > viewport.width || box.y + box.height > viewport.height));
      // Include nested scrolling containers, not just the document scroll position.
      const readScrollPositions = element => {
        const positions = [];
        for (let node = element.parentElement; node; node = node.parentElement) {
          positions.push({ x: node.scrollLeft, y: node.scrollTop });
        }
        return positions;
      };
      const before = await locator.evaluate(readScrollPositions);
      const scrollStarted = performance.now();
      let after = before, movingSamples = 0;
      if (needed) {
        await locator.evaluate(element => element.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' }));
        let stableSince = performance.now();
        // Poll from Node so background-tab animation-frame throttling cannot hang this wait.
        while (true) {
          await sleep(50);
          const current = await locator.evaluate(readScrollPositions);
          if (JSON.stringify(current) !== JSON.stringify(after)) {
            stableSince = performance.now();
            movingSamples++;
          }
          after = current;
          if (performance.now() - stableSince >= 200) break;
          if (performance.now() - scrollStarted >= 5000) throw new Error(`${label}: scroll did not settle; stopped before click`);
        }
      }
      const durationMs = Math.round(performance.now() - scrollStarted);
      const comparable = before.length === after.length;
      const deltas = comparable ? after.map((position, index) => ({
        ancestorIndex: index, x: position.x - before[index].x, y: position.y - before[index].y,
      })).filter(delta => delta.x !== 0 || delta.y !== 0) : null;
      this.log('scroll', { label, attempt: reaim + 1, needed,
        scrolled: comparable ? deltas.length > 0 : null, behavior: needed ? 'smooth' : null, movingSamples, before, after, deltas, durationMs });
      if (needed) {
        await pause(this.log, `after scrolling ${label}`, 1000, 2000);
      }
      // Read again after the wait; the page may have shifted while settling.
      box = await locator.boundingBox();
      if (!box || box.width <= 0 || box.height <= 0) throw new Error(`${label}: no clickable box`);
      const point = { x: box.x + box.width * random(0.35, 0.65), y: box.y + box.height * random(0.35, 0.65) };
      const movementStarted = performance.now();
      await this.moveTo(point);
      this.log('mouse-move-complete', { label, attempt: reaim + 1, durationMs: Math.round(performance.now() - movementStarted) });
      await pause(this.log, `before clicking ${label}`);
      await activateTab(this.page, this.log);
      // Do not click if an overlay or layout shift has replaced the intended target.
      const hit = await locator.evaluate((element, p) => {
        const target = document.elementFromPoint(p.x, p.y);
        return target === element || element.contains(target);
      }, point);
      if (!hit) {
        const current = await locator.boundingBox();
        const shifted = current && ['x', 'y', 'width', 'height'].some(key => Math.abs(current[key] - box[key]) > 1);
        if (reaim === 0 && shifted) {
          this.log('mouse-retarget', { label, before: box, after: current });
          continue;
        }
        throw new Error(`${label}: target moved or is covered; stopped before click`);
      }
      this.log('click', { label, ...point });
      await beforeMouseDown?.();
      await this.page.mouse.down();
      await sleep(integer(60, 140));
      await this.page.mouse.up();
      this.log('click-complete', { label, durationMs: Math.round(performance.now() - clickStarted) });
      return;
    }
  }
}
