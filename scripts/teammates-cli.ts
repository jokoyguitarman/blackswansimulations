import 'dotenv/config';

/**
 * Out-of-process dev harness for AI teammates (docs/ai-teammate-bots-plan.md Phase 6).
 *
 *   npx tsx scripts/teammates-cli.ts --session <uuid> [--url http://localhost:3001] [--intellect 80]
 *
 * Runs the same PlayerBot loop the server runs, but from this process, against any
 * backend URL — useful when the target server has ENABLE_TEAMMATE_BOTS=false (e.g. a
 * deployed instance) or when you want bot logs on your own terminal. Bots must already be
 * enrolled in the session (lobby "+ Add bot", or POST /api/sessions/:id/bots). Do NOT run
 * this against a server that is already running the bots itself: they would act twice.
 *
 * Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and OPENAI_API_KEY in .env.
 */

const argv = process.argv.slice(2);
const arg = (name: string, fallback?: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const sessionId = arg('session');
const url = (arg('url', 'http://localhost:3001') as string).replace(/\/$/, '');
const intellectOverride = arg('intellect');
if (!sessionId) {
  console.error(
    'Usage: npx tsx scripts/teammates-cli.ts --session <uuid> [--url http://localhost:3001] [--intellect 0-100]',
  );
  process.exit(1);
}

// env.ts reads process.env at import time; point the loopback client at the target first.
process.env.TEAMMATE_BOTS_API_BASE = url;
process.env.ENABLE_TEAMMATE_BOTS = 'true';

const log = (m: string): void => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

async function main(): Promise<void> {
  const { supabaseAdmin } = await import('../server/lib/supabaseAdmin.js');
  const { ensurePool, getAccount } = await import('../server/services/teammates/accounts.js');
  const { listSessionBots } = await import('../server/services/teammates/enrol.js');
  const { PlayerBot } = await import('../server/services/teammates/bot.js');
  const { intellectToParams, clampIntellect, DEFAULT_INTELLECT } =
    await import('../server/services/teammates/intellect.js');
  const { loadSessionContext } = await import('../server/services/teammates/perception.js');
  const { createBoard } = await import('../server/services/teammates/memory.js');

  const health = await fetch(`${url}/api/health`)
    .then((r) => r.ok)
    .catch(() => false);
  if (!health) throw new Error(`No server at ${url}`);

  await ensurePool();
  const rows = await listSessionBots(sessionId!);
  if (rows.length === 0)
    throw new Error('No AI teammates enrolled in this session. Add them in the lobby first.');
  log(
    `${rows.length} bot(s): ${rows.map((r) => `${r.display_name} [${r.team_name ?? '-'}]`).join(', ')}`,
  );

  const boards = new Map<string, ReturnType<typeof createBoard>>();
  const sessionBoard = createBoard('*');
  const order: string[] = [];
  const bots = new Map<string, InstanceType<typeof PlayerBot>>();

  const getIntellect = async (): Promise<number> => {
    if (intellectOverride) return clampIntellect(Number(intellectOverride));
    const { data } = await supabaseAdmin
      .from('sessions')
      .select('bot_intellect')
      .eq('id', sessionId!)
      .maybeSingle();
    const raw = (data as { bot_intellect?: number | null } | null)?.bot_intellect;
    return raw === null || raw === undefined ? DEFAULT_INTELLECT : clampIntellect(raw);
  };

  for (const [i, row] of rows.entries()) {
    const account = await getAccount(row.user_id);
    if (!account) continue;
    const bot = new PlayerBot({
      sessionId: sessionId!,
      account,
      getParams: async () => intellectToParams(await getIntellect()),
      getSessionCtx: () => loadSessionContext(sessionId!),
      getBoard: (teamName) => {
        if (!teamName) return null;
        let b = boards.get(teamName);
        if (!b) {
          b = createBoard(teamName);
          boards.set(teamName, b);
        }
        return b;
      },
      getSessionBoard: () => sessionBoard,
      isLead: () => {
        const me = bots.get(account.userId);
        if (!me) return false;
        const sameTeam = order.filter((id) => bots.get(id)?.teamName === me.teamName);
        return sameTeam[0] === account.userId;
      },
      log: (msg) => log(msg),
    });
    bots.set(account.userId, bot);
    order.push(account.userId);
    bot.start(5_000 + i * 10_000);
  }

  const stop = (): void => {
    for (const b of bots.values()) b.stop();
    log('stopped');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  // Stop when the session ends.
  for (;;) {
    await new Promise((r) => setTimeout(r, 30_000));
    const { data } = await supabaseAdmin
      .from('sessions')
      .select('status')
      .eq('id', sessionId!)
      .maybeSingle();
    const status = (data as { status?: string } | null)?.status;
    if (status !== 'in_progress') {
      log(
        `session status is ${status ?? 'unknown'}; ${status === 'scheduled' ? 'waiting for start' : 'exiting'}`,
      );
      if (status !== 'scheduled') stop();
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
