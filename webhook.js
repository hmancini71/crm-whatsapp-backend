// Integrações: configurações (API key + webhook) e disparo de webhook assinado.
// Formato do webhook: POST JSON { event, timestamp, data } com header
// X-CRM-Signature = HMAC-SHA256(corpo, webhook_secret) e X-CRM-Event = nome do evento.
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { runQuery, getRow } = require('./db');

async function getIntegrationSettings() {
  try {
    const row = await getRow("SELECT value FROM app_settings WHERE key = 'integrations'");
    return row && row.value ? JSON.parse(row.value) : {};
  } catch (e) { return {}; }
}

function saveIntegrationSettings(cfg) {
  return runQuery(
    "INSERT INTO app_settings (key, value) VALUES ('integrations', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [JSON.stringify(cfg || {})]
  );
}

function newApiKey() {
  return 'eck_' + crypto.randomBytes(24).toString('hex');
}

// Dispara e esquece (não bloqueia a resposta ao usuário; erros só no log)
async function sendWebhook(event, data) {
  try {
    const cfg = await getIntegrationSettings();
    if (!cfg.webhook_enabled || !cfg.webhook_url) return;
    const body = JSON.stringify({ event, timestamp: new Date().toISOString(), data });
    const sig = cfg.webhook_secret
      ? crypto.createHmac('sha256', String(cfg.webhook_secret)).update(body).digest('hex')
      : '';
    let u;
    try { u = new URL(cfg.webhook_url); } catch (e) { return; }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: (u.pathname || '/') + (u.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-CRM-Event': event,
        'X-CRM-Signature': sig
      },
      timeout: 10000
    }, (res) => { res.resume(); });
    req.on('error', (e) => console.error('[webhook]', event, e.message));
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} });
    req.write(body);
    req.end();
  } catch (e) { console.error('[webhook]', e && e.message); }
}

module.exports = { getIntegrationSettings, saveIntegrationSettings, newApiKey, sendWebhook };
