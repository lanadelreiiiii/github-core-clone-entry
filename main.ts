// Entrypoint: the forge's lifecycle against the make.fun environment.
//
// The environment drives the trial. This process only has three jobs:
//   1. serve the forge on an ephemeral port,
//   2. tell the environment which port that is, and
//   3. stay alive until the environment reports the trial is done.
// Everything the suite scores lives in app.ts; this file is just the handshake.
//
// The handshake, step by step:
//   - MAKEFUN_ENV_URL names the environment's origin. With no URL there is
//     nobody to register with, so the process fails fast with exit code 1.
//   - The server binds port 0 and the kernel picks a free one. Port 8080 is
//     the environment's own and must never be bound here.
//   - POST {port} to $MAKEFUN_ENV_URL/register. The environment records the
//     request's source address plus the port as this entry's base URL and
//     dials back from then on. A 409 means some other entry registered
//     first; that is not an error, the process simply waits like any other.
//   - GET $MAKEFUN_ENV_URL/done until it answers {"done": true}. The answer
//     arrives at once ({"done": false} while the suite is still running), so
//     this is a poll. A failed or slow poll is retried with backoff; the
//     process never exits before the environment says done.
//   - Close the server and exit 0. The harness then stops the environment,
//     which writes the export the scorer reads.

import { createApp } from './app.ts';

// The environment's origin, with any trailing slashes stripped off.
const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

// One register or done request may take this long before it is abandoned.
const REQUEST_TIMEOUT_MS = 30_000;
// Retry waits start here and never grow past the cap below.
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Wait after `attempt` failed tries: exponential from RETRY_INITIAL_MS, capped.
function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

/**
 * Run `step` until it reports success. Each attempt returns true when the
 * work is finished, false when it should be tried again, and may throw a
 * fatal error that ends the process. Retries wait with backoff between
 * attempts; there is no attempt limit, the environment may still be
 * starting.
 */
async function retryUntilDone(step: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    if (await step()) return;
    await sleep(retryDelay(attempt));
  }
}

/**
 * POST the bound port until the environment accepts it. 200 is the normal
 * answer and 409 means a first register already won, so both finish the
 * step. 400 and 405 are contract errors and end the program; a network
 * error or any other status is retried, since the environment may still
 * be starting.
 */
async function register(port: number): Promise<void> {
  await retryUntilDone(async () => {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return true;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
      return false;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
      return false;
    }
  });
}

/** Poll GET /done until it answers {"done": true}; never return before that. */
async function waitForDone(): Promise<void> {
  await retryUntilDone(async () => {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return true;
      }
    } catch {
      // The environment is not answering yet, or the poll timed out: it is
      // not done, so the step reports false and the poll runs again.
    }
    return false;
  });
}

/** Bind the port, register it, then wait for the environment: the whole life of the process. */
async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
