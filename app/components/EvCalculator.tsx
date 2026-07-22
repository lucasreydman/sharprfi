'use client'

import { useState } from 'react'
import { impliedProbability, expectedValuePerUnit } from '@/lib/sim'
import { breakEvenOdds, formatOdds } from '@/lib/poisson'
import { MODE_LABELS, type ViewMode } from '@/lib/mode'

// Betting-value layer adapted from Francisco Nevarez's model:
// enter your book's American odds for the active side, get the implied
// probability, EV per unit vs the model probability, and a banded verdict.
//
// American odds are split into a sign toggle (default −) and a magnitude
// field so the calculator works on mobile numeric keypads, which have no
// +/− key.

type Sign = -1 | 1

function verdictForEv(ev: number, mode: ViewMode): { label: string; className: string } {
  const side = MODE_LABELS[mode]
  if (ev >= 0.05) return { label: `BET ${side}`, className: 'bg-green-100 text-green-700' }
  if (ev > 0) return { label: `SLIGHT +EV`, className: 'bg-emerald-50 text-emerald-700' }
  if (ev >= -0.05) return { label: 'PASS', className: 'bg-yellow-100 text-yellow-700' }
  return { label: 'NO BET', className: 'bg-red-100 text-red-600' }
}

// Combine the sign toggle with the typed magnitude into a valid American
// odds number, or null if the magnitude isn't a bettable price (|odds| ≥ 100).
function resolveOdds(sign: Sign, magnitude: string): number | null {
  const cleaned = magnitude.replace(/[^\d]/g, '')
  if (cleaned === '') return null
  const value = parseInt(cleaned, 10)
  if (!Number.isFinite(value) || value < 100) return null
  return sign * value
}

export default function EvCalculator({
  probability,
  mode,
}: {
  probability: number
  mode: ViewMode
}) {
  const [sign, setSign] = useState<Sign>(-1)
  const [magnitude, setMagnitude] = useState('')

  const odds = resolveOdds(sign, magnitude)
  const hasTyped = magnitude.replace(/[^\d]/g, '') !== ''

  const ev = odds !== null ? expectedValuePerUnit(probability, odds) : null
  const verdict = ev !== null ? verdictForEv(ev, mode) : null
  const fairOdds = breakEvenOdds(probability)

  const stop = (e: React.SyntheticEvent) => e.stopPropagation()

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-[0.65rem] font-semibold uppercase tracking-wider text-slate-400">
          Bet value ({MODE_LABELS[mode]})
        </div>
        {verdict ? (
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[0.65rem] font-semibold ${verdict.className}`}>
            {verdict.label}
          </span>
        ) : (
          <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[0.65rem] font-semibold text-slate-400">
            Enter odds
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <div className="flex items-center gap-2">
          <span className="text-slate-500">Your book&apos;s {MODE_LABELS[mode]} odds</span>

          {/* Sign toggle (default −) + magnitude — works on mobile keypads */}
          <div className="flex items-stretch overflow-hidden rounded-lg border border-slate-200">
            <div className="flex" role="group" aria-label="Odds sign">
              <button
                type="button"
                aria-pressed={sign === -1}
                onClick={e => {
                  stop(e)
                  setSign(-1)
                }}
                className={`px-2.5 py-1.5 text-sm font-bold tabular-nums transition-colors ${
                  sign === -1 ? 'bg-slate-800 text-white' : 'bg-white text-slate-400 hover:text-slate-600'
                }`}
              >
                −
              </button>
              <button
                type="button"
                aria-pressed={sign === 1}
                onClick={e => {
                  stop(e)
                  setSign(1)
                }}
                className={`px-2.5 py-1.5 text-sm font-bold tabular-nums transition-colors ${
                  sign === 1 ? 'bg-slate-800 text-white' : 'bg-white text-slate-400 hover:text-slate-600'
                }`}
              >
                +
              </button>
            </div>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              placeholder="110"
              value={magnitude}
              onChange={e => setMagnitude(e.target.value.replace(/[^\d]/g, ''))}
              onClick={stop}
              className="w-16 border-l border-slate-200 px-2 py-1.5 text-center tabular-nums text-slate-700 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-slate-300"
            />
          </div>
        </div>

        {odds !== null ? (
          <>
            <Metric label="Implied" value={`${(impliedProbability(odds) * 100).toFixed(1)}%`} tone="neutral" />
            <Metric label="Model" value={`${(probability * 100).toFixed(1)}%`} tone="neutral" />
            <Metric
              label="EV / unit"
              value={`${ev! >= 0 ? '+' : ''}${ev!.toFixed(3)}`}
              tone={ev! > 0 ? 'positive' : ev! < 0 ? 'negative' : 'neutral'}
            />
          </>
        ) : hasTyped ? (
          <span className="text-slate-400">Odds must be 100 or more (e.g. 110 or 125)</span>
        ) : (
          <span className="text-slate-400">Fair value: {formatOdds(fairOdds, false)}</span>
        )}
      </div>
    </div>
  )
}

function Metric({ label, value, tone }: { label: string; value: string; tone: 'neutral' | 'positive' | 'negative' }) {
  const valueClass =
    tone === 'positive' ? 'text-green-700' : tone === 'negative' ? 'text-red-600' : 'text-slate-700'
  return (
    <span className="inline-flex items-center gap-1 rounded-lg bg-slate-50 px-2 py-1.5">
      <span className="text-[0.6rem] font-semibold uppercase tracking-wider text-slate-400">{label}</span>
      <span className={`font-semibold tabular-nums ${valueClass}`}>{value}</span>
    </span>
  )
}
