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
import { DoctorSummaryPage } from "./pages/DoctorSummary";
import { EmrCompletenessPage } from "./pages/EmrCompleteness";
import { DayPrintPage } from "./pages/DayPrint";
import { FollowupsPage } from "./pages/Followups";
import { ActivityPage } from "./pages/Activity";
import { UsersPage } from "./pages/Users";
import { CalendarPage } from "./pages/Calendar";
import { ConfirmationsPage, useConfirmationList } from "./pages/Confirmations";
import { TodayPage } from "./pages/Today";
import { HuddlePage } from "./pages/Huddle";
import { DirectCallsPage, useDirectCalls } from "./pages/DirectCalls";
import { CancelListPage, useCancelList } from "./pages/CancelList";
import { TriagePage, useTriage } from "./pages/Triage";
import { MonthPage } from "./pages/Month";
import { SettingsPage } from "./pages/Settings";
import { WhatsAppPage } from "./pages/WhatsApp";
import { PaymentsPage } from "./pages/Payments";

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

// Trial (D-025): the Google app is still the master; its records are copied here every 15 minutes and are read-only.
function TrialBanner() {
  const h = useQuery({ queryKey: ["health"], refetchInterval: 10 * 60_000,
    queryFn: () => api<{ googleMaster?: boolean; lastImport?: string | null; lastImportStatus?: string | null }>("/health") });
  if (!h.data?.googleMaster) return null;
  const { lastImport } = h.data;
  const old = !lastImport || Date.now() - new Date(lastImport).getTime() > 60 * 60_000;
  return (
    <div className={`trial-banner${old ? " old" : ""}`} role="status">
      <b>Trial.</b> Bookings, the cancel list, direct calls, triage and the clinic calendar come from the Google app
      ({lastImport ? `copied ${stamp(lastImport)}` : "not copied yet"}{old && lastImport ? ", over an hour ago" : ""}):
      change them there. New bookings here are for practice; name them TEST.
    </div>
  );
}

// payments to check (amount differs, link not made, refund failed): a number on the menu
function usePaymentCounts(enabled: boolean) {
  const r = useQuery({ queryKey: ["payments", "counts"], enabled, refetchInterval: 5 * 60_000,
                       queryFn: () => api<{ counts: { review: number } }>("/payments?view=review") });
  return r.data?.counts.review ?? 0;
}

const ROLE_WORDS: Record<string, string> = { admin: "Admin", manager: "Manager", staff: "Front desk", doctor: "Doctor", optometrist: "Optometrist", counsellor: "Counsellor" };

function Shell() {
  const { user, logout, can } = useAuth();
  // confirmation calls still to make (same list as the Confirmation calls page)
  const conf = useConfirmationList();
  const due = { data: can("appointments.write") && conf.data ? new Set([...conf.data.oneDay, ...conf.data.fourDay].map((a) => a.id)).size : 0 };
  const calls = useDirectCalls("open").data?.counts.open ?? 0;
  const toCallBack = useCancelList("to_call").data?.counts.toCall ?? 0;
  const triagePending = useTriage("pending").data?.pending ?? 0;
  const payReview = usePaymentCounts(can("payments.write"));
  return (
    <div className="shell">
      <nav className="nav" aria-label="Main">
        <div className="brand"><span className="brand-mark" aria-hidden="true" /><div><b>Sudarshan</b><span>Sampada VR</span></div></div>
        <NavLink to="/today">Today</NavLink>
        <NavLink to="/" end>Day board</NavLink>
        <NavLink to="/month">Month</NavLink>
        {can("appointments.write") && <NavLink to="/confirm">Confirmation calls {!!due.data && <span className="count">{due.data}</span>}</NavLink>}
        <NavLink to="/calls">Direct calls {!!calls && <span className="count">{calls}</span>}</NavLink>
        <NavLink to="/cancelled">Cancel list {!!toCallBack && <span className="count">{toCallBack}</span>}</NavLink>
        <NavLink to="/triage">Triage {!!triagePending && <span className="count">{triagePending}</span>}</NavLink>
        <NavLink to="/patients">Patients</NavLink>
        <NavLink to="/followups">Follow-up calls</NavLink>
        {can("messages.send") && <NavLink to="/whatsapp">WhatsApp</NavLink>}
        {can("payments.write") && <NavLink to="/payments">Payments {!!payReview && <span className="count">{payReview}</span>}</NavLink>}
        {can("clinical.read") && <NavLink to="/emr-completeness">EMR completeness</NavLink>}
        {can("audit.read") && <NavLink to="/activity">Activity log</NavLink>}
        {can("settings.manage") && <NavLink to="/calendar">Clinic calendar</NavLink>}
        {can("settings.manage") && <NavLink to="/settings">Settings</NavLink>}
        {can("users.manage") && <NavLink to="/users">Users</NavLink>}
        <div className="nav-foot">
          <b>{user!.fullName}</b>{ROLE_WORDS[user!.role]}
          {can("settings.manage") && <BackupStatus />}
          <div><button className="btn-quiet" onClick={() => void logout()}>Log out</button></div>
        </div>
      </nav>
      <main className="main">
        <TrialBanner />
        <Routes>
          <Route path="/" element={<BoardPage />} />
          <Route path="/today" element={<TodayPage />} />
          <Route path="/huddle" element={<HuddlePage />} />
          <Route path="/calls" element={<DirectCallsPage />} />
          <Route path="/cancelled" element={<CancelListPage />} />
          <Route path="/triage" element={<TriagePage />} />
          <Route path="/month" element={<MonthPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/confirm" element={<ConfirmationsPage />} />
          <Route path="/patients" element={<PatientsPage />} />
          <Route path="/patients/:id" element={<PatientPage />} />
          <Route path="/patients/:id/summary" element={<DoctorSummaryPage />} />
          <Route path="/emr-completeness" element={<EmrCompletenessPage />} />
          <Route path="/print" element={<DayPrintPage />} />
          <Route path="/followups" element={<FollowupsPage />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/users" element={<UsersPage />} />
          <Route path="/whatsapp" element={<WhatsAppPage />} />
          <Route path="/payments" element={<PaymentsPage />} />
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
