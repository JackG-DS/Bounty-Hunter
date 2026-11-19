import { NextRequest, NextResponse } from 'next/server';
import {
  getSql,
  normalizeDailyTask,
  normalizePoolTask,
  normalizeRecurringTask,
  normalizeUserSettingsRow,
} from '@/lib/db';
import { getAuthenticatedUser } from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

/**
 * GET /api/tasks?today=YYYY-MM-DD
 * Performs logical-day rollover & recurring task generation in Neon Postgres,
 * then returns the authenticated user's settings, daily_tasks, pool_tasks, and recurring_tasks.
 */
export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const sql = getSql();
    const { searchParams } = new URL(request.url);
    const requestedToday = searchParams.get('today');

    // 1. Fetch user_settings first
    const settingsRows = await sql`
      SELECT *
      FROM public.user_settings
      WHERE user_id = ${user.id}::uuid
      LIMIT 1
    `;
    const userSettings = normalizeUserSettingsRow(settingsRows[0] as Record<string, unknown> | undefined);

    const localToday =
      requestedToday && /^\d{4}-\d{2}-\d{2}$/.test(requestedToday)
        ? requestedToday
        : new Date().toISOString().slice(0, 10);

    // 2. Roll over incomplete tasks from past days to localToday
    try {
      await sql`SELECT * FROM public.rollover_incomplete_tasks(${user.id}::uuid, ${localToday}::date)`;
    } catch (rolloverErr) {
      console.warn('[API /api/tasks] rollover_incomplete_tasks warning:', rolloverErr);
    }

    // 3. Generate due recurring tasks for localToday
    try {
      await sql`SELECT * FROM public.generate_due_recurring_tasks(${user.id}::uuid, ${localToday}::date)`;
    } catch (recurringErr) {
      console.warn('[API /api/tasks] generate_due_recurring_tasks warning:', recurringErr);
    }

    // 4. Fetch all daily_tasks, pool_tasks, and recurring_tasks in parallel
    const [dailyRows, poolRows, recurringRows] = await Promise.all([
      sql`
        SELECT *
        FROM public.daily_tasks
        WHERE user_id = ${user.id}::uuid
        ORDER BY date_assigned DESC, order_index ASC
      `,
      sql`
        SELECT *
        FROM public.pool_tasks
        WHERE user_id = ${user.id}::uuid
        ORDER BY created_at DESC
      `,
      sql`
        SELECT *
        FROM public.recurring_tasks
        WHERE user_id = ${user.id}::uuid
        ORDER BY created_at DESC
      `,
    ]);

    return NextResponse.json({
      userSettings,
      dailyTasks: dailyRows.map((r) => normalizeDailyTask(r as Record<string, unknown>)),
      poolTasks: poolRows.map((r) => normalizePoolTask(r as Record<string, unknown>)),
      recurringTasks: recurringRows.map((r) => normalizeRecurringTask(r as Record<string, unknown>)),
    });
  } catch (err: unknown) {
    console.error('[API GET /api/tasks] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to fetch tasks from Neon Postgres' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/tasks
 * Executes authenticated mutations & RPC helpers against Neon Postgres.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const sql = getSql();
    const body = await request.json();
    const action = body?.action as string;

    switch (action) {
      case 'upsert_settings': {
        const resetTime = String(body.reset_time || '04:00').slice(0, 5);
        const lastResetDate = body.last_reset_date || null;
        const dayEndedDate = body.day_ended_date || null;
        const rows = await sql`
          INSERT INTO public.user_settings (user_id, reset_time, last_reset_date, day_ended_date, updated_at)
          VALUES (
            ${user.id}::uuid,
            ${resetTime},
            ${lastResetDate ? `${lastResetDate}` : null}::date,
            ${dayEndedDate ? `${dayEndedDate}` : null}::date,
            timezone('utc'::text, now())
          )
          ON CONFLICT (user_id) DO UPDATE SET
            reset_time = EXCLUDED.reset_time,
            last_reset_date = EXCLUDED.last_reset_date,
            day_ended_date = EXCLUDED.day_ended_date,
            updated_at = timezone('utc'::text, now())
          RETURNING *
        `;
        return NextResponse.json({
          data: normalizeUserSettingsRow(rows[0] as Record<string, unknown> | undefined),
        });
      }

      case 'insert_daily': {
        const t = body.task;
        const rows = await sql`
          INSERT INTO public.daily_tasks (
            id, user_id, title, notes, color, completed, order_index, date_assigned,
            created_at, is_bonus, bounty_started_at, bounty_earned, bounty_amount, completed_at
          )
          VALUES (
            ${t.id}::uuid,
            ${user.id}::uuid,
            ${t.title},
            ${t.notes ?? null},
            ${t.color ?? 'default'},
            ${Boolean(t.completed)},
            ${Number(t.order_index ?? 0)},
            ${t.date_assigned}::date,
            ${t.created_at || new Date().toISOString()}::timestamptz,
            ${Boolean(t.is_bonus)},
            ${t.bounty_started_at || t.created_at || new Date().toISOString()}::timestamptz,
            ${t.bounty_earned ?? null},
            ${t.bounty_amount ?? 100},
            ${t.completed_at ?? null}::timestamptz
          )
          ON CONFLICT (id) DO UPDATE SET
            title = EXCLUDED.title,
            notes = EXCLUDED.notes,
            color = EXCLUDED.color,
            completed = EXCLUDED.completed,
            order_index = EXCLUDED.order_index,
            date_assigned = EXCLUDED.date_assigned
          RETURNING *
        `;
        return NextResponse.json({
          data: rows[0] ? normalizeDailyTask(rows[0] as Record<string, unknown>) : null,
        });
      }

      case 'update_daily': {
        const id = String(body.id);
        const updates = (body.updates || {}) as Record<string, unknown>;
        const existingRows = await sql`
          SELECT * FROM public.daily_tasks WHERE id = ${id}::uuid AND user_id = ${user.id}::uuid LIMIT 1
        `;
        if (existingRows.length === 0) {
          return NextResponse.json({ error: 'Task not found' }, { status: 404 });
        }
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

        const rows = await sql`
          UPDATE public.daily_tasks
          SET
            title = ${nextTitle},
            notes = ${nextNotes},
            color = ${nextColor},
            completed = ${nextCompleted},
            order_index = ${nextOrderIndex},
            date_assigned = ${nextDateAssigned}::date,
            created_at = ${nextCreatedAt}::timestamptz,
            bounty_earned = ${nextBountyEarned},
            completed_at = ${nextCompletedAt}::timestamptz
          WHERE id = ${id}::uuid AND user_id = ${user.id}::uuid
          RETURNING *
        `;
        return NextResponse.json({
          data: rows[0] ? normalizeDailyTask(rows[0] as Record<string, unknown>) : null,
        });
      }

      case 'reorder_daily': {
        const items = Array.isArray(body.items) ? body.items : [];
        await Promise.all(
          items.map((item: { id: string; order_index: number }) =>
            sql`
              UPDATE public.daily_tasks
              SET order_index = ${Number(item.order_index)}
              WHERE id = ${item.id}::uuid AND user_id = ${user.id}::uuid
            `
          )
        );
        return NextResponse.json({ success: true });
      }

      case 'delete_daily': {
        const id = String(body.id);
        await sql`DELETE FROM public.daily_tasks WHERE id = ${id}::uuid AND user_id = ${user.id}::uuid`;
        return NextResponse.json({ success: true });
      }

      case 'clear_all_daily': {
        const today = body.p_today || new Date().toISOString().slice(0, 10);
        await sql`SELECT public.clear_all_daily_tasks(${user.id}::uuid, ${today}::date)`;
        return NextResponse.json({ success: true });
      }

      case 'clear_completed': {
        await sql`SELECT public.clear_completed_tasks(${user.id}::uuid)`;
        return NextResponse.json({ success: true });
      }

      case 'rollover_incomplete_tasks': {
        const today = body.p_today || new Date().toISOString().slice(0, 10);
        const rows = await sql`
          SELECT * FROM public.rollover_incomplete_tasks(${user.id}::uuid, ${today}::date)
        `;
        return NextResponse.json({
          data: rows.map((r) => normalizeDailyTask(r as Record<string, unknown>)),
        });
      }

      case 'generate_due_recurring_tasks': {
        const today = body.p_today || new Date().toISOString().slice(0, 10);
        const rows = await sql`
          SELECT * FROM public.generate_due_recurring_tasks(${user.id}::uuid, ${today}::date)
        `;
        return NextResponse.json({
          data: rows.map((r) => normalizeDailyTask(r as Record<string, unknown>)),
        });
      }

      case 'pull_bonus_task': {
        const today = body.p_today || new Date().toISOString().slice(0, 10);
        const rows = await sql`
          SELECT * FROM public.pull_bonus_task(${user.id}::uuid, ${today}::date)
        `;
        const row = rows[0] as Record<string, unknown> | undefined;
        if (!row || !row.id) {
          return NextResponse.json({ data: null });
        }
        return NextResponse.json({ data: normalizeDailyTask(row) });
      }

      case 'push_template_to_daily': {
        const title = String(body.p_title || '');
        const notes = body.p_notes ?? null;
        const color = body.p_color ?? 'default';
        const targetDate = body.p_target_date || new Date().toISOString().slice(0, 10);
        const rows = await sql`
          SELECT * FROM public.push_template_to_daily(
            ${user.id}::uuid,
            ${title},
            ${notes},
            ${color},
            ${targetDate}::date
          )
        `;
        const row = rows[0] as Record<string, unknown> | undefined;
        if (!row || !row.id) {
          return NextResponse.json({ data: null });
        }
        return NextResponse.json({ data: normalizeDailyTask(row) });
      }

      case 'move_task_to_date': {
        const taskId = String(body.p_task_id);
        const newDate = body.p_new_date || new Date().toISOString().slice(0, 10);
        const rows = await sql`
          SELECT * FROM public.move_task_to_date(
            ${user.id}::uuid,
            ${taskId}::uuid,
            ${newDate}::date
          )
        `;
        const row = rows[0] as Record<string, unknown> | undefined;
        if (!row || !row.id) {
          return NextResponse.json({ data: null });
        }
        return NextResponse.json({ data: normalizeDailyTask(row) });
      }

      case 'insert_pool': {
        const p = body.task;
        const rows = await sql`
          INSERT INTO public.pool_tasks (id, user_id, title, notes, color, created_at)
          VALUES (
            ${p.id}::uuid,
            ${user.id}::uuid,
            ${p.title},
            ${p.notes ?? null},
            ${p.color ?? 'default'},
            ${p.created_at || new Date().toISOString()}::timestamptz
          )
          RETURNING *
        `;
        return NextResponse.json({
          data: rows[0] ? normalizePoolTask(rows[0] as Record<string, unknown>) : null,
        });
      }

      case 'delete_pool': {
        const id = String(body.id);
        await sql`DELETE FROM public.pool_tasks WHERE id = ${id}::uuid AND user_id = ${user.id}::uuid`;
        return NextResponse.json({ success: true });
      }

      case 'insert_recurring': {
        const r = body.task;
        const rows = await sql`
          INSERT INTO public.recurring_tasks (id, user_id, title, notes, color, frequency, day_of_week, created_at)
          VALUES (
            ${r.id}::uuid,
            ${user.id}::uuid,
            ${r.title},
            ${r.notes ?? null},
            ${r.color ?? 'default'},
            ${r.frequency === 'weekly' ? 'weekly' : 'daily'},
            ${r.frequency === 'weekly' ? Number(r.day_of_week ?? 1) : null},
            ${r.created_at || new Date().toISOString()}::timestamptz
          )
          RETURNING *
        `;
        return NextResponse.json({
          data: rows[0] ? normalizeRecurringTask(rows[0] as Record<string, unknown>) : null,
        });
      }

      case 'update_recurring': {
        const id = String(body.id);
        const updates = (body.updates || {}) as Record<string, unknown>;
        const existingRows = await sql`
          SELECT * FROM public.recurring_tasks WHERE id = ${id}::uuid AND user_id = ${user.id}::uuid LIMIT 1
        `;
        if (existingRows.length === 0) {
          return NextResponse.json({ error: 'Recurring task not found' }, { status: 404 });
        }
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

        const rows = await sql`
          UPDATE public.recurring_tasks
          SET
            title = ${nextTitle},
            notes = ${nextNotes},
            color = ${nextColor},
            frequency = ${nextFrequency},
            day_of_week = ${nextDayOfWeek}
          WHERE id = ${id}::uuid AND user_id = ${user.id}::uuid
          RETURNING *
        `;
        return NextResponse.json({
          data: rows[0] ? normalizeRecurringTask(rows[0] as Record<string, unknown>) : null,
        });
      }

      case 'delete_recurring': {
        const id = String(body.id);
        await sql`DELETE FROM public.recurring_tasks WHERE id = ${id}::uuid AND user_id = ${user.id}::uuid`;
        return NextResponse.json({ success: true });
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (err: unknown) {
    console.error('[API POST /api/tasks] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Neon Postgres mutation failed' },
      { status: 500 }
    );
  }
}
