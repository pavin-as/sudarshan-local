import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, NavLink, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { stamp } from "./format";
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
import { TodayPage } from "./pages/Today";
import { HuddlePage } from "./pages/Huddle";
import { DirectCallsPage, useDirectCalls } from "./pages/DirectCalls";
import { CancelListPage, useCancelList } from "./pages/CancelList";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 20_000, refetchOnWindowFocus: true, retry: (n, e: any) => n < 2 && !(e?.status >= 400 && e?.status < 500) } },
});

// Managers and admins see whether last night's backup worked (scripts/backup.ps1 records it).
function BackupStatus() {
  const h = useQuery({ queryKey: ["health"], refetchInterval: 10 * 60_000,
    queryFn: () => api<{ lastBackup: string | null; lastBackupStatus: string | null }>("/health") });
  if (!h.data) return null;
  const { lastBackup, lastBackupStatus } = h.data;
  const ageH = lastBackup ? (Date.now() - new Date(lastBackup).getTime()) / 3_600_000 : Infinity;
  const bad = lastBackupStatus === "failed" || ageH > 36;
  return (
    <div className={`backup-status${bad ? " bad" : ""}`} title="Nightly backup of Sudarshan to the QNAP">
      {lastBackupStatus === "failed" ? "Last backup failed" : lastBackup ? `Backup ${stamp(lastBackup)}` : "No backup yet"}
      {bad && lastBackupStatus !== "failed" && lastBackup ? " (over a day old)" : ""}
    </div>
  );
}

const ROLE_WORDS: Record<string, string> = { admin: "Admin", manager: "Manager", staff: "Front desk", doctor: "Doctor", optometrist: "Optometrist", counsellor: "Counsellor" };

function Shell() {
  const { user, logout, can } = useAuth();
  // confirmation calls still to make (same list as the Confirmation calls page)
  const conf = useConfirmationList();
  const due = { data: can("appointments.write") && conf.data ? new Set([...conf.data.oneDay, ...conf.data.fourDay].map((a) => a.id)).size : 0 };
  const calls = useDirectCalls("open").data?.counts.open ?? 0;
  const toCallBack = useCancelList("to_call").data?.counts.toCall ?? 0;
  return (
    <div className="shell">
      <nav className="nav" aria-label="Main">
        <div className="brand"><span className="brand-mark" aria-hidden="true" /><div><b>Sudarshan</b><span>Sampada VR</span></div></div>
        <NavLink to="/today">Today</NavLink>
        <NavLink to="/" end>Day board</NavLink>
        {can("appointments.write") && <NavLink to="/confirm">Confirmation calls {!!due.data && <span className="count">{due.data}</span>}</NavLink>}
        <NavLink to="/calls">Direct calls {!!calls && <span className="count">{calls}</span>}</NavLink>
        <NavLink to="/cancelled">Cancel list {!!toCallBack && <span className="count">{toCallBack}</span>}</NavLink>
        <NavLink to="/patients">Patients</NavLink>
        <NavLink to="/followups">Follow-up calls</NavLink>
        {can("audit.read") && <NavLink to="/activity">Activity log</NavLink>}
        {can("settings.manage") && <NavLink to="/calendar">Clinic calendar</NavLink>}
        {can("users.manage") && <NavLink to="/users">Users</NavLink>}
        <div className="nav-foot">
          <b>{user!.fullName}</b>{ROLE_WORDS[user!.role]}
          {can("settings.manage") && <BackupStatus />}
          <div><button className="btn-quiet" onClick={() => void logout()}>Log out</button></div>
        </div>
      </nav>
      <main className="main">
        <Routes>
          <Route path="/" element={<BoardPage />} />
          <Route path="/today" element={<TodayPage />} />
          <Route path="/huddle" element={<HuddlePage />} />
          <Route path="/calls" element={<DirectCallsPage />} />
          <Route path="/cancelled" element={<CancelListPage />} />
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
