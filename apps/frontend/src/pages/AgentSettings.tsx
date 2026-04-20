import { useState, useEffect, useCallback } from 'react';
import { ApiError } from '../api/client';
import { marketRequest } from '../api/market-client';

type Provider = 'claude' | 'gpt';
type AuthMode = 'api_key' | 'subscription';

interface ProviderStatus {
  configured: boolean;
  authMode: AuthMode | 'none';
  keySet: boolean;
  keyPreview: string | null;
  errorMessage?: string;
}

interface AgentStatus {
  claude: ProviderStatus;
  gpt: ProviderStatus;
}

type Step = 'loading' | 'configured' | 'setup';

export function AgentSettings() {
  const [step, setStep] = useState<Step>('loading');
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [provider, setProvider] = useState<Provider>('claude');
  const [authMode, setAuthMode] = useState<AuthMode>('api_key');
  const [apiKey, setApiKey] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const [loggingIn, setLoggingIn] = useState(false);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [authCode, setAuthCode] = useState('');
  const [submittingCode, setSubmittingCode] = useState(false);
  const [claudeCliLoggedIn, setClaudeCliLoggedIn] = useState(false);
  const [gptCliLoggedIn, setGptCliLoggedIn] = useState(false);
  const [gptCliAuthMode, setGptCliAuthMode] = useState<'chatgpt' | 'api_key' | 'none'>('none');
  const [gptAuthJson, setGptAuthJson] = useState('');
  const [importingGptAuth, setImportingGptAuth] = useState(false);

  const currentStatus = status?.[provider] ?? null;

  const fetchStatus = useCallback(async () => {
    try {
      const data = await marketRequest<AgentStatus>('/agents/status');
      setStatus(data);
      setError('');
    } catch (err) {
      setStatus(null);
      setStep('setup');
      setError(err instanceof ApiError ? err.message : 'Market Data 서비스에 연결할 수 없습니다.');
    }
  }, []);

  const fetchProviderLoginStatus = useCallback(async (targetProvider: Provider) => {
    try {
      const res = await fetch(`/market-api/agents/login/status?provider=${targetProvider}`);
      const data = await res.json();
      if (targetProvider === 'claude') {
        setClaudeCliLoggedIn(!!data.loggedIn);
      } else {
        setGptCliLoggedIn(!!data.loggedIn);
        setGptCliAuthMode(data.authMode || 'none');
      }
    } catch {
      if (targetProvider === 'claude') {
        setClaudeCliLoggedIn(false);
      } else {
        setGptCliLoggedIn(false);
        setGptCliAuthMode('none');
      }
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    if (!status) {
      setStep('loading');
      return;
    }
    const nextStatus = status[provider];
    setStep(nextStatus.configured ? 'configured' : 'setup');
    if (provider === 'gpt' && nextStatus.errorMessage) {
      setAuthMode('subscription');
      return;
    }
    setAuthMode(nextStatus.authMode !== 'none' ? nextStatus.authMode : 'api_key');
  }, [provider, status]);

  useEffect(() => {
    if (step === 'setup' && authMode === 'subscription') {
      void fetchProviderLoginStatus(provider);
    }
  }, [authMode, fetchProviderLoginStatus, provider, step]);

  const handleVerify = async () => {
    if (!apiKey.trim()) {
      setError(provider === 'gpt' ? 'OpenAI API 키를 입력하세요.' : 'API 키를 입력하세요.');
      return;
    }
    setError('');
    setVerifying(true);
    try {
      const res = await fetch('/market-api/agents/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          provider === 'gpt'
            ? { provider, openaiApiKey: apiKey.trim() }
            : { provider, anthropicApiKey: apiKey.trim() },
        ),
      });
      const data = await res.json();
      if (data.valid) {
        setSuccess(provider === 'gpt' ? 'OpenAI API 키가 유효합니다.' : 'API 키가 유효합니다.');
        setError('');
      } else {
        setError(provider === 'gpt' ? '유효하지 않은 OpenAI API 키입니다.' : '유효하지 않은 API 키입니다.');
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
      setError(provider === 'gpt' ? 'OpenAI API 키를 입력하세요.' : 'API 키를 입력하세요.');
      return;
    }
    setError('');
    setSuccess('');
    setSaving(true);
    try {
      const token = localStorage.getItem('access_token');
      const body =
        provider === 'gpt'
          ? authMode === 'subscription'
            ? { provider, authMode: 'subscription' }
            : { provider, authMode: 'api_key', openaiApiKey: apiKey.trim() }
          : authMode === 'subscription'
            ? { provider, authMode: 'subscription' }
            : { provider, authMode: 'api_key', anthropicApiKey: apiKey.trim() };

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
          provider === 'gpt'
            ? authMode === 'subscription'
              ? 'GPT 구독 인증으로 설정되었습니다.'
              : 'OpenAI API 키가 저장되었습니다.'
            : authMode === 'subscription'
              ? 'Claude 구독 인증으로 설정되었습니다.'
              : 'API 키가 저장되었습니다.',
        );
        setError('');
        setApiKey('');
        setStatus(data.status);
      } else {
        setError(data.message || '저장 실패');
      }
    } catch {
      setError('저장 요청 실패');
    } finally {
      setSaving(false);
    }
  };

  const handleImportGptAuth = async () => {
    if (!gptAuthJson.trim()) {
      setError('auth.json 내용을 붙여넣어 주세요.');
      return;
    }

    setError('');
    setSuccess('');
    setImportingGptAuth(true);
    try {
      const token = localStorage.getItem('access_token');
      const res = await fetch('/market-api/agents/gpt/auth/import', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ authJson: gptAuthJson }),
      });
      const data = await res.json();
      if (data.success) {
        setSuccess('GPT auth.json 이 저장되었습니다.');
        setGptAuthJson('');
        setStatus(data.status);
        await fetchProviderLoginStatus('gpt');
      } else {
        setError(data.error || 'GPT auth.json 저장 실패');
      }
    } catch {
      setError('GPT auth.json 저장 요청 실패');
    } finally {
      setImportingGptAuth(false);
    }
  };

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
        setClaudeCliLoggedIn(true);
        setLoggingIn(false);
        setSubmittingCode(false);
        setLoginUrl(null);
        setAuthCode('');
        setSuccess('Claude 구독 인증이 완료되었습니다.');
        await fetchStatus();
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
    setGptAuthJson('');
    setImportingGptAuth(false);
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

  const handleProviderChange = (nextProvider: Provider) => {
    setProvider(nextProvider);
    setError('');
    setSuccess('');
    setApiKey('');
    resetLoginState();
  };

  if (step === 'loading') {
    return (
      <div className="page-container">
        <h2>AI 에이전트 설정</h2>
        <p className="text-muted">상태 확인 중...</p>
      </div>
    );
  }

  const authModeLabel =
    currentStatus?.authMode === 'subscription'
      ? provider === 'gpt' ? 'GPT 구독' : 'Claude 구독'
      : currentStatus?.authMode === 'api_key'
        ? provider === 'gpt' ? 'OpenAI API 키' : 'Anthropic API 키'
        : '미설정';

  return (
    <div className="page-container">
      <h2>AI 에이전트 설정</h2>
      <p style={{ color: 'var(--text-secondary)', marginBottom: 24 }}>
        AI 전문가 회의에 사용할 Claude / GPT 연동 방식을 설정합니다.
      </p>

      <div className="agent-auth-tabs" style={{ marginBottom: 24 }}>
        <button
          className={`agent-auth-tab ${provider === 'claude' ? 'active' : ''}`}
          onClick={() => handleProviderChange('claude')}
        >
          Claude
        </button>
        <button
          className={`agent-auth-tab ${provider === 'gpt' ? 'active' : ''}`}
          onClick={() => handleProviderChange('gpt')}
        >
          GPT
        </button>
      </div>

      <div className="agent-status-card">
        <div className="agent-status-row">
          <span className="agent-status-label">연동 상태</span>
          <span className={`agent-status-badge ${currentStatus?.configured ? 'ok' : 'none'}`}>
            {currentStatus?.configured ? '설정 완료' : '미설정'}
          </span>
        </div>
        <div className="agent-status-row">
          <span className="agent-status-label">인증 방식</span>
          <span className="agent-key-preview">{authModeLabel}</span>
        </div>
        {currentStatus?.keyPreview && (
          <div className="agent-status-row">
            <span className="agent-status-label">API 키</span>
            <code className="agent-key-preview">{currentStatus.keyPreview}</code>
          </div>
        )}
      </div>

      {currentStatus?.errorMessage && (
        <div className="alert alert-error" style={{ marginTop: 16 }}>
          {currentStatus.errorMessage}
        </div>
      )}

      {step === 'configured' ? (
        <div style={{ marginTop: 24 }}>
          {success && <div className="alert alert-success">{success}</div>}
          <p style={{ marginBottom: 16, color: 'var(--text-secondary)' }}>
            {provider === 'gpt'
              ? 'GPT 연동이 완료되었습니다. AI 전문가 회의에서 GPT를 선택할 수 있습니다.'
              : 'Claude 연동이 완료되었습니다. AI 전문가 회의에서 Claude를 선택할 수 있습니다.'}
          </p>
          <button className="btn" onClick={handleReconfigure}>
            인증 재설정
          </button>
        </div>
      ) : (
        <div className="agent-setup-form">
          <h3>인증 방식 선택</h3>

          <div className="agent-auth-tabs">
            <button
              className={`agent-auth-tab ${authMode === 'api_key' ? 'active' : ''}`}
              onClick={() => handleModeChange('api_key')}
            >
              {provider === 'gpt' ? 'OpenAI API 키' : 'API 키'}
            </button>
            <button
              className={`agent-auth-tab ${authMode === 'subscription' ? 'active' : ''}`}
              onClick={() => handleModeChange('subscription')}
            >
              {provider === 'gpt' ? 'GPT 구독' : 'Claude 구독'}
            </button>
          </div>

          {error && <div className="alert alert-error">{error}</div>}
          {success && <div className="alert alert-success">{success}</div>}

          {authMode === 'api_key' ? (
            <>
              <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16 }}>
                {provider === 'gpt' ? (
                  <>
                    OpenAI API 키를 입력하세요.{' '}
                    <a
                      href="https://platform.openai.com/api-keys"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      OpenAI Platform
                    </a>
                    에서 발급받을 수 있습니다.
                  </>
                ) : (
                  <>
                    Anthropic API 키를 입력하세요.{' '}
                    <a
                      href="https://console.anthropic.com/settings/keys"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Anthropic Console
                    </a>
                    에서 발급받을 수 있습니다.
                  </>
                )}
              </p>

              <div className="form-group">
                <label>{provider === 'gpt' ? 'OpenAI API Key' : 'Anthropic API Key'}</label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={provider === 'gpt' ? 'sk-...' : 'sk-ant-api03-...'}
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
                {currentStatus?.configured && (
                  <button className="btn" onClick={() => setStep('configured')}>
                    취소
                  </button>
                )}
              </div>
            </>
          ) : provider === 'claude' ? (
            <>
              <div className="agent-subscription-info">
                <p>
                  Claude Pro, Max, Team, Enterprise 구독 계정의 OAuth 인증을 사용합니다.
                </p>
                <div className="agent-login-status">
                  <span className="agent-status-label">CLI 로그인</span>
                  <span className={`agent-status-badge ${claudeCliLoggedIn ? 'ok' : 'none'}`}>
                    {claudeCliLoggedIn ? '로그인됨' : '로그인 필요'}
                  </span>
                </div>
              </div>

              {!claudeCliLoggedIn && !loginUrl && (
                <div className="agent-setup-actions">
                  <button
                    className="btn"
                    onClick={handleLogin}
                    disabled={loggingIn}
                  >
                    {loggingIn ? '준비 중...' : 'Claude 로그인'}
                  </button>
                  {currentStatus?.configured && (
                    <button className="btn" onClick={() => setStep('configured')}>
                      취소
                    </button>
                  )}
                </div>
              )}

              {loggingIn && loginUrl && !claudeCliLoggedIn && (
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

              {claudeCliLoggedIn && (
                <div className="agent-setup-actions">
                  <button
                    className="btn btn-primary"
                    onClick={handleSave}
                    disabled={saving}
                  >
                    {saving ? '저장 중...' : '구독 인증으로 설정'}
                  </button>
                  {currentStatus?.configured && (
                    <button className="btn" onClick={() => setStep('configured')}>
                      취소
                    </button>
                  )}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="agent-subscription-info">
                <p>
                  GPT 구독은 Codex CLI의 <code>auth.json</code>을 사용합니다.
                </p>
                <div className="agent-login-status">
                  <span className="agent-status-label">Codex 로그인</span>
                  <span className={`agent-status-badge ${gptCliLoggedIn && gptCliAuthMode === 'chatgpt' ? 'ok' : 'none'}`}>
                    {gptCliLoggedIn && gptCliAuthMode === 'chatgpt' ? 'ChatGPT 로그인됨' : '로그인 필요'}
                  </span>
                </div>
              </div>

              <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16 }}>
                Docker 서버 터미널에서 직접 로그인할 수 없는 경우, 로컬 PC에서 <code>codex login</code> 후
                생성된 <code>~/.codex/auth.json</code> 내용을 아래에 붙여넣으면 됩니다.
              </p>

              {currentStatus?.errorMessage && (
                <p style={{ color: 'var(--danger, #c92a2a)', fontSize: 13, marginBottom: 16 }}>
                  기존 GPT 구독 인증이 만료되었거나 refresh 에 실패했습니다. 최신 <code>auth.json</code>을 다시 가져와야 합니다.
                </p>
              )}

              <div className="form-group">
                <label>Codex auth.json</label>
                <textarea
                  value={gptAuthJson}
                  onChange={(e) => setGptAuthJson(e.target.value)}
                  placeholder={'{\n  "auth_mode": "chatgpt",\n  "tokens": { ... }\n}'}
                  rows={10}
                  style={{ width: '100%', resize: 'vertical' }}
                />
              </div>

              <div className="agent-setup-actions">
                <button
                  className="btn"
                  onClick={() => void fetchProviderLoginStatus('gpt')}
                >
                  상태 다시 확인
                </button>
                <button
                  className="btn"
                  onClick={handleImportGptAuth}
                  disabled={importingGptAuth || !gptAuthJson.trim()}
                >
                  {importingGptAuth ? '가져오는 중...' : 'auth.json 가져오기'}
                </button>
                <button
                  className="btn btn-primary"
                  onClick={handleSave}
                  disabled={saving || !gptCliLoggedIn || gptCliAuthMode !== 'chatgpt'}
                >
                  {saving ? '저장 중...' : 'GPT 구독으로 설정'}
                </button>
                {currentStatus?.configured && (
                  <button className="btn" onClick={() => setStep('configured')}>
                    취소
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
