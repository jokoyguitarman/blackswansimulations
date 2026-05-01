import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { NotificationProvider } from './contexts/NotificationContext';
import { Login } from './pages/Login';
import { SignUp } from './pages/SignUp';
import { Dashboard } from './pages/Dashboard';
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
import GroupChatApp from './components/SimDevice/GroupChatApp';
import EmailApp from './components/SimDevice/EmailApp';
import NewsApp from './components/SimDevice/NewsApp';
import FactCheckBrowser from './components/SimDevice/FactCheckBrowser';
import DraftPadApp from './components/SimDevice/DraftPadApp';
import TrainerSimDashboard from './components/SimDevice/TrainerSimDashboard';
import DesktopShell from './components/SimDevice/DesktopShell';
import './style.css';

const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center  scanline">
        <div className="text-center">
          <div className="text-lg terminal-text mb-2 animate-pulse">[AUTHENTICATING]</div>
          <div className="text-xs terminal-text text-robotic-yellow/50">
            Verifying credentials...
          </div>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
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
                <ProtectedRoute>
                  <DebugBuildingStuds />
                </ProtectedRoute>
              }
            />
            <Route
              path="/debug/evacuation-sim"
              element={
                <ProtectedRoute>
                  <DebugEvacuationSim />
                </ProtectedRoute>
              }
            />
            <Route
              path="/debug/rts-sim"
              element={
                <ProtectedRoute>
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
              <Route path="chat" element={<GroupChatApp />} />
              <Route path="email" element={<EmailApp />} />
              <Route path="news" element={<NewsApp />} />
              <Route path="browser" element={<FactCheckBrowser />} />
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
                <ProtectedRoute>
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
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
