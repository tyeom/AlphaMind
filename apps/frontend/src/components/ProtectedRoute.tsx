import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export function ProtectedRoute() {
  const { user, loading } = useAuth();

  if (loading) {
    return <div className="page-loading">로딩 중...</div>;
  }

  if (!user) {
    return <Navigate to="/sign-in" replace />;
  }

  return <Outlet />;
}

export function AdminRoute() {
  const { isAdmin, loading } = useAuth();

  if (loading) {
    return <div className="page-loading">로딩 중...</div>;
  }

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}
