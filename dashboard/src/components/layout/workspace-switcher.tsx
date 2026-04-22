'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/stores/auth.store';
import { useWorkspaces, useCreateWorkspace, useSwitchWorkspace } from '@/hooks/use-workspaces';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { Building2, ChevronDown, Check, Plus, Loader2 } from 'lucide-react';

export function WorkspaceSwitcher() {
  const router = useRouter();
  const tenant = useAuthStore((s) => s.tenant);
  const { data: workspaces } = useWorkspaces();
  const switchWorkspace = useSwitchWorkspace();
  const createWorkspace = useCreateWorkspace();
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
        className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted/50 transition-colors text-sm"
      >
        <div className="w-6 h-6 rounded bg-primary/20 text-primary flex items-center justify-center text-xs font-bold">
          {initial}
        </div>
        <span className="hidden sm:block max-w-[120px] truncate font-medium">
          {tenant?.name ?? 'Workspace'}
        </span>
        <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-64 bg-background border border-border rounded-lg shadow-lg z-50 py-1">
          <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Workspaces
          </div>

          {(workspaces ?? []).map((ws) => (
            <button
              key={ws.id}
              onClick={() => handleSwitch(ws.id)}
              disabled={switchWorkspace.isPending}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted/50 transition-colors text-left"
            >
              <div className="w-6 h-6 rounded bg-primary/10 text-primary flex items-center justify-center text-xs font-bold shrink-0">
                {ws.name.charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{ws.name}</div>
                <div className="text-xs text-muted-foreground">{ws.role}</div>
              </div>
              {ws.id === tenant?.id && (
                <Check className="w-4 h-4 text-primary shrink-0" />
              )}
            </button>
          ))}

          <div className="border-t border-border mt-1 pt-1">
            {creating ? (
              <form onSubmit={handleCreate} className="px-3 py-2 flex gap-2">
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Workspace name"
                  className="h-8 text-sm"
                  autoFocus
                />
                <Button type="submit" size="sm" className="h-8 px-2" disabled={createWorkspace.isPending || !newName.trim()}>
                  {createWorkspace.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                </Button>
              </form>
            ) : (
              <button
                onClick={() => setCreating(true)}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted/50 transition-colors text-left text-muted-foreground"
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
