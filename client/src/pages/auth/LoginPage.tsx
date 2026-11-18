import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Briefcase,
  Eye,
  EyeOff,
  ArrowRight,
  Building2,
  AlertTriangle,
  ShieldCheck,
  UserCheck,
  Lock,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { bootstrapApi } from '../../services/api';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import type { BootstrapStatus } from '../../types';

export function LoginPage() {
  const { login, loginWithGoogle, bootstrapWorkspace, user } = useAuth();
  const navigate = useNavigate();

  // Sign-In state
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // First-time Workspace Bootstrap state
  const [workspaceName, setWorkspaceName] = useState('');
  const [adminFullName, setAdminFullName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [department, setDepartment] = useState('Administration');
  const [setupSecret, setSetupSecret] = useState('');

  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionConflict, setSessionConflict] = useState<{
    method: 'password' | 'google';
    message: string;
  } | null>(null);

  const { data: bootstrapStatus, isLoading: statusLoading } = useQuery({
    queryKey: ['bootstrap-status'],
    queryFn: async () => {
      const res = await bootstrapApi.getStatus();
      return res.data?.data as BootstrapStatus;
    },
    retry: 1,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (user && !loading && !googleLoading) {
      navigate(user.role === 'admin' ? '/admin' : '/employee', { replace: true });
    }
  }, [user, loading, googleLoading, navigate]);

  const handleLoginSubmit = async (e: React.FormEvent, forceTakeover = false) => {
    e.preventDefault();
    setError(null);
    if (!forceTakeover) setSessionConflict(null);
    if (!email.trim() || !password) {
      setError('Please enter both your email address and password.');
      return;
    }
    try {
      setLoading(true);
      const loggedIn = await login(email.trim(), password, forceTakeover);
      setSessionConflict(null);
      navigate(loggedIn.role === 'admin' ? '/admin' : '/employee', { replace: true });
    } catch (err: unknown) {
      const typedErr = err as Error & { code?: string };
      const message = typedErr instanceof Error ? typedErr.message : 'Invalid email or password';
      if (typedErr?.code === 'ACTIVE_SESSION_CONFLICT') {
        setSessionConflict({ method: 'password', message });
      } else {
        setSessionConflict(null);
        setError(message);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignIn = async (forceTakeover = false) => {
    setError(null);
    if (!forceTakeover) setSessionConflict(null);
    try {
      setGoogleLoading(true);
      const loggedIn = await loginWithGoogle(forceTakeover);
      setSessionConflict(null);
      navigate(loggedIn.role === 'admin' ? '/admin' : '/employee', { replace: true });
    } catch (err: unknown) {
      const typedErr = err as Error & { code?: string };
      const message = typedErr instanceof Error ? typedErr.message : 'Google Sign-In failed';
      if (typedErr?.code === 'ACTIVE_SESSION_CONFLICT') {
        setSessionConflict({ method: 'google', message });
      } else {
        setSessionConflict(null);
        setError(message);
      }
    } finally {
      setGoogleLoading(false);
    }
  };

  const handleConfirmTakeover = async () => {
    if (!sessionConflict) return;
    if (sessionConflict.method === 'google') {
      await handleGoogleSignIn(true);
    } else {
      await handleLoginSubmit({ preventDefault: () => {} } as React.FormEvent, true);
    }
  };

  const handleBootstrapSubmit = async (e: React.FormEvent, useGoogleAuth = false) => {
    e.preventDefault();
    setError(null);
    if (!workspaceName.trim() || !adminFullName.trim()) {
      setError('Workspace Name and Administrator Full Name are required.');
      return;
    }
    if (!useGoogleAuth && (!adminEmail.trim() || adminPassword.length < 8)) {
      setError('A valid Administrator Email and Password (min 8 characters) are required.');
      return;
    }

    try {
      if (useGoogleAuth) {
        setGoogleLoading(true);
      } else {
        setLoading(true);
      }
      const createdAdmin = await bootstrapWorkspace({
        workspaceName: workspaceName.trim(),
        adminFullName: adminFullName.trim(),
        adminEmail: adminEmail.trim() || 'pending-google-auth@workspace.local',
        adminPassword: useGoogleAuth ? undefined : adminPassword,
        useGoogleAuth,
        department: department.trim() || 'Administration',
        setupSecret: setupSecret.trim() || undefined,
      });
      navigate(createdAdmin.role === 'admin' ? '/admin' : '/employee', { replace: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Workspace initialization failed';
      setError(message);
    } finally {
      setLoading(false);
      setGoogleLoading(false);
    }
  };

  const isFirestoreOffline =
    bootstrapStatus && bootstrapStatus.firestoreConnected === false;
  const needsBootstrap =
    bootstrapStatus && bootstrapStatus.firestoreConnected && !bootstrapStatus.initialized;

  return (
    <div className="min-h-screen bg-[#F5F7FA] flex flex-col justify-center py-12 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md px-4">
        <div className="flex justify-center items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-[#2458D3] to-[#168BFF] flex items-center justify-center text-white shadow-md">
            <Briefcase size={22} />
          </div>
          <h2 className="text-2xl font-bold tracking-tight text-[#172033]">TaskFlow</h2>
        </div>
        <p className="text-center text-xs font-medium text-[#667085] tracking-wide uppercase">
          Workspace Task Operations & Subscription Platform
        </p>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md px-4 sm:px-0">
        <div className="bg-white py-8 px-6 sm:px-10 shadow-sm border border-[#E4E8EF] rounded-2xl">
          {statusLoading ? (
            <div className="py-10 text-center text-xs text-[#667085]">
              Checking workspace initialization status...
            </div>
          ) : isFirestoreOffline ? (
            <div className="space-y-4">
              <div className="p-4 rounded-xl bg-[#FFF8E7] border border-[#F5D87E] space-y-2">
                <div className="flex items-center gap-2 text-xs font-bold text-[#C58A20]">
                  <AlertTriangle size={16} className="shrink-0" />
                  <span>Backend Database Configuration Required</span>
                </div>
                <p className="text-xs text-[#172033] leading-relaxed">
                  The server is running on project{' '}
                  <span className="font-mono font-semibold">{bootstrapStatus.projectId}</span>{' '}
                  (database <span className="font-mono font-semibold">{bootstrapStatus.databaseId}</span>),
                  but Firebase Admin SDK credentials are not yet configured in the runtime environment.
                </p>
                {bootstrapStatus.error && (
                  <p className="text-[11px] text-[#667085] font-mono break-words bg-white/70 p-2 rounded border border-[#F5D87E]/60">
                    {bootstrapStatus.error}
                  </p>
                )}
              </div>
              <div className="p-3 rounded-xl bg-[#F8FAFD] border border-[#E4E8EF] text-[11px] text-[#667085] leading-relaxed">
                Configure <span className="font-mono font-semibold text-[#172033]">FIREBASE_CLIENT_EMAIL</span>,{' '}
                <span className="font-mono font-semibold text-[#172033]">FIREBASE_PRIVATE_KEY</span>, and{' '}
                <span className="font-mono font-semibold text-[#172033]">SESSION_SECRET</span> in your server environment, then reload this page to initialize your Workspace.
              </div>
            </div>
          ) : needsBootstrap ? (
            <form className="space-y-4" onSubmit={(e) => handleBootstrapSubmit(e, false)}>
              <div className="pb-3 border-b border-[#E4E8EF]">
                <div className="flex items-center gap-2 text-sm font-bold text-[#172033]">
                  <Building2 size={18} className="text-[#2458D3]" />
                  <span>Initialize Your Workspace</span>
                </div>
                <p className="text-xs text-[#667085] mt-1">
                  Create your organization Workspace and primary Administrator account. Workspaces begin on the Free plan and can upgrade to Premium anytime.
                </p>
              </div>

              {error && (
                <div className="p-3 text-xs bg-[#FFF0F0] border border-[#F5B8B8] text-[#D64545] rounded-lg">
                  {error}
                </div>
              )}

              <Input
                label="Workspace / Company Name *"
                placeholder="e.g. Acme Engineering"
                value={workspaceName}
                onChange={(e) => setWorkspaceName(e.target.value)}
                required
              />

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Input
                  label="Admin Full Name *"
                  placeholder="Your full name"
                  value={adminFullName}
                  onChange={(e) => setAdminFullName(e.target.value)}
                  required
                />
                <Input
                  label="Department"
                  placeholder="Administration"
                  value={department}
                  onChange={(e) => setDepartment(e.target.value)}
                />
              </div>

              <Input
                label="Administrator Email *"
                type="email"
                placeholder="you@organization.com"
                value={adminEmail}
                onChange={(e) => setAdminEmail(e.target.value)}
                required
              />

              <div>
                <label className="text-sm font-medium text-[#172033] block mb-1.5">
                  Administrator Password *
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    placeholder="Minimum 8 characters"
                    value={adminPassword}
                    onChange={(e) => setAdminPassword(e.target.value)}
                    className="w-full px-3 py-2 pr-10 text-sm text-[#172033] bg-white border border-[#E4E8EF] rounded-lg focus:outline-none focus:ring-2 focus:ring-[#3157A4] focus:border-[#3157A4] transition-colors"
                    minLength={8}
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-2.5 text-[#667085] hover:text-[#172033] cursor-pointer"
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>

              {bootstrapStatus.requiresSetupSecret && (
                <Input
                  label="Bootstrap Setup Secret *"
                  type="password"
                  placeholder="Enter BOOTSTRAP_SETUP_SECRET"
                  value={setupSecret}
                  onChange={(e) => setSetupSecret(e.target.value)}
                  required
                />
              )}

              <Button type="submit" className="w-full mt-2" size="lg" loading={loading}>
                Create Workspace & Admin Account
                <ArrowRight size={16} />
              </Button>

              <div className="relative py-2">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-[#E4E8EF]" />
                </div>
                <div className="relative flex justify-center text-[11px]">
                  <span className="bg-white px-2 text-[#667085]">or initialize with</span>
                </div>
              </div>

              <Button
                type="button"
                variant="outline"
                className="w-full"
                loading={googleLoading}
                onClick={(e) => handleBootstrapSubmit(e, true)}
              >
                Continue with Google Account
              </Button>
            </form>
          ) : (
            <>
              <div className="pb-4 mb-4 border-b border-[#E4E8EF]">
                <h1 className="text-lg font-bold text-[#172033]">Sign In to Workspace</h1>
                <p className="text-xs text-[#667085] mt-0.5">
                  Access your Workspace tasks, team communications, and notifications.
                </p>
              </div>

              <form className="space-y-4" onSubmit={(e) => handleLoginSubmit(e, false)}>
                {sessionConflict && (
                  <div className="p-3.5 rounded-xl bg-[#FFF8E7] border border-[#F5D87E] space-y-2.5">
                    <div className="flex items-start gap-2 text-xs text-[#8A5A00] leading-relaxed">
                      <AlertTriangle size={15} className="shrink-0 mt-0.5 text-[#C58A20]" />
                      <span>{sessionConflict.message}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 pt-0.5">
                      <Button
                        type="button"
                        size="sm"
                        loading={loading || googleLoading}
                        onClick={handleConfirmTakeover}
                      >
                        Sign Out Other Session & Log In Here
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => setSessionConflict(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}

                {error && (
                  <div className="p-3 text-xs bg-[#FFF0F0] border border-[#F5B8B8] text-[#D64545] rounded-lg leading-relaxed">
                    {error}
                  </div>
                )}

                <Input
                  label="Work Email"
                  type="email"
                  placeholder="name@organization.com"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    if (sessionConflict) setSessionConflict(null);
                  }}
                  autoComplete="email"
                  required
                />

                <div>
                  <label className="text-sm font-medium text-[#172033] block mb-1.5">
                    Password
                  </label>
                  <div className="relative">
                    <input
                      type={showPassword ? 'text' : 'password'}
                      placeholder="Enter your password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="current-password"
                      className="w-full px-3 py-2 pr-10 text-sm text-[#172033] bg-white border border-[#E4E8EF] rounded-lg focus:outline-none focus:ring-2 focus:ring-[#3157A4] focus:border-[#3157A4] transition-colors"
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-2.5 text-[#667085] hover:text-[#172033] cursor-pointer"
                    >
                      {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>

                <Button type="submit" className="w-full mt-2" size="lg" loading={loading}>
                  Sign In
                  <ArrowRight size={16} />
                </Button>
              </form>

              <div className="relative my-5">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-[#E4E8EF]" />
                </div>
                <div className="relative flex justify-center text-[11px]">
                  <span className="bg-white px-2 text-[#667085]">or</span>
                </div>
              </div>

              <Button
                type="button"
                variant="outline"
                className="w-full"
                loading={googleLoading}
                onClick={() => handleGoogleSignIn(false)}
              >
                <ShieldCheck size={16} className="text-[#2458D3]" />
                Continue with Google
              </Button>

              <div className="mt-6 pt-5 border-t border-[#E4E8EF] space-y-2.5">
                <div className="p-3 rounded-xl border border-[#E4E8EF] bg-[#F9FAFB] flex items-start gap-2.5">
                  <UserCheck size={15} className="text-[#667085] shrink-0 mt-0.5" />
                  <p className="text-[11px] text-[#667085] leading-relaxed">
                    <span className="font-semibold text-[#172033]">Employee Access:</span>{' '}
                    Employee accounts are provisioned by your Workspace Administrator. Use the credentials shared with you or your Workspace Google email.
                  </p>
                </div>
                <div className="p-3 rounded-xl border border-[#E4E8EF] bg-[#F9FAFB] flex items-start gap-2.5">
                  <Lock size={15} className="text-[#667085] shrink-0 mt-0.5" />
                  <p className="text-[11px] text-[#667085] leading-relaxed">
                    <span className="font-semibold text-[#172033]">Single-Device Policy:</span>{' '}
                    Each account maintains one active device session at a time. Sign out before switching devices.
                  </p>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
