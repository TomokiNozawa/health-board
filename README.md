# HealthBoard 🌱

野沢さん専用の健康管理 PWA。食事・ファスティング(16:8)・筋トレ・歩数・体重などを記録する。

- **公開**: GitHub Pages (予定)
- **データ**: Firebase Realtime Database (`task-board-fbf1e`)、名前付きインスタンス `health-board`
  - パス: `/healthData/$uid/...` (本人のみ read/write)
  - 端末を変えてもアカウントでデータ継続 (localStorage 単独保持はしない)

## 機能 (Phase 1)

| タブ | 内容 |
|---|---|
| 🏠 ホーム | ファスティングリング(絶食時間/目標16h)、カロリー・たんぱく質・歩数・水分のサマリー、PFCバランス、クイック記録 |
| 🍽️ 食事 | 料理名・**食事時刻**・カロリー・PFC を記録 (食事時刻からファスティング自動計測) |
| 💪 運動 | 筋トレ種目を記録。チェック式(YouTube腹筋)+回数式(スクワット/腹筋/立ちコロ)。**種目は自分で追加・編集可** |
| ⚖️ からだ | 体重・体脂肪率・水分・睡眠・体調(気分3段階) |
| 📊 記録 | カロリー/歩数の7日グラフ、体重推移、ファスティング連続達成日数、目標設定 |

- 日付ナビで過去日も記録・閲覧可
- 初期目標: 絶食16h / 2,000kcal / たんぱく質120g / 水分2,000ml / 8,000歩 (アプリ内で変更可)

## データ構造

```
healthData/$uid/
  settings/
    goals/   { fastHours, calorie, protein, water, steps }
    exercises/ [ {id,name,type:'check'|'count',unit,icon} ... ]
  days/
    YYYY-MM-DD/
      meals/ { <id>: {name, at:"HH:MM", kcal, p, f, c, ts} }
      workout/ { exercises:{ <exId>:{done}|{count} }, note }
      body/ { weight, fat }
      water  (ml)
      steps
      sleep  (h)
      mood   (0|1|2)
```

## Firebase ルール (要マージ)

下記を**既存ルールに追加**する (既存パスは消さない、`FIREBASE_RULES_snippet.json` 参照):

```json
"healthData": {
  "$uid": {
    ".read":  "auth != null && auth.uid === $uid",
    ".write": "auth != null && auth.uid === $uid"
  }
}
```

## ロードマップ

- **Phase 2**: iPhoneショートカット連携(歩数・睡眠の自動取り込み) / 食事写真AI推定(Cloudflare Worker経由、安価モデル+高精度ボタン)
- **Phase 3**: 目標達成率の可視化強化 / 進捗写真の月次比較 / リマインド通知

## 開発メモ

- 単一ファイル構成 (index.html + app.js + sw.js)。ビルド不要
- Firebase compat SDK 9.23.0 を CDN ロード
- バージョン: cache buster は `app.js?v=` と `sw.js` の CACHE 名を揃えて bump
