import type { QuickBooksClassification, QuickBooksClassificationResult } from './types';

interface Rule {
  pattern: RegExp;
  classification: QuickBooksClassification;
}

const RULES: Rule[] = [
  {
    // Wallets: cash / bank-account terms. `bank` is carved out so the
    // common expense phrases "Bank Charges" / "Bank Fees" fall through to
    // the expense rule further down instead of being misclassified as wallets.
    pattern: /\b(cash|checking|savings|operating|petty cash)\b|\bbank\b(?!\s*(charges?|fees?|expense))/i,
    classification: {
      accountType: 'ASSET',
      accountSubType: 'WALLETS',
      normalBalance: 'DEBIT',
      isWallet: true,
      isSystem: false,
    },
  },
  {
    pattern: /\b(receivable|a\/r|accounts receivable)\b/i,
    classification: {
      accountType: 'ASSET',
      accountSubType: 'OTHER_CURRENT_ASSETS',
      normalBalance: 'DEBIT',
      isWallet: false,
      isSystem: false,
    },
  },
  {
    // Transfer Clearing + Undeposited Funds are the two classic QB
    // "money-is-moving-but-not-settled-yet" accounts. Per internal connector review
    // and the V2 seed template, these are current assets (bank has not yet
    // posted), not suspense. "Suspense" keeps its own subType for the rare
    // user who labels an account literally that.
    pattern: /\b(transfer clearing|undeposited funds)\b/i,
    classification: {
      accountType: 'ASSET',
      accountSubType: 'OTHER_CURRENT_ASSETS',
      normalBalance: 'DEBIT',
      isWallet: false,
      isSystem: true,
    },
  },
  {
    pattern: /\bsuspense\b/i,
    classification: {
      accountType: 'ASSET',
      accountSubType: 'SUSPENSE',
      normalBalance: 'DEBIT',
      isWallet: false,
      isSystem: true,
    },
  },
  {
    pattern: /\b(inventory|prepaid|deposit|asset)\b/i,
    classification: {
      accountType: 'ASSET',
      accountSubType: 'OTHER_CURRENT_ASSETS',
      normalBalance: 'DEBIT',
      isWallet: false,
      isSystem: false,
    },
  },
  {
    pattern: /\b(fixed asset|equipment|vehicle|furniture|building)\b/i,
    classification: {
      accountType: 'ASSET',
      accountSubType: 'FIXED_ASSETS',
      normalBalance: 'DEBIT',
      isWallet: false,
      isSystem: false,
    },
  },
  {
    pattern: /\b(payable|a\/p|credit card|loan|liability|tax payable)\b/i,
    classification: {
      accountType: 'LIABILITY',
      accountSubType: 'CURRENT_LIABILITIES',
      normalBalance: 'CREDIT',
      isWallet: false,
      isSystem: false,
    },
  },
  {
    pattern: /\b(long.?term|mortgage|note payable)\b/i,
    classification: {
      accountType: 'LIABILITY',
      accountSubType: 'LONG_TERM_LIABILITIES',
      normalBalance: 'CREDIT',
      isWallet: false,
      isSystem: false,
    },
  },
  {
    pattern: /\b(equity|owner|capital|opening balance)\b/i,
    classification: {
      accountType: 'EQUITY',
      accountSubType: 'OWNERS_EQUITY',
      normalBalance: 'CREDIT',
      isWallet: false,
      isSystem: false,
    },
  },
  {
    pattern: /\b(retained earnings)\b/i,
    classification: {
      accountType: 'EQUITY',
      accountSubType: 'RETAINED_EARNINGS',
      normalBalance: 'CREDIT',
      isWallet: false,
      isSystem: false,
    },
  },
  {
    pattern: /\b(sales|revenue|income|service|fees)\b/i,
    classification: {
      accountType: 'INCOME',
      accountSubType: 'SALES',
      normalBalance: 'CREDIT',
      isWallet: false,
      isSystem: false,
    },
  },
  {
    pattern: /\b(cost of goods|cogs|cost of sales)\b/i,
    classification: {
      accountType: 'EXPENSE',
      accountSubType: 'COST_OF_SALES',
      normalBalance: 'DEBIT',
      isWallet: false,
      isSystem: false,
    },
  },
  {
    pattern: /\b(marketing|advertising|promotion)\b/i,
    classification: {
      accountType: 'EXPENSE',
      accountSubType: 'SALES_AND_MARKETING',
      normalBalance: 'DEBIT',
      isWallet: false,
      isSystem: false,
    },
  },
  {
    pattern: /\b(payroll|wage|salary|labor)\b/i,
    classification: {
      accountType: 'EXPENSE',
      accountSubType: 'LABOR',
      normalBalance: 'DEBIT',
      isWallet: false,
      isSystem: false,
    },
  },
  {
    pattern: /\b(expense|rent|software|subscription|utilities|office|bank charges?|fees?)\b/i,
    classification: {
      accountType: 'EXPENSE',
      accountSubType: 'GENERAL_AND_ADMINISTRATIVE',
      normalBalance: 'DEBIT',
      isWallet: false,
      isSystem: false,
    },
  },
];

export function classifyQuickBooksAccounts(accountNames: string[]): QuickBooksClassificationResult {
  const confident: Record<string, QuickBooksClassification> = {};
  const ambiguous: string[] = [];

  for (const accountName of [...new Set(accountNames.map((name) => name.trim()).filter(Boolean))]) {
    const rule = RULES.find((candidate) => candidate.pattern.test(accountName));
    if (rule) {
      confident[accountName] = rule.classification;
    } else {
      ambiguous.push(accountName);
    }
  }

  return { confident, ambiguous };
}
