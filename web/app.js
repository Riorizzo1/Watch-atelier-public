async function getJson(url) {
  const res = await fetch(url);
  return res.json();
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

function money(n) {
  const num = Number(n || 0);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(num);
}

let latestWatches = [];
let currentEditWatchId = '';
let editorMode = 'edit';
let tradeMode = 'sell';

function renderSummary(summary) {
  const root = document.getElementById('summary');
  const netSales = Number(summary.totals.net_sales || 0);
  const items = [
    ['On hand', summary.counts.on_hand],
    ['Retail on hand', money(summary.totals.retail_on_hand)],
    ['Net paid in', money(summary.totals.net_paid)],
    ['Net sales', `${netSales > 0 ? '+' : ''}${money(netSales)}`],
  ];
  root.innerHTML = items.map(([label, value]) => `
    <div class="summary-card">
      <div class="summary-label">${label}</div>
      <div class="summary-value">${value}</div>
    </div>
  `).join('');
}

function historyMarkup(w) {
  const blocks = [];
  if (w.trade_result) {
    blocks.push(`<div class="event-block event-block-${w.trade_result}"><div class="event-title">Trade ${w.trade_result}</div><div class="event-detail">${money(w.trade_out_value || w.paid_value)} → ${money(w.trade_in_value || 0)}</div><div class="event-delta">${w.trade_delta > 0 ? '+' : ''}${money(w.trade_delta)} ${w.traded_for_label ? `• ${w.traded_for_label}` : ''}</div></div>`);
  }
  if (w.sale_result) {
    blocks.push(`<div class="event-block event-block-${w.sale_result}"><div class="event-title">Sale ${w.sale_result}</div><div class="event-detail">${money(w.paid_value)} → ${money(w.sold_value)}</div><div class="event-delta">${w.sale_delta > 0 ? '+' : ''}${money(w.sale_delta)}</div></div>`);
  }
  if (w.linked_trade_from_watch_id) {
    blocks.push(`<div class="event-block"><div class="event-title">Trade origin</div><div class="event-detail">Received from linked trade chain</div></div>`);
  }
  return blocks.join('');
}

function tileMarkup(w, idx, kind = 'onhand') {
  const hasStructuredHistory = Boolean(w.trade_result || Number(w.sold_value || 0) || w.linked_trade_from_watch_id);
  const title = [w.reference, w.model].filter(Boolean).join(' ').trim() || `${w.brand} ${w.model}`;
  const faceValue = Number(w.trade_in_value || 0) > 0 && w.status === 'on_hand' ? Number(w.trade_in_value) : Number(w.paid_value || 0);
  return `
    <div class="catalog-tile ${hasStructuredHistory ? 'catalog-tile-has-history' : ''}" data-card-index="${kind}-${idx}">
      <div class="catalog-frame catalog-history-toggle" data-history-card="${kind}-${idx}">
        <div class="catalog-image">${w.web_image ? `<img src="${w.web_image}" alt="${w.brand} ${w.model}" loading="lazy" onerror="this.parentElement.classList.add('image-fallback'); this.remove();">` : ''}</div>
      </div>
      <div class="catalog-meta">${w.brand.toUpperCase()}${w.factory ? ` | ${w.factory.toUpperCase()}` : ''}</div>
      <div class="catalog-title">${title}</div>
      <div class="catalog-value">${money(faceValue)}</div>
      <div class="catalog-subline">
        <span>${w.status.replace('_', ' ')}</span>
        ${w.trade_result ? `<span class="catalog-marker catalog-marker-${w.trade_result}">${w.trade_result === 'win' ? `+${money(w.trade_delta)}` : w.trade_result === 'loss' ? `-${money(Math.abs(w.trade_delta))}` : 'Even trade'}</span>` : ''}
      </div>
      <div class="catalog-actions ${hasStructuredHistory ? 'catalog-actions-has-details' : 'catalog-actions-no-details'}">
        ${hasStructuredHistory ? `<button class="history-cue catalog-history-cue" data-history-card="${kind}-${idx}" type="button">Details</button>` : ''}
        <div class="catalog-action-group">
          <button class="catalog-action-btn catalog-edit-btn" data-edit-card="${kind}-${idx}" type="button">Edit</button>
          ${kind === 'onhand' ? `<button class="catalog-action-btn catalog-action-btn-primary" data-trade-card="${kind}-${idx}" type="button">Trade / Sell</button>` : ''}
        </div>
      </div>
      ${hasStructuredHistory ? `<div class="history-drawer hidden" id="history-${kind}-${idx}">${historyMarkup(w)}</div>` : ''}
    </div>
  `;
}

function openModal() {
  const modal = document.getElementById('editorModal');
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
}

function closeModal() {
  const modal = document.getElementById('editorModal');
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  document.getElementById('formStatus').textContent = '';
  document.getElementById('uploadStatus').textContent = '';
  document.getElementById('tradeFlowFields').classList.add('hidden');
  document.getElementById('tradeFlowFields').innerHTML = '';
  editorMode = 'edit';
  tradeMode = 'sell';
}

function renderTradeFlowFields(watch = {}) {
  const root = document.getElementById('tradeFlowFields');
  if (editorMode !== 'trade_sell') {
    root.classList.add('hidden');
    root.innerHTML = '';
    return;
  }
  root.classList.remove('hidden');
  root.innerHTML = `
    <label><span>Trade flow</span>
      <select id="tradeModeField">
        <option value="sell" ${tradeMode === 'sell' ? 'selected' : ''}>Sell this watch</option>
        <option value="trade_new" ${tradeMode === 'trade_new' ? 'selected' : ''}>Trade for new watch</option>
      </select>
    </label>
    <label><span>Trade out value</span><input id="tradeOutFlow" type="number" step="0.01" value="${watch.trade_out_value || watch.paid_value || ''}" /></label>
    <label><span>Trade in value</span><input id="tradeInFlow" type="number" step="0.01" value="${watch.trade_in_value || ''}" /></label>
    ${tradeMode === 'trade_new' ? `
      <label><span>New watch brand</span><input id="tradeNewBrand" value="" /></label>
      <label><span>New watch model</span><input id="tradeNewModel" value="" /></label>
      <label><span>New watch factory</span><input id="tradeNewFactory" value="" /></label>
      <label><span>New watch reference</span><input id="tradeNewReference" value="" /></label>
      <label class="full-span"><span>New watch notes</span><textarea id="tradeNewNotes" rows="3"></textarea></label>
    ` : ''}
  `;
  document.getElementById('tradeModeField').addEventListener('change', e => {
    tradeMode = e.target.value;
    renderTradeFlowFields(watch);
  });
}

function fillEditor(watch, mode = 'edit') {
  const form = document.getElementById('watchForm');
  currentEditWatchId = watch.id || '';
  editorMode = mode;
  form.elements.id.value = watch.id || '';
  form.elements.brand.value = watch.brand || '';
  form.elements.model.value = watch.model || '';
  form.elements.factory.value = watch.factory || '';
  form.elements.paid_value.value = watch.paid_value || '';
  form.elements.status.value = mode === 'trade_sell' ? 'traded' : (watch.status || 'on_hand');
  form.elements.acquisition_type.value = watch.acquisition_type || 'purchase';
  form.elements.reference.value = watch.reference || '';
  form.elements.notes.value = watch.notes || '';
  document.getElementById('editorTitle').textContent = mode === 'trade_sell' ? `Trade / Sell ${watch.brand} ${watch.model}` : `Edit ${watch.brand} ${watch.model}`;
  renderConditionalFields();
  renderTradeFlowFields(watch);
  if (form.elements.sold_value) form.elements.sold_value.value = watch.sold_value || '';
  if (form.elements.traded_for_label) form.elements.traded_for_label.value = watch.traded_for_label || '';
  if (form.elements.trade_out_value) form.elements.trade_out_value.value = watch.trade_out_value || '';
  if (form.elements.trade_in_value) form.elements.trade_in_value.value = watch.trade_in_value || '';
  form.elements.cover_upload.value = '';
  openModal();
}

function bindCardActions(container) {
  container.querySelectorAll('[data-history-card]').forEach(el => {
    el.addEventListener('click', event => {
      event.stopPropagation();
      const idx = el.dataset.historyCard;
      const drawer = document.getElementById(`history-${idx}`);
      if (drawer) drawer.classList.toggle('hidden');
    });
  });
  container.querySelectorAll('[data-edit-card]').forEach(el => {
    el.addEventListener('click', event => {
      event.stopPropagation();
      const watch = latestWatches.find(w => w._tileKey === el.dataset.editCard);
      if (watch) fillEditor(watch, 'edit');
    });
  });
  container.querySelectorAll('[data-trade-card]').forEach(el => {
    el.addEventListener('click', event => {
      event.stopPropagation();
      const watch = latestWatches.find(w => w._tileKey === el.dataset.tradeCard);
      if (watch) fillEditor(watch, 'trade_sell');
    });
  });
}

function renderInventory(onHand) {
  const list = document.getElementById('inventoryList');
  if (!list) return;
  if (!onHand.length) {
    list.innerHTML = `<div class="catalog-tile"><div class="catalog-image"></div><div class="catalog-meta">No watches yet</div><div class="catalog-title">Your current collection will appear here.</div></div>`;
    return;
  }
  list.innerHTML = onHand.map((w, idx) => tileMarkup(w, idx, 'onhand')).join('');
  bindCardActions(list);
}

function renderHistory(historical) {
  const list = document.getElementById('historyList');
  if (!list) return;
  if (!historical.length) {
    list.innerHTML = `<div class="catalog-tile"><div class="catalog-meta">No history yet</div><div class="catalog-title">Sold and traded watches will appear here.</div></div>`;
    return;
  }
  list.innerHTML = historical.map((w, idx) => tileMarkup(w, idx, 'history')).join('');
  bindCardActions(list);
}

function renderConditionalFields() {
  const status = document.getElementById('statusField').value;
  const acquisition = document.getElementById('acquisitionField').value;
  const watch = latestWatches.find(w => w.id === currentEditWatchId) || {};
  const root = document.getElementById('conditionalFields');
  const fields = [];
  if (editorMode !== 'trade_sell' && status === 'sold') fields.push(`<label><span>Sold for</span><input name="sold_value" type="number" step="0.01" value="${watch.sold_value || ''}" /></label>`);
  if (editorMode !== 'trade_sell' && (status === 'traded' || acquisition === 'trade')) {
    fields.push(`<label><span>Traded for</span><input name="traded_for_label" value="${watch.traded_for_label || ''}" /></label>`);
    fields.push(`<label><span>Trade out value</span><input name="trade_out_value" type="number" step="0.01" value="${watch.trade_out_value || ''}" /></label>`);
    fields.push(`<label><span>Trade in value</span><input name="trade_in_value" type="number" step="0.01" value="${watch.trade_in_value || ''}" /></label>`);
  }
  root.innerHTML = fields.join('');
}

async function uploadImageIfNeeded(watchId) {
  const input = document.getElementById('imageUploadField');
  const uploadStatus = document.getElementById('uploadStatus');
  const file = input.files?.[0];
  if (!file || !watchId) return null;
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  uploadStatus.textContent = 'Uploading image...';
  const result = await postJson('/api/watch/upload-image', { id: watchId, filename: file.name, dataUrl });
  uploadStatus.textContent = result.error ? result.error : 'Image updated.';
  return result;
}

async function refresh() {
  const payload = await getJson('/api/inventory');
  const watches = payload.watches || [];
  const onHand = watches.filter(w => w.status === 'on_hand' || w.status === 'pending').map((w, idx) => ({ ...w, _tileKey: `onhand-${idx}` }));
  const history = watches.filter(w => w.status === 'sold' || w.status === 'traded').map((w, idx) => ({ ...w, _tileKey: `history-${idx}` }));
  latestWatches = [...onHand, ...history];
  renderSummary(payload.summary);
  renderInventory(onHand);
  renderHistory(history);
}

document.getElementById('refreshBtn').addEventListener('click', refresh);
document.getElementById('statusField').addEventListener('change', renderConditionalFields);
document.getElementById('acquisitionField').addEventListener('change', renderConditionalFields);
document.getElementById('closeEditorBtn').addEventListener('click', closeModal);
document.querySelector('[data-close-modal="true"]').addEventListener('click', closeModal);
document.getElementById('startTradeSellBtn').addEventListener('click', () => {
  editorMode = 'trade_sell';
  tradeMode = 'sell';
  document.getElementById('statusField').value = 'traded';
  document.getElementById('acquisitionField').value = 'trade';
  renderConditionalFields();
  const watch = latestWatches.find(w => w.id === currentEditWatchId) || {};
  renderTradeFlowFields(watch);
});

document.getElementById('watchForm').addEventListener('submit', async event => {
  event.preventDefault();
  const formEl = event.currentTarget;
  const form = new FormData(formEl);
  const body = Object.fromEntries(form.entries());
  delete body.cover_upload;
  const status = document.getElementById('formStatus');

  if (editorMode === 'trade_sell' && tradeMode === 'trade_new') {
    const result = await postJson('/api/trade', {
      outgoing_watch_id: body.id,
      trade_out_value: document.getElementById('tradeOutFlow')?.value || body.paid_value,
      trade_in_value: document.getElementById('tradeInFlow')?.value || 0,
      new_watch: {
        brand: document.getElementById('tradeNewBrand')?.value || '',
        model: document.getElementById('tradeNewModel')?.value || '',
        factory: document.getElementById('tradeNewFactory')?.value || '',
        reference: document.getElementById('tradeNewReference')?.value || '',
        notes: document.getElementById('tradeNewNotes')?.value || '',
        paid_value: document.getElementById('tradeInFlow')?.value || 0,
      }
    });
    if (result.error) {
      status.textContent = result.error;
      return;
    }
    await refresh();
    closeModal();
    return;
  }

  if (editorMode === 'trade_sell' && tradeMode === 'sell') {
    body.status = 'sold';
    body.sold_value = document.getElementById('tradeInFlow')?.value || body.sold_value || 0;
  }

  const result = await postJson('/api/watch', body);
  if (result.error) {
    status.textContent = result.error;
    return;
  }
  await uploadImageIfNeeded(result.watch.id);
  status.textContent = 'Watch saved.';
  await refresh();
  closeModal();
});

refresh();
