import { cn } from '@/lib/utils';

export type AgentTab =
  | 'approvals' | 'overview' | 'contacts' | 'businesses' | 'opportunities' | 'companies'
  | 'documents' | 'emails' | 'activity' | 'strategy' | 'room' | 'settings';

const VALID_AGENT_TABS: readonly AgentTab[] = [
  'approvals', 'overview', 'contacts', 'businesses', 'opportunities', 'companies', 'documents', 'emails', 'activity', 'strategy', 'room', 'settings',
];

export function agentTabFromQuery(value: string | null): AgentTab {
  // ?tab=queue is the old name of the Approvals tab; keep old links working.
  if (value === 'queue') return 'approvals';
  return value && (VALID_AGENT_TABS as readonly string[]).includes(value) ? (value as AgentTab) : 'approvals';
}

export interface AgentTabItem {
  key: AgentTab;
  label: string;
  icon: React.ElementType;
  count?: number;
}

export interface AgentTabGroup {
  label: string;
  tabs: AgentTabItem[];
}

/** Grouped side navigation on wide screens; a single scrolling row of tabs on narrow ones. */
export function AgentTabNav({
  groups,
  active,
  onSelect,
}: {
  groups: AgentTabGroup[];
  active: AgentTab;
  onSelect: (tab: AgentTab) => void;
}) {
  return (
    <nav
      role="tablist"
      aria-orientation="vertical"
      className="scroll-thin flex gap-1 overflow-x-auto rounded-2xl border border-line bg-bg-panel p-2 shadow-sm lg:sticky lg:top-4 lg:flex-col lg:gap-0 lg:overflow-visible"
    >
      {groups.map((group, gi) => (
        <div key={group.label} className="contents lg:block">
          <div className={cn('hidden px-2.5 pb-1 text-3xs font-medium uppercase tracking-[0.09em] text-ink-4 lg:block', gi === 0 ? 'pt-1' : 'pt-3.5')}>
            {group.label}
          </div>
          <div className="contents lg:flex lg:flex-col lg:gap-0.5">
            {group.tabs.map((tab) => {
              const Icon = tab.icon;
              const isActive = active === tab.key;
              return (
                <button
                  key={tab.key}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => onSelect(tab.key)}
                  className={cn(
                    'flex h-8 shrink-0 items-center gap-2.5 whitespace-nowrap rounded-card border px-2.5 text-body transition-colors',
                    isActive
                      ? 'border-accent-mid bg-accent-weak font-medium text-accent-fg'
                      : 'border-transparent text-ink-2 hover:bg-hover hover:text-ink',
                  )}
                >
                  <Icon size={14} className={isActive ? 'text-accent' : 'text-ink-4'} />
                  {tab.label}
                  {tab.count !== undefined && tab.count > 0 && (
                    <span
                      className={cn(
                        'rounded-tag px-1.5 font-mono text-2xs leading-[18px] lg:ml-auto',
                        isActive ? 'bg-bg-panel/70 text-accent-fg' : 'bg-bg-soft text-ink-3',
                      )}
                    >
                      {tab.count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}
