// ─────────────────────────────────────────────────────────────────────────────
//  Express app — sin .listen()
//
//  Se importa desde dos lugares:
//    - src/server.ts  → para local dev (corre con .listen())
//    - api/index.ts   → para Vercel serverless (export default como handler)
// ─────────────────────────────────────────────────────────────────────────────

import { config } from 'dotenv';
import express from 'express';
import {
  PollarPayClient,
  PollarPayError,
  buildSep7PayUri,
  buildStellarExpertTxUrl,
} from './sdk/index.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHmac, timingSafeEqual } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

// dotenv solo aplica en local; en Vercel las env vars vienen del dashboard.
try {
  config({ path: resolve(__dirname, '../.env') });
} catch { /* sin .env local — ok */ }

const POLLAR_API_KEY = process.env.POLLAR_API_KEY;
const POLLAR_BACKEND_URL = process.env.POLLAR_BACKEND_URL;
const CRON_SECRET = process.env.CRON_SECRET;
// Secret del webhook configurado en /dashboard/avanzado. El comercio lo guarda
// y firma cada payload. Si no está, /webhook acepta cualquier request (modo demo).
const POLLAR_WEBHOOK_SECRET = process.env.POLLAR_WEBHOOK_SECRET;

// Buffer en memoria de los últimos eventos recibidos. En producción real esto
// iría a una DB; acá es solo para el demo /eventos.
interface ReceivedEvent {
  received_at: string;
  event_type: string;
  delivery_id: string | null;
  signature_valid: boolean;
  payload: unknown;
}
const RECENT_EVENTS: ReceivedEvent[] = [];
const MAX_RECENT_EVENTS = 50;

// ─── Catálogo (en producción vendría de una DB) ──────────────────────────────
const CATALOG = [
  { id: 1, name: 'Espresso',       price: 2.50,  image: '☕' },
  { id: 2, name: 'Cappuccino',     price: 4.00,  image: '☕' },
  { id: 3, name: 'Premium Latte',  price: 5.50,  image: '🥛' },
  { id: 4, name: 'Bolsa de café (250g)', price: 18.00, image: '📦' },
];

// Lazy: no crashear al importar el módulo si falta env var.
// Cada handler usa este getter — si la apiKey no está, devuelve 500 claro.
let _pay: PollarPayClient | null = null;
function getPay(): PollarPayClient {
  if (_pay) return _pay;
  if (!POLLAR_API_KEY) {
    throw new Error('Missing POLLAR_API_KEY env var (check Vercel → Settings → Environment Variables)');
  }
  _pay = new PollarPayClient({
    apiKey: POLLAR_API_KEY,
    baseUrl: POLLAR_BACKEND_URL,
  });
  return _pay;
}

export const app = express();

// IMPORTANTE: /webhook necesita el body RAW para verificar HMAC, no JSON parseado.
// Si lo parseamos primero, el `JSON.stringify(req.body)` puede diferir del payload
// original (orden de keys, espacios) y la firma falla. Por eso usamos un middleware
// específico para esa ruta antes del express.json() global.
app.post('/webhook', express.raw({ type: 'application/json', limit: '1mb' }), (req, res) => {
  const rawBody = (req.body as Buffer).toString('utf-8');
  const timestamp = req.header('x-pollar-timestamp') || '';
  const sigHeader = req.header('x-pollar-signature') || '';
  const eventType = req.header('x-pollar-event') || 'unknown';
  const deliveryId = req.header('x-pollar-delivery-id') || null;

  // Esperamos formato "sha256=<hex>"
  const signature = sigHeader.replace(/^sha256=/, '');

  let signatureValid = false;
  if (POLLAR_WEBHOOK_SECRET && signature && timestamp) {
    const expected = createHmac('sha256', POLLAR_WEBHOOK_SECRET)
      .update(`${timestamp}.${rawBody}`)
      .digest('hex');
    try {
      signatureValid =
        expected.length === signature.length &&
        timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    } catch {
      signatureValid = false;
    }
  } else if (!POLLAR_WEBHOOK_SECRET) {
    // Modo demo: si no hay secret configurado, aceptamos pero marcamos como no-verificado
    signatureValid = false;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    payload = { _raw: rawBody.slice(0, 500) };
  }

  // Si está el secret pero la firma no matchea, rechazamos.
  // Esto es lo que un comercio real debería hacer en producción.
  if (POLLAR_WEBHOOK_SECRET && !signatureValid) {
    console.warn('[WEBHOOK] firma inválida — rechazado');
    return res.status(401).json({ error: 'invalid signature' });
  }

  // Guardar en memoria para mostrar en /eventos
  RECENT_EVENTS.unshift({
    received_at: new Date().toISOString(),
    event_type: eventType,
    delivery_id: deliveryId,
    signature_valid: signatureValid,
    payload,
  });
  if (RECENT_EVENTS.length > MAX_RECENT_EVENTS) RECENT_EVENTS.length = MAX_RECENT_EVENTS;

  console.log(`[WEBHOOK] ${eventType} recibido (firma ${signatureValid ? 'OK' : 'no-verificada'})`);
  res.json({ received: true });
});

app.use(express.json());

// Healthcheck — útil para diagnosticar env vars sin tocar Pollar
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    has_api_key: Boolean(POLLAR_API_KEY),
    has_backend_url: Boolean(POLLAR_BACKEND_URL),
    has_cron_secret: Boolean(CRON_SECRET),
    has_webhook_secret: Boolean(POLLAR_WEBHOOK_SECRET),
    backend_url: POLLAR_BACKEND_URL || null,
  });
});

// Lista de eventos recibidos (JSON) — la consume la página /eventos
app.get('/api/webhook/events', (_req, res) => {
  res.json({
    has_secret: Boolean(POLLAR_WEBHOOK_SECRET),
    events: RECENT_EVENTS,
  });
});

// En local, Express sirve también los static (para usar npm run dev sin Vercel).
// En Vercel los static los sirve el CDN directamente desde public/ — esto se
// monta solo si el directorio existe (en serverless puede no estar accesible).
import { existsSync, readFileSync, readdirSync } from 'fs';
const publicDir = resolve(__dirname, '../public');
if (existsSync(publicDir)) {
  app.use(express.static(publicDir));
}

// En Vercel, los rewrites pueden mandar / al handler (FUNCTION_INVOCATION_FAILED
// si no hay match). Servimos index.html y checkout.html inline desde el bundle
// para que funcione sin depender de filesystem en serverless.
function loadHtml(name: string): string {
  const candidates = [
    resolve(__dirname, '../public', name),
    resolve(process.cwd(), 'public', name),
    resolve(process.cwd(), name),
  ];
  for (const c of candidates) {
    try { return readFileSync(c, 'utf-8'); } catch { /* try next */ }
  }
  return `<!DOCTYPE html><html><body><h1>${name} not found</h1><p>Tried: ${candidates.join(', ')}</p></body></html>`;
}

let _indexHtml: string | null = null;
let _checkoutHtml: string | null = null;
let _eventosHtml: string | null = null;
function getIndexHtml(): string {
  if (_indexHtml === null) _indexHtml = loadHtml('index.html');
  return _indexHtml;
}
function getCheckoutHtml(): string {
  if (_checkoutHtml === null) _checkoutHtml = loadHtml('checkout.html');
  return _checkoutHtml;
}
function getEventosHtml(): string {
  if (_eventosHtml === null) _eventosHtml = loadHtml('eventos.html');
  return _eventosHtml;
}

app.get('/', (_req, res) => {
  try {
    res.type('html').send(getIndexHtml());
  } catch (e: any) {
    res.status(500).json({ error: 'getIndexHtml failed', message: e?.message, stack: e?.stack });
  }
});

// Endpoint de diagnóstico para ver qué hay en el filesystem serverless
app.get('/api/debug', (_req, res) => {
  let files: string[] | string = 'publicDir does not exist';
  try {
    if (existsSync(publicDir)) {
      files = readdirSync(publicDir);
    }
  } catch (e: any) {
    files = `error: ${e.message}`;
  }
  res.json({
    __dirname,
    cwd: process.cwd(),
    publicDir,
    publicDirExists: existsSync(publicDir),
    cwdPublicExists: existsSync(resolve(process.cwd(), 'public')),
    files,
  });
});

// ─── Endpoints API ───────────────────────────────────────────────────────────

app.get('/api/products', (_req, res) => {
  res.json({ products: CATALOG });
});

app.post('/api/checkout', async (req, res) => {
  const { productId } = req.body;
  const product = CATALOG.find(p => p.id === productId);
  if (!product) {
    return res.status(404).json({ error: 'Producto no existe' });
  }
  try {
    const intent = await getPay().createIntent(product.price, `Pago de ${product.name}`);
    // El SDK arma la URI SEP-7. Se la mandamos lista al browser para no
    // duplicar el builder en checkout.js. Cualquier wallet Stellar la entiende.
    const sep7_uri = buildSep7PayUri(intent.data);
    res.json({
      transaction_id: intent.data.transaction_id,
      wallet_address: intent.data.wallet_address,
      amount: intent.data.amount,
      asset: intent.data.asset,
      network: intent.data.network,
      expires_at: intent.data.expires_at,
      sep7_uri,
      product: { name: product.name, image: product.image },
    });
  } catch (e: any) {
    const code = e instanceof PollarPayError ? e.code : 'UNKNOWN';
    res.status(500).json({ error: e.message, code });
  }
});

// Reconstruye la URI SEP-7 a partir del status. Útil cuando el cliente entra
// directo a /checkout/:id (sharing de link) sin haber pasado por POST /api/checkout.
app.get('/api/checkout/:id/sep7', async (req, res) => {
  try {
    const pay = getPay();
    const status = await pay.checkStatus(req.params.id);
    const sep7_uri = buildSep7PayUri({
      destination: status.data.wallet_address,
      amount: status.data.amount_expected,
      network: pay.network,
    });
    res.json({ sep7_uri });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/checkout/:id/status', async (req, res) => {
  try {
    const pay = getPay();
    const status = await pay.checkStatus(req.params.id);
    // Adjuntamos el link al explorer si ya hay forward_tx_hash — así el browser
    // no tiene que conocer el formato de Stellar Expert.
    const explorer_url = status.data.forward_tx_hash
      ? buildStellarExpertTxUrl(status.data.forward_tx_hash, pay.network)
      : null;
    res.json({ ...status.data, network: pay.network, explorer_url });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/checkout/:id/verify', async (req, res) => {
  let cronResult: any = { skipped: true };
  if (CRON_SECRET && POLLAR_BACKEND_URL) {
    try {
      const cronUrl = POLLAR_BACKEND_URL.replace(/\/api$/, '') + '/api/cron/check-payments';
      const cronRes = await fetch(cronUrl, { headers: { 'x-cron-secret': CRON_SECRET } });
      cronResult = await cronRes.json();
    } catch (e: any) {
      cronResult = { error: e.message };
    }
  }
  try {
    const pay = getPay();
    const status = await pay.checkStatus(req.params.id);
    const explorer_url = status.data.forward_tx_hash
      ? buildStellarExpertTxUrl(status.data.forward_tx_hash, pay.network)
      : null;
    res.json({ cron: cronResult, status: { ...status.data, network: pay.network, explorer_url } });
  } catch (e: any) {
    res.status(500).json({ error: e.message, cron: cronResult });
  }
});

// Servir checkout.html para rutas dinámicas /checkout/:id.
// En Vercel el rewrite a /checkout.html funciona como static, pero si por algún
// motivo cae acá, servimos inline para no FUNCTION_INVOCATION_FAILED.
app.get('/checkout/:id', (_req, res) => {
  res.type('html').send(getCheckoutHtml());
});

// Página de debug que muestra los webhooks recibidos en este Express.
// El JS de la página consume /api/webhook/events.
app.get('/eventos', (_req, res) => {
  res.type('html').send(getEventosHtml());
});

// Catch-all para diagnostico: si algo cae acá en Vercel, devuelve JSON con
// info útil en vez de FUNCTION_INVOCATION_FAILED.
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found in function',
    path: req.path,
    method: req.method,
    hint: 'This path should not reach the function — check vercel.json rewrites',
  });
});

// Error handler — si algo throwea, devuelve JSON en vez de crashear la función
app.use((err: Error, _req: any, res: any, _next: any) => {
  console.error('[express error]', err);
  res.status(500).json({ error: err.message, stack: err.stack });
});

// Default export para que Vercel pueda invocar este módulo directamente
// (algunas configuraciones del proyecto tratan a src/app.ts como handler).
export default app;
