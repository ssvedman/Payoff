/**
 * Recurring overrides — the I/O half.
 *
 * The rules live in recurringRules.ts and are re-exported here, so every existing
 * import of this module keeps working and a test can reach the pure half without
 * pulling in the supabase client.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from './supabase'
import type { Direction } from './cadence'
import { toOverride, type ConfirmCadence, type Override } from './recurringRules'

export * from './recurringRules'

/* ------------------------------------------------------------------ *
 * I/O
 * ------------------------------------------------------------------ */

export interface RecurringOverridesView {
  overrides: Override[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  dismiss: (input: DismissInput) => Promise<string | null>
  confirm: (input: ConfirmInput) => Promise<string | null>
  remove: (seriesKey: string) => Promise<string | null>
}

export interface DismissInput {
  seriesKey: string
  accountId: string | null
  descriptor: string
  label: string
  direction: Direction
  /** The last date the series was seen. Anything after it is a return. */
  lastOn: string
}

export interface ConfirmInput {
  seriesKey: string
  accountId: string | null
  descriptor: string
  label: string
  direction: Direction
  cadence: ConfirmCadence
  expectedAmount: number
  anchorOn: string
}

export function useRecurringOverrides(): RecurringOverridesView {
  const [overrides, setOverrides] = useState<Override[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    const res = await supabase.from('recurring_overrides').select('*')
    // An empty table and a failed read are different statements. Reporting the
    // failure as "nothing dismissed" would quietly resurrect every dismissal.
    if (res.error) {
      setError(res.error.message)
      setLoading(false)
      return
    }
    setError(null)
    setOverrides((res.data ?? []).map((r) => toOverride(r as Record<string, unknown>)))
    setLoading(false)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const write = useCallback(
    async (row: Record<string, unknown>): Promise<string | null> => {
      // onConflict on series_key: re-dismissing updates the standing instruction
      // rather than stacking a second one the unique index would reject.
      const res = await supabase
        .from('recurring_overrides')
        .upsert(row as never, { onConflict: 'series_key' })
      if (res.error) return res.error.message
      await refresh()
      return null
    },
    [refresh],
  )

  const dismiss = useCallback(
    (i: DismissInput) =>
      write({
        series_key: i.seriesKey,
        account_id: i.accountId,
        descriptor: i.descriptor,
        label: i.label,
        direction: i.direction,
        action: 'dismiss',
        dismissed_after: i.lastOn,
        cadence: null,
        expected_amount: null,
        anchor_on: null,
        updated_at: new Date().toISOString(),
      }),
    [write],
  )

  const confirm = useCallback(
    (i: ConfirmInput) =>
      write({
        series_key: i.seriesKey,
        account_id: i.accountId,
        descriptor: i.descriptor,
        label: i.label,
        direction: i.direction,
        action: 'confirm',
        dismissed_after: null,
        cadence: i.cadence,
        expected_amount: i.expectedAmount,
        anchor_on: i.anchorOn,
        updated_at: new Date().toISOString(),
      }),
    [write],
  )

  const remove = useCallback(
    async (seriesKey: string): Promise<string | null> => {
      const res = await supabase.from('recurring_overrides').delete().eq('series_key', seriesKey)
      if (res.error) return res.error.message
      await refresh()
      return null
    },
    [refresh],
  )

  return useMemo(
    () => ({ overrides, loading, error, refresh, dismiss, confirm, remove }),
    [overrides, loading, error, refresh, dismiss, confirm, remove],
  )
}
