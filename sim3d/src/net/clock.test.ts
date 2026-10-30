import { describe, expect, it } from 'vitest';
import { Rng } from '../world/rng';
import { LocalClock } from './Clock';

describe('LocalClock', () => {
  it('runs at sim rate without drift and at (1 + ppm 1e-6) with it', () => {
    let t = 0;
    const c = new LocalClock(() => t);
    t = 100;
    expect(c.nowLocal()).toBe(100);
    const d = new LocalClock(() => t, 10000); // 1 %
    expect(d.at(200)).toBeCloseTo(202, 9);
    expect(d.ppm).toBe(10000);
  });

  it('a drift change rebases: continuous at the change, new rate after it', () => {
    let t = 0;
    const c = new LocalClock(() => t);
    t = 50;
    const before = c.nowLocal();
    c.setDrift(-20000); // 2 % slow from now on
    expect(c.nowLocal()).toBe(before);
    t = 150;
    expect(c.nowLocal()).toBeCloseTo(50 + 100 * 0.98, 9);
    c.setDrift(5000, 150);
    expect(c.nowLocal()).toBeCloseTo(148, 9);
    expect(c.at(250)).toBeCloseTo(148 + 100 * 1.005, 9);
  });

  it('stays monotonic and continuous over many random rebases', () => {
    const rng = new Rng(7);
    let t = 0;
    const c = new LocalClock(() => t);
    let last = c.nowLocal();
    for (let i = 0; i < 2000; i++) {
      const dt = rng.range(0, 2);
      t += dt;
      const now = c.nowLocal();
      expect(now).toBeGreaterThanOrEqual(last);
      // the step is dt times a rate within +-10 % (no jump)
      expect(now - last).toBeLessThanOrEqual(dt * 1.1 + 1e-9);
      if (rng.chance(0.2)) {
        c.setDrift(rng.range(-100000, 100000));
        expect(c.nowLocal()).toBe(now); // continuous at the rebase
      }
      last = c.nowLocal();
    }
  });

  it('rejects a drift that would stop or reverse the clock', () => {
    const c = new LocalClock(() => 0);
    expect(() => c.setDrift(-1e6)).toThrow(/stop or reverse/);
    expect(() => new LocalClock(() => 0, -2e6)).toThrow(/stop or reverse/);
    expect(c.ppm).toBe(0);
  });
});
