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
  novo_instructions: `Você é o Jorge, atendente virtual da Vale Visto (consultoria de vistos e cidadania) que tem a persona de um especialista em vendas de serviços de imigração. Cumprimente o cliente pelo nome se souber, agradeça o contato, faça uma apresentação curta sobre a Vale Visto e colete com gentileza: 1) nome completo; 2) qual serviço/tipo de visto procura.
Faça as perguntas que forem necessárias para classificar o pedido em algumas das opções a seguir:
A01 - 1 visto americano B1B2
A02 - renov visto amer B1B2 -repres
A03 - renov visto amer B1B2 +repres
A04 - passap + 1 visto amer B1/B2
A05 - passap + ren visto amer B1B2 +repres
A06 - passap + ren visto amer B1B2 -repres
A07 - visto americano F1 e/ou F2
A08 - passap + 1 visto amer F1 e/ou F2
A09 - Visto trânsito C1
A10 - visto K (noiva)
A11 - visto amer C1/D
A12 - visto amer B1 in lieu
A13 - visto amer J1
A14 - Visto L1/L2
A15 - visto amer B1 - empregada
A16 - visto amer O
A17 - visto amer R Religioso
A18 - visto EB2
A19 - ITIN
A20 - green card
A22 - ESTA
A23 - renov passap americano
A24 - FOIA
A25 - agend exame green card
A26 - FBI Background Check
A27 - Representação
A28 - EB2NIW
A29 - Serviços de sistema do consulado
A30 - extensão/ mudança de status
A31 - EB1
A32 - Waiver
B01 - Visto de estudo brasileiro
C01 - visto canadense Est
C02 - visto canadense Tur
C03 - visto trabalho canada
C04 - ETA
M01 - visto mexicano
M02 - visto brasileiro
M03 - visto chinês
M04 - visto australiano
M05 - visto de estudo Japão
M06 - AIRE
M07 - Visto autônomo brasileiro
M08 - segunda via certidão japonesa
M09 - Agend pass italiano
M10 - Visto Espanhol
M11 - Visto RD Congo
M12 - Passaporte alemão
M13 - cpf para estrangeiro
M14 - visto trabalho Itália
P01 - visto procura trabalho portugal
P02 - visto D4 estudo portugal
P03 - visto D1 (trabalho com contrato) Portugal
P04 - visto D3 Português
P05 - visto português D7
P06 - visto nômade digital Portugal
P07 - NIF/ NISS
P08 - Passap português / cartão cidadão
P09 - cidadania port
P10 - Visto turismo português
PA - passaporte
Se houver ambiguidade na informação, pergunte para esclarecer (exemplo, o cliente fala que quer visto americano mas não diz se é primeiro visto ou renovação).
Após identificar qual o serviço, você deve colocar a tag do serviço no card.
Após identificar o serviço, pergunte sobre prazo ou urgência. Faça UMA pergunta por mensagem, seja breve e cordial. NUNCA invente preços, prazos ou requisitos — diga que um consultor trabalha de segunda a sexta das 9h às 18h e ele confirmará os detalhes. Quando já tiver nome e serviço, agradeça e avise que um consultor especializado dará sequência ao atendimento.
Apenas conclua (transfira o card) depois de obter o nome E o serviço desejado pelo cliente.
Informações sobre a Vale Visto (use para a apresentação e para responder dúvidas, sem inventar):
A Vale Visto Imigração é uma empresa especializada em assessoria para obtenção de vistos e residência para os Estados Unidos, Brasil, Canadá, Portugal, México, China e muitos outros locais, além de cidadania portuguesa. Com mais de uma década de experiência, é líder em consultoria de visto e imigração, com o maior índice de aprovação do mercado. Cuidamos do preenchimento técnico dos formulários, agendamento das entrevistas no consulado e facilitamos o pagamento da taxa consular (inclusive parcelamento no cartão Visa/Mastercard). Atendemos todo o Brasil, presencialmente e online.
Escritórios: (1) Rua José Maria Whitaker 887, sala 1, Vila Mariana, São Paulo (a 200 m do Centro de Atendimento de Vistos do Consulado Americano); (2) Shopping Oriente, Rua Andorra 500, São José dos Campos/SP (estacionamento gratuito).
Horário de funcionamento: segunda a sexta das 9h às 18h e aos sábados das 9h às 13h.
E-mail: contato@valevisto.com.br | WhatsApp (somente mensagens): (12) 98181-8964 | Telefone (somente ligações): (12) 98248-3094, (11) 96502-2030, (12) 99136-0550.`,
  fu_enabled: false,
  fu_instructions: 'Escreva uma mensagem CURTA e gentil de follow-up retomando a última conversa: ' +
    'pergunte se o cliente ainda tem interesse e se ficou alguma dúvida. Não seja insistente, ' +
    'não invente informações e não repita follow-ups anteriores.',
  fu_hours: 24,
  fu_max: 2
};

// Regras invioláveis anti-alucinação — injetadas em TODA geração da IA, no código (não editáveis),
// com prioridade acima de qualquer instrução. Impedem a IA de inventar preços, prazos, etc.
const GUARDRAILS = `[REGRAS INVIOLÁVEIS — PRIORIDADE MÁXIMA, ACIMA DE QUALQUER OUTRA INSTRUÇÃO]
1. NUNCA invente, estime, sugira ou "chute" preços, valores, taxas, mensalidades, descontos, formas de pagamento, prazos de processo, tempo de entrega, datas de entrevista, requisitos ou qualquer promessa. Você NÃO possui essas informações.
2. Se o cliente perguntar preço, valor, "quanto custa" ou prazo: NÃO diga nenhum número. Responda que um consultor especializado informará os valores e detalhes exatos. É TERMINANTEMENTE PROIBIDO citar valores (ex.: "R$ 499", "R$ 450" ou qualquer outro) — esses valores são FALSOS.
3. Afirme apenas o que estiver EXPLICITAMENTE escrito nestas instruções. Se não souber algo, diga que o consultor confirmará. É melhor não responder do que inventar.
4. Nunca invente nomes, e-mails, endereços, números de telefone ou fatos que não estejam nestas instruções.
5. Nunca invente perfis de REDES SOCIAIS nem qualquer canal de contato: Instagram, @usuário, Facebook, TikTok, YouTube, links, sites ou URLs. Só cite um perfil/@/link se ele estiver LITERALMENTE escrito nestas instruções. Se o cliente pedir o Instagram (ou outra rede/site) e ele NÃO constar aqui, é PROIBIDO inventar um @ ou endereço — responda que um consultor vai te passar os canais oficiais. Jamais afirme "temos Instagram" citando um @ que você não viu nestas instruções.
6. VOCÊ NÃO DÁ ORIENTAÇÃO NEM RESPONDE DÚVIDAS SOBRE O PROCESSO. É TERMINANTEMENTE PROIBIDO opinar, explicar ou afirmar qualquer coisa sobre: agendamento, datas, disponibilidade de agenda, local/consulado/CASV/cidade da coleta de digitais (biometria) ou da entrevista, se pode fazer em cidades diferentes, documentos, requisitos, elegibilidade, chances de aprovação, "implicações", motivos de reprovação, ou perguntas de viabilidade ("é possível?", "consegue?", "tem como?", "pode?"). Você NÃO sabe a agenda nem as regras do caso. Para QUALQUER pergunta desse tipo, sua ÚNICA resposta é dizer que um consultor especializado vai dar a orientação correta e personalizada — NUNCA improvise uma resposta, mesmo que pareça simples ou óbvia. Seu papel é apenas de RECEPÇÃO: cumprimentar, apresentar a Vale Visto brevemente e coletar (1) o nome e (2) o serviço/visto desejado. Tudo além disso é com o consultor humano. Jamais responda "Sim", "Não", "pode", "não tem problema" a uma pergunta de processo — encaminhe ao consultor. EXCEÇÃO ÚNICA: você PODE perguntar se há um horário em que o nosso consultor possa fazer contato telefônico (ligar) — isso serve apenas para COLETAR a preferência do cliente. Mas NUNCA confirme, marque, agende ou garanta um horário: a confirmação é SEMPRE feita por um consultor HUMANO. Se o cliente sugerir um horário, diga que vai repassar ao consultor para confirmar — nunca diga "confirmado/marcado/às X então".`;

// Catálogo de serviços/vistos. A IA DEVE escolher um código exato daqui antes de transferir o lead.
const SERVICE_TAGS = [
  "A01 - 1 vista americana B1B2", "A02 - renov vista amer B1B2 -reprov", "A03 - renov vista amer B1B2 +reprov",
  "A04 - passap + 1 vista amer B1/B2", "A05 - passap + ren vista amer B1B2 +reprov", "A06 - passap + ren vista amer B1B2 -reprov",
  "A07 - vista americana F1 e/ou F2", "A08 - passap + 1 vista amer F1 e/ou F2", "A09 - Vista trânsito C1",
  "A10 - vista K (noiva)", "A11 - vista amer C1/D", "A12 - vista amer B1 in lieu", "A13 - vista amer J1",
  "A14 - Vista L1/L2", "A15 - vista amer B1 - empregada", "A16 - vista amer O", "A17 - vista amer R Religioso",
  "A18 - vista EB2", "A19 - ITIN", "A20 - green card", "A22 - ESTA", "A23 - renov passap americano", "A24 - FOIA",
  "A25 - agend exame green card", "A26 - FBI Background Check", "A27 - Representação", "A28 - EB2NIW",
  "A29 - Serviço p/ desistência de consulado", "A30 - extensão/ mudança de status", "A31 - EB1", "A32 - Waiver",
  "B01 - Vista de estudo brasileiro",
  "C01 - vista canadense Ext", "C02 - vista canadense Tur", "C03 - vista trabalho canada", "C04 - ETA",
  "M01 - vista mexicano", "M02 - vista brasileiro", "M03 - vista chinês", "M04 - vista australiano",
  "M05 - vista de estudo Japão", "M06 - AIRE", "M07 - Vista autônomo brasileiro", "M08 - segunda via certidão japonesa",
  "M09 - Agend pass italiano", "M10 - Vista Espanhol", "M11 - Vista RD Congo", "M12 - Passaporte alemão",
  "M13 - cpf para estrangeiro", "M14 - vista trabalho Itália",
  "P01 - vista procura trabalho portugal", "P02 - vista D4 estudo portugal", "P03 - vista D1 (trabalho com contrato) P",
  "P04 - vista D3 Português", "P05 - vista português D7", "P06 - vista nômade digital Portugal", "P07 - NIF / NISS",
  "P08 - Passap português / cartão cidadão", "P09 - cidadania part", "P10 - Vista turismo português", "PA - passaporte"
];

// Valida/normaliza a tag escolhida pela IA: aceita string exata do catálogo OU só o código (ex.: "A01").
function normalizeServiceTag(t) {
  if (!t) return '';
  const s = String(t).trim();
  if (SERVICE_TAGS.includes(s)) return s;
  const code = s.split(/[\s-]/)[0].toUpperCase();
  const byCode = SERVICE_TAGS.find(tag => tag.toUpperCase().startsWith(code + ' '));
  return byCode || '';
}

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
        // Temperatura baixa = mais fiel às instruções, menos "criatividade"/invenção
        // (ex.: deixar de inventar preços). Pode ser sobrescrita via cfg.temperature.
        { temperature: (typeof cfg.temperature === 'number' ? cfg.temperature : 0.3), maxOutputTokens: 2048 },
        // Modelos 2.5 são de "raciocínio": sem isso, o thinking consome a cota de saída e o
        // JSON volta truncado/vazio (a IA não responde). thinkingBudget:0 desliga o raciocínio.
        /2\.5/.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {},
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

// Monta o histórico da conversa no formato do Gemini (últimas N mensagens, só texto).
// O Gemini exige que a última mensagem seja sempre role:'user'; remove model-trailing.
async function buildContents(convoId, limit) {
  const msgs = await allRows(
    "SELECT `from`, text, type FROM messages WHERE conversationId = ? ORDER BY timestamp DESC LIMIT ?",
    [convoId, limit || 20]
  );
  const contents = msgs.reverse().map(m => ({
    role: m.from === 'me' ? 'model' : 'user',
    text: (m.type && m.type !== 'text') ? ('[' + m.type + '] ' + (m.text || '')) : (m.text || '')
  })).filter(c => c.text.trim());
  // Remove mensagens finais do tipo 'model' para garantir que a última seja 'user'
  while (contents.length && contents[contents.length - 1].role === 'model') contents.pop();
  return contents;
}

// Rede de segurança determinística: varre o TEXTO que a IA quer enviar e BLOQUEIA os casos mais
// arriscados de informação inventada — preço/valor em dinheiro, @ de rede social que não seja
// @valevisto, e links/sites que não sejam da Vale Visto. Se detectar, substitui por uma resposta
// segura (encaminha ao consultor) e registra no log para revisão. Não substitui o prompt — é uma
// camada extra: mesmo que o modelo escorregue, o dado inventado NÃO chega ao cliente.
function sanitizeAiReply(reply) {
  const t = String(reply || '');
  let bad = null;
  if (/R\$\s*\d/.test(t) || /\b\d{1,4}([.,]\d{2})?\s*reais\b/i.test(t) || /\b\d{1,4}\s*(?:d[óo]lares|usd)\b/i.test(t)) bad = 'preço/valor';
  if (!bad) {
    const handles = t.match(/@[a-z0-9._]{2,}/ig) || [];
    if (handles.some(h => !/valevisto/i.test(h))) bad = 'rede social';
  }
  if (!bad) {
    const urls = t.match(/(?:https?:\/\/|www\.)[^\s]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|br|net|org|io|co)\b(?:\/[^\s]*)?/ig) || [];
    if (urls.some(u => !/valevisto/i.test(u))) bad = 'link/site';
  }
  if (bad) {
    console.warn('[IA guardrail] resposta BLOQUEADA (possível ' + bad + ' inventado): ' + t.slice(0, 220));
    try { runQuery("INSERT INTO ai_guardrail_log (ts, kind, sample) VALUES (?, ?, ?)", [Date.now(), bad, t.slice(0, 220)]).catch(() => {}); } catch (e) {}
    return { safe: 'Para te passar essa informação com precisão, vou pedir para um consultor especializado confirmar com você. Posso te ajudar em mais alguma coisa? 🙏', blocked: bad };
  }
  return { safe: t, blocked: null };
}

// 1ª interação (Novo Leads): devolve { reply, visa_tag, dados_coletados } ou null se IA desligada.
// O lead só é transferido (pelo chamador) quando dados_coletados=true E visa_tag for um código válido.
async function getNovoLeadReply(convoId, leadName) {
  const cfg = await getAiSettings();
  if (!cfg.enabled || !cfg.novo_enabled || !cfg.gemini_key) return null;
  const contents = await buildContents(convoId, 20);
  if (!contents.length) return null;
  const system = GUARDRAILS + '\n\n' + cfg.novo_instructions +
    '\n\nContexto: o lead chama-se "' + (leadName || 'desconhecido') + '" e está na etapa "Novo Leads" do CRM.' +
    '\n\n[FORMATO DE SAÍDA OBRIGATÓRIO] Responda SEMPRE em JSON válido EXATO, sem nada fora do JSON: ' +
    '{"reply": "texto da mensagem ao cliente", "visa_tag": "código exato da tabela do enunciado (ex.: A01) ou string vazia se ainda não identificou", "dados_coletados": true ou false}. ' +
    'Regra de transferência: "dados_coletados" só pode ser true quando você já souber o NOME do cliente E tiver escolhido um "visa_tag" específico da tabela (sem ambiguidade). ' +
    'Enquanto o serviço estiver ambíguo, mantenha visa_tag vazio e dados_coletados=false e faça mais UMA pergunta.' +
    '\n\nLEMBRETE FINAL: cumpra as REGRAS INVIOLÁVEIS do início. JAMAIS escreva preços, valores, taxas ou prazos no campo "reply" — qualquer número desses seria FALSO. Se o cliente perguntar valor/preço, o "reply" deve dizer que um consultor informará os valores exatos.';
  const raw = await callGemini(cfg, system, contents, true);
  // Parsing robusto: tenta JSON direto, depois bloco { }, depois sem markdown.
  const tryParse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };
  let j = tryParse(raw);
  if (!j) { const m = raw.match(/\{[\s\S]*\}/); if (m) j = tryParse(m[0]); }
  if (!j) { j = tryParse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
  if (j && j.reply) {
    const tag = normalizeServiceTag(j.visa_tag);
    const san = sanitizeAiReply(String(j.reply).slice(0, 1500));
    return {
      reply: san.safe,
      visa_tag: tag,
      // só conclui se houver tag válida E a resposta não tiver sido bloqueada pelo filtro.
      dados_coletados: !san.blocked && !!j.dados_coletados && !!tag
    };
  }
  // Fallback: extrai o texto do "reply" mesmo de JSON sujo/truncado (sem parsear o objeto inteiro),
  // para nunca enviar o JSON cru ao cliente e ainda assim aproveitar a resposta quando possível.
  {
    const rm = raw.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (rm && rm[1].trim()) {
      const txt = rm[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim();
      const tm = raw.match(/"visa_tag"\s*:\s*"([^"]*)"/);
      return { reply: sanitizeAiReply(txt.slice(0, 1500)).safe, visa_tag: normalizeServiceTag(tm ? tm[1] : ''), dados_coletados: false };
    }
  }
  // Se parece JSON (mesmo truncado tipo {"reply":) mas não deu pra extrair, NÃO envia o cru ao cliente.
  if (raw.trim().startsWith('{') || raw.includes('"reply"')) return null;
  // Texto simples (sem JSON) → usa como resposta, sem concluir
  return { reply: sanitizeAiReply(String(raw).trim().slice(0, 1500)).safe, visa_tag: '', dados_coletados: false };
}

// Follow-up (Tratamento inicial, colunas 2-3): devolve texto ou null
async function getFollowUpReply(convoId, leadName, tentativa) {
  const cfg = await getAiSettings();
  if (!cfg.enabled || !cfg.fu_enabled || !cfg.gemini_key) return null;
  const contents = await buildContents(convoId, 20);
  if (!contents.length) return null;
  const system = GUARDRAILS + '\n\n' + cfg.fu_instructions +
    '\n\nContexto: o lead chama-se "' + (leadName || 'desconhecido') + '". ' +
    'Esta é a tentativa de follow-up nº ' + (tentativa || 1) + '. ' +
    'Responda APENAS com o texto da mensagem (sem JSON, sem aspas, sem explicações). ' +
    'Jamais cite preços, valores ou prazos (ver REGRAS INVIOLÁVEIS).';
  const txt = await callGemini(cfg, system, contents, false);
  const san = sanitizeAiReply(String(txt).trim().slice(0, 1200));
  // No follow-up, se a resposta cair no filtro (preço/@/link inventado), NÃO envia nada nesta rodada.
  return san.blocked ? null : (san.safe || null);
}

module.exports = { getAiSettings, saveAiSettings, callGemini, getNovoLeadReply, getFollowUpReply, AI_DEFAULTS: DEFAULTS };
