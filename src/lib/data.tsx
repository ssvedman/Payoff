import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { supabase } from './supabase'
import { useAuth } from './auth'
import { isoDate } from './format'
import {
  currentTarget,
  inAvalancheOrder,
  monthlyPool,
  round2,
  simulate,
  simulateMinimumsOnly,
  type SimDebt,
} from './avalanche'
import type {
  AccountRow,
  AssetRow,
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

/** numeric arrives as the string "31000.00"; coerce at the boundary. */
export interface Asset extends Omit<AssetRow, 'estimated_value'> {
  estimated_value: number
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

/**
 * Is this row the business's money?
 *
 * There is no per-transaction flag and there should not be one: whose money a
 * charge is follows from the account it was made on, and a person re-labelling
 * a bucket must not be able to make a business charge personal by accident.
 *
 * Business rows are kept, synced, charted and counted toward balances — they are
 * simply not household spending, so they stay out of every budget bucket and out
 * of household income.
 */
export function isBusinessTxn(
  t: Pick<Transaction, 'account_id'>,
  businessAccountIds: Set<string>,
): boolean {
  return businessAccountIds.has(t.account_id)
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
  /** Every debt, avalanche-ordered. Excludes savings and checking. */
  debts: Account[]
  savings: Account | null
  /**
   * HOUSEHOLD checking accounts — spending sources, never part of the payoff
   * queue. The business's 5star checking is excluded: it used to be in here,
   * and seeding a household cash projection from it would have added $3,347.13
   * of the business's money to the household's, which is roughly the size of
   * the shortfall such a projection exists to catch.
   */
  checking: Account[]
  /**
   * Every savings account. `savings` above is a single row — the deposit-target
   * account Home's panel means — so it is not a cash total: there are two live
   * and using it drops one of them silently.
   */
  savingsAccounts: Account[]
  /** The business's own accounts, for the Business view. */
  businessAccounts: Account[]
  /** Vehicles and anything else owned outright or against a loan. */
  assets: Asset[]
  /**
   * Set when the assets read itself failed, as opposed to there being none.
   *
   * The two are otherwise indistinguishable — both leave `assets` empty — and
   * they mean opposite things. Without this, a dropped request made net worth
   * render as −$116,090 instead of −$52,348, and the vehicles table said "No
   * vehicles on record" about four vehicles that are on record.
   */
  assetsError: string | null
  /**
   * Set when the account_progress read failed.
   *
   * usePayoffPlan falls back to opening_balance for any account with no progress
   * row, which is right for a genuinely new account and badly wrong for all of
   * them at once: the peaks total $149,565.63 against $120,897.51 of opening
   * figures, so a failed read turns "$28,827 cleared, 19.3%" into "$159 cleared,
   * 0.13%" with no sign anything is missing.
   */
  progressError: string | null
  /**
   * This month's HOUSEHOLD transactions. Business is already excluded, so no
   * consumer has to remember to exclude it — a total computed from this is
   * right by default, and the one screen that wants everything asks for it.
   */
  transactions: Transaction[]
  /** This month's transactions including the business's. The ledger view only. */
  allTransactions: Transaction[]
  /**
   * Accounts whose money belongs to the business. Their balances and history are
   * tracked exactly like any other account; only the budget ignores them.
   */
  businessAccountIds: Set<string>
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

  /**
   * supabase-js hands back a NEW user object on every token refresh and on every
   * tab focus, even when nothing about the user changed. Keying `load` on the
   * object identity therefore rebuilt the callback, re-fired the effect, and
   * refetched the entire dataset — which also blew away in-progress typing on
   * Accounts and mapping choices on LinkBank. The id is what actually matters.
   */
  const userId = user?.id ?? null

  /**
   * Guards against an older request finishing last. Two loads can be in flight
   * after a refresh() lands on top of a focus refetch, and the slower one would
   * otherwise commit stale rows over fresh ones.
   */
  const loadSeq = useRef(0)
  const [state, setState] = useState<Omit<DataState, 'refresh'>>({
    loading: true,
    error: null,
    accounts: [],
    debts: [],
    savings: null,
    checking: [],
    savingsAccounts: [],
    businessAccounts: [],
    assets: [],
    assetsError: null,
    progressError: null,
    businessAccountIds: new Set<string>(),
    transactions: [],
    allTransactions: [],
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

    const seq = ++loadSeq.current
    /** Only the most recent load may write. */
    const isCurrent = () => seq === loadSeq.current

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
      assetsRes,
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
      // plaid_sync_status, not plaid_items: the base table has RLS on with no
      // policy by design (tokens and cursors are service-role only), so reading
      // it from the browser always returned nothing and the header always said
      // "not synced yet".
      supabase.from('plaid_sync_status').select('last_synced, status, institution'),
      supabase.from('account_progress').select('*'),
      supabase.from('assets').select('*').order('estimated_value', { ascending: false }),
    ])

    const firstError =
      accountsRes.error ?? balancesRes.error ?? txnRes.error ?? budgetRes.error ?? planRes.error

    if (firstError) {
      if (!isCurrent()) return
      setState((s) => ({ ...s, loading: false, error: firstError.message }))
      return
    }
    if (!isCurrent()) return

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

    const businessAccounts = accounts.filter((a) => a.is_business)
    const businessAccountIds = new Set(businessAccounts.map((a) => a.id))

    const allTransactions = (txnRes.data ?? []).map((t: Record<string, unknown>) => ({
      ...(t as unknown as TransactionRow),
      amount: num(t.amount),
    }))

    setState({
      loading: false,
      error: null,
      accounts,
      debts,
      savings: accounts.find((a) => a.kind === 'savings') ?? null,
      checking: accounts.filter((a) => a.kind === 'checking' && !a.is_business),
      savingsAccounts: accounts.filter((a) => a.kind === 'savings' && !a.is_business),
      businessAccounts,
      // A failed assets read must not blank the app, so it stays out of the
      // firstError chain: net worth is one panel, not the payoff plan. It is
      // reported on its own channel instead, because silence here reads as
      // "no assets", which is a different and much more confident claim.
      assets: (assetsRes.data ?? []).map((r: Record<string, unknown>) => ({
        ...(r as unknown as AssetRow),
        estimated_value: num(r.estimated_value),
      })),
      assetsError: assetsRes.error?.message ?? null,
      progressError: acctProgRes.error?.message ?? null,
      businessAccountIds,
      allTransactions,
      transactions: allTransactions.filter((t) => !isBusinessTxn(t, businessAccountIds)),
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
  }, [isMember, userId])

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
  const { debts, plan, savings, progress } = useData()

  return useMemo(() => {
    if (!plan) return null

    const open = debts.filter((d) => !isCleared(d))
    const totalOwed = open.reduce((s, d) => s + d.balance, 0)

    /**
     * Progress is measured from the HIGHEST balance ever recorded for each debt,
     * the same basis the per-account bars use.
     *
     * It used to measure from opening_balance — the figure entered when the plan
     * began. That silently broke the moment a debt was added afterwards, because
     * a new account's opening figure IS its current balance, so it contributed
     * nothing to the total repaid however much had been paid off it before it was
     * tracked. With most accounts added later, the headline claimed $39.93
     * repaid while the rows beneath it showed one debt two thirds cleared and
     * another at 97%. Two figures on one screen, disagreeing, both derived from
     * the same data.
     *
     * Falls back to the opening figures only if the progress view has not loaded,
     * so a slow read never divides by zero.
     */
    const peakTotal = debts.reduce(
      (s, d) => s + (progress[d.id]?.peak_balance ?? d.opening_balance),
      0,
    )
    const cleared = Math.max(0, peakTotal - totalOwed)
    const openingTotal = peakTotal

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

    /**
     * The counterfactual the Progress tab measures the plan against: every debt
     * pays its own minimum forever and nothing is ever redirected. Run over the
     * SAME simDebts array as the plan, so the two lines start from one total.
     */
    const noRollSim = simulateMinimumsOnly(simDebts)

    /**
     * What goes out to debt each month: every minimum plus the attack fund.
     *
     * Taken from the simulation's own pool rather than re-added here, so the
     * figure on screen and the figure the projection runs on cannot disagree.
     * It stays constant as debts clear, which is the point of the method — a
     * cleared minimum rolls into the next target rather than being kept.
     */
    const monthlyOutlay = monthlyPool(simDebts, plan.attack_fund)
    const minimumsTotal = round2(monthlyOutlay - plan.attack_fund)
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
      noRollSim,
      savingsBalance: savings?.balance ?? 0,
      depositTarget: plan.deposit_target,
      monthlySavings: plan.monthly_savings,
      savingsRemaining: Math.max(0, plan.deposit_target - (savings?.balance ?? 0)),
      attackFund: plan.attack_fund,
      monthlyOutlay,
      minimumsTotal,
      planStartedOn: plan.plan_started_on,
    }
  }, [debts, plan, savings, progress])
}

/** One asset with the loan held against it resolved. */
export interface AssetEquity {
  asset: Asset
  /** The securing loan, or null when the asset is owned outright. */
  loan: Account | null
  /** Balance still owed on that loan. 0 when owned outright. */
  owedOn: number
  /** value − owed. Negative means underwater. */
  equity: number
}

/**
 * Net worth: everything owned, less everything owed.
 *
 * Debt alone only ever looks bad, and the figure this returns is negative today.
 * That is the point — it climbs every month as debt falls, which the debt total
 * on its own never conveys.
 *
 * Business money is counted on BOTH sides, because the debt total already
 * includes the business's Amazon Business card. Counting its card but not its
 * cash would overstate what is owed by the size of the balance sitting in the
 * business account. This is a balance sheet, not a household budget: the rule
 * that business data stays out of bucket maths is about `transactions`, and
 * nothing here touches a bucket.
 *
 * Debt is summed from the account rows by kind rather than from plan.totalOwed,
 * which counts only debts that are not cleared — and `cleared` is true whenever
 * cleared_at is set, even with a balance still on the account. Such a debt would
 * vanish from net worth while still being owed.
 */
export function useNetWorth() {
  const { accounts, assets } = useData()

  return useMemo(() => {
    const byId = new Map(accounts.map((a) => [a.id, a]))

    const assetRows: AssetEquity[] = assets.map((asset) => {
      // Matched by uuid. The truck's loan is "Truck — Issuer", with an em
      // dash, and any name match against it reports the vehicle as owned outright.
      const loan = asset.secured_by ? byId.get(asset.secured_by) ?? null : null
      const owedOn = loan ? Math.max(0, loan.balance) : 0
      return {
        asset,
        loan,
        owedOn,
        equity: round2(asset.estimated_value - owedOn),
      }
    })

    const assetsTotal = round2(assets.reduce((s, a) => s + a.estimated_value, 0))

    const cashAccounts = accounts.filter((a) => a.kind === 'checking' || a.kind === 'savings')
    const cashTotal = round2(cashAccounts.reduce((s, a) => s + a.balance, 0))
    const businessCash = round2(
      cashAccounts.filter((a) => a.is_business).reduce((s, a) => s + a.balance, 0),
    )

    const debtAccounts = accounts.filter((a) => a.kind !== 'checking' && a.kind !== 'savings')
    const debtTotal = round2(
      debtAccounts.reduce((s, a) => s + Math.max(0, a.balance), 0),
    )

    return {
      assetRows,
      assetsTotal,
      cashTotal,
      businessCash,
      debtTotal,
      netWorth: round2(assetsTotal + cashTotal - debtTotal),
      /** True once there is anything to show; an empty assets table is not an error. */
      hasAssets: assets.length > 0,
    }
  }, [accounts, assets])
}

/**
 * Spend per bucket for the current month. Money out is positive.
 *
 * Reads `transactions`, which the provider has already narrowed to the
 * household — so business spending never lands in a bucket and money the
 * business takes in is never reported as household income.
 */
export function useMonthTotals() {
  const { transactions, budgetLines } = useData()
  return useMonthTotalsFor(transactions, budgetLines)
}

/**
 * The same totals for any month's rows — /month pages back through earlier
 * months and totals whichever one is on screen.
 *
 * `transactions` must already be narrowed to the household, as both the
 * provider and useMonthView() narrow theirs.
 */
export function useMonthTotalsFor(transactions: Transaction[], budgetLines: BudgetLine[]) {
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
