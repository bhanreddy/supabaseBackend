function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function money(value, currency = 'INR') {
    const amount = Number(value || 0);
    return new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: currency || 'INR',
        minimumFractionDigits: 2,
    }).format(Number.isFinite(amount) ? amount : 0);
}

function date(value) {
    if (!value) return '—';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime())
        ? escapeHtml(value)
        : new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' }).format(parsed);
}

function lineItems(payload) {
    const items = Array.isArray(payload.line_items) ? payload.line_items : [];
    if (!items.length) {
        return `<tr><td>1</td><td>Subscription payment</td><td class="right">1</td><td class="right">${money(payload.total_amount, payload.currency)}</td></tr>`;
    }
    return items.map((item, index) => `<tr>
        <td>${index + 1}</td>
        <td>${escapeHtml(item.description || 'Subscription payment')}</td>
        <td class="right">${escapeHtml(item.quantity ?? 1)}</td>
        <td class="right">${money(item.amount ?? Number(item.quantity || 1) * Number(item.rate || 0), payload.currency)}</td>
    </tr>`).join('');
}

/** Render the immutable receipt snapshot mirrored into the school cluster. */
export function renderSubscriptionReceipt(receipt) {
    const payload = receipt.document_payload && typeof receipt.document_payload === 'object'
        ? receipt.document_payload
        : {};
    const document = { ...payload, ...receipt };
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(document.document_number || 'Subscription receipt')}</title>
<style>
  *{box-sizing:border-box}body{margin:0;background:#f1f5f9;color:#172033;font-family:Inter,system-ui,-apple-system,sans-serif}
  .page{width:min(820px,calc(100% - 32px));margin:32px auto;background:#fff;border-radius:18px;padding:42px;box-shadow:0 16px 50px #0f172a18}
  header{display:flex;justify-content:space-between;gap:24px;padding-bottom:26px;border-bottom:2px solid #e9e7ff}.brand{color:#6754e9;font-size:13px;font-weight:800;letter-spacing:.13em;text-transform:uppercase}
  h1{margin:8px 0 5px;font-size:30px}.muted{color:#64748b;font-size:13px;line-height:1.55}.number{text-align:right;font-weight:800}.grid{display:grid;grid-template-columns:1fr 1fr;gap:32px;margin:28px 0}
  .label{color:#7c8596;font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;margin-bottom:7px}.name{font-size:16px;font-weight:750;line-height:1.45}
  table{width:100%;border-collapse:collapse;margin-top:12px}th{background:#f7f7fc;color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:.08em}th,td{padding:13px 12px;border-bottom:1px solid #e5e7eb;text-align:left}.right{text-align:right}
  .total{display:flex;justify-content:flex-end;align-items:center;gap:35px;margin-top:22px;font-size:17px}.total strong{font-size:24px;color:#15152b}.paid{margin-top:28px;padding:14px 18px;border-radius:12px;background:#ecfdf5;color:#047857;font-weight:750;text-align:center}
  footer{margin-top:28px;padding-top:18px;border-top:1px solid #e5e7eb;color:#94a3b8;font-size:12px;text-align:center}@media print{body{background:#fff}.page{width:100%;margin:0;box-shadow:none;border-radius:0}}@media(max-width:600px){.page{padding:24px}.grid{grid-template-columns:1fr}header{display:block}.number{text-align:left;margin-top:16px}}
</style></head><body><main class="page">
  <header><div><div class="brand">${escapeHtml(document.supplier_legal_name || 'NexSyrus')}</div><h1>Payment Receipt</h1><div class="muted">${escapeHtml(document.supplier_address || '')}</div></div><div class="number">${escapeHtml(document.document_number || '')}<div class="muted">Issued ${date(document.issued_at || document.created_at)}</div></div></header>
  <section class="grid"><div><div class="label">Received from</div><div class="name">${escapeHtml(document.client_legal_name || 'School')}</div><div class="muted">${escapeHtml(document.client_billing_address || '')}</div></div><div><div class="label">Financial year</div><div class="name">${escapeHtml(document.financial_year || '—')}</div></div></section>
  <table><thead><tr><th>#</th><th>Description</th><th class="right">Qty</th><th class="right">Amount</th></tr></thead><tbody>${lineItems(document)}</tbody></table>
  <div class="total"><span>Total paid</span><strong>${money(document.total_amount, document.currency)}</strong></div>
  <div class="paid">Payment received successfully</div>
  <footer>This receipt was issued by NexSyrus and downloaded securely from your school portal.</footer>
</main></body></html>`;
}
