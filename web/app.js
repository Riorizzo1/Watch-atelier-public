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
let currentDisposeWatchId = '';
let editorMode = 'edit';
let tradeMode = 'sell';

function summaryValueClass(value) {
  const num = Number(value || 0);
  if (num > 0) return 'summary-value-positive';
  if (num < 0) return 'summary-value-negative';
  return '';
}

function renderSummary(summary) {
  const root = document.getElementById('summary');
  if (!root) return;
  const totalWatches = Number(summary.counts.total || 0);
  const onHand = Number(summary.counts.on_hand || 0);
  const outCount = Math.max(totalWatches - onHand, 0);
  const onHandRatio = totalWatches > 0 ? Math.max(0, Math.min(1, onHand / totalWatches)) : 0;
  const retailOnHand = Number(summary.totals.retail_paid_value || 0) + Number(summary.totals.retail_trade_value || 0);
  const retailPaid = Number(summary.totals.retail_paid_value || 0);
  const retailTrade = Number(summary.totals.retail_trade_value || 0);
  const chainTotal = Number(summary.totals.realized_chain_total || 0);
  const unrealizedChain = Number(summary.totals.unrealized_chain_total || 0);
  root.innerHTML = `
    <div class="metric-card metric-card-dark metric-card-summary-combined">
      <div class="metric-summary-section">
        <div class="metric-summary-head">
          <div class="metric-label">Collection</div>
          <div class="metric-summary-icon">⌁</div>
        </div>
        <div class="metric-collection-row metric-collection-row-horizontal metric-collection-row-dark">
          <div class="metric-collection-total-wrap">
            <div class="metric-value metric-value-collection metric-value-collection-dark">${totalWatches}</div>
            <div class="metric-total-tag metric-total-tag-dark">TOTAL</div>
          </div>
          <div class="metric-collection-side-stats metric-collection-side-stats-dark">
            <div class="metric-collection-stat metric-collection-stat-on">● ${onHand} On Hand</div>
            <div class="metric-collection-stat">${outCount} Out</div>
          </div>
        </div>
        <div class="metric-progress-track metric-progress-track-dark"><div class="metric-progress-fill" style="width:${Math.round(onHandRatio * 100)}%"></div></div>
      </div>
      <div class="metric-summary-divider"></div>
      <div class="metric-summary-section">
        <div class="metric-summary-head">
          <div class="metric-label">Retail value</div>
          <div class="metric-summary-icon">◉</div>
        </div>
        <div class="metric-value metric-value-dark">${money(retailOnHand)}</div>
        <div class="metric-breakdown-list metric-breakdown-list-dark">
          <div class="metric-breakdown-row"><span><span class="metric-breakdown-dot paid"></span>Paid watches</span><strong>${money(retailPaid)}</strong></div>
          <div class="metric-breakdown-row"><span><span class="metric-breakdown-dot trade"></span>Trade watches</span><strong>${money(retailTrade)}</strong></div>
                  </div>
        <div class="metric-breakdown-bar">
          <span class="metric-breakdown-bar-seg paid" style="width:${retailOnHand ? (retailPaid / retailOnHand) * 100 : 0}%"></span>
          <span class="metric-breakdown-bar-seg trade" style="width:${retailOnHand ? (retailTrade / retailOnHand) * 100 : 0}%"></span>
                  </div>
      </div>
    </div>
    <div class="metric-pill-row metric-pill-row-two-up">
      <div class="metric-card metric-card-soft metric-card-pill">
        <div class="metric-label">Unrealized</div>
        <div class="metric-value ${summaryValueClass(unrealizedChain)}">${unrealizedChain > 0 ? '+' : ''}${money(unrealizedChain)}</div>
      </div>
      <div class="metric-card metric-card-soft metric-card-pill">
        <div class="metric-label">Realized</div>
        <div class="metric-value ${summaryValueClass(chainTotal)}">${chainTotal > 0 ? '+' : ''}${money(chainTotal)}</div>
      </div>
    </div>
  `;
}

function historyMarkup(w) {
  const blocks = [];
  if (w.acquisition_type === 'monthly_payment') {
    blocks.push(`<div class="event-block event-block-payment"><div class="event-title">Monthly payment watch</div><div class="event-detail">Counted in inventory value${w.monthly_payment_period ? ` • ${w.monthly_payment_period}` : ''}</div></div>`);
  }
  if (w.trade_result) {
    blocks.push(`<div class="event-block event-block-${w.trade_result}"><div class="event-title">Trade ${w.trade_result}</div><div class="event-detail">${money(w.trade_out_value || w.paid_value)} → ${money(w.trade_in_value || 0)}</div><div class="event-delta">${w.trade_delta > 0 ? '+' : ''}${money(w.trade_delta)} ${w.traded_for_label ? `• ${w.traded_for_label}` : ''}</div></div>`);
  }
  if (w.sale_result) {
    blocks.push(`<div class="event-block event-block-${w.sale_result}"><div class="event-title">Sale ${w.sale_result}</div><div class="event-detail">Basis ${money(w.carried_basis)} → ${money(w.sold_value)}</div><div class="event-delta">${w.sale_delta > 0 ? '+' : ''}${money(w.sale_delta)}</div></div>`);
  }
  if (w.linked_trade_from_watch_id || (w.lineage_path || []).length > 1) {
    const finalLine = w.chain_closed
      ? `Realized P/L ${w.chain_final_realized_pl > 0 ? '+' : ''}${money(w.chain_final_realized_pl)}`
      : `Unrealized ${w.chain_unrealized_delta > 0 ? '+' : ''}${money(w.chain_unrealized_delta)}`;
    blocks.push(`<div class="event-block"><div class="event-title">Chain provenance</div><div class="event-detail">${(w.lineage_path || []).join(' → ')}</div><div class="event-delta">Original basis ${money(w.original_basis)} • ${finalLine}</div></div>`);
  }
  return blocks.join('');
}

function tileMarkup(w, idx, kind = 'onhand') {
  const hasStructuredHistory = Boolean(w.trade_result || Number(w.sold_value || 0) || w.linked_trade_from_watch_id);
  const displayName = w.display_name || w.model || `${w.brand} ${w.model}`;
  const reference = w.reference || '';
  const faceValue = Number(w.trade_in_value || 0) > 0 && w.status === 'on_hand' ? Number(w.trade_in_value) : Number(w.paid_value || 0);
  const statusPill = kind === 'onhand'
    ? `<div class="catalog-status-row"><span class="catalog-status-pill">● On hand</span></div>`
    : '';
  return `
    <div class="catalog-tile ${hasStructuredHistory ? 'catalog-tile-has-history' : ''}" data-card-index="${kind}-${idx}">
      <div class="catalog-frame ${hasStructuredHistory ? 'catalog-history-toggle' : ''}" ${hasStructuredHistory ? `data-history-card="${kind}-${idx}"` : ''}>
        ${statusPill}
        <div class="catalog-image-wrap">
          <div class="catalog-image-expand" data-expand-image="${w.web_image || ''}" data-expand-alt="${`${w.brand || ''} ${w.model || ''}`.trim()}">Expand</div>
          <div class="catalog-image">${w.web_image ? `<img src="${w.web_image}" alt="${w.brand} ${w.model}" loading="lazy" onerror="this.parentElement.classList.add('image-fallback'); this.remove();">` : ''}</div>
        </div>
      </div>
      <div class="catalog-topline">
        <div class="catalog-meta">${w.brand.toUpperCase()}${w.factory ? ` <span class="catalog-meta-sep">|</span> ${w.factory.toUpperCase()}` : ''}</div>
        <div class="catalog-reference">${reference}</div>
      </div>
      <div class="catalog-detail-row">
        <div class="catalog-name-block">
          <div class="catalog-title">${displayName}</div>
          ${w.acquisition_type === 'monthly_payment' ? '<div class="catalog-footnote">Monthly payment</div>' : ''}
          ${w.trade_result ? `<div class="catalog-footnote catalog-footnote-${w.trade_result}">${w.trade_result === 'win' ? `Trade surplus ${money(w.trade_delta)}` : w.trade_result === 'loss' ? `Trade loss ${money(Math.abs(w.trade_delta))}` : 'Even trade'}</div>` : ''}
          ${w.linked_trade_from_watch_id || (w.lineage_path || []).length > 1 ? `<div class="catalog-footnote catalog-footnote-stack"><span>Basis ${money(w.carried_basis)}</span><span>${w.chain_closed ? `Realized ${w.chain_final_realized_pl > 0 ? '+' : ''}${money(w.chain_final_realized_pl)}` : `Unrealized ${w.chain_unrealized_delta > 0 ? '+' : ''}${money(w.chain_unrealized_delta)}`}</span></div>` : ''}
        </div>
        <div class="catalog-price-block">
          <div class="catalog-value">${money(faceValue)}</div>
          <div class="catalog-value-label">Net cost</div>
        </div>
      </div>
      <div class="catalog-actions catalog-actions-reference ${hasStructuredHistory ? 'catalog-actions-has-details' : 'catalog-actions-no-details'}">
        <div class="catalog-action-group catalog-action-group-full">
          <button class="catalog-action-btn catalog-edit-btn" data-edit-card="${kind}-${idx}" type="button">Edit Details</button>
          ${kind === 'onhand'
            ? `<button class="catalog-action-btn" data-sell-card="${kind}-${idx}" type="button">Sell</button><button class="catalog-action-btn catalog-action-btn-primary" data-trade-card="${kind}-${idx}" type="button">Trade</button>`
            : hasStructuredHistory ? `<button class="catalog-action-btn" data-history-card="${kind}-${idx}" type="button">Details</button>` : ''}
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
  editorMode = 'edit';
}

function openDisposeModal(watch, mode = 'sell') {
  currentDisposeWatchId = watch?.id || '';
  tradeMode = mode;
  const modal = document.getElementById('disposeModal');
  const title = document.getElementById('disposeTitle');
  const context = document.getElementById('disposeContext');
  const sellFields = document.getElementById('sellFields');
  const tradeFields = document.getElementById('tradeFields');
  const sellBtn = document.getElementById('sellModeBtn');
  const tradeBtn = document.getElementById('tradeModeBtn');
  const carriedBasis = Number(watch?.carried_basis || watch?.paid_value || 0);
  title.textContent = `${mode === 'sell' ? 'Sell' : 'Trade'} ${[watch?.brand, watch?.model].filter(Boolean).join(' ') || 'Watch'}`;
  context.innerHTML = `<div class="dispose-context-kicker">Current basis</div><div class="dispose-context-value">${money(carriedBasis)}</div><div class="dispose-context-note">${watch?.display_name || watch?.model || ''}</div>`;
  sellFields.classList.toggle('hidden', mode !== 'sell');
  tradeFields.classList.toggle('hidden', mode !== 'trade_new');
  sellBtn.classList.toggle('catalog-action-btn-primary', mode === 'sell');
  sellBtn.classList.toggle('catalog-edit-btn', mode !== 'sell');
  tradeBtn.classList.toggle('catalog-action-btn-primary', mode === 'trade_new');
  tradeBtn.classList.toggle('catalog-edit-btn', mode !== 'trade_new');
  document.getElementById('sellValueField').value = mode === 'sell' ? (watch?.sold_value || '') : '';
  document.getElementById('tradeOutFlow').value = watch?.trade_out_value || watch?.paid_value || '';
  document.getElementById('tradeInFlow').value = watch?.trade_in_value || '';
  document.getElementById('tradeNewBrand').value = '';
  document.getElementById('tradeNewModel').value = '';
  document.getElementById('tradeNewFactory').value = '';
  document.getElementById('tradeNewReference').value = '';
  document.getElementById('tradeNewNotes').value = '';
  document.getElementById('disposeStatus').textContent = '';
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
}

function closeDisposeModal() {
  const modal = document.getElementById('disposeModal');
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  document.getElementById('disposeStatus').textContent = '';
  currentDisposeWatchId = '';
}

function fillEditor(watch, mode = 'edit') {
  const form = document.getElementById('watchForm');
  const safeWatch = watch || {};
  currentEditWatchId = safeWatch.id || '';
  editorMode = mode;
  form.elements.id.value = safeWatch.id || '';
  form.elements.brand.value = safeWatch.brand || '';
  form.elements.model.value = safeWatch.model || '';
  form.elements.factory.value = safeWatch.factory || '';
  form.elements.paid_value.value = safeWatch.paid_value || '';
  form.elements.status.value = safeWatch.status || 'on_hand';
  form.elements.acquisition_type.value = safeWatch.acquisition_type || 'purchase';
  form.elements.display_name.value = safeWatch.display_name || '';
  form.elements.reference.value = safeWatch.reference || '';
  form.elements.notes.value = safeWatch.notes || '';
  const hasName = safeWatch.brand || safeWatch.model;
  document.getElementById('editorTitle').textContent = hasName ? `Edit ${[safeWatch.brand, safeWatch.model].filter(Boolean).join(' ')}` : 'Edit Details';
  renderConditionalFields();
  if (form.elements.sold_value) form.elements.sold_value.value = safeWatch.sold_value || '';
  if (form.elements.traded_for_label) form.elements.traded_for_label.value = safeWatch.traded_for_label || '';
  if (form.elements.trade_out_value) form.elements.trade_out_value.value = safeWatch.trade_out_value || '';
  if (form.elements.trade_in_value) form.elements.trade_in_value.value = safeWatch.trade_in_value || '';
  if (form.elements.monthly_payment_period) form.elements.monthly_payment_period.value = safeWatch.monthly_payment_period || '';
  form.elements.cover_upload.value = '';
  openModal();
}

function openLightbox(src, alt = 'Expanded watch image') {
  if (!src) return;
  const lightbox = document.getElementById('imageLightbox');
  const image = document.getElementById('lightboxImage');
  if (!lightbox || !image) return;
  image.src = src;
  image.alt = alt;
  lightbox.classList.remove('hidden');
  lightbox.setAttribute('aria-hidden', 'false');
}

function closeLightbox() {
  const lightbox = document.getElementById('imageLightbox');
  const image = document.getElementById('lightboxImage');
  if (!lightbox || !image) return;
  lightbox.classList.add('hidden');
  lightbox.setAttribute('aria-hidden', 'true');
  image.src = '';
}

function bindCardActions(container) {
  container.querySelectorAll('.catalog-frame[data-history-card], button[data-history-card]').forEach(el => {
    el.addEventListener('click', event => {
      if (event.target.closest('[data-expand-image]')) return;
      event.stopPropagation();
      const idx = el.dataset.historyCard;
      const drawer = document.getElementById(`history-${idx}`);
      if (drawer) drawer.classList.toggle('hidden');
    });
  });
  container.querySelectorAll('[data-expand-image]').forEach(el => {
    el.addEventListener('click', event => {
      event.stopPropagation();
      openLightbox(el.dataset.expandImage, el.dataset.expandAlt || 'Expanded watch image');
    });
  });
  container.querySelectorAll('[data-edit-card]').forEach(el => {
    el.addEventListener('click', event => {
      event.stopPropagation();
      const watch = latestWatches.find(w => w._tileKey === el.dataset.editCard);
      if (watch) fillEditor(watch, 'edit');
    });
  });
  container.querySelectorAll('[data-sell-card]').forEach(el => {
    el.addEventListener('click', event => {
      event.stopPropagation();
      const watch = latestWatches.find(w => w._tileKey === el.dataset.sellCard);
      if (watch) openDisposeModal(watch, 'sell');
    });
  });
  container.querySelectorAll('[data-trade-card]').forEach(el => {
    el.addEventListener('click', event => {
      event.stopPropagation();
      const watch = latestWatches.find(w => w._tileKey === el.dataset.tradeCard);
      if (watch) openDisposeModal(watch, 'trade_new');
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
  if (status === 'sold') fields.push(`<label><span>Sold for</span><input name="sold_value" type="number" step="0.01" value="${watch.sold_value || ''}" /></label>`);
  if (status === 'traded' || acquisition === 'trade') {
    fields.push(`<label><span>Traded for</span><input name="traded_for_label" value="${watch.traded_for_label || ''}" /></label>`);
    fields.push(`<label><span>Trade out value</span><input name="trade_out_value" type="number" step="0.01" value="${watch.trade_out_value || ''}" /></label>`);
    fields.push(`<label><span>Trade in value</span><input name="trade_in_value" type="number" step="0.01" value="${watch.trade_in_value || ''}" /></label>`);
  }
  if (acquisition === 'monthly_payment') fields.push(`<label><span>Payment period</span><input name="monthly_payment_period" placeholder="Optional month or note" value="${watch.monthly_payment_period || ''}" /></label>`);
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
document.getElementById('openCreateBtn')?.addEventListener('click', () => {
  fillEditor({ status: 'on_hand', acquisition_type: 'purchase' }, 'edit');
});
document.getElementById('statusField').addEventListener('change', renderConditionalFields);
document.getElementById('acquisitionField').addEventListener('change', renderConditionalFields);
document.getElementById('closeEditorBtn').addEventListener('click', closeModal);
document.getElementById('cancelEditorBtn')?.addEventListener('click', closeModal);
document.querySelector('[data-close-modal="true"]').addEventListener('click', closeModal);
document.getElementById('closeDisposeBtn')?.addEventListener('click', closeDisposeModal);
document.getElementById('cancelDisposeBtn')?.addEventListener('click', closeDisposeModal);
document.querySelector('[data-close-dispose-modal="true"]')?.addEventListener('click', closeDisposeModal);
document.getElementById('sellModeBtn')?.addEventListener('click', () => {
  const watch = latestWatches.find(w => w.id === currentDisposeWatchId);
  if (watch) openDisposeModal(watch, 'sell');
});
document.getElementById('tradeModeBtn')?.addEventListener('click', () => {
  const watch = latestWatches.find(w => w.id === currentDisposeWatchId);
  if (watch) openDisposeModal(watch, 'trade_new');
});
document.getElementById('closeLightboxBtn')?.addEventListener('click', closeLightbox);
document.querySelector('[data-close-lightbox="true"]')?.addEventListener('click', closeLightbox);

document.getElementById('watchForm').addEventListener('submit', async event => {
  event.preventDefault();
  const formEl = event.currentTarget;
  const form = new FormData(formEl);
  const body = Object.fromEntries(form.entries());
  delete body.cover_upload;
  const status = document.getElementById('formStatus');
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

document.getElementById('disposeForm').addEventListener('submit', async event => {
  event.preventDefault();
  const status = document.getElementById('disposeStatus');
  const watch = latestWatches.find(w => w.id === currentDisposeWatchId);
  if (!watch) {
    status.textContent = 'Watch not found.';
    return;
  }

  if (tradeMode === 'sell') {
    const saleValue = document.getElementById('sellValueField')?.value || 0;
    const result = await postJson('/api/watch', {
      ...watch,
      status: 'sold',
      sold_value: saleValue,
    });
    if (result.error) {
      status.textContent = result.error;
      return;
    }
    await refresh();
    closeDisposeModal();
    return;
  }

  const result = await postJson('/api/trade', {
    outgoing_watch_id: watch.id,
    trade_out_value: document.getElementById('tradeOutFlow')?.value || watch.paid_value,
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
  closeDisposeModal();
});

refresh();
