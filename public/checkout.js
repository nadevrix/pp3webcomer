// ─── checkout.js ─────────────────────────────────────────────────────────────
// Frontend del checkout — NO usa el SDK directo ni la apiKey.
// Habla solo con el Express backend, que tiene el SDK y ya devuelve:
//   - `sep7_uri`     → URI que va al QR (armada con buildSep7PayUri del SDK)
//   - `explorer_url` → link a Stellar Expert cuando hay forward_tx_hash
// Así el browser queda simple y la lógica de Stellar vive en el SDK.

const transactionId = location.pathname.split('/').pop();
const $ = (id) => document.getElementById(id);

let pollInterval = null;
let expiresAt = null;
let timerInterval = null;

function renderQR(uri) {
  const qr = qrcode(0, 'M');
  qr.addData(uri);
  qr.make();
  $('qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 4 });
}

function setStatus(cls, text) {
  $('status-dot').className = `status-dot status-${cls}`;
  $('status-text').textContent = text;
}

function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    if (!expiresAt) return;
    const ms = expiresAt - Date.now();
    if (ms <= 0) {
      $('timer').textContent = '(expirado)';
      clearInterval(timerInterval);
      return;
    }
    const total = Math.floor(ms / 1000);
    const m = String(Math.floor(total / 60)).padStart(2, '0');
    const s = String(total % 60).padStart(2, '0');
    $('timer').textContent = `(expira en ${m}:${s})`;
  }, 1000);
}

function showCompleted(status) {
  $('state-pending').style.display = 'none';
  $('state-done').style.display = 'block';
  $('paid-amount').textContent = status.amount_paid;
  if (status.explorer_url) {
    $('explorer-link').href = status.explorer_url;
  }

  // Desglose fee/neto — el backend agrega fee_amount y payout_amount cuando la
  // tx se cierra. Si entró dentro de las 50 gratuitas del tier Free, fee=0 y
  // mostramos "GRATIS".
  const fee = parseFloat(status.fee_amount || '0');
  const payout = parseFloat(status.payout_amount || '0');
  if (fee > 0 || status.is_free_tx) {
    $('fee-breakdown').style.display = 'flex';
    $('fee-amount').textContent = status.is_free_tx ? 'GRATIS' : `${fee.toFixed(2)} USDC`;
    $('payout-amount').textContent = `${payout > 0 ? payout.toFixed(2) : status.amount_paid} USDC`;
  }

  if (pollInterval) clearInterval(pollInterval);
  if (timerInterval) clearInterval(timerInterval);
}

function showFailed(status, customMsg) {
  $('state-pending').style.display = 'none';
  $('state-fail').style.display = 'block';
  $('fail-title').textContent = `Estado: ${status.status}`;
  $('fail-message').textContent = customMsg ||
    (status.support?.message || 'El pago no se completó dentro del tiempo permitido.');
  if (pollInterval) clearInterval(pollInterval);
  if (timerInterval) clearInterval(timerInterval);
}

function applyStatus(status) {
  if (status.status === 'completed' || status.status === 'overpaid') {
    showCompleted(status);
  } else if (
    status.status === 'expired' ||
    status.status === 'underpaid' ||
    status.status === 'anomaly' ||
    status.is_expired
  ) {
    showFailed(status);
  } else {
    setStatus(
      'pending',
      `Esperando pago... (recibido: ${status.amount_paid} / ${status.amount_expected} USDC)`,
    );
  }
}

async function loadIntent() {
  // Primera lectura del estado — el backend nos da también el SEP-7 listo.
  const res = await fetch(`/api/checkout/${transactionId}/status`);
  if (!res.ok) {
    $('product-name').textContent = 'Intent no encontrado';
    setStatus('fail', 'Error');
    return;
  }
  const intent = await res.json();
  $('product-name').textContent = intent.reason || 'Pago';
  $('product-emoji').textContent = '☕';
  $('amount').textContent = `${intent.amount_expected} USDC`;
  $('wallet-addr').textContent = intent.wallet_address;
  $('manual-amount').textContent = `${intent.amount_expected} USDC`;

  expiresAt = new Date(intent.expires_at).getTime();
  startTimer();

  // El SEP-7 viene desde /api/checkout (POST). Si entraste directo a /checkout/:id
  // sin pasar por la home, hay un segundo origen: el handler reconstruye el SEP-7
  // a pedido. Acá pedimos /sep7 si no tenemos uno todavía.
  let sep7Uri = intent.sep7_uri;
  if (!sep7Uri) {
    try {
      const r = await fetch(`/api/checkout/${transactionId}/sep7`);
      if (r.ok) sep7Uri = (await r.json()).sep7_uri;
    } catch { /* fallback abajo */ }
  }
  if (sep7Uri) {
    renderQR(sep7Uri);
  } else {
    // Último recurso: dejamos visible la dirección y el monto a mano.
    $('qr').textContent = 'Pegá la dirección y el monto en tu wallet manualmente.';
  }

  applyStatus(intent);

  // Polling cada 5s
  pollInterval = setInterval(async () => {
    const r = await fetch(`/api/checkout/${transactionId}/status`);
    if (r.ok) applyStatus(await r.json());
  }, 5000);
}

$('btn-verify').addEventListener('click', async () => {
  const btn = $('btn-verify');
  btn.disabled = true;
  btn.textContent = 'Verificando...';
  try {
    const res = await fetch(`/api/checkout/${transactionId}/verify`, { method: 'POST' });
    const data = await res.json();
    if (data.status) applyStatus(data.status);
  } catch (e) {
    console.error(e);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Verificar pago';
  }
});

loadIntent();
