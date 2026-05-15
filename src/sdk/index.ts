// ─── @pollar/pay — Public API (copia local del demo) ────────────────────────

export { PollarPayClient } from './client.js';

export type {
    PollarPayConfig,
    PayIntentResponse,
    PayIntentData,
    PayStatusResponse,
    PayStatusData,
    PayManualCompleteResponse,
    PaymentStatus,
    PaymentCallbacks,
    WaitForPaymentOptions,
    PayErrorCode,
    StellarNetwork,
} from './types.js';

export { PAY_ERROR_CODES, FINAL_STATUSES, PollarPayError } from './types.js';

export {
    buildSep7PayUri,
    buildStellarExpertTxUrl,
    buildStellarExpertAccountUrl,
    networkFromApiKey,
    normalizeNetwork,
    USDC_ISSUERS,
    NETWORK_PASSPHRASES,
} from './stellar.js';
