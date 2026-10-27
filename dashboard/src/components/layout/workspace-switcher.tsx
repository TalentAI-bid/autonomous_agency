'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/stores/auth.store';
import { useWorkspaces, useCreateWorkspace, useSwitchWorkspace, useDeleteWorkspace } from '@/hooks/use-workspaces';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { ChevronDown, Check, Plus, Loader2, Trash2 } from 'lucide-react';

export function WorkspaceSwitcher() {
  const router = useRouter();
  const tenant = useAuthStore((s) => s.tenant);
  const { data: workspaces } = useWorkspaces();
  const switchWorkspace = useSwitchWorkspace();
  const createWorkspace = useCreateWorkspace();
  const deleteWorkspace = useDeleteWorkspace();
  const { toast } = useToast();

  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
      }
    }
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  async function handleSwitch(id: string) {
    if (id === tenant?.id) {
      setOpen(false);
      return;
    }
    try {
      await switchWorkspace.mutateAsync(id);
      setOpen(false);
      // Soft-refresh server components with the updated auth state.
      // No window.location.reload() — that races with Zustand persist
      // hydration and flips the route guard to /login.
      router.refresh();
    } catch {
      toast({ title: 'Failed to switch workspace', variant: 'destructive' });
    }
  }

  async function handleDelete(id: string, name: string) {
    if (
      !confirm(
        `Delete workspace "${name}"?\n\nThis permanently deletes all its agents, companies, contacts and other data. This cannot be undone.`
      )
    ) {
      return;
    }
    try {
      await deleteWorkspace.mutateAsync(id);
      toast({ title: `Workspace "${name}" deleted` });
    } catch {
      toast({ title: 'Failed to delete workspace', variant: 'destructive' });
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    try {
      const ws = await createWorkspace.mutateAsync({ name: newName.trim() });
      setNewName('');
      setCreating(false);
      // Switch to the new workspace
      await handleSwitch(ws.id);
    } catch {
      toast({ title: 'Failed to create workspace', variant: 'destructive' });
    }
  }

  const initial = tenant?.name?.charAt(0)?.toUpperCase() ?? 'W';

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex h-8 items-center gap-2 rounded-lg border border-line bg-bg-panel px-2 text-body transition-colors hover:bg-bg-soft"
      >
        <div className="grid size-5 place-items-center rounded-md bg-accent text-2xs font-semibold text-white">
          {initial}
        </div>
        <span className="hidden max-w-[120px] truncate font-medium text-ink sm:block">
          {tenant?.name ?? 'Workspace'}
        </span>
        <ChevronDown className="size-3.5 text-ink-3" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1.5 w-64 rounded-lg border border-line bg-bg-panel p-1 shadow-lg">
          <div className="px-2.5 pb-1.5 pt-2 text-2xs font-medium uppercase tracking-[0.09em] text-ink-4">
            Workspaces
          </div>

          {(workspaces ?? []).map((ws) => {
            const isActive = ws.id === tenant?.id;
            const canDelete =
              ws.role === 'owner' && !isActive && (workspaces?.length ?? 0) > 1;
            return (
              <div
                key={ws.id}
                className="group flex items-center rounded-md transition-colors hover:bg-bg-soft"
              >
                <button
                  onClick={() => handleSwitch(ws.id)}
                  disabled={switchWorkspace.isPending}
                  className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left text-body"
                >
                  <div className="grid size-6 shrink-0 place-items-center rounded-md bg-accent-weak text-2xs font-semibold text-accent-fg">
                    {ws.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-ink">{ws.name}</div>
                    <div className="text-xs text-ink-3">{ws.role}</div>
                  </div>
                  {isActive && <Check className="size-4 shrink-0 text-accent" />}
                </button>
                {canDelete && (
                  <button
                    onClick={() => handleDelete(ws.id, ws.name)}
                    disabled={deleteWorkspace.isPending}
                    title="Delete workspace"
                    aria-label={`Delete workspace ${ws.name}`}
                    className="shrink-0 px-2 py-2 text-ink-3 opacity-0 transition-opacity hover:text-down group-hover:opacity-100"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            );
          })}

          <div className="mt-1 border-t border-line pt-1">
            {creating ? (
              <form onSubmit={handleCreate} className="flex gap-2 px-2.5 py-2">
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Workspace name"
                  className="h-8 text-body"
                  autoFocus
                />
                <Button type="submit" size="sm" className="h-8 px-2" disabled={createWorkspace.isPending || !newName.trim()}>
                  {createWorkspace.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                </Button>
              </form>
            ) : (
              <button
                onClick={() => setCreating(true)}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-body text-ink-3 transition-colors hover:bg-bg-soft hover:text-ink"
              >
                <Plus className="w-4 h-4" />
                Create workspace
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
