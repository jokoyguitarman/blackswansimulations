# Runtime implementation spec — notifications, TeamChat, stakeholder contacts, multi-org readers

2026-09-20 — **status: workstreams 0–4 implemented and live (migrations 198–204 applied,
pushed to production). Workstream 5 (menu-based decision layer) was built, then RETIRED the same
day by the product owner and removed from the runtime; its replacement — the organic
executive-decision model — is specified in `docs/executive-decisions-organic-handover.md` and owned
end to end by the generator agent.** Implements the runtime side of
`stakeholder-contacts-contract.md` v3.1. Owner: runtime agent (everything except the organic
decision feature).

Nothing here is scenario-specific. "Multi-org" means any of: several offices of one company,
several agencies in one country, several countries. One data shape covers all three.

Conventions used below: `→` = returns / results in; all endpoints are under the existing routers
(`/api/channels`, `/api/social`, `/api/notifications`, `/api/sessions`) and use `requireAuth`;
"identity" = `TeamIdentity { team_name, function_key, org_key, country }` from §0.2.

---

## Ordering

| #   | Workstream                                                    | Size | Hard dependency                                                                                     |
| --- | ------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------- |
| 0   | Foundation: contract lib, org registry, team-identity readers | S    | —                                                                                                   |
| 1   | Notification pill                                             | S    | —                                                                                                   |
| 2   | Department chats                                              | M    | —                                                                                                   |
| 3   | Stakeholder runtime                                           | L    | generator's `scenario_teams` migration (197) before testing; a scenario with `stakeholders` for E2E |
| 4   | Multi-org readers                                             | M–L  | generator's `orgs[]` + tagged injects/personas for E2E                                              |
| 5   | ~~Decision layer (menu-based)~~ — RETIRED, see handover doc   | —    | —                                                                                                   |

Every reader of a new field treats "absent" as today's behaviour, so 0–3 ship and work in
single-org scenarios regardless of the generator's progress.

**Migration numbering** (latest in repo is `196`): generator agent takes **197**
(`scenario_teams.org_key`, `function_key`); runtime takes **198–202** as listed per workstream.

---

## 0. Foundation

### 0.1 `server/lib/stakeholderContract.ts` (new)

Exports (all pure; no DB access):

```ts
export type StakeholderRelationship =
  | 'client'
  | 'supplier'
  | 'regulator'
  | 'partner'
  | 'internal'
  | 'media'
  | 'community'
  | 'investor'
  | 'union'
  | 'other';
export type Persuadability = 'none' | 'low' | 'medium' | 'high';
export type Verdict = 'keep' | 'modify' | 'delay' | 'cancel';
export interface Stakeholder {
  /* contract §3, verbatim */
}
export type PlayerVisibleStakeholder = Pick<
  Stakeholder,
  | 'id'
  | 'name'
  | 'title'
  | 'organisation'
  | 'relationship'
  | 'owning_team'
  | 'org_key'
  | 'email'
  | 'phone'
  | 'handle'
  | 'note'
  | 'avatar_url'
>;
export interface OrgRegistryEntry {
  /* contract §5.1 */
}
export interface CountryEntry {
  /* contract §5.1 */
}
export interface TeamIdentity {
  team_name: string;
  function_key: string | null;
  org_key: string | null;
  country: string | null;
}

export const StakeholderSchema: z.ZodType<Stakeholder>; // field-level rules: id /^[a-z0-9_]+$/, email lowercase, handle /^@[a-z0-9_]{3,30}$/
export const StakeholdersSchema: z.ZodType<Stakeholder[]>; // + superRefine: unique id/email/handle; grievance ''  ⇔ resolution_criteria []
export const OrgRegistrySchema: z.ZodType<OrgRegistryEntry[]>; // unique org_key; exactly one protagonist is_primary
export const CountriesSchema: z.ZodType<CountryEntry[]>;

export function resolveTeamFunction(t: { team_name: string; function_key: string | null }): string;
export function isStakeholderVisibleToTeam(
  s: Stakeholder | PlayerVisibleStakeholder,
  t: TeamIdentity,
): boolean; // contract §6
export function toPlayerVisible(s: Stakeholder): PlayerVisibleStakeholder;
export const RELATIONSHIP_SHEETS: ReadonlyArray<readonly [StakeholderRelationship, string]>; // contract §6 order/labels
export const ALLOWED_VERDICTS: Record<Persuadability, ReadonlySet<Verdict>>; // contract §3.1
export const MAX_DELAY_MINUTES = 15;
export function criteriaThreshold(p: Persuadability, total: number): number; // medium → total; high → ceil(total/2); none/low → Infinity
```

Tests `server/lib/__tests__/stakeholderContract.test.ts` (vitest, same runner as existing server
tests): predicate truth table — single-org exact name; common stakeholder vs three composed teams
sharing `function_key`; org-specific vs same function other org; custom team without
`function_key`; team with `org_key: null` sees org-specific; `toPlayerVisible` drops every hidden
key; schema rejects duplicate email, uppercase email, grievance without criteria;
`criteriaThreshold` table.

### 0.2 `server/services/orgRegistryService.ts` (new)

```ts
export async function getOrgRegistry(scenarioId: string): Promise<OrgRegistryEntry[]>;
// initial_state.orgs[] (validated) → else derive from normalizeOrgPages(initial_state.org_page)
//   (role → side, country/city from OrgConfig if present) → else [{ org_key:'primary', display_name: org_name ?? 'Organization', country: null, side:'protagonist', is_primary:true }]
export async function getCountries(scenarioId: string): Promise<CountryEntry[]>; // countries[] or distinct orgs[].country as { name }
export async function getSessionTeams(
  sessionId: string,
): Promise<Array<TeamIdentity & { scenario_team_id: string | null }>>;
// scenario_teams for the session's scenario, selected with '*' (tolerates missing 197 columns → null),
// joined with the registry for country. Teams present in session_teams but absent from scenario_teams
// (legacy/custom) are returned with function_key/org_key null.
export async function getTeamIdentity(
  sessionId: string,
  userId: string,
): Promise<TeamIdentity | null>; // via session_teams.team_name
export async function getOrgMemberUserIds(sessionId: string, orgKey: string): Promise<string[]>; // users on teams with that org_key (+ teams with null org_key)
export async function getUserCountry(sessionId: string, userId: string): Promise<string | null>;
export function invalidateScenario(scenarioId: string): void;
```

Cache (shared helper `server/lib/scenarioCache.ts`, also used by §3.1):
`Map<scenarioId, { updated_at, value }>`; every read first does
`select updated_at from scenarios where id = $1` (PK lookup) and refetches when it differs.
`scenarios.updated_at` is bumped by the existing `update_scenarios_updated_at` trigger
(migration 001), so post-compile edits between sessions are picked up without signalling.
`invalidateScenario` remains for tests. Contract §7 item 10.

### 0.3 Team-identity readers

| Site                                                                                   | Change                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `teamCharterService.ts` `isKnownTeam`, `getCharterForTeam`, `getPlayerTeamContext`     | Accept `{ team_name, function_key }`; look up `TEAM_CATALOG[resolveTeamFunction(t)]`. `getPlayerTeamContext` result gains `function_key`, `org_key`.                                                                                                                                                                             |
| `GET /social/my-team/session/:id`                                                      | Response adds `function_key`, `org_key`, `country`.                                                                                                                                                                                                                                                                              |
| `GET /channels/session/:id/participants`                                               | Each participant adds `function_key`, `org_key`.                                                                                                                                                                                                                                                                                 |
| `frontend HomeScreen.TEAM_ICON`                                                        | Key = `function_key ?? team_name`.                                                                                                                                                                                                                                                                                               |
| AAR / scoring sweep                                                                    | `rg "team_name ===                                                                                                                                                                                                                                                                                                               | TEAM_CATALOG\[ | FIXED_TEAM_NAMES" server/services/aar\*.ts server/services/teamScoreService.ts server/services/playerLedgerService.ts frontend/src`→ route through`resolveTeamFunction`/`function_key`. Composed and custom teams then receive their catalog AAR section. |
| `feedEngineService.resolveTeamMembers` (used by `routeToEmail` for `stakeholder_team`) | Exact `team_name` match first; if zero members, add members of teams whose `resolveTeamFunction(team) === value` (restricted to the inject's `org_key` when set); only then the existing session-wide fallback. Contract §7 item 9. Prevents a function name in `stakeholder_team` from ever degrading to session-wide delivery. |

**Done when:** a team row `{ team_name: "Communications — PNP", function_key: "Communications" }`
gets 📣, its charter fallback and its AAR section; rows with `function_key: null` behave as
before; contract tests green.

---

## 1. Notification pill

Files: `frontend/src/components/SimDevice/DeviceShell.tsx`, `NotificationCenter.tsx`.
`NotificationBanner.tsx` is deleted; `NotificationItem` moves to `NotificationCenter.tsx`.
Mobile only (`DesktopShell` has no banner).

### 1.1 `DeviceShell` state machine

Remove: `bannerQueue`, `activeBanner`, `handleBannerDismiss`, `handleBannerTap`, the
`<NotificationBanner>` render and the `!activeBanner &&` guard.

```ts
// WS onEvent, after mapEventToNotification and the existing "already in target app" check:
setNotifications((prev) => (prev.some((n) => n.id === item.id) ? prev : [item, ...prev]));

const dismissAll = useCallback(
  async (reason: 'close' | 'clear' | 'swipe' | 'item') => {
    setCenterExpanded(false);
    const hadPersisted = notifications.some((n) => n.dbId);
    setNotifications([]);
    if (hadPersisted && sessionId) {
      try {
        await fetch(apiUrl('/api/notifications/read-all'), {
          method: 'POST',
          headers: await getAuthHeaders(),
          body: JSON.stringify({ session_id: sessionId }),
        });
      } catch {}
    }
  },
  [notifications, sessionId],
);

const handleCenterTap = useCallback(
  async (n) => {
    if (n.dbId) {
      /* existing POST /api/notifications/:id/read */
    }
    navigate(n.route);
    void dismissAll('item');
  },
  [navigate, dismissAll],
);
```

Props passed: `<NotificationCenter notifications expanded onExpand={() => setCenterExpanded(true)} onDismiss={dismissAll} onTap={handleCenterTap} />`.
Initial unread fetch on mount is kept (pill reflects arrivals since last dismissal across
refreshes). The `chat_message` route becomes `/sim/${sessionId}/device/chat?channel=${metadata.channel_id}` when present (consumed in §2.5).

### 1.2 `NotificationCenter`

Props: `{ notifications; expanded; onExpand(); onDismiss(reason); onTap(n) }`. Backdrop click →
`onDismiss('close')`; Clear All → `onDismiss('clear')`.

Swipe hook `useSwipeUp(onTrigger)` (new, `frontend/src/hooks/useSwipeUp.ts`) returning pointer
handlers + `style.transform`:

- `pointerdown`: record `startY`, `startT`, `setPointerCapture`.
- `pointermove`: `dy = clientY - startY`; `translateY = Math.min(0, dy)`; ignore positive.
- `pointerup`: trigger if `dy <= -40 && (now - startT) <= 400` **or** `dy <= -120`; else snap
  back (`transition: transform 160ms`). On trigger animate to `-100%`, then `onTrigger()`.
- Handle elements carry `touch-action: none`. Applied to: the collapsed pill; the expanded panel's
  header row only (the list must keep native scrolling).

### 1.3 Edge cases

- Same notification id arriving twice (WS + initial fetch) → deduped by id.
- Email / Messenger arrivals have no `dbId` → local only; `read-all` is skipped when nothing is
  persisted.
- User is in Mail when a Mail notification arrives → still skipped (existing rule).
- Pill label: `${n} notification${n===1?'':'s'}`; hidden when `n === 0 && !expanded`.

**Done when:** in Mail compose/reply a stream of 10 notifications never covers Send or Cancel;
pill shows 10; expand → swipe up on header → pill gone; 2 more arrive → pill shows 2; refresh →
still 2; Clear All marks the persisted ones read server-side.

---

## 2. Department chats

### 2.1 Migration `198_team_channels.sql`

```sql
ALTER TABLE chat_channels DROP CONSTRAINT IF EXISTS chat_channels_type_check;
ALTER TABLE chat_channels ADD CONSTRAINT chat_channels_type_check
  CHECK (type IN ('public','inter_agency','private','command','trainer','role_specific','direct','team','npc_direct'));
ALTER TABLE chat_channels ADD COLUMN IF NOT EXISTS team_name TEXT;
ALTER TABLE chat_channels ADD COLUMN IF NOT EXISTS stakeholder_id TEXT;          -- used by §3.3
CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_channels_team ON chat_channels(session_id, team_name) WHERE type = 'team';
CREATE INDEX IF NOT EXISTS idx_chat_channels_stakeholder ON chat_channels(session_id, stakeholder_id) WHERE type = 'npc_direct';

CREATE TABLE IF NOT EXISTS chat_channel_reads (
  channel_id UUID NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (channel_id, user_id)
);

CREATE OR REPLACE FUNCTION can_user_access_channel(p_channel_id UUID, p_user_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM chat_channels c JOIN sessions s ON s.id = c.session_id
    WHERE c.id = p_channel_id AND (
      s.trainer_id = p_user_id
      OR EXISTS (SELECT 1 FROM user_profiles up WHERE up.id = p_user_id AND up.role = 'admin')
      OR (c.type IN ('direct','npc_direct') AND c.members ? p_user_id::text)
      OR (c.type = 'team' AND EXISTS (SELECT 1 FROM session_teams st
            WHERE st.session_id = c.session_id AND st.user_id = p_user_id AND st.team_name = c.team_name))
      OR (c.type NOT IN ('direct','npc_direct','team','trainer') AND is_user_session_participant(c.session_id, p_user_id))
    ));
$$;

DROP POLICY IF EXISTS "Session participants can view messages" ON chat_messages;
CREATE POLICY "Channel members can view messages" ON chat_messages FOR SELECT
  USING (can_user_access_channel(channel_id, auth.uid()));
```

Effect: Supabase Realtime (which the client subscribes to unfiltered, relying on RLS) stops
pushing `direct`, `npc_direct`, `team` and `trainer` rows to non-members. This closes the existing
DM leak as a side effect. Trainer Channel becomes trainer/admin-only, matching the product
decision to hide it from players.

### 2.2 `server/lib/channelAccess.ts` (new) — one rule for REST and WS

```ts
export type ChannelRow = {
  id: string;
  session_id: string;
  type: string;
  team_name: string | null;
  members: string[] | null;
  stakeholder_id: string | null;
  name: string;
  role_filter: string | null;
};
export async function assertChannelAccess(
  channelId: string,
  user: { id: string; role: string },
): Promise<
  | { ok: true; channel: ChannelRow; isTrainer: boolean }
  | { ok: false; status: 403 | 404; error: string }
>;
export async function listAccessibleChannels(
  sessionId: string,
  user: { id: string; role: string },
): Promise<ChannelRow[]>;
export async function getChannelMemberIds(channel: ChannelRow): Promise<string[]>;
// team → session_teams users for team_name (+ trainer); direct/npc_direct → members; trainer → trainer/admins; else → all participants + trainer
```

Mirrors the SQL predicate exactly (kept side by side with a comment referencing 198).

### 2.3 `channelService.ensureTeamChannels`

```ts
export async function ensureTeamChannels(sessionId: string, createdBy: string): Promise<void>;
// distinct session_teams.team_name → for each missing (session_id, team_name) insert
// { session_id, name: team_name, type: 'team', team_name, members: [], created_by: createdBy }
```

Called from: `GET /channels/session/:id` (before listing, alongside the existing default-channel
self-heal), and after every `session_teams` write — `routes/teams.ts` (assign/reassign/remove),
`routes/join.ts:241`, `routes/demo.ts:129`. Membership is **derived live** from `session_teams`
(channel `members` stays empty for `team`), so reassignments take effect immediately; a removed
team's channel is left in place but becomes invisible (no members).

### 2.4 `routes/channels.ts`

**`GET /channels/session/:sessionId`** → `{ data: ChannelListItem[] }`

```ts
interface ChannelListItem {
  id: string;
  session_id: string;
  name: string;
  type: 'public' | 'inter_agency' | 'command' | 'trainer' | 'role_specific' | 'team';
  team_name: string | null;
  function_key: string | null;
  org_key: string | null;
  member_count: number;
  last_message: { content: string; created_at: string; sender_name: string } | null;
  unread_count: number; // capped at 99
}
```

Implementation: `listAccessibleChannels` → one query for the newest 500 `chat_messages` of the
session (`id, channel_id, content, created_at, sender_id, sender_stakeholder_id,
sender_display_name`) + one for `chat_channel_reads` of the caller → reduce in JS for preview and
unread; `member_count` from `getChannelMemberIds`; `function_key`/`org_key` from
`getSessionTeams`. Direct/NPC channels are excluded here (they come from `/dms`).

**`GET /channels/session/:sessionId/dms`** — unchanged shape, plus for `npc_direct`:
`stakeholder: PlayerVisibleStakeholder` and `type`. Includes `unread_count`.

**`GET /channels/:channelId/members`** → `{ data: Array<{ id: string; full_name: string; role: string; team_name: string | null; function_key: string | null; org_key: string | null; is_trainer: boolean }> }`; requires `assertChannelAccess`.

**`POST /channels/:channelId/read`** → upsert `chat_channel_reads (channel_id, user_id, now())` → `204`.

**`GET /channels/:channelId/messages`**, **`POST /channels/:channelId/messages`** — replace the
inline session + direct checks with `assertChannelAccess`. On POST, recipients for
`createNotificationsForUsers` = `getChannelMemberIds(channel)` minus sender (today: all
participants). Notification `metadata` adds `channel_type`, `team_name`.

**Frontend client (`frontend/src/lib/api.ts` → `api.channels`)**: `getMembers(channelId)`,
`markRead(channelId)`, and list/getDMs typed with the shapes above.

### 2.5 WebSocket `join_channel` (`server/websocket/index.ts:121`)

Replace the `role_specific` check with `assertChannelAccess(channelId, { id: socket.userId, role: socket.userRole })`; emit `error` on `ok: false`.

### 2.6 Frontend — `frontend/src/components/SimDevice/TeamChat/`

```
TeamChat/
  types.ts            ChatListItem, ChatScreenState
  ChatListScreen.tsx  list + search
  ConversationScreen.tsx
  MemberSheet.tsx
  avatars.ts          team icon (by function_key), initials, npc avatar seed
```

```ts
type ChatListItem = {
  id: string;
  kind: 'group' | 'dm' | 'npc';
  name: string;
  subtitle: string; // group: "3 members" · dm: team/role · npc: "title · organisation"
  functionKey: string | null; // for the group icon
  lastMessage: string | null;
  lastAt: string | null;
  unread: number;
};
type ChatScreenState =
  | { screen: 'list' }
  | { screen: 'conversation'; channelId: string; kind: 'channel' | 'dm' };
```

`GroupChatApp.tsx` becomes the router: state `ChatScreenState`; initial state from
`?channel=<id>` (deep link from notifications); header per screen (list: title "TeamChat", search
icon, existing **Calls** toggle moves here; conversation: back, name, subtitle "N members" /
title·org, tap → `MemberSheet`). Hardcoded "Crisis Response Team · 8 members · 3 online" removed.

`ChatListScreen` props `{ sessionId; variant; onOpen(item) }`. Data: `api.channels.list` +
`api.channels.getDMs`; sections **Groups** (team channels first, then All Teams, Command, Public)
and **Direct**. Live updates: `useRealtime({ table: 'chat_messages', onInsert })` bumps
`lastMessage/lastAt/unread` for the affected channel (RLS guarantees only visible rows arrive);
`useWebSocket({ eventTypes: ['message.sent'] })` as the existing fallback. Search input filters the
list by name (contacts search is added in §3.3).

`ConversationScreen` props `{ sessionId; variant; channelId; kind; onBack }`: renders
`<ChatInterface sessionId variant fixedChannelId={channelId} fixedChannelKind={kind} />`; on mount
and on each realtime insert for this channel → `api.channels.markRead(channelId)` (debounced 1 s).

`ChatInterface` new props:

```ts
fixedChannelId?: string; fixedChannelKind?: 'channel'|'dm';
```

When set: skip `loadChannels()` auto-selection; set `selectedChannel`/`selectedDM` from props;
do not render the WA tab bar or the terminal tab/channel pills; voice UI untouched. All realtime,
optimistic-send and queue logic is unchanged.

Terminal variant: no UI change; `team` channels appear in its channel pills because the list
endpoint returns them.

### 2.7 Edge cases

- Player not yet assigned to a team → no `team` group; list shows org-wide channels only.
- Trainer → sees every `team` group and Trainer Channel; `member_count` includes the trainer.
- `session_teams` reassignment mid-session → next list load reflects it; open conversation for a
  team the player just left: next `POST /messages` → 403 → UI shows "You are no longer a member"
  and returns to the list.
- Legacy sessions created before 198 → self-heal creates team channels on first list call.

**Done when:** a Procurement player opens TeamChat and sees Procurement (3 members), All Teams,
Command, Public; a Sales player cannot see Procurement, cannot fetch or post to it (403), cannot
join its WS room, and receives none of its rows over Realtime; unread badges clear on open; the
trainer sees every group; desktop window shows the same UI.

---

## 3. Stakeholder runtime

### 3.1 `server/services/stakeholderService.ts` (new) + contacts API

```ts
export async function getStakeholders(scenarioId: string): Promise<Stakeholder[]>;
// initial_state.stakeholders → StakeholderSchema.safeParse per record (skip invalid, logger.warn with id/index) → scenarioCache (updated_at-keyed)
// Schema is non-strict: unknown keys are preserved; `latent_grievances` (contract §7A) is typed optional and kept intact.
export async function hasStakeholderBlock(scenarioId: string): Promise<boolean>;
export async function getVisibleStakeholders(
  sessionId: string,
  userId: string,
  opts?: { asTrainer?: boolean },
): Promise<Stakeholder[]>;
// identity → filter isStakeholderVisibleToTeam; asTrainer → all. No identity (unassigned player) → [] (plus fallback below)
export async function findByEmail(scenarioId: string, email: string): Promise<Stakeholder | null>;
export async function findByHandle(scenarioId: string, handle: string): Promise<Stakeholder | null>;
export async function findById(scenarioId: string, id: string): Promise<Stakeholder | null>;
export async function getFallbackContacts(
  sessionId: string,
  userId: string,
): Promise<PlayerVisibleStakeholder[]>;
// used only when !hasStakeholderBlock: distinct inbound inject email senders (sim_emails.inject_id not null) joined to
// scenario_injects.delivery_config → relationship = email_category ∈ {verified_facts, sitrep_request} ? 'internal' : 'other';
// owning_team = delivery_config.stakeholder_team ?? '*'; visible if '*' or equals caller's function/team; id = `fallback:${from_address}`
```

**`GET /social/contacts/session/:sessionId`** → workbook

```ts
{ data: {
    team: { team_name: string; function_key: string | null } | null;
    org: { org_key: string; display_name: string; country: string | null } | null;
    is_trainer: boolean;
    sheets: Array<{ relationship: StakeholderRelationship; label: string;
                    rows: Array<PlayerVisibleStakeholder & { owning_team?: string; org_display?: string }> }>;  // extra cols only for trainer
    source: 'stakeholders' | 'fallback' | 'none';
} }
```

Sheets ordered by `RELATIONSHIP_SHEETS`; empty relationships omitted. Trainer: `?team=&org_key=`
filters, else everything.

**`GET /social/contacts/session/:sessionId/search?q=`** → `{ data: Array<
  { kind: 'player'; id: string; name: string; team_name: string | null; function_key: string | null } |
  { kind: 'stakeholder'; stakeholder: PlayerVisibleStakeholder } > }` — case-insensitive substring
over name / organisation / title / handle / email; excludes the caller; max 25.

**`GET /social/emails/contacts/session/:sessionId`** — source 3 ("key personas") is replaced by
visible stakeholders when `hasStakeholderBlock`; otherwise unchanged.

### 3.2 Workbook app — `frontend/src/components/SimDevice/SheetsApp/`

```
SheetsApp/
  SheetsApp.tsx      export function SheetsApp({ variant }: { variant: 'mobile'|'desktop' }); SheetsAppMobile; SheetsAppDesktop
  SheetsGrid.tsx     read-only grid
  SheetTabs.tsx      bottom (mobile) / top (desktop) tabs
  types.ts           ContactsWorkbook (= §3.1 response), ContactRow
  sheets.css
```

Registration: `main.tsx` route `contacts` → `SheetsAppMobile`; `DesktopShell.APP_REGISTRY.contacts`
`{ title: 'Contacts', iconImg: '/icons/icon-sheets.svg', component: SheetsAppDesktop, defaultWidth: 980, defaultHeight: 620 }`;
`HomeScreen` tile `{ id: 'contacts', label: 'Contacts', icon: '/icons/icon-sheets.svg', path: 'contacts' }`;
new asset `frontend/public/icons/icon-sheets.svg` (green spreadsheet glyph, matches `icon-docs.svg` style).

Grid: columns `Name · Title · Organisation · Email · Phone · Chat · Notes`; frozen header row and
row numbers; column widths fixed per column (Notes flexible); single-cell selection highlight;
horizontal scroll on mobile. Title bar: `"{team_name} contacts"` + `" — {org.display_name}"` when
`org` present and the registry has >1 protagonist org. File name shown as
`Contacts_{function_key||team_name}.xlsx`.

Cell actions (tap on mobile, click on desktop): Email → `navigate('/sim/:id/device/email?compose_to=' + encodeURIComponent(email))`
(desktop: open Mail window with the same query via a new `openApp(appId, query)` in `DesktopShell`);
Chat → `POST /channels/session/:id/npc-dm` then open TeamChat at that channel; Phone → copy to
clipboard + toast "Copied".

`EmailApp`: on mount read `compose_to` from `useLocation().search`; if present → `setComposing(true)`,
`setToChips(dedupeAddresses([compose_to]))`, then `navigate(pathname, { replace: true })` to strip it.

Empty states: `source: 'none'` → "No contacts file for your team yet."; unassigned player → "Join a
team to receive your contacts file." Trainer variant adds `Owning team` and `Organisation (org)`
columns and a team/org filter bar.

### 3.3 Migration `199_npc_chat.sql` + TeamChat NPC DMs

```sql
ALTER TABLE chat_messages ALTER COLUMN sender_id DROP NOT NULL;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS sender_stakeholder_id TEXT;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS sender_display_name TEXT;
ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_sender_present
  CHECK (sender_id IS NOT NULL OR sender_stakeholder_id IS NOT NULL);
```

**`POST /channels/session/:sessionId/npc-dm`** body `{ stakeholder_id }` →
`201/200 { data: { id, type: 'npc_direct', stakeholder: PlayerVisibleStakeholder, members: [userId] } }`;
`404` if the stakeholder is not visible to the caller (never reveal existence). Create-or-get on
`(session_id, stakeholder_id, members ? userId)`; `name = stakeholder.name`.

`POST /channels/:channelId/messages` on `npc_direct`: after the normal insert →
`player_actions` insert `{ session_id, player_id: user.id, action_type: 'dm_sent', target_id: channelId, content, metadata: { channel: 'teamchat', stakeholder_id, stakeholder_name } }`
→ `void stakeholderReplyService.handlePlayerMessage({ sessionId, stakeholder, channel: 'teamchat', userId, teamIdentity, content, refTable: 'chat_messages', refId })`.

NPC reply persistence (inside the reply service's teamchat adapter): insert
`{ channel_id, session_id, sender_id: null, sender_stakeholder_id, sender_display_name: stakeholder.name, content, type: 'text' }`
after `delay_seconds` (clamped 5–45 for chat) → `getWebSocketService().messageSent(channelId, row)`
→ `createNotification({ userId, type: 'chat_message', title: stakeholder.name, message: content.slice(0,100), metadata: { channel_id, channel_type: 'npc_direct', stakeholder_id } })`.

Messages `GET`: rows with `sender_stakeholder_id` get `sender = { id: 'stk:'+sender_stakeholder_id, full_name: sender_display_name, role: 'npc' }`.
`ChatInterface.handleRealtimeMessage` / `createMessage`: if `payload.sender_stakeholder_id` → build
the same `sender` object and skip participant lookups (payload type gains the two optional fields).

Search (§2.6 list screen): when `q.length >= 2` call `/contacts/session/:id/search`; results
render under "Contacts" below matching chats; player → `createDM`; stakeholder → `npc-dm`; then
open the conversation.

### 3.4 Migration `200_stakeholder_conversations.sql` + `stakeholderReplyService.ts`

```sql
CREATE TABLE IF NOT EXISTS stakeholder_conversations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  stakeholder_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email','teamchat','messenger','phone')),
  direction TEXT NOT NULL CHECK (direction IN ('player','npc')),
  user_id UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  team_name TEXT, function_key TEXT, org_key TEXT,
  content TEXT NOT NULL,
  ref_table TEXT, ref_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_stk_conv_lookup ON stakeholder_conversations(session_id, stakeholder_id, created_at);
```

```ts
// server/services/stakeholderReplyService.ts
export interface PlayerMessageCtx {
  sessionId;
  stakeholder: Stakeholder;
  channel: 'email' | 'teamchat' | 'messenger';
  userId;
  teamIdentity: TeamIdentity | null;
  content: string;
  subject?: string;
  refTable: string;
  refId: string;
}
export interface ReplyPlan {
  should_reply: boolean;
  text: string;
  subject?: string;
  delay_seconds: number;
}
export async function handlePlayerMessage(ctx: PlayerMessageCtx): Promise<ReplyPlan>;
// 1. append player row to stakeholder_conversations
// 2. pending = reconsideration.getPendingInjects(sessionId, stakeholder.id)
// 3. one LLM call (§3.5 contract) → reply + verdicts; verdicts stored by reconsiderationService
// 4. append npc row (if should_reply); return plan — the CALLER persists in its channel table
export function buildCharacterPrompt(
  s: Stakeholder,
  log: ConversationRow[],
  scenarioCtx: { description; org_name; fact_sheet },
): string;
// hidden fields + knowledge/will_not_disclose + existing anti-coaching & sender-realism rules (verbatim from npcEmailReplyService) + the log (last 20 rows, all channels)
```

Channel adapters (callers):

| Channel   | Hook point                                                                                                                                                                                                                                                                                                                                                                                   | Persist reply as                                |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| email     | `npcEmailReplyService.triggerNPCEmailReply`: after the anti-loop guards and before Step 1, `const stk = await findByEmail(scenarioId, toAddress)`; if found → `handlePlayerMessage` and skip Steps 1–3 and the OpenAI call; media publication logic still runs when `stk.relationship === 'media'` using the returned text as the reply body (article generation stays in the email service) | existing `sim_emails` insert (unchanged fields) |
| messenger | `npcMessengerService.triggerNPCDMReply`: after `npc = personas.find(...)`, `const stk = await findByHandle(...)`; if found → `handlePlayerMessage`                                                                                                                                                                                                                                           | existing `sim_direct_messages` insert           |
| teamchat  | §3.3                                                                                                                                                                                                                                                                                                                                                                                         | `chat_messages` NPC row                         |

Rate limits (per session): existing email guards stay; new: ≤ 1 verdict call per stakeholder per
45 s (later messages inside the window are appended to the log and folded into the next call);
≤ 30 stakeholder calls per 10 min; `env.enableStakeholderEngine` (default `true`) short-circuits
to the legacy paths.

### 3.5 Migration `201_inject_verdicts.sql` + `stakeholderReconsiderationService.ts`

```sql
CREATE TABLE IF NOT EXISTS inject_verdicts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  inject_id UUID NOT NULL REFERENCES scenario_injects(id) ON DELETE CASCADE,
  stakeholder_id TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('keep','modify','delay','cancel')),
  reason TEXT NOT NULL,
  criteria_met JSONB NOT NULL DEFAULT '[]',
  modified_content TEXT, delay_minutes INTEGER,
  credited_team TEXT, contributing_teams TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inject_verdicts_latest ON inject_verdicts(session_id, inject_id, created_at DESC);

ALTER TABLE session_events DROP CONSTRAINT IF EXISTS session_events_event_type_check;
ALTER TABLE session_events ADD CONSTRAINT session_events_event_type_check CHECK (event_type IN (
  /* full list from migration 190 */ 'decision','decision_executed','inject','inject_cancelled','ai_step_start','ai_step_end',
  'communication','resource_change','status_update','incident','media_post','message','bomb_squad_sweep',
  'patient_queue_processed','hazard_queue_processed','quality_failure_inject_fired','zone_skip_violation',
  'friction_inject_fired','state_effect_managed','direction_intent',
  'inject_modified','inject_delayed','stakeholder_verdict'));
```

```ts
export interface PendingInject {
  id;
  title;
  content;
  type;
  trigger_time_minutes: number | null;
  delivery_config: Record<string, unknown>;
}
export async function getPendingInjects(
  sessionId: string,
  stakeholderId: string,
): Promise<PendingInject[]>;
// scenario_injects where delivery_config->>'stakeholder_id' = $id AND (session_id IS NULL OR session_id = $session)
// minus ids with session_events 'inject' or 'inject_cancelled' in this session
export async function decideAndReply(
  ctx: PlayerMessageCtx,
  pending: PendingInject[],
  log: ConversationRow[],
): Promise<{ plan: ReplyPlan; verdicts: StoredVerdict[] }>;
export async function decideAtFireTime(
  sessionId: string,
  inject: PendingInject,
): Promise<
  | { action: 'publish' }
  | { action: 'skip'; reason: 'cancelled' | 'delayed' }
  | { action: 'publish_modified'; injectId: string }
>;
```

**LLM contract** (`gpt-5.2`, `response_format: json_object`, temperature 0.6):

System prompt sections: character (`buildCharacterPrompt`), the hidden reconsideration model
(`grievance`, `resolution_criteria` numbered, `persuadability`, `hard_constraints`), the allowed
verdict set for this persuadability (from `ALLOWED_VERDICTS`), the pending injects (id, title,
content, app, fires at T+N), the full cross-channel log, the fact sheet. Rules: a criterion counts
as met only if the players' messages **contain or achieve** it; "please hold off" alone meets
nothing; `cancel` only when the threshold is met; `modify` keeps the same subject and register;
never reveal criteria or the scheduled inject in the reply; reply length by channel (chat 1–3
sentences, email 2–6, messenger 1–3).

Output:

```json
{
  "should_reply": true,
  "reply": { "text": "...", "subject": "RE: ...", "delay_seconds": 30 },
  "verdicts": [
    {
      "inject_id": "...",
      "verdict": "keep|modify|delay|cancel",
      "reason": "...",
      "criteria_met": [1, 3],
      "modified_content": "...",
      "delay_minutes": 10
    }
  ]
}
```

Server-side enforcement (never trust the model): verdict ∉ `ALLOWED_VERDICTS[p]` → downgrade
(`cancel`→`modify` if `modified_content` else `keep`; `delay`→`keep`); `cancel` with
`criteria_met.length < criteriaThreshold(p, criteria.length)` → downgrade the same way;
`delay_minutes` clamped 1–`MAX_DELAY_MINUTES`; `modify` with empty content or > 2× original length
→ `keep`; `hard_constraints` non-empty and verdict `cancel` → `modify`. Unknown `inject_id` →
dropped. Result rows inserted into `inject_verdicts` with `credited_team = ctx.teamIdentity?.team_name`,
`contributing_teams = distinct team_name in log`. Event `stakeholder_verdict` per inject with the
row as metadata (trainer visibility even when the verdict is `keep`).

**Scheduler hook** (`injectSchedulerService.processSession`, both the time-based and the
condition-driven publish paths, via `publishWithStakeholderGate(inject, session)`):

```
if (!inject.delivery_config?.stakeholder_id) → existing gates → publish
else:
  d = decideAtFireTime(session.id, inject)
    latest = newest inject_verdicts row for (session, inject)
    if none and log has ≥1 player row for this stakeholder → verdict-only LLM call (no reply) → store → latest
    if none → { publish }                                   // never contacted: fire as authored, skip generic gate
    cancel  → insert session_events 'inject_cancelled' { inject_id, stakeholder_id, reason, credited_team, criteria_met, source:'stakeholder' }
               + updateTeamHeatMeter(session.id, credited_team, 'good') → { skip:'cancelled' }
    delay   → if elapsed < trigger_time_minutes + delay_minutes → insert 'inject_delayed' once (dedupe on metadata.inject_id) → { skip:'delayed' }
               else → { publish }
    modify  → insert runtime copy into scenario_injects { ...inject, id: new, session_id, content: modified_content,
                 delivery_config: { ...cfg, modified_from: inject.id }, ai_generated: true, generation_source: 'stakeholder_modified' }
               + 'inject_cancelled' for original { reason:'modified', ... } + 'inject_modified' { original_id, new_id, ... }
               + heat credit → { publish_modified: newId }
    keep    → { publish }
  stakeholder injects with any verdict skip shouldCancelSocialInject / runAiCancellationGate (no double judgment)
```

Unresolvable `stakeholder_id` → `logger.warn` and the existing path (contract §4 rule 4).

### 3.6 Surfacing

- Trainer timeline (`TrainerSimDashboard.tsx`): fetch `/api/sessions/:id/events?event_type=inject_cancelled,inject_modified,inject_delayed,stakeholder_verdict`
  (extend the `event_type` filter in `routes/sessions.ts` to accept a comma-separated list) and
  render rows "T+12 · Sales · Meridian Logistics: complaint post withdrawn — criteria 1,2,3 met".
- AAR: `aarSocialMediaService.buildSocialMediaAARData` adds
  `stakeholder_preemption: Array<{ team: string; stakeholder_name: string; inject_title: string; verdict: Verdict; at_minute: number; reason: string }>`;
  the AAR section renderer gets a "Stakeholder pre-emption" block per team.
- Scoring: heat-meter credit only (existing path). No new score tables.

### 3.7 Edge cases

- Email with several `to_addresses` → stakeholder matched on `to_addresses[0]` only (existing
  rule); CC'd stakeholders are logged as recipients in the conversation table but do not reply.
- Two players message the same stakeholder within the 45 s window → one call sees both messages;
  `credited_team` = first triggering team, `contributing_teams` = both.
- Verdict flips: latest row wins until the inject fires; an executed `cancel` is final.
- Modified copy's `trigger_time_minutes` = original (fires immediately on the same tick).
- No `OPENAI_API_KEY` or engine disabled → `keep`, reply falls back to legacy improvisation paths.
- Player messages after the inject already fired → normal in-character reply; no verdicts.
- Common stakeholder contacted by two orgs → one log, one verdict per inject.

**Done when:** with a generated scenario carrying a `stakeholders` block — the Sales workbook
shows only Sales contacts under Clients/Suppliers tabs; Jasmine Tan is found via TeamChat search;
her DM reply references the email sent to her 5 minutes earlier; meeting her three criteria
yields `cancel` for the T+15 email and `modify` for the T+32 post (visible on the trainer
timeline and in the AAR); the FSA notice fires regardless with softened tone when Legal filed the
report; a scenario without the block behaves exactly as today.

---

## 4. Multi-org readers

### 4.1 `delivery_config.org_key` delivery routing

`feedEngineService.resolveInjectTargeting(sessionId, inject_scope, target_teams)` gains a fourth
argument `orgKey?: string`; when present, `playerIds = (playerIds ?? allParticipants) ∩ getOrgMemberUserIds(sessionId, orgKey)`.
`routeInjectToApp` passes `config.org_key`. Effects: email (`recipient_user_ids`), `phone_call`
(`emitScoped`), `group_chat` — with `org_key`, post into each `team` channel whose team's `org_key`
matches instead of the session-wide channel by type. Empty intersection → log and skip (existing
behaviour for empty targeting).

### 4.2 Migration `202_content_country.sql` + country-scoped feed/News

```sql
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS country TEXT;
ALTER TABLE sim_news_articles ADD COLUMN IF NOT EXISTS country TEXT;
CREATE INDEX IF NOT EXISTS idx_social_posts_country ON social_posts(session_id, country);
CREATE INDEX IF NOT EXISTS idx_news_country ON sim_news_articles(session_id, country);
```

- Stamp on publish from `delivery_config.country` (`routeToSocialFeed`, `routeToNews`).
- Inheritance: every insert into `social_posts` with `reply_to_post_id`/`original_post_id` copies
  the parent's `country` (helper `inheritCountry(parentId)` in `feedEngineService`, used by
  `npcReactionService`, `engagementAlgorithmService`, `extremistHiveService`,
  `antagonistEngineService`, `ambientContentService`); persona-originated posts use
  `persona.country ?? null`.
- Page-originated posts: `antagonistEngineService` (`official_account` inserts at ~252 and ~497),
  the ally engine when it exists, and player page posts (`routes/socialMedia.ts` post creation when
  `posted_as_page`) are stamped with `orgCountryForPage(sessionId, pageHandleOrOrgKey)` =
  `org_page.orgs[].org_key → orgs[].country` via `orgRegistryService`. Without this a rival
  tabloid page in country X would appear in country Y's feed.
- `GET /social/posts/session/:id`, `GET /social/news/session/:id`: `mine = getUserCountry(...)`;
  non-trainer → `.or('country.is.null,country.eq.' + mine)` (when `mine` is null → no filter);
  trainer → optional `?country=`.
- Frontend: players unchanged; trainer feed/News views get a country `<select>` fed by
  `GET /sessions/:id/orgs` (§4.4).

### 4.3 Persona pool by country

`orgRegistryService.selectPersonaPool(personas, country: string | null)` → personas with
`!p.country || p.country === country`; if the result has fewer than 5 entries, return all
(starvation guard). Applied where a reacting/replying persona is chosen in the six engines above
(target = parent post's country) and in `npcMessengerService.triggerNPCMessages` (target = the
recipient player's org country).

### 4.4 Lobby and trainer dashboard

**`GET /sessions/:sessionId/orgs`** → `{ data: { orgs: Array<OrgRegistryEntry & { teams: Array<{ team_name; function_key; member_count }> }>, countries: CountryEntry[] } }`.
Team-assignment UI (consumer of `routes/teams.ts`) groups teams under their org with country
badges when `orgs.length > 1`; `TrainerSimDashboard` adds an org/country selector that scopes the
feed/News views (metrics remain session-global — per-org scoring is deferred).

**Done when:** in a two-org, two-country fixture — an email with `org_key: A` reaches only A's
members; a post with `country: X` is absent from Y's feed and present for the trainer with the
selector on X; reactions to it come only from X personas; the lobby lists teams under their org;
a single-org scenario shows no difference anywhere.

---

## Cross-cutting

**Migrations (runtime):** 198 team channels + RLS + reads → 199 npc chat → 200 conversations →
201 verdicts + events CHECK → 202 content country → 203 decision layer. Generator: 197
(`scenario_teams`).

**New env:** `ENABLE_STAKEHOLDER_ENGINE` (default `true`) → `env.enableStakeholderEngine`.

**Client API additions (`frontend/src/lib/api.ts`):** `channels.getMembers`, `channels.markRead`,
`channels.createNpcDM`, `social.contactsWorkbook`, `social.contactsSearch`, `sessions.orgs`.

**Tests:** vitest unit tests for `stakeholderContract.ts` (0.1) and for verdict enforcement
(`downgradeVerdict` table); integration smoke via a fixture scenario JSON kept under `/tmp`
during development (single-org; common stakeholder across composed teams; two countries);
manual E2E on phone and desktop for each "Done when".

**Dependencies on the generator agent:** imports `stakeholderContract.ts`; migration 197 before
§3 is tested; two compiled fixtures in the shared DB for E2E — the multi-org kidnapping scenario
(two countries, common + org-specific stakeholders, tagged injects/personas) for §3–§4, and the
Dyson decision-layer scenario for §5 if approved.

**Dormancy guard (ships with §3.5, removed by §5.4):** until the decision primitives exist, when
a session's scenario contains injects whose `conditions_to_appear` use `decision_recorded:*` /
`inject_published:*` / `inject_cancelled:*`, log `decision_layer_inert` once per session
(`Set<sessionId>` in the scheduler process). Unknown primitives already evaluate to `false`.

**Client API additions for §5:** `sessions.decisionSpace`, `sessions.recordDecision`,
`sessions.listDecisions`.

---

## 5. Decision layer — RETIRED (menu-based; removed 2026-09-20)

**This workstream was built and then removed the same day.** The product owner rejected the
menu-based model (executives picking pre-authored options in a Decisions app) in favour of an
organic one where executives decide by communicating and the consequences are generated at
runtime. The replacement is specified in **`docs/executive-decisions-organic-handover.md`** and is
owned end to end by the generator agent.

What was removed from the runtime: `decisionEngineService.ts`; `GET /sessions/:id/decision-space`,
`POST/GET /sessions/:id/decisions`; the Decisions app (mobile route, desktop window, home tile,
notification deep link, icon); the `decision_recorded:*` primitive; latent-grievance swapping in
`getEffectiveGrievance`; `markObligationsMet` / `lapseObligations`; `triggered_by_decision_key`
SOP clocks (steps carrying it are now skipped); the dashboard "Executive Decisions" card; the AAR
`leadership_decisions` data and block.

What was kept: migration 203 (tables `session_decisions`, `stakeholder_state`,
`decision_obligations` — empty, unused; the `decision_recorded` action type and the
`decision_recorded` / `obligation_met` / `obligation_lapsed` event types), the generic
`inject_published:*` / `inject_cancelled:*` primitives, the Executive team identity and its AAR
section, and a new `registerGrievanceOverrideResolver()` hook in
`stakeholderReconsiderationService` for the new engine to plug into.

The original §5.1–5.7 text is preserved below for reference only.

<details>
<summary>Original §5 (historical)</summary>

C-suite join as players in an **Executive** team (`function_key: "Executive"`, ≤ 1 per org) and
record business decisions whose SOP consequences toward stakeholders the scenario guarantees.
**Optional mode:** active only when the scenario has `initial_state.decision_space[]`; otherwise no
Executive team exists and nothing here runs. Depends on §3.4–3.5 (conversation log,
reconsideration engine) and §4.2 (country stamping, for per-country spillover). Fixture: the
generator's Dyson scenario.

### 5.1 Migration `203_decision_layer.sql`

```sql
-- player_actions vocabulary (re-assert the full list from migration 196 + new value)
ALTER TABLE player_actions DROP CONSTRAINT IF EXISTS player_actions_action_type_check;
ALTER TABLE player_actions ADD CONSTRAINT player_actions_action_type_check CHECK (action_type IN (
  /* list from 196 */ 'post_created','reply_posted','post_liked','post_reposted','post_flagged','post_reported','dm_sent','dm_read',
  'email_sent','email_read','call_answered','call_declined','news_read','fact_checked','draft_created','draft_submitted_for_approval',
  'draft_approved','draft_published','escalated','chat_message_sent','content_graded','misinfo_flagged','group_post_created',
  'group_joined','event_created','event_responded','event_discussed','dispute_filed','dispute_upheld','dispute_rejected','intel_shared',
  'decision_recorded'));

CREATE TABLE IF NOT EXISTS session_decisions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  org_key TEXT NOT NULL,
  decision_key TEXT NOT NULL,
  recorded_by UUID NOT NULL REFERENCES user_profiles(id),
  team_name TEXT NOT NULL,
  scope TEXT, rationale TEXT,
  effective_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recorded_at_minute INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (session_id, org_key, decision_key)
);

CREATE TABLE IF NOT EXISTS stakeholder_state (
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  stakeholder_id TEXT NOT NULL,
  active_decision_key TEXT,                 -- null = base grievance
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (session_id, stakeholder_id)
);

CREATE TABLE IF NOT EXISTS decision_obligations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  decision_id UUID NOT NULL REFERENCES session_decisions(id) ON DELETE CASCADE,
  stakeholder_id TEXT NOT NULL,
  by_function TEXT NOT NULL,
  description TEXT NOT NULL,
  due_at_minute INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','met','lapsed')),
  met_by_user_id UUID, met_at TIMESTAMPTZ,
  UNIQUE (decision_id, stakeholder_id, by_function)
);

-- session_events: re-assert list from 201 + 'decision_recorded', 'obligation_met', 'obligation_lapsed'
```

`teamCharterService` detectable-action vocabulary gains `decision_recorded` (the Executive charter
comes from the generator with today's vocabulary; this only lets future charters detect the
decision itself).

### 5.2 `server/services/decisionEngineService.ts` (new)

```ts
export async function getDecisionSpace(scenarioId: string): Promise<DecisionOption[]>; // initial_state.decision_space, validated, scenarioCache
export async function canRecord(
  sessionId: string,
  userId: string,
  decisionKey: string,
): Promise<
  | { ok: true; identity: TeamIdentity; option: DecisionOption }
  | { ok: false; status: 403 | 404; error: string }
>;
// identity.function_key === 'Executive' && identity.org_key ∈ option.decidable_by_org_keys; 409 if already recorded for that org
export async function recordDecision(
  sessionId: string,
  userId: string,
  input: { decision_key; scope?; rationale?; effective_at? },
): Promise<SessionDecision>;
// 1. insert session_decisions (recorded_at_minute = elapsed)
// 2. player_actions { action_type:'decision_recorded', target_id: decision.id, content: title, metadata:{ decision_key, org_key, severity } }
// 3. session_events 'decision_recorded' { decision_id, decision_key, org_key, team_name, severity }
// 4. arm(sessionId, decision, option)
// 5. broadcast 'decision.recorded' to getOrgMemberUserIds(sessionId, org_key) (emitScoped) — private to the org
export async function arm(
  sessionId: string,
  decision: SessionDecision,
  option: DecisionOption,
): Promise<void>;
// a) obligations: one decision_obligations row per (sop_obligations[i], owed_to_stakeholder_id), due_at_minute = recorded_at_minute + window_minutes
// b) stakeholder_state upsert active_decision_key for every stakeholder that has latent_grievances[decision_key]
// c) eruption templates: scenario_injects where delivery_config->>'inject_key' ∈ option.eruption_inject_keys AND session_id IS NULL
//    → runtime copy { session_id, eligible_after_minutes: recorded_at_minute + max(window_minutes owed to that template's stakeholder_id, else min window),
//                     conditions_to_appear preserved, generation_source: 'decision_eruption', delivery_config: { ...cfg, armed_by_decision_id } }
// d) spillover templates are NOT copied here; they remain condition-driven on inject_published:<key> and fire per country through the normal loop
export async function listDecisions(
  sessionId: string,
): Promise<Array<SessionDecision & { obligations: DecisionObligation[] }>>;
```

Reconsideration integration: `stakeholderService.getEffectiveGrievance(sessionId, stakeholder)` →
`stakeholder_state.active_decision_key ? stakeholder.latent_grievances[key] : base fields`.
`stakeholderReplyService` / `stakeholderReconsiderationService` call this instead of reading the
base fields directly (one-line change in each), so eruption injects are judged with the latent
grievance/criteria/persuadability, unchanged otherwise.

### 5.3 Endpoints

**`GET /sessions/:sessionId/decision-space`** → `{ data: { options: Array<DecisionOption & { recorded: SessionDecision | null; decidable: boolean }>, chain_of_command: ChainOfCommandLink[] } }` — Executive players of an org see options with `decidable = org_key ∈ decidable_by_org_keys`; other players get `403`; trainer gets all with `decidable:false`.

**`POST /sessions/:sessionId/decisions`** body `{ decision_key: string; scope?: string; rationale?: string; effective_at?: string }` → `201 { data: SessionDecision }`; `403` not Executive / wrong org; `409` already recorded.

**`GET /sessions/:sessionId/decisions`** → `{ data: Array<SessionDecision & { obligations: DecisionObligation[] }> }` — org members see their org's; trainer sees all.

### 5.4 Condition primitives (`conditionEvaluatorService.conditionRegistry`)

| Key                                | True when                                                                                                             |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `decision_recorded:<decision_key>` | a `session_decisions` row exists for the session (any org) with that key                                              |
| `inject_published:<inject_key>`    | any inject whose `delivery_config->>'inject_key'` equals the key is in the scheduler's published set for this session |
| `inject_cancelled:<inject_key>`    | same, against the cancelled set                                                                                       |

`inject_key → inject ids` resolved once per tick via `scenarioCache`. The evaluator context gains
`publishedInjectIds` / `cancelledInjectIds` (the scheduler already computes both sets — pass them
in). Dormancy guard from the cross-cutting section is replaced by the real primitives.

### 5.5 Obligation tracking (`sopCheckerService` + conversation log)

- On every `stakeholder_conversations` player row insert: mark open `decision_obligations` for
  `(stakeholder_id, by_function = writer's function_key)` as `met` if `elapsed <= due_at_minute`;
  event `obligation_met`.
- Scheduler tick: open obligations with `due_at_minute < elapsed` → `lapsed`; event
  `obligation_lapsed { decision_id, stakeholder_id, by_function }`; `updateTeamHeatMeter(session,
owingTeam, 'bad')` for the team(s) whose function owed it (owing team = teams with that
  `function_key` in the decision's org).
- `evaluateSOPCompliance`: decision-triggered steps (`sop_definitions.steps[].triggered_by_decision_key`,
  written by the generator) are ignored until the decision is recorded, then evaluated like normal
  steps with their clock starting at `recorded_at_minute`.

### 5.6 UI

- **Executive device entry** — `frontend/src/components/SimDevice/DecisionsApp/` (mobile +
  desktop, same pattern as SheetsApp): list of options from `/decision-space` with severity,
  affected orgs, obligations preview; "Record decision" form (scope, rationale, effective date);
  recorded decisions with live obligation status. Home tile and `APP_REGISTRY` entry shown only
  when the player's `function_key === 'Executive'` and the scenario has a decision space.
- **Org broadcast** — `decision.recorded` WS event → DeviceShell notification (appId `decisions`)
  for that org's members; TeamChat system message in the org's `team` channels
  ("Executive decision recorded: <title> — obligations due T+N").
- **Trainer dashboard** — decision log (org, decision, who, when) with per-obligation status
  chips (open / met / lapsed) and links to the resulting eruption injects.
- **AAR** — "Leadership decisions" section: each decision, who recorded it, who was informed
  (`chain_of_command` vs. actual org broadcast + TeamChat/email traffic from the conversation log),
  obligations met/lapsed, eruptions fired/cancelled/modified.

### 5.7 Edge cases

- Two Executive players in the same org → first record wins (`UNIQUE`), second gets `409` with
  the existing decision.
- Decision recorded after an eruption template's stakeholder already has an executed `cancel`
  on a base inject → unaffected; eruptions are separate injects.
- `latent_grievances[key]` missing for an affected stakeholder → stakeholder keeps base grievance;
  obligations still tracked.
- Scenario has `decision_space[]` but no Executive team assigned → options exist, nobody can
  record; trainer may record on an org's behalf (`?as_org_key=`, logged as trainer action).
- Session without `decision_space[]` → endpoints return `404 decision_layer_not_enabled`; no
  tile, no primitives evaluated.

**Done when:** on the Dyson fixture an Executive player records a decision; their org's members
get the broadcast and TeamChat notice; obligations appear with due times; a Sales player emailing
the owed client marks the obligation met and the client's eruption inject (judged against the
latent grievance) is cancelled at fire time; an unmet obligation lapses on schedule, fires the
eruption, and the trainer log + AAR show the chain; a scenario without a decision space shows no
Decisions tile and no behaviour change.

Deferred inside §5: AI-run executives for unstaffed orgs; decision reversal; board / regulator
escalation ladders; per-org metrics.

</details>

---

## Implementation status (2026-09-20)

Workstreams 0–4 are coded and live (migrations 197–204 applied to production, merged to
`master`); server and frontend typecheck clean; `stakeholderContract` unit tests pass (16 cases).
Workstream 5 was coded, then retired and removed the same day (see §5); its database objects
(migration 203) remain in place, empty. Still pending: end-to-end runs against the generator's
kidnapping fixture.

**Contract v3.2 acknowledgement (2026-09-20).** The generator agent added the additive v3.2
fields to `stakeholderContract.ts` (stakeholder `kind / members / tier / site_key / sensitivities /
page_org_key`; registry `side: 'pressure'`, pressure kinds, `spokesperson_stakeholder_id`,
`operation`, `sites[]`) and shipped migration 205 (pressure pages, decision ledger detail,
`decision_knowledge`, `decision_events`, new event types) — applied by the runtime agent. Runtime
readers added the same day, closing handover §10.5 R1–R3: `server/lib/stakeholderRecipients.ts`
(`resolveStakeholderRecipients`, `pickResponders`, tested) and the multi-recipient rewrite of
`triggerNPCEmailReply`; `stakeholderReplyService.appendPlayerMessage`, `resolveContext`,
`registerStakeholderContextProvider`, `PlayerMessageCtx.context`; roster sheet + group badges in
the contacts workbook and Mail autocomplete; `PLAYER_VISIBLE_FIELDS` extended (`sensitivities`
hidden). Migration 206 widened `scenario_injects.generation_source` for four values the server
already wrote (`stakeholder_modified` was the W3.5 `modify` path failing silently).

Deviations from the spec above, all deliberate:

- **§4.2 country inheritance is a DB trigger** (`social_posts_inherit_country`, migration 202)
  rather than a per-service `inheritCountry()` helper, so every engine that inserts a reply or
  repost is covered without touching six files. Persona-originated top-level posts are stamped
  in `ambientContentService.insertPost` from the persona registry; page posts in
  `antagonistEngineService` and the player post route via `orgCountryForPage` / `getUserCountry`.
- **§4.3 persona pool** is applied where personas are actually _chosen_: ambient thread
  continuation and `npcReactionService`. `engagementAlgorithmService` only reads follower
  counts, `extremistHiveService` uses the fixed doctrine cell, and `triggerNPCMessages`
  generates DMs for all players in one call — none of these select a persona per country, so
  they were left unchanged.
- **§3.4 media stakeholders** keep the legacy email path because it owns article publication;
  the stakeholder record seeds the respondent, and the exchange is still logged and judged for
  verdicts. Non-media stakeholders are answered entirely from the record.
- **§3.6 trainer timeline** required adding `GET /sessions/:id/events` — the dashboard's
  consequence panel had been calling this endpoint although it did not exist.
- **Migration 201 also adds eight event types** the server already inserts but the deployed
  CHECK (migration 190) rejected (`trainer_alert`, `consequence_inject`, `antagonist_post`,
  `antagonist_reply`, `extremist_post`, `extremist_reply`, `director_action`,
  `evaluator_result`). Those inserts had been failing silently.
- **§5 removed** — the deviation notes that used to sit here (lapsed obligations → `prereq`
  heat-meter mistake) no longer apply.
- **Desktop cross-app intents** (Contacts → Mail compose, Contacts → TeamChat DM) use a small
  parked-intent store (`frontend/src/lib/appIntents.ts`) plus a DOM event that makes the desktop
  shell open/remount the target window; on the phone the same intents travel as query params.
- **AAR in multi-org scenarios** (follow-up after the generator agent's audit): team deep-dive
  sections are keyed by function; when several organisations share a function the section carries
  `teams[]` and the frontend renders one tab per organisation's team. Two new sections cover teams
  that previously had no review: `social_team_executive` (leadership, judged from the decisions
  they communicated in email/chat/statements) and `social_team_other` (custom functions, one tab
  per team). The executive
  summary gains an `organisations[]` roll-up (average composite per protagonist org) rendered as an
  "Organisations" comparison beside the team bars. Scoring itself is unchanged: it was already per
  team row, hence per organisation.

## Deferred (agreed, not built now)

- Cross-team visibility of contacts with an "owned by <team>" label.
- Editable workbook: notes, player-added contacts, team-shared edits, export.
- Proactive "cold call" engine; live two-way phone conversations.
- `(org × team)` player identity; per-org scoring and metrics (see `multi-org-coalition-plan.md`).
- Per-notification swipe-away in the expanded list; grouping by app.
- TeamChat: message search, typing indicators, read receipts, attachments.
