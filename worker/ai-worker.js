/* HealthBoard AI Worker
   食事写真 → カロリー/PFC 推定 (Anthropic Claude vision)
   - APIキーは Worker Secret (ANTHROPIC_API_KEY) に保持。クライアントには出さない
   - 軽量モデル(haiku)を既定、?hi=1 で高精度(sonnet)
   - 呼び出し元を ALLOWED_ORIGIN で制限 (CORS)
   POST /estimate  body: { image: "data:image/jpeg;base64,...", note?: "ラーメンと餃子" }
   resp: { name, kcal, p, f, c, confidence, items:[...], note }
*/

const MODEL_FAST = "claude-haiku-4-5-20251001";
const MODEL_HI   = "claude-sonnet-4-6";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env, origin) });
    if (url.pathname === "/health") return json({ status: "ok" }, 200, env, origin);
    if (url.pathname !== "/estimate" || request.method !== "POST")
      return json({ error: "not found" }, 404, env, origin);

    try {
      const body = await request.json();
      const image = body.image || "";
      const userNote = (body.note || "").slice(0, 200);
      const hi = url.searchParams.get("hi") === "1";
      const m = image.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
      if (!m) return json({ error: "image must be data URL (jpeg/png/webp)" }, 400, env, origin);
      const mediaType = m[1], b64 = m[2];
      if (b64.length > 7_000_000) return json({ error: "image too large (max ~5MB)" }, 413, env, origin);

      const sys = "あなたは管理栄養士です。料理写真から1食分の栄養を推定し、必ずJSONだけを返します。" +
        "視点: 料理名(日本語/簡潔)、カロリー(kcal)、たんぱく質P・脂質F・炭水化物C(グラム)。" +
        "皿の数や量から現実的な1食分を推定。複数品あれば合算し、items に内訳を入れる。" +
        "不明確でも必ず数値を出す(0は避ける)。confidence は high/medium/low。" +
        'スキーマ: {"name":string,"kcal":number,"p":number,"f":number,"c":number,"confidence":string,"items":[{"name":string,"kcal":number}]}';
      const userText = userNote
        ? `この料理を推定してください。補足: ${userNote}`
        : "この料理を推定してください。";

      const payload = {
        model: hi ? MODEL_HI : MODEL_FAST,
        max_tokens: 600,
        system: sys,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
            { type: "text", text: userText }
          ]
        }]
      };

      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify(payload)
      });
      if (!r.ok) {
        const t = await r.text();
        return json({ error: "anthropic " + r.status, detail: t.slice(0, 300) }, 502, env, origin);
      }
      const data = await r.json();
      let txt = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("\n");
      // JSON抽出 (```json ... ``` で囲まれる場合に対応)
      const jm = txt.match(/\{[\s\S]*\}/);
      let parsed;
      try { parsed = JSON.parse(jm ? jm[0] : txt); }
      catch { return json({ error: "parse failed", raw: txt.slice(0, 300) }, 500, env, origin); }

      const out = {
        name: String(parsed.name || "食事").slice(0, 60),
        kcal: clampNum(parsed.kcal), p: clampNum(parsed.p), f: clampNum(parsed.f), c: clampNum(parsed.c),
        confidence: ["high", "medium", "low"].includes(parsed.confidence) ? parsed.confidence : "medium",
        items: Array.isArray(parsed.items) ? parsed.items.slice(0, 8).map(i => ({ name: String(i.name || "").slice(0, 40), kcal: clampNum(i.kcal) })) : [],
        model: hi ? "sonnet" : "haiku"
      };
      return json(out, 200, env, origin);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500, env, origin);
    }
  }
};

function clampNum(v) { const n = Math.round(Number(v)); return isFinite(n) && n >= 0 ? Math.min(n, 100000) : 0; }
function cors(env, origin) {
  const allow = (env.ALLOWED_ORIGIN || "*");
  const ok = allow === "*" || allow.split(",").map(s => s.trim()).includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? (allow === "*" ? "*" : origin) : "null",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "86400"
  };
}
function json(obj, status, env, origin) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...cors(env, origin) } });
}
