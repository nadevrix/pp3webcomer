// ─── checkout.js ─────────────────────────────────────────────────────────────
// Frontend del checkout. NO usa el SDK directo — habla con el backend Express
// que tiene el SDK y la apiKey. El backend abstrae las llamadas a Pollar.

const transactionId = location.pathname.split('/').pop();

const $ = (id) => document.getElementById(id);

const USDC_ISSUERS = {
  TESTNET: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  MAINNET: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
};

let pollInterval = null;
let expiresAt = null;
let timerInterval = null;

function buildSep7Uri(intent) {
  const issuer = USDC_ISSUERS[intent.network] || USDC_ISSUERS.TESTNET;
  return `web+stellar:pay?destination=${intent.wallet_address}` +
    `&amount=${intent.amount}` +
    `&asset_code=USDC` +
    `&asset_issuer=${issuer}` +
    `&network_passphrase=${encodeURIComponent(intent.network === 'MAINNET' ? 'Public Global Stellar Network ; September 2015' : 'Test SDF Network ; September 2015')}`;
}

function renderQR(uri) {
  const qr = qrcode(0, 'M');
  qr.addData(uri);
  qr.make();
  $('qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 4 });
}

function setStatus(status, text) {
  $('status-dot').className = `status-dot status-${status}`;
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
  if (status.forward_tx_hash) {
    const url = `https://stellar.expert/explorer/${status.is_expired || expiresAt < Date.now() ? 'testnet' : 'testnet'}/tx/${status.forward_tx_hash}`;
    $('explorer-link').href = url;
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
  } else if (status.status === 'expired' || status.status === 'underpaid' || status.status === 'anomaly' || status.is_expired) {
    showFailed(status);
  } else {
    setStatus('pending', `Esperando pago... (recibido: ${status.amount_paid} / ${status.amount_expected} USDC)`);
  }
}

async function loadIntent() {
  // Primer fetch para obtener metadata + status inicial
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

  renderQR(buildSep7Uri({
    wallet_address: intent.wallet_address,
    amount: intent.amount_expected,
    network: 'TESTNET',
  }));

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
