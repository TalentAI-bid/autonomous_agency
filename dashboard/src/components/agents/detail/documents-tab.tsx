import { Badge } from '@/components/ui/badge';
import { formatDate } from '@/lib/utils';
import { ListPanel, ListRow } from './list-panel';
import type { useAgentDocuments } from '@/hooks/use-agents';

type AgentDocument = NonNullable<ReturnType<typeof useAgentDocuments>['data']>[number];

export function DocumentsTab({ documents }: { documents: AgentDocument[] }) {
  return (
    <ListPanel title="Documents" count={documents.length} isEmpty={documents.length === 0} empty="No documents yet.">
      {documents.map((doc) => (
        <li key={doc.id}>
          <ListRow
            title={doc.fileName || doc.type}
            sub={`${doc.type} · ${formatDate(doc.createdAt)}`}
            aside={<Badge variant="secondary">{doc.status}</Badge>}
          />
        </li>
      ))}
    </ListPanel>
  );
}
