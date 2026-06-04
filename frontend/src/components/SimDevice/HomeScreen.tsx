import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useRoleVisibility } from '../../hooks/useRoleVisibility';

const API_BASE_URL = import.meta.env.VITE_API_URL || '';
function apiUrl(path: string): string {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  if (API_BASE_URL) return `${API_BASE_URL.replace(/\/$/, '')}${cleanPath}`;
  return cleanPath;
}
async function getAuthHeaders() {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${session?.access_token || ''}`,
  };
}

interface AppDef {
  id: string;
  label: string;
  icon: string;
  path: string;
  badge?: number;
  inDock?: boolean;
}

const AGE_OPTIONS = [
  { value: 'under_18', label: 'Under 18' },
  { value: '18_25', label: '18-25' },
  { value: '26_35', label: '26-35' },
  { value: '36_50', label: '36-50' },
  { value: '51_plus', label: '51+' },
];

const GENDER_OPTIONS = [
  { value: 'male', label: 'Male' },
  { value: 'female', label: 'Female' },
  { value: 'other', label: 'Other' },
  { value: 'prefer_not_to_say', label: 'Prefer not to say' },
];

const RELIGION_OPTIONS = [
  { value: 'buddhism', label: 'Buddhism' },
  { value: 'christianity', label: 'Christianity' },
  { value: 'hinduism', label: 'Hinduism' },
  { value: 'islam', label: 'Islam' },
  { value: 'sikhism', label: 'Sikhism' },
  { value: 'taoism', label: 'Taoism' },
  { value: 'none', label: 'None' },
  { value: 'other', label: 'Other' },
];

const RACE_BY_COUNTRY: Record<string, Array<{ value: string; label: string }>> = {
  singapore: [
    { value: 'chinese', label: 'Chinese' },
    { value: 'malay', label: 'Malay' },
    { value: 'indian', label: 'Indian' },
    { value: 'eurasian', label: 'Eurasian' },
  ],
  malaysia: [
    { value: 'malay', label: 'Malay' },
    { value: 'chinese', label: 'Chinese' },
    { value: 'indian', label: 'Indian' },
    { value: 'orang_asli', label: 'Orang Asli' },
  ],
  indonesia: [
    { value: 'javanese', label: 'Javanese' },
    { value: 'sundanese', label: 'Sundanese' },
    { value: 'malay', label: 'Malay' },
    { value: 'chinese_indonesian', label: 'Chinese Indonesian' },
    { value: 'batak', label: 'Batak' },
  ],
  philippines: [
    { value: 'tagalog', label: 'Tagalog' },
    { value: 'cebuano', label: 'Cebuano' },
    { value: 'ilocano', label: 'Ilocano' },
    { value: 'chinese_filipino', label: 'Chinese Filipino' },
    { value: 'moro', label: 'Moro' },
  ],
  'united states': [
    { value: 'white', label: 'White' },
    { value: 'black', label: 'Black / African American' },
    { value: 'hispanic_latino', label: 'Hispanic / Latino' },
    { value: 'asian', label: 'Asian' },
    { value: 'native_american', label: 'Native American' },
    { value: 'pacific_islander', label: 'Pacific Islander' },
  ],
  'united kingdom': [
    { value: 'white_british', label: 'White British' },
    { value: 'asian_british', label: 'Asian British' },
    { value: 'black_british', label: 'Black British' },
    { value: 'mixed', label: 'Mixed' },
  ],
  germany: [
    { value: 'german', label: 'German' },
    { value: 'turkish', label: 'Turkish' },
    { value: 'arab', label: 'Arab' },
    { value: 'eastern_european', label: 'Eastern European' },
    { value: 'african', label: 'African' },
  ],
  australia: [
    { value: 'anglo_australian', label: 'Anglo-Australian' },
    { value: 'indigenous', label: 'Aboriginal / Torres Strait Islander' },
    { value: 'asian_australian', label: 'Asian Australian' },
    { value: 'middle_eastern', label: 'Middle Eastern' },
    { value: 'european', label: 'European' },
  ],
  india: [
    { value: 'hindu', label: 'Hindu' },
    { value: 'muslim', label: 'Muslim' },
    { value: 'sikh', label: 'Sikh' },
    { value: 'christian', label: 'Christian' },
    { value: 'dalit', label: 'Dalit' },
    { value: 'adivasi', label: 'Adivasi' },
  ],
};

const DEFAULT_RACE_OPTIONS = [
  { value: 'majority', label: 'Majority group' },
  { value: 'minority_1', label: 'Minority group 1' },
  { value: 'minority_2', label: 'Minority group 2' },
  { value: 'immigrant', label: 'Immigrant community' },
];

export default function HomeScreen() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const { isTrainer } = useRoleVisibility();
  const [badges, setBadges] = useState<Record<string, number>>({});
  const [time, setTime] = useState(new Date());
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [onboardingChecked, setOnboardingChecked] = useState(false);
  const [saving, setSaving] = useState(false);

  const [ageBracket, setAgeBracket] = useState('');
  const [gender, setGender] = useState('');
  const [religion, setReligion] = useState('');
  const [customReligion, setCustomReligion] = useState('');
  const [race, setRace] = useState('');
  const [customRace, setCustomRace] = useState('');
  const [scenarioCountry, setScenarioCountry] = useState('');

  const raceOptions = RACE_BY_COUNTRY[scenarioCountry.toLowerCase()] || DEFAULT_RACE_OPTIONS;
  const effectiveReligion = religion === 'other' ? customReligion.trim() : religion;
  const effectiveRace = race === 'other' ? customRace.trim() : race;

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 30000);
    return () => clearInterval(timer);
  }, []);

  // Poll notification badge counts (platform-specific)
  useEffect(() => {
    if (!sessionId) return;
    const fetchBadges = async () => {
      try {
        const headers = await getAuthHeaders();
        const res = await fetch(
          apiUrl(`/api/notifications?session_id=${sessionId}&read=false&limit=100`),
          {
            headers,
          },
        );
        if (res.ok) {
          const json = await res.json();
          const all = (json.data || []) as Array<{
            type: string;
            metadata?: Record<string, unknown>;
          }>;
          const socialTypes = ['social_like', 'social_reply', 'social_mention', 'social_repost'];
          const zCount = all.filter(
            (n) =>
              socialTypes.includes(n.type) &&
              (!n.metadata?.platform || n.metadata.platform === 'x_twitter'),
          ).length;
          const fbCount = all.filter(
            (n) => socialTypes.includes(n.type) && n.metadata?.platform === 'facebook',
          ).length;
          if (zCount > 0 || fbCount > 0) {
            setBadges({ social: zCount || undefined, facebook: fbCount || undefined } as Record<
              string,
              number
            >);
          } else {
            setBadges({});
          }
        }
      } catch {
        /* ignore */
      }
    };
    fetchBadges();
    const interval = setInterval(fetchBadges, 15000);
    return () => clearInterval(interval);
  }, [sessionId]);

  const checkDemographics = useCallback(async () => {
    if (!sessionId || onboardingChecked) return;
    setOnboardingChecked(true);
    try {
      const headers = await getAuthHeaders();

      // Check demographics first (fast, single call) -- show modal immediately if needed
      const res = await fetch(apiUrl(`/api/social/demographics/session/${sessionId}`), { headers });
      if (res.ok) {
        const json = await res.json();
        if (!json.data) {
          setShowOnboarding(true);
        }
      }

      // Fetch country in the background (non-blocking for modal display)
      fetch(apiUrl(`/api/sessions/${sessionId}`), { headers })
        .then((r) => (r.ok ? r.json() : null))
        .then((sessionJson) => {
          const session = sessionJson?.data || sessionJson;
          if (!session?.scenario_id) return;
          return fetch(apiUrl(`/api/scenarios/${session.scenario_id}`), { headers });
        })
        .then((r) => (r && r.ok ? r.json() : null))
        .then((scenarioJson) => {
          if (!scenarioJson) return;
          const scenario = scenarioJson.data || scenarioJson;
          const is = (scenario?.initial_state || {}) as Record<string, unknown>;
          const foundCountry = String(is.country || scenario?.country || '');
          if (foundCountry) setScenarioCountry(foundCountry);
        })
        .catch(() => {
          /* ignore */
        });
    } catch {
      /* ignore */
    }
  }, [sessionId, onboardingChecked]);

  useEffect(() => {
    checkDemographics();
  }, [checkDemographics]);

  async function saveDemographics() {
    if (!sessionId || !ageBracket || !gender || !effectiveRace) return;
    setSaving(true);
    try {
      const headers = await getAuthHeaders();
      await fetch(apiUrl('/api/social/demographics'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          session_id: sessionId,
          demographics: {
            age_bracket: ageBracket,
            gender,
            religion: effectiveReligion || 'none',
            race: effectiveRace,
          },
        }),
      });
      setShowOnboarding(false);
    } catch {
      /* ignore */
    }
    setSaving(false);
  }

  const hours = time.getHours();
  const minutes = time.getMinutes().toString().padStart(2, '0');
  const dateStr = time.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  const apps: AppDef[] = [
    {
      id: 'social',
      label: 'Z',
      icon: '/icons/icon-social.png',
      path: 'social',
      badge: badges.social,
      inDock: true,
    },
    {
      id: 'facebook',
      label: 'Fakebook',
      icon: '/icons/icon-facebook.png',
      path: 'facebook',
      badge: badges.facebook,
      inDock: true,
    },
    {
      id: 'chat',
      label: 'TeamChat',
      icon: '/icons/icon-chat.png',
      path: 'chat',
      badge: badges.chat,
      inDock: true,
    },
    {
      id: 'email',
      label: 'Mail',
      icon: '/icons/icon-mail.png',
      path: 'email',
      badge: badges.email,
      inDock: true,
    },
    {
      id: 'news',
      label: 'News',
      icon: '/icons/icon-news.png',
      path: 'news',
      badge: badges.news,
    },
    { id: 'drafts', label: 'DraftPad', icon: '/icons/icon-drafts.png', path: 'drafts' },
  ];

  const dockApps = apps.filter((a) => a.inDock);

  return (
    <div
      className="h-full flex flex-col relative overflow-hidden"
      style={{
        backgroundImage: 'url(/icons/wallpaper.png)',
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      }}
    >
      {/* Demographics Onboarding Modal */}
      {showOnboarding && (
        <div
          className="absolute inset-0 z-[100] flex items-center justify-center"
          style={{ backgroundColor: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(10px)' }}
        >
          <div
            className="mx-6 rounded-2xl overflow-hidden"
            style={{ backgroundColor: '#1C1C1E', maxWidth: 340, width: '100%' }}
          >
            <div className="px-5 pt-5 pb-3 text-center">
              <div className="text-[32px] mb-2">📱</div>
              <h2
                className="text-white text-[17px] font-semibold mb-1"
                style={{ fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif' }}
              >
                Set Up Your Profile
              </h2>
              <p className="text-[13px]" style={{ color: 'rgba(255,255,255,0.5)' }}>
                This personalizes your social media feed for the simulation.
              </p>
            </div>

            <div className="px-5 pb-4 space-y-3">
              <div>
                <label
                  className="text-[11px] font-semibold uppercase tracking-wider mb-1 block"
                  style={{ color: 'rgba(255,255,255,0.4)' }}
                >
                  Age
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {AGE_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => setAgeBracket(opt.value)}
                      className="px-3 py-1.5 rounded-full text-[12px] font-medium transition-colors"
                      style={{
                        backgroundColor: ageBracket === opt.value ? '#0A84FF' : '#2C2C2E',
                        color: ageBracket === opt.value ? '#FFF' : 'rgba(255,255,255,0.6)',
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label
                  className="text-[11px] font-semibold uppercase tracking-wider mb-1 block"
                  style={{ color: 'rgba(255,255,255,0.4)' }}
                >
                  Gender
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {GENDER_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => setGender(opt.value)}
                      className="px-3 py-1.5 rounded-full text-[12px] font-medium transition-colors"
                      style={{
                        backgroundColor: gender === opt.value ? '#0A84FF' : '#2C2C2E',
                        color: gender === opt.value ? '#FFF' : 'rgba(255,255,255,0.6)',
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label
                  className="text-[11px] font-semibold uppercase tracking-wider mb-1 block"
                  style={{ color: 'rgba(255,255,255,0.4)' }}
                >
                  Religion
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {RELIGION_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => {
                        setReligion(opt.value);
                        setCustomReligion('');
                      }}
                      className="px-3 py-1.5 rounded-full text-[12px] font-medium transition-colors"
                      style={{
                        backgroundColor: religion === opt.value ? '#0A84FF' : '#2C2C2E',
                        color: religion === opt.value ? '#FFF' : 'rgba(255,255,255,0.6)',
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                {religion === 'other' && (
                  <input
                    type="text"
                    value={customReligion}
                    onChange={(e) => setCustomReligion(e.target.value)}
                    placeholder="Enter your religion..."
                    className="mt-2 w-full bg-transparent border rounded-lg px-3 py-1.5 text-[13px] outline-none"
                    style={{ borderColor: '#3A3A3C', color: '#FFF' }}
                    maxLength={50}
                  />
                )}
              </div>

              <div>
                <label
                  className="text-[11px] font-semibold uppercase tracking-wider mb-1 block"
                  style={{ color: 'rgba(255,255,255,0.4)' }}
                >
                  Race / Ethnicity{scenarioCountry ? ` (${scenarioCountry})` : ''}
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {raceOptions.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => {
                        setRace(opt.value);
                        setCustomRace('');
                      }}
                      className="px-3 py-1.5 rounded-full text-[12px] font-medium transition-colors"
                      style={{
                        backgroundColor: race === opt.value ? '#0A84FF' : '#2C2C2E',
                        color: race === opt.value ? '#FFF' : 'rgba(255,255,255,0.6)',
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                  <button
                    onClick={() => setRace('other')}
                    className="px-3 py-1.5 rounded-full text-[12px] font-medium transition-colors"
                    style={{
                      backgroundColor: race === 'other' ? '#0A84FF' : '#2C2C2E',
                      color: race === 'other' ? '#FFF' : 'rgba(255,255,255,0.6)',
                    }}
                  >
                    Other
                  </button>
                </div>
                {race === 'other' && (
                  <input
                    type="text"
                    value={customRace}
                    onChange={(e) => setCustomRace(e.target.value)}
                    placeholder="Enter your ethnicity..."
                    className="mt-2 w-full bg-transparent border rounded-lg px-3 py-1.5 text-[13px] outline-none"
                    style={{ borderColor: '#3A3A3C', color: '#FFF' }}
                    maxLength={50}
                  />
                )}
              </div>
            </div>

            <div className="px-5 pb-5">
              <button
                onClick={saveDemographics}
                disabled={!ageBracket || !gender || !effectiveRace || saving}
                className="w-full py-2.5 rounded-xl text-[15px] font-semibold text-white disabled:opacity-40 transition-opacity"
                style={{ backgroundColor: '#0A84FF' }}
              >
                {saving ? 'Saving...' : 'Continue'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Time & Date Widget */}
      <div className="flex flex-col items-center pt-12 pb-6">
        <div
          className="text-white font-light tracking-tight"
          style={{
            fontSize: 72,
            lineHeight: 1,
            fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
            textShadow: '0 2px 8px rgba(0,0,0,0.3)',
          }}
        >
          {hours}:{minutes}
        </div>
        <div
          className="text-white/80 mt-1"
          style={{
            fontSize: 17,
            fontWeight: 500,
            letterSpacing: 0.3,
            fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
            textShadow: '0 1px 4px rgba(0,0,0,0.4)',
          }}
        >
          {dateStr}
        </div>
      </div>

      {/* App Grid */}
      <div className="flex-1 flex flex-col items-center justify-start px-10 pt-6">
        <div className="grid grid-cols-4 gap-x-7 gap-y-7">
          {apps.map((app) => (
            <button
              key={app.id}
              onClick={() => navigate(`/sim/${sessionId}/device/${app.path}`)}
              className="flex flex-col items-center gap-[6px] ios-btn-bounce bg-transparent border-0 p-0 outline-none focus:outline-none"
            >
              <div className="relative">
                <img
                  src={app.icon}
                  alt={app.label}
                  className="w-[56px] h-[56px] object-cover superellipse-icon"
                  draggable={false}
                  style={{ filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.3))' }}
                />
                {!!app.badge && app.badge > 0 && (
                  <span
                    className="absolute -top-1 -right-1 min-w-[20px] h-[20px] bg-[#FF3B30] text-white text-[13px] font-bold rounded-full flex items-center justify-center px-1"
                    style={{ borderWidth: 2, borderColor: 'rgba(0,0,0,0.2)', borderStyle: 'solid' }}
                  >
                    {app.badge > 99 ? '99+' : app.badge}
                  </span>
                )}
              </div>
              <span
                className="text-white text-center truncate w-[64px]"
                style={{
                  fontSize: 11,
                  fontWeight: 500,
                  textShadow: '0 1px 2px rgba(0,0,0,0.8), 0 0px 6px rgba(0,0,0,0.4)',
                  fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
                }}
              >
                {app.label}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Mode Switcher */}
      <div className="flex items-center justify-center gap-2 py-2">
        <button
          onClick={() => navigate(`/sim/${sessionId}/desktop`)}
          className="px-3 py-1 rounded-full text-[11px] font-medium"
          style={{
            backgroundColor: 'rgba(255,255,255,0.15)',
            color: 'rgba(255,255,255,0.7)',
            backdropFilter: 'blur(10px)',
          }}
        >
          Desktop Mode
        </button>
        {isTrainer && (
          <button
            onClick={() => navigate(`/sim/${sessionId}/trainer`)}
            className="px-3 py-1 rounded-full text-[11px] font-medium"
            style={{
              backgroundColor: 'rgba(239,68,68,0.3)',
              color: 'rgba(255,255,255,0.9)',
              backdropFilter: 'blur(10px)',
            }}
          >
            Trainer Dashboard
          </button>
        )}
      </div>

      {/* Dock */}
      <div
        className="mx-2 mb-1 px-4 py-3"
        style={{
          background: 'rgba(30, 30, 30, 0.55)',
          backdropFilter: 'blur(30px)',
          WebkitBackdropFilter: 'blur(30px)',
          borderRadius: 28,
          borderTop: '0.5px solid rgba(255,255,255,0.1)',
        }}
      >
        <div className="flex items-center justify-around">
          {dockApps.map((app) => (
            <button
              key={app.id}
              onClick={() => navigate(`/sim/${sessionId}/device/${app.path}`)}
              className="flex flex-col items-center ios-btn-bounce bg-transparent border-0 p-0 outline-none focus:outline-none"
            >
              <div className="relative">
                <img
                  src={app.icon}
                  alt={app.label}
                  className="w-[52px] h-[52px] object-cover superellipse-icon"
                  draggable={false}
                  style={{ filter: 'drop-shadow(0 1px 4px rgba(0,0,0,0.25))' }}
                />
                {!!app.badge && app.badge > 0 && (
                  <span
                    className="absolute -top-1 -right-1 min-w-[20px] h-[20px] bg-[#FF3B30] text-white text-[13px] font-bold rounded-full flex items-center justify-center px-1"
                    style={{ borderWidth: 2, borderColor: 'rgba(0,0,0,0.3)', borderStyle: 'solid' }}
                  >
                    {app.badge > 99 ? '99+' : app.badge}
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
