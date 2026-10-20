import { TOKEN_URL } from '../src/oauth.js';

export function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

// Records every call so tests can assert on URLs, headers, and decoded form bodies.
export function recordingFetch(route) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const call = {
      url: String(url),
      init,
      body: init.body === undefined ? undefined : Object.fromEntries(new URLSearchParams(init.body)),
    };
    calls.push(call);
    return route(call);
  };
  return { fetch, calls };
}

// The token endpoint issues a fresh access token each time; other URLs take responses from the queue.
export function router(apiResponses = []) {
  const queue = [...apiResponses];
  let issued = 0;
  return ({ url }) => {
    if (url === TOKEN_URL) {
      issued += 1;
      return jsonResponse({
        access_token: `access-${issued}`,
        token_type: 'bearer',
        expires_in: 3600,
        scope: 'identity read',
      });
    }
    return queue.shift() ?? jsonResponse({ unexpected: true }, { status: 500 });
  };
}

export function memoryStore(refreshToken = 'refresh-1') {
  let token = refreshToken;
  return {
    async getRefreshToken() {
      return token;
    },
    async setRefreshToken(next) {
      token = next;
    },
    async clear() {
      token = null;
    },
    get value() {
      return token;
    },
  };
}

export function fakeClock(start = 1_000_000) {
  let time = start;
  const sleeps = [];
  return {
    now: () => time,
    sleep: async (ms) => {
      sleeps.push(ms);
      time += ms;
    },
    sleeps,
  };
}
