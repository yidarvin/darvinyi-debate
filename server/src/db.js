import { PrismaClient } from '@prisma/client';

// Singleton pattern: prevents creating multiple PrismaClient instances during
// development hot-reload (nodemon restarts) which would exhaust the DB
// connection pool. In production, the module is loaded exactly once.
//
// See https://www.prisma.io/docs/orm/more/help-and-troubleshooting/help-articles/nextjs-prisma-client-dev-practices
// for the rationale (this pattern originated in Next.js but applies to any
// dev-server-with-hot-reload setup).

const globalForPrisma = globalThis;

export const prisma =
  globalForPrisma.__prisma ??
  new PrismaClient({
    log: ['error', 'warn'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__prisma = prisma;
}

export default prisma;
