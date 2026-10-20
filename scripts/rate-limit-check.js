#!/usr/bin/env node
// Sends a few reads and prints the rate-limit headers Reddit returned, so you can see your real budget.
// The cache is off for this run, so every request reaches Reddit.
import { loadConfig } from '../src/config.js';
import { openSession } from '../src/session.js';

const count = Number.parseInt(process.argv[2] ?? '5', 10);
const { client } = openSession({ ...loadConfig(), cacheTtlMs: 0 });

for (let i = 1; i <= count; i += 1) {
  await client.request('GET', '/r/popular/hot', { query: { limit: 1 } });
  console.log(`request ${i}/${count}: ${JSON.stringify(client.rateLimit())}`);
}
