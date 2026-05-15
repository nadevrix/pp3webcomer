// Página simple que muestra los webhooks recibidos. Refresca cada 3 segundos.
// Útil para verificar end-to-end que el webhook llegó y la firma se validó.

const $ = (id) => document.getElementById(id);

document.getElementById('webhook-url-hint').textContent = `${location.origin}/webhook`;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch { return iso; }
}

async function load() {
  let data;
  try {
    const res = await fetch('/api/webhook/events');
    data = await res.json();
  } catch (e) {
    $('events').innerHTML = `<div class="empty">Error: ${e.message}</div>`;
    return;
  }

  const status = data.has_secret
    ? '🔒 POLLAR_WEBHOOK_SECRET configurado — se verifica HMAC en cada webhook.'
    : '⚠️ POLLAR_WEBHOOK_SECRET no configurado — los webhooks llegan pero no se verifica firma. Solo demo.';
  $('status-line').textContent = status;

  if (!data.events || data.events.length === 0) {
    $('events').innerHTML = `
      <div class="empty">
        Aún no llegó ningún webhook a este servidor. Dispará un cobro o usá el botón "Probar"
        en /dashboard/avanzado del lado de Pollar.
      </div>
    `;
    return;
  }

  $('events').innerHTML = data.events.map(ev => {
    const sigBadge = ev.signature_valid
      ? '<span class="badge-ok">firma válida</span>'
      : '<span class="badge-warn">firma no verificada</span>';
    return `
      <article class="event">
        <header>
          <span class="event-type">${escapeHtml(ev.event_type)}</span>
          ${sigBadge}
          <span class="event-date">${fmtDate(ev.received_at)}</span>
        </header>
        ${ev.delivery_id ? `<div class="event-meta">delivery: <code>${escapeHtml(ev.delivery_id)}</code></div>` : ''}
        <pre class="event-payload">${escapeHtml(JSON.stringify(ev.payload, null, 2))}</pre>
      </article>
    `;
  }).join('');
}

load();
setInterval(load, 3000);
