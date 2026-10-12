/** Game time. Code that applies time-based rules (upkeep, succession) reads it here, so tests can move it. */
export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol("CLOCK");

export const systemClock: Clock = { now: () => new Date() };
