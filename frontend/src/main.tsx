import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { NotificationProvider } from './contexts/NotificationContext';
import { Login } from './pages/Login';
import { SignUp } from './pages/SignUp';
import { Dashboard } from './pages/Dashboard';
import { Clients } from './pages/Clients';
import { AdminPayouts } from './pages/AdminPayouts';
import { Scenarios } from './pages/Scenarios';
import { WarRoom } from './pages/WarRoom';
import { SocialCrisisWizard } from './pages/SocialCrisisWizard';
import { WarRoomLegacy } from './pages/WarRoomLegacy';
import { Sessions } from './pages/Sessions';
import { SessionView } from './pages/SessionView';
import { JoinSessionPage } from './pages/JoinSessionPage';
import { DemoLanding } from './pages/DemoLanding';
import { DebugBuildingStuds } from './pages/DebugBuildingStuds';
import { DebugEvacuationSim } from './pages/DebugEvacuationSim';
import { DebugRTSSim } from './pages/DebugRTSSim';
import { ErrorBoundary } from './components/ErrorBoundary';
import { SupabaseConfigError } from './components/SupabaseConfigError';
import DeviceShell from './components/SimDevice/DeviceShell';
import HomeScreen from './components/SimDevice/HomeScreen';
import SocialFeedApp from './components/SimDevice/SocialFeedApp';
import FacebookFeedApp from './components/SimDevice/FacebookFeedApp';
import GroupChatApp from './components/SimDevice/GroupChatApp';
import EmailApp from './components/SimDevice/EmailApp';
import NewsApp from './components/SimDevice/NewsApp';
import DraftPadApp from './components/SimDevice/DraftPadApp';
import TrainerSimDashboard from './components/SimDevice/TrainerSimDashboard';
import DesktopShell from './components/SimDevice/DesktopShell';
import './style.css';

const ProtectedRoute = ({
  children,
  roles,
}: {
  children: React.ReactNode;
  /** If provided, the authenticated user must have one of these roles. */
  roles?: Array<'trainer' | 'admin'>;
}) => {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="text-lg text-ink mb-2 animate-pulse">Authenticating</div>
          <div className="text-xs text-muted">Verifying credentials…</div>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  // Defense-in-depth: role-restricted pages (trainer dashboards, debug tools).
  // Authorization is still enforced server-side; this only hides the UI.
  if (roles && !roles.includes(user.role as 'trainer' | 'admin')) {
    return <Navigate to="/dashboard" replace />;
  }

  return <>{children}</>;
};

const App = () => {
  return (
    <BrowserRouter>
      <SupabaseConfigError />
      <AuthProvider>
        <NotificationProvider>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/signup" element={<SignUp />} />
            <Route path="/join/:joinToken" element={<JoinSessionPage />} />
            <Route
              path="/dashboard"
              element={
                <ProtectedRoute>
                  <Dashboard />
                </ProtectedRoute>
              }
            />
            <Route
              path="/clients"
              element={
                <ProtectedRoute roles={['trainer', 'admin']}>
                  <Clients />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/payouts"
              element={
                <ProtectedRoute roles={['admin']}>
                  <AdminPayouts />
                </ProtectedRoute>
              }
            />
            <Route
              path="/scenarios"
              element={
                <ProtectedRoute>
                  <Scenarios />
                </ProtectedRoute>
              }
            />
            <Route
              path="/warroom"
              element={
                <ProtectedRoute>
                  <WarRoom />
                </ProtectedRoute>
              }
            />
            <Route
              path="/warroom/social-crisis"
              element={
                <ProtectedRoute>
                  <SocialCrisisWizard />
                </ProtectedRoute>
              }
            />
            <Route
              path="/warroom-legacy"
              element={
                <ProtectedRoute>
                  <WarRoomLegacy />
                </ProtectedRoute>
              }
            />
            <Route
              path="/sessions"
              element={
                <ProtectedRoute>
                  <Sessions />
                </ProtectedRoute>
              }
            />
            <Route
              path="/sessions/:id"
              element={
                <ProtectedRoute>
                  <SessionView />
                </ProtectedRoute>
              }
            />
            <Route
              path="/demo"
              element={
                <ProtectedRoute>
                  <DemoLanding />
                </ProtectedRoute>
              }
            />
            <Route
              path="/debug/building-studs"
              element={
                <ProtectedRoute roles={['trainer', 'admin']}>
                  <DebugBuildingStuds />
                </ProtectedRoute>
              }
            />
            <Route
              path="/debug/evacuation-sim"
              element={
                <ProtectedRoute roles={['trainer', 'admin']}>
                  <DebugEvacuationSim />
                </ProtectedRoute>
              }
            />
            <Route
              path="/debug/rts-sim"
              element={
                <ProtectedRoute roles={['trainer', 'admin']}>
                  <DebugRTSSim />
                </ProtectedRoute>
              }
            />
            {/* Social Media Crisis Simulation Device Routes */}
            <Route
              path="/sim/:sessionId/device"
              element={
                <ProtectedRoute>
                  <DeviceShell />
                </ProtectedRoute>
              }
            >
              <Route index element={<HomeScreen />} />
              <Route path="home" element={<HomeScreen />} />
              <Route path="social" element={<SocialFeedApp />} />
              <Route path="facebook" element={<FacebookFeedApp />} />
              <Route path="chat" element={<GroupChatApp />} />
              <Route path="email" element={<EmailApp />} />
              <Route path="news" element={<NewsApp />} />
              <Route path="drafts" element={<DraftPadApp />} />
            </Route>
            <Route
              path="/sim/:sessionId/desktop"
              element={
                <ProtectedRoute>
                  <DesktopShell />
                </ProtectedRoute>
              }
            />
            <Route
              path="/sim/:sessionId/trainer"
              element={
                <ProtectedRoute roles={['trainer', 'admin']}>
                  <TrainerSimDashboard />
                </ProtectedRoute>
              }
            />
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </NotificationProvider>
      </AuthProvider>
    </BrowserRouter>
  );
};

createRoot(document.getElementById('app')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
