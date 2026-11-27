import { useEffect, useRef } from 'react'
import { reducedMotion } from './useNewYear'

interface Flake {
  x: number
  y: number
  r: number
  /** px per second */
  vy: number
  phase: number
  sway: number
  /** a rare big six-armed snowflake */
  star: boolean
  rot: number
  alpha: number
}

const MAX_FLAKES = 80
const STARS = 5

function makeFlake(w: number, h: number, star: boolean, anywhere: boolean): Flake {
  return {
    x: Math.random() * w,
    y: anywhere ? Math.random() * h : -10,
    r: star ? 3.5 + Math.random() * 2.5 : 0.7 + Math.random() * 1.6,
    vy: star ? 14 + Math.random() * 10 : 18 + Math.random() * 34,
    phase: Math.random() * Math.PI * 2,
    sway: 6 + Math.random() * 16,
    star,
    rot: Math.random() * Math.PI,
    alpha: star ? 0.45 + Math.random() * 0.2 : 0.35 + Math.random() * 0.45
  }
}

function drawStar(g: CanvasRenderingContext2D, f: Flake): void {
  g.save()
  g.translate(f.x, f.y)
  g.rotate(f.rot)
  g.strokeStyle = `rgba(230,240,255,${f.alpha})`
  g.lineWidth = 1
  g.beginPath()
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3
    const cx = Math.cos(a)
    const cy = Math.sin(a)
    g.moveTo(0, 0)
    g.lineTo(cx * f.r * 2, cy * f.r * 2)
    // small side twigs
    const mx = cx * f.r * 1.2
    const my = cy * f.r * 1.2
    g.moveTo(mx, my)
    g.lineTo(mx + Math.cos(a + 0.7) * f.r * 0.6, my + Math.sin(a + 0.7) * f.r * 0.6)
    g.moveTo(mx, my)
    g.lineTo(mx + Math.cos(a - 0.7) * f.r * 0.6, my + Math.sin(a - 0.7) * f.r * 0.6)
  }
  g.stroke()
  g.restore()
}

/**
 * Falling snow over the parent (absolute, no clicks). At most 80 flakes; stops
 * while the window is hidden / minimized; with «reduce motion» it is still.
 */
export function Snowfall({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    const g = canvas?.getContext('2d')
    if (!canvas || !g) return
    let w = 0
    let h = 0
    let flakes: Flake[] = []
    let raf = 0
    let last = 0
    const motion = reducedMotion()

    const draw = (): void => {
      g.clearRect(0, 0, w, h)
      for (const f of flakes) {
        if (f.star) {
          drawStar(g, f)
          continue
        }
        g.fillStyle = `rgba(235,243,255,${f.alpha})`
        g.beginPath()
        g.arc(f.x + Math.sin(f.phase) * f.sway * 0.3, f.y, f.r, 0, Math.PI * 2)
        g.fill()
      }
    }
    const step = (t: number): void => {
      const dt = last ? Math.min(0.05, (t - last) / 1000) : 0
      last = t
      for (const f of flakes) {
        f.y += f.vy * dt
        f.phase += dt * 0.9
        f.x += Math.sin(f.phase) * f.sway * dt
        if (f.star) f.rot += dt * 0.3
        if (f.y > h + 12) Object.assign(f, makeFlake(w, h, f.star, false))
        if (f.x < -12) f.x = w + 10
        else if (f.x > w + 12) f.x = -10
      }
      draw()
      raf = requestAnimationFrame(step)
    }
    const stop = (): void => {
      cancelAnimationFrame(raf)
      raf = 0
      last = 0
    }
    const sync = (): void => {
      stop()
      if (motion.matches)
        draw() // still snow
      else if (document.visibilityState === 'visible') raf = requestAnimationFrame(step)
    }
    const resize = (): void => {
      const rect = canvas.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      w = Math.max(1, Math.round(rect.width))
      h = Math.max(1, Math.round(rect.height))
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      const n = Math.min(MAX_FLAKES, Math.max(24, Math.round((w * h) / 9000)))
      flakes = Array.from({ length: n }, (_, i) => makeFlake(w, h, i < STARS, true))
      sync()
    }

    const ro = new ResizeObserver(resize)
    ro.observe(canvas)
    document.addEventListener('visibilitychange', sync)
    motion.addEventListener('change', sync)
    return () => {
      stop()
      ro.disconnect()
      document.removeEventListener('visibilitychange', sync)
      motion.removeEventListener('change', sync)
    }
  }, [])

  return (
    <canvas
      ref={ref}
      aria-hidden
      className={`pointer-events-none absolute inset-0 h-full w-full ${className ?? ''}`}
    />
  )
}
