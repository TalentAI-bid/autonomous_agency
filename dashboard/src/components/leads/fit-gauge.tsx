'use client';

/**
 * Circular fit-score gauge (0–100), colored by threshold to match the fit-score
 * bar colors used elsewhere (fit-score-panel: ≥80 strong emerald … <20 zinc).
 * A null score renders a dashed "discovering" ring with an em-dash.
 */

export function scoreColor(score: number | null | undefined): string {
  if (score == null) return 'var(--ink-5)';
  if (score >= 80) return 'var(--up)';
  if (score >= 60) return 'var(--accent)';
  if (score >= 40) return 'var(--warn)';
  if (score >= 20) return 'var(--down)';
  return 'var(--ink-4)';
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
    <div className="relative shrink-0" style={{ width: size, height: size }}>
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
        className="absolute flex flex-col items-center justify-center leading-[1]" style={{ inset: 0 }}
      >
        <span
          className="mono !font-semibold"
          style={{ fontSize: size * 0.3, color: discovering ? 'var(--ink-4)' : 'var(--ink)' }}
        >
          {discovering ? '—' : Math.round(score!)}
        </span>
        <span className="mono !text-ink-4 !mt-px" style={{ fontSize: size * 0.15 }}>
          /100
        </span>
      </div>
    </div>
  );
}
