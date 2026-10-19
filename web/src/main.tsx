import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, NavLink, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./styles.css";
import { AuthProvider, useAuth } from "./auth";
import { ToastProvider } from "./components/ui";
import { LoginPage, ChangePasswordPage } from "./pages/Login";
import { BoardPage } from "./pages/Board";
import { PatientPage, PatientsPage } from "./pages/Patient";
import { FollowupsPage } from "./pages/Followups";
import { ActivityPage } from "./pages/Activity";
import { UsersPage } from "./pages/Users";
import { CalendarPage } from "./pages/Calendar";
import { ConfirmationsPage, useConfirmationList } from "./pages/Confirmations";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 20_000, refetchOnWindowFocus: true, retry: (n, e: any) => n < 2 && !(e?.status >= 400 && e?.status < 500) } },
});

const ROLE_WORDS: Record<string, string> = { admin: "Admin", manager: "Manager", staff: "Front desk", doctor: "Doctor", optometrist: "Optometrist", counsellor: "Counsellor" };

function Shell() {
  const { user, logout, can } = useAuth();
  // confirmation calls still to make (same list as the Confirmation calls page)
  const conf = useConfirmationList();
  const due = { data: can("appointments.write") && conf.data ? new Set([...conf.data.oneDay, ...conf.data.fourDay].map((a) => a.id)).size : 0 };
  return (
    <div className="shell">
      <nav className="nav" aria-label="Main">
        <div className="brand"><span className="brand-mark" aria-hidden="true" /><div><b>Sudarshan</b><span>Sampada VR</span></div></div>
        <NavLink to="/" end>Day board</NavLink>
        {can("appointments.write") && <NavLink to="/confirm">Confirmation calls {!!due.data && <span className="count">{due.data}</span>}</NavLink>}
        <NavLink to="/patients">Patients</NavLink>
        <NavLink to="/followups">Follow-up calls</NavLink>
        {can("audit.read") && <NavLink to="/activity">Activity log</NavLink>}
        {can("settings.manage") && <NavLink to="/calendar">Clinic calendar</NavLink>}
        {can("users.manage") && <NavLink to="/users">Users</NavLink>}
        <div className="nav-foot">
          <b>{user!.fullName}</b>{ROLE_WORDS[user!.role]}
          <div><button className="btn-quiet" onClick={() => void logout()}>Log out</button></div>
        </div>
      </nav>
      <main className="main">
        <Routes>
          <Route path="/" element={<BoardPage />} />
          <Route path="/confirm" element={<ConfirmationsPage />} />
          <Route path="/patients" element={<PatientsPage />} />
          <Route path="/patients/:id" element={<PatientPage />} />
          <Route path="/followups" element={<FollowupsPage />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/users" element={<UsersPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function Gate() {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <LoginPage />;
  if (user.mustChangePassword) return <ChangePasswordPage />;
  return <Shell />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ToastProvider>
          <AuthProvider><Gate /></AuthProvider>
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
