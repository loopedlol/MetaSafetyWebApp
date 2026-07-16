import type { PublicUser } from '../../src/types/contracts.ts';

declare global {
  namespace Express {
    interface Request {
      user: PublicUser & { passwordHash?: string };
      requestId: string;
      authKind?: 'supervisor' | 'glasses';
      glassesSession?: {
        id: string;
        supervisorUserId: string;
        scopeType: 'site' | 'tbm_session';
        scopeSiteId: string;
        scopeSessionId: string | null;
        siteName: string;
        siteArea: string;
        taskName: string | null;
        expiresAt: string;
      };
      nativeDevice?: { id: string; ownerId: string; name: string; createdAt: string; lastSeenAt: string };
    }
  }
}

export {};
