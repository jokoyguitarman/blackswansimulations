# Vercel Deployment Guide

This guide will help you deploy your Black Swan Simulations application to Vercel.

## ⚠️ Important Limitations

**WebSocket Support**: Vercel serverless functions do not support persistent WebSocket connections. Your application uses Socket.io for real-time features. You have two options:

1. **Deploy frontend to Vercel, backend elsewhere** (Recommended)
   - Frontend: Vercel
   - Backend + WebSocket: Railway, Render, Fly.io, or similar

2. **Use Vercel for both** (Limited functionality)
   - Frontend: Vercel
   - Backend API: Vercel serverless functions (WebSocket features won't work)

## Option 1: Frontend on Vercel (Recommended)

### Step 1: Link Your Repository to Vercel

1. Go to [vercel.com](https://vercel.com) and sign in
2. Click **"Add New Project"**
3. Import your GitHub repository: `jokoyguitarman/blackswansimulations`
4. Vercel will auto-detect your project settings

### Step 2: Configure Project Settings

In the Vercel project settings:

**Root Directory**: Leave as root (`.`)

**Build Settings**:

- **Framework Preset**: Vite
- **Build Command**: `cd frontend && npm install && npm run build`
- **Output Directory**: `frontend/dist`
- **Install Command**: `npm install`

**OR** use the `vercel.json` file (already created in your repo)

### Step 3: Set Environment Variables

In Vercel Dashboard → Your Project → Settings → Environment Variables, add:

#### Frontend Environment Variables:

```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key-here
```

#### Backend API URL (if deploying backend separately):

```
VITE_API_URL=https://your-backend-url.com
```

**Where to find Supabase values:**

- Go to Supabase Dashboard → Project Settings → API
- Copy the `URL` → `VITE_SUPABASE_URL`
- Copy the `anon public` key → `VITE_SUPABASE_ANON_KEY`

### Step 4: Deploy Backend Separately (For WebSocket Support)

Since Vercel doesn't support WebSockets, deploy your backend to one of these services:

#### Option A: Railway (Recommended)

1. Go to [railway.app](https://railway.app)
2. Create new project → Deploy from GitHub
3. Select your repository
4. Set root directory to: `.` (root)
5. Set start command: `npm start`
6. Add environment variables (see backend env vars below)

#### Option B: Render

1. Go to [render.com](https://render.com)
2. Create new Web Service
3. Connect GitHub repository
4. Set:
   - **Build Command**: `npm run build`
   - **Start Command**: `npm start`
   - **Environment**: Node

#### Option C: Fly.io

1. Install Fly CLI: `npm i -g @fly/cli`
2. Run: `fly launch`
3. Follow prompts

### Step 5: Backend Environment Variables

Add these to your backend hosting service:

```env
NODE_ENV=production
PORT=3001
CLIENT_URL=https://your-vercel-app.vercel.app

# Supabase (Required)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# OpenAI (Required for AI features)
OPENAI_API_KEY=sk-your-openai-api-key

# Email Configuration
EMAIL_ENABLED=true
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-gmail-app-password
EMAIL_FROM=noreply@simulator.local
EMAIL_FROM_NAME=Simulation Environment

# Security
SESSION_SECRET=generate-a-secure-random-string-here

# Inject Scheduler
ENABLE_AUTO_INJECTS=true
INJECT_SCHEDULER_INTERVAL_MS=30000

# Logging
LOG_LEVEL=info
```

**Generate SESSION_SECRET:**

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Step 6: Update Frontend API Configuration

Update `frontend/src/lib/api.ts` to use your backend URL:

```typescript
const API_URL = import.meta.env.VITE_API_URL || 'https://your-backend-url.com';
```

Or set `VITE_API_URL` in Vercel environment variables.

### Step 7: Deploy

1. Push your changes to GitHub
2. Vercel will automatically deploy
3. Your backend service will also auto-deploy (if configured)

## Option 2: Full Vercel Deployment (No WebSocket)

If you want to deploy everything to Vercel (without WebSocket support):

### Step 1: Same as Option 1, Steps 1-3

### Step 2: Add Backend Environment Variables to Vercel

Add all backend environment variables listed in Step 5 above.

### Step 3: Update API Routes

The `api/index.ts` file is already set up to handle API routes as serverless functions.

### Step 4: Deploy

Push to GitHub and Vercel will deploy both frontend and API routes.

**Note**: Real-time features (WebSocket) will not work with this setup.

## Post-Deployment Checklist

- [ ] Frontend loads correctly
- [ ] API endpoints respond (check `/api/health`)
- [ ] Authentication works (Supabase)
- [ ] Environment variables are set correctly
- [ ] CORS is configured properly
- [ ] WebSocket connection works (if using separate backend)

## Troubleshooting

### Build Fails

- Check that all dependencies are in `package.json`
- Verify build commands are correct
- Check Vercel build logs

### API Routes Return 404

- Verify `vercel.json` rewrites are correct
- Check that `api/index.ts` exists
- Ensure routes are prefixed with `/api`

### CORS Errors

- Verify `CLIENT_URL` matches your Vercel domain
- Check CORS configuration in `api/index.ts`

### WebSocket Connection Fails

- This is expected if using Vercel serverless functions
- Deploy backend to Railway/Render/Fly.io for WebSocket support

## Custom Domain Setup

1. In Vercel Dashboard → Settings → Domains
2. Add your custom domain
3. Follow DNS configuration instructions
4. Update `CLIENT_URL` in backend environment variables

## Monitoring

- Vercel provides built-in analytics
- Check Vercel Dashboard → Analytics for performance metrics
- Use Supabase Dashboard for database monitoring
