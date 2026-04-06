import { useState, useEffect, useCallback } from 'react';

type AuthMode = 'api_key' | 'subscription';

interface AgentStatus {
  configured: boolean;
  authMode: AuthMode | 'none';
  keySet: boolean;
  keyPreview: string | null;
}

type Step = 'loading' | 'configured' | 'setup';

export function AgentSettings() {
  const [step, setStep] = useState<Step>('loading');
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>('api_key');
  const [apiKey, setApiKey] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // 구독 로그인
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [authCode, setAuthCode] = useState('');
  const [submittingCode, setSubmittingCode] = useState(false);
  const [cliLoggedIn, setCliLoggedIn] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/market-api/agents/status');
      if (res.ok) {
        const data: AgentStatus = await res.json();
        setStatus(data);
        if (data.authMode && data.authMode !== 'none') {
          setAuthMode(data.authMode);
        }
        setStep(data.configured ? 'configured' : 'setup');
      } else {
        setError('서버 연결 실패');
        setStep('setup');
      }
    } catch {
      setError('Market Data 서비스에 연결할 수 없습니다.');
      setStep('setup');
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // 구독 탭 진입 시 CLI 로그인 상태 확인
  useEffect(() => {
    if (authMode === 'subscription' && step === 'setup') {
      fetch('/market-api/agents/login/status')
        .then((r) => r.json())
        .then((d) => setCliLoggedIn(d.loggedIn))
        .catch(() => {});
    }
  }, [authMode, step]);

  const handleVerify = async () => {
    if (!apiKey.trim()) {
      setError('API 키를 입력하세요.');
      return;
    }
    setError('');
    setVerifying(true);
    try {
      const res = await fetch('/market-api/agents/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ anthropicApiKey: apiKey.trim() }),
      });
      const data = await res.json();
      if (data.valid) {
        setSuccess('API 키가 유효합니다.');
        setError('');
      } else {
        setError('유효하지 않은 API 키입니다.');
        setSuccess('');
      }
    } catch {
      setError('검증 요청 실패');
    } finally {
      setVerifying(false);
    }
  };

  const handleSave = async () => {
    if (authMode === 'api_key' && !apiKey.trim()) {
      setError('API 키를 입력하세요.');
      return;
    }
    setError('');
    setSuccess('');
    setSaving(true);
    try {
      const token = localStorage.getItem('access_token');
      const body =
        authMode === 'subscription'
          ? { authMode: 'subscription' }
          : { authMode: 'api_key', anthropicApiKey: apiKey.trim() };

      const res = await fetch('/market-api/agents/config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.success) {
        setSuccess(
          authMode === 'subscription'
            ? 'Claude 구독 인증으로 설정되었습니다.'
            : 'API 키가 저장되었습니다.',
        );
        setError('');
        setApiKey('');
        setStatus(data.status);
        setStep('configured');
      } else {
        setError(data.message || '저장 실패');
      }
    } catch {
      setError('저장 요청 실패');
    } finally {
      setSaving(false);
    }
  };

  /** 1단계: OAuth PKCE URL 생성 (즉시 응답, CLI 사용 안 함) */
  const handleLogin = async () => {
    setError('');
    setSuccess('');
    setLoggingIn(true);
    setLoginUrl(null);
    setAuthCode('');

    try {
      const token = localStorage.getItem('access_token');
      const res = await fetch('/market-api/agents/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      const data = await res.json();

      if (data.url) {
        setLoginUrl(data.url);
        window.open(data.url, '_blank', 'noopener');
      } else {
        setError(data.error || '로그인 URL을 가져올 수 없습니다.');
        setLoggingIn(false);
      }
    } catch {
      setError('로그인 요청 실패');
      setLoggingIn(false);
    }
  };

  /** 2단계: 인증 코드 → OAuth 토큰 교환 (HTTP 직접 교환) */
  const handleSubmitCode = async () => {
    if (!authCode.trim()) {
      setError('인증 코드를 입력하세요.');
      return;
    }
    setError('');
    setSubmittingCode(true);

    try {
      const token = localStorage.getItem('access_token');
      const res = await fetch('/market-api/agents/login/code', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ code: authCode.trim() }),
      });
      const data = await res.json();

      if (data.success) {
        setCliLoggedIn(true);
        setLoggingIn(false);
        setSubmittingCode(false);
        setLoginUrl(null);
        setAuthCode('');
        setSuccess('Claude 구독 인증이 완료되었습니다.');
      } else {
        setError(data.error || '인증 실패');
        setSubmittingCode(false);
      }
    } catch {
      setError('인증 코드 전송 실패');
      setSubmittingCode(false);
    }
  };

  const resetLoginState = () => {
    setLoginUrl(null);
    setLoggingIn(false);
    setAuthCode('');
    setSubmittingCode(false);
  };

  const handleReconfigure = () => {
    setStep('setup');
    setSuccess('');
    setError('');
    setApiKey('');
    resetLoginState();
  };

  const handleModeChange = (mode: AuthMode) => {
    setAuthMode(mode);
    setError('');
    setSuccess('');
    setApiKey('');
    resetLoginState();
  };

  if (step === 'loading') {
    return (
      <div className="page-container">
        <h2>Claude Code 설정</h2>
        <p className="text-muted">상태 확인 중...</p>
      </div>
    );
  }

  const authModeLabel =
    status?.authMode === 'subscription'
      ? 'Claude 구독'
      : status?.authMode === 'api_key'
        ? 'Anthropic API 키'
        : '미설정';

  return (
    <div className="page-container">
      <h2>Claude Code 설정</h2>
      <p style={{ color: 'var(--text-secondary)', marginBottom: 24 }}>
        AI 종목 분석에 사용되는 Claude Code CLI 인증 설정입니다.
      </p>

      {/* 현재 상태 카드 */}
      <div className="agent-status-card">
        <div className="agent-status-row">
          <span className="agent-status-label">인증 상태</span>
          <span className={`agent-status-badge ${status?.configured ? 'ok' : 'none'}`}>
            {status?.configured ? '설정 완료' : '미설정'}
          </span>
        </div>
        <div className="agent-status-row">
          <span className="agent-status-label">인증 방식</span>
          <span className="agent-key-preview">{authModeLabel}</span>
        </div>
        {status?.keyPreview && (
          <div className="agent-status-row">
            <span className="agent-status-label">API 키</span>
            <code className="agent-key-preview">{status.keyPreview}</code>
          </div>
        )}
      </div>

      {step === 'configured' ? (
        <div style={{ marginTop: 24 }}>
          {success && <div className="alert alert-success">{success}</div>}
          <p style={{ marginBottom: 16, color: 'var(--text-secondary)' }}>
            Claude Code CLI 인증이 완료되었습니다. AI 종목 추천 기능을 사용할 수 있습니다.
          </p>
          <button className="btn" onClick={handleReconfigure}>
            인증 재설정
          </button>
        </div>
      ) : (
        <div className="agent-setup-form">
          <h3>인증 방식 선택</h3>

          {/* 인증 모드 탭 */}
          <div className="agent-auth-tabs">
            <button
              className={`agent-auth-tab ${authMode === 'api_key' ? 'active' : ''}`}
              onClick={() => handleModeChange('api_key')}
            >
              Anthropic API 키
            </button>
            <button
              className={`agent-auth-tab ${authMode === 'subscription' ? 'active' : ''}`}
              onClick={() => handleModeChange('subscription')}
            >
              Claude 구독
            </button>
          </div>

          {error && <div className="alert alert-error">{error}</div>}
          {success && <div className="alert alert-success">{success}</div>}

          {authMode === 'api_key' ? (
            <>
              <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16 }}>
                Anthropic API 키를 입력하세요.{' '}
                <a
                  href="https://console.anthropic.com/settings/keys"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Anthropic Console
                </a>
                에서 발급받을 수 있습니다.
              </p>

              <div className="form-group">
                <label>Anthropic API Key</label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-ant-api03-..."
                  autoComplete="off"
                />
              </div>

              <div className="agent-setup-actions">
                <button
                  className="btn"
                  onClick={handleVerify}
                  disabled={verifying || !apiKey.trim()}
                >
                  {verifying ? '검증 중...' : '키 검증'}
                </button>
                <button
                  className="btn btn-primary"
                  onClick={handleSave}
                  disabled={saving || !apiKey.trim()}
                >
                  {saving ? '저장 중...' : '저장'}
                </button>
                {status?.configured && (
                  <button className="btn" onClick={() => setStep('configured')}>
                    취소
                  </button>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="agent-subscription-info">
                <p>
                  Claude Pro, Max, Team, Enterprise 구독 계정의 OAuth 인증을 사용합니다.
                </p>
                <div className="agent-login-status">
                  <span className="agent-status-label">CLI 로그인</span>
                  <span className={`agent-status-badge ${cliLoggedIn ? 'ok' : 'none'}`}>
                    {cliLoggedIn ? '로그인됨' : '로그인 필요'}
                  </span>
                </div>
              </div>

              {/* 로그인 단계별 UI */}
              {!cliLoggedIn && !loginUrl && (
                <div className="agent-setup-actions">
                  <button
                    className="btn"
                    onClick={handleLogin}
                    disabled={loggingIn}
                  >
                    {loggingIn ? '준비 중...' : 'Claude 로그인'}
                  </button>
                  {status?.configured && (
                    <button className="btn" onClick={() => setStep('configured')}>
                      취소
                    </button>
                  )}
                </div>
              )}

              {/* 인증 코드 입력 */}
              {loggingIn && loginUrl && !cliLoggedIn && (
                <div className="agent-code-form">
                  <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 8 }}>
                    브라우저에서 Claude 로그인 후 표시되는 인증 코드를 입력하세요.
                    {' '}
                    <a href={loginUrl} target="_blank" rel="noopener noreferrer">
                      로그인 페이지 열기
                    </a>
                  </p>

                  <div className="form-group">
                    <label>Authentication Code</label>
                    <input
                      type="text"
                      value={authCode}
                      onChange={(e) => setAuthCode(e.target.value)}
                      placeholder="인증 코드 붙여넣기"
                      autoComplete="off"
                      disabled={submittingCode}
                    />
                  </div>

                  <div className="agent-setup-actions">
                    <button
                      className="btn btn-primary"
                      onClick={handleSubmitCode}
                      disabled={submittingCode || !authCode.trim()}
                    >
                      {submittingCode ? '인증 중...' : '인증 코드 제출'}
                    </button>
                    <button className="btn" onClick={handleReconfigure}>
                      취소
                    </button>
                  </div>

                  {submittingCode && (
                    <div className="agent-login-pending" style={{ marginTop: 12 }}>
                      <p>로그인 확인 중...</p>
                      <div className="agent-login-spinner" />
                    </div>
                  )}
                </div>
              )}

              {/* 로그인 완료 → 저장 */}
              {cliLoggedIn && (
                <div className="agent-setup-actions">
                  <button
                    className="btn btn-primary"
                    onClick={handleSave}
                    disabled={saving}
                  >
                    {saving ? '저장 중...' : '구독 인증으로 설정'}
                  </button>
                  {status?.configured && (
                    <button className="btn" onClick={() => setStep('configured')}>
                      취소
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
