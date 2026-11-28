// Local stub API for documentation screenshots. Serves ONLY synthetic fixtures (fixtures.mjs).
// Listens on 127.0.0.1:3001 (the port the Vite dev proxy targets) and doubles as the
// Supabase URL so no network or credentials are needed. Unknown routes return empty data
// and are logged so the harness can show what the UI asked for.
import http from 'node:http';
import * as F from './fixtures.mjs';

const unknown = new Set();
let stateIdx = 0;

const send = (res, code, body) => {
  res.writeHead(code, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': '*',
  });
  res.end(JSON.stringify(body));
};

const routes = [
  [/^\/api\/profile$/, () => ({ data: F.profile })],
  [/^\/api\/sessions\/[^/]+$/, () => ({ data: F.trainerSession })],
  [/^\/api\/sessions\/[^/]+\/orgs$/, () => ({ data: { multi_org: false, countries: [] } })],
  [/^\/api\/sessions\/[^/]+\/events\?event_type=consequence_inject/, () => ({ data: F.consequenceEvents })],
  [/^\/api\/sessions\/[^/]+\/events\?event_type=inject_cancelled/, () => ({ data: F.stakeholderEvents })],
  [/^\/api\/sessions\/[^/]+\/events/, () => ({ data: [] })],
  [/^\/api\/sessions\/[^/]+\/exec-decisions/, () => ({ data: [] })],
  [/^\/api\/social\/state\/session\//, () => {
    if (process.env.STATE_SERIES) { const i = Math.min(stateIdx++, F.stateSeries.length - 1); return { data: F.stateSeries[i] }; }
    return { data: F.socialState };
  }],
  [/^\/__reset$/, () => { stateIdx = 0; return { ok: true }; }],
  [/^\/api\/social\/posts\/session\/[^/?]+\?graded=true/, () => ({ data: F.gradedReplies })],
  [/^\/api\/social\/posts\/session\//, () => ({ data: F.posts })],
  [/^\/api\/social\/orchestration\/session\//, () => ({ data: F.orchestration })],
  [/^\/api\/social\/disputes\/session\//, () => ({ data: [] })],
  [/^\/api\/social\/ledger\/session\//, () => ({ data: null })],
  [/^\/api\/social\/team-scores\/session\//, () => ({ data: null })],
  [/^\/api\/social\/intel-status\/session\//, () => ({ data: [] })],
  [/^\/api\/social\/posts\/([0-9a-f-]{36})$/, (m) => {
    const post = F.posts.find((p) => p.id === m[1]);
    return { data: { ...post, replies: F.posts.filter((p) => p.reply_to_post_id === m[1]) } };
  }],
  [/^\/api\/billing\/credits/, () => ({ data: { session: 5 } })],
  [/^\/api\/scenarios\/[^/]+\/editability/, () => ({ data: { editable: true, reason: 'ok', session_credits: 5, live_session_id: null } })],
  [/^\/api\/scenarios(\?.*)?$/, () => ({ data: [F.scenario] })],
  [/^\/api\/scenarios\/[^/?]+(\?.*)?$/, () => ({ data: F.scenario })],
  [/^\/api\/scenarios\/[^/]+\/stakeholders/, () => ({ data: F.stakeholders, orgs: [], countries: [{ name: 'Singapore', code: 'SG' }], teams: [{ id: 't1', team_name: 'Communications', org_key: null, function_key: 'communications' }, { id: 't2', team_name: 'Community Liaison', org_key: null, function_key: 'community' }], functions: ['communications', 'community'], injects_by_stakeholder: {} })],
  [/^\/api\/sessions\/[^/]+\/bots$/, () => ({ data: F.botsView })],
  [/^\/api\/social\/pages\/session\//, () => ({ data: [] })],
  [/^\/api\/social\/trending\/session\//, () => {
    const counts = {};
    for (const p of F.posts) for (const t of p.hashtags || []) counts[t.toLowerCase()] = (counts[t.toLowerCase()] || 0) + 1;
    return { data: {
      hashtags: Object.entries(counts).map(([tag, count]) => ({ tag, count })),
      topics: [...F.posts].sort((a, b) => b.like_count - a.like_count).slice(0, 4).map((p) => ({ label: p.content.slice(0, 60) + '...', count: p.view_count, trend: 'hot', post_id: p.id })),
      total_posts: F.posts.length } };
  }],
  [/^\/api\/social\/suggested\/session\//, () => ({ data: F.personas.slice(0, 5).map((p) => ({ handle: p.handle, display_name: p.name, type: p.type, follower_count: p.follower_count, personality: p.personality.slice(0, 80) })) })],
  [/^\/api\/social\/my-page\/session\//, () => ({ data: { x_twitter: { page_name: 'Northgate Dairy Co-op', page_handle: '@northgatedairy', page_logo_url: '' } } })],
  [/^\/api\/social\/my-team\/session\//, () => ({ data: { team_name: 'Communications' } })],
  [/^\/api\/notifications/, () => ({ data: [] })],
];

http
  .createServer((req, res) => {
    if (req.method === 'OPTIONS') return send(res, 204, {});
    const url = req.url || '/';
    const path = url.split('?')[0];
    if (path.startsWith('/auth/v1/user')) return send(res, 200, F.authUser);
    if (path.startsWith('/rest/v1/')) return send(res, 200, []);
    for (const [re, fn] of routes) {
      const m = re.exec(url); if (m) return send(res, 200, fn(m));
    }
    unknown.add(`${req.method} ${url}`);
    console.log('[stub] unhandled', req.method, url);
    return send(res, 200, { data: [] });
  })
  .listen(3001, '127.0.0.1', () => console.log('stub listening on 3001'));
