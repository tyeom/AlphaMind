import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import type { User } from '../../types/user';
import { getAllUsers } from '../../api/user';

export function UserList() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    getAllUsers()
      .then(setUsers)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="page-loading">로딩 중...</div>;

  return (
    <div className="page-container">
      <h2>회원 관리</h2>
      {error && <div className="alert alert-error">{error}</div>}
      <div className="table-container">
        <table className="data-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>아이디</th>
              <th>이름</th>
              <th>이메일</th>
              <th>권한</th>
              <th>가입일</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.id}</td>
                <td>{u.username}</td>
                <td>{u.name}</td>
                <td>{u.email}</td>
                <td>
                  <span className={`badge badge-${u.role}`}>{u.role}</span>
                </td>
                <td>{new Date(u.createdAt).toLocaleDateString('ko-KR')}</td>
                <td>
                  <Link to={`/admin/users/${u.id}`} className="btn btn-sm">
                    수정
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
