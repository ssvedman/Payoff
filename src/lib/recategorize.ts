import { supabase } from './supabase'
import { ruleTextFor } from './categorize'
import type { Bucket, MerchantRuleRow, TransactionRow } from './database.types'
import type { Transaction } from './data'

/**
 * Recategorizing a transaction — the one place it happens.
 *
 * Lives here rather than on a page because two screens now offer it, and this
 * codebase has already been bitten twice by the same rule existing in two files
 * and drifting apart.
 *
 * SCOPE is the caller's decision, and it is a real decision:
 *
 *   'once'   — this row only. Nothing is learned. For a charge that is genuinely
 *              a one-off, or a merchant whose charges are not all alike: a
 *              payment processor billing for a dozen unrelated sellers, a shop
 *              used for both business and personal.
 *
 *   'vendor' — a rule, so every future charge from that merchant lands the same
 *              way, and everything already loaded that matches is corrected too.
 *
 * Both write bucket_source 'manual' on the row that was tapped, so nothing
 * recomputes a decision a person made.
 */
export type Scope = 'once' | 'vendor'

/** What a rule would be keyed on, so a caller can show it before committing. */
export function vendorKeyFor(t: { name: string; merchant_name?: string | null }): string {
  return ruleTextFor(t)
}

export function matchesVendorKey(t: Transaction, key: string): boolean {
  if (!key) return false
  return `${t.name ?? ''} ${t.merchant_name ?? ''}`.toLowerCase().includes(key)
}

export interface RecategorizeArgs {
  transaction: Transaction
  bucket: Bucket
  /**
   * Three-valued on purpose. undefined leaves the line alone, null clears it, a
   * string sets it. An earlier version wrote `lineId ?? null`, so re-tapping the
   * bucket a transaction was already in silently erased its budget line —
   * changing a label destroyed data nobody had touched.
   */
  lineId?: string | null
  scope: Scope
  userId?: string | null
  /** Rows already on screen, so a vendor rule can correct them in one call. */
  loaded?: Transaction[]
}

export async function recategorize({
  transaction,
  bucket,
  lineId,
  scope,
  userId,
  loaded = [],
}: RecategorizeArgs): Promise<void> {
  const linePatch = lineId === undefined ? {} : { budget_line_id: lineId }
  const key = scope === 'vendor' ? vendorKeyFor(transaction) : ''

  // 1. The rule, when one was asked for. Checked against the generated Insert
  //    shape — no casts, so a renamed column fails the build rather than the write.
  if (key) {
    const rule: Partial<MerchantRuleRow> = {
      match_text: key,
      bucket,
      // A rule pins the line too, so correcting one coffee shop teaches every
      // future one rather than just this row.
      ...linePatch,
      created_by: userId ?? null,
    }
    const { error } = await supabase
      .from('merchant_rules')
      .upsert(rule, { onConflict: 'match_text' })
    if (error) throw error
  }

  // 2. The row that was tapped, marked manual so nothing recomputes it.
  const manual: Partial<TransactionRow> = {
    bucket,
    bucket_source: 'manual',
    ...linePatch,
  }
  const { error: txError } = await supabase
    .from('transactions')
    .update(manual)
    .eq('id', transaction.id)
  if (txError) throw txError

  // 3. Everything else already loaded that the rule covers. Rows somebody set by
  //    hand are left alone — a rule never overrides a person.
  if (key) {
    const ids = loaded
      .filter((o) => o.id !== transaction.id && o.bucket_source !== 'manual' && matchesVendorKey(o, key))
      .map((o) => o.id)

    if (ids.length > 0) {
      const byRule: Partial<TransactionRow> = { bucket, bucket_source: 'rule', ...linePatch }
      const { error } = await supabase.from('transactions').update(byRule).in('id', ids)
      if (error) throw error
    }
  }
}
