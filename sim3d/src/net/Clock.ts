import type { Clock } from '../p2p/contracts';

/**
 * Per-node local clock (docs/P2P_DESIGN.md section 3): `nowLocal(tSim) = base + (tSim - tBase) * (1 + ppm * 1e-6)`.
 * It reads simulation time through the injected getter, never the wall clock. A `clock_drift` fault rebases it at
 * fault time, so local time stays continuous and strictly increasing whatever the new rate (|ppm| < 1e6).
 * Agents see only `nowLocal()` (PRD 9.2); the engine and tests may also ask for the local time at a given sim time.
 */
export class LocalClock implements Clock {
  private base = 0;
  private tBase = 0;
  private rate: number;

  constructor(
    private readonly simTime: () => number,
    private drift = 0,
  ) {
    this.rate = LocalClock.rateOf(drift);
  }

  /** Current drift in parts per million (0 = perfect clock). */
  get ppm(): number {
    return this.drift;
  }

  nowLocal(): number {
    return this.at(this.simTime());
  }

  /** Local time at simulation time `tSim` under the current drift (valid for `tSim` >= the last rebase). */
  at(tSim: number): number {
    return this.base + (tSim - this.tBase) * this.rate;
  }

  /** Changes the drift from `tSim` on; the local time at `tSim` is kept, so the clock never jumps. */
  setDrift(ppm: number, tSim: number = this.simTime()): void {
    const r = LocalClock.rateOf(ppm);
    this.base = this.at(tSim);
    this.tBase = tSim;
    this.drift = ppm;
    this.rate = r;
  }

  private static rateOf(ppm: number): number {
    const r = 1 + ppm * 1e-6;
    if (!(r > 0) || !Number.isFinite(r)) throw new Error(`clock drift ${ppm} ppm would stop or reverse the clock`);
    return r;
  }
}
