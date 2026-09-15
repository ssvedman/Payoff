/**
 * Generated from the live schema via the Supabase MCP connector.
 * Regenerate after any migration.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Bucket = 'fixed' | 'optional' | 'attack' | 'savings' | 'income' | 'transfer' | 'review'
export type BucketSource = 'auto' | 'rule' | 'manual'
/**
 * Whose name the account is in. The authoritative values are enforced by a CHECK
 * constraint on accounts.owner; they are deliberately not enumerated here, so the
 * household members' names stay out of a public repository. Rendering goes through
 * ownerLabel() in format.ts.
 */
export type AccountOwner = string
export type AccountKind = 'card' | 'loan' | 'tax' | 'savings' | 'checking'
export type SnapshotSource = 'plaid' | 'manual'
export type ItemStatus = 'ok' | 'login_required' | 'error'

export type AlertType =
  | 'balance_up'
  | 'attack_missing'
  | 'optional_80'
  | 'business_low'
  | 'account_cleared'
  | 'balance_stale'
  | 'item_login_required'
  | 'monthly_summary'

export type AccountRow = {
  id: string
  name: string
  owner: AccountOwner
  kind: AccountKind
  apr: number | null
  minimum_payment: number
  payoff_order: number
  opening_balance: number
  plaid_account_id: string | null
  is_manual: boolean
  cleared_at: string | null
  is_business: boolean
  /** Human description for the UI: "Auto loan", "Savings account". */
  type_label: string | null
  /**
   * The issuing bank, shown beside the type label. Stored rather than derived:
   * an account row carries no item_id, and a typed-in account has no Plaid item
   * to derive it from at all.
   */
  institution: string | null
  /**
   * Statement descriptors that stand in for this account's name, so a payment to
   * it is recognized as one when the bank's wording shares no word with it.
   */
  payment_aliases: string[]
  /** From the issuer, refreshed nightly. Null means "not stated this cycle". */
  next_due_on: string | null
  last_payment_on: string | null
  last_payment_amount: number | null
  last_statement_balance: number | null
  created_at: string
}

export type BalanceSnapshotRow = {
  id: number
  account_id: string
  balance: number
  as_of: string
  source: SnapshotSource
  entered_by: string | null
  created_at: string
}

export type TransactionRow = {
  id: string
  plaid_transaction_id: string | null
  account_id: string
  posted_on: string
  name: string
  merchant_name: string | null
  amount: number
  plaid_category: string | null
  bucket: Bucket
  bucket_source: BucketSource
  budget_line_id: string | null
  pending: boolean
  created_at: string
}

export type MerchantRuleRow = {
  id: string
  match_text: string
  bucket: Bucket
  budget_line_id: string | null
  created_by: string | null
  created_at: string
}

export type BudgetLineRow = {
  id: string
  bucket: string
  line_name: string
  monthly_target: number
  sort_order: number
}

export type PlanSettingsRow = {
  id: number
  attack_fund: number
  monthly_savings: number
  deposit_target: number
  plan_started_on: string
}

export type HouseholdMemberRow = {
  user_id: string
  display_name: string
  created_at: string
}

export type PushSubscriptionRow = {
  id: string
  user_id: string
  endpoint: string
  p256dh: string
  auth_key: string
  created_at: string
}

export type NotificationPrefRow = {
  user_id: string
  alert_type: string
  enabled: boolean
}

export type PlaidItemRow = {
  item_id: string
  institution: string
  cursor: string | null
  status: ItemStatus
  last_synced: string | null
  created_at: string
}

export type AlertLogRow = {
  id: number
  alert_type: string
  payload: Json | null
  sent_at: string
}

export type AuditLogRow = {
  id: number
  user_id: string | null
  table_name: string
  record_id: string | null
  action: string
  old_value: Json | null
  new_value: Json | null
  created_at: string
}

type T<Row, Ins = Partial<Row>, Upd = Partial<Row>> = { Row: Row; Insert: Ins; Update: Upd; Relationships: [] }

export type Database = {
  public: {
    Tables: {
      accounts: T<AccountRow>
      balance_snapshots: T<BalanceSnapshotRow>
      transactions: T<TransactionRow>
      merchant_rules: T<MerchantRuleRow>
      budget_lines: T<BudgetLineRow>
      plan_settings: T<PlanSettingsRow>
      household_members: T<HouseholdMemberRow>
      push_subscriptions: T<PushSubscriptionRow>
      notification_prefs: T<NotificationPrefRow>
      plaid_items: T<PlaidItemRow>
      alert_log: T<AlertLogRow>
      audit_log: T<AuditLogRow>
    }
    Views: {
      debt_history_weekly: {
        Row: {
          week_start: string
          total_owed: number | null
          savings: number | null
          open_debts: number | null
          /** How many debts had a reading by this week, and how many exist. */
          debts_covered: number
          debts_total: number
          /** False when total_owed is missing an account rather than short one. */
          fully_covered: boolean
        }
        Relationships: []
      }
      account_balance_weekly: {
        Row: {
          week_start: string
          account_id: string
          name: string
          kind: string
          owner: string
          /** NULL when nothing had been recorded for this account yet. */
          balance: number | null
          balance_as_of: string | null
          covered: boolean
        }
        Relationships: []
      }
      account_balance_current: {
        Row: {
          account_id: string
          balance: number
          as_of: string
          source: string
          entered_by: string | null
          created_at: string
          prev_balance: number | null
          prev_as_of: string | null
        }
        Relationships: []
      }
      plaid_sync_status: {
        Row: {
          item_id: string
          institution: string
          status: string
          last_synced: string | null
        }
        Relationships: []
      }
      account_progress: {
        Row: {
          account_id: string
          name: string
          kind: string
          owner: string
          payoff_order: number
          current_balance: number | null
          peak_balance: number
          paid_off: number
          pct_paid: number
        }
        Relationships: []
      }
    }
    Functions: { is_household_member: { Args: Record<string, never>; Returns: boolean } }
    Enums: { [_ in never]: never }
    CompositeTypes: { [_ in never]: never }
  }
}
