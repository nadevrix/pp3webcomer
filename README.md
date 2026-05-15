# Café Polar — Checkout Web (demo del SDK)

Demo de **aplicación web del comercio** que integra el SDK `@pollar/pay`.
Estilo "Stripe Checkout" pero para crypto/USDC sobre Stellar.

## Arquitectura

```
Browser (cliente)                Express server (merchant)              Pollar Backend
─────────────────                ──────────────────────                  ──────────────
GET /                ────────►   sirve index.html
GET /api/products    ────────►   responde catálogo
POST /api/checkout   ────────►   pay.createIntent()    ────────────►   POST /sdk/pay
                     ◄────────   transaction_id                    ◄───  intent + wallet
redirect /checkout/:id
GET /checkout/:id    ────────►   sirve checkout.html
GET /api/.../status  ─polling►   pay.checkStatus()     ────────────►   GET /sdk/status
                     ◄────────   status                            ◄───  status
POST /api/.../verify ────────►   curl cron + status    ────────────►   POST /cron/check-payments
```

**Importante**: la `apiKey` solo vive en el backend Express. El browser nunca la ve.

## Setup

```bash
npm install
cp .env.example .env
# Editar .env con tu POLLAR_API_KEY
npm run dev
```

Abre http://localhost:4000 — ves el catálogo, clickeás un producto, te lleva al checkout con QR.

## Flujo end-to-end real

1. Cliente entra a la tienda (http://localhost:4000)
2. Click en "Cappuccino — 4.00 USDC"
3. Pantalla de checkout muestra:
   - QR escaneable (formato SEP-7 — todas las wallets Stellar lo entienden)
   - Wallet address + monto para pago manual
   - Status en vivo ("Esperando pago...")
   - Botón "Verificar pago"
   - Timer de 15 minutos
4. Cliente escanea QR con Lobstr/Freighter
5. Wallet auto-completa los campos, cliente confirma → pago va a Stellar
6. Frontend hace polling cada 5s al backend
7. Cuando se detecta el pago → transiciona a "✅ Pago recibido" con link al explorer

## Endpoints del backend

| Endpoint | Para qué |
|---|---|
| `GET /` | Página catálogo |
| `GET /api/products` | Lista productos (JSON) |
| `POST /api/checkout` | Crea intent vía SDK → devuelve transaction_id |
| `GET /checkout/:id` | Página de checkout |
| `GET /api/checkout/:id/status` | Status actual del intent |
| `POST /api/checkout/:id/verify` | Workaround Hobby: dispara cron + chequea status |

## Estructura

```
merchant-checkout-web/
├── src/server.ts        ← Express backend con SDK
├── public/
│   ├── index.html       ← catálogo
│   ├── checkout.html    ← QR + status + verify
│   ├── checkout.js      ← polling con fetch (no usa SDK directo)
│   └── styles.css
├── package.json
├── tsconfig.json
└── .env
```

## Diferencias vs merchant-demo (CLI)

| Aspecto | merchant-demo (CLI) | merchant-checkout-web |
|---|---|---|
| Para qué tipo de comercio | POS físico / scripts internos | Tienda online (e-commerce) |
| Visualización | ASCII en terminal | UI completa en browser |
| QR | Renderizado en ASCII | SVG visual escaneable |
| Quién usa el SDK | Directo en el CLI | Solo el backend Express |
| Quién ve la apiKey | El que corre el script | NADIE en el browser |
| Realismo de prod | Bajo (devs internos) | Alto (estilo Stripe Checkout) |
