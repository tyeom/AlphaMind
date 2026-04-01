import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { signUp } from '../api/user';

export function SignUp() {
  const [form, setForm] = useState({
    username: '',
    password: '',
    passwordConfirm: '',
    email: '',
    name: '',
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const update = (field: string, value: string) =>
    setForm((f) => ({ ...f, [field]: value }));

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    if (form.password !== form.passwordConfirm) {
      setError('비밀번호가 일치하지 않습니다.');
      return;
    }

    setLoading(true);
    try {
      await signUp({
        username: form.username,
        password: form.password,
        email: form.email,
        name: form.name,
      });
      navigate('/sign-in');
    } catch (err) {
      setError(err instanceof Error ? err.message : '회원가입에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <form className="auth-form" onSubmit={handleSubmit}>
        <h2>회원가입</h2>
        {error && <div className="alert alert-error">{error}</div>}
        <div className="form-group">
          <label htmlFor="username">아이디</label>
          <input
            id="username"
            type="text"
            value={form.username}
            onChange={(e) => update('username', e.target.value)}
            required
            autoFocus
          />
        </div>
        <div className="form-group">
          <label htmlFor="email">이메일</label>
          <input
            id="email"
            type="email"
            value={form.email}
            onChange={(e) => update('email', e.target.value)}
            required
          />
        </div>
        <div className="form-group">
          <label htmlFor="name">이름</label>
          <input
            id="name"
            type="text"
            value={form.name}
            onChange={(e) => update('name', e.target.value)}
            required
          />
        </div>
        <div className="form-group">
          <label htmlFor="password">비밀번호</label>
          <input
            id="password"
            type="password"
            value={form.password}
            onChange={(e) => update('password', e.target.value)}
            required
          />
        </div>
        <div className="form-group">
          <label htmlFor="passwordConfirm">비밀번호 확인</label>
          <input
            id="passwordConfirm"
            type="password"
            value={form.passwordConfirm}
            onChange={(e) => update('passwordConfirm', e.target.value)}
            required
          />
        </div>
        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? '가입 중...' : '회원가입'}
        </button>
        <p className="auth-link">
          이미 계정이 있으신가요? <Link to="/sign-in">로그인</Link>
        </p>
      </form>
    </div>
  );
}
