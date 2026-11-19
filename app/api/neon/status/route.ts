import { NextResponse } from 'next/server';
import { getSql } from '@/lib/db';
import { getAuthenticatedUser } from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const hasDatabaseUrl = Boolean(process.env.DATABASE_URL);
  const hasAuthUrl = Boolean(process.env.NEON_AUTH_BASE_URL);
  const branch = process.env.NEON_BRANCH || 'production';
  const branchId = process.env.NEON_BRANCH_ID || '';

  let databaseConnected = false;
  let databaseName: string | null = null;
  let dbError: string | null = null;

  if (hasDatabaseUrl) {
    try {
      const sql = getSql();
      const rows = await sql`SELECT current_database() AS db, now() AS server_time`;
      databaseConnected = rows.length > 0;
      databaseName = rows[0]?.db ? String(rows[0].db) : 'neondb';
    } catch (err: unknown) {
      dbError = err instanceof Error ? err.message : String(err);
    }
  }

  const user = await getAuthenticatedUser();

  return NextResponse.json({
    configured: hasDatabaseUrl && hasAuthUrl,
    databaseConnected,
    databaseName,
    authConfigured: hasAuthUrl,
    authBaseUrl: process.env.NEON_AUTH_BASE_URL || null,
    branch,
    branchId,
    user,
    error: dbError,
  });
}
