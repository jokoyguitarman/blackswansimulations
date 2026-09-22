# Enquiry emails: what we need from Kenneth

**Status: the enquiry form works and stores submissions. The emails do not send.**

A test enquiry on 22 Sep at 22:34 SGT was saved to the database, but both the
notification to us and the acknowledgement to the enquirer failed. Render's logs
give the reason plainly:

```
EAUTH 535-5.7.8 Username and Password not accepted
https://support.google.com/mail/?p=BadCredentials
command: AUTH PLAIN
```

Gmail accepted the connection and rejected the credentials. Everything else is
already correct, so this is the only thing standing between us and working
enquiry emails.

---

## What we need

**One 16-character Google App Password for `kenneth@prophyion.com`.**

That is the whole ask. Nothing else needs to change.

### Why an App Password and not the normal one

The server signs in to Gmail's SMTP as `kenneth@prophyion.com` to send mail.
Google has not accepted ordinary account passwords over SMTP since 2022. An App
Password is a separate 16-character credential issued for exactly this purpose.
It only works for mail, it cannot be used to sign in to the account in a browser,
and it can be revoked on its own without touching the real password.

---

## Step 1: confirm 2-Step Verification is on

App Passwords only exist on accounts with 2-Step Verification enabled. Check at:

**https://myaccount.google.com/signinoptions/two-step-verification**

If it is off, turn it on first. The App Password page will not appear otherwise.

## Step 2: create the App Password

Go to:

**https://myaccount.google.com/apppasswords**

1. Sign in as `kenneth@prophyion.com` if prompted.
2. In the **App name** box, enter `Prophyion website enquiries`.
3. Click **Create**.
4. Google shows a 16-character password in four blocks, like `abcd efgh ijkl mnop`.
5. Copy it. **It is shown once and never again.** If you lose it, delete the entry
   and create a new one; there is no way to view an existing one.

The spaces do not matter. We will strip them.

## Step 3: send it to us securely

Do **not** put it in an email, a WhatsApp message, or a chat thread. It is a live
credential for the mailbox.

Use either:

- A password manager share link (1Password, Bitwarden), or
- Enter it directly into Render yourself: Dashboard → `blackswansimulations-backend`
  → **Environment** → edit `SMTP_PASS` → paste → **Save**. The service restarts
  automatically, which takes about a minute.

If you enter it yourself, nobody else ever handles it. That is the better option.

---

## If the App Passwords page says it is unavailable

That means the Workspace admin has blocked App Passwords for the organisation, or
2-Step Verification is not on for the account. Since Kenneth is the admin, both
are fixable from the **Google Admin console** at admin.google.com:

- Check **Security → Authentication → 2-step verification** is permitted for
  users, and enrol the account.
- If App Passwords are blocked at the org level, that control also lives under
  **Security → Authentication**. Re-enable it, wait a few minutes for the change
  to propagate, then retry the App Passwords page.

If the option genuinely cannot be re-enabled, tell us and we will switch the
server to Amazon SES instead. See the note at the end.

---

## What is already done, so nobody redoes it

| Piece                                         | State                                               |
| --------------------------------------------- | --------------------------------------------------- |
| `MX` → `smtp.google.com`                      | correct, Workspace handles the domain's mail        |
| `SPF` → `v=spf1 include:_spf.google.com ~all` | correct, authorises Gmail to send as the domain     |
| `DKIM` at `google._domainkey`                 | published and signing                               |
| `SMTP_HOST` / `SMTP_PORT` on Render           | `smtp.gmail.com` / `465`, connecting fine           |
| `EMAIL_FROM`                                  | `kenneth@prophyion.com`                             |
| `ENQUIRY_NOTIFY_EMAIL`                        | `kenneth@prophyion.com`                             |
| `SMTP_PASS`                                   | **set but rejected. This is the one thing to fix.** |
| `DMARC`                                       | **not published.** Optional, recommended below.     |

One detail worth knowing: `SMTP_USER` must be `kenneth@prophyion.com`, the same
address as `EMAIL_FROM`. Gmail will not let the server send as one address while
authenticating as another unless the sender is configured as a verified alias.

---

## Recommended while you are in there: publish DMARC

SPF and DKIM are both in place, but without DMARC there is no policy telling
receiving servers what to do with mail that fails them, and no reporting when
something spoofs the domain. For a firm selling crisis preparedness to government
buyers, a missing DMARC record is the kind of thing a security reviewer notices.

Add this TXT record in **Cloudflare → prophyion.com → DNS**:

| Field   | Value                                                      |
| ------- | ---------------------------------------------------------- |
| Type    | `TXT`                                                      |
| Name    | `_dmarc`                                                   |
| Content | `v=DMARC1; p=none; rua=mailto:kenneth@prophyion.com; fo=1` |

Start at `p=none`. That monitors and reports without affecting delivery. Once the
reports confirm only Google is sending as the domain, tighten to `p=quarantine`
and later `p=reject`.

---

## How we will confirm it works

Once `SMTP_PASS` is updated, we submit a test enquiry through the form on
prophyion.com and check three things:

1. A notification arrives at `kenneth@prophyion.com`.
2. An acknowledgement arrives at the address used in the form.
3. The database row has both `notified_at` and `acknowledged_at` filled in, which
   is what proves the send actually succeeded rather than silently failing.

---

## A note on the longer term

A personal mailbox App Password is the fastest fix and it will work, but it is
not where this should stay:

- Gmail caps sending at roughly 2,000 messages a day.
- Mail breaks if Kenneth changes his password, loses the account, or leaves.
- Bounces and spam complaints land in a human inbox instead of being tracked.
- App Passwords are a legacy mechanism Google keeps narrowing.

Since we are already moving inference to AWS Bedrock, **Amazon SES** is the
natural home for transactional mail: DKIM signed on the domain itself rather than
a person's mailbox, bounce and complaint webhooks, proper delivery logs, and no
dependency on anyone's individual account. It is roughly an hour of work to
switch, and the domain verification reuses the DNS access we already have.

Worth doing before any real volume goes through the form, but not a reason to
delay the App Password today.
