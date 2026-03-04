<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# シナリオ解析エクセル出力ツール

PDFや画像のシナリオフローをAIが解析し、画像付きのExcelデータを作成します。

## 動作環境

- **Google AI Studio** でそのまま利用可能（APIキーは自動注入）
- **Vercel** でデプロイ可能（環境変数でAPIキーを設定）
- **ローカル** でも利用可能

## Vercel へのデプロイ

1. このリポジトリを GitHub にプッシュ
2. [Vercel](https://vercel.com) でプロジェクトをインポート
3. **Environment Variables** に以下を設定:
   ```
   VITE_GEMINI_API_KEY = <あなたのGemini APIキー>
   ```
4. デプロイ実行

> **注意:** APIキーは `.env.local` などのファイルに書かず、必ずVercelの環境変数で設定してください。

## ローカルで実行

**前提:** Node.js がインストールされていること

1. 依存関係をインストール: `npm install`
2. `.env.local` を作成し、以下を設定:
   ```
   VITE_GEMINI_API_KEY="あなたのGemini APIキー"
   ```
   ※ `.env.local` は `.gitignore` で除外済みのため Git にはコミットされません
3. 起動: `npm run dev`
