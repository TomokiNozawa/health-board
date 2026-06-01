/* HealthBoard AI Worker
   食事写真 → カロリー/PFC 推定 (Anthropic Claude vision)
   - APIキーは Worker Secret (ANTHROPIC_API_KEY) に保持。クライアントには出さない
   - 軽量モデル(haiku)を既定、?hi=1 で高精度(sonnet)
   - 呼び出し元を ALLOWED_ORIGIN で制限 (CORS)
   POST /estimate  body: { image: "data:image/jpeg;base64,...", note?: "ラーメンと餃子" }
   resp: { name, kcal, p, f, c, confidence, items:[...], note }
*/

// 精度優先: 既定でも sonnet を使う。?hi=1 は extended thinking を上乗せして最難ケースに対応。
const MODEL_FAST = "claude-sonnet-4-6";
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

      const sys =
        "あなたは経験豊富な管理栄養士です。料理写真を分析し、1食分の栄養を可能な限り正確に推定します。\n" +
        "【推定手順】必ず次の順で考える:\n" +
        "1. 写真に写る料理を品目ごとに特定する(主食・主菜・副菜・汁物・飲料・調味料/油も見落とさない)。\n" +
        "2. 皿や茶碗のサイズ、箸/スプーン、盛り付けの高さを基準に、各品の重量(g)または容量を現実的に見積もる。\n" +
        "   - 例: 茶碗1杯の白米≒150g(252kcal)、味噌汁1杯≒200ml(40kcal)、鶏もも唐揚げ1個≒30g。\n" +
        "3. 調理法(揚げ/炒め/焼き/生)を考慮し油の量を加味する(揚げ物・炒め物はFが増える)。\n" +
        "4. 日本食品標準成分表ベースで各品の kcal/P/F/C を算出し、合算する。\n" +
        "【数値ルール】\n" +
        "- P(たんぱく質)・F(脂質)・C(炭水化物)はグラムで【小数第1位まで】必ず出す(例 24.5)。kcal は整数。\n" +
        "- 4kcal×P + 9kcal×F + 4kcal×C が kcal とおおむね一致するよう整合性を保つ。\n" +
        "- 量が不明でも標準的な1人前を仮定し、0や空にしない。\n" +
        "- 単品(ラーメン等)でも必ず P/F/C を分解する。\n" +
        "confidence は推定の確からしさ high/medium/low。\n" +
        "出力は JSON のみ。説明文・コードブロック記号は付けない。\n" +
        'スキーマ: {"name":string,"kcal":number,"p":number,"f":number,"c":number,"confidence":"high|medium|low","items":[{"name":string,"kcal":number,"p":number,"f":number,"c":number}]}';
      const userText = userNote
        ? `この料理の栄養を推定してください。ユーザー補足(料理名やヒント): 「${userNote}」。補足を最優先の手がかりにしてください。`
        : "この料理の栄養を推定してください。";

      const payload = {
        model: hi ? MODEL_HI : MODEL_FAST,
        max_tokens: hi ? 2200 : 900,
        system: sys,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
            { type: "text", text: userText }
          ]
        }]
      };
      // 高精度モード: extended thinking で量推定を熟考させる
      if (hi) payload.thinking = { type: "enabled", budget_tokens: 1200 };

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
        kcal: clampNum(parsed.kcal),
        p: dec1(parsed.p), f: dec1(parsed.f), c: dec1(parsed.c),
        confidence: ["high", "medium", "low"].includes(parsed.confidence) ? parsed.confidence : "medium",
        items: Array.isArray(parsed.items) ? parsed.items.slice(0, 8).map(i => ({
          name: String(i.name || "").slice(0, 40), kcal: clampNum(i.kcal),
          p: dec1(i.p), f: dec1(i.f), c: dec1(i.c)
        })) : [],
        model: hi ? "sonnet-thinking" : "sonnet"
      };
      return json(out, 200, env, origin);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500, env, origin);
    }
  }
};

function clampNum(v) { const n = Math.round(Number(v)); return isFinite(n) && n >= 0 ? Math.min(n, 100000) : 0; }
function dec1(v) { const n = Number(v); return isFinite(n) && n >= 0 ? Math.round(Math.min(n, 100000) * 10) / 10 : 0; }
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
