# 🌍 Multilingual Summarization Agent

AI-powered article summarizer supporting English, French, Spanish, and Chinese.
Built with Next.js + Anthropic Claude. Deployable to Vercel in ~5 minutes.

---

## 🚀 Deploy to Vercel — Step by Step

### Step 1 — Get your Anthropic API key
1. Go to https://console.anthropic.com
2. Sign up or log in
3. Go to **API Keys** → click **Create Key**
4. Copy the key (starts with `sk-ant-...`)
5. Add some credits under **Billing** (start with $5)

---

### Step 2 — Upload to GitHub
1. Go to https://github.com/new and create a new **private** repository
2. On your computer, open a terminal in this project folder and run:

```bash
git init
git add .
git commit -m "initial commit"
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
git push -u origin main
```

---

### Step 3 — Deploy on Vercel
1. Go to https://vercel.com and log in
2. Click **"Add New Project"**
3. Click **"Import"** next to your GitHub repo
4. Leave all settings as default — Vercel auto-detects Next.js ✅
5. Click **"Deploy"**

---

### Step 4 — Add your API key (CRITICAL)
After deploy, your app will show an error until you add the key:

1. In Vercel, open your project dashboard
2. Go to **Settings → Environment Variables**
3. Click **"Add New"**
   - **Name:** `ANTHROPIC_API_KEY`
   - **Value:** `sk-ant-your-key-here`
   - **Environment:** ✅ Production ✅ Preview ✅ Development
4. Click **Save**
5. Go to **Deployments** → click the 3 dots on latest → **Redeploy**

Your app is now live at `https://your-project.vercel.app` 🎉

---

## 🔒 Security

- Your API key is stored as a **server-side environment variable** on Vercel
- It is **never exposed to the browser**
- All Claude API calls go through `/api/claude` — your secure proxy
- Do not commit `.env.local` to git (it's in `.gitignore`)

---

## 💻 Run Locally

```bash
# 1. Install dependencies
npm install

# 2. Create your local env file
cp .env.example .env.local
# Edit .env.local and paste your ANTHROPIC_API_KEY

# 3. Start the dev server
npm run dev

# Open http://localhost:3000
```

---

## 📁 Project Structure

```
/
├── pages/
│   ├── index.js          ← Main page
│   ├── _app.js           ← App wrapper
│   └── api/
│       └── claude.js     ← 🔒 Secure API proxy (key lives here)
├── components/
│   └── SummarizerAgent.js ← Full agent UI + logic
├── styles/
│   └── globals.css
├── .env.example          ← Template for your API key
├── .gitignore            ← Keeps .env.local out of git
├── next.config.js
└── package.json
```

---

## 🛡️ Guardrails

| Setting | Value |
|---|---|
| MAX_AGENT_STEPS | 5 |
| MAX_INPUT_CHARS | 8,000 |
| MAX_TOKENS_PER_CALL | 1,500 |
| TIMEOUT_MS | 30,000ms |
| MIN_ARTICLE_LENGTH | 50 chars |

---

## 💰 Cost Estimate

Each summarization run uses ~1,000–2,500 tokens total.
At claude-sonnet-4 pricing: roughly **$0.003–$0.008 per article**.
