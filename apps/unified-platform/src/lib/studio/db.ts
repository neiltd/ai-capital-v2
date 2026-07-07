// App-local generated client (see prisma/schema.prisma `output`) — do not
// import from '@prisma/client': that resolves to the pnpm-store copy shared
// with creator-studio, where the last `prisma generate` to run wins.
import { PrismaClient } from '@/generated/prisma'

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({ log: process.env.NODE_ENV === 'development' ? ['error'] : [] })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
