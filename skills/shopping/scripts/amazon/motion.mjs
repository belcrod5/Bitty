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
        await this.page.mouse.move(p.x, p.y);
        this.position = p;
        await sleep(integer(8, 30));
        if (i === stopAt && segment < waypoints.length - 1) {
          await pause(this.log, 'mid-movement stop', 150, 650);
        }
      }
    }
  }

  async click(locator, label, { beforeMouseDown } = {}) {
    for (let reaim = 0; reaim < 2; reaim++) {
      await locator.waitFor({ state: 'visible' });
      let box = await locator.boundingBox();
      const viewport = this.page.viewportSize() ?? await this.page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      // Avoid a stability/animation-frame wait when the whole target is already visible.
      // The hit test immediately before mouse-down still rejects movement or overlays.
      if (box && (box.x < 0 || box.y < 0 || box.x + box.width > viewport.width || box.y + box.height > viewport.height)) {
        await locator.scrollIntoViewIfNeeded();
        box = await locator.boundingBox();
      }
      if (!box || box.width <= 0 || box.height <= 0) throw new Error(`${label}: no clickable box`);
      const point = { x: box.x + box.width * random(0.35, 0.65), y: box.y + box.height * random(0.35, 0.65) };
      await this.moveTo(point);
      await pause(this.log, `before clicking ${label}`);
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
      return;
    }
  }
}
