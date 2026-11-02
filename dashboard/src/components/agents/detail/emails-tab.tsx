import { Badge } from '@/components/ui/badge';
import { formatDate } from '@/lib/utils';
import { ListPanel, ListRow } from './list-panel';
import type { useAgentEmails } from '@/hooks/use-agents';

type AgentEmails = ReturnType<typeof useAgentEmails>['data'];

export function EmailsTab({ emails }: { emails: AgentEmails }) {
  const list = emails ?? [];
  return (
    <ListPanel
      title="Emails sent"
      count={list.length}
      scroll
      isEmpty={list.length === 0}
      empty="No emails sent yet. Emails go out after you approve drafts in Approvals."
    >
      {list.map((email) => (
        <li key={email.id}>
          <ListRow
            title={email.subject ?? 'No subject'}
            sub={`To: ${email.toEmail}`}
            aside={
              <>
                {email.repliedAt && <Badge variant="success">Replied</Badge>}
                {email.openedAt && !email.repliedAt && <Badge variant="outline">Opened</Badge>}
                {email.sentAt && <span className="font-mono text-xs text-ink-4">{formatDate(email.sentAt)}</span>}
              </>
            }
          />
        </li>
      ))}
    </ListPanel>
  );
}
