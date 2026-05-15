// ─── @pollar/pay — PollarPayClient ───────────────────────────────────────────
// Copia local del SDK para la demo merchant-checkout-web. Espejo del paquete
// publicado en @pollar/pay (carpeta pollar-sdk/). Mantenerlos en sync.
// ─────────────────────────────────────────────────────────────────────────────

import type {
    PayIntentResponse,
    PayStatusResponse,
    PayStatusData,
    PaymentCallbacks,
    PollarPayConfig,
    PayManualCompleteResponse,
    WaitForPaymentOptions,
    StellarNetwork,
} from './types.js';
import { FINAL_STATUSES, PollarPayError, PAY_ERROR_CODES } from './types.js';
import { networkFromApiKey } from './stellar.js';

const DEFAULT_POLL_INTERVAL_MS = 5_000;

const BASE_URLS = {
    testnet: 'https://pp1back.vercel.app/api',
    mainnet: 'https://pp1back.vercel.app/api',
    local: 'http://localhost:3000/api',
} as const;

function resolveBaseUrl(config: PollarPayConfig): string {
    if (config.baseUrl) return config.baseUrl;
    if (config.apiKey.startsWith('pub_mainnet_')) return BASE_URLS.mainnet;
    if (config.apiKey.startsWith('pub_testnet_')) return BASE_URLS.testnet;
    return BASE_URLS.local;
}

export class PollarPayClient {
    readonly apiKey: string;
    readonly network: StellarNetwork;
    private readonly _baseUrl: string;

    constructor(config: PollarPayConfig) {
        if (!config.apiKey) {
            throw new PollarPayError(PAY_ERROR_CODES.INVALID_API_KEY, 'apiKey is required');
        }
        this.apiKey = config.apiKey;
        this.network = networkFromApiKey(config.apiKey);
        this._baseUrl = resolveBaseUrl(config);
    }

    async createIntent(amount: number | string, reason: string): Promise<PayIntentResponse> {
        const parsedAmount = typeof amount === 'string' ? parseFloat(amount) : amount;

        if (isNaN(parsedAmount) || parsedAmount < 0.01 || parsedAmount > 1_000_000) {
            throw new PollarPayError(
                PAY_ERROR_CODES.INVALID_AMOUNT,
                'Amount must be between 0.01 and 1,000,000 USDC',
            );
        }
        if (!reason || !reason.trim()) {
            throw new PollarPayError(
                PAY_ERROR_CODES.INVALID_AMOUNT,
                'reason is required (1+ char)',
            );
        }

        return this._request<PayIntentResponse>('POST', '/sdk/pay', {
            amount_expected: parsedAmount.toString(),
            reason: reason.trim(),
        });
    }

    async checkStatus(transactionId: string): Promise<PayStatusResponse> {
        if (!transactionId) {
            throw new PollarPayError(PAY_ERROR_CODES.TRANSACTION_NOT_FOUND, 'transactionId is required');
        }
        const params = new URLSearchParams({ transaction_id: transactionId });
        return this._request<PayStatusResponse>('GET', `/sdk/status?${params.toString()}`);
    }

    async manualComplete(transactionId: string): Promise<PayManualCompleteResponse> {
        if (!transactionId) {
            throw new PollarPayError(PAY_ERROR_CODES.TRANSACTION_NOT_FOUND, 'transactionId is required');
        }
        return this._request<PayManualCompleteResponse>('POST', '/sdk/manual-complete', {
            transaction_id: transactionId,
        });
    }

    waitForPayment(
        transactionId: string,
        callbacks: PaymentCallbacks,
        options: number | WaitForPaymentOptions = {},
    ): () => void {
        const opts: WaitForPaymentOptions =
            typeof options === 'number' ? { intervalMs: options } : options;

        const intervalMs           = opts.intervalMs           ?? DEFAULT_POLL_INTERVAL_MS;
        const maxWaitMs            = opts.maxWaitMs            ?? 16 * 60 * 1000;
        const maxConsecutiveErrors = opts.maxConsecutiveErrors ?? 5;

        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const startedAt = Date.now();
        let consecutiveErrors = 0;

        const stop = () => {
            stopped = true;
            if (timer) clearTimeout(timer);
        };

        const poll = async (): Promise<void> => {
            if (stopped) return;
            if (Date.now() - startedAt >= maxWaitMs) {
                stopped = true;
                await callbacks.onTimeout?.();
                return;
            }

            try {
                const result = await this.checkStatus(transactionId);
                const data: PayStatusData = result.data;
                consecutiveErrors = 0;
                await callbacks.onUpdate?.(data);

                if (data.status === 'completed')   { await callbacks.onCompleted?.(data); stopped = true; return; }
                if (data.status === 'overpaid')    { await callbacks.onOverpaid?.(data);  stopped = true; return; }
                if (FINAL_STATUSES.includes(data.status) || data.is_expired) {
                    await callbacks.onFailed?.(data);
                    stopped = true;
                    return;
                }
                timer = setTimeout(poll, intervalMs);
            } catch (error: unknown) {
                const err = error instanceof Error ? error : new Error(String(error));
                consecutiveErrors += 1;
                await callbacks.onError?.(err);
                if (consecutiveErrors >= maxConsecutiveErrors) {
                    stopped = true;
                    await callbacks.onTimeout?.();
                    return;
                }
                const backoff = Math.min(intervalMs * 2 ** (consecutiveErrors - 1), 60_000);
                if (!stopped) timer = setTimeout(poll, backoff);
            }
        };

        poll();
        return stop;
    }

    private async _request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
        const url = `${this._baseUrl}${path}`;
        const headers: Record<string, string> = { 'x-pollar-api-key': this.apiKey };
        const init: RequestInit = { method, headers };
        if (body !== undefined) {
            headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(body);
        }

        let response: Response;
        try {
            response = await fetch(url, init);
        } catch (err: unknown) {
            throw new PollarPayError(
                PAY_ERROR_CODES.NETWORK_ERROR,
                `Network error: ${err instanceof Error ? err.message : String(err)}`,
            );
        }

        const data = (await response.json()) as T & { error?: string };
        if (!response.ok) {
            const errorMessage = data.error ?? `HTTP ${response.status}`;
            if (response.status === 401) throw new PollarPayError(PAY_ERROR_CODES.INVALID_API_KEY, errorMessage);
            if (response.status === 404) throw new PollarPayError(PAY_ERROR_CODES.TRANSACTION_NOT_FOUND, errorMessage);
            if (response.status === 503) throw new PollarPayError(PAY_ERROR_CODES.NO_WALLETS_AVAILABLE, errorMessage);
            throw new PollarPayError(PAY_ERROR_CODES.NETWORK_ERROR, errorMessage);
        }
        return data;
    }
}
