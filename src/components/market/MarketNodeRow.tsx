'use client'

import React from 'react'
import type { MarketNode } from '@/lib/types/market'

interface MarketNodeRowProps {
  node: MarketNode
  showSparkline?: boolean
  compact?: boolean
  /** Active timeframe — rendered as a muted chip next to the % change in compact mode */
  timeframe?: '1D' | '5D' | '1M' | '3M'
}

/**
 * Unified Market Node Row Component
 * Displays a single market instrument (FX, commodity, or index)
 * with dynamic liveness indicators:
 * - 🟢 GREEN PULSE: LIVE_INTRADAY (fresh data, market active)
 * - 🕐 AMBER CLOCK: MARKET_CLOSED_STALE (no update since close)
 * - 🔴 RED WARNING: FEED_DISCONNECTED (API down or very stale)
 */
export function MarketNodeRow({ node, showSparkline = false, compact = false, timeframe }: MarketNodeRowProps) {
  const {
    displayName,
    price,
    change,
    changePercent,
    decimals,
    unit,
    liveness,
    sparkline,
  } = node

  const { status, ageSeconds, message, dataSource } = liveness

  // ─── Liveness Styling ────────────────────────────────────────────────────────

  const isLive = status === 'LIVE_INTRADAY'
  const isStale = status === 'MARKET_CLOSED_STALE'
  const isDisconnected = status === 'FEED_DISCONNECTED'

  const statusColor = isLive ? '#34d399' : isStale ? '#fbbf24' : '#ef4444'
  const statusBg = isLive ? 'rgba(52,211,153,0.1)' : isStale ? 'rgba(251,191,36,0.1)' : 'rgba(239,68,68,0.1)'

  const pulseAnimation = isLive
    ? `
        @keyframes pulse {
          0%, 100% { box-shadow: 0 0 0 0 ${statusColor}40; }
          50% { box-shadow: 0 0 0 8px transparent; }
        }
        animation: pulse 2s infinite;
      `
    : ''

  // ─── Format Values ───────────────────────────────────────────────────────────
  // ZERO-TOLERANCE: Handle null prices (rate-limited) with clean "--" display

  const priceDisplay = price === null ? '--' : price.toFixed(decimals ?? 2)
  const changeColor = change === null || change >= 0 ? '#34d399' : '#f87171'
  const changeDisplay =
    change === null ? '--' : (change >= 0 ? '+' : '') + change.toFixed(decimals ?? 2)
  const changePctDisplay =
    changePercent === null ? '--' : (changePercent >= 0 ? '+' : '') + changePercent.toFixed(2) + '%'

  // ─── Sparkline Rendering ─────────────────────────────────────────────────────

  const renderSparkline = () => {
    // ZERO-TOLERANCE: Don't render sparkline for null prices
    if (!showSparkline || !sparkline || sparkline.length < 2 || price === null) return null

    const minPrice = Math.min(...sparkline)
    const maxPrice = Math.max(...sparkline)
    const range = maxPrice - minPrice || 1

    const normalized = sparkline.map(p => ((p - minPrice) / range) * 100)
    const points = normalized.map((y, i) => `${(i / (normalized.length - 1)) * 100},${100 - y}`).join(' ')

    return (
      <svg
        viewBox="0 0 100 30"
        className="h-6 w-full"
        style={{ opacity: 0.6, marginTop: '4px' }}
      >
        <polyline
          points={points}
          fill="none"
          stroke={changeColor}
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    )
  }

  // ─── Status Icon ──────────────────────────────────────────────────────────────

  const statusIcon = isLive ? '🟢' : isStale ? '🕐' : '🔴'
  const statusLabel = status
    .split('_')
    .map(word => word.charAt(0) + word.slice(1).toLowerCase())
    .join(' ')

  // ─── Render ───────────────────────────────────────────────────────────────────

  if (compact) {
    return (
      <div
        className="flex items-center gap-2 px-2 py-1.5 rounded border text-[11px]"
        style={{
          backgroundColor: statusBg,
          borderColor: statusColor + '40',
        }}
      >
        {/* Status Indicator */}
        <div
          className="w-2.5 h-2.5 rounded-full"
          style={{
            backgroundColor: statusColor,
            ...(!isDisconnected && isLive ? { boxShadow: `0 0 0 0 ${statusColor}40` } : {}),
          }}
        >
          <style>{pulseAnimation}</style>
        </div>

        {/* Name & Price */}
        <div className="flex-1">
          <div className="font-mono font-semibold text-slate-100">{displayName}</div>
          <div className={price === null ? 'text-slate-500/60 font-mono' : 'text-slate-400'}>
            {priceDisplay}{price !== null && unit ? ` ${unit}` : ''}
          </div>
        </div>

        {/* Change - Shifted right */}
        <div className="text-right">
          <div
            className="font-mono font-semibold"
            style={{ color: changePercent === null ? 'rgb(100, 116, 139, 0.6)' : changeColor }}
          >
            {changeDisplay}
          </div>
          <div
            className="text-[10px] flex items-center justify-end gap-1"
            style={{ color: changePercent === null ? 'rgb(100, 116, 139, 0.6)' : changeColor }}
          >
            {changePctDisplay}
            {/* Period chip — shown only for non-1D lookbacks */}
            {timeframe && timeframe !== '1D' && (
              <span
                className="text-[8px] font-mono px-0.5 rounded-sm border leading-none"
                style={{
                  color:            'rgba(148,163,184,0.55)',
                  borderColor:      'rgba(148,163,184,0.18)',
                  backgroundColor:  'rgba(148,163,184,0.06)',
                }}
              >
                {timeframe}
              </span>
            )}
          </div>
        </div>
      </div>
    )
  }

  // ─── Full Row Layout ──────────────────────────────────────────────────────────

  return (
    <div
      className="grid items-center gap-3 px-3 py-2 rounded border border-slate-800/50 hover:bg-slate-800/20 transition-colors"
      style={{
        gridTemplateColumns: '2fr 1.2fr 1.5fr 1fr',
        backgroundColor: isDisconnected ? 'rgba(239,68,68,0.05)' : undefined,
      }}
    >
      {/* ─── MARKET INFO ───────────────────────────────────────────────────────────── */}
      <div>
        <div className="font-mono text-sm font-semibold text-slate-100">{displayName}</div>
        <div className="text-[10px] text-slate-500 font-mono">
          {node.category.toUpperCase()} • {dataSource.toUpperCase()}
        </div>
      </div>

      {/* ─── PRICE & UNIT ────────────────────────────────────────────────────────────── */}
      <div className="text-right">
        <div
          className={`font-mono text-sm font-semibold ${
            price === null ? 'text-slate-500/60' : 'text-slate-100'
          }`}
        >
          {priceDisplay}
        </div>
        <div
          className={`text-[9px] font-mono ${price === null ? 'text-slate-500/60' : 'text-slate-400'}`}
        >
          {price !== null ? unit : ''}
        </div>
      </div>

      {/* ─── CHANGE ──────────────────────────────────────────────────────────────────── */}
      <div className="text-right">
        <div
          className="font-mono text-sm font-bold tabular-nums"
          style={{
            color:
              changePercent === null ? 'rgb(100, 116, 139, 0.6)' : changeColor,
          }}
        >
          {changeDisplay}
        </div>
        <div
          className="text-[10px] font-mono"
          style={{
            color:
              changePercent === null ? 'rgb(100, 116, 139, 0.6)' : changeColor,
          }}
        >
          {changePctDisplay}
        </div>
        {showSparkline && renderSparkline()}
      </div>

      {/* ─── LIVENESS INDICATOR ──────────────────────────────────────────────────────── */}
      <div className="flex justify-center">
        <div
          className="relative w-10 h-10 rounded-full flex items-center justify-center border-2 flex-shrink-0"
          style={{
            borderColor: statusColor,
            backgroundColor: statusBg,
          }}
        >
          {/* Pulse ring for live data */}
          {isLive && (
            <div
              className="absolute w-12 h-12 rounded-full opacity-0"
              style={{
                borderColor: statusColor,
                borderWidth: '2px',
                animation: 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
              }}
            />
          )}

          {/* Status icon */}
          <span className="text-lg font-bold relative z-10">
            {isLive ? '🟢' : isStale ? '🕐' : '🔴'}
          </span>
        </div>
      </div>

      {/* CSS for pulse animation */}
      <style>{`
        @keyframes pulse {
          0%, 100% {
            opacity: 1;
          }
          50% {
            opacity: 0.5;
          }
        }
      `}</style>
    </div>
  )
}

/**
 * Compact Market Node Row for dense tables
 */
export function CompactMarketNodeRow(props: MarketNodeRowProps) {
  return <MarketNodeRow {...props} compact={true} />
}

/**
 * Market Node Row with Sparkline (for dashboard cards)
 */
export function MarketNodeRowWithSparkline(props: Omit<MarketNodeRowProps, 'showSparkline'>) {
  return <MarketNodeRow {...props} showSparkline={true} />
}
