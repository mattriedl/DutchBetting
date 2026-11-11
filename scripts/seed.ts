import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

/**
 * Creates (or leaves alone) one login account. Upsert only — never deletes or overwrites.
 *
 *   SEED_USER_EMAIL=you@example.com SEED_USER_PASSWORD='long-password' yarn prisma db seed
 *
 * The old version created a hard-coded admin (john@doe.com / johndoe123) plus fake June-2026
 * market rows. Both are gone: a published default password is a backdoor on any database it runs
 * against, and the fake markets showed up as real data.
 */
const prisma = new PrismaClient();

async function main() {
  const email = process.env.SEED_USER_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_USER_PASSWORD;
  if (!email || !password) {
    console.log('Seed skipped: set SEED_USER_EMAIL and SEED_USER_PASSWORD to create a login.');
    return;
  }
  if (password.length < 10) throw new Error('SEED_USER_PASSWORD must be at least 10 characters');

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`Seed: ${email} already exists, left unchanged.`);
    return;
  }
  await prisma.user.create({
    data: { email, name: email.split('@')[0], password: await bcrypt.hash(password, 12), role: 'admin' },
  });
  console.log(`Seed: created ${email}.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
