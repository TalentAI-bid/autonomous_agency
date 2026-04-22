import { Spark } from './spark';

export function KpiTile({
  label,
  value,
  sub,
  delta,
  up,
  spark,
}: {
  label: string;
  value: string | number;
  sub?: string;
  delta?: string;
  up?: boolean;
  spark?: number[];
}) {
  return (
    <div className="kpi">
      <div className="label">{label}</div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, justifyContent: 'space-between' }}>
        <div className="value">{value}</div>
        {spark && spark.length > 0 && (
          <Spark data={spark} width={74} height={26} color={up ? 'var(--up)' : 'var(--accent)'} fill />
        )}
      </div>
      <div className="foot">
        {delta && (
          <span style={{ color: up ? 'var(--up)' : 'var(--down)' }}>
            {up ? '▲' : '▼'} {delta}
          </span>
        )}
        {sub && <span>{sub}</span>}
      </div>
    </div>
  );
}
