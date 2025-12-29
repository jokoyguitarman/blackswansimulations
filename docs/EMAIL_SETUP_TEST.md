# Email Setup Testing Guide

## Quick Test

After configuring your `.env` file with Gmail SMTP settings, test the email service:

### 1. Restart Your Server

If your server is running, restart it to load the new environment variables:

```bash
# Stop the current server (Ctrl+C)
# Then restart:
npm run dev
```

### 2. Check Server Logs

When the server starts, you should see:

```
Email transporter initialized { host: 'smtp.gmail.com', port: 587 }
```

If you see:

```
Email service disabled (EMAIL_ENABLED=false)
```

→ Check that `EMAIL_ENABLED=true` in your `.env`

If you see:

```
SMTP credentials not configured, emails will be logged only
```

→ Check that `SMTP_USER` and `SMTP_PASS` are set in your `.env`

### 3. Test Email Sending

**Option A: Add a Participant to a Session**

1. Create a session
2. Add a participant (via `[PARTICIPANTS]` tab)
3. Check server logs for: `Invitation email sent`
4. Check participant's email inbox

**Option B: Check Logs**

- If email fails, you'll see: `Failed to send invitation email`
- If email succeeds, you'll see: `Invitation email sent { messageId: '...', to: '...' }`

### 4. Common Issues

**"Invalid login" Error**

- App password might be wrong
- Make sure you're using the 16-character app password, not your regular Gmail password
- Generate a new app password and update `.env`

**"Less secure app" Error**

- You're using regular password instead of app password
- Generate an app password from: https://myaccount.google.com/apppasswords

**Emails Not Sending**

- Check `EMAIL_ENABLED=true`
- Check `SMTP_USER` and `SMTP_PASS` are correct
- Check server logs for errors
- Verify 2FA is enabled on Gmail account

**Development Mode (No Real Emails)**

- Set `EMAIL_ENABLED=false` in `.env`
- Emails will be logged to console instead of sent
- Useful for testing without sending real emails

### 5. Verify Configuration

Your `.env` should have:

```env
EMAIL_ENABLED=true
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-16-char-app-password
EMAIL_FROM=noreply@simulator.local
EMAIL_FROM_NAME=Simulation Environment
```

## Next Steps

1. ✅ Restart server to load new config
2. ✅ Create a test session
3. ✅ Add yourself as a participant
4. ✅ Check your email inbox
5. ✅ Verify email content and link work
