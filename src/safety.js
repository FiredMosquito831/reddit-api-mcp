import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_LOG_ENTRIES = 500;
const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Case and spacing are normalized, so trivial edits don't defeat the duplicate check.
export function fingerprint(text) {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
  return createHash('sha256').update(normalized).digest('hex');
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

      const sentLastHour = entries.filter((entry) => time - entry.at < HOUR_MS).length;
      if (sentLastHour >= maxWritesPerHour) {
        throw new Error(`Hourly write limit reached (${maxWritesPerHour}). Wait, or raise REDDIT_CLI_MAX_WRITES_PER_HOUR.`);
      }

      const fp = text === undefined ? null : fingerprint(text);
      if (fp !== null && entries.some((entry) => entry.fp === fp && time - entry.at < duplicateWindowMs)) {
        throw new Error('Identical text was already sent recently. Change it, or wait before sending it again.');
      }

      const lastAt = entries.reduce((latest, entry) => Math.max(latest, entry.at), 0);
      const waitMs = lastAt + minGapMs - time;
      if (waitMs > 0) await sleep(waitMs);

      const result = await perform();
      await log.save([...entries, { fp, at: now() }]);
      return result;
    },
  };
}
