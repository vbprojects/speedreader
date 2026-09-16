/** Detect a stalled device clock; never use wall time to advance speech. */
export class OutputWatchdog {
  private clock: number | null = null;
  private lastMovement = 0;
  constructor(private timeoutMilliseconds = 5_000) {}
  check(clock: number, now: number, expectingAudio: boolean): boolean {
    if (!expectingAudio || this.clock === null || clock !== this.clock) {
      this.clock = clock; this.lastMovement = now; return false;
    }
    return now - this.lastMovement >= this.timeoutMilliseconds;
  }
}
