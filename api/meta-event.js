// Meta Conversions API (servidor)
// Recebe os eventos da página e repassa para a Meta, com o mesmo event_id do pixel do navegador
// (a Meta usa o event_id para não contar o mesmo evento duas vezes).
//
// Variáveis de ambiente na Vercel:
//   META_CAPI_TOKEN       token da API de Conversões (obrigatório)
//   META_PIXEL_ID         ID do pixel (obrigatório)
//   META_API_VERSION      versão da Graph API (opcional, padrão abaixo)
//   META_TEST_EVENT_CODE  código de "Testar eventos" do Gerenciador de Eventos (opcional, só para testes)

const VERSAO_PADRAO = "v23.0";
const EVENTOS_PERMITIDOS = new Set(["PageView", "ViewContent", "InitiateCheckout"]);

function lerCookie(req, nome) {
  const m = (req.headers.cookie || "").match(new RegExp("(?:^|;\\s*)" + nome + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : undefined;
}

function texto(v, max) {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
}

function dadosPersonalizados(c) {
  if (!c || typeof c !== "object") return undefined;
  const valor = Number(c.value);
  const saida = {
    value: Number.isFinite(valor) && valor >= 0 && valor < 100000 ? valor : undefined,
    currency: /^[A-Z]{3}$/.test(c.currency || "") ? c.currency : undefined,
    content_name: texto(c.content_name, 120),
  };
  return Object.values(saida).some((v) => v !== undefined) ? saida : undefined;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false });
  }

  const token = process.env.META_CAPI_TOKEN;
  const pixel = process.env.META_PIXEL_ID;
  if (!token || !pixel) {
    console.error("Meta CAPI: META_CAPI_TOKEN ou META_PIXEL_ID não configurados");
    return res.status(500).json({ ok: false });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  if (!EVENTOS_PERMITIDOS.has(body.event_name)) {
    return res.status(400).json({ ok: false, erro: "evento não permitido" });
  }

  const ip =
    String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.headers["x-real-ip"] ||
    (req.socket && req.socket.remoteAddress);

  const evento = {
    event_name: body.event_name,
    event_time: Math.floor(Date.now() / 1000),
    event_id: texto(body.event_id, 64),
    event_source_url: texto(body.event_source_url, 1000),
    action_source: "website",
    user_data: {
      client_ip_address: ip || undefined,
      client_user_agent: texto(req.headers["user-agent"], 500),
      fbp: texto(body.fbp, 200) || lerCookie(req, "_fbp"),
      fbc: texto(body.fbc, 500) || lerCookie(req, "_fbc"),
    },
    custom_data: dadosPersonalizados(body.custom_data),
  };

  const payload = { data: [evento] };
  if (process.env.META_TEST_EVENT_CODE) payload.test_event_code = process.env.META_TEST_EVENT_CODE;

  const versao = process.env.META_API_VERSION || VERSAO_PADRAO;
  const url = `https://graph.facebook.com/${versao}/${encodeURIComponent(pixel)}/events?access_token=${encodeURIComponent(token)}`;

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload), // campos undefined são descartados aqui
    });
    const resposta = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error("Meta CAPI: erro", r.status, JSON.stringify(resposta.error || resposta));
      return res.status(502).json({ ok: false });
    }
    return res.status(200).json({ ok: true, recebidos: resposta.events_received });
  } catch (erro) {
    console.error("Meta CAPI: falha de conexão", erro && erro.message);
    return res.status(502).json({ ok: false });
  }
};
