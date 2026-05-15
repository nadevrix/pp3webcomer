// ─────────────────────────────────────────────────────────────────────────────
//  Express app — sin .listen()
//
//  Se importa desde dos lugares:
//    - src/server.ts  → para local dev (corre con .listen())
//    - api/index.ts   → para Vercel serverless (export default como handler)
// ─────────────────────────────────────────────────────────────────────────────

import { config } from 'dotenv';
import express from 'express';
import { PollarPayClient, PollarPayError } from './sdk/index.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// dotenv solo aplica en local; en Vercel las env vars vienen del dashboard.
try {
  config({ path: resolve(__dirname, '../.env') });
} catch { /* sin .env local — ok */ }

const POLLAR_API_KEY = process.env.POLLAR_API_KEY;
const POLLAR_BACKEND_URL = process.env.POLLAR_BACKEND_URL;
const CRON_SECRET = process.env.CRON_SECRET;

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
app.use(express.json());

// Healthcheck — útil para diagnosticar env vars sin tocar Pollar
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    has_api_key: Boolean(POLLAR_API_KEY),
    has_backend_url: Boolean(POLLAR_BACKEND_URL),
    has_cron_secret: Boolean(CRON_SECRET),
    backend_url: POLLAR_BACKEND_URL || null,
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
function getIndexHtml(): string {
  if (_indexHtml === null) _indexHtml = loadHtml('index.html');
  return _indexHtml;
}
function getCheckoutHtml(): string {
  if (_checkoutHtml === null) _checkoutHtml = loadHtml('checkout.html');
  return _checkoutHtml;
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
    res.json({
      transaction_id: intent.data.transaction_id,
      wallet_address: intent.data.wallet_address,
      amount: intent.data.amount,
      asset: intent.data.asset,
      network: intent.data.network,
      expires_at: intent.data.expires_at,
      product: { name: product.name, image: product.image },
    });
  } catch (e: any) {
    const code = e instanceof PollarPayError ? e.code : 'UNKNOWN';
    res.status(500).json({ error: e.message, code });
  }
});

app.get('/api/checkout/:id/status', async (req, res) => {
  try {
    const status = await getPay().checkStatus(req.params.id);
    res.json(status.data);
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
    const status = await getPay().checkStatus(req.params.id);
    res.json({ cron: cronResult, status: status.data });
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
