// Integração CALENDLY (2026-07-07, pedido do Henry).
// O cliente agenda a "Reunião de Validação" no Calendly (calendly.com/valevisto) e o CRM:
//   1) localiza o card do lead (por E-MAIL do convidado; senão pelos últimos 8 dígitos do telefone);
//   2) preenche validation_date no formato "DD/MM/AAAA HH:MM" (fuso São Paulo — o mesmo que o
//      frontend usa nas caixinhas de data da coluna Agendado);
//   3) registra no histórico do lead (agendado / remarcado / cancelado);
//   4) em cancelamento, limpa a data do card SÓ se ela ainda for a do evento cancelado.
// Sem webhook (plano do Calendly pode não ter): varredura via API a cada 5 min (token PAT, Bearer).
// Config em app_settings key 'calendly_settings' (como a IA), editável em Configurações.
// Tabela calendly_events (db.js) evita retrabalho e detecta remarcação (cancel + novo evento).
const https = require('https');
const { runQuery, getRow, allRows } = require('./db');

const DEFAULTS = {
  enabled: false,
  token: '',
  // só eventos cujo NOME contenha esta palavra viram data de validação (regex, sem maiúsc/minúsc).
  event_keyword: 'valida',
  last_sync: 0,
  last_result: ''
};

async function getCalendlySettings() {
  try {
    const row = await getRow("SELECT value FROM app_settings WHERE key = 'calendly_settings'");
    const cfg = row && row.value ? JSON.parse(row.value) : {};
    return Object.assign({}, DEFAULTS, cfg);
  } catch (e) { return Object.assign({}, DEFAULTS); }
}

function saveCalendlySettings(cfg) {
  return runQuery(
    "INSERT INTO app_settings (key, value) VALUES ('calendly_settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [JSON.stringify(cfg || {})]
  );
}

// GET simples na API v2 do Calendly. pathAndQuery ex.: '/users/me'.
function api(token, pathAndQuery) {
  return new Promise((resolve, reject) => {
    if (!token) return reject(new Error('Token do Calendly não configurado'));
    const req = https.request({
      hostname: 'api.calendly.com',
      path: pathAndQuery,
      method: 'GET',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      timeout: 20000
    }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data || '{}');
          if (res.statusCode >= 400) return reject(new Error((j.message || j.title || 'Erro da API Calendly') + ' (HTTP ' + res.statusCode + ')'));
          resolve(j);
        } catch (e) { reject(new Error('Resposta inválida do Calendly: ' + String(data).slice(0, 150))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { try { req.destroy(new Error('Timeout na API Calendly')); } catch (e) {} });
    req.end();
  });
}

async function testCalendly(token) {
  const j = await api(token, '/users/me');
  const r = (j && j.resource) || {};
  return { ok: true, name: r.name || '', email: r.email || '', scheduling_url: r.scheduling_url || '' };
}

// "DD/MM/AAAA HH:MM" no fuso de São Paulo (formato que o card/parsers do frontend entendem).
function fmtSP(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const dt = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Sao_Paulo' });
  const hr = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
  return dt + ' ' + hr;
}

// Acha o lead do convidado: e-mail (email OU access_email) primeiro; senão últimos 8 dígitos do fone.
async function findLead(email, phoneDigits) {
  let lead = null;
  if (email) {
    lead = await getRow(
      "SELECT id, name, phone, validation_date FROM leads WHERE lower(email) = lower(?) OR lower(access_email) = lower(?) ORDER BY rowid DESC LIMIT 1",
      [email, email]
    );
  }
  if (!lead && phoneDigits && phoneDigits.length >= 8) {
    const last8 = phoneDigits.slice(-8);
    const rows = await allRows("SELECT id, name, phone, validation_date FROM leads ORDER BY rowid DESC", []);
    lead = (rows || []).find(l => String(l.phone || '').replace(/\D/g, '').endsWith(last8)) || null;
  }
  return lead;
}

// Varredura principal. logLeadHistory é injetado pelo index.js (evita require circular).
async function calendlySweep(logLeadHistory) {
  const cfg = await getCalendlySettings();
  if (!cfg.enabled || !cfg.token) return { skipped: true };
  const me = await api(cfg.token, '/users/me');
  const org = me && me.resource && me.resource.current_organization;
  if (!org) throw new Error('Organização do Calendly não encontrada (token sem users:read?)');
  // Janela: de ontem em diante (pega remarcações/cancelamentos recentes e todos os futuros).
  const minStart = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const events = [];
  let next = '/scheduled_events?organization=' + encodeURIComponent(org) +
    '&min_start_time=' + encodeURIComponent(minStart) + '&count=100&sort=start_time:asc';
  let guard = 0;
  while (next && guard++ < 10) {
    const j = await api(cfg.token, next);
    (j.collection || []).forEach(e => events.push(e));
    next = (j.pagination && j.pagination.next_page)
      ? String(j.pagination.next_page).replace('https://api.calendly.com', '')
      : null;
  }
  let updated = 0, semLead = 0, ignorados = 0;
  const kw = cfg.event_keyword ? new RegExp(cfg.event_keyword, 'i') : null;
  for (const ev of events) {
    try {
      const uuid = String(ev.uri || '').split('/').pop();
      if (!uuid) continue;
      if (kw && !kw.test(ev.name || '')) { ignorados++; continue; }
      const status = ev.status; // 'active' | 'canceled'
      const startIso = ev.start_time;
      const row = await getRow("SELECT * FROM calendly_events WHERE uuid = ?", [uuid]);
      if (row && row.status === status && row.start_time === startIso) continue; // nada mudou
      // Convidado (e-mail/telefone) — 1 por evento no fluxo da Vale Visto.
      let invitee = null;
      try {
        const inv = await api(cfg.token, '/scheduled_events/' + uuid + '/invitees?count=1');
        invitee = inv.collection && inv.collection[0];
      } catch (e) { /* segue sem convidado */ }
      const email = (invitee && invitee.email) || '';
      let phone = (invitee && invitee.text_reminder_number) || '';
      if (!phone && invitee && Array.isArray(invitee.questions_and_answers)) {
        const qa = invitee.questions_and_answers.find(q =>
          /(telefone|celular|whats|phone|fone)/i.test(q.question || '') ||
          /^\+?[\d\s().-]{8,}$/.test(String(q.answer || '').trim()));
        if (qa) phone = String(qa.answer || '');
      }
      const digits = String(phone).replace(/\D/g, '');
      const lead = await findLead(email, digits);
      const when = fmtSP(startIso);
      const invName = (invitee && invitee.name) || '';
      // Local/link da reunião: join_url (Zoom/Meet/Teams) ou o texto/URL do campo location.
      const loc = ev.location || {};
      const meetLink = loc.join_url || (/^https?:\/\//i.test(String(loc.location || '')) ? loc.location : '') || '';
      const locTxt = meetLink || String(loc.location || '') || '';
      if (!lead) {
        semLead++;
        await runQuery(
          "INSERT INTO calendly_events (uuid, lead_id, start_time, status, card_date, location, invitee_name, invitee_email, updated_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(uuid) DO UPDATE SET start_time = excluded.start_time, status = excluded.status, location = excluded.location, invitee_name = excluded.invitee_name, invitee_email = excluded.invitee_email, updated_at = excluded.updated_at",
          [uuid, startIso, status, when, locTxt, invName, email, Date.now()]
        );
        console.log('[Calendly] evento sem lead correspondente: ' + (invName || email || digits || uuid));
        continue;
      }
      if (status === 'active') {
        await runQuery("UPDATE leads SET validation_date = ? WHERE id = ?", [when, lead.id]);
        const remarcada = !!(row && row.card_date && row.card_date !== when);
        try {
          await logLeadHistory({
            leadId: lead.id, phone: lead.phone, name: lead.name, type: 'calendly',
            detail: '📅 Reunião de Validação ' + (remarcada ? 'REMARCADA' : 'agendada') + ' via Calendly: ' + when +
              (invName ? ' (convidado: ' + invName + ')' : ''),
            meta: uuid
          });
        } catch (e) {}
        updated++;
      } else if (status === 'canceled') {
        // Limpa a data do card apenas se ela ainda for a deste evento (não apaga data remarcada).
        const cur = await getRow("SELECT validation_date FROM leads WHERE id = ?", [lead.id]);
        const cardDate = (row && row.card_date) || when;
        if (cur && String(cur.validation_date || '').trim() === String(cardDate).trim()) {
          await runQuery("UPDATE leads SET validation_date = '' WHERE id = ?", [lead.id]);
        }
        try {
          await logLeadHistory({
            leadId: lead.id, phone: lead.phone, name: lead.name, type: 'calendly',
            detail: '🚫 Reunião de Validação CANCELADA no Calendly (era ' + when + ')',
            meta: uuid
          });
        } catch (e) {}
        updated++;
      }
      await runQuery(
        "INSERT INTO calendly_events (uuid, lead_id, start_time, status, card_date, location, invitee_name, invitee_email, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(uuid) DO UPDATE SET lead_id = excluded.lead_id, start_time = excluded.start_time, status = excluded.status, card_date = excluded.card_date, location = excluded.location, invitee_name = excluded.invitee_name, invitee_email = excluded.invitee_email, updated_at = excluded.updated_at",
        [uuid, lead.id, startIso, status, when, locTxt, invName, email, Date.now()]
      );
    } catch (e) { console.error('[Calendly] erro no evento:', e.message); }
  }
  const result = 'eventos: ' + events.length + ' · atualizados: ' + updated + ' · sem lead: ' + semLead;
  const cfg2 = await getCalendlySettings();
  cfg2.last_sync = Date.now();
  cfg2.last_result = result;
  await saveCalendlySettings(cfg2);
  console.log('[Calendly] sweep — ' + result);
  return { events: events.length, updated, semLead, ignorados };
}

module.exports = { getCalendlySettings, saveCalendlySettings, testCalendly, calendlySweep, CALENDLY_DEFAULTS: DEFAULTS };
