// ---------------------------------------------------------------------------
// The direct checks' own bookkeeping (0.7.3): how many connections they opened
// (DoH, TLS, QUIC, the video page) — the log of a check / a pick names it, so
// the owner can line it up with lags — and their cancellation: zapret switched
// off / the VPN off aborts every probe in flight at once (its socket closed).
// ---------------------------------------------------------------------------

let opened = 0

/** one more outgoing connection / datagram exchange of a check */
export function countConnection(): void {
  opened++
}

/** connections the checks opened since the app started (the log takes differences) */
export function connectionsOpened(): number {
  return opened
}

/**
 * Runs `fn` once when `signal` aborts (right after this call if it already
 * has — never synchronously, the caller's variables are all set by then); the
 * returned function unhooks it — call it when the probe ends by itself.
 */
export function onAbort(signal: AbortSignal | undefined, fn: () => void): () => void {
  if (!signal) return () => undefined
  if (signal.aborted) {
    queueMicrotask(fn)
    return () => undefined
  }
  signal.addEventListener('abort', fn, { once: true })
  return () => signal.removeEventListener('abort', fn)
}
