import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_LOG_ENTRIES = 500;
const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export { HOUR_MS, DAY_MS };

// Case and spacing are normalized, so trivial edits don't defeat the duplicate check.
export function fingerprint(text) {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
  return createHash('sha256').update(normalized).digest('hex');
}

// Shared admission rules. The legacy guard below and the durable account ledger in
// src/attempts.js use these same helpers, so there is one definition of the hourly cap and the
// spacing rule instead of two guards drifting apart. Entries are `{ at }` timestamps.
export function writesWithin(entries, now, windowMs = HOUR_MS) {
  return entries.filter((entry) => now - entry.at < windowMs);
}

export function assertHourlyCap(entries, now, maxWritesPerHour) {
  if (writesWithin(entries, now).length >= maxWritesPerHour) {
    const error = new Error(`Hourly write limit reached (${maxWritesPerHour}). Wait, or raise REDDIT_CLI_MAX_WRITES_PER_HOUR.`);
    error.code = 'THROTTLED';
    throw error;
  }
}

export function hasRecentFingerprint(entries, fp, now, duplicateWindowMs = DAY_MS) {
  return entries.some((entry) => entry.fp === fp && now - entry.at < duplicateWindowMs);
}

export function spacingDelay(entries, now, minGapMs) {
  const lastAt = entries.reduce((latest, entry) => Math.max(latest, entry.at), 0);
  return Math.max(0, lastAt + minGapMs - now);
}


// The log keeps timestamps and hashes, never the text itself.
export function createFileLog(path) {
  return {
    async load() {
      try {
        return JSON.parse(await readFile(path, 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
    },
    async save(entries) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(entries.slice(-MAX_LOG_ENTRIES)));
    },
  };
}

export function createMemoryLog(initial = []) {
  let entries = [...initial];
  return {
    async load() {
      return [...entries];
    },
    async save(next) {
      entries = next.slice(-MAX_LOG_ENTRIES);
    },
  };
}

// Every write goes through run(): spacing between writes, no identical text twice in a day, and an hourly cap.
export function createWriteGuard({
  log,
  now = () => Date.now(),
  sleep = sleepFor,
  minGapMs = 2_000,
  duplicateWindowMs = DAY_MS,
  maxWritesPerHour = 30,
}) {
  return {
    async run({ text, perform }) {
      const entries = await log.load();
      const time = now();

      assertHourlyCap(entries, time, maxWritesPerHour);

      const fp = text === undefined ? null : fingerprint(text);
      if (fp !== null && hasRecentFingerprint(entries, fp, time, duplicateWindowMs)) {
        throw new Error('Identical text was already sent recently. Change it, or wait before sending it again.');
      }

      const waitMs = spacingDelay(entries, time, minGapMs);
      if (waitMs > 0) await sleep(waitMs);

      const result = await perform();
      await log.save([...entries, { fp, at: now() }]);
      return result;
    },
  };
}
