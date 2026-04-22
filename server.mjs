import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataPath = path.join(__dirname, 'data', 'inventory.json');
const webDir = path.join(__dirname, 'web');
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function getDb() {
  const db = readJson(dataPath);
  db.watches = Array.isArray(db.watches) ? db.watches : [];
  db.transactions = Array.isArray(db.transactions) ? db.transactions : [];
  return db;
}

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function lineageRootId(watch, byId) {
  let current = watch;
  const seen = new Set();
  while (current?.linked_trade_from_watch_id && byId.has(current.linked_trade_from_watch_id) && !seen.has(current.linked_trade_from_watch_id)) {
    seen.add(current.linked_trade_from_watch_id);
    current = byId.get(current.linked_trade_from_watch_id);
  }
  return current?.id || watch.id;
}

function buildLineagePath(watch, byId) {
  const path = [];
  let current = watch;
  const seen = new Set();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current.id);
    if (!current.linked_trade_from_watch_id || !byId.has(current.linked_trade_from_watch_id)) break;
    current = byId.get(current.linked_trade_from_watch_id);
  }
  return path;
}

function computeBasisAndChains(baseWatches, byId) {
  const basisMap = new Map();
  const chainMap = new Map();

  function ensureChain(rootId) {
    if (!chainMap.has(rootId)) {
      chainMap.set(rootId, {
        final_realized_pl: 0,
        unrealized_trade_delta: 0,
        members: [],
        is_closed: false,
      });
    }
    return chainMap.get(rootId);
  }

  function computeWatch(watch) {
    if (basisMap.has(watch.id)) return basisMap.get(watch.id);

    const rootId = lineageRootId(watch, byId);
    const lineagePath = buildLineagePath(watch, byId);
    const tradeOut = Number(watch.trade_out_value || 0);
    const tradeIn = Number(watch.trade_in_value || 0);
    const soldValue = Number(watch.sold_value || 0);
    const paidValue = Number(watch.paid_value || 0);

    let originalBasis = paidValue;
    let carriedBasis = paidValue;

    if (watch.linked_trade_from_watch_id && byId.has(watch.linked_trade_from_watch_id)) {
      const parent = computeWatch(byId.get(watch.linked_trade_from_watch_id));
      originalBasis = Number(parent.original_basis || 0);
      carriedBasis = Number(parent.carried_basis || 0);
    }

    let tradeDelta = 0;
    const isIncomingTradeWatch = watch.acquisition_type === 'trade' && !!watch.linked_trade_from_watch_id;
    if (watch.status === 'traded') {
      tradeDelta = tradeIn - tradeOut;
    } else if (isIncomingTradeWatch) {
      tradeDelta = tradeIn - carriedBasis;
      carriedBasis = carriedBasis;
    }

    let saleDelta = 0;
    let finalRealizedPl = 0;
    let chainClosed = false;
    if (watch.status === 'sold' && soldValue) {
      saleDelta = soldValue - carriedBasis;
      finalRealizedPl = soldValue - originalBasis;
      chainClosed = true;
    }

    const result = {
      root_id: rootId,
      lineage_path: lineagePath,
      original_basis: roundMoney(originalBasis),
      carried_basis: roundMoney(carriedBasis),
      trade_delta: roundMoney(tradeDelta),
      sale_delta: roundMoney(saleDelta),
      final_realized_pl: roundMoney(finalRealizedPl),
      chain_closed: chainClosed,
    };

    basisMap.set(watch.id, result);
    const chain = ensureChain(rootId);
    if (!chain.members.includes(watch.id)) chain.members.push(watch.id);
    if (!chainClosed && tradeDelta) {
      chain.unrealized_trade_delta = roundMoney(tradeDelta);
    }
    if (chainClosed) {
      chain.final_realized_pl = roundMoney(finalRealizedPl);
      chain.is_closed = true;
      chain.unrealized_trade_delta = 0;
    }
    return result;
  }

  for (const watch of baseWatches) computeWatch(watch);
  return { basisMap, chainMap };
}

function decorateWatch(watch, byId, basisMap, chainMap) {
  const outgoing = Number(watch.trade_out_value || 0);
  const incoming = Number(watch.trade_in_value || 0);
  const tradeDeltaRaw = incoming - outgoing;
  let trade_result = '';
  if (watch.status === 'traded' || outgoing || incoming) {
    trade_result = tradeDeltaRaw > 0 ? 'win' : tradeDeltaRaw < 0 ? 'loss' : 'even';
  }
  const basis = basisMap.get(watch.id) || {
    root_id: watch.id,
    lineage_path: [watch.id],
    original_basis: Number(watch.paid_value || 0),
    carried_basis: Number(watch.paid_value || 0),
    trade_delta: 0,
    sale_delta: 0,
    final_realized_pl: 0,
    chain_closed: false,
  };
  let sale_result = '';
  if (watch.status === 'sold' && Number(watch.sold_value || 0)) {
    sale_result = basis.sale_delta > 0 ? 'win' : basis.sale_delta < 0 ? 'loss' : 'even';
  }
  const chain = chainMap.get(basis.root_id) || { final_realized_pl: basis.final_realized_pl, unrealized_trade_delta: basis.trade_delta, members: [watch.id], is_closed: basis.chain_closed };
  return {
    ...watch,
    trade_delta: basis.trade_delta,
    trade_result,
    sale_delta: basis.sale_delta,
    sale_result,
    original_basis: basis.original_basis,
    carried_basis: basis.carried_basis,
    root_id: basis.root_id,
    lineage_path: basis.lineage_path,
    chain_closed: chain.is_closed,
    chain_final_realized_pl: roundMoney(chain.final_realized_pl),
    chain_unrealized_delta: roundMoney(chain.unrealized_trade_delta),
    chain_member_ids: chain.members,
  };
}

function getInventorySummary(db) {
  const baseWatches = db.watches || [];
  const byId = new Map(baseWatches.map(w => [w.id, w]));
  const { basisMap, chainMap } = computeBasisAndChains(baseWatches, byId);
  const watches = baseWatches.map(w => decorateWatch(w, byId, basisMap, chainMap));
  const onHand = watches.filter(w => w.status === 'on_hand');
  const sold = watches.filter(w => w.status === 'sold');
  const traded = watches.filter(w => w.status === 'traded');
  const retailPaid = onHand
    .filter(w => w.acquisition_type !== 'monthly_payment' && w.acquisition_type !== 'trade')
    .reduce((sum, w) => sum + Number(w.paid_value || 0), 0);
  const retailTrade = onHand
    .filter(w => w.acquisition_type === 'trade')
    .reduce((sum, w) => sum + Number(w.trade_in_value || 0), 0);
  const monthlyValue = onHand
    .filter(w => w.acquisition_type === 'monthly_payment')
    .reduce((sum, w) => sum + Number(w.paid_value || 0), 0);
  const retailOnHand = retailPaid + retailTrade + monthlyValue;
  const totalSold = sold.reduce((sum, w) => sum + Number(w.sold_value || 0), 0);
  const netSales = sold.reduce((sum, w) => sum + Number(w.sale_delta || 0), 0);
  const tradeDelta = watches.reduce((sum, w) => sum + Number(w.trade_delta || 0), 0);
  const realizedChainTotals = Array.from(chainMap.values()).reduce((sum, chain) => sum + Number(chain.is_closed ? (chain.final_realized_pl || 0) : 0), 0);
  const unrealizedChainTotals = Array.from(chainMap.values()).reduce((sum, chain) => sum + Number(!chain.is_closed ? (chain.unrealized_trade_delta || 0) : 0), 0);
  return {
    counts: {
      total: watches.length,
      on_hand: onHand.length,
      sold: sold.length,
      traded: traded.length,
      pending: watches.filter(w => w.status === 'pending').length,
    },
    totals: {
      retail_on_hand: Math.round((retailOnHand + Number.EPSILON) * 100) / 100,
      retail_paid_value: Math.round((retailPaid + Number.EPSILON) * 100) / 100,
      retail_trade_value: Math.round((retailTrade + Number.EPSILON) * 100) / 100,
      monthly_payment_value: Math.round((monthlyValue + Number.EPSILON) * 100) / 100,
      sold_value: Math.round((totalSold + Number.EPSILON) * 100) / 100,
      net_sales: Math.round((netSales + Number.EPSILON) * 100) / 100,
      trade_delta: Math.round((tradeDelta + Number.EPSILON) * 100) / 100,
      realized_chain_total: Math.round((realizedChainTotals + Number.EPSILON) * 100) / 100,
      unrealized_chain_total: Math.round((unrealizedChainTotals + Number.EPSILON) * 100) / 100,
    },
    watches,
  };
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function serveStatic(res, file, type = 'text/html; charset=utf-8') {
  res.writeHead(200, { 'Content-Type': type });
  res.end(fs.readFileSync(file));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/') {
    return serveStatic(res, path.join(webDir, 'index.html'));
  }
  if (req.method === 'GET' && url.pathname === '/app.css') {
    return serveStatic(res, path.join(webDir, 'app.css'), 'text/css; charset=utf-8');
  }
  if (req.method === 'GET' && url.pathname === '/app.js') {
    return serveStatic(res, path.join(webDir, 'app.js'), 'application/javascript; charset=utf-8');
  }
  if (req.method === 'GET' && url.pathname === '/history.html') {
    return serveStatic(res, path.join(webDir, 'history.html'));
  }
  if (req.method === 'GET' && url.pathname === '/api/inventory') {
    const db = getDb();
    const summary = getInventorySummary(db);
    return sendJson(res, 200, { watches: summary.watches, transactions: db.transactions, summary });
  }
  if (req.method === 'POST' && url.pathname === '/api/watch') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        if (!parsed.brand || !parsed.model) return sendJson(res, 400, { error: 'brand and model required' });
        const db = getDb();
        const now = new Date().toISOString();
        const existing = db.watches.find(w => w.id === parsed.id) || null;
        const watch = {
          id: parsed.id || `watch_${Date.now()}`,
          brand: parsed.brand,
          model: parsed.model,
          factory: parsed.factory || '',
          reference: parsed.reference || '',
          display_name: parsed.display_name ?? existing?.display_name ?? '',
          status: parsed.status || existing?.status || 'on_hand',
          acquisition_type: parsed.acquisition_type || existing?.acquisition_type || 'purchase',
          paid_value: Number(parsed.paid_value || 0),
          sold_value: parsed.sold_value !== undefined ? Number(parsed.sold_value || 0) : Number(existing?.sold_value || 0),
          traded_for_watch_id: parsed.traded_for_watch_id ?? existing?.traded_for_watch_id ?? '',
          traded_for_label: parsed.traded_for_label ?? existing?.traded_for_label ?? '',
          trade_out_value: parsed.trade_out_value !== undefined ? Number(parsed.trade_out_value || 0) : Number(existing?.trade_out_value || 0),
          trade_in_value: parsed.trade_in_value !== undefined ? Number(parsed.trade_in_value || 0) : Number(existing?.trade_in_value || 0),
          monthly_payment_period: parsed.monthly_payment_period ?? existing?.monthly_payment_period ?? '',
          notes: parsed.notes || '',
          web_image: parsed.web_image ?? existing?.web_image ?? '',
          personal_images: existing?.personal_images || [],
          created_at: parsed.created_at || existing?.created_at || now,
          updated_at: now
        };
        const idx = db.watches.findIndex(w => w.id === watch.id);
        if (idx >= 0) db.watches[idx] = { ...db.watches[idx], ...watch, updated_at: now };
        else db.watches.unshift(watch);
        writeJson(dataPath, db);
        return sendJson(res, 200, { ok: true, watch, summary: getInventorySummary(db) });
      } catch (err) {
        return sendJson(res, 500, { error: String(err.message || err) });
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/trade') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        if (!parsed.outgoing_watch_id || !parsed.new_watch?.brand || !parsed.new_watch?.model) {
          return sendJson(res, 400, { error: 'outgoing watch and new watch details required' });
        }
        const db = getDb();
        const now = new Date().toISOString();
        const outgoingIdx = db.watches.findIndex(w => w.id === parsed.outgoing_watch_id);
        if (outgoingIdx < 0) return sendJson(res, 404, { error: 'outgoing watch not found' });
        const outgoing = db.watches[outgoingIdx];
        const newId = `watch_${Date.now()}`;
        const tradeOutValue = Number(parsed.trade_out_value || outgoing.trade_out_value || outgoing.paid_value || 0);
        const tradeInValue = Number(parsed.trade_in_value || parsed.new_watch.paid_value || 0);
        const incoming = {
          id: newId,
          brand: parsed.new_watch.brand,
          model: parsed.new_watch.model,
          factory: parsed.new_watch.factory || '',
          reference: parsed.new_watch.reference || '',
          status: 'on_hand',
          acquisition_type: 'trade',
          paid_value: tradeInValue,
          sold_value: 0,
          traded_for_watch_id: '',
          traded_for_label: '',
          trade_out_value: 0,
          trade_in_value: tradeInValue,
          linked_trade_from_watch_id: outgoing.id,
          monthly_payment_period: '',
          notes: parsed.new_watch.notes || '',
          web_image: parsed.new_watch.web_image || '',
          personal_images: [],
          created_at: now,
          updated_at: now
        };
        db.watches[outgoingIdx] = {
          ...outgoing,
          status: 'traded',
          acquisition_type: outgoing.acquisition_type || 'trade',
          traded_for_watch_id: newId,
          traded_for_label: `${incoming.brand} ${incoming.model}`,
          trade_out_value: tradeOutValue,
          trade_in_value: tradeInValue,
          updated_at: now
        };
        db.watches.unshift(incoming);
        writeJson(dataPath, db);
        return sendJson(res, 200, { ok: true, outgoing: db.watches[outgoingIdx], incoming, summary: getInventorySummary(db) });
      } catch (err) {
        return sendJson(res, 500, { error: String(err.message || err) });
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/watch/upload-image') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_UPLOAD_BYTES * 2) req.destroy();
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        if (!parsed.id || !parsed.filename || !parsed.dataUrl) return sendJson(res, 400, { error: 'id, filename, and dataUrl required' });
        const match = String(parsed.dataUrl).match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
        if (!match) return sendJson(res, 400, { error: 'invalid image data' });
        const ext = (parsed.filename.split('.').pop() || 'jpg').replace(/[^a-z0-9]/gi, '').toLowerCase();
        const buf = Buffer.from(match[2], 'base64');
        if (buf.length > MAX_UPLOAD_BYTES) return sendJson(res, 400, { error: 'image too large' });
        const safeName = `${parsed.id}.${ext}`;
        const out = path.join(uploadsDir, safeName);
        fs.writeFileSync(out, buf);
        const db = getDb();
        const idx = db.watches.findIndex(w => w.id === parsed.id);
        if (idx < 0) return sendJson(res, 404, { error: 'watch not found' });
        db.watches[idx].web_image = `/uploads/${safeName}`;
        db.watches[idx].updated_at = new Date().toISOString();
        writeJson(dataPath, db);
        return sendJson(res, 200, { ok: true, web_image: `/uploads/${safeName}` });
      } catch (err) {
        return sendJson(res, 500, { error: String(err.message || err) });
      }
    });
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/uploads/')) {
    const file = path.join(uploadsDir, path.basename(url.pathname));
    if (!fs.existsSync(file)) return sendJson(res, 404, { error: 'not found' });
    const ext = path.extname(file).toLowerCase();
    const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return serveStatic(res, file, type);
  }

  sendJson(res, 404, { error: 'not found' });
});

const port = process.env.PORT || 4313;
const host = process.env.HOST || '0.0.0.0';
server.listen(port, host, () => {
  console.log(`Watch inventory app running at http://${host}:${port}`);
});
