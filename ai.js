// IA (Google Gemini) na comunicação do WhatsApp.
// - 1ª interação nos "Novo Leads": coleta dados do cliente conforme as instruções
//   configuradas; quando concluir (dados coletados), o CHAMADOR move o card.
// - Follow-up nas colunas 2-3 do Tratamento inicial: texto gerado conforme instruções.
// Configuração em app_settings (key 'ai_settings'), editável em Configurações.
const https = require('https');
const { runQuery, getRow, allRows } = require('./db');

const DEFAULTS = {
  enabled: false,
  gemini_key: '',
  model: 'gemini-2.0-flash',
  novo_enabled: false,
  novo_instructions: 'Você é o atendente virtual da Eccere / Vale Visto (consultoria de vistos e cidadania). ' +
    'Cumprimente o cliente pelo nome se souber, agradeça o contato e colete com gentileza: ' +
    '1) nome completo; 2) qual serviço/tipo de visto procura; 3) prazo ou urgência. ' +
    'Faça UMA pergunta por mensagem, seja breve e cordial. NUNCA invente preços, prazos ou requisitos — ' +
    'diga que um consultor confirmará os detalhes. Quando já tiver nome e serviço, agradeça e avise que ' +
    'um consultor dará sequência ao atendimento.',
  fu_enabled: false,
  fu_instructions: 'Escreva uma mensagem CURTA e gentil de follow-up retomando a última conversa: ' +
    'pergunte se o cliente ainda tem interesse e se ficou alguma dúvida. Não seja insistente, ' +
    'não invente informações e não repita follow-ups anteriores.',
  fu_hours: 24,
  fu_max: 2
};

async function getAiSettings() {
  try {
    const row = await getRow("SELECT value FROM app_settings WHERE key = 'ai_settings'");
    const cfg = row && row.value ? JSON.parse(row.value) : {};
    return Object.assign({}, DEFAULTS, cfg);
  } catch (e) { return Object.assign({}, DEFAULTS); }
}

function saveAiSettings(cfg) {
  return runQuery(
    "INSERT INTO app_settings (key, value) VALUES ('ai_settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [JSON.stringify(cfg || {})]
  );
}

// Chamada REST ao Gemini (generateContent). contents: [{role:'user'|'model', text}]
function callGemini(cfg, systemText, contents, jsonMode) {
  return new Promise((resolve, reject) => {
    if (!cfg.gemini_key) return reject(new Error('Chave da API Gemini não configurada'));
    const model = cfg.model || DEFAULTS.model;
    const body = JSON.stringify({
      system_instruction: { parts: [{ text: systemText || '' }] },
      contents: contents.map(c => ({ role: c.role, parts: [{ text: String(c.text || '').slice(0, 4000) }] })),
      generationConfig: Object.assign(
        { temperature: 0.7, maxOutputTokens: 500 },
        jsonMode ? { responseMimeType: 'application/json' } : {}
      )
    });
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: '/v1beta/models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(cfg.gemini_key),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 30000
    }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.error) return reject(new Error(j.error.message || 'Erro da API Gemini'));
          const txt = j.candidates && j.candidates[0] && j.candidates[0].content &&
            j.candidates[0].content.parts && j.candidates[0].content.parts.map(p => p.text || '').join('');
          if (!txt) return reject(new Error('Resposta vazia do Gemini'));
          resolve(txt);
        } catch (e) { reject(new Error('Resposta inválida do Gemini: ' + String(data).slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { try { req.destroy(new Error('Timeout na API Gemini')); } catch (e) {} });
    req.write(body); req.end();
  });
}

// Monta o histórico da conversa no formato do Gemini (últimas N mensagens, só texto)
async function buildContents(convoId, limit) {
  const msgs = await allRows(
    "SELECT `from`, text, type FROM messages WHERE conversationId = ? ORDER BY timestamp DESC LIMIT ?",
    [convoId, limit || 20]
  );
  return msgs.reverse().map(m => ({
    role: m.from === 'me' ? 'model' : 'user',
    text: (m.type && m.type !== 'text') ? ('[' + m.type + '] ' + (m.text || '')) : (m.text || '')
  })).filter(c => c.text.trim());
}

// 1ª interação (Novo Leads): devolve { reply, dados_coletados } ou null se IA desligada
async function getNovoLeadReply(convoId, leadName) {
  const cfg = await getAiSettings();
  if (!cfg.enabled || !cfg.novo_enabled || !cfg.gemini_key) return null;
  const contents = await buildContents(convoId, 20);
  if (!contents.length) return null;
  const system = cfg.novo_instructions +
    '\n\nContexto: o lead chama-se "' + (leadName || 'desconhecido') + '" e está na etapa "Novo Leads" do CRM.' +
    '\nResponda SEMPRE em JSON válido neste formato exato: ' +
    '{"reply": "texto da mensagem ao cliente", "dados_coletados": true ou false}. ' +
    '"dados_coletados" deve ser true SOMENTE quando você já souber o nome do cliente E o serviço de interesse.';
  const raw = await callGemini(cfg, system, contents, true);
  try {
    const j = JSON.parse(raw);
    if (j && j.reply) return { reply: String(j.reply).slice(0, 1500), dados_coletados: !!j.dados_coletados };
  } catch (e) {
    // se o modelo não devolveu JSON, usa o texto cru como resposta (sem mover o card)
    return { reply: String(raw).slice(0, 1500), dados_coletados: false };
  }
  return null;
}

// Follow-up (Tratamento inicial, colunas 2-3): devolve texto ou null
async function getFollowUpReply(convoId, leadName, tentativa) {
  const cfg = await getAiSettings();
  if (!cfg.enabled || !cfg.fu_enabled || !cfg.gemini_key) return null;
  const contents = await buildContents(convoId, 20);
  if (!contents.length) return null;
  const system = cfg.fu_instructions +
    '\n\nContexto: o lead chama-se "' + (leadName || 'desconhecido') + '". ' +
    'Esta é a tentativa de follow-up nº ' + (tentativa || 1) + '. ' +
    'Responda APENAS com o texto da mensagem (sem JSON, sem aspas, sem explicações).';
  const txt = await callGemini(cfg, system, contents, false);
  return String(txt).trim().slice(0, 1200) || null;
}

module.exports = { getAiSettings, saveAiSettings, callGemini, getNovoLeadReply, getFollowUpReply, AI_DEFAULTS: DEFAULTS };
