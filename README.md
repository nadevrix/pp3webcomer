# Café Polar — Checkout Web (demo del SDK `@pollar/pay`)

Demo end-to-end de una **tienda online** integrando Pollar Pay.
Estilo "Stripe Checkout" pero para pagos en USDC sobre Stellar.

Es la referencia oficial de cómo se usa el SDK desde un backend real:
la `apiKey` vive **solo en el server**, el browser nunca la ve.

---

## Qué hace

1. Servís un catálogo en `/`.
2. El cliente clickea "Comprar" → `POST /api/checkout` crea un cobro con el SDK.
3. Redirigís a `/checkout/:id` que muestra:
   - QR escaneable (formato **SEP-7** — Binance, Meru, Lobstr, Freighter lo entienden)
   - Monto, dirección destino, timer de 15 min
   - Botón "Verificar pago" (workaround para Vercel Hobby sin cron)
4. El cliente paga desde su wallet → Stellar liquida en 3-5 s.
5. El frontend polea `/api/checkout/:id/status` cada 5 s. Cuando se detecta el pago, transiciona a "✅ Pago recibido" con desglose fee/neto y link a Stellar Expert.

---

## Cómo está armado

```
┌────────────────┐    ┌────────────────────────┐    ┌──────────────────────┐
│  Browser       │    │  Express server        │    │  Pollar Pay API      │
│  (cliente)     │    │  (merchant — con SDK)  │    │  (backend HTTPS)     │
└────────────────┘    └────────────────────────┘    └──────────────────────┘
        │                       │                              │
        │  GET /                │                              │
        │ ────────────────────► │  sirve index.html            │
        │                       │                              │
        │  POST /api/checkout   │                              │
        │ ────────────────────► │  pay.createIntent()          │
        │                       │  buildSep7PayUri()           │
        │                       │ ───────────────────────────► │
        │                       │                              │
        │       { tx_id, sep7_uri, ... } ◄───────────────────  │
        │ ◄──────────────────── │                              │
        │                       │                              │
        │  redirect /checkout/:id                              │
        │  renderQR(sep7_uri)                                  │
        │                       │                              │
        │  poll /:id/status     │                              │
        │ ────────────────────► │  pay.checkStatus()           │
        │                       │ ───────────────────────────► │
        │       { status, fee, payout, explorer_url }          │
        │ ◄──────────────────── │ ◄──────────────────────────  │
```

**Importante:**
- La `apiKey` solo vive en el backend Express.
- El backend usa los helpers `buildSep7PayUri()` y `buildStellarExpertTxUrl()` del SDK para que el browser no tenga que conocer issuers ni passphrases.

---

## Setup

```bash
npm install
cp .env.example .env
# Editar .env con tu POLLAR_API_KEY
npm run dev
```

Abre `http://localhost:4000` — ves el catálogo, clickeás un producto, te lleva al checkout con QR.

### Variables de entorno

| Variable | Para qué |
|---|---|
| `POLLAR_API_KEY` | API key publishable de la sucursal (`pub_testnet_…` o `pub_mainnet_…`) |
| `POLLAR_BACKEND_URL` | URL del backend Pollar Pay (autoresuelta si no la pasás) |
| `CRON_SECRET` | Workaround Vercel Hobby: dispara cron manual desde "Verificar pago" |
| `POLLAR_WEBHOOK_SECRET` | (Opcional) Secret HMAC para verificar firmas de webhooks |
| `PORT` | Puerto local (default 4000) |

---

## Endpoints del backend

| Endpoint | Para qué |
|---|---|
| `GET /` | Página catálogo |
| `GET /api/products` | Lista productos (JSON) |
| `POST /api/checkout` | Crea intent vía SDK → devuelve `transaction_id` + `sep7_uri` |
| `GET /api/checkout/:id/sep7` | Reconstruye `sep7_uri` (útil si entrás directo al link) |
| `GET /api/checkout/:id/status` | Status actual + `explorer_url` si ya hay forward_tx_hash |
| `POST /api/checkout/:id/verify` | Workaround Hobby: dispara cron + chequea status |
| `POST /webhook` | Receptor de webhooks de Pollar (verifica firma HMAC) |
| `GET /eventos` | Página de debug que muestra los webhooks recibidos |
| `GET /api/webhook/events` | JSON de los webhooks recibidos en memoria |

---

## Estructura

```
merchant-checkout-web/
├── src/
│   ├── app.ts          ← Express con SDK (handlers + webhook receiver)
│   ├── server.ts       ← Entry local (con .listen)
│   └── sdk/            ← Copia local del SDK (espejo de pollar-sdk/)
│       ├── index.ts
│       ├── client.ts
│       ├── stellar.ts  ← buildSep7PayUri, buildStellarExpertTxUrl, etc.
│       └── types.ts
├── api/
│   └── handler.ts      ← Entry Vercel serverless
├── public/
│   ├── index.html      ← catálogo
│   ├── checkout.html   ← QR + status + verify
│   ├── checkout.js     ← polling con fetch (sin SDK ni apiKey en el browser)
│   ├── eventos.html    ← debug de webhooks
│   ├── eventos.js
│   └── styles.css
├── vercel.json
└── tsconfig.json
```

---

## Por qué hay una copia del SDK en `src/sdk/`

Es un demo. Lo dejamos auto-contenido para que cualquiera lo clone, ponga la
apiKey y arranque sin tener que linkear paquetes.

La carpeta es **espejo** del paquete publicado [`@pollar/pay`](../pollar-sdk).
En producción real, usás:

```bash
npm install @pollar/pay
```

y reemplazás los imports `./sdk/index.js` por `@pollar/pay`.

---

## Helpers del SDK que se usan acá

- **`buildSep7PayUri(intent)`** — arma la URI `web+stellar:pay?…` que cualquier wallet Stellar entiende. Devuelta al browser en `POST /api/checkout` y reconstruida bajo demanda en `GET /:id/sep7`.
- **`buildStellarExpertTxUrl(hash, network)`** — link al hash en el explorer. Se adjunta al status response.
- **`PollarPayClient.network`** — getter que el server usa para no andar pasando la red en cada llamada.

El frontend (`checkout.js`) queda simple: solo consume el JSON y dibuja.

---

## Verificación de webhooks

Si configurás `POLLAR_WEBHOOK_SECRET`, el endpoint `POST /webhook` valida HMAC SHA-256:

```
signature = HMAC_SHA256(secret, `${timestamp}.${rawBody}`)
```

El header `x-pollar-signature` debe venir como `sha256=<hex>`. Si la firma no
matchea, devuelve `401`. Si no hay secret configurado, acepta todo (modo demo).

Visitá `/eventos` para ver los últimos 50 webhooks recibidos.
