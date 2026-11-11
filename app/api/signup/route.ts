export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import bcrypt from 'bcryptjs';

// Public sign-up is OFF unless ALLOW_SIGNUP=true. This is a private dashboard: any account can run
// the research/ingest endpoints (spending API-Football / LLM credits) and see shared tracker data.
export async function POST(req: Request) {
  if (process.env.ALLOW_SIGNUP !== 'true') {
    return NextResponse.json({ error: 'Sign-up is disabled' }, { status: 403 });
  }
  try {
    const body = await req.json();
    const { password, name } = body ?? {};
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';

    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password are required' }, { status: 400 });
    }
    if (typeof password !== 'string' || password.length < 10) {
      return NextResponse.json({ error: 'Password must be at least 10 characters' }, { status: 400 });
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return NextResponse.json({ error: 'User already exists' }, { status: 409 });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: { email, password: hashedPassword, name: name ?? email?.split?.('@')?.[0] ?? 'User' },
    });

    return NextResponse.json({ id: user?.id, email: user?.email, name: user?.name }, { status: 201 });
  } catch (error: any) {
    console.error('Signup error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
