# Launch security fix spec

This is the implementation spec for the nine agreed fixes. It does not change the join page, anonymous sign-in, public image links, demo accounts, or guest accounts.

The app server reads and writes the database with the service-role key, which bypasses row-level security. The website also ships the public anon key. The database policies below are what that public key is allowed to do on its own. The server routes are a second door, because a guest login is a valid bearer token.

One new migration, `migrations/218_launch_access_locks.sql`, holds every database change. Application changes are in three existing files.

## Files

| File                                     | Change                                                                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `migrations/218_launch_access_locks.sql` | New. Storage policies, scenario and scene policies, trainer policies, function permissions, notification insert. |
| `server/lib/access.ts`                   | New helpers used by the scenario routes and the microphone route.                                                |
| `server/routes/scenarios.ts`             | `GET /` and `GET /:id` only.                                                                                     |
| `server/routes/ai.ts`                    | `POST /transcribe` only.                                                                                         |
| `server/index.ts`                        | Global rate-limit key only. The `jsonwebtoken` import goes away.                                                 |

No frontend file changes. `HomeScreen` still calls `GET /api/scenarios/:id` and still reads `initial_state.country`.

Left alone on purpose: join routes, anonymous sign-in, `scenario-assets`, `aar-exports`, `rts-scene-images`, captcha, and every account row.

---

## 1. Media bucket

### What the current code does

`migrations/170_sim_media_storage_bucket.sql` creates the `sim-media` bucket as public and adds two policies. The live bucket is still public. Its file size limit has since been raised to 500 MB. This fix must not change the public flag or the size limit.

```sql
CREATE POLICY "Public read access for sim-media"
ON storage.objects FOR SELECT
USING (bucket_id = 'sim-media');

CREATE POLICY "Service role full access for sim-media"
ON storage.objects FOR ALL
USING (bucket_id = 'sim-media')
WITH CHECK (bucket_id = 'sim-media');
```

The first policy lets any caller with the public key list every object in the bucket.

The second policy is named for the service role, but it has no role check. `FOR ALL` means select, insert, update, and delete. In Postgres an empty role list means the policy applies to everyone. The server does not need this policy: the service-role key bypasses row-level security, and `mediaGenerationService`, `chatSurveillanceService`, and `socialCrisisWarroom` upload with that key and then store `getPublicUrl()` on the post.

A public bucket still serves a file to anyone who already has its URL. That is what `<img>` tags in the sim use. Dropping these policies does not blank those images. It stops listing, uploading, overwriting, and deleting through the public key.

### New code

```sql
DROP POLICY IF EXISTS "Public read access for sim-media" ON storage.objects;
DROP POLICY IF EXISTS "Service role full access for sim-media" ON storage.objects;
```

After this, the storage API refuses list, upload, and delete for the anon and authenticated roles. The server keeps uploading because it uses the service-role key. Existing public URLs keep loading because the bucket stays public.

---

## 2. Scenario database rule

### What the current code does

`migrations/002_rls_policies.sql` lets every signed-in user, including an anonymous guest, read every active scenario row. The row includes `insider_knowledge`, `blueprint`, `briefing`, and `role_specific_briefs`.

```sql
CREATE POLICY "Anyone authenticated can view active scenarios"
  ON scenarios FOR SELECT
  USING (is_active = true AND auth.role() = 'authenticated');
```

The browser does not call this table directly. A caller who uses the public anon key against the database API does. The app's own scenario screens go through the server and are covered in section 3.

### New code

```sql
DROP POLICY IF EXISTS "Anyone authenticated can view active scenarios" ON public.scenarios;

CREATE POLICY "Creators and admins can view scenarios"
  ON public.scenarios
  FOR SELECT
  TO authenticated
  USING (
    created_by = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = auth.uid()
        AND up.role = 'admin'
    )
  );
```

A direct read with the public key returns a row only to the person who created it, or to an admin. A guest, a player, and another trainer get no row. Players still receive the scenario through `GET /api/scenarios/:id`, with the field stripping in section 3. Trainers and admins still receive scenarios through that same route, which uses the service-role key and does not consult this policy.

---

## 3. Scenario API

### What the current code does

`GET /api/scenarios` in `server/routes/scenarios.ts` builds one query for everyone, then filters it.

```ts
const isTrainer = user.role === 'trainer' || user.role === 'admin';

let query = supabaseAdmin
  .from('scenarios')
  .select(withSummary ? `${LIST_COLUMNS}, ${SUMMARY_SOURCE_COLUMNS}` : LIST_COLUMNS)
  .order('created_at', { ascending: false });

if (user.role === 'trainer') {
  query = query.eq('created_by', user.id);
} else if (!isTrainer) {
  query = query.eq('is_active', true);
}
```

An admin has no extra filter, so the admin sees every scenario. A trainer sees only rows they created. Anyone else, including a guest who has never joined a session, sees every active scenario. The list columns are the card fields (`title`, `description`, `objectives`, and so on). They do not include `insider_knowledge` or `blueprint`.

`GET /api/scenarios/:id` loads the entire row and then applies one check.

```ts
const { data, error } = await supabaseAdmin.from('scenarios').select('*').eq('id', id).single();

if (user.role !== 'trainer' && user.role !== 'admin' && !data.is_active) {
  return res.status(403).json({ error: 'Access denied' });
}

res.json({ data });
```

Any trainer can open any scenario by id, including another trainer's insider knowledge and blueprint. Any other signed-in user, including a guest, can open any active scenario and receives the full row.

`select('*')` is what the trainer screens need. `ScenarioDetailView`, `TrainerEnvironmentalTruths`, and `WarRoomLegacy` read `insider_knowledge` from this response. `HomeScreen` calls the same route for a player and reads only `initial_state.country`. That field has to stay.

The other scenario routes (`/injects`, `/teams`, `/locations`, and the edit routes) already return 403 unless the caller is a trainer or admin. They are not part of this change. A trainer hitting those routes is still not checked for ownership there. Ownership of edits already goes through `guardScenarioEdit` and `assertScenarioOwner`. This spec does not widen that work.

### New helpers in `server/lib/access.ts`

These sit next to the existing session helpers. They use the same service-role client.

```ts
const FULL_SCENARIO_READER = new Set(['admin']);

export async function sessionTrainerScenarioIds(userId: string): Promise<string[]> {
  const { data } = await supabaseAdmin
    .from('sessions')
    .select('scenario_id')
    .eq('trainer_id', userId);
  return [...new Set((data ?? []).map((row) => row.scenario_id).filter(Boolean))] as string[];
}

export async function joinedScenarioIds(userId: string): Promise<string[]> {
  const { data } = await supabaseAdmin
    .from('session_participants')
    .select('session_id, sessions!inner(scenario_id)')
    .eq('user_id', userId);
  const ids = (data ?? []).map((row) => {
    const session = row.sessions as { scenario_id: string } | { scenario_id: string }[];
    const one = Array.isArray(session) ? session[0] : session;
    return one?.scenario_id;
  });
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
}

export function redactScenarioForPlayer<T extends Record<string, unknown>>(row: T): T {
  const copy = { ...row };
  delete copy.insider_knowledge;
  delete copy.blueprint;
  return copy;
}
```

`sessionTrainerScenarioIds` is the set of scenarios for which this person is the session trainer. That person still needs the ground truth while running the exercise, even when someone else created the scenario.

`joinedScenarioIds` is the set of scenarios for which this person is only a participant.

`redactScenarioForPlayer` removes the two trainer-only documents. `initial_state`, `description`, `briefing`, and the card fields stay, so the player phone can still read the country.

`FULL_SCENARIO_READER` is unused by itself. The route checks `user.role === 'admin'` directly, matching the rest of the file. Do not add it if it has no caller. The three functions above are the ones to add.

### New `GET /`

Replace the filter block. Leave the summary aggregation that follows it unchanged. It already runs on whatever `rows` the query returned.

```ts
const user = req.user!;
const withSummary = req.query.include === 'summary';

let query = supabaseAdmin
  .from('scenarios')
  .select(withSummary ? `${LIST_COLUMNS}, ${SUMMARY_SOURCE_COLUMNS}` : LIST_COLUMNS)
  .order('created_at', { ascending: false });

if (user.role === 'admin') {
  // no extra filter: an admin still sees the whole library
} else if (user.role === 'trainer') {
  query = query.eq('created_by', user.id);
} else {
  const ids = await joinedScenarioIds(user.id);
  if (ids.length === 0) {
    return res.json({ data: [] });
  }
  query = query.in('id', ids);
}
```

A guest who has never joined a session gets an empty list. A player gets the scenarios for sessions they joined, including a completed session whose scenario is no longer marked active. A trainer's library is unchanged. An admin's library is unchanged.

### New `GET /:id`

Keep the `select('*')` load and the 404 handling. Replace the single active-scenario check with this.

```ts
const isAdmin = user.role === 'admin';
const isCreator = data.created_by === user.id && user.role === 'trainer';
const trainsThisScenario =
  user.role === 'trainer' && (await sessionTrainerScenarioIds(user.id)).includes(id);
const playsThisScenario =
  !isAdmin && !isCreator && !trainsThisScenario && (await joinedScenarioIds(user.id)).includes(id);

if (!isAdmin && !isCreator && !trainsThisScenario && !playsThisScenario) {
  return res.status(403).json({ error: 'Access denied' });
}

const payload = playsThisScenario ? redactScenarioForPlayer(data) : data;
res.json({ data: payload });
```

Meaning:

- An admin receives the full row.
- The trainer who created the scenario receives the full row, so scenario editing and insider knowledge stay.
- A trainer who is the `trainer_id` on a session of that scenario receives the full row, so the ground-truth panel still works when they are running someone else's scenario.
- A participant, including an anonymous guest who joined, receives the row without `insider_knowledge` and without `blueprint`. `HomeScreen` still finds `initial_state.country`.
- Everyone else receives 403, including a guest who never joined and a trainer who neither created the scenario nor runs a session of it.

`id` here is the route param, which is the scenario id. `sessionTrainerScenarioIds` and `joinedScenarioIds` return scenario ids, so `.includes(id)` is the right comparison.

---

## 4. Scene configs

### What the current code does

`migrations/163_rts_scene_configs.sql` lets every caller read every scene. The rows hold planted items, casualties, and the blast site.

```sql
CREATE POLICY rts_scene_configs_select ON rts_scene_configs
  FOR SELECT USING (true);
```

Insert, update, and delete are already limited to `created_by = auth.uid()`. The War Room routes load and save scenes with the service-role client, so they do not use this policy.

### New code

```sql
DROP POLICY IF EXISTS rts_scene_configs_select ON public.rts_scene_configs;

CREATE POLICY rts_scene_configs_select
  ON public.rts_scene_configs
  FOR SELECT
  TO authenticated
  USING (
    created_by = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = auth.uid()
        AND up.role = 'admin'
    )
  );
```

The public key can no longer read planted items. The creator and an admin still can. The War Room is unchanged because it uses the service-role key.

---

## 5. Database functions

### What the current code does

These five functions are `SECURITY DEFINER`. They run with the owner's rights and ignore row-level security. Postgres grants execute to `PUBLIC` by default, and the live database still allows the anon role to call them. Nothing in `server/` calls them. The server writes `session_events`, `sentiment_snapshots`, and notifications with the service-role client.

`log_session_event(uuid, text, text, uuid, text, jsonb)` inserts a session event for whatever session id it is given.

`update_sentiment_snapshot(uuid, integer, integer, integer)` inserts a sentiment row for whatever session id it is given.

`get_unread_notification_count(uuid)` returns the unread count for whatever user id it is given.

`process_accepted_invitations_for_user(uuid)` reads that user's email and enrolls them in their accepted invitations.

`is_session_participant(uuid, uuid)` reports whether a user is on a session.

### New code

```sql
REVOKE ALL ON FUNCTION public.log_session_event(uuid, text, text, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_sentiment_snapshot(uuid, integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_unread_notification_count(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.process_accepted_invitations_for_user(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.is_session_participant(uuid, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.log_session_event(uuid, text, text, uuid, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.update_sentiment_snapshot(uuid, integer, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_unread_notification_count(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.process_accepted_invitations_for_user(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.is_session_participant(uuid, uuid) TO service_role;

ALTER FUNCTION public.log_session_event(uuid, text, text, uuid, text, jsonb) SET search_path = public;
ALTER FUNCTION public.update_sentiment_snapshot(uuid, integer, integer, integer) SET search_path = public;
ALTER FUNCTION public.get_unread_notification_count(uuid) SET search_path = public;
ALTER FUNCTION public.process_accepted_invitations_for_user(uuid) SET search_path = public;
ALTER FUNCTION public.is_session_participant(uuid, uuid) SET search_path = public;
```

The anon and authenticated roles can no longer call these functions. `service_role` still can, which is the key the server uses. `search_path = public` keeps a definer function from resolving tables through some other schema. It does not change the function body.

Trigger functions such as `handle_new_user` stay as they are. Signup still creates a profile.

---

## 6. Notifications

### What the current code does

`migrations/029_create_notifications_system.sql` allows any caller to insert any notification, for any user, on any session.

```sql
CREATE POLICY "System can create notifications"
  ON notifications FOR INSERT
  WITH CHECK (true);
```

Select and update stay limited to `auth.uid() = user_id`. The server inserts notifications from `socialNotificationService` and `contentDisputeService` with the service-role client, which bypasses this policy.

### New code

```sql
DROP POLICY IF EXISTS "System can create notifications" ON public.notifications;
```

There is no replacement insert policy. The anon and authenticated roles can no longer insert alerts. The server still can. Users can still read and mark their own alerts.

---

## 7. Trainer separation

### What the current code does

Several policies allow the owner, and then also allow every trainer and every admin. The second branch is the hole. Any trainer, using the public key, can read and write another trainer's scenario structure, and can rewrite team assignment on any session.

The same shape appears on all four commands for these tables:

- `scenario_locations` (`migrations/062_inject_conditions_scenario_locations.sql`)
- `scenario_environmental_seeds` (`migrations/063_scenario_environmental_seeds.sql`)
- `scenario_teams` (`migrations/011_team_assignments_and_inject_scoping.sql`)

Current check, repeated for select, insert, update, and delete:

```sql
EXISTS (
  SELECT 1 FROM scenarios s
  WHERE s.id = scenario_locations.scenario_id
    AND s.created_by = auth.uid()
)
OR EXISTS (
  SELECT 1 FROM user_profiles up
  WHERE up.id = auth.uid()
    AND up.role IN ('trainer', 'admin')
)
```

`scenario_injects` insert is wider. It does not look at the scenario owner at all.

```sql
CREATE POLICY "Trainers can create injects"
  ON scenario_injects FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
        AND role IN ('trainer', 'admin')
    )
  );
```

`session_teams` lets the session's own trainer through, and then also any trainer or admin. This is the insert form. Update and delete use the same session check. Select also allows `user_id = auth.uid()`.

```sql
EXISTS (
  SELECT 1 FROM sessions s
  WHERE s.id = session_teams.session_id
    AND (
      s.trainer_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM user_profiles up
        WHERE up.id = auth.uid()
          AND up.role IN ('trainer', 'admin')
      )
    )
)
```

The Express routes that edit these rows already call `assertScenarioOwner` or `assertSessionOwner` and then use the service-role client. Tightening the policies does not change those screens.

The participant select policy on `scenario_injects` stays. It is not a cross-trainer write.

### New code

For each of `scenario_locations`, `scenario_environmental_seeds`, and `scenario_teams`, drop the four policies and recreate them with the owner check plus admin only. Example for locations. Seeds and teams use the same text with their own table and column names. Policy names stay the same so a later reader can find them.

```sql
DROP POLICY IF EXISTS "Trainers can view locations for their scenarios" ON public.scenario_locations;
DROP POLICY IF EXISTS "Trainers can create locations for their scenarios" ON public.scenario_locations;
DROP POLICY IF EXISTS "Trainers can update locations for their scenarios" ON public.scenario_locations;
DROP POLICY IF EXISTS "Trainers can delete locations for their scenarios" ON public.scenario_locations;

CREATE POLICY "Trainers can view locations for their scenarios"
  ON public.scenario_locations FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.scenarios s
      WHERE s.id = scenario_locations.scenario_id
        AND s.created_by = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.role = 'admin'
    )
  );

CREATE POLICY "Trainers can create locations for their scenarios"
  ON public.scenario_locations FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.scenarios s
      WHERE s.id = scenario_locations.scenario_id
        AND s.created_by = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.role = 'admin'
    )
  );

CREATE POLICY "Trainers can update locations for their scenarios"
  ON public.scenario_locations FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.scenarios s
      WHERE s.id = scenario_locations.scenario_id
        AND s.created_by = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.role = 'admin'
    )
  );

CREATE POLICY "Trainers can delete locations for their scenarios"
  ON public.scenario_locations FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.scenarios s
      WHERE s.id = scenario_locations.scenario_id
        AND s.created_by = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.role = 'admin'
    )
  );
```

Seeds: same four statements, table `scenario_environmental_seeds`, names `Trainers can view environmental seeds for their scenarios`, `Trainers can create environmental seeds for their scenarios`, `Trainers can update environmental seeds for their scenarios`, `Trainers can delete environmental seeds for their scenarios`.

Teams: same four statements, table `scenario_teams`, names `Trainers can view teams for their scenarios`, `Trainers can create teams for their scenarios`, `Trainers can update teams for their scenarios`, `Trainers can delete teams for their scenarios`.

Inject insert:

```sql
DROP POLICY IF EXISTS "Trainers can create injects" ON public.scenario_injects;

CREATE POLICY "Trainers can create injects"
  ON public.scenario_injects FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.scenarios s
      WHERE s.id = scenario_injects.scenario_id
        AND s.created_by = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.role = 'admin'
    )
  );
```

Session teams. A player can still read their own assignment. Writes belong to that session's trainer, or to an admin.

```sql
DROP POLICY IF EXISTS "Users can view their own team assignments" ON public.session_teams;
DROP POLICY IF EXISTS "Trainers can assign teams" ON public.session_teams;
DROP POLICY IF EXISTS "Trainers can update team assignments" ON public.session_teams;
DROP POLICY IF EXISTS "Trainers can remove team assignments" ON public.session_teams;

CREATE POLICY "Users can view their own team assignments"
  ON public.session_teams FOR SELECT
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id = session_teams.session_id
        AND (
          s.trainer_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.user_profiles up
            WHERE up.id = auth.uid() AND up.role = 'admin'
          )
        )
    )
  );

CREATE POLICY "Trainers can assign teams"
  ON public.session_teams FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id = session_teams.session_id
        AND (
          s.trainer_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.user_profiles up
            WHERE up.id = auth.uid() AND up.role = 'admin'
          )
        )
    )
  );

CREATE POLICY "Trainers can update team assignments"
  ON public.session_teams FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id = session_teams.session_id
        AND (
          s.trainer_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.user_profiles up
            WHERE up.id = auth.uid() AND up.role = 'admin'
          )
        )
    )
  );

CREATE POLICY "Trainers can remove team assignments"
  ON public.session_teams FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id = session_teams.session_id
        AND (
          s.trainer_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.user_profiles up
            WHERE up.id = auth.uid() AND up.role = 'admin'
          )
        )
    )
  );
```

A trainer can still edit the scenarios they created, and the sessions they run, through the app. They can no longer reach another trainer's locations, seeds, teams, injects, or session roster through the public key. An admin still can.

---

## 8. Microphone

### What the current code does

`POST /api/ai/transcribe` in `server/routes/ai.ts` requires a login and then sends the audio to the paid speech API. There is no role check and no session check. `useVoiceInput` posts the recording with the current bearer token and no session id. The button is on chat, the decision form, the map response panel, and the legacy War Room. A guest who only just called anonymous sign-in, and who has never joined, can hit this route.

```ts
router.post(
  '/transcribe',
  requireAuth,
  raw({ type: ['audio/*', 'application/octet-stream'], limit: '10mb' }),
  async (req: AuthenticatedRequest, res) => {
    if (!env.openAiApiKey) {
      return res.status(500).json({ error: 'OpenAI API key not configured' });
    }
    const audioBuffer = req.body as Buffer;
    if (!audioBuffer || !Buffer.isBuffer(audioBuffer) || audioBuffer.length < 100) {
      return res.status(400).json({ error: 'No audio data provided' });
    }
    // builds FormData and calls the speech API
  },
);
```

### New helper in `server/lib/access.ts`

```ts
export async function canTranscribe(user: AccessUser): Promise<boolean> {
  if (user.role === 'trainer' || user.role === 'admin') return true;
  const { count } = await supabaseAdmin
    .from('session_participants')
    .select('user_id', { count: 'exact', head: true })
    .eq('user_id', user.id);
  return (count ?? 0) > 0;
}
```

A trainer or admin can use the microphone from the War Room without being a participant. Anyone who has a `session_participants` row can use it from chat, decisions, and the map. That includes an anonymous guest after they have joined. A login with no session row is refused. The check is not tied to one session id, because the request body is raw audio and does not carry a session id.

### New route

Insert this immediately after the empty-audio check and before the `FormData` is built. A short or missing recording still returns 400 without a database lookup. A refused caller never reaches the paid API.

```ts
const allowed = await canTranscribe(req.user!);
if (!allowed) {
  return res.status(403).json({ error: 'Access denied' });
}
```

The rest of the handler, including the speech-API call, stays as it is.

---

## 9. Rate limit

### What the current code does

`server/index.ts` imports `jsonwebtoken` and uses it only here. The global limiter allows 10,000 requests per 15 minutes in production. The key is a user id taken from the bearer token with `jwt.decode`, which does not check the signature.

```ts
keyGenerator: (req) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader) {
      const [, token] = authHeader.split(' ');
      if (token) {
        const decoded = jwt.decode(token) as { sub?: string } | null;
        if (decoded?.sub) {
          return `user:${decoded.sub}`;
        }
      }
    }
  } catch {
    // Fall back to IP if token parsing fails
  }
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  if (ip === 'unknown') return 'unknown';
  return ipKeyGenerator(ip);
},
```

A token that was never issued can still supply a `sub`, and each different `sub` gets its own 10,000-request budget. The join limiter and the contact limiter already key by IP only. They stay as they are.

`requireAuth` later calls `supabaseAdmin.auth.getUser(token)`, which does check the token. The limiter runs before that, so it cannot see `req.user`.

### New code

Delete `import jwt from 'jsonwebtoken';`.

Add a middleware immediately before `app.use('/api/', limiter)`. It asks Supabase whether the bearer token is real. On success it stores only the user id for the limiter. It does not set `req.user`, so `requireAuth` still performs its own check and still loads the profile.

```ts
app.use('/api/', async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    next();
    return;
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    next();
    return;
  }
  try {
    const { data } = await supabaseAdmin.auth.getUser(token);
    if (data?.user?.id) {
      (req as AuthenticatedRequest & { rateLimitUserId?: string }).rateLimitUserId = data.user.id;
    }
  } catch {
    // An unusable token falls through to the IP key.
  }
  next();
});
```

`AuthenticatedRequest` is imported from `./middleware/auth.js`. The intersection type can be a one-line local interface instead if that reads more clearly:

```ts
interface RateLimitedRequest extends Request {
  rateLimitUserId?: string;
}
```

Replace the key function:

```ts
keyGenerator: (req) => {
  const userId = (req as RateLimitedRequest).rateLimitUserId;
  if (userId) return `user:${userId}`;
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  if (ip === 'unknown') return 'unknown';
  return ipKeyGenerator(ip);
},
```

A real signed-in user still has their own 10,000-request budget. A missing or rejected token shares the IP budget. The health check skip, the join limiter, and the contact limiter stay.

This adds one Supabase auth lookup on each API request that sends a bearer token, and `requireAuth` still does a second lookup. That is the cost of not trusting an unverified token. Do not remove the lookup inside `requireAuth` as part of this change.

---

## What a caller can do after this

| Caller                   | Scenarios                                                                        | Scenes                                                    | Media files                                                 | Microphone | Alerts                |
| ------------------------ | -------------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------- | ---------- | --------------------- |
| Admin                    | Full library, full row                                                           | Own scenes, plus the War Room through the server          | Server uploads, public URLs still load                      | Yes        | Server creates them   |
| Trainer                  | Library of scenarios they created. Full row for those, and for sessions they run | Scenes they created, plus the War Room through the server | Same                                                        | Yes        | Same                  |
| Player or joined guest   | Only scenarios they have joined. Row has no insider knowledge and no blueprint   | No direct read                                            | Images already on posts still load                          | Yes        | Their own alerts only |
| Guest who has not joined | Empty list, 403 on a direct id                                                   | No direct read                                            | Cannot list or upload                                       | 403        | Cannot insert         |
| Public key with no login | No scenario rows                                                                 | No scene rows                                             | Cannot list or upload. A known public image URL still loads | 401        | Cannot insert         |

## Apply order

1. Add the helpers to `server/lib/access.ts`.
2. Update `GET /` and `GET /:id` in `server/routes/scenarios.ts`.
3. Update `POST /transcribe` in `server/routes/ai.ts`.
4. Update the limiter in `server/index.ts` and remove the `jsonwebtoken` import.
5. Add `migrations/218_launch_access_locks.sql` and apply it to the live database.

Steps 1–4 are safe to deploy before the migration. Until the migration runs, the public key can still read scenarios and scenes and can still write the media bucket. The route changes close the server door first. The migration closes the database door.
