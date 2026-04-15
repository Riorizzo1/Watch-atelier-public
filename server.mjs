import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataPath = path.join(__dirname, 'data', 'inventory.json');
const webDir = path.join(__dirname, 'web');

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

function decorateWatch(watch) {
  const outgoing = Number(watch.trade_out_value || 0);
  const incoming = Number(watch.trade_in_value || 0);
  const trade_delta = incoming - outgoing;
  let trade_result = '';
  if (watch.status === 'traded' || outgoing || incoming) {
    trade_result = trade_delta > 0 ? 'win' : trade_delta < 0 ? 'loss' : 'even';
  }
  const sale_delta = Number(watch.sold_value || 0) - Number(watch.paid_value || 0);
  let sale_result = '';
  if (watch.status === 'sold' && Number(watch.sold_value || 0)) {
    sale_result = sale_delta > 0 ? 'win' : sale_delta < 0 ? 'loss' : 'even';
  }
  return {
    ...watch,
    trade_delta,
    trade_result,
    sale_delta,
    sale_result,
  };
}

function getInventorySummary(db) {
  const watches = db.watches.map(decorateWatch);
  const onHand = watches.filter(w => w.status === 'on_hand');
  const sold = watches.filter(w => w.status === 'sold');
  const traded = watches.filter(w => w.status === 'traded');
  const retailOnHand = onHand.reduce((sum, w) => sum + Number((w.trade_in_value || 0) > 0 ? w.trade_in_value : w.paid_value || 0), 0);
  const netPaid = onHand
    .reduce((sum, w) => sum + Number(w.paid_value || 0), 0);
  const totalSold = sold.reduce((sum, w) => sum + Number(w.sold_value || 0), 0);
  const netSales = sold.reduce((sum, w) => sum + (Number(w.sold_value || 0) - Number(w.paid_value || 0)), 0);
  const tradeDelta = traded.reduce((sum, w) => sum + Number(w.trade_delta || 0), 0);
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
      net_paid: Math.round((netPaid + Number.EPSILON) * 100) / 100,
      sold_value: Math.round((totalSold + Number.EPSILON) * 100) / 100,
      net_sales: Math.round((netSales + Number.EPSILON) * 100) / 100,
      trade_delta: Math.round((tradeDelta + Number.EPSILON) * 100) / 100,
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
          status: parsed.status || existing?.status || 'on_hand',
          acquisition_type: parsed.acquisition_type === 'trade' ? 'trade' : 'purchase',
          paid_value: Number(parsed.paid_value || 0),
          sold_value: parsed.sold_value !== undefined ? Number(parsed.sold_value || 0) : Number(existing?.sold_value || 0),
          traded_for_watch_id: parsed.traded_for_watch_id ?? existing?.traded_for_watch_id ?? '',
          traded_for_label: parsed.traded_for_label ?? existing?.traded_for_label ?? '',
          trade_out_value: parsed.trade_out_value !== undefined ? Number(parsed.trade_out_value || 0) : Number(existing?.trade_out_value || 0),
          trade_in_value: parsed.trade_in_value !== undefined ? Number(parsed.trade_in_value || 0) : Number(existing?.trade_in_value || 0),
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







  sendJson(res, 404, { error: 'not found' });
});

const port = process.env.PORT || 4313;
const host = process.env.HOST || '0.0.0.0';
server.listen(port, host, () => {
  console.log(`Watch inventory app running at http://${host}:${port}`);
});
