import { neon, NeonQueryFunction } from '@neondatabase/serverless';
import { DailyTask, PoolTask, RecurringTask } from './types';

let cachedSql: NeonQueryFunction<false, false> | null = null;

/**
 * Lazy Neon HTTP driver initialization following Neon Serverless best practices for Next.js App Router.
 * Uses the pooled DATABASE_URL from .env.local without failing static analysis during `next build`.
 */
export function getSql(): NeonQueryFunction<false, false> {
  if (!cachedSql) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable is not configured');
    }
    cachedSql = neon(connectionString);
  }
  return cachedSql;
}

export function formatPgDate(val: unknown): string {
  if (!val) return '';
  if (typeof val === 'string') {
    return val.slice(0, 10);
  }
  if (val instanceof Date) {
    return val.toISOString().slice(0, 10);
  }
  return String(val).slice(0, 10);
}

export function formatPgTimestamp(val: unknown): string {
  if (!val) return new Date().toISOString();
  if (typeof val === 'string') {
    return new Date(val).toISOString();
  }
  if (val instanceof Date) {
    return val.toISOString();
  }
  return new Date().toISOString();
}

export function normalizeDailyTask(row: Record<string, unknown>): DailyTask {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    title: String(row.title ?? ''),
    notes: row.notes != null ? String(row.notes) : null,
    color: row.color != null ? String(row.color) : 'default',
    completed: Boolean(row.completed),
    order_index: typeof row.order_index === 'number' ? row.order_index : Number(row.order_index ?? 0),
    date_assigned: formatPgDate(row.date_assigned),
    created_at: formatPgTimestamp(row.created_at),
    is_bonus: row.is_bonus != null ? Boolean(row.is_bonus) : undefined,
    bounty_started_at: row.bounty_started_at ? formatPgTimestamp(row.bounty_started_at) : undefined,
    bounty_earned:
      row.bounty_earned != null && row.bounty_earned !== '' ? Number(row.bounty_earned) : null,
    bounty_amount:
      row.bounty_amount != null && row.bounty_amount !== '' ? Number(row.bounty_amount) : 100,
    completed_at: row.completed_at ? formatPgTimestamp(row.completed_at) : null,
  };
}

export function normalizePoolTask(row: Record<string, unknown>): PoolTask {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    title: String(row.title ?? ''),
    notes: row.notes != null ? String(row.notes) : null,
    color: row.color != null ? String(row.color) : 'default',
    bounty_amount:
      row.bounty_amount != null && row.bounty_amount !== '' ? Number(row.bounty_amount) : 10,
    created_at: formatPgTimestamp(row.created_at),
  };
}

export function normalizeRecurringTask(row: Record<string, unknown>): RecurringTask {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    title: String(row.title ?? ''),
    notes: row.notes != null ? String(row.notes) : null,
    color: row.color != null ? String(row.color) : 'default',
    frequency: row.frequency === 'weekly' ? 'weekly' : 'daily',
    day_of_week:
      row.day_of_week != null && row.day_of_week !== '' ? Number(row.day_of_week) : undefined,
    created_at: formatPgTimestamp(row.created_at),
  };
}

export function normalizeUserSettingsRow(row: Record<string, unknown> | null | undefined) {
  if (!row) return null;
  return {
    user_id: String(row.user_id),
    reset_time: row.reset_time ? String(row.reset_time).slice(0, 5) : '04:00',
    last_reset_date: row.last_reset_date ? formatPgDate(row.last_reset_date) : '',
    day_ended_date: row.day_ended_date ? formatPgDate(row.day_ended_date) : null,
    total_bounty_claimed:
      row.total_bounty_claimed != null && row.total_bounty_claimed !== ''
        ? Number(row.total_bounty_claimed)
        : 0,
    updated_at: row.updated_at ? formatPgTimestamp(row.updated_at) : new Date().toISOString(),
  };
}
