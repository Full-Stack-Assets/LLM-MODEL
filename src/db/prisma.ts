import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  log: ['error'],
});

/**
 * Verify database connectivity without creating any rows. Throws if the
 * database is unreachable.
 */
export async function pingDatabase(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
}

export { prisma };
