# CLT Solver — Deployment Guide

## Project Structure

```
MDP/
├── api/
│   └── gemini.js          ← Serverless proxy (API key lives here, server-side only)
├── public/
│   ├── landing.html
│   ├── index.html
│   ├── style.css
│   ├── app.js
│   └── api.js             ← Safe: calls /api/gemini, no key exposed
├── .env.example           ← Template — copy to .env.local for local dev
├── .gitignore             ← Prevents .env from being committed
├── package.json
└── vercel.json            ← Routing config for Vercel
```

## How the API key is protected

The Gemini key is stored as a **Vercel Environment Variable**, not in any file.
The browser calls `/api/gemini` (your own server), which injects the key and
forwards the request to Google. The key is never visible in browser DevTools.

---

## Deploy to Vercel (step by step)

### 1. Push to GitHub
```bash
git init
git add .
git commit -m "Initial commit"
# Create a repo on github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

### 2. Import on Vercel
1. Go to https://vercel.com → **Add New Project**
2. Import your GitHub repository
3. Leave all build settings as default (Vercel auto-detects)
4. Click **Deploy**

### 3. Add the API key as an Environment Variable
1. After deploy, go to your project → **Settings** → **Environment Variables**
2. Add:
   - **Name:** `GEMINI_API_KEY`
   - **Value:** your actual Gemini API key
   - **Environment:** Production (and Preview if you want)
3. Click **Save**, then go to **Deployments** → **Redeploy** (so the new env var takes effect)

### 4. Done!
Your site is live at `https://your-project.vercel.app`

---

## Local Development (optional)

```bash
npm install -g vercel
cp .env.example .env.local
# Edit .env.local and paste your real key
vercel dev
```
This starts a local server that mimics Vercel including the `/api/gemini` proxy.

---

## Security checklist

- [x] API key removed from `api.js`
- [x] `.env` added to `.gitignore`
- [x] Key only lives in Vercel's environment variables
- [x] Browser never sees the key — only calls `/api/gemini`
