// Are you at the screen? And a Pomodoro timer that only counts time you're actually there.
// Both are driven by tick(now) so they can be tested without real time.

export type PresenceState = 'present' | 'checking' | 'away';

/**
 * Presence from activity: keys, mouse, scroll, plus tab visibility and window focus.
 * After `awaySec` without input we ask "still reading?" (people do read without touching anything);
 * no answer within `graceSec` → away, and that unanswered time doesn't count.
 */
export class Presence {
  state: PresenceState = 'present';
  presentMs = 0;
  awayCount = 0;
  awaySince = 0;
  private lastInput: number;
  private lastTick: number;
  private hiddenAt = 0;

  constructor(
    public awaySec: number,
    now: number,
    private onChange: (s: PresenceState, awayMs: number) => void = () => {},
    public graceSec = 30,
  ) {
    this.lastInput = now;
    this.lastTick = now;
  }

  /** Any sign of life. Returns how long you were away, if you were. */
  input(now: number): number {
    this.lastInput = now;
    this.hiddenAt = 0;
    if (this.state === 'present') return 0;
    const awayMs = this.state === 'away' ? now - this.awaySince : 0;
    this.lastTick = now;
    this.set('present', awayMs);
    return awayMs;
  }

  /** Tab hidden or window lost focus. */
  hidden(now: number) {
    if (!this.hiddenAt) this.hiddenAt = now;
  }

  visible(now: number) {
    this.input(now);
  }

  tick(now: number) {
    const dt = Math.max(0, Math.min(now - this.lastTick, 5000));
    this.lastTick = now;
    if (this.state !== 'away') this.presentMs += dt;
    if (this.state === 'away') return;
    // hidden for 10 s (a quick alt-tab doesn't count) → away since it was hidden
    if (this.hiddenAt && now - this.hiddenAt >= 10000) {
      this.presentMs -= Math.min(this.presentMs, now - this.hiddenAt);
      return this.goAway(this.hiddenAt);
    }
    const idle = now - this.lastInput;
    if (this.state === 'present' && idle >= this.awaySec * 1000) this.set('checking', 0);
    else if (this.state === 'checking' && idle >= (this.awaySec + this.graceSec) * 1000) {
      this.presentMs -= Math.min(this.presentMs, this.graceSec * 1000); // the unanswered check wasn't reading
      this.goAway(now - this.graceSec * 1000);
    }
  }

  private goAway(since: number) {
    this.awaySince = since;
    this.awayCount++;
    this.set('away', 0);
  }

  private set(s: PresenceState, awayMs: number) {
    this.state = s;
    this.onChange(s, awayMs);
  }
}

export type Phase = 'idle' | 'focus' | 'break';

export interface PomodoroConfig {
  focusMin: number;
  breakMin: number;
  longBreakMin: number;
  longBreakEvery: number;
}

export interface PhaseEnd {
  kind: 'focus' | 'break';
  start: number;
  end: number;
  ms: number;
  planned: number;
  completed: boolean;
}

/** Focus time only runs while you're present; breaks run on the wall clock. */
export class Pomodoro {
  phase: Phase = 'idle';
  elapsed = 0;
  planned = 0;
  started = 0;
  sprints: number; // focus sprints completed today
  private lastTick = 0;

  constructor(
    public cfg: PomodoroConfig,
    sprintsToday: number,
    private onEnd: (e: PhaseEnd, next: Phase) => void = () => {},
  ) {
    this.sprints = sprintsToday;
  }

  get remaining() {
    return Math.max(0, this.planned - this.elapsed);
  }

  /** Is the next break a long one? */
  get longBreakNext() {
    return (this.sprints + 1) % Math.max(1, this.cfg.longBreakEvery) === 0;
  }

  startFocus(now: number) {
    this.phase = 'focus';
    this.started = now;
    this.lastTick = now;
    this.elapsed = 0;
    this.planned = this.cfg.focusMin * 60000;
  }

  startBreak(now: number) {
    const long = this.sprints > 0 && this.sprints % Math.max(1, this.cfg.longBreakEvery) === 0;
    this.phase = 'break';
    this.started = now;
    this.lastTick = now;
    this.elapsed = 0;
    this.planned = (long ? this.cfg.longBreakMin : this.cfg.breakMin) * 60000;
  }

  /** End the current phase early (skip a break, or stop a sprint). */
  stop(now: number) {
    if (this.phase === 'idle') return;
    this.finish(now, false, 'idle');
  }

  tick(now: number, present: boolean) {
    const dt = Math.max(0, Math.min(now - this.lastTick, 5000));
    this.lastTick = now;
    if (this.phase === 'idle') return;
    if (this.phase === 'break' || present) this.elapsed += dt;
    if (this.elapsed < this.planned) return;
    if (this.phase === 'focus') {
      this.sprints++;
      this.finish(now, true, 'break');
    } else this.finish(now, true, 'idle');
  }

  private finish(now: number, completed: boolean, next: Phase) {
    const e: PhaseEnd = { kind: this.phase as 'focus' | 'break', start: this.started, end: now, ms: this.elapsed, planned: this.planned, completed };
    if (next === 'break') this.startBreak(now);
    else this.phase = 'idle';
    this.onEnd(e, next);
  }
}

export function clock(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
