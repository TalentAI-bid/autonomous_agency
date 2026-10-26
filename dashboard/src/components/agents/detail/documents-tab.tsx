import { FileText } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDate } from '@/lib/utils';
import type { useAgentDocuments } from '@/hooks/use-agents';

type AgentDocument = NonNullable<ReturnType<typeof useAgentDocuments>['data']>[number];

export function DocumentsTab({ documents }: { documents: AgentDocument[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <FileText className="w-4 h-4" />
          Documents ({documents.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {documents.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">
            No documents yet.
          </p>
        ) : (
          documents.map((doc) => (
            <div key={doc.id} className="flex items-center justify-between p-2 rounded-lg hover:bg-muted/50 transition-colors">
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{doc.fileName || doc.type}</p>
                <p className="text-xs text-muted-foreground truncate">
                  {doc.type} · {formatDate(doc.createdAt)}
                </p>
              </div>
              <Badge variant="secondary" className="text-xs">{doc.status}</Badge>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
