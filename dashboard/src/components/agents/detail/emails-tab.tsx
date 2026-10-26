import { Mail } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDate } from '@/lib/utils';
import type { useAgentEmails } from '@/hooks/use-agents';

type AgentEmails = ReturnType<typeof useAgentEmails>['data'];

export function EmailsTab({ emails }: { emails: AgentEmails }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Mail className="w-4 h-4" />
          Emails Sent ({emails?.length ?? 0})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 max-h-[500px] overflow-y-auto">
        {!emails || emails.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">
            No emails sent yet. Emails are sent after scoring in the pipeline.
          </p>
        ) : (
          emails.map((email) => (
            <div key={email.id} className="flex items-center justify-between p-2 rounded-lg hover:bg-muted/50 transition-colors">
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{email.subject ?? 'No subject'}</p>
                <p className="text-xs text-muted-foreground truncate">To: {email.toEmail}</p>
              </div>
              <div className="flex items-center gap-2 ml-2 shrink-0">
                {email.repliedAt && <Badge variant="success" className="text-xs">Replied</Badge>}
                {email.openedAt && !email.repliedAt && <Badge variant="outline" className="text-xs">Opened</Badge>}
                {email.sentAt && (
                  <span className="text-xs text-muted-foreground">{formatDate(email.sentAt)}</span>
                )}
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
