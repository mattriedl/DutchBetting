import { withAuth } from 'next-auth/middleware';

export default withAuth({
  pages: {
    signIn: '/login',
  },
});

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
