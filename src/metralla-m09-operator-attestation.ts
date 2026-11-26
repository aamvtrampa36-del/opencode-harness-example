/** Recovery-only attestation by the deployment administrator, not three independent signers.
 * The operator obtains evidence from independent sources and signs its exact digests.
 * The M01 archive transaction still checks identity, freshness, closure and CAS.
 */
import { reconciliationDigest, type ConsumedVerifier, type FreezeManifest } from './supervisor-reconciliation';
const roles = ['effect', 'closure', 'authorization'] as const;
type Role = typeof roles[number];
const hex = (v: unknown, n: number): v is string => typeof v === 'string' && v.length === n && /^[a-f0-9]+$/.test(v);
const bytes = (s: string) => Uint8Array.from(s.match(/../g)!, v => parseInt(v, 16));
const exactKeys = (v: unknown, keys: string) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === keys;
export type OperatorAttestation = {
  schema: 'metralla-m09-operator-attestation-v1';
  environment: 'staging';
  releaseSha: string;
  requestId: string;
  approvalRef: string;
  expiresAt: number;
  digests: Record<Role, string>;
  signature: string;
};
export async function operatorAttestationMessage(body: Omit<OperatorAttestation, 'signature'>) {
  return new TextEncoder().encode('metralla:m09:archive-operator:v1:' + await reconciliationDigest(body));
}
export async function operatorConsumedVerifier(root: unknown, freeze: FreezeManifest, raw: unknown,
  clock = Date.now): Promise<ConsumedVerifier> {
  const a = raw as OperatorAttestation;
  const now = clock();
  if (!hex(root,64) || !exactKeys(a,'approvalRef,digests,environment,expiresAt,releaseSha,requestId,schema,signature') ||
      a.schema !== 'metralla-m09-operator-attestation-v1' || a.environment !== 'staging' ||
      freeze.schema !== 'r4-freeze-v1' || freeze.environment !== 'staging' ||
      freeze.requestId !== '42574cb3f5ee0cbf' || a.requestId !== freeze.requestId ||
      !hex(freeze.releaseSha,40) || a.releaseSha !== freeze.releaseSha || a.approvalRef !== freeze.approvalRef ||
      !Number.isSafeInteger(freeze.notBefore) || freeze.notBefore > now ||
      !Number.isSafeInteger(freeze.expiresAt) || freeze.expiresAt <= now ||
      !Number.isSafeInteger(a.expiresAt) || a.expiresAt <= now || a.expiresAt > freeze.expiresAt ||
      !exactKeys(a.digests,'authorization,closure,effect') || !roles.every(r => hex(a.digests[r],64)) ||
      !hex(a.signature,128)) throw Error('M09_OPERATOR_ATTESTATION_INVALID');
  const {signature,...body} = structuredClone(a);
  const key = await crypto.subtle.importKey('raw',bytes(root),{name:'Ed25519'},false,['verify']);
  if (!await crypto.subtle.verify('Ed25519',key,bytes(signature),await operatorAttestationMessage(body)))
    throw Error('M09_OPERATOR_ATTESTATION_SIGNATURE');
  return async (role, value) => {
    if (!roles.includes(role) || clock() >= body.expiresAt) return false;
    return await reconciliationDigest(value) === body.digests[role];
  };
}
