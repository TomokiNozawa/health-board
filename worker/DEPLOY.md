# AI Worker デプロイ手順 (食事写真AI推定 / Phase 2-B)

食事写真→カロリー・PFC推定の Cloudflare Worker。APIキーをクライアントに出さないための proxy。

## 前提
- Cloudflare アカウント (既存の camp-auth / slidex-auth と同じ `tomoki-nozawa` アカウント)
- Anthropic APIキー (環境変数 `ANTHROPIC_API_KEY` に設定済み、または console から取得)

## デプロイ (初回)

```bash
cd ~/health-board/worker

# 1. Cloudflare にログイン (ブラウザが開く。野沢さんの操作が必要)
npx wrangler login

# 2. Anthropic APIキーを Worker Secret に登録 (プロンプトに貼り付け)
#    値は Windows環境変数 ANTHROPIC_API_KEY と同じものを使う
npx wrangler secret put ANTHROPIC_API_KEY

# 3. デプロイ
npx wrangler deploy
```

デプロイ後、URL が `https://healthboard-ai.<サブドメイン>.workers.dev` で発行される。
- もし `tomoki-nozawa.workers.dev` 以外のサブドメインになった場合は、
  `app.js` の `AI_WORKER_URL` をその URL に書き換えて push する。
- 現状 app.js は `https://healthboard-ai.tomoki-nozawa.workers.dev` を想定。

## 動作確認

```bash
curl https://healthboard-ai.tomoki-nozawa.workers.dev/health
# => {"status":"ok"}
```

アプリの食事追加 → 📷写真を選ぶ → カロリー/PFCが自動入力されればOK。

## コスト
- 既定モデル: Claude Haiku 4.5 (1食あたり約¥0.1〜0.3)
- 「🔍高精度で再解析」: Claude Sonnet 4.6 (約¥1.5〜3)
- 月90食(3食×30日)を Haiku で約¥10〜30

## セキュリティ
- `ANTHROPIC_API_KEY` は Worker Secret のみ (リポジトリ・クライアントに出さない)
- CORS は `wrangler.toml` の `ALLOWED_ORIGIN` (= GitHub Pages) に制限
- 画像は base64 で受けて Anthropic に転送するだけ。Worker 側に保存しない
