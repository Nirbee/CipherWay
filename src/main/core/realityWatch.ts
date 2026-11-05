// ---------------------------------------------------------------------------
// `REALITY: received real certificate (potential MITM or redirection)` — the
// node answered with someone else's certificate. By far the most common reason:
// the key / shortId in our subscription cache is out of date, so the first
// reaction is to fetch the subscription again (at most once per 10 minutes). If
// the same server keeps failing after that, the list shows a hint on it instead
// of the user reading endless log lines. Pure — unit tested.
// ---------------------------------------------------------------------------

export const REALITY_ERROR_RE = /REALITY: received real certificate/

/** at most one automatic subscription refresh per this period */
export const REALITY_COOLDOWN_MS = 10 * 60_000
/** errors right after a refresh may still come from connections opened before it */
export const REALITY_GRACE_MS = 15_000
/** a hint disappears once the server has been quiet for this long */
export const REALITY_HINT_TTL_MS = 15 * 60_000

export const REALITY_HINT =
  'Сервер отвечает чужим сертификатом: ключ устарел или соединение подменяют. Подписка уже обновлена — выберите другой сервер.'

export interface RealityVerdict {
  /** refresh the subscription now */
  heal: boolean
  /** the set of hints changed */
  hintsChanged: boolean
}

export class RealityWatch {
  private lastHealAt = Number.NEGATIVE_INFINITY
  private healing = false
  private healEndedAt: number | null = null
  private lastSeen = new Map<string, number>()
  private hinted = new Set<string>()

  /** One error line; `nodeId` is unknown if the line could not be attributed. */
  note(nodeId: string | undefined, now = Date.now()): RealityVerdict {
    if (nodeId) this.lastSeen.set(nodeId, now)
    let heal = false
    if (!this.healing && now - this.lastHealAt >= REALITY_COOLDOWN_MS) {
      this.lastHealAt = now
      this.healing = true
      heal = true
    }
    let hintsChanged = false
    if (
      nodeId &&
      !heal &&
      !this.healing &&
      this.healEndedAt !== null &&
      now - this.healEndedAt >= REALITY_GRACE_MS &&
      !this.hinted.has(nodeId)
    ) {
      this.hinted.add(nodeId)
      hintsChanged = true
    }
    return { heal, hintsChanged }
  }

  /** The refresh finished (whatever the result). */
  healDone(now = Date.now()): void {
    this.healing = false
    this.healEndedAt = now
  }

  /** New config: every server gets a clean slate (the cooldown stays). */
  resetServers(): boolean {
    const had = this.hinted.size > 0
    this.hinted.clear()
    this.lastSeen.clear()
    return had
  }

  /** Forgets hints of servers that went quiet; true = the set changed. */
  prune(now = Date.now()): boolean {
    let changed = false
    for (const id of [...this.hinted]) {
      if (now - (this.lastSeen.get(id) ?? 0) >= REALITY_HINT_TTL_MS) {
        this.hinted.delete(id)
        changed = true
      }
    }
    return changed
  }

  hints(): Record<string, string> {
    return Object.fromEntries([...this.hinted].map((id) => [id, REALITY_HINT]))
  }
}
