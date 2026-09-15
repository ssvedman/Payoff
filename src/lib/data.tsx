import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { supabase } from './supabase'
import { useAuth } from './auth'
import { isoDate } from './format'
import { currentTarget, inAvalancheOrder, simulate, type SimDebt } from './avalanche'
import type {
  AccountRow,
  BudgetLineRow,
  MerchantRuleRow,
  NotificationPrefRow,
  TransactionRow,
  Bucket,
} from './database.types'

/** PostgREST can serialise numeric as a string. Coerce everywhere, once. */
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0))
const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v)

export interface Account extends Omit<AccountRow, 'apr' | 'minimum_payment' | 'opening_balance'> {
  apr: number | null
  minimum_payment: number
  opening_balance: number
  /** Latest snapshot balance. Falls back to opening_balance when none exists. */
  balance: number
  /** The snapshot before the latest, for "balance rose" reporting. null when there is only one. */
  previousBalance: number | null
  balanceAsOf: string | null
  balanceSource: string | null
  enteredBy: string | null
  balanceUpdatedAt: string | null
}

export interface Transaction extends Omit<TransactionRow, 'amount'> {
  amount: number
}

export interface BudgetLine extends Omit<BudgetLineRow, 'monthly_target'> {
  monthly_target: number
}

/**
 * The single definition of "cleared", shared by the queue, the current target and
 * the avalanche simulation. Divergent predicates here produced a struck-through
 * account that was still the active target.
 */
export function isCleared(a: Pick<Account, 'balance' | 'cleared_at'>): boolean {
  return a.balance <= 0 || a.cleared_at !== null
}

export interface PlanSettings {
  attack_fund: number
  monthly_savings: number
  deposit_target: number
  plan_started_on: string
}

/** How far one debt has come against the highest balance ever recorded for it. */
export interface AccountProgress {
  account_id: string
  current_balance: number
  peak_balance: number
  paid_off: number
  pct_paid: number
}

interface DataState {
  loading: boolean
  error: string | null
  accounts: Account[]
  /** The nine debts, avalanche-ordered. Excludes savings. */
  debts: Account[]
  savings: Account | null
  /** Checking accounts — spending sources, never part of the payoff queue. */
  checking: Account[]
  transactions: Transaction[]
  budgetLines: BudgetLine[]
  plan: PlanSettings | null
  rules: MerchantRuleRow[]
  prefs: NotificationPrefRow[]
  memberNames: Record<string, string>
  /** Keyed by account id. Absent for an account with nothing recorded yet. */
  progress: Record<string, AccountProgress>
  lastSyncedAt: string | null
  refresh: () => Promise<void>
}

const DataContext = createContext<DataState | null>(null)

/** First day of the current month, as YYYY-MM-DD. */
export function monthStart(d = new Date()): string {
  return isoDate(new Date(d.getFullYear(), d.getMonth(), 1))
}

/** Last day of the current month, as YYYY-MM-DD. */
export function monthEnd(d = new Date()): string {
  return isoDate(new Date(d.getFullYear(), d.getMonth() + 1, 0))
}

export function DataProvider({ children }: { children: ReactNode }) {
  const { isMember, user } = useAuth()
  const [state, setState] = useState<Omit<DataState, 'refresh'>>({
    loading: true,
    error: null,
    accounts: [],
    debts: [],
    savings: null,
    checking: [],
    transactions: [],
    budgetLines: [],
    plan: null,
    rules: [],
    prefs: [],
    memberNames: {},
    progress: {},
    lastSyncedAt: null,
  })

  const load = useCallback(async () => {
    if (!isMember) {
      setState((s) => ({ ...s, loading: false }))
      return
    }

    setState((s) => ({ ...s, loading: true, error: null }))

    const [
      accountsRes,
      balancesRes,
      txnRes,
      budgetRes,
      planRes,
      rulesRes,
      prefsRes,
      membersRes,
      itemsRes,
      acctProgRes,
    ] = await Promise.all([
      supabase.from('accounts').select('*').order('payoff_order'),
      supabase.from('account_balance_current').select('*'),
      supabase
        .from('transactions')
        .select('*')
        .gte('posted_on', monthStart())
        .lte('posted_on', monthEnd())
        .order('posted_on', { ascending: false }),
      supabase.from('budget_lines').select('*').order('sort_order'),
      supabase.from('plan_settings').select('*').eq('id', 1).maybeSingle(),
      supabase.from('merchant_rules').select('*'),
      user
        ? supabase.from('notification_prefs').select('*').eq('user_id', user.id)
        : Promise.resolve({ data: [], error: null }),
      supabase.from('household_members').select('user_id, display_name'),
      supabase.from('plaid_items').select('last_synced'),
      supabase.from('account_progress').select('*'),
    ])

    const firstError =
      accountsRes.error ?? balancesRes.error ?? txnRes.error ?? budgetRes.error ?? planRes.error

    if (firstError) {
      setState((s) => ({ ...s, loading: false, error: firstError.message }))
      return
    }

    const balanceByAccount = new Map(
      (balancesRes.data ?? []).map((b: Record<string, unknown>) => [b.account_id as string, b]),
    )

    const accounts: Account[] = (accountsRes.data ?? []).map((a: Record<string, unknown>) => {
      const bal = balanceByAccount.get(a.id as string)
      return {
        ...(a as unknown as AccountRow),
        apr: numOrNull(a.apr),
        minimum_payment: num(a.minimum_payment),
        opening_balance: num(a.opening_balance),
        balance: bal ? num(bal.balance) : num(a.opening_balance),
        previousBalance: bal ? numOrNull(bal.prev_balance) : null,
        balanceAsOf: (bal?.as_of as string) ?? null,
        balanceSource: (bal?.source as string) ?? null,
        enteredBy: (bal?.entered_by as string) ?? null,
        balanceUpdatedAt: (bal?.created_at as string) ?? null,
      }
    })

    const debts = inAvalancheOrder(
      accounts
        .filter((a) => a.kind !== 'savings' && a.kind !== 'checking')
        .map((a) => ({ ...a, payoffOrder: a.payoff_order })),
    ) as Account[]

    const memberNames: Record<string, string> = {}
    for (const m of membersRes.data ?? []) {
      memberNames[(m as { user_id: string }).user_id] = (m as { display_name: string }).display_name
    }

    const lastSyncedAt = (itemsRes.data ?? [])
      .map((i) => (i as { last_synced: string | null }).last_synced)
      .filter(Boolean)
      .sort()
      .pop() as string | null

    setState({
      loading: false,
      error: null,
      accounts,
      debts,
      savings: accounts.find((a) => a.kind === 'savings') ?? null,
      checking: accounts.filter((a) => a.kind === 'checking'),
      transactions: (txnRes.data ?? []).map((t: Record<string, unknown>) => ({
        ...(t as unknown as TransactionRow),
        amount: num(t.amount),
      })),
      budgetLines: (budgetRes.data ?? []).map((b: Record<string, unknown>) => ({
        ...(b as unknown as BudgetLineRow),
        monthly_target: num(b.monthly_target),
      })),
      plan: planRes.data
        ? {
            attack_fund: num((planRes.data as Record<string, unknown>).attack_fund),
            monthly_savings: num((planRes.data as Record<string, unknown>).monthly_savings),
            deposit_target: num((planRes.data as Record<string, unknown>).deposit_target),
            plan_started_on: (planRes.data as Record<string, unknown>).plan_started_on as string,
          }
        : null,
      rules: (rulesRes.data ?? []) as MerchantRuleRow[],
      prefs: (prefsRes.data ?? []) as NotificationPrefRow[],
      memberNames,
      // numeric comes back from PostgREST as a string; coerce at the boundary so
      // nothing downstream ever concatenates where it meant to add.
      progress: Object.fromEntries(
        (acctProgRes.data ?? []).map((r: Record<string, unknown>) => [
          r.account_id as string,
          {
            account_id: r.account_id as string,
            current_balance: num(r.current_balance),
            peak_balance: num(r.peak_balance),
            paid_off: num(r.paid_off),
            pct_paid: num(r.pct_paid),
          } satisfies AccountProgress,
        ]),
      ),
      lastSyncedAt: lastSyncedAt ?? null,
    })
  }, [isMember, user])

  useEffect(() => {
    void load()
  }, [load])

  const value = useMemo<DataState>(() => ({ ...state, refresh: load }), [state, load])

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>
}

export function useData(): DataState {
  const ctx = useContext(DataContext)
  if (!ctx) throw new Error('useData must be used inside DataProvider')
  return ctx
}

/** Everything the home screen derives from the raw rows. */
export function usePayoffPlan() {
  const { debts, plan, savings } = useData()

  return useMemo(() => {
    if (!plan) return null

    const open = debts.filter((d) => !isCleared(d))
    const totalOwed = open.reduce((s, d) => s + d.balance, 0)
    const openingTotal = debts.reduce((s, d) => s + d.opening_balance, 0)
    const cleared = Math.max(0, openingTotal - totalOwed)

    // Pass EVERY debt, cleared ones included with a zero balance — not just the
    // open ones. simulate() derives its constant monthly pool from the minimums of
    // whatever it is given, and then works only on those with a balance. Passing
    // just the open debts drops each cleared account's minimum out of the pool, so
    // the projection gets LONGER every time something is paid off, which is the
    // exact opposite of the avalanche rule that a cleared payment rolls into the
    // next account. Clearing a single account shrank the pool by its own minimum.
    const simDebts: SimDebt[] = debts.map((d) => ({
      id: d.id,
      name: d.name,
      apr: d.apr,
      minimumPayment: d.minimum_payment,
      payoffOrder: d.payoff_order,
      balance: isCleared(d) ? 0 : d.balance,
    }))

    const sim = simulate(simDebts, plan.attack_fund)
    const target = currentTarget(
      debts.filter((d) => !isCleared(d)).map((d) => ({ ...d, payoffOrder: d.payoff_order })),
    ) as (Account & { payoffOrder: number }) | null

    return {
      totalOwed,
      openingTotal,
      cleared,
      progress: openingTotal > 0 ? cleared / openingTotal : 0,
      target,
      sim,
      savingsBalance: savings?.balance ?? 0,
      depositTarget: plan.deposit_target,
      monthlySavings: plan.monthly_savings,
      savingsRemaining: Math.max(0, plan.deposit_target - (savings?.balance ?? 0)),
      attackFund: plan.attack_fund,
      planStartedOn: plan.plan_started_on,
    }
  }, [debts, plan, savings])
}

/** Spend per bucket for the current month. Money out is positive. */
export function useMonthTotals() {
  const { transactions, budgetLines } = useData()

  return useMemo(() => {
    const spent: Record<string, number> = {}
    for (const t of transactions) {
      spent[t.bucket] = (spent[t.bucket] ?? 0) + t.amount
    }

    const targets: Record<string, number> = {}
    for (const line of budgetLines) {
      targets[line.bucket] = (targets[line.bucket] ?? 0) + line.monthly_target
    }

    // income is stored negative (money in), so flip it for display
    const income = -(spent.income ?? 0)

    return {
      spent,
      targets,
      income,
      bucketSpent: (b: Bucket) => spent[b] ?? 0,
      bucketTarget: (b: string) => targets[b] ?? 0,
    }
  }, [transactions, budgetLines])
}
