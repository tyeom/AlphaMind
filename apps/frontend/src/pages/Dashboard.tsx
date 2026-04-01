import { useAuth } from '../contexts/AuthContext';

export function Dashboard() {
  const { user } = useAuth();

  return (
    <div className="page-container">
      <h2>Alpha Mind</h2>
      {user ? (
        <p>
          안녕하세요, <strong>{user.name}</strong>님! 상단 메뉴에서 원하는 기능을
          선택하세요.
        </p>
      ) : (
        <p>로그인하여 트레이딩을 시작하세요.</p>
      )}
    </div>
  );
}
