'use server';

import { neon } from '@neondatabase/serverless';
import { auth } from '@/lib/auth/server';
import {
  normalizeDailyTask,
  normalizePoolTask,
  normalizeRecurringTask,
  normalizeUserSettingsRow,
} from '@/lib/db';
import { DailyTask, PoolTask, RecurringTask } from '@/lib/types';

function getNeonSql() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is not set');
  }
  return neon(process.env.DATABASE_URL);
}

/**
 * Fetch user settings for the currently authenticated user.
 */
export async function getUserSettings() {
  const { data: session } = await auth.getSession();
  if (!session?.user?.id) {
    throw new Error('Unauthorized: No active Neon Auth session');
  }
  const sql = getNeonSql();
  const rows = await sql.query(
    `SELECT * FROM public.user_settings WHERE user_id = $1::uuid LIMIT 1`,
    [session.user.id]
  );
  return normalizeUserSettingsRow(rows[0] as Record<string, unknown> | undefined);
}

/**
 * Upsert user settings (reset_time, last_reset_date, day_ended_date, total_bounty_claimed).
 */
export async function updateUserSettings(input: {
  reset_time?: string;
  last_reset_date?: string | null;
  day_ended_date?: string | null;
  total_bounty_claimed?: number;
}) {
  const { data: session } = await auth.getSession();
  if (!session?.user?.id) {
    throw new Error('Unauthorized: No active Neon Auth session');
  }
  const sql = getNeonSql();

  const existingRows = await sql.query(
    `SELECT * FROM public.user_settings WHERE user_id = $1::uuid LIMIT 1`,
    [session.user.id]
  );
  const existing = normalizeUserSettingsRow(existingRows[0] as Record<string, unknown> | undefined);

  const resetTime = String(input.reset_time ?? existing?.reset_time ?? '04:00').slice(0, 5);
  const lastResetDate =
    input.last_reset_date !== undefined
      ? input.last_reset_date || null
      : existing?.last_reset_date || null;
  const dayEndedDate =
    input.day_ended_date !== undefined
      ? input.day_ended_date || null
      : existing?.day_ended_date || null;
  const totalBountyClaimed =
    typeof input.total_bounty_claimed === 'number'
      ? input.total_bounty_claimed
      : existing?.total_bounty_claimed ?? 0;

  const rows = await sql.query(
    `INSERT INTO public.user_settings (
      user_id,
      reset_time,
      last_reset_date,
      day_ended_date,
      total_bounty_claimed,
      updated_at
    )
    VALUES ($1::uuid, $2, $3::date, $4::date, $5, timezone('utc'::text, now()))
    ON CONFLICT (user_id) DO UPDATE SET
      reset_time = EXCLUDED.reset_time,
      last_reset_date = EXCLUDED.last_reset_date,
      day_ended_date = EXCLUDED.day_ended_date,
      total_bounty_claimed = EXCLUDED.total_bounty_claimed,
      updated_at = timezone('utc'::text, now())
    RETURNING *`,
    [session.user.id, resetTime, lastResetDate, dayEndedDate, totalBountyClaimed]
  );
  return normalizeUserSettingsRow(rows[0] as Record<string, unknown> | undefined);
}

/**
 * Roll over incomplete tasks from past dates (< todayStr) to todayStr.
 */
export async function rolloverIncompleteTasks(todayStr: string): Promise<DailyTask[]> {
  const { data: session } = await auth.getSession();
  if (!session?.user?.id) {
    throw new Error('Unauthorized: No active Neon Auth session');
  }
  const sql = getNeonSql();

  const rows = await sql.query(
    `UPDATE public.daily_tasks
     SET date_assigned = $2::date
     WHERE user_id = $1::uuid
       AND completed = false
       AND date_assigned < $2::date
     RETURNING *`,
    [session.user.id, todayStr]
  );
  return rows.map((r) => normalizeDailyTask(r as Record<string, unknown>));
}

/**
 * Generate due recurring tasks for todayStr with deduplication against active incomplete tasks.
 */
export async function generateDueRecurringTasks(todayStr: string): Promise<DailyTask[]> {
  const { data: session } = await auth.getSession();
  if (!session?.user?.id) {
    throw new Error('Unauthorized: No active Neon Auth session');
  }
  const sql = getNeonSql();

  const rows = await sql.query(
    `WITH max_ord AS (
      SELECT COALESCE(MAX(order_index), 0) AS base_order
      FROM public.daily_tasks
      WHERE user_id = $1::uuid
        AND date_assigned = $2::date
    ),
    due_templates AS (
      SELECT
        r.title,
        r.notes,
        r.color,
        ROW_NUMBER() OVER (ORDER BY r.created_at ASC) AS rn
      FROM public.recurring_tasks r
      WHERE r.user_id = $1::uuid
        AND (
          r.frequency = 'daily'
          OR (r.frequency = 'weekly' AND r.day_of_week = EXTRACT(DOW FROM $2::date)::integer)
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.daily_tasks d
          WHERE d.user_id = $1::uuid
            AND d.date_assigned = $2::date
            AND lower(trim(d.title)) = lower(trim(r.title))
            AND d.completed = false
        )
    )
    INSERT INTO public.daily_tasks (
      user_id,
      title,
      notes,
      color,
      completed,
      order_index,
      date_assigned,
      is_bonus,
      bounty_started_at,
      bounty_amount
    )
    SELECT
      $1::uuid,
      dt.title,
      dt.notes,
      COALESCE(dt.color, 'default'),
      false,
      (SELECT base_order FROM max_ord) + dt.rn::integer,
      $2::date,
      false,
      timezone('utc'::text, now()),
      100
    FROM due_templates dt
    RETURNING *`,
    [session.user.id, todayStr]
  );
  return rows.map((r) => normalizeDailyTask(r as Record<string, unknown>));
}

/**
 * Fetch tasks for todayStr & tomorrowStr, along with full daily history, pool tasks, and recurring tasks.
 */
export async function getTasksForDate(todayStr: string, tomorrowStr?: string) {
  const { data: session } = await auth.getSession();
  if (!session?.user?.id) {
    throw new Error('Unauthorized: No active Neon Auth session');
  }
  const sql = getNeonSql();

  const [dailyRows, poolRows, recurringRows] = await Promise.all([
    sql.query(
      `SELECT * FROM public.daily_tasks WHERE user_id = $1::uuid ORDER BY date_assigned DESC, order_index ASC`,
      [session.user.id]
    ),
    sql.query(
      `SELECT * FROM public.pool_tasks WHERE user_id = $1::uuid ORDER BY created_at DESC`,
      [session.user.id]
    ),
    sql.query(
      `SELECT * FROM public.recurring_tasks WHERE user_id = $1::uuid ORDER BY created_at DESC`,
      [session.user.id]
    ),
  ]);

  const allDailyTasks = dailyRows.map((r) => normalizeDailyTask(r as Record<string, unknown>));
  const todayTasks = allDailyTasks
    .filter((t) => t.date_assigned === todayStr)
    .sort((a, b) => a.order_index - b.order_index);
  const tomorrowTasks = tomorrowStr
    ? allDailyTasks
        .filter((t) => t.date_assigned === tomorrowStr)
        .sort((a, b) => a.order_index - b.order_index)
    : [];
  const poolTasks = poolRows.map((r) => normalizePoolTask(r as Record<string, unknown>));
  const recurringTasks = recurringRows.map((r) =>
    normalizeRecurringTask(r as Record<string, unknown>)
  );

  return {
    todayTasks,
    tomorrowTasks,
    allDailyTasks,
    poolTasks,
    recurringTasks,
  };
}

/**
 * Create a daily task for the authenticated user.
 */
export async function createTask(input: {
  id?: string;
  title: string;
  notes?: string | null;
  color?: string | null;
  completed?: boolean;
  order_index?: number;
  date_assigned: string;
  created_at?: string;
  is_bonus?: boolean;
  bounty_started_at?: string;
  bounty_earned?: number | null;
  bounty_amount?: number | null;
  completed_at?: string | null;
}): Promise<DailyTask> {
  const { data: session } = await auth.getSession();
  if (!session?.user?.id) {
    throw new Error('Unauthorized: No active Neon Auth session');
  }
  const sql = getNeonSql();

  let orderIndex = input.order_index;
  if (typeof orderIndex !== 'number') {
    const ordRows = await sql.query(
      `SELECT COALESCE(MAX(order_index), -1) + 1 AS next_order
       FROM public.daily_tasks
       WHERE user_id = $1::uuid AND date_assigned = $2::date`,
      [session.user.id, input.date_assigned]
    );
    orderIndex = Number(ordRows[0]?.next_order ?? 0);
  }

  const nowIso = input.created_at || new Date().toISOString();
  const startedAt = input.bounty_started_at || nowIso;
  const bountyAmount =
    typeof input.bounty_amount === 'number' && input.bounty_amount > 0
      ? input.bounty_amount
      : input.is_bonus
      ? 10
      : 100;

  const rows = input.id
    ? await sql.query(
        `INSERT INTO public.daily_tasks (
          id, user_id, title, notes, color, completed, order_index, date_assigned,
          created_at, is_bonus, bounty_started_at, bounty_earned, bounty_amount, completed_at
        )
        VALUES ($2::uuid, $1::uuid, $3, $4, $5, $6, $7, $8::date, $9::timestamptz, $10, $11::timestamptz, $12, $13, $14::timestamptz)
        ON CONFLICT (id) DO UPDATE SET
          title = EXCLUDED.title,
          notes = EXCLUDED.notes,
          color = EXCLUDED.color,
          completed = EXCLUDED.completed,
          order_index = EXCLUDED.order_index,
          date_assigned = EXCLUDED.date_assigned
        RETURNING *`,
        [
          session.user.id,
          input.id,
          input.title.trim(),
          input.notes ?? null,
          input.color || 'default',
          Boolean(input.completed),
          orderIndex,
          input.date_assigned,
          nowIso,
          Boolean(input.is_bonus),
          startedAt,
          input.bounty_earned ?? null,
          bountyAmount,
          input.completed_at ?? null,
        ]
      )
    : await sql.query(
        `INSERT INTO public.daily_tasks (
          user_id, title, notes, color, completed, order_index, date_assigned,
          created_at, is_bonus, bounty_started_at, bounty_earned, bounty_amount, completed_at
        )
        VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::date, $8::timestamptz, $9, $10::timestamptz, $11, $12, $13::timestamptz)
        RETURNING *`,
        [
          session.user.id,
          input.title.trim(),
          input.notes ?? null,
          input.color || 'default',
          Boolean(input.completed),
          orderIndex,
          input.date_assigned,
          nowIso,
          Boolean(input.is_bonus),
          startedAt,
          input.bounty_earned ?? null,
          bountyAmount,
          input.completed_at ?? null,
        ]
      );

  return normalizeDailyTask(rows[0] as Record<string, unknown>);
}

/**
 * Update a daily task belonging to the authenticated user.
 */
export async function updateTask(
  id: string,
  updates: Partial<DailyTask>
): Promise<DailyTask | null> {
  const { data: session } = await auth.getSession();
  if (!session?.user?.id) {
    throw new Error('Unauthorized: No active Neon Auth session');
  }
  const sql = getNeonSql();

  const existingRows = await sql.query(
    `SELECT * FROM public.daily_tasks WHERE user_id = $1::uuid AND id = $2::uuid LIMIT 1`,
    [session.user.id, id]
  );
  if (existingRows.length === 0) return null;

  const current = normalizeDailyTask(existingRows[0] as Record<string, unknown>);
  const nextTitle = updates.title !== undefined ? String(updates.title) : current.title;
  const nextNotes =
    updates.notes !== undefined
      ? updates.notes != null
        ? String(updates.notes)
        : null
      : current.notes ?? null;
  const nextColor =
    updates.color !== undefined
      ? updates.color != null
        ? String(updates.color)
        : 'default'
      : current.color ?? 'default';
  const nextCompleted =
    updates.completed !== undefined ? Boolean(updates.completed) : current.completed;
  const nextOrderIndex =
    updates.order_index !== undefined ? Number(updates.order_index) : current.order_index;
  const nextDateAssigned =
    updates.date_assigned !== undefined ? String(updates.date_assigned) : current.date_assigned;
  const nextCreatedAt =
    updates.created_at !== undefined ? String(updates.created_at) : current.created_at;
  const nextBountyEarned =
    updates.bounty_earned !== undefined
      ? updates.bounty_earned != null
        ? Number(updates.bounty_earned)
        : null
      : current.bounty_earned ?? null;
  const nextCompletedAt =
    updates.completed_at !== undefined
      ? updates.completed_at != null
        ? String(updates.completed_at)
        : null
      : current.completed_at ?? null;

  const rows = await sql.query(
    `UPDATE public.daily_tasks
     SET
       title = $3,
       notes = $4,
       color = $5,
       completed = $6,
       order_index = $7,
       date_assigned = $8::date,
       created_at = $9::timestamptz,
       bounty_earned = $10,
       completed_at = $11::timestamptz
     WHERE user_id = $1::uuid AND id = $2::uuid
     RETURNING *`,
    [
      session.user.id,
      id,
      nextTitle,
      nextNotes,
      nextColor,
      nextCompleted,
      nextOrderIndex,
      nextDateAssigned,
      nextCreatedAt,
      nextBountyEarned,
      nextCompletedAt,
    ]
  );
  return rows[0] ? normalizeDailyTask(rows[0] as Record<string, unknown>) : null;
}

/**
 * Delete a daily task belonging to the authenticated user.
 */
export async function deleteTask(id: string): Promise<boolean> {
  const { data: session } = await auth.getSession();
  if (!session?.user?.id) {
    throw new Error('Unauthorized: No active Neon Auth session');
  }
  const sql = getNeonSql();
  await sql.query(
    `DELETE FROM public.daily_tasks WHERE user_id = $1::uuid AND id = $2::uuid`,
    [session.user.id, id]
  );
  return true;
}

/**
 * Reorder daily tasks belonging to the authenticated user.
 */
export async function reorderTasks(
  items: { id: string; order_index: number }[]
): Promise<boolean> {
  const { data: session } = await auth.getSession();
  if (!session?.user?.id) {
    throw new Error('Unauthorized: No active Neon Auth session');
  }
  const sql = getNeonSql();
  await Promise.all(
    items.map((item) =>
      sql.query(
        `UPDATE public.daily_tasks SET order_index = $3 WHERE user_id = $1::uuid AND id = $2::uuid`,
        [session.user.id, item.id, Number(item.order_index)]
      )
    )
  );
  return true;
}

/**
 * Pull one random pool task into today's daily_tasks WITHOUT deleting it from pool_tasks,
 * preserving title, notes, color, and bounty.
 */
export async function pullBonusTask(todayStr: string): Promise<DailyTask | null> {
  const { data: session } = await auth.getSession();
  if (!session?.user?.id) {
    throw new Error('Unauthorized: No active Neon Auth session');
  }
  const sql = getNeonSql();

  const poolRows = await sql.query(
    `SELECT id, title, notes, color, COALESCE(bounty_amount, 10) AS bounty_amount
     FROM public.pool_tasks
     WHERE user_id = $1::uuid
     ORDER BY random()
     LIMIT 1`,
    [session.user.id]
  );

  if (poolRows.length === 0) {
    return null;
  }

  const chosen = poolRows[0] as Record<string, unknown>;
  const ordRows = await sql.query(
    `SELECT COALESCE(MAX(order_index), 0) + 1 AS next_order
     FROM public.daily_tasks
     WHERE user_id = $1::uuid AND date_assigned = $2::date`,
    [session.user.id, todayStr]
  );
  const nextOrder = Number(ordRows[0]?.next_order ?? 1);
  const bountyVal = Number(chosen.bounty_amount ?? 10);

  const inserted = await sql.query(
    `INSERT INTO public.daily_tasks (
      user_id,
      title,
      notes,
      color,
      completed,
      order_index,
      date_assigned,
      is_bonus,
      bounty_started_at,
      bounty_amount
    )
    VALUES (
      $1::uuid,
      $2,
      $3,
      $4,
      false,
      $5,
      $6::date,
      true,
      timezone('utc'::text, now()),
      $7
    )
    RETURNING *`,
    [
      session.user.id,
      String(chosen.title),
      chosen.notes != null ? String(chosen.notes) : null,
      chosen.color != null ? String(chosen.color) : 'default',
      nextOrder,
      todayStr,
      bountyVal,
    ]
  );

  return inserted[0] ? normalizeDailyTask(inserted[0] as Record<string, unknown>) : null;
}

/**
 * Push a recurring template to today's daily_tasks (preventing duplicates).
 */
export async function pushTemplateToDaily(
  title: string,
  notes?: string | null,
  color?: string | null,
  targetDate?: string
): Promise<DailyTask | null> {
  const { data: session } = await auth.getSession();
  if (!session?.user?.id) {
    throw new Error('Unauthorized: No active Neon Auth session');
  }
  const sql = getNeonSql();
  const dateStr = targetDate || new Date().toISOString().slice(0, 10);

  const dupRows = await sql.query(
    `SELECT id
     FROM public.daily_tasks
     WHERE user_id = $1::uuid
       AND date_assigned = $2::date
       AND lower(trim(title)) = lower(trim($3))
       AND completed = false
     LIMIT 1`,
    [session.user.id, dateStr, title]
  );

  if (dupRows.length > 0) {
    return null;
  }

  const ordRows = await sql.query(
    `SELECT COALESCE(MAX(order_index), 0) + 1 AS next_order
     FROM public.daily_tasks
     WHERE user_id = $1::uuid AND date_assigned = $2::date`,
    [session.user.id, dateStr]
  );
  const nextOrder = Number(ordRows[0]?.next_order ?? 1);

  const inserted = await sql.query(
    `INSERT INTO public.daily_tasks (
      user_id,
      title,
      notes,
      color,
      completed,
      order_index,
      date_assigned,
      is_bonus,
      bounty_started_at,
      bounty_amount
    )
    VALUES (
      $1::uuid,
      $2,
      $3,
      $4,
      false,
      $5,
      $6::date,
      false,
      timezone('utc'::text, now()),
      100
    )
    RETURNING *`,
    [session.user.id, title.trim(), notes ?? null, color || 'default', nextOrder, dateStr]
  );
  return inserted[0] ? normalizeDailyTask(inserted[0] as Record<string, unknown>) : null;
}

/**
 * Move a task to a specific date (e.g., Tomorrow's Leads -> Today's Most Wanted).
 */
export async function moveTaskToDate(
  taskId: string,
  newDate: string
): Promise<DailyTask | null> {
  const { data: session } = await auth.getSession();
  if (!session?.user?.id) {
    throw new Error('Unauthorized: No active Neon Auth session');
  }
  const sql = getNeonSql();

  const ordRows = await sql.query(
    `SELECT COALESCE(MAX(order_index), 0) + 1 AS next_order
     FROM public.daily_tasks
     WHERE user_id = $1::uuid AND date_assigned = $2::date`,
    [session.user.id, newDate]
  );
  const nextOrder = Number(ordRows[0]?.next_order ?? 1);

  const rows = await sql.query(
    `UPDATE public.daily_tasks
     SET
       date_assigned = $3::date,
       order_index = $4,
       created_at = timezone('utc'::text, now()),
       bounty_started_at = timezone('utc'::text, now())
     WHERE user_id = $1::uuid AND id = $2::uuid
     RETURNING *`,
    [session.user.id, taskId, newDate, nextOrder]
  );
  return rows[0] ? normalizeDailyTask(rows[0] as Record<string, unknown>) : null;
}

/**
 * Clear all completed daily tasks for the authenticated user.
 */
export async function clearCompletedTasks(): Promise<boolean> {
  const { data: session } = await auth.getSession();
  if (!session?.user?.id) {
    throw new Error('Unauthorized: No active Neon Auth session');
  }
  const sql = getNeonSql();
  await sql.query(
    `DELETE FROM public.daily_tasks WHERE user_id = $1::uuid AND completed = true`,
    [session.user.id]
  );
  return true;
}

/**
 * Clear all daily tasks for a specific logical date (defaults to today).
 */
export async function clearAllDailyTasks(
  todayStr: string = new Date().toISOString().slice(0, 10)
): Promise<boolean> {
  const { data: session } = await auth.getSession();
  if (!session?.user?.id) {
    throw new Error('Unauthorized: No active Neon Auth session');
  }
  const sql = getNeonSql();
  await sql.query(
    `DELETE FROM public.daily_tasks WHERE user_id = $1::uuid AND date_assigned = $2::date`,
    [session.user.id, todayStr]
  );
  return true;
}

// =========================================================================
// Bonus Pool Tasks Server Actions
// =========================================================================

export async function getPoolTasks(): Promise<PoolTask[]> {
  const { data: session } = await auth.getSession();
  if (!session?.user?.id) {
    throw new Error('Unauthorized: No active Neon Auth session');
  }
  const sql = getNeonSql();
  const rows = await sql.query(
    `SELECT * FROM public.pool_tasks WHERE user_id = $1::uuid ORDER BY created_at DESC`,
    [session.user.id]
  );
  return rows.map((r) => normalizePoolTask(r as Record<string, unknown>));
}

export async function createPoolTask(input: {
  id?: string;
  title: string;
  notes?: string | null;
  color?: string | null;
  bounty_amount?: number | null;
  created_at?: string;
}): Promise<PoolTask> {
  const { data: session } = await auth.getSession();
  if (!session?.user?.id) {
    throw new Error('Unauthorized: No active Neon Auth session');
  }
  const sql = getNeonSql();
  const nowIso = input.created_at || new Date().toISOString();
  const bountyVal = typeof input.bounty_amount === 'number' ? input.bounty_amount : 10;

  const rows = input.id
    ? await sql.query(
        `INSERT INTO public.pool_tasks (id, user_id, title, notes, color, bounty_amount, created_at)
         VALUES ($2::uuid, $1::uuid, $3, $4, $5, $6, $7::timestamptz)
         RETURNING *`,
        [
          session.user.id,
          input.id,
          input.title.trim(),
          input.notes ?? null,
          input.color || 'default',
          bountyVal,
          nowIso,
        ]
      )
    : await sql.query(
        `INSERT INTO public.pool_tasks (user_id, title, notes, color, bounty_amount, created_at)
         VALUES ($1::uuid, $2, $3, $4, $5, $6::timestamptz)
         RETURNING *`,
        [
          session.user.id,
          input.title.trim(),
          input.notes ?? null,
          input.color || 'default',
          bountyVal,
          nowIso,
        ]
      );
  return normalizePoolTask(rows[0] as Record<string, unknown>);
}

export async function deletePoolTask(id: string): Promise<boolean> {
  const { data: session } = await auth.getSession();
  if (!session?.user?.id) {
    throw new Error('Unauthorized: No active Neon Auth session');
  }
  const sql = getNeonSql();
  await sql.query(
    `DELETE FROM public.pool_tasks WHERE user_id = $1::uuid AND id = $2::uuid`,
    [session.user.id, id]
  );
  return true;
}

// =========================================================================
// Recurring Tasks Server Actions
// =========================================================================

export async function getRecurringTasks(): Promise<RecurringTask[]> {
  const { data: session } = await auth.getSession();
  if (!session?.user?.id) {
    throw new Error('Unauthorized: No active Neon Auth session');
  }
  const sql = getNeonSql();
  const rows = await sql.query(
    `SELECT * FROM public.recurring_tasks WHERE user_id = $1::uuid ORDER BY created_at DESC`,
    [session.user.id]
  );
  return rows.map((r) => normalizeRecurringTask(r as Record<string, unknown>));
}

export async function createRecurringTask(input: {
  id?: string;
  title: string;
  notes?: string | null;
  color?: string | null;
  frequency: 'daily' | 'weekly';
  day_of_week?: number;
  created_at?: string;
}): Promise<RecurringTask> {
  const { data: session } = await auth.getSession();
  if (!session?.user?.id) {
    throw new Error('Unauthorized: No active Neon Auth session');
  }
  const sql = getNeonSql();
  const nowIso = input.created_at || new Date().toISOString();
  const dow = input.frequency === 'weekly' ? Number(input.day_of_week ?? 1) : null;

  const rows = input.id
    ? await sql.query(
        `INSERT INTO public.recurring_tasks (
          id, user_id, title, notes, color, frequency, day_of_week, created_at
        )
        VALUES ($2::uuid, $1::uuid, $3, $4, $5, $6, $7, $8::timestamptz)
        RETURNING *`,
        [
          session.user.id,
          input.id,
          input.title.trim(),
          input.notes ?? null,
          input.color || 'default',
          input.frequency,
          dow,
          nowIso,
        ]
      )
    : await sql.query(
        `INSERT INTO public.recurring_tasks (
          user_id, title, notes, color, frequency, day_of_week, created_at
        )
        VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::timestamptz)
        RETURNING *`,
        [
          session.user.id,
          input.title.trim(),
          input.notes ?? null,
          input.color || 'default',
          input.frequency,
          dow,
          nowIso,
        ]
      );
  return normalizeRecurringTask(rows[0] as Record<string, unknown>);
}

export async function updateRecurringTask(
  id: string,
  updates: Partial<RecurringTask>
): Promise<RecurringTask | null> {
  const { data: session } = await auth.getSession();
  if (!session?.user?.id) {
    throw new Error('Unauthorized: No active Neon Auth session');
  }
  const sql = getNeonSql();

  const existingRows = await sql.query(
    `SELECT * FROM public.recurring_tasks WHERE user_id = $1::uuid AND id = $2::uuid LIMIT 1`,
    [session.user.id, id]
  );
  if (existingRows.length === 0) return null;

  const current = normalizeRecurringTask(existingRows[0] as Record<string, unknown>);
  const nextTitle = updates.title !== undefined ? String(updates.title) : current.title;
  const nextNotes =
    updates.notes !== undefined
      ? updates.notes != null
        ? String(updates.notes)
        : null
      : current.notes ?? null;
  const nextColor =
    updates.color !== undefined
      ? updates.color != null
        ? String(updates.color)
        : 'default'
      : current.color ?? 'default';
  const nextFrequency =
    updates.frequency !== undefined
      ? updates.frequency === 'weekly'
        ? 'weekly'
        : 'daily'
      : current.frequency;
  const nextDayOfWeek =
    nextFrequency === 'weekly'
      ? updates.day_of_week !== undefined
        ? Number(updates.day_of_week)
        : Number(current.day_of_week ?? 1)
      : null;

  const rows = await sql.query(
    `UPDATE public.recurring_tasks
     SET
       title = $3,
       notes = $4,
       color = $5,
       frequency = $6,
       day_of_week = $7
     WHERE user_id = $1::uuid AND id = $2::uuid
     RETURNING *`,
    [session.user.id, id, nextTitle, nextNotes, nextColor, nextFrequency, nextDayOfWeek]
  );
  return rows[0] ? normalizeRecurringTask(rows[0] as Record<string, unknown>) : null;
}

export async function deleteRecurringTask(id: string): Promise<boolean> {
  const { data: session } = await auth.getSession();
  if (!session?.user?.id) {
    throw new Error('Unauthorized: No active Neon Auth session');
  }
  const sql = getNeonSql();
  await sql.query(
    `DELETE FROM public.recurring_tasks WHERE user_id = $1::uuid AND id = $2::uuid`,
    [session.user.id, id]
  );
  return true;
}
