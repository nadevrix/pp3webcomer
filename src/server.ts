// ─────────────────────────────────────────────────────────────────────────────
//  Entry point para LOCAL DEV — corre el Express app en un puerto.
//  En Vercel se usa api/index.ts en lugar de este archivo.
// ─────────────────────────────────────────────────────────────────────────────

import { app } from './app.js';

const PORT = parseInt(process.env.PORT || '4000');

app.listen(PORT, () => {
  console.log(`☕ Café Polar — checkout web corriendo en http://localhost:${PORT}`);
});
