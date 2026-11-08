export interface Clock {
  now(): Date;
}

export const DEMO_NOW = "2026-11-10T12:00:00Z";

export function systemClock(): Clock {
  return { now: () => new Date() };
}

export function fixedClock(iso: string): Clock {
  return { now: () => new Date(iso) };
}
