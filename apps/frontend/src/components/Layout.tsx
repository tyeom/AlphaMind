import { useState, useEffect, useCallback } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';
import { ConnectionIndicator } from './ConnectionIndicator';
import { CollectionStatus } from './CollectionStatus';
import { NotificationBell } from './NotificationBell';

export function Layout() {
  const { user, isAdmin, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(() => {
    return localStorage.getItem('sidebar_collapsed') === 'true';
  });
  const [serverTime, setServerTime] = useState('');

  const toggleSidebar = useCallback(() => {
    setCollapsed((prev) => {
      localStorage.setItem('sidebar_collapsed', String(!prev));
      return !prev;
    });
  }, []);

  useEffect(() => {
    const tick = () => {
      const now = new Date();
      const y = now.getFullYear();
      const M = String(now.getMonth() + 1).padStart(2, '0');
      const d = String(now.getDate()).padStart(2, '0');
      const h = String(now.getHours()).padStart(2, '0');
      const m = String(now.getMinutes()).padStart(2, '0');
      const s = String(now.getSeconds()).padStart(2, '0');
      setServerTime(`${y}/${M}/${d} ${h}:${m}:${s}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const handleLogout = async () => {
    await logout();
    navigate('/sign-in');
  };

  return (
    <div className={`app-layout ${collapsed ? 'sidebar-collapsed' : ''}`}>
      {/* Top Bar */}
      <header className="app-topbar">
        <div className="topbar-left">
          <button
            className="btn-icon sidebar-toggle"
            onClick={toggleSidebar}
            title={collapsed ? '메뉴 펼치기' : '메뉴 접기'}
          >
            {collapsed ? '\u2630' : '\u2715'}
          </button>
          <span className="server-time">{serverTime}</span>
          <CollectionStatus />
        </div>
        <div className="topbar-right">
          {user && <NotificationBell />}
          <ConnectionIndicator />
          <button
            className="btn-icon"
            onClick={toggle}
            title={theme === 'light' ? '다크 모드' : '라이트 모드'}
          >
            {theme === 'light' ? '\uD83C\uDF19' : '\u2600\uFE0F'}
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

      <div className="app-body">
        {/* Sidebar */}
        <aside className="app-sidebar">
          <div className="sidebar-logo">
            <NavLink to="/" className="sidebar-logo-link">
              <span className="sidebar-logo-short">A</span>
              <span className="sidebar-logo-full">Alpha Mind</span>
            </NavLink>
          </div>
          {user && (
            <nav className="sidebar-nav">
              <NavLink to="/trading/balance" title="잔고">
                <span className="nav-icon">W</span>
                {!collapsed && <span className="nav-label">잔고</span>}
              </NavLink>
              <NavLink to="/trading/search" title="종목 조회">
                <span className="nav-icon">Q</span>
                {!collapsed && <span className="nav-label">종목 조회</span>}
              </NavLink>
              <NavLink to="/trading/order" title="매매">
                <span className="nav-icon">T</span>
                {!collapsed && <span className="nav-label">매매</span>}
              </NavLink>
              <NavLink to="/trading/journal" title="매매 일지">
                <span className="nav-icon">J</span>
                {!collapsed && <span className="nav-label">매매 일지</span>}
              </NavLink>
              <NavLink to="/backtest" title="백테스팅">
                <span className="nav-icon">B</span>
                {!collapsed && <span className="nav-label">백테스팅</span>}
              </NavLink>
              <NavLink to="/ai-scanner" title="AI 종목 추천">
                <span className="nav-icon">AI</span>
                {!collapsed && <span className="nav-label">AI 종목 추천</span>}
              </NavLink>
              <NavLink to="/agent-settings" title="Claude 설정">
                <span className="nav-icon">S</span>
                {!collapsed && <span className="nav-label">Claude 설정</span>}
              </NavLink>
              {isAdmin && (
                <NavLink to="/admin/users" className="nav-admin" title="회원 관리">
                  <span className="nav-icon">M</span>
                  {!collapsed && <span className="nav-label">회원 관리</span>}
                </NavLink>
              )}
            </nav>
          )}
        </aside>

        {/* Main Content */}
        <main className="app-main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
