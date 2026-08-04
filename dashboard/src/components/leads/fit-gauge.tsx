'use client';

/**
 * Circular fit-score gauge (0–100), colored by threshold to match the fit-score
 * bar colors used elsewhere (fit-score-panel: ≥80 strong emerald … <20 zinc).
 * A null score renders a dashed "discovering" ring with an em-dash.
 */

export function scoreColor(score: number | null | undefined): string {
  if (score == null) return 'var(--ink-5)';
  if (score >= 80) return '#059669'; // emerald-600
  if (score >= 60) return '#10b981'; // emerald-500
  if (score >= 40) return '#f59e0b'; // amber-500
  if (score >= 20) return '#f97316'; // orange-500
  return '#a1a1aa'; // zinc-400
}

export function FitGauge({
  score,
  size = 56,
  stroke = 5,
}: {
  score: number | null | undefined;
  size?: number;
  stroke?: number;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = score == null ? 0 : Math.max(0, Math.min(100, score)) / 100;
  const color = scoreColor(score);
  const discovering = score == null;

  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }} aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--line)"
          strokeWidth={stroke}
          strokeDasharray={discovering ? '3 4' : undefined}
        />
        {!discovering && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c * (1 - pct)}
            style={{ transition: 'stroke-dashoffset 400ms ease' }}
          />
        )}
      </svg>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          lineHeight: 1,
        }}
      >
        <span
          className="mono"
          style={{ fontSize: size * 0.3, fontWeight: 600, color: discovering ? 'var(--ink-4)' : 'var(--ink)' }}
        >
          {discovering ? '—' : Math.round(score!)}
        </span>
        <span className="mono" style={{ fontSize: size * 0.15, color: 'var(--ink-4)', marginTop: 1 }}>
          /100
        </span>
      </div>
    </div>
  );
}
