'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';

import { FormError, FormField, NativeSelect } from '@/components/app/form-field';
import {
  grantableRoles,
  useCan,
  useCurrentUser,
  useWorkspace,
} from '@/components/app/workspace-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useApiQuery } from '@/hooks/use-api-query';
import { api, type Member, problemMessage, type WorkspaceRole } from '@/lib/api/client';
import { formValue } from '@/lib/form';

function LoadingRows() {
  return (
    <div className="grid gap-2" aria-busy="true">
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
    </div>
  );
}

export default function MembersPage() {
  const workspace = useWorkspace();
  const can = useCan();
  const wid = workspace.id;
  const members = useApiQuery(`members:${wid}`, () =>
    api.GET('/v1/workspaces/{wid}/members', { params: { path: { wid } } }),
  );
  const invitations = useApiQuery(`invitations:${wid}`, () =>
    can('invitation.read')
      ? api.GET('/v1/workspaces/{wid}/invitations', { params: { path: { wid } } })
      : Promise.resolve({ data: { invitations: [] }, response: new Response() }),
  );

  return (
    <div className="grid gap-6">
      {can('invitation.create') && invitations.state.status !== 'error' && (
        <InviteCard onInvited={invitations.reload} />
      )}

      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
          <CardDescription>People who can access {workspace.name}.</CardDescription>
        </CardHeader>
        <CardContent>
          {members.state.status === 'loading' && <LoadingRows />}
          {members.state.status === 'error' && (
            <FormError message={problemMessage(members.state.error, 'Could not load members.')} />
          )}
          {members.state.status === 'ok' && (
            <MembersTable members={members.state.data.members} onChanged={members.reload} />
          )}
        </CardContent>
      </Card>

      {can('invitation.read') && (
        <Card>
          <CardHeader>
            <CardTitle>Pending invitations</CardTitle>
          </CardHeader>
          <CardContent>
            {invitations.state.status === 'loading' && <LoadingRows />}
            {invitations.state.status === 'error' && (
              <p className="text-sm text-muted-foreground">
                {invitations.state.httpStatus === 404
                  ? 'Invitations are not enabled for this workspace.'
                  : problemMessage(invitations.state.error)}
              </p>
            )}
            {invitations.state.status === 'ok' && (
              <PendingInvitations
                invitations={invitations.state.data.invitations}
                onChanged={invitations.reload}
              />
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function InviteCard({ onInvited }: { onInvited: () => void }) {
  const workspace = useWorkspace();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setPending(true);
    setError(null);
    const email = formValue(form, 'email');
    const { error: apiError } = await api.POST('/v1/workspaces/{wid}/invitations', {
      params: { path: { wid: workspace.id } },
      body: { email, role: formValue(form, 'role') as WorkspaceRole },
    });
    setPending(false);
    if (apiError) {
      setError(problemMessage(apiError, 'Could not send the invitation.'));
      return;
    }
    toast.success(`Invitation sent to ${email}`);
    formElement.reset();
    onInvited();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Invite people</CardTitle>
        <CardDescription>They&apos;ll get an email with a link to join.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={(e) => void onSubmit(e)} className="flex flex-wrap items-end gap-3">
          <div className="min-w-64 flex-1">
            <FormField id="invite-email" label="Email" type="email" name="email" required />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="invite-role">Role</Label>
            <NativeSelect id="invite-role" name="role" defaultValue="member">
              {grantableRoles(workspace.role).map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </NativeSelect>
          </div>
          <Button type="submit" disabled={pending}>
            {pending ? 'Sending…' : 'Send invitation'}
          </Button>
        </form>
        <div className="mt-3">
          <FormError message={error} />
        </div>
      </CardContent>
    </Card>
  );
}

function MembersTable({ members, onChanged }: { members: Member[]; onChanged: () => void }) {
  const router = useRouter();
  const workspace = useWorkspace();
  const user = useCurrentUser();
  const can = useCan();
  const myRole = workspace.role;

  async function changeRole(member: Member, role: WorkspaceRole) {
    const { error } = await api.PATCH('/v1/workspaces/{wid}/members/{userId}', {
      params: { path: { wid: workspace.id, userId: member.userId } },
      body: { role },
    });
    if (error) toast.error(problemMessage(error));
    else toast.success(`${member.name} is now ${role}`);
    onChanged();
  }

  async function remove(member: Member, isSelf: boolean) {
    const { error } = await api.DELETE('/v1/workspaces/{wid}/members/{userId}', {
      params: { path: { wid: workspace.id, userId: member.userId } },
    });
    if (error) {
      toast.error(problemMessage(error));
      return;
    }
    if (isSelf) {
      router.push('/');
      router.refresh();
      return;
    }
    toast.success(`${member.name} was removed`);
    onChanged();
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Email</TableHead>
          <TableHead>Role</TableHead>
          <TableHead className="text-right">
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {members.map((member) => {
          const isSelf = member.userId === user.id;
          // Mirrors the server's rules so we don't offer what it would reject.
          const touchable = !(myRole === 'admin' && member.role === 'owner');
          const canChangeRole = can('member.update') && touchable;
          const canRemove = isSelf || (can('member.remove') && touchable);
          const options = grantableRoles(myRole);
          return (
            <TableRow key={member.userId} data-testid={`member-${member.email}`}>
              <TableCell className="font-medium">
                {member.name}
                {isSelf && <span className="ml-1 text-muted-foreground">(you)</span>}
              </TableCell>
              <TableCell>{member.email}</TableCell>
              <TableCell>
                {canChangeRole ? (
                  <NativeSelect
                    aria-label={`Role for ${member.email}`}
                    value={member.role}
                    onChange={(e) => void changeRole(member, e.target.value as WorkspaceRole)}
                  >
                    {(options.includes(member.role) ? options : [...options, member.role]).map(
                      (role) => (
                        <option key={role} value={role}>
                          {role}
                        </option>
                      ),
                    )}
                  </NativeSelect>
                ) : (
                  <Badge variant="outline">{member.role}</Badge>
                )}
              </TableCell>
              <TableCell className="text-right">
                {canRemove && (
                  <Button variant="ghost" size="sm" onClick={() => void remove(member, isSelf)}>
                    {isSelf ? 'Leave' : 'Remove'}
                  </Button>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function PendingInvitations({
  invitations,
  onChanged,
}: {
  invitations: { id: string; email: string; role: string; expiresAt: string }[];
  onChanged: () => void;
}) {
  const workspace = useWorkspace();
  const can = useCan();

  async function revoke(id: string, email: string) {
    const { error } = await api.DELETE('/v1/workspaces/{wid}/invitations/{id}', {
      params: { path: { wid: workspace.id, id } },
    });
    if (error) toast.error(problemMessage(error));
    else toast.success(`Invitation to ${email} revoked`);
    onChanged();
  }

  if (invitations.length === 0) {
    return <p className="text-sm text-muted-foreground">No pending invitations.</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Email</TableHead>
          <TableHead>Role</TableHead>
          <TableHead>Expires</TableHead>
          <TableHead className="text-right">
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {invitations.map((invitation) => (
          <TableRow key={invitation.id}>
            <TableCell>{invitation.email}</TableCell>
            <TableCell>
              <Badge variant="outline">{invitation.role}</Badge>
            </TableCell>
            <TableCell>{new Date(invitation.expiresAt).toLocaleDateString()}</TableCell>
            <TableCell className="text-right">
              {can('invitation.cancel') && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void revoke(invitation.id, invitation.email)}
                >
                  Revoke
                </Button>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
