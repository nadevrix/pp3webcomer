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

config({ path: resolve(__dirname, '../.env') });

const POLLAR_API_KEY = process.env.POLLAR_API_KEY;
const POLLAR_BACKEND_URL = process.env.POLLAR_BACKEND_URL;
const CRON_SECRET = process.env.CRON_SECRET;

if (!POLLAR_API_KEY) {
  throw new Error('Falta POLLAR_API_KEY en las variables de entorno');
}

// ─── Catálogo (en producción vendría de una DB) ──────────────────────────────
const CATALOG = [
  { id: 1, name: 'Espresso',       price: 2.50,  image: '☕' },
  { id: 2, name: 'Cappuccino',     price: 4.00,  image: '☕' },
  { id: 3, name: 'Premium Latte',  price: 5.50,  image: '🥛' },
  { id: 4, name: 'Bolsa de café (250g)', price: 18.00, image: '📦' },
];

const pay = new PollarPayClient({
  apiKey: POLLAR_API_KEY,
  baseUrl: POLLAR_BACKEND_URL,
});

export const app = express();
app.use(express.json());

// En local, Express sirve también los static. En Vercel, los static los sirve
// Vercel CDN automáticamente desde public/ — esto queda como no-op.
app.use(express.static(resolve(__dirname, '../public')));

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
    const intent = await pay.createIntent(product.price, `Pago de ${product.name}`);
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
    const status = await pay.checkStatus(req.params.id);
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
    const status = await pay.checkStatus(req.params.id);
    res.json({ cron: cronResult, status: status.data });
  } catch (e: any) {
    res.status(500).json({ error: e.message, cron: cronResult });
  }
});

// Servir checkout.html para rutas dinámicas /checkout/:id (solo local; en
// Vercel esto lo hace un rewrite en vercel.json, pero dejarlo no molesta).
app.get('/checkout/:id', (_req, res) => {
  res.sendFile(resolve(__dirname, '../public/checkout.html'));
});
