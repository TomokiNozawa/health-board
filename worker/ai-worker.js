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

    // ===== iPhoneショートカット → 歩数/睡眠 取り込み (Phase 2-A) =====
    // POST /ingest  body: { key, steps?, sleep?, date?, day? }
    //  - key が INGEST_KEY と一致したら、Firebase に HEALTH_EMAIL/PASS でログインして書き込む
    //  - 日付の決め方(優先順): date(YYYY-MM-DD明示) > day("today"|"yesterday") > 既定today
    //  - CORS不要(ショートカットから叩くため)。RTDBルールは変更不要(正規ユーザーとして書く)
    if (url.pathname === "/ingest" && request.method === "POST") {
      try {
        const b = await request.json();
        // 認証: ショートカット(body.key=INGEST_KEY) または ChatGPT GPT Actions(ヘッダー X-Api-Key=SUMMARY_KEY)
        const headerKey = request.headers.get("X-Api-Key") || "";
        const okShortcut = env.INGEST_KEY && b.key === env.INGEST_KEY;
        const okGpt = env.SUMMARY_KEY && headerKey === env.SUMMARY_KEY;
        if (!okShortcut && !okGpt) return json({ error: "unauthorized" }, 401, env, origin);
        const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date || "")
          ? b.date
          : (b.day === "yesterday" ? jstDay(-1) : jstDay(0));
        const steps  = b.steps  != null ? clampNum(b.steps) : null;
        const sleep  = b.sleep  != null ? dec1(b.sleep)     : null;
        // 体重・体脂肪: 値があり > 0 の時だけ書く(測ってない日は送らない=記録なし)
        const weight = (b.weight != null && Number(b.weight) > 0) ? dec1(b.weight) : null;
        const fat    = (b.fat    != null && Number(b.fat)    > 0) ? dec1(b.fat)    : null;
        const muscle = (b.muscle != null && Number(b.muscle) > 0) ? dec1(b.muscle) : null;
        // アクティブ消費カロリー(Apple Watch)
        const active = b.active != null ? clampNum(b.active) : null;
        if (steps == null && sleep == null && weight == null && fat == null && muscle == null && active == null)
          return json({ error: "steps/sleep/weight/fat/muscle/active のいずれかが必要" }, 400, env, origin);

        // Firebase Auth REST でログイン → idToken
        const auth = await (await fetch(
          "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" + env.FIREBASE_API_KEY,
          { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ email: env.HEALTH_EMAIL, password: env.HEALTH_PASSWORD, returnSecureToken: true }) }
        )).json();
        if (!auth.idToken) return json({ error: "firebase auth failed", detail: (auth.error && auth.error.message) || "" }, 502, env, origin);

        const base = env.FIREBASE_DB_URL.replace(/\/$/, "") + "/healthData/" + auth.localId + "/days/" + date;
        const results = {};
        if (steps != null) {
          const r = await fetch(base + "/steps.json?auth=" + auth.idToken, { method: "PUT", body: String(steps) });
          results.steps = r.ok ? steps : ("err " + r.status);
        }
        if (sleep != null) {
          const r = await fetch(base + "/sleep.json?auth=" + auth.idToken, { method: "PUT", body: String(sleep) });
          results.sleep = r.ok ? sleep : ("err " + r.status);
        }
        // 体重/体脂肪は days/{date}/body/ 配下 (アプリの DAY.body と同じ場所)
        if (weight != null) {
          const r = await fetch(base + "/body/weight.json?auth=" + auth.idToken, { method: "PUT", body: String(weight) });
          results.weight = r.ok ? weight : ("err " + r.status);
        }
        if (fat != null) {
          const r = await fetch(base + "/body/fat.json?auth=" + auth.idToken, { method: "PUT", body: String(fat) });
          results.fat = r.ok ? fat : ("err " + r.status);
        }
        if (muscle != null) {
          const r = await fetch(base + "/body/muscle.json?auth=" + auth.idToken, { method: "PUT", body: String(muscle) });
          results.muscle = r.ok ? muscle : ("err " + r.status);
        }
        if (active != null) {
          const r = await fetch(base + "/active.json?auth=" + auth.idToken, { method: "PUT", body: String(active) });
          results.active = r.ok ? active : ("err " + r.status);
        }
        return json({ ok: true, date, ...results }, 200, env, origin);
      } catch (e) {
        return json({ error: String(e && e.message || e) }, 500, env, origin);
      }
    }

    // ===== ChatGPT等の外部AI用 読み取りAPI =====
    // GET /summary?days=7  header: X-Api-Key: SUMMARY_KEY
    // 直近N日の食事/PFC/歩数/体組成/サプリ/食事ウィンドウ + 目標値 を返す (読み取り専用)
    if (url.pathname === "/summary" && (request.method === "GET" || request.method === "POST")) {
      try {
        const key = request.headers.get("X-Api-Key") || url.searchParams.get("key") || "";
        if (!env.SUMMARY_KEY || key !== env.SUMMARY_KEY) return json({ error: "unauthorized" }, 401, env, origin);
        const n = Math.max(1, Math.min(31, Number(url.searchParams.get("days")) || 7));
        const auth = await fbLogin(env);
        if (!auth.idToken) return json({ error: "firebase auth failed" }, 502, env, origin);
        const { days, goals } = await fetchRange(env, auth, n);
        return json({ generatedAt: new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16) + " JST", goals, days }, 200, env, origin);
      } catch (e) { return json({ error: String(e && e.message || e) }, 500, env, origin); }
    }

    // ===== ChatGPT等の外部AI用 書き込みAPI =====
    // POST /record  header: X-Api-Key: SUMMARY_KEY
    // body: { date?: "YYYY-MM-DD", weight?, fat?, muscle? }  (JST当日が既定)
    // 体組成を days/{date}/body/ に書く (アプリの ⚖️からだ と同じ場所、/ingest と同ロジック)
    if (url.pathname === "/record" && request.method === "POST") {
      try {
        const key = request.headers.get("X-Api-Key") || url.searchParams.get("key") || "";
        if (!env.SUMMARY_KEY || key !== env.SUMMARY_KEY) return json({ error: "unauthorized" }, 401, env, origin);
        const b = await request.json().catch(() => ({}));
        const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date || "")
          ? b.date
          : (b.day === "yesterday" ? jstDay(-1) : jstDay(0));
        // 値があり > 0 の項目だけ書く (0/null/負値は「記録なし」扱いでスキップ)
        const fields = {};
        for (const k of ["weight", "fat", "muscle"]) {
          if (b[k] != null && Number(b[k]) > 0) fields[k] = dec1(b[k]);
        }
        if (!Object.keys(fields).length)
          return json({ error: "weight/fat/muscle のいずれか (>0) が必要" }, 400, env, origin);
        // 現実的な範囲チェック (誤登録ガード: 体重20-300kg, 体脂肪率3-60%, 筋肉量10-100kg)
        const range = { weight: [20, 300], fat: [3, 60], muscle: [10, 100] };
        for (const [k, v] of Object.entries(fields)) {
          if (v < range[k][0] || v > range[k][1])
            return json({ error: k + "=" + v + " は範囲外 (" + range[k][0] + "〜" + range[k][1] + ")" }, 400, env, origin);
        }
        const auth = await fbLogin(env);
        if (!auth.idToken) return json({ error: "firebase auth failed" }, 502, env, origin);
        const base = env.FIREBASE_DB_URL.replace(/\/$/, "") + "/healthData/" + auth.localId + "/days/" + date;
        const results = {};
        for (const [k, v] of Object.entries(fields)) {
          const r = await fetch(base + "/body/" + k + ".json?auth=" + auth.idToken, { method: "PUT", body: String(v) });
          results[k] = r.ok ? v : ("err " + r.status);
        }
        return json({ ok: true, date, ...results }, 200, env, origin);
      } catch (e) { return json({ error: String(e && e.message || e) }, 500, env, origin); }
    }

    // ===== アプリ内コーチ (今日のFB) =====
    // POST /coach  body: { date?: "YYYY-MM-DD" }  (CORS: アプリのオリジン限定、/estimate と同様)
    if (url.pathname === "/coach" && request.method === "POST") {
      try {
        const b = await request.json().catch(() => ({}));
        const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date || "") ? b.date : jstDay(0);
        const auth = await fbLogin(env);
        if (!auth.idToken) return json({ error: "firebase auth failed" }, 502, env, origin);
        const { days, goals } = await fetchRange(env, auth, 8, date);
        const target = days[days.length - 1];
        if (!target || (!target.meals.length && target.steps == null))
          return json({ error: "この日の記録がまだありません" }, 400, env, origin);

        const sys =
          "あなたは減量・ボディメイク中のユーザーを日々サポートするパーソナルコーチです。\n" +
          "渡されたJSON(目標値 goals と直近数日のデータ、最終日が対象日)を読み、対象日のフィードバックを日本語で書いてください。\n" +
          "【構成】1) 今日の総評: 良かった点を具体的な数字で2つ褒める 2) 改善点: あれば1〜2個、明日から実行できる具体策とセットで 3) 一言: 明日に向けた短い励まし。\n" +
          "【トーン】親しみやすく簡潔に。全体で400字以内。絵文字は各セクション1個まで。\n" +
          "【視点】カロリー収支、PFC(特にたんぱく質目標)、脂質の使い方、歩数、16:8ファスティング(食事ウィンドウ)、体重・筋肉量トレンド、サプリ継続。数字は必ずデータから引用し、推測で数字を作らない。";

        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model: MODEL_FAST, max_tokens: 800, system: sys,
            messages: [{ role: "user", content: "対象日: " + date + "\n" + JSON.stringify({ goals, days }) }]
          })
        });
        if (!r.ok) { const t = await r.text(); return json({ error: "anthropic " + r.status, detail: t.slice(0, 200) }, 502, env, origin); }
        const data = await r.json();
        const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("\n").trim();
        // 生成結果を days/{date}/coach に保存 (アプリで見返せる)
        const base = env.FIREBASE_DB_URL.replace(/\/$/, "") + "/healthData/" + auth.localId + "/days/" + date;
        await fetch(base + "/coach.json?auth=" + auth.idToken, {
          method: "PUT", body: JSON.stringify({ text, ts: Date.now() })
        }).catch(() => {});
        return json({ date, feedback: text }, 200, env, origin);
      } catch (e) { return json({ error: String(e && e.message || e) }, 500, env, origin); }
    }

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

/* ---- 共通: Firebaseログイン & 日次サマリー取得 (/summary, /coach 用) ---- */
async function fbLogin(env) {
  return await (await fetch(
    "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" + env.FIREBASE_API_KEY,
    { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: env.HEALTH_EMAIL, password: env.HEALTH_PASSWORD, returnSecureToken: true }) }
  )).json();
}
// endDate(既定=今日JST) を最終日として直近n日分を取得し、日次サマリー配列 + 目標値を返す
async function fetchRange(env, auth, n, endDate) {
  const base = env.FIREBASE_DB_URL.replace(/\/$/, "") + "/healthData/" + auth.localId;
  const end = /^\d{4}-\d{2}-\d{2}$/.test(endDate || "") ? endDate : jstDay(0);
  const dates = [];
  for (let i = n - 1; i >= 0; i--) dates.push(addDays(end, -i));
  const [goals, exercises, ...vals] = await Promise.all([
    fetch(base + "/settings/goals.json?auth=" + auth.idToken).then(r => r.json()).catch(() => null),
    fetch(base + "/settings/exercises.json?auth=" + auth.idToken).then(r => r.json()).catch(() => null),
    ...dates.map(d => fetch(base + "/days/" + d + ".json?auth=" + auth.idToken).then(r => r.json()).catch(() => null))
  ]);
  const exNames = {};
  (Array.isArray(exercises) ? exercises : Object.values(exercises || {})).forEach(e => { if (e && e.id) exNames[e.id] = e.name || e.id; });
  return { goals, days: dates.map((d, i) => summarizeDay(d, vals[i] || {}, exNames)) };
}
function summarizeDay(date, v, exNames) {
  let kcal = 0, p = 0, f = 0, c = 0; const meals = [];
  for (const k in (v.meals || {})) {
    const m = v.meals[k];
    kcal += Number(m.kcal) || 0; p += Number(m.p) || 0; f += Number(m.f) || 0; c += Number(m.c) || 0;
    meals.push({ name: String(m.name || "").slice(0, 50), kcal: Math.round(Number(m.kcal) || 0), at: m.at || null, type: m.type || null });
  }
  meals.sort((a, b) => String(a.at || "99").localeCompare(String(b.at || "99")));
  const ats = meals.map(m => m.at).filter(Boolean);
  const b = v.body || {};
  return {
    date, kcal: Math.round(kcal), p: dec1(p), f: dec1(f), c: dec1(c),
    steps: v.steps != null ? v.steps : null,
    weight: b.weight != null ? b.weight : null, bodyFatPct: b.fat != null ? b.fat : null, muscleKg: b.muscle != null ? b.muscle : null,
    sleepH: v.sleep != null ? v.sleep : null, waterMl: v.water != null ? v.water : null, activeKcal: v.active != null ? v.active : null,
    eatWindow: ats.length ? { firstMeal: ats[0], lastMeal: ats[ats.length - 1] } : null,
    supplements: v.supplements || null,
    workout: summarizeWorkout(v.workout, exNames),
    meals
  };
}
// 筋トレ: 実施した種目だけ {種目名: 回数|"done"} で返す (未実施日は null)
function summarizeWorkout(w, exNames) {
  if (!w || !w.exercises) return null;
  const out = {};
  for (const [id, e] of Object.entries(w.exercises)) {
    const nm = (exNames && exNames[id]) || id;
    if (e && e.done) out[nm] = "done";
    else if (e && Number(e.count) > 0) out[nm] = Number(e.count);
  }
  if (w.note) out.note = String(w.note).slice(0, 100);
  return Object.keys(out).length ? out : null;
}
function addDays(str, d) { const [y, m, dd] = str.split("-").map(Number); const t = new Date(Date.UTC(y, m - 1, dd + d)); return t.toISOString().slice(0, 10); }

function clampNum(v) { const n = Math.round(Number(v)); return isFinite(n) && n >= 0 ? Math.min(n, 100000) : 0; }
function dec1(v) { const n = Number(v); return isFinite(n) && n >= 0 ? Math.round(Math.min(n, 100000) * 10) / 10 : 0; }
function jstToday() { return jstDay(0); }
function jstDay(offsetDays) { const d = new Date(Date.now() + 9 * 3600 * 1000 + (offsetDays || 0) * 86400000); return d.toISOString().slice(0, 10); }
function cors(env, origin) {
  const allow = (env.ALLOWED_ORIGIN || "*");
  const ok = allow === "*" || allow.split(",").map(s => s.trim()).includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? (allow === "*" ? "*" : origin) : "null",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "86400"
  };
}
function json(obj, status, env, origin) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...cors(env, origin) } });
}
