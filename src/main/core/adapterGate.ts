// ---------------------------------------------------------------------------
// One wintun adapter at a time (0.5.1). The TUN core (sing-box) and the LAN
// daemon (tailscaled) each create a wintun adapter through their own broker.
// wintun.dll serializes creation machine-wide anyway (its device installation
// mutex, held for up to 15 s while it waits for the device), so starting both
// at once only makes each wait behind the other's slow attempt — right after a
// reboot that was 15 s + 15 s, the LAN start gave up and killed its daemon in
// the middle of creating the adapter, and Windows then refused every wintun
// adapter for minutes. The app now lets one of them create its adapter, then
// the other. A waiter never waits forever: after `maxWaitMs` it goes ahead
// (wintun still keeps the two apart). Pure — unit tested in adapterGate.test.ts.
// ---------------------------------------------------------------------------

export interface AdapterGateOpts {
  /** give up waiting after this long and go ahead (default 60 s) */
  maxWaitMs?: number
  /** called once when the other one is creating its adapter right now */
  onWait?: (holder: string) => void
}

export interface AdapterGateLike {
  run<T>(who: string, fn: () => Promise<T>, opts?: AdapterGateOpts): Promise<T>
}

const DEFAULT_MAX_WAIT_MS = 60_000

export class AdapterGate implements AdapterGateLike {
  private tail: Promise<void> = Promise.resolve()
  private holder: string | null = null
  /** everybody inside or waiting, in order */
  private line: Array<{ who: string }> = []

  /** who is creating an adapter now (null = nobody) */
  get busy(): string | null {
    return this.holder
  }

  async run<T>(who: string, fn: () => Promise<T>, opts: AdapterGateOpts = {}): Promise<T> {
    const before = this.tail
    let release!: () => void
    const mine = new Promise<void>((r) => {
      release = r
    })
    // the next one waits for everybody queued before it and for this one
    this.tail = Promise.all([before, mine]).then(() => undefined)
    const me = { who }
    const ahead = this.line[0]
    this.line.push(me)
    if (ahead) opts.onWait?.(ahead.who)
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      before,
      new Promise<void>((r) => {
        timer = setTimeout(r, opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS)
      })
    ])
    clearTimeout(timer)
    this.holder = who
    try {
      return await fn()
    } finally {
      if (this.holder === who) this.holder = null
      this.line = this.line.filter((x) => x !== me)
      release()
    }
  }
}
