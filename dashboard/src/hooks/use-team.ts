'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPatch, apiDelete } from '@/lib/api';

export type TeamRole = 'owner' | 'admin' | 'member' | 'viewer';
export type InvitableRole = Exclude<TeamRole, 'owner'>;

export interface TeamMember {
  userId: string;
  email: string;
  name: string | null;
  role: TeamRole;
  joinedAt: string;
}

export interface PendingInvitation {
  id: string;
  email: string;
  role: TeamRole;
  createdAt: string;
  expiresAt: string;
  inviteUrl: string;
}

export function useTeamMembers() {
  return useQuery({
    queryKey: ['team', 'members'],
    queryFn: () => apiGet<TeamMember[]>('/team/members'),
  });
}

export function useTeamInvitations() {
  return useQuery({
    queryKey: ['team', 'invitations'],
    queryFn: () => apiGet<PendingInvitation[]>('/team/invitations'),
  });
}

export function useInviteMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { email: string; role: InvitableRole }) =>
      apiPost<{ id: string; email: string; role: TeamRole; expiresAt: string; inviteUrl: string }>(
        '/team/invitations',
        data,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team', 'invitations'] }),
  });
}

export function useRevokeInvitation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiDelete<void>(`/team/invitations/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team', 'invitations'] }),
  });
}

export function useUpdateMemberRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: TeamRole }) =>
      apiPatch<{ userId: string; role: TeamRole }>(`/team/members/${userId}`, { role }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team', 'members'] }),
  });
}

export function useRemoveMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => apiDelete<void>(`/team/members/${userId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team', 'members'] }),
  });
}
