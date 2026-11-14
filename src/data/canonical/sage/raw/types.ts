/**
 * Raw shapes as returned by Sage Accounting API v3.1.
 *
 * Keep wire shapes here, untouched and separate from canonical models,
 * so API changes and canonical mapping changes never hide in the same file.
 */

export interface SageEnvelope<T> {
  $total?: number;
  $page?: number;
  $next?: string | null;
  $back?: string | null;
  $itemsPerPage?: number;
  $items: T[];
}

export interface SageFinancialSettings {
  id?: string;
  base_currency?: {
    id: string;
    displayed_as?: string;
    $path?: string;
  };
  multi_currency_enabled?: boolean;
  tax_scheme?: {
    id: string;
    displayed_as?: string;
  };
  tax_number?: string;
}

export interface SageLedgerAccount {
  id: string;
  displayed_as?: string;
  name?: string;
  nominal_code?: number | string;
  ledger_account_type?: {
    id: string;
    displayed_as?: string;
  };
  ledger_account_group?: {
    id: string;
    displayed_as?: string;
  };
  currency?: string;
  updated_at?: string;
  created_at?: string;
}

export interface SageBankAccount {
  id: string;
  displayed_as?: string;
  bank_account_name?: string;
  ledger_account?: {
    id: string;
    displayed_as?: string;
    nominal_code?: number | string;
  };
  nominal_code?: number | string;
  currency?: {
    id: string;
    displayed_as?: string;
  } | string;
  updated_at?: string;
}

export interface SageContact {
  id: string;
  displayed_as?: string;
  name?: string;
  contact_type_ids?: string[];
  email?: string;
  main_contact_person?: {
    email?: string;
  };
  updated_at?: string;
}

export interface SageInvoiceLine {
  id?: string;
  description?: string;
  ledger_account?: {
    id: string;
    displayed_as?: string;
  };
  net_amount?: number | string;
  total_amount?: number | string;
  tax_amount?: number | string;
  unit_price?: number | string;
}

export interface SageInvoice {
  id: string;
  displayed_as?: string;
  invoice_number?: string | number;
  contact?: {
    id: string;
    displayed_as?: string;
  };
  date?: string;
  due_date?: string;
  status?: {
    id: string;
    displayed_as?: string;
  } | string;
  currency?: {
    id: string;
    displayed_as?: string;
  } | string;
  total?: number | string;
  total_amount?: number | string;
  outstanding_amount?: number | string;
  total_paid?: number | string;
  net_amount?: number | string;
  invoice_lines?: SageInvoiceLine[];
  updated_at?: string;
}

export interface SageOtherPayment {
  id: string;
  displayed_as?: string;
  date?: string;
  total_amount?: number | string;
  net_amount?: number | string;
  reference?: string;
  bank_account?: {
    id: string;
    displayed_as?: string;
  };
  contact?: {
    id: string;
    displayed_as?: string;
  };
  transaction_type?: {
    id: string;
    displayed_as?: string;
  };
  currency?: {
    id: string;
    displayed_as?: string;
  } | string;
  payment_lines?: Array<{
    id?: string;
    details?: string;
    ledger_account?: {
      id: string;
      displayed_as?: string;
    };
    net_amount?: number | string;
    total_amount?: number | string;
  }>;
  updated_at?: string;
}

export interface SageContactPayment {
  id: string;
  displayed_as?: string;
  date?: string;
  total_amount?: number | string;
  net_amount?: number | string;
  reference?: string;
  bank_account?: {
    id: string;
    displayed_as?: string;
  };
  contact?: {
    id: string;
    displayed_as?: string;
  };
  transaction_type?: {
    id: string;
    displayed_as?: string;
  };
  currency?: {
    id: string;
    displayed_as?: string;
  } | string;
  updated_at?: string;
}

export interface SageBankTransfer {
  id: string;
  displayed_as?: string;
  date?: string;
  amount?: number | string;
  reference?: string;
  description?: string;
  from_bank_account?: {
    id: string;
    displayed_as?: string;
  };
  to_bank_account?: {
    id: string;
    displayed_as?: string;
  };
  currency?: {
    id: string;
    displayed_as?: string;
  } | string;
  updated_at?: string;
}

export interface SageBankTransaction {
  id: string;
  date?: string;
  amount?: number | string;
  net_amount?: number | string;
  total_amount?: number | string;
  currency?: {
    id: string;
  } | string;
  reference?: string;
  description?: string;
  bank_account?: {
    id: string;
    ledger_account?: {
      id: string;
    };
  };
  contact?: {
    id: string;
  };
  ledger_account?: {
    id: string;
  };
  bank_transaction_type?: {
    id: string;
  };
  updated_at?: string;
}
