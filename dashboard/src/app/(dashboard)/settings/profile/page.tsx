'use client';

import { useAuth } from '@/hooks/use-auth';
import { Input } from '@/components/ui/input';
import { Field, Panel, readOnlyInput } from '@/components/settings/settings-ui';

export default function ProfileSettingsPage() {
  const { user } = useAuth();

  return (
    <div className="space-y-5">
      <Panel title="Your profile" description="Your personal account information.">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Name">
            <Input defaultValue={user?.name} disabled className={readOnlyInput} />
          </Field>
          <Field label="Email">
            <Input defaultValue={user?.email} disabled className={readOnlyInput} />
          </Field>
          <Field label="Role">
            <div className="flex h-9 items-center">
              <span className="rounded-md bg-accent-weak px-2.5 py-1 text-xs font-medium capitalize text-accent-fg">{user?.role ?? 'admin'}</span>
            </div>
          </Field>
        </div>
      </Panel>
    </div>
  );
}
