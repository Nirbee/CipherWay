// Simple vector stand-ins, drawn when a picture of assets/newyear is missing.

export function GarlandStandIn({ mirror }: { mirror?: boolean }) {
  return (
    <svg
      viewBox="0 0 220 40"
      preserveAspectRatio="none"
      className="h-full w-full"
      style={{ transform: mirror ? 'scaleX(-1)' : undefined }}
    >
      <path
        d="M-4 10 Q55 34 110 16 T224 12"
        fill="none"
        stroke="#1f5a36"
        strokeWidth="12"
        strokeLinecap="round"
      />
      <path
        d="M-4 10 Q55 34 110 16 T224 12"
        fill="none"
        stroke="#2f7d4b"
        strokeWidth="5"
        strokeDasharray="2 5"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function BowStandIn() {
  return (
    <svg viewBox="0 0 46 46" className="h-full w-full">
      <path d="M23 18 C10 4 2 10 4 20 C6 28 16 26 23 20 Z" fill="#c8202c" />
      <path d="M23 18 C36 4 44 10 42 20 C40 28 30 26 23 20 Z" fill="#c8202c" />
      <path d="M21 21 L12 42 L18 39 L22 44 L24 22 Z" fill="#a51521" />
      <path d="M25 21 L34 42 L28 39 L24 44 L22 22 Z" fill="#a51521" />
      <circle cx="23" cy="20" r="4.5" fill="#e0353f" />
    </svg>
  )
}

export function HatStandIn() {
  return (
    <svg viewBox="0 0 140 108" className="h-full w-full">
      <path
        d="M14 82 C26 30 70 6 104 22 C124 32 128 56 122 80 C96 70 50 70 14 82 Z"
        fill="#d42a32"
      />
      <path d="M104 22 C126 34 132 58 126 82" fill="none" stroke="#a81c24" strokeWidth="3" />
      <path d="M6 84 C40 66 96 66 132 82 L130 100 C96 86 42 86 8 102 Z" fill="#f4f7fb" />
      <circle cx="126" cy="88" r="11" fill="#f4f7fb" />
    </svg>
  )
}

export function TreeStandIn() {
  return (
    <svg viewBox="0 0 160 320" preserveAspectRatio="xMinYMax meet" className="h-full w-full">
      <rect x="66" y="280" width="18" height="34" fill="#4a2f1c" />
      <path
        d="M75 20 L140 120 H105 L150 200 H112 L158 286 H-8 L38 200 H0 L45 120 H10 Z"
        fill="#1e5a38"
      />
      <path d="M75 20 L96 52 H54 Z" fill="#eaf2ff" opacity="0.8" />
    </svg>
  )
}
