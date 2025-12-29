# Environment Variables Template

Create a `.env` file in the project root with the following variables:

```env
# Server Configuration
NODE_ENV=development
PORT=3001
CLIENT_URL=http://localhost:3000

# Supabase Configuration (Required)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-here

# OpenAI Configuration (Required for AI features)
OPENAI_API_KEY=sk-your-openai-api-key-here
OPENAI_MODEL=gpt-4o

# Email Configuration (SMTP - Gmail example)
EMAIL_ENABLED=true
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-gmail-app-password
EMAIL_FROM=noreply@simulator.local
EMAIL_FROM_NAME=Simulation Environment

# Logging
LOG_LEVEL=info

# Inject Scheduler Configuration
# Enable automatic publishing of time-based injects when trigger_time_minutes is reached
# Default: enabled in production, disabled in development unless explicitly set to 'true'
ENABLE_AUTO_INJECTS=true
# Interval in milliseconds for checking if injects should be published (default: 30000 = 30 seconds)
INJECT_SCHEDULER_INTERVAL_MS=30000

# Security (Generate secure random strings for production)
# Run: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
SESSION_SECRET=change-this-to-a-secure-random-string
```

## How to Get Credentials

### Supabase

1. Go to [supabase.com](https://supabase.com) and create a project
2. Navigate to Project Settings > API
3. Copy the `URL` for `SUPABASE_URL`
4. Copy the `service_role` key for `SUPABASE_SERVICE_ROLE_KEY` (keep this secret!)

### OpenAI

1. Go to [platform.openai.com](https://platform.openai.com/api-keys)
2. Create a new API key
3. Copy it for `OPENAI_API_KEY`

### Email (Gmail Setup)

1. Enable 2-Factor Authentication on your Gmail account
2. Go to [Google Account Settings](https://myaccount.google.com/apppasswords)
3. Generate an "App Password" for "Mail"
4. Use your Gmail address for `SMTP_USER`
5. Use the generated app password for `SMTP_PASS`
6. Set `SMTP_HOST=smtp.gmail.com` and `SMTP_PORT=587`

## Security Notes

- **Never commit `.env` to git** - it's already in `.gitignore`
- **SERVICE_ROLE_KEY** bypasses Row Level Security - keep it server-side only
- Generate strong random strings for secrets in production
