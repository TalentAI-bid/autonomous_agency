import { AgentGlyph, type AgentType } from './agent-glyph';

export function StreamRow({
  ts,
  agent,
  tag,
  message,
}: {
  ts: string;
  agent: AgentType | string;
  tag?: string;
  message: string;
}) {
  return (
    <div className="stream-row" style={{ padding: '6px 12px' }}>
      <span className="ts">{ts}</span>
      <AgentGlyph type={agent} size={16} />
      <div className="body">
        <span className={'agent-name ag-' + agent}>{agent}</span>
        <span style={{ fontSize: 12 }}>{message}</span>
      </div>
      {tag && (
        <span
          className="tag"
          style={{
            fontSize: 9.5,
            padding: '1px 5px',
            border: '1px solid var(--line)',
            borderRadius: 2,
            background: 'var(--bg-panel)',
          }}
        >
          {tag}
        </span>
      )}
    </div>
  );
}
