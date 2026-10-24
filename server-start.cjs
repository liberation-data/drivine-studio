// server-start.cjs: how the desktop app knows its studio server is up. Apart from main.cjs, which needs
// Electron, so a test can drive it.

/**
 * True when something answers at url within timeoutMs. Bounded, since a process that holds the port but
 * never answers would otherwise keep the app waiting for ever, past any timeout of the caller's.
 */
async function answers(url, timeoutMs = 2000) {
  try {
    await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves once the server at url answers, rather than after a guess at how long it takes to start.
 * stopped() answers why the server has stopped, or null while it runs: a server that has exited will
 * never answer, so the wait fails then rather than at the timeout.
 */
async function waitForServer(url, { timeoutMs = 30000, intervalMs = 250, stopped = () => null } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reason = stopped();
    if (reason) throw new Error(reason);
    if (await answers(url, Math.max(1, deadline - Date.now()))) return;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`The studio server did not answer at ${url} within ${timeoutMs / 1000}s`);
}

module.exports = { answers, waitForServer };
