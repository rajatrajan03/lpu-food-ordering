import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { getAuth } from "./api/client";
import Login from "./pages/Login";
import OwnerDashboard from "./pages/OwnerDashboard";
import AdminDashboard from "./pages/AdminDashboard";

function RequireRole({ role, children }: { role: "stall_owner" | "super_admin"; children: React.ReactNode }) {
  const auth = getAuth();
  if (!auth || auth.role !== role) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Login />} />
        <Route
          path="/owner"
          element={
            <RequireRole role="stall_owner">
              <OwnerDashboard />
            </RequireRole>
          }
        />
        <Route
          path="/admin"
          element={
            <RequireRole role="super_admin">
              <AdminDashboard />
            </RequireRole>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
