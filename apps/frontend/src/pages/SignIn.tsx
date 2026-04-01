import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { signIn } from '../api/auth';
import { useAuth } from '../contexts/AuthContext';

export function SignIn() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const { refresh } = useAuth();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await signIn({ username, password });
      await refresh();
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : '로그인에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <form className="auth-form" onSubmit={handleSubmit}>
        <h2>로그인</h2>
        {error && <div className="alert alert-error">{error}</div>}
        <div className="form-group">
          <label htmlFor="username">아이디</label>
          <input
            id="username"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            autoFocus
          />
        </div>
        <div className="form-group">
          <label htmlFor="password">비밀번호</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? '로그인 중...' : '로그인'}
        </button>
        <p className="auth-link">
          계정이 없으신가요? <Link to="/sign-up">회원가입</Link>
        </p>
      </form>
    </div>
  );
}
