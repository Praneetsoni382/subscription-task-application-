import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Video, CheckCircle2, AlertTriangle, Unlink, ExternalLink } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { meetingApi } from '../../services/api';
import {
  authorizeGoogleMeetPopup,
  checkOAuthUrlParams,
  clearMeetAccessToken,
  getCachedMeetAccessToken,
  getCachedMeetEmail,
  isEmbeddedInIframe,
  startWorkspaceGoogleOAuth,
} from '../../services/googleMeet';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

function GoogleIcon() {
  return (
    <svg
      version="1.1"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 48 48"
      className="w-4 h-4 shrink-0"
    >
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
      <path fill="none" d="M0 0h48v48H0z" />
    </svg>
  );
}

export function GoogleMeetAdminConnectModal({ isOpen, onClose }: Props) {
  const queryClient = useQueryClient();
  const [connectError, setConnectError] = useState('');
  const [successNotice, setSuccessNotice] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [sessionMeetEmail, setSessionMeetEmail] = useState<string | null>(
    () => (getCachedMeetAccessToken() ? getCachedMeetEmail() : null)
  );
  const [hasSessionMeetToken, setHasSessionMeetToken] = useState<boolean>(
    () => Boolean(getCachedMeetAccessToken())
  );

  useEffect(() => {
    if (isOpen) {
      setHasSessionMeetToken(Boolean(getCachedMeetAccessToken()));
      setSessionMeetEmail(getCachedMeetEmail());
    }
    const { connected, error } = checkOAuthUrlParams();
    if (connected) {
      setSuccessNotice('Workspace Google account authorized successfully!');
      queryClient.invalidateQueries({ queryKey: ['admin-google-status'] });
    }
    if (error) {
      setConnectError(`Google authorization notice: ${error}`);
    }
  }, [queryClient, isOpen]);

  const { data: statusData, isLoading } = useQuery({
    queryKey: ['admin-google-status'],
    queryFn: async () => {
      const res = await meetingApi.getGoogleStatus();
      return res.data?.data as {
        isConnected: boolean;
        connectedEmail?: string | null;
        hasClientId?: boolean;
        hasClientSecret?: boolean;
        isEncryptionConfigured?: boolean;
        hasOAuthConfig?: boolean;
        hasEncryptionKey?: boolean;
      };
    },
    enabled: isOpen,
  });

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      clearMeetAccessToken();
      setHasSessionMeetToken(false);
      setSessionMeetEmail(null);
      if (statusData?.isConnected) {
        await meetingApi.disconnectGoogle();
      }
    },
    onSuccess: () => {
      setSuccessNotice('');
      setConnectError('');
      queryClient.invalidateQueries({ queryKey: ['admin-google-status'] });
    },
    onError: (err: any) => {
      setConnectError(
        err?.response?.data?.error || err?.message || 'Failed to disconnect Google account.'
      );
    },
  });

  const handleConnectGoogle = async () => {
    setConnectError('');
    setSuccessNotice('');
    setIsConnecting(true);
    try {
      // On Render production (when server-side OAuth credentials + encryption key are configured),
      // use the full-page OAuth redirect flow so refresh tokens are encrypted in Firestore and
      // browser popup/third-party cookie restrictions are avoided completely.
      const hasServerOAuth = Boolean(
        (statusData?.hasOAuthConfig || (statusData?.hasClientId && statusData?.hasClientSecret)) &&
          (statusData?.hasEncryptionKey || statusData?.isEncryptionConfigured)
      );
      if (hasServerOAuth) {
        await startWorkspaceGoogleOAuth();
        return;
      }

      const result = await authorizeGoogleMeetPopup();
      setHasSessionMeetToken(true);
      setSessionMeetEmail(result.email);
      setSuccessNotice(
        `Google Meet connected${result.email ? ` as ${result.email}` : ''}. You can now create real Google Meet links.`
      );
      queryClient.invalidateQueries({ queryKey: ['admin-google-status'] });
    } catch (err: any) {
      setConnectError(
        err?.response?.data?.error ||
          err?.message ||
          'Google Meet authorization was cancelled or could not be completed.'
      );
    } finally {
      setIsConnecting(false);
    }
  };

  const isConnected = Boolean(statusData?.isConnected) || hasSessionMeetToken;
  const connectedEmail =
    sessionMeetEmail || statusData?.connectedEmail || 'Authorized Google Account';

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Workspace Google Meet Integration"
      footer={
        <Button variant="secondary" size="sm" onClick={onClose}>
          Close Settings
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="p-4 bg-[#F8FAFD] rounded-xl border border-[#E4E8EF] flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-[#EBF3FF] border border-[#B8D0F5] text-[#3157A4] flex items-center justify-center shrink-0">
              <Video size={20} />
            </div>
            <div>
              <p className="text-xs font-bold text-[#172033]">Google Meet Integration Status</p>
              {isLoading ? (
                <p className="text-[11px] text-[#667085]">Checking workspace connection...</p>
              ) : isConnected ? (
                <div className="flex items-center gap-1.5 text-xs text-[#16865B] font-semibold mt-0.5">
                  <CheckCircle2 size={13} />
                  <span>Connected ({connectedEmail})</span>
                </div>
              ) : (
                <p className="text-[11px] text-[#D64545] font-semibold mt-0.5">
                  Not Connected — Sign in with Google to authorize Meet
                </p>
              )}
            </div>
          </div>

          {isConnected ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => disconnectMutation.mutate()}
              loading={disconnectMutation.isPending}
              className="text-xs text-[#D64545] hover:bg-[#FFF0F0] shrink-0"
            >
              <Unlink size={13} />
              Disconnect
            </Button>
          ) : (
            <button
              type="button"
              onClick={handleConnectGoogle}
              disabled={isConnecting}
              className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-white hover:bg-[#F8FAFD] text-[#172033] border border-[#D0D5DD] shadow-2xs text-xs font-semibold transition-colors cursor-pointer disabled:opacity-60 shrink-0"
            >
              <GoogleIcon />
              <span>{isConnecting ? 'Connecting...' : 'Sign in with Google'}</span>
            </button>
          )}
        </div>

        {successNotice && (
          <div className="p-3.5 bg-[#EDFAF4] text-[#16865B] rounded-xl border border-[#A8DFC5] text-xs flex items-center gap-2">
            <CheckCircle2 size={15} className="shrink-0" />
            <span className="font-semibold">{successNotice}</span>
          </div>
        )}

        {connectError && (
          <div className="p-3.5 bg-[#FFF0F0] text-[#D64545] rounded-xl border border-[#F5B8B8] text-xs flex items-center gap-2">
            <AlertTriangle size={15} className="shrink-0" />
            <span className="font-semibold">{connectError}</span>
          </div>
        )}

        {!isConnected && (
          <div className="p-4 bg-[#F0F9FF] rounded-xl border border-[#B8DDFB] space-y-3 text-xs">
            <div className="flex items-center gap-2 font-bold text-[#3157A4]">
              <Video size={16} />
              <span>Google Meet Space Authorization</span>
            </div>
            <p className="text-[#667085] leading-relaxed">
              Sign in with Google to grant TaskFlow permission to create real Google Meet rooms for your Workspace status discussions. Your authorization stays in memory for this session and powers up to 5 Google Meet links per 30-day Premium period.
            </p>
            <div className="pt-1 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleConnectGoogle}
                disabled={isConnecting}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-white hover:bg-[#F8FAFD] text-[#172033] border border-[#D0D5DD] shadow-2xs text-xs font-semibold transition-colors cursor-pointer disabled:opacity-60"
              >
                <GoogleIcon />
                <span>{isConnecting ? 'Connecting...' : 'Sign in with Google'}</span>
              </button>
              {isEmbeddedInIframe() && (
                <a
                  href={typeof window !== 'undefined' ? window.location.href : '/'}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#EBF3FF] hover:bg-[#DCE9FF] text-[#3157A4] border border-[#B8D0F5] text-xs font-semibold transition-colors"
                >
                  <ExternalLink size={13} />
                  <span>Open in New Tab</span>
                </a>
              )}
            </div>
            {isEmbeddedInIframe() && (
              <p className="text-[11px] text-[#475467] leading-relaxed">
                Note: Chrome blocks cross-site OAuth popups inside embedded preview frames. If the popup closes or stays blank here, click <strong>Open in New Tab</strong> to authorize Google Meet in a standalone browser tab.
              </p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
