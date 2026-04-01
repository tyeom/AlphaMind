import { useState, useEffect, type FormEvent } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { UserRole } from '../../types/user';
import type { User } from '../../types/user';
import { getAllUsers, adminUpdateUser } from '../../api/user';

export function UserEdit() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [user, setUser] = useState<User | null>(null);
  const [form, setForm] = useState({
    email: '',
    name: '',
    password: '',
    role: UserRole.USER as UserRole,
  });
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getAllUsers()
      .then((users) => {
        const found = users.find((u) => u.id === Number(id));
        if (found) {
          setUser(found);
          setForm({
            email: found.email,
            name: found.name,
            password: '',
            role: found.role,
          });
        } else {
          setError('사용자를 찾을 수 없습니다.');
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [id]);

  const update = (field: string, value: string) =>
    setForm((f) => ({ ...f, [field]: value }));

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setSaving(true);
    try {
      const dto: Record<string, string> = {};
      if (form.email !== user?.email) dto.email = form.email;
      if (form.name !== user?.name) dto.name = form.name;
      if (form.role !== user?.role) dto.role = form.role;
      if (form.password) dto.password = form.password;

      if (Object.keys(dto).length === 0) {
        setError('변경된 내용이 없습니다.');
        setSaving(false);
        return;
      }

      await adminUpdateUser(Number(id), dto);
      setSuccess('수정되었습니다.');
      setForm((f) => ({ ...f, password: '' }));
    } catch (err) {
      setError(err instanceof Error ? err.message : '수정에 실패했습니다.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="page-loading">로딩 중...</div>;
  if (!user) return <div className="page-container"><p>{error}</p></div>;

  return (
    <div className="page-container">
      <div className="page-header">
        <h2>회원 정보 수정</h2>
        <button className="btn btn-text" onClick={() => navigate('/admin/users')}>
          목록으로
        </button>
      </div>
      <form className="form-card" onSubmit={handleSubmit}>
        {error && <div className="alert alert-error">{error}</div>}
        {success && <div className="alert alert-success">{success}</div>}
        <div className="form-group">
          <label>아이디</label>
          <input type="text" value={user.username} disabled />
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
          <label htmlFor="password">새 비밀번호</label>
          <input
            id="password"
            type="password"
            value={form.password}
            onChange={(e) => update('password', e.target.value)}
            placeholder="변경하지 않으려면 비워두세요"
          />
        </div>
        <div className="form-group">
          <label htmlFor="role">권한</label>
          <select
            id="role"
            value={form.role}
            onChange={(e) => update('role', e.target.value)}
          >
            <option value={UserRole.USER}>User</option>
            <option value={UserRole.ADMIN}>Admin</option>
          </select>
        </div>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? '저장 중...' : '저장'}
        </button>
      </form>
    </div>
  );
}
