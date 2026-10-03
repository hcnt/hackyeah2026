// Icons traced from Penpot "Widget v1" (paths in each icon's own coordinates).

const stroke = { fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round' } as const

export function Chevron() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <path d="M3.5 5.25l3.5 3.5 3.5-3.5" stroke="#fafafa" strokeWidth="2.2" {...stroke} />
    </svg>
  )
}

export function Check({ size }: { size: 44 | 32 }) {
  const d = size === 44 ? 'M9.167 22.917l8.25 8.25 17.416-17.417' : 'M6.667 18.667l6 6L25.333 12'
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <path d={d} stroke="#ffffff" strokeWidth={size === 44 ? 4.1 : 2.6} {...stroke} />
    </svg>
  )
}

export function ButtonCheck() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <path d="M13.333 4L6 11.333 2.667 8" stroke="#fafafa" strokeWidth="2" {...stroke} />
    </svg>
  )
}

export function FaceGuide({ ok }: { ok: boolean }) {
  return (
    <svg className="an-face-guide" data-ok={ok} viewBox="0 0 176 216" aria-hidden>
      <ellipse cx="88" cy="108" rx="85" ry="105" fill="none" stroke="#ffffff" strokeOpacity="0.9" strokeWidth="3" strokeDasharray="13 13" />
    </svg>
  )
}
