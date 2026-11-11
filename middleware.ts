import { NextResponse, type NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';

/**
 * Send signed-out visitors of protected pages to /login.
 *
 * Replaces next-auth's `withAuth`, which built the redirect from the URL Next.js sees internally
 * (e.g. http://localhost:3470) — behind a reverse proxy that sent people to a dead localhost link.
 * The redirect origin now comes from NEXTAUTH_URL (the public address), falling back to the
 * forwarded host headers.
 */
export async function middleware(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (token) return NextResponse.next();

  let origin: string;
  try {
    origin = new URL(process.env.NEXTAUTH_URL ?? '').origin;
  } catch {
    const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? req.nextUrl.host;
    const proto = req.headers.get('x-forwarded-proto') ?? req.nextUrl.protocol.replace(':', '');
    origin = `${proto}://${host}`;
  }
  const url = new URL('/login', origin);
  url.searchParams.set('callbackUrl', `${req.nextUrl.pathname}${req.nextUrl.search}`);
  return NextResponse.redirect(url);
}

// Every authenticated page must be listed here (see CLAUDE.md), or an expired session shows an
// empty page of 401s instead of redirecting to /login.
export const config = {
  matcher: [
    '/dashboard/:path*',
    '/settings/:path*',
    '/analytics/:path*',
    '/markets/:path*',
    '/opportunities/:path*',
    '/history/:path*',
    '/backtest/:path*',
    '/auto-bet/:path*',
    '/correct-score/:path*',
    '/polymarket-cs/:path*',
    '/soccer/:path*',
    '/goals/:path*',
    '/ai-tracker/:path*',
    '/predictions/:path*',
    '/value-tracker/:path*',
  ],
};
