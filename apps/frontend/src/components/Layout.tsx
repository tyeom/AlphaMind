import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';
import { ConnectionIndicator } from './ConnectionIndicator';

export function Layout() {
  const { user, isAdmin, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate('/sign-in');
  };

  return (
    <div className="app-layout">
      <header className="app-header">
        <div className="header-left">
          <NavLink to="/" className="app-logo">
            Alpha Mind
          </NavLink>
          {user && (
            <nav className="main-nav">
              <NavLink to="/trading/balance">잔고</NavLink>
              <NavLink to="/trading/search">종목 조회</NavLink>
              <NavLink to="/trading/order">매매</NavLink>
              <NavLink to="/trading/journal">매매 일지</NavLink>
              <NavLink to="/backtest">백테스팅</NavLink>
              <NavLink to="/ai-scanner">AI 종목 추천</NavLink>
              {isAdmin && (
                <NavLink to="/admin/users" className="nav-admin">
                  회원 관리
                </NavLink>
              )}
            </nav>
          )}
        </div>
        <div className="header-right">
          <ConnectionIndicator />
          <button
            className="btn-icon"
            onClick={toggle}
            title={theme === 'light' ? '다크 모드' : '라이트 모드'}
          >
            {theme === 'light' ? '🌙' : '☀️'}
          </button>
          {user ? (
            <div className="user-menu">
              <NavLink to="/profile" className="user-name">
                {user.name}
              </NavLink>
              <button className="btn-text" onClick={handleLogout}>
                로그아웃
              </button>
            </div>
          ) : (
            <div className="auth-links">
              <NavLink to="/sign-in">로그인</NavLink>
              <NavLink to="/sign-up">회원가입</NavLink>
            </div>
          )}
        </div>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
