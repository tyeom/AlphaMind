import { useState, useEffect, type FormEvent } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { updateMe } from '../api/user';

export function Profile() {
  const { user, refresh } = useAuth();
  const [form, setForm] = useState({ email: '', name: '', password: '' });
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (user) {
      setForm({ email: user.email, name: user.name, password: '' });
    }
  }, [user]);

  const update = (field: string, value: string) =>
    setForm((f) => ({ ...f, [field]: value }));

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setLoading(true);
    try {
      const dto: Record<string, string> = {};
      if (form.email !== user?.email) dto.email = form.email;
      if (form.name !== user?.name) dto.name = form.name;
      if (form.password) dto.password = form.password;

      if (Object.keys(dto).length === 0) {
        setError('변경된 내용이 없습니다.');
        setLoading(false);
        return;
      }

      await updateMe(dto);
      await refresh();
      setSuccess('정보가 수정되었습니다.');
      setForm((f) => ({ ...f, password: '' }));
    } catch (err) {
      setError(err instanceof Error ? err.message : '수정에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  };

  if (!user) return null;

  return (
    <div className="page-container">
      <h2>내 정보</h2>
      <form className="form-card" onSubmit={handleSubmit}>
        {error && <div className="alert alert-error">{error}</div>}
        {success && <div className="alert alert-success">{success}</div>}
        <div className="form-group">
          <label>아이디</label>
          <input type="text" value={user.username} disabled />
        </div>
        <div className="form-group">
          <label>권한</label>
          <input type="text" value={user.role} disabled />
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
          <label htmlFor="password">새 비밀번호 (변경시에만 입력)</label>
          <input
            id="password"
            type="password"
            value={form.password}
            onChange={(e) => update('password', e.target.value)}
            placeholder="변경하지 않으려면 비워두세요"
          />
        </div>
        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? '저장 중...' : '저장'}
        </button>
      </form>
    </div>
  );
}
