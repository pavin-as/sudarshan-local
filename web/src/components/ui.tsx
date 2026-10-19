import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, type LiveStage, type Status } from "../api";
import { STATUS_WORDS } from "../format";

// ---------- toasts ----------
type Toast = { id: number; text: string; kind: "ok" | "warn" | "err" };
const ToastCtx = createContext<(text: string, kind?: Toast["kind"]) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Toast["kind"] = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "ok" ? 3500 : 7000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// ---------- dialogs ----------
function useEscape(onClose: () => void) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
}

export function Drawer({ title, sub, onClose, children, foot }: { title: ReactNode; sub?: ReactNode; onClose: () => void; children: ReactNode; foot?: ReactNode }) {
  useEscape(onClose);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true" tabIndex={-1} ref={ref}>
        <div className="sheet-head">
          <div className="grow"><h2>{title}</h2>{sub && <div className="muted small">{sub}</div>}</div>
          <button className="btn-quiet" onClick={onClose} aria-label="Close">Close</button>
        </div>
        <div className="sheet-body">{children}</div>
        {foot && <div className="sheet-foot">{foot}</div>}
      </aside>
    </div>
  );
}

export function Dialog({ title, onClose, children, foot, narrow }: { title: ReactNode; onClose: () => void; children: ReactNode; foot?: ReactNode; narrow?: boolean }) {
  useEscape(onClose);
  return (
    <div className="overlay center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog ${narrow ? "narrow" : ""}`} role="dialog" aria-modal="true">
        <div className="sheet-head"><h2 className="grow">{title}</h2><button className="btn-quiet" onClick={onClose}>Close</button></div>
        <div className="sheet-body">{children}</div>
        {foot && <div className="sheet-foot">{foot}</div>}
      </div>
    </div>
  );
}

// ---------- errors from the API, with the server's own words ----------
export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as ApiError;
  const problems: string[] = e.details?.problems ?? [];
  return (
    <div className="notice error" role="alert">
      {e.message ?? String(error)}
      {problems.length > 1 && <ul>{problems.slice(1).map((p) => <li key={p}>{p}</li>)}</ul>}
    </div>
  );
}

export function StatusPill({ status }: { status: Status }) {
  return <span className={`pill ${status}`}>{STATUS_WORDS[status] ?? status}</span>;
}

// ---------- where the patient is today (from Yarago) ----------
const STEPS: Record<string, { n: number; label: string }> = {
  registered_not_arrived: { n: 0, label: "Registered" },
  arrived: { n: 1, label: "Arrived" },
  optometry: { n: 2, label: "Optometry" },
  waiting_for_doctor: { n: 3, label: "Waiting for doctor" },
  with_doctor: { n: 4, label: "With doctor" },
  done: { n: 5, label: "Done" },
  cancelled_in_yarago: { n: 0, label: "Cancelled in Yarago" },
};
export function StageTrack({ stage, checkIn }: { stage: LiveStage; checkIn?: string | null }) {
  if (!stage) return null;
  const s = STEPS[stage];
  return (
    <span className="row" style={{ gap: "0.4rem" }} title={checkIn ? `Checked in ${checkIn}` : undefined}>
      <span className={`track ${stage === "done" ? "done" : ""}`} aria-hidden="true">
        {[1, 2, 3, 4, 5].map((i) => <i key={i} className={i <= s.n ? "on" : ""} />)}
      </span>
      <span className="track-label">{s.label}</span>
    </span>
  );
}

export function Tags({ tags }: { tags: string[] }) {
  return <>{tags.map((t) => <span key={t} className={`tag ${/vip|bni/i.test(t) ? "vip" : /urgent|wheel/i.test(t) ? "alert" : ""}`}>{t}</span>)}</>;
}

export function Loading() { return <div className="empty">Loading…</div>; }
