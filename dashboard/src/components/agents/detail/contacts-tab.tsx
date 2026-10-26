import Link from 'next/link';
import { Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { Contact, MasterAgent } from '@/types';

export function ContactsTab({
  agentId,
  agent,
  contacts,
  totalContacts,
}: {
  agentId: string;
  agent: MasterAgent;
  contacts: Contact[];
  totalContacts: number;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Users className="w-4 h-4" />
          Contacts ({totalContacts})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {contacts.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">
            No contacts discovered yet. Run the agent to start finding {agent.useCase === 'sales' ? 'prospects' : 'candidates'}.
          </p>
        ) : (
          contacts.map((contact) => (
            <Link key={contact.id} href={`/agents/${agentId}/contacts/${contact.id}`} className="block cursor-pointer">
              <div className="flex items-center justify-between p-2 rounded-lg hover:bg-muted/50 transition-colors">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{[contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.email || 'Unknown'}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {contact.title} {contact.companyName ? `at ${contact.companyName}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2 ml-2 shrink-0">
                  {(contact.score ?? 0) > 0 && (
                    <Badge variant="outline" className="text-xs">
                      {contact.score}
                    </Badge>
                  )}
                  <Badge variant="secondary" className="text-xs">{contact.status}</Badge>
                </div>
              </div>
            </Link>
          ))
        )}
      </CardContent>
    </Card>
  );
}
