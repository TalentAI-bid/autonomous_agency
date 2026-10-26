import { Badge } from '@/components/ui/badge';

export type AgentTab =
  | 'queue' | 'overview' | 'contacts' | 'businesses' | 'opportunities' | 'companies'
  | 'documents' | 'emails' | 'activity' | 'strategy' | 'room' | 'settings';

export const VALID_AGENT_TABS: readonly AgentTab[] = [
  'queue', 'overview', 'contacts', 'businesses', 'opportunities', 'companies', 'documents', 'emails', 'activity', 'strategy', 'room', 'settings',
];

export function agentTabFromQuery(value: string | null): AgentTab {
  return value && (VALID_AGENT_TABS as readonly string[]).includes(value) ? (value as AgentTab) : 'queue';
}

export interface AgentTabItem {
  key: AgentTab;
  label: string;
  icon: React.ElementType;
  count?: number;
}

export function AgentTabNav({
  tabs,
  active,
  onSelect,
}: {
  tabs: AgentTabItem[];
  active: AgentTab;
  onSelect: (tab: AgentTab) => void;
}) {
  return (
    <div className="flex gap-1 border-b border-border">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        return (
          <button
            key={tab.key}
            onClick={() => onSelect(tab.key)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              active === tab.key
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
            }`}
          >
            <Icon className="w-4 h-4" />
            {tab.label}
            {tab.count !== undefined && tab.count > 0 && (
              <Badge variant="secondary" className="text-xs ml-1 px-1.5 py-0">
                {tab.count}
              </Badge>
            )}
          </button>
        );
      })}
    </div>
  );
}
