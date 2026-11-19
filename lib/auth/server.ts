import { createNeonAuth } from '@neondatabase/auth/next/server';

const DEFAULT_COOKIE_SECRET =
  'bounty-hunter-neon-auth-cookie-secret-key-2026-production-9f8e7d6c5b4a';

export const auth = createNeonAuth({
  baseUrl:
    process.env.NEON_AUTH_BASE_URL ||
    'https://ep-aged-meadow-be3dmfa7.neonauth.c-9.us-east-2.aws.neon.tech/neondb/auth',
  cookies: {
    secret: process.env.NEON_AUTH_COOKIE_SECRET || DEFAULT_COOKIE_SECRET,
  },
});

export async function getAuthenticatedUser(): Promise<{
  id: string;
  email: string | null;
  name: string | null;
} | null> {
  try {
    const { data } = await auth.getSession();
    if (!data?.user?.id) {
      return null;
    }
    return {
      id: data.user.id,
      email: data.user.email || null,
      name: data.user.name || null,
    };
  } catch (err) {
    console.warn('[NeonAuth] getAuthenticatedUser error:', err);
    return null;
  }
}
