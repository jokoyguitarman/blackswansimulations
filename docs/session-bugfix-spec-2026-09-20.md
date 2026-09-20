# Session bug-fix spec — 20 Sep 2026 (Dyson / Meridian run)

**Status:** diagnosed against the live session (trainer "Yeo, Kenneth X.", human player "Sandwichman",
nine AI teammate bots, scenario with 107 stakeholders) and fixed in the same day. Owner: runtime
agent. Touch points in other agents' modules are marked.

This is the reference sheet for nine symptoms reported from one play session. Each entry records
the symptom, the evidence, the root cause, the fix, and how to verify it, so the same class of bug
can be recognised next time. Three of the findings are systemic and get their own model sections
(§10 identity, §11 rate limiting, §12 inject publication).

---

## 0. Summary table

| #   | Symptom                                                                                                                                                      | Root cause                                                                                                                               | Fix (section) |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 1   | NPC group-chat lines show the trainer's name with "[NPC]" inline                                                                                             | `routeToGroupChat` inserts with `sender_id = trainer_id` and a text prefix                                                               | §1            |
| 2   | Same NPC line / email / post appears twice                                                                                                                   | Every scheduled inject fires twice — two API instances, no DB-level publish guard                                                        | §2, §12       |
| 3   | Bots never answer in team chat                                                                                                                               | Bot perception counts a line as "addressed to me" only if it names the bot, `@team`, or ends with `?`; the Executive channel has no bots | §3            |
| 4   | Send button is a bare green circle                                                                                                                           | Global `button { padding: 0.6em 1.2em }` squeezes the 40 px WhatsApp-style button                                                        | §4            |
| 5   | Own message shows twice, then one disappears                                                                                                                 | WebSocket fallback appends the real message without removing the optimistic bubble                                                       | §5            |
| 6   | Emails to NPCs unanswered ("Closing down factory" to Amelia Tan)                                                                                             | Legacy path's session-wide limiter (10 replies / 5 min) saturated by bot mail; stakeholder cap (30 / 10 min) same exposure               | §6, §11       |
| 7   | Desktop Back / Home / cross-app icon drops into mobile view                                                                                                  | Shared apps `navigate()` to `/device/...` routes instead of the desktop-aware intent helper                                              | §7            |
| 8   | To-field suggests addresses "from other simulations"; `@crisisresponse.sim` teammates                                                                        | Browser autofill on the To input (no `autoComplete="off"`); platform-wide hard-coded player domain                                       | §8            |
| 9   | "Participant, 1" on Z/Fakebook, "Sandwichman" in chat, "DH" / "[Name]" in NPC emails; an internal NPC argues instead of executing an executive's instruction | Two name stores (auth metadata vs `user_profiles`); NPC prompt never told who is writing; no chain-of-command rule for internal staff    | §9, §10       |

---

## 1. NPC group-chat lines attributed to the trainer

**Symptom.** In a team channel a line reads "Yeo, Kenneth X. — [NPC] FYI—our regional retail
partners' social teams are pinging us…". The trainer's name is the sender; the NPC is only a
bracketed prefix.

**Evidence.** `chat_messages` rows for the session: 20+ lines with `sender_id = e6536ef5…`
(the trainer) and content starting `[NPC] …`, one per group-chat inject, in every team channel.

**Root cause.** `routeToGroupChat()` in `server/services/feedEngineService.ts` predates migration 199. It writes `sender_id: trainer.trainer_id` and `content: "[${sender_name}] ${content}"` because
`chat_messages.sender_id` used to be NOT NULL. Since 199 the table has `sender_stakeholder_id` and
`sender_display_name`, with `CHECK (sender_id IS NOT NULL OR sender_stakeholder_id IS NOT NULL)`,
and both the list endpoint (`routes/channels.ts` ~L770) and the realtime handler
(`ChatInterface.handleRealtimeMessage`) already synthesise an NPC sender from those fields.

**Fix.** `routeToGroupChat` inserts `sender_id: null`,
`sender_stakeholder_id: config.stakeholder_id ?? 'npc:' + slug(sender_name)`,
`sender_display_name: sender_name`, and the content without the bracket prefix. Nothing changes on
the client. `sender_stakeholder_id` is TEXT with no FK, so the `npc:` pseudo-id is legal and lets
the client key the avatar.

**Verify.** Fire a group-chat inject → the line shows the NPC's name and initial; the TeamChat list
preview shows the NPC name; a player reply in that channel does not trigger an NPC reply (team
channels are player space; §3 covers bots).

---

## 2. Every scheduled inject fires twice

**Symptom.** Duplicate NPC chat lines ~1 minute apart, duplicate inbound emails, duplicate feed
posts.

**Evidence.** `session_events WHERE event_type='inject'` in the live session: 25 of 25 sampled
`war_room` injects have two events, 5–97 s apart (e.g. "Board office asks if execs are aware"
15:05:50 and 15:06:00; "Call from Meridian HR Manager" 15:17:10 and 15:18:02). All types affected.

**Root cause.** `InjectSchedulerService` has an in-process per-session lock
(`sessionsInProgress`), so a single process cannot double-publish. Two publications therefore mean
two API processes were running the scheduler against the same database — a second instance, or an
old deployment kept alive through a rollout. `publishInjectToSession()` (`routes/injects.ts`) has no
database-level guard: it reads `session_events`, then inserts one, then routes; two processes both
see "not published" and both publish.

**Fix.** Publication becomes idempotent at the database (§12): migration 208 adds
`inject_publications (session_id, inject_id) PRIMARY KEY`; `publishInjectToSession` claims the row
first (`ON CONFLICT DO NOTHING`) and returns silently when the claim already exists. Trainer manual
publish passes `{ force: true }` to re-publish deliberately. This also halves the load on the rate
limiters in §6.

**Open question for the product owner.** How is the API hosted and how many instances run? If two
are intended, every background engine (scheduler, AI inject scheduler, chat surveillance,
statement watchdog, pressure engine ticker, bot runner) runs twice and costs twice. If not intended,
the platform is keeping the previous deployment alive — the guard makes the visible symptom
impossible either way.

**Verify.** With two local processes pointed at the same DB, one inject → one `inject` event, one
chat line; the `inject_publications` row exists once.

---

## 3. AI teammate bots don't answer in team chat

**Symptom.** Human writes "damn it people" and "could you please react faster" in `team/Executive —
DH`; nothing comes back.

**Evidence.** Bot lines in the session are all "STATUS UPDATE: …" (their scheduled cadence). No
bot is a member of the Executive team channel; bots sit on Legal, Communications, Operations,
HR/Labour Compliance, Supply Chain, Stakeholder Engagement, Shareholder Engagement, Country Manager.

**Root cause.** `server/services/teammates/perception.ts` (~L460) builds `mentions` only from lines
that contain the bot's display name or first name, contain `@<team>`, or end with `?`. Plain
imperatives from a human are invisible to triage. Second, a channel without bots has nobody who
could answer.

**Fix (touch point in the teammate module, owner notified).** Any line in the bot's own team channel
from a **non-bot** participant (`accounts.isBotUser`) that nobody else has spoken after counts as a
mention (same `seenChat` memory so a line is answered once; same team blackboard so one bot
answers, not all). Explicit mentions, `@team` and trailing-`?` lines behave as before; trainer
nudges unchanged. The Executive channel case is not a code defect: add an Executive bot in the
lobby if leadership should have a bot colleague.

**Verify.** Human writes a plain line in a channel with a bot → one bot reply within a turn
(40–90 s at intellect 80); a second bot does not also answer; a `?` line still works as before.

---

## 4. Send button renders as a plain green circle

**Root cause.** `frontend/src/style.css` has a global `button { padding: 0.6em 1.2em; }`. The
WhatsApp-style send button is `w-10 h-10` (40 px) with a 20 px SVG; ~38 px of horizontal padding
leaves the icon no room.

**Fix.** `p-0` on the send button class, `shrink-0` on the SVG (`ChatInterface.tsx`,
`s.sendButton`). Verified visually.

---

## 5. Own message duplicated, then one bubble disappears

**Root cause.** `ChatInterface.tsx` has two inbound paths for a new message: Supabase realtime
(`handleRealtimeMessage`) and the WebSocket fallback (`useWebSocket … 'message.sent'`, ~L1043). The
server emits `message.sent` immediately after the insert — usually **before** the `POST` response
returns — and the fallback appends the message when no message with that **id** exists. The
optimistic bubble has a `temp-…` id, so both are shown. The realtime path then renames the temp
bubble to the real id; two bubbles share one id until a reload replaces the list.

**Fix.** In the fallback: if `newMessage.sender_id === user.id`, replace the `temp-` bubble with the
same content instead of appending (and dedupe by id in the same pass). Realtime path unchanged.

**Verify.** Send ten messages quickly → ten bubbles, none flickering; refresh → same ten.

---

## 6. NPC emails unanswered

**Symptom.** "Closing down factory" to `amelia.tan@dyson.com` at 23:18 — no reply. "Proceed
immediately thank you" to Mei Ling Wong — no reply; the follow-up five minutes later gets one.

**Evidence.** Session had 23 NPC replies in the trailing 10 minutes when the email was sent; the
nine bots produced ~60 outbound emails in 20 minutes. `amelia.tan@dyson.com` is not a stakeholder
(all 107 stakeholder addresses are `.sim` domains); it is an inbound inject sender, so the reply
goes through the legacy persona path.

**Root cause.** `triggerNPCEmailReply()` runs three anti-loop checks **before** anything else:
per-email, per-thread (6), and **session-wide** ("max 10 NPC replies in the last 5 minutes"). The
session-wide check counts every inbound NPC email in the session regardless of who triggered it,
so bot traffic starves the human. The stakeholder engine's `underSessionCap()` (30 NPC messages /
10 min, session-wide) has the same shape and explains Mei Ling Wong's silence.

**Fix (§11).**

- Stakeholder recipients are resolved **before** the legacy limiters (the v3.2 multi-recipient
  path), so workbook contacts are never starved by the legacy budget.
- Legacy limiter becomes **per sender** (4 replies / 5 min per player) plus a session ceiling of 40
  that **exempts non-bot senders** (`user_profiles.is_bot`). Per-thread cap of 6 stays.
- `underSessionCap()` becomes per sender (6 / 10 min) plus a session ceiling of 60 with the same
  human exemption.

**Verify.** With bots active, a human email to a legacy NPC and to a stakeholder both get replies
within ~90 s; bot mail still capped.

---

## 7. Desktop falls back to mobile view

**Symptom.** Desktop → Mail → Back from the inbox → phone UI. Desktop → Z → Fakebook icon → phone
UI. Desktop → News → Home → phone UI.

**Root cause.** Shared app components call `navigate(\`/sim/${sessionId}/device/…\`)`for
Home/Back and for cross-app links. Those are phone routes.`frontend/src/lib/appIntents.ts`already has`openAppWithIntent()`which detects the desktop path and opens a window instead, but
these call sites bypass it. Call sites:`EmailApp`L958;`SocialFeedApp`L1794, L1836, L2237;`NewsApp`L706;`FacebookFeedApp`L1161, L1777, L1834, L1853, L2337;`WordApp`L220;`ZDesktopLayout`L288;`GroupChatApp`L139;`SheetsApp` L175.

**Fix.** New hook `frontend/src/lib/deviceNav.ts` → `useDeviceNav(appId)` returning
`{ isDesktop, goHome(), openApp(appId, params?) }`. Phone: navigates as today. Desktop: `goHome()`
dispatches `sim:desktop-close-app` (handled in `DesktopShell` beside the existing open-app listener;
closes the calling window) and `openApp()` delegates to `openAppWithIntent()`. Thirteen call sites
switched (Mail, Z ×3, News, Fakebook ×5, Docs, TeamChat, Contacts); `NewsApp` now also consumes
the parked `article` intent so "open this article" works from a desktop window. Deliberately kept:
`ZDesktopLayout`'s sidebar "Phone Mode" / "Desktop Mode" buttons and the shell's own mobile-view
control — those are the explicit switches. `DeviceShell` / `HomeScreen` are phone-only and
untouched.

**Verify.** Every Back/Home/cross-app control in Mail, Z, Fakebook, News, Docs, Contacts, TeamChat
keeps the URL under `/desktop`.

---

## 8. "Contacts from other simulations" and the `@crisisresponse.sim` domain

**Finding.** Server-side sources are all scoped: session players (`session_participants`),
inbound senders of **this** session (`sim_emails WHERE session_id = …`), stakeholders of **this**
scenario. `amelia.tan@dyson.com` appears in this session only (4 inject emails). The addresses that
"come from other simulations" are the **browser's own form history** on the To input, which has no
`autoComplete="off"`.

**Domains in play.** `@dyson.com` → legacy inject NPCs (inbox senders); `@dyson.sim`, `@dh.sim`,
`@dmo.sim`, `@meridianassemblysdnbh.sim`… → workbook stakeholders (generator-slugged organisation
names); `@crisisresponse.sim` → the platform's hard-coded `SIM_EMAIL_DOMAIN` for every player and
teammate bot (`server/services/playerDirectoryService.ts`), which is why a Legal teammate looks
foreign next to `@dyson.sim` NPCs.

**Fix.**

- `EmailApp` To/Subject inputs: `autoComplete="off"`, per-session `name` attribute.
- Dropdown rows labelled by `source`: "Team" (players), "Contact" (workbook), "From inbox" (inject
  NPCs), so a dead-end address is recognisable before sending.
- Player address domain derived **per organisation** (§10.3): the most common domain among that
  org's `internal` stakeholders; else `slug(org short/display name).sim`; else the legacy default.
  `resolveAddressesToPlayers` accepts the legacy domain too, so mail stored before the change still
  resolves. Teammate bots (`teammates/perception.ts` `simAddressFor`) read the directory instead of
  re-deriving (touch point).

---

## 9. Identity: "Participant, 1" / "Sandwichman" / "DH" / "[Name]"

**Evidence.** `user_profiles.full_name = 'Sandwichman'`;
`auth.users.raw_user_meta_data.full_name = 'Participant, 1'` for the same user.

**Root causes.**

1. **Two name stores.** The join-link flow writes the display name to both `user_profiles` and
   Supabase Auth `user_metadata`; later renames only reach `user_profiles`. Social routes read
   `user.metadata.full_name` first (`routes/socialMedia.ts` L335, L794, L1060–1061, L1233, L1389;
   `socialMessenger.ts` L27, L177, L357; `socialEvents.ts` L87, L147, L225; `socialGroups.ts` L112)
   → "Participant, 1" and handle `@participant__1`. Chat joins `user_profiles` → "Sandwichman".
2. **NPCs are never told who is writing.** `stakeholderReconsiderationService.callJudge()` renders
   the log as `[email · <team_name>] …` and the latest message as "FROM THE PLAYER". The model
   either invents a placeholder ("Hi [Name]") or adopts the team label's suffix ("Hi DH", from
   "Executive — DH").
3. **No chain of command for internal staff.** The internal-stakeholder prompt says "share verified
   facts, request status, flag constraints" and "reflect your own interests". Faced with "Proceed
   immediately", an operations director argues policy instead of executing; a terse instruction may
   also be judged "no reply needed".

**Fix (§10).**

- One display-name source: `requireAuth` attaches `req.user.displayName` from `user_profiles`
  (one PK lookup); `server/lib/identity.ts` exposes `displayNameOf(user)` and `handleFor(name)`;
  all twelve call sites use them. Auth metadata is never read for in-game identity again.
- Judge prompt receives the **sender**: `PLAYER: Sandwichman — Executive team (Executive), Dyson
HQ Singapore` and log lines carry the sender's name; rule: address the player by name, never emit
  placeholders. Post-processing scrubs `[Name]`, `[Your Name]`, `{name}` defensively.
- Internal staff rule: players are colleagues; an instruction from the Executive function or from
  the function that owns you is to be **carried out** — acknowledge, state what you will do and by
  when, raise risks once, ask for what you need; refuse only when a hard constraint applies
  (unlawful / unsafe), and then say what you can do instead. A direct instruction or question is
  always answered (`should_reply: true`), even briefly.

---

## 10. Identity model (normative)

### 10.1 Display name

- **Source of truth:** `user_profiles.full_name`. Editable by the player (join-link display name,
  profile). Auth `user_metadata.full_name` is a write-only cache for Supabase's own UI and must
  not be read by game routes.
- **Server:** `requireAuth` sets `req.user.displayName` (fallback: auth metadata, then email local
  part). Helper `displayNameOf(user)`.
- **Surfaces:** feed posts/reposts/replies, page "posted by", Messenger, events, groups, email
  `from_name`, chat (already), NPC prompts, AAR — all via `displayNameOf`.

### 10.2 Handle

`handleFor(name)` = `@` + name with each of `@ . space + , " \` replaced by one `_`, lowercased —
deliberately the historical derivation (no collapsing, no truncation) so handles already stored on
posts, Messenger threads and notifications keep matching (`Participant, 1` → `@participant__1`,
`Sandwichman` → `@sandwichman`). One implementation in `server/lib/identity.ts`, unit-tested.

### 10.3 In-sim email address

`<local>@<domain>` where `local` = name slug (collision-suffixed per session) and `domain` =
`getSessionEmailDomain(sessionId, orgKey)`: most common domain of the org's `internal`
stakeholders → `slug(org short_name || display_name).sim` → `crisisresponse.sim`. Resolution of
incoming addresses accepts both the org domain and the legacy domain.

### 10.4 What an NPC knows about the player

Name, team name, function, organisation display name — passed on every judge call and rendered in
the conversation log. Never the real email or account id.

---

## 11. Rate-limiting model (normative)

| Limiter                                | Before                             | After                                                                          |
| -------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------ |
| Legacy NPC email replies, per thread   | 6                                  | 6                                                                              |
| Legacy NPC email replies, session-wide | 10 / 5 min, counts everyone        | per sender 4 / 5 min; session ceiling 40 / 5 min applies to bot senders only   |
| Stakeholder engine `underSessionCap`   | 30 NPC msgs / 10 min, session-wide | per sender 6 / 10 min; session ceiling 60 / 10 min applies to bot senders only |
| Stakeholder coalescing window          | 45 s per stakeholder               | unchanged                                                                      |

Principle: a human player's message is never dropped because of automated traffic. Bots are
identified by `user_profiles.is_bot`.

---

## 12. Inject publication idempotency (normative)

- Table `inject_publications (session_id uuid, inject_id uuid, claimed_at timestamptz default
now(), claimed_by uuid null, PRIMARY KEY (session_id, inject_id))`, RLS enabled, service-role
  only (migration 208, applied 20 Sep 2026).
- `publishInjectToSession(injectId, sessionId, userId, io, { force? })`: upsert with
  `ignoreDuplicates` (`ON CONFLICT DO NOTHING`) and `select`; zero rows returned → already
  published → log `inject_publish_skipped_duplicate` and return. `force: true` (the trainer's
  manual publish endpoint) bypasses the claim and logs `inject_publish_forced`. If the table is
  unreachable the guard fails open (publishes, warns) so a stale deployment cannot silence injects.
- The `session_events` `inject` row remains the trainer-visible record; the claim table is the
  lock. Backfill is unnecessary: the claim is checked only for future publications.

---

## 13. Verification checklist

1. Fresh session, one group-chat inject → one line, NPC name, no `[NPC]` prefix.
2. Two local API processes → each inject publishes once.
3. Human line in a bot's channel → one bot reply; no reply in a channel without bots.
4. Send button shows the paper plane; ten quick messages → ten bubbles, no flicker.
5. Human email to a legacy NPC and to a stakeholder while bots run → both replied within ~90 s.
6. Desktop Mail Back / Z→Fakebook / News Home stay under `/desktop`.
7. Compose To offers no browser history; dropdown rows carry Team / Contact / From inbox labels;
   teammates carry the organisation domain; old `@crisisresponse.sim` addresses still resolve.
8. Z post by the human shows "Sandwichman" / `@sandwichman`; NPC email greets "Hi Sandwichman"
   (or first name), no "[Name]", no "DH"; "Proceed immediately" to an internal NPC gets an
   acknowledgement that commits to action and flags risk once.
