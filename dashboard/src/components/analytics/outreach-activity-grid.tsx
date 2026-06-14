'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Mail, MessageSquare, UserPlus, UserCheck, Reply } from 'lucide-react';
import { useOutreachActivity } from '@/hooks/use-analytics';

interface CardDef {
  title: string;
  value: number;
  sub: string;
  icon: React.ElementType;
  iconColor: string;
  bgColor: string;
}

export function OutreachActivityGrid() {
  const { data, isLoading } = useOutreachActivity();

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-28" />)}
      </div>
    );
  }

  const cards: CardDef[] = [
    {
      title: 'Emails Sent',
      value: data?.emailsSent ?? 0,
      sub: 'outreach emails',
      icon: Mail,
      iconColor: 'text-purple-400',
      bgColor: 'bg-purple-500/10',
    },
    {
      title: 'LinkedIn Messages',
      value: data?.linkedinMessagesSent ?? 0,
      sub: 'DMs sent',
      icon: MessageSquare,
      iconColor: 'text-blue-400',
      bgColor: 'bg-blue-500/10',
    },
    {
      title: 'Persons Added',
      value: data?.personsAddedWithNote ?? 0,
      sub: 'connection notes sent',
      icon: UserPlus,
      iconColor: 'text-cyan-400',
      bgColor: 'bg-cyan-500/10',
    },
    {
      title: 'Connections',
      value: data?.connectionsAccepted ?? 0,
      sub: 'connections accepted',
      icon: UserCheck,
      iconColor: 'text-green-400',
      bgColor: 'bg-green-500/10',
    },
    {
      title: 'Responses',
      value: data?.responses ?? 0,
      sub: 'people who replied',
      icon: Reply,
      iconColor: 'text-emerald-400',
      bgColor: 'bg-emerald-500/10',
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
      {cards.map(({ title, value, sub, icon: Icon, iconColor, bgColor }) => (
        <Card key={title}>
          <CardContent className="p-5">
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">{title}</p>
                <p className="text-2xl font-bold tabular-nums">{value}</p>
                <p className="text-xs text-muted-foreground">{sub}</p>
              </div>
              <div className={`p-2.5 rounded-lg ${bgColor}`}>
                <Icon className={`w-5 h-5 ${iconColor}`} />
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
