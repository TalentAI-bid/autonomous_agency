export function Spark({
  data,
  width = 80,
  height = 22,
  color = 'var(--accent)',
  fill = false,
}: {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  fill?: boolean;
}) {
  if (!data?.length) return null;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const rng = max - min || 1;
  const step = width / Math.max(1, data.length - 1);
  const pts = data.map((v, i) => [i * step, height - ((v - min) / rng) * height] as const);
  const d = 'M ' + pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' L ');
  return (
    <svg className="spark" width={width} height={height} aria-hidden>
      {fill && (
        <path d={d + ` L ${width},${height} L 0,${height} Z`} fill={color} opacity="0.12" />
      )}
      <path d={d} fill="none" stroke={color} strokeWidth="1.2" />
    </svg>
  );
}
