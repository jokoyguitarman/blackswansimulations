# Quick Start: Deploying to Vercel

## 🚀 Fastest Path to Deployment

### Step 1: Connect Repository to Vercel

1. Go to [vercel.com](https://vercel.com) and sign in with GitHub
2. Click **"Add New Project"**
3. Import: `jokoyguitarman/blackswansimulations`
4. Vercel will auto-detect settings from `vercel.json`

### Step 2: Configure Environment Variables

In Vercel Dashboard → Your Project → Settings → Environment Variables:

**Required for Frontend:**

```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key-here
```

**Optional (if deploying backend to Vercel):**

```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
OPENAI_API_KEY=sk-your-key-here
SESSION_SECRET=generate-secure-random-string
CLIENT_URL=https://your-vercel-app.vercel.app
```

### Step 3: Deploy

Click **"Deploy"** - Vercel will automatically:

- Install dependencies
- Build the frontend
- Deploy to production

## ⚠️ Important: WebSocket Limitation

**Your app uses WebSocket (Socket.io) for real-time features.**

Vercel serverless functions **do not support persistent WebSocket connections**.

### Recommended Solution: Split Deployment

**Frontend → Vercel** (Static site, fast CDN)
**Backend → Railway/Render/Fly.io** (Full Node.js server with WebSocket support)

### Alternative: Vercel Only (Limited)

If you deploy everything to Vercel:

- ✅ Frontend will work
- ✅ API routes will work (via serverless functions)
- ❌ WebSocket/real-time features will NOT work

## 📋 Environment Variables Checklist

### Frontend (Required)

- [ ] `VITE_SUPABASE_URL`
- [ ] `VITE_SUPABASE_ANON_KEY`

### Backend (If deploying separately)

- [ ] `SUPABASE_URL`
- [ ] `SUPABASE_SERVICE_ROLE_KEY`
- [ ] `OPENAI_API_KEY` (for AI features)
- [ ] `SESSION_SECRET` (generate with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)
- [ ] `CLIENT_URL` (your Vercel frontend URL)
- [ ] Email settings (SMTP_HOST, SMTP_USER, SMTP_PASS, etc.)

## 🔗 Next Steps

1. **Deploy frontend to Vercel** (follow steps above)
2. **Deploy backend separately** (see `docs/VERCEL_SETUP.md` for detailed instructions)
3. **Update frontend API URL** if backend is on different domain
4. **Test WebSocket connection** to verify real-time features work

## 📚 Full Documentation

See `docs/VERCEL_SETUP.md` for:

- Detailed deployment instructions
- Backend deployment options (Railway, Render, Fly.io)
- Troubleshooting guide
- Custom domain setup
