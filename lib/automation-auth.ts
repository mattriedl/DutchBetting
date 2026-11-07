/**
 * Shared auth for endpoints that must be callable BOTH by a signed-in human
 * (from the dashboard UI) and by an unattended scheduled job.
 *
 * A scheduled job has no browser session, so it authenticates with a shared
 * secret sent in the `x-automation-secret` header. The secret lives only in the
 * server environment (AUTOMATION_SECRET) and is never sent to the client.
 *
 * Every route using this still refuses anonymous traffic.
 */
import { NextRequest } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { prisma } from '@/lib/db';

export interface AuthorizedCaller {
  /** Which user the work is attributed to. */
  userId: string;
  /** true when the caller was a scheduled job rather than a browser session. */
  automated: boolean;
}

/** Resolve the account that automated runs act on behalf of (the data owner). */
async function resolveAutomationUserId(): Promise<string | null> {
  const email = process.env.AUTOMATION_USER_EMAIL;
  if (email) {
    const u = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (u) return u.id;
  }
  // Fall back to the oldest account, which is the owner on this deployment.
  const first = await prisma.user.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } });
  return first?.id ?? null;
}

/**
 * Returns the authorized caller, or null when the request should be rejected
 * with 401. Accepts either a valid NextAuth session or the automation secret.
 */
export async function authorizeCaller(req?: NextRequest | Request | null): Promise<AuthorizedCaller | null> {
  const configured = process.env.AUTOMATION_SECRET;
  const provided = req?.headers?.get?.('x-automation-secret') ?? null;

  if (configured && provided && provided === configured) {
    const userId = await resolveAutomationUserId();
    if (userId) return { userId, automated: true };
    return null;
  }

  const session = await getServerSession(authOptions);
  const userId = (session?.user as any)?.id as string | undefined;
  if (session?.user && userId) return { userId, automated: false };

  return null;
}
