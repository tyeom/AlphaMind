import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { Layout } from './components/Layout';
import { ProtectedRoute, AdminRoute } from './components/ProtectedRoute';
import { Dashboard } from './pages/Dashboard';
import { SignIn } from './pages/SignIn';
import { SignUp } from './pages/SignUp';
import { Profile } from './pages/Profile';
import { UserList } from './pages/admin/UserList';
import { UserEdit } from './pages/admin/UserEdit';
import { Balance } from './pages/trading/Balance';
import { StockSearch } from './pages/trading/StockSearch';
import { Order } from './pages/trading/Order';
import { Journal } from './pages/trading/Journal';
import { Backtest } from './pages/Backtest';
import { AiScanner } from './pages/AiScanner';
import { AgentSettings } from './pages/AgentSettings';

export default function App() {
  return (
    <BrowserRouter>
      <ThemeProvider>
        <AuthProvider>
          <Routes>
            <Route element={<Layout />}>
              <Route path="/" element={<Dashboard />} />
              <Route path="/sign-in" element={<SignIn />} />
              <Route path="/sign-up" element={<SignUp />} />

              <Route element={<ProtectedRoute />}>
                <Route path="/profile" element={<Profile />} />
                <Route path="/trading/balance" element={<Balance />} />
                <Route path="/trading/search" element={<StockSearch />} />
                <Route path="/trading/order" element={<Order />} />
                <Route path="/trading/journal" element={<Journal />} />
                <Route path="/backtest" element={<Backtest />} />
                <Route path="/ai-scanner" element={<AiScanner />} />
                <Route path="/agent-settings" element={<AgentSettings />} />

                <Route element={<AdminRoute />}>
                  <Route path="/admin/users" element={<UserList />} />
                  <Route path="/admin/users/:id" element={<UserEdit />} />
                </Route>
              </Route>
            </Route>
          </Routes>
        </AuthProvider>
      </ThemeProvider>
    </BrowserRouter>
  );
}
