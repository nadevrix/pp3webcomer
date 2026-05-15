// ─────────────────────────────────────────────────────────────────────────────
//  Entry point para VERCEL serverless.
//  Exporta el Express app como handler default — Vercel lo invoca por request.
// ─────────────────────────────────────────────────────────────────────────────

import { app } from '../src/app.js';

export default app;
