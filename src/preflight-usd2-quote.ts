/**
 * F0-C10/PREFLIGHT-03 — US$2,00 TOTAL experimental budget (offline only).
 *
 * This is a shadow/quoting guard, NOT a live spending adapter.
 * No input object or success here authorizes an inference, deployment or
 * account mutation. Upstream billing may be delayed, eventually consistent,
 * scoped to an entire account or inaccessible to these credentials.
 */
import { COST_KINDS, F0_C10_GLOBAL_APPROVED_MICRO_USD,
  type DisposableCostPolicy, type ExpenseKind } from "./preflight-disposable-cost";

export const F0_C10_USD2_APPROVAL = Object.freeze({
  project: "F0-C10",
  currency: "USD",
  totalMicroUsd: F0_C10_GLOBAL_APPROVED_MICRO_USD,
  totalUsd: "2.00",
  scope: "one future experimental campaign, ALL attributable costs combined",
  spendOrDeployAuthorized: false,
  proofOfProviderHardCutoff: false,
  canUseSharedAccountSpendPolicy: false
} as const);

/** Costs outside T07's six named routes must NOT silently become zero. */
export const ADDITIONAL_COST_KINDS = [
  "storage", "egress", "observability", "unclassified"
] as const;
export type AdditionalCostKind = typeof ADDITIONAL_COST_KINDS[number];
export type ShadowUsd2Quote = {
  currency: "USD";
  /** A single dedicated control DO is assumed, not authenticated. */
  plannedControlDOs: number;
  perServiceWorstCaseMicroUsd: Record<ExpenseKind, number | null>;
  additionalWorstCaseMicroUsd: Record<AdditionalCostKind, number | null>;
  /** Values in a quote are NOT provider-certified, even if user sets flags. */
  source: "synthetic-fixture" | "unverified-estimate";
};
export type ShadowUsd2Decision = {
  decision: "STOP";
  shadowStatus: "UNQUOTED" | "EXCEEDS_USD2" | "WITHIN_USD2_UNVERIFIED" |
    "MULTI_LEDGER_BYPASS";
  totalWorstCaseMicroUsd: number | null;
  ceilingMicroUsd: typeof F0_C10_GLOBAL_APPROVED_MICRO_USD;
  providerDispatchAuthorized: false;
  operationalLeaseVerified: false;
  providerHardCutoffVerified: false;
};

const HEX64=/^[0-9a-f]{64}$/;
const REV=/^[a-z][a-z0-9._-]{0,63}$/;
function assert(ok:unknown,label:string):asserts ok {
  if(!ok)throw new Error(label);
}
const isAmount=(value:unknown):value is number=>
  typeof value==="number" && Number.isSafeInteger(value) &&
  value>=0 && value<=Number.MAX_SAFE_INTEGER;
function exactCostKeys(value:unknown,expected:readonly string[]):value is Record<string,number|null> {
  return value!==null && typeof value==="object" && !Array.isArray(value) &&
    Object.keys(value).length===expected.length &&
    expected.every(k=>Object.hasOwn(value,k));
}

/** This builder is not a live control. Six service maxima share ONE ledger;
 * they are NOT six separately spendable US$2 budgets.
 */
export function buildUsd2DisposableShadowPolicy(scopeHash:string,revision:string):
  DisposableCostPolicy {
  assert(HEX64.test(scopeHash) && REV.test(revision),"USD2_SHADOW_SCOPE_INVALID");
  return {
    scopeHash,policyRevision:revision,
    totalMicroUsd:F0_C10_GLOBAL_APPROVED_MICRO_USD,
    maxByServiceMicroUsd:Object.fromEntries(COST_KINDS.map(k=>[
      k,F0_C10_GLOBAL_APPROVED_MICRO_USD
    ])) as Record<ExpenseKind,number>
  };
}

/** Numeric quotes are acceptable for offline comparisons, never runtime GO.
 * Missing costs stay UNKNOWN instead of being treated as free.
 */
export function evaluateUsd2ShadowQuote(input:ShadowUsd2Quote):ShadowUsd2Decision {
  assert(input && input.currency==="USD" &&
    (input.source==="synthetic-fixture"||input.source==="unverified-estimate") &&
    Number.isSafeInteger(input.plannedControlDOs) &&
    input.plannedControlDOs>=1 &&
    exactCostKeys(input.perServiceWorstCaseMicroUsd,COST_KINDS) &&
    exactCostKeys(input.additionalWorstCaseMicroUsd,ADDITIONAL_COST_KINDS),
    "USD2_QUOTE_INVALID");
  const amounts=[
    ...COST_KINDS.map(k=>input.perServiceWorstCaseMicroUsd[k]),
    ...ADDITIONAL_COST_KINDS.map(k=>input.additionalWorstCaseMicroUsd[k])
  ];
  for(const value of amounts)
    assert(value===null||isAmount(value),"USD2_QUOTE_AMOUNT_INVALID");
  const baseline: Omit<ShadowUsd2Decision,"shadowStatus"|"totalWorstCaseMicroUsd">={
    decision:"STOP",
    ceilingMicroUsd:F0_C10_GLOBAL_APPROVED_MICRO_USD,
    providerDispatchAuthorized:false,
    operationalLeaseVerified:false,
    providerHardCutoffVerified:false
  };
  if(input.plannedControlDOs!==1)
    return {...baseline,shadowStatus:"MULTI_LEDGER_BYPASS",totalWorstCaseMicroUsd:null};
  if(amounts.some(value=>value===null))
    return {...baseline,shadowStatus:"UNQUOTED",totalWorstCaseMicroUsd:null};
  let sum=0;
  for(const value of amounts){
    sum+=(value as number);
    if(!Number.isSafeInteger(sum))
      return {...baseline,shadowStatus:"EXCEEDS_USD2",totalWorstCaseMicroUsd:null};
  }
  return {...baseline,shadowStatus:sum>F0_C10_GLOBAL_APPROVED_MICRO_USD?
    "EXCEEDS_USD2":"WITHIN_USD2_UNVERIFIED",totalWorstCaseMicroUsd:sum};
}
