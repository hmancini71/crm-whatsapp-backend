// pipeline452: "Relatório crítico de conversão" (guia IA) — analisa, via API Anthropic (Claude),
// as conversas de WhatsApp dos leads do "Tratamento inicial" num período e responde: (a)
// principais dificuldades de conversão; (b) nível de qualificação dos leads; (c) principais
// razões pelas quais os leads não fecham; (d) principais gaps no processo de conversão; (e)
// principais deficiências do nosso papel como vendedor.
//
// IMPORTANTE: isto é 100% INDEPENDENTE do loop de IA do Gemini (ai.js) usado no atendimento e
// follow-up do WhatsApp — não reaproveita nem altera nada daquele fluxo, só lê mensagens já
// gravadas no banco. Roda em BACKGROUND (setImmediate + awaits sequenciais) para não travar o
// event loop; só 1 job por vez (checado via status 'queued'/'running' na tabela ai_reports).
const https = require('https');
const crypto = require('crypto');
const { runQuery, getRow, allRows } = require('./db');
const { getAiSettings } = require('./ai');

const CHUNK_SIZE = 12;
const LEAD_CAP = 150;
const MAX_MSGS_PER_LEAD = 50;
const MAX_CHARS_PER_LEAD = 3500;

function newId() { return crypto.randomBytes(12).toString('hex'); }

// ===== Chamada REST à API Anthropic (Messages API) =====
function callClaudeOnce(apiKey, model, maxTokens, systemText, userText) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: systemText || '',
      messages: [{ role: 'user', content: userText }]
    });
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 120000
    }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        let j;
        try { j = JSON.parse(data); } catch (e) {
          return reject(new Error('Resposta inválida da API Anthropic (HTTP ' + res.statusCode + ')'));
        }
        if (res.statusCode === 401) return reject(new Error('chave Anthropic inválida'));
        if (j.error) {
          const msg = (j.error && j.error.message) || ('Erro da API Anthropic (HTTP ' + res.statusCode + ')');
          return reject(new Error(msg));
        }
        if (res.statusCode >= 400) return reject(new Error('Erro da API Anthropic (HTTP ' + res.statusCode + ')'));
        const txt = j.content && j.content[0] && j.content[0].text;
        if (!txt) return reject(new Error('Resposta vazia da API Anthropic'));
        resolve(txt);
      });
    });
    req.on('error', (e) => reject(new Error('Falha de rede ao chamar a API Anthropic: ' + e.message)));
    req.on('timeout', () => { try { req.destroy(new Error('Timeout na API Anthropic')); } catch (e) {} });
    req.write(body); req.end();
  });
}

// Retry 1x (só p/ falhas transitórias — não repete em chave inválida).
async function callClaude(apiKey, model, maxTokens, systemText, userText) {
  try {
    return await callClaudeOnce(apiKey, model, maxTokens, systemText, userText);
  } catch (e) {
    if (/chave Anthropic inválida/i.test(e.message)) throw e;
    await new Promise(r => setTimeout(r, 1500));
    return await callClaudeOnce(apiKey, model, maxTokens, systemText, userText);
  }
}

// ===== Seleção de leads do "Tratamento inicial" no período =====
// Mesmo padrão de join lead→conversa usado em /api/dashboard/response-time (index.js): casa por
// whatsapp_jid exato ou pelos últimos 8 dígitos do telefone.
async function findLeadsAndMessages(fromIso, toIso) {
  const fromTs = new Date(fromIso + 'T00:00:00-03:00').getTime();
  const toTs = new Date(toIso + 'T23:59:59-03:00').getTime();

  const leads = await allRows(
    "SELECT id, name, phone, whatsapp_jid, source, value, tags, createdAt FROM leads WHERE archived = 0 AND stage = 'tratamento'"
  );
  const convs = await allRows("SELECT id, account, phone, whatsapp_jid FROM conversations WHERE (archived IS NULL OR archived = 0)");
  const norm = (p) => String(p || '').replace(/\D/g, '');
  const convByLead = new Map();
  for (const l of leads) {
    const lt = norm(l.phone).slice(-8);
    const conv = convs.find(c =>
      (l.whatsapp_jid && c.whatsapp_jid && c.whatsapp_jid === l.whatsapp_jid) ||
      (lt.length === 8 && norm(c.phone).slice(-8) === lt)
    );
    if (conv) convByLead.set(l.id, conv.id);
  }

  const convIds = Array.from(new Set(Array.from(convByLead.values())));
  if (!convIds.length) return { picked: [], truncated: false, totalCandidates: 0 };

  const ph = convIds.map(() => '?').join(',');
  const msgRows = await allRows(
    "SELECT conversationId, `from`, text, timestamp FROM messages WHERE conversationId IN (" + ph + ") AND timestamp >= ? AND timestamp <= ? ORDER BY conversationId, timestamp ASC",
    [...convIds, fromTs, toTs]
  );
  const msgsByConv = new Map();
  for (const m of msgRows) {
    if (!msgsByConv.has(m.conversationId)) msgsByConv.set(m.conversationId, []);
    msgsByConv.get(m.conversationId).push(m);
  }

  const createdInPeriod = (l) => {
    const t = Date.parse(l.createdAt || '');
    return !isNaN(t) && t >= fromTs && t <= toTs;
  };

  const candidates = [];
  for (const l of leads) {
    const convId = convByLead.get(l.id);
    const msgs = convId ? (msgsByConv.get(convId) || []) : [];
    if (createdInPeriod(l) || msgs.length > 0) {
      candidates.push({ lead: l, msgs });
    }
  }
  // Prioriza quem tem mais mensagens no período (conversas mais ricas p/ a análise) ao cortar.
  candidates.sort((a, b) => b.msgs.length - a.msgs.length);
  const truncated = candidates.length > LEAD_CAP;
  const picked = candidates.slice(0, LEAD_CAP);
  return { picked, truncated, totalCandidates: candidates.length };
}

function buildLeadContext(item) {
  const l = item.lead;
  const msgs = item.msgs.slice(-MAX_MSGS_PER_LEAD);
  let lines = msgs.map(m => (m.from === 'me' ? 'VENDEDOR: ' : 'CLIENTE: ') + String(m.text || '').replace(/\s+/g, ' ').trim())
    .filter(l2 => l2.length > 'VENDEDOR: '.length);
  let text = lines.join('\n');
  if (text.length > MAX_CHARS_PER_LEAD) text = text.slice(text.length - MAX_CHARS_PER_LEAD); // mantém o trecho mais RECENTE
  const meta = [
    'Lead: ' + (l.name || '(sem nome)'),
    'Origem: ' + (l.source || 'não informado'),
    'Valor estimado: ' + (l.value ? ('R$ ' + l.value) : 'não informado')
  ].join(' | ');
  return meta + '\nConversa:\n' + (text || '(sem mensagens no período)');
}

const MAP_SYSTEM = `Você é um analista sênior de vendas/CRM especializado em consultoria de vistos e imigração (Vale Visto).
Receberá um lote de conversas de WhatsApp entre um VENDEDOR e CLIENTES (leads) que ainda não fecharam negócio.
Para CADA lead do lote, extraia evidências OBJETIVAS (baseadas só no texto, sem inventar) em JSON.
Responda APENAS um array JSON, um objeto por lead, no formato:
[{"lead":"nome","objecoes":["..."],"qualificacao_0_10":N,"motivo_provavel_nao_fechou":"...","falhas_do_vendedor":["..."],"gaps_processo":["..."]}]
Se não houver evidência suficiente para um campo, use array vazio ou null. Não inclua texto fora do JSON.`;

const REDUCE_SYSTEM = `Você é um consultor de vendas sênior. Receberá evidências (JSON) extraídas de várias conversas de WhatsApp
de leads de uma consultoria de vistos/imigração (Vale Visto) que estão na fase "Tratamento inicial" (pré-venda) e
ainda não fecharam. Escreva um RELATÓRIO em markdown, em português do Brasil, com:
1. Um sumário executivo (3-5 linhas).
2. EXATAMENTE estas 5 seções, nesta ordem, cada uma com achados concretos e EXEMPLOS NOMINAIS (cite nomes de leads das evidências) e recomendações práticas ao final de cada seção:
   ## 1. Principais dificuldades de conversão
   ## 2. Nível de qualificação dos leads
   ## 3. Principais razões pelas quais os leads não fecham
   ## 4. Principais gaps no processo de conversão
   ## 5. Principais deficiências do nosso papel como vendedor
Seja direto, crítico e específico — evite generalidades. Baseie-se SOMENTE nas evidências fornecidas.`;

async function setReport(id, fields) {
  const cur = await getRow("SELECT * FROM ai_reports WHERE id = ?", [id]);
  const next = Object.assign({}, cur, fields);
  await runQuery(
    "UPDATE ai_reports SET status=?, progress=?, result=?, error=? WHERE id=?",
    [next.status, next.progress, next.result, next.error, id]
  );
}

async function runConversionReport(id, fromIso, toIso) {
  try {
    await setReport(id, { status: 'running', progress: 'buscando leads do Tratamento inicial…' });
    const cfg = await getAiSettings();
    const apiKey = cfg.anthropic_key;
    const model = cfg.anthropic_model || 'claude-fable-5';
    if (!apiKey) throw new Error('chave Anthropic não configurada');

    const { picked, truncated, totalCandidates } = await findLeadsAndMessages(fromIso, toIso);
    console.log('[reports] conversion-analysis', id, 'leads candidatos:', totalCandidates, 'selecionados:', picked.length, 'cortado:', !!truncated);
    if (!picked.length) throw new Error('Nenhum lead com conversa no período informado.');

    const chunks = [];
    for (let i = 0; i < picked.length; i += CHUNK_SIZE) chunks.push(picked.slice(i, i + CHUNK_SIZE));

    const cutNote = truncated ? (' (analisando os ' + LEAD_CAP + ' leads mais ativos de ' + totalCandidates + ' candidatos)') : '';
    const evidences = [];
    for (let i = 0; i < chunks.length; i++) {
      await setReport(id, { status: 'running', progress: 'chunk ' + (i + 1) + '/' + chunks.length + cutNote });
      const userText = chunks[i].map((item, idx) => '--- LEAD ' + (idx + 1) + ' ---\n' + buildLeadContext(item)).join('\n\n');
      let out;
      try {
        out = await callClaude(apiKey, model, 2000, MAP_SYSTEM, userText);
      } catch (e) {
        if (/chave Anthropic inválida/i.test(e.message)) throw e;
        throw new Error('Falha ao processar chunk ' + (i + 1) + '/' + chunks.length + ': ' + e.message);
      }
      let parsed;
      try {
        const m = out.match(/\[[\s\S]*\]/);
        parsed = JSON.parse(m ? m[0] : out);
      } catch (e) { parsed = [{ raw: out.slice(0, 1500) }]; }
      evidences.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    }

    await setReport(id, { status: 'running', progress: 'gerando relatório final…' });
    const reduceInput = 'Período analisado: ' + fromIso + ' a ' + toIso + '. Total de leads: ' + picked.length + cutNote + '.\n\n' +
      'Evidências por lead (JSON):\n' + JSON.stringify(evidences).slice(0, 60000);
    let finalMd;
    try {
      finalMd = await callClaude(apiKey, model, 4000, REDUCE_SYSTEM, reduceInput);
    } catch (e) {
      throw new Error('Falha ao gerar o relatório final: ' + e.message);
    }

    await setReport(id, { status: 'done', progress: 'concluído', result: finalMd, error: null });
    console.log('[reports] conversion-analysis', id, 'concluído. leads analisados:', picked.length);
  } catch (e) {
    let msg = e.message || 'Erro desconhecido';
    if (/chave Anthropic inválida|invalid x-api-key|authentication_error/i.test(msg)) msg = 'chave Anthropic inválida';
    if (/chave Anthropic não configurada/i.test(msg)) msg = 'chave Anthropic não configurada';
    console.error('[reports] conversion-analysis', id, 'erro:', msg);
    await setReport(id, { status: 'error', progress: null, error: msg });
  }
}

async function createConversionReportJob(fromIso, toIso) {
  const running = await getRow("SELECT id FROM ai_reports WHERE type = 'conversion-analysis' AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1");
  if (running) { const err = new Error('Já existe um relatório em andamento.'); err.status = 409; throw err; }
  const id = newId();
  await runQuery(
    "INSERT INTO ai_reports (id, type, period_from, period_to, status, progress, result, error, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    [id, 'conversion-analysis', fromIso, toIso, 'queued', 'na fila…', null, null, new Date().toISOString()]
  );
  setImmediate(() => { runConversionReport(id, fromIso, toIso).catch((e) => console.error('[reports] job não tratado:', e && e.message)); });
  return getRow("SELECT * FROM ai_reports WHERE id = ?", [id]);
}

function listConversionReports(limit) {
  return allRows("SELECT id, type, period_from, period_to, status, progress, error, created_at FROM ai_reports WHERE type = 'conversion-analysis' ORDER BY created_at DESC LIMIT ?", [limit || 10]);
}
function getConversionReport(id) {
  return getRow("SELECT * FROM ai_reports WHERE id = ? AND type = 'conversion-analysis'", [id]);
}
function getLatestConversionReport() {
  return getRow("SELECT * FROM ai_reports WHERE type = 'conversion-analysis' ORDER BY created_at DESC LIMIT 1");
}

module.exports = {
  createConversionReportJob,
  listConversionReports,
  getConversionReport,
  getLatestConversionReport
};
