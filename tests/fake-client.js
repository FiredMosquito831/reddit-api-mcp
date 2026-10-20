import { createMemoryLog, createWriteGuard } from '../src/safety.js';

// Stand-in for the Reddit client. It records every request and answers with a canned body, or with
// whatever a function returns for (method, path, options).
export function fakeClient(answer = {}) {
  const requests = [];
  return {
    requests,
    client: {
      async request(method, path, options = {}) {
        requests.push({ method, path, ...options });
        return typeof answer === 'function' ? answer(method, path, options) : answer;
      },
    },
  };
}

// A write guard with an in-memory log and a clock that advances when the guard sleeps.
export function guardWith(log = createMemoryLog()) {
  const clock = { time: 1_000_000 };
  return createWriteGuard({
    log,
    now: () => clock.time,
    sleep: async (ms) => {
      clock.time += ms;
    },
  });
}
