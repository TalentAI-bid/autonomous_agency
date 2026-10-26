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
    <div className="stream-row py-1.5 px-3">
      <span className="ts">{ts}</span>
      <AgentGlyph type={agent} size={16} />
      <div className="body">
        <span className={'agent-name ag-' + agent}>{agent}</span>
        <span className="text-label">{message}</span>
      </div>
      {tag && (
        <span
          className="tag text-[9.5px] py-px px-[5px] border border-line rounded-[2px] bg-bg-panel"
        >
          {tag}
        </span>
      )}
    </div>
  );
}
