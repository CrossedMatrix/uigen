'use client'

/**
 * ─── Unified Dashboard Status Badge ─────────────────────────────────────────
 *
 * Three variants, three visual languages:
 *
 *  'live'         → ● REAL-TIME / ● LIVE          — green pill  (rounded-full)
 *  'awaiting'     → ▲ AWAITING SYNC               — amber tag   (rounded-md)
 *  'disconnected' → ■ SIMULATED / ■ OFF / ■ DEMO  — red rect    (rounded-sm)
 *
 * Usage:
 *   <StatusBadge variant="live"         label="REAL-TIME FRED" />
 *   <StatusBadge variant="awaiting"     label="AWAITING SYNC" />
 *   <StatusBadge variant="disconnected" label="DEMO DATA" />
 */

export type StatusBadgeVariant = 'live' | 'awaiting' | 'disconnected'

export interface StatusBadgeProps {
  variant:    StatusBadgeVariant
  label:      string
  /** Override the geometric marker character. Defaults to ●/▲/■ per variant. */
  marker?:    string
  /** Show an animated pulse halo on the marker dot (live only). Default: true for live. */
  pulse?:     boolean
  title?:     string
  className?: string
}

// ─── Design tokens ────────────────────────────────────────────────────────────

const TOKEN = {
  live: {
    border:  'rgba(52,211,153,0.40)',
    bg:      'rgba(52,211,153,0.10)',
    text:    '#34d399',
    glow:    '0 0 6px #34d399, 0 0 12px rgba(52,211,153,0.50)',
    radius:  'rounded-full',
    marker:  '●',
  },
  awaiting: {
    border:  'rgba(251,191,36,0.38)',
    bg:      'rgba(251,191,36,0.08)',
    text:    '#fbbf24',
    glow:    undefined,
    radius:  'rounded-md',
    marker:  '▲',
  },
  disconnected: {
    border:  'rgba(239,68,68,0.38)',
    bg:      'rgba(239,68,68,0.08)',
    text:    '#ef4444',
    glow:    undefined,
    radius:  'rounded-sm',
    marker:  '■',
  },
} as const

// ─── Component ────────────────────────────────────────────────────────────────

export function StatusBadge({
  variant,
  label,
  marker,
  pulse = variant === 'live',
  title,
  className = '',
}: StatusBadgeProps) {
  const t       = TOKEN[variant]
  const icon    = marker ?? t.marker
  const isLive  = variant === 'live'

  return (
    <div
      className={`inline-flex items-center gap-1 px-2 py-0.5 border font-mono text-[10px] tracking-widest uppercase shrink-0 ${t.radius} ${className}`}
      style={{ borderColor: t.border, backgroundColor: t.bg, color: t.text }}
      title={title}
    >
      {/* Single geometric marker — unicode char only (no extra CSS dot) */}
      <span
        className={`shrink-0 leading-none${pulse ? ' animate-pulse' : ''}`}
        style={isLive ? { textShadow: t.glow } : undefined}
        aria-hidden
      >
        {icon}
      </span>
      {/* Label */}
      <span className="font-semibold leading-none">
        {label}
      </span>
    </div>
  )
}
