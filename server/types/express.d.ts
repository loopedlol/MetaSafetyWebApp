import type { PublicUser } from '../../src/types/contracts.ts';

declare global {
  namespace Express {
    interface Request {
      user: PublicUser & { passwordHash?: string };
      requestId: string;
    }
  }
}

export {};
