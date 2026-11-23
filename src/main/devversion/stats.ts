// Small numeric helpers for DevVersion summaries. Pure — unit tested.

/** Nearest-rank percentile of a list (null for an empty one). */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[rank]
}

/** Mean absolute difference of consecutive values (RFC 3550-ish jitter), ms. */
export function jitter(values: number[]): number | null {
  if (values.length < 2) return null
  let sum = 0
  for (let i = 1; i < values.length; i++) sum += Math.abs(values[i] - values[i - 1])
  return Math.round(sum / (values.length - 1))
}

export interface SampleSummary {
  samples: number
  ok_samples: number
  p50_ms: number | null
  p95_ms: number | null
  jitter_ms: number | null
  loss_pct: number | null
}

/** Samples in time order; null = no answer. */
export function summarize(samples: (number | null)[]): SampleSummary {
  const ok = samples.filter((s): s is number => typeof s === 'number')
  return {
    samples: samples.length,
    ok_samples: ok.length,
    p50_ms: percentile(ok, 50),
    p95_ms: percentile(ok, 95),
    jitter_ms: jitter(ok),
    loss_pct: samples.length
      ? Math.round(((samples.length - ok.length) / samples.length) * 1000) / 10
      : null
  }
}

/** Pushes into a bounded list, dropping the oldest. */
export function pushCapped<T>(list: T[], item: T, cap: number): void {
  list.push(item)
  if (list.length > cap) list.splice(0, list.length - cap)
}
