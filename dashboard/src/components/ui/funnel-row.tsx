import type { CSSProperties } from 'react';

export function FunnelRow({
  label,
  value,
  pct,
  index = 0,
}: {
  label: string;
  value: number;
  pct: number;
  index?: number;
}) {
  const style = { ['--a' as string]: 0.95 - index * 0.09 } as CSSProperties;
  return (
    <div className="funnel-row" style={style}>
      <div className="lbl">{label}</div>
      <div className="bar">
        <span style={{ width: `${Math.max(0, Math.min(1, pct)) * 100}%` }} />
      </div>
      <div className="val">{value.toLocaleString()}</div>
      <div className="pct">{(pct * 100).toFixed(pct < 0.05 ? 2 : 1)}%</div>
    </div>
  );
}
