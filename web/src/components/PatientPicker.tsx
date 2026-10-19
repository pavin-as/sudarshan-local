import { useEffect, useState } from "react";
import { api } from "../api";
import { niceDate } from "../format";

export interface PickedPatient { patientId: number; mrd: string; name: string; ageYears: number | null; sex: string | null; mobile: string | null; lastVisit: string | null }

/** Find a Yarago patient by MRD, phone or name. */
export function PatientPicker({ onPick, autoFocus }: { onPick: (p: PickedPatient) => void; autoFocus?: boolean }) {
  const [text, setText] = useState("");
  const [results, setResults] = useState<PickedPatient[]>([]);
  const [hl, setHl] = useState(0);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = text.trim();
    if (t.length < 2) { setResults([]); return; }
    const h = setTimeout(async () => {
      setBusy(true);
      try { setResults((await api<{ patients: PickedPatient[] }>(`/patients/search?q=${encodeURIComponent(t)}`)).patients); setHl(0); setOpen(true); }
      catch { setResults([]); }
      finally { setBusy(false); }
    }, 250);
    return () => clearTimeout(h);
  }, [text]);

  const pick = (p: PickedPatient) => { onPick(p); setOpen(false); setText(""); };

  return (
    <div className="picker">
      <input
        type="search" value={text} autoFocus={autoFocus} placeholder="MRD, phone number or name"
        aria-label="Find patient in Yarago" style={{ width: "100%" }}
        onChange={(e) => setText(e.target.value)} onFocus={() => results.length && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (!open || !results.length) return;
          if (e.key === "ArrowDown") { e.preventDefault(); setHl((h) => Math.min(h + 1, results.length - 1)); }
          if (e.key === "ArrowUp") { e.preventDefault(); setHl((h) => Math.max(h - 1, 0)); }
          if (e.key === "Enter") { e.preventDefault(); pick(results[hl]); }
        }}
      />
      {open && (
        <div className="picker-list" role="listbox">
          {results.length === 0 && <div className="empty small">{busy ? "Searching…" : "No patient found in Yarago"}</div>}
          {results.map((p, i) => (
            <button key={p.patientId} type="button" className={i === hl ? "hl" : ""} onMouseDown={(e) => { e.preventDefault(); pick(p); }}>
              <b>{p.mrd}</b>
              <span>{p.name} <span className="muted small">{[p.ageYears != null ? `${p.ageYears} y` : null, p.sex].filter(Boolean).join(", ")}</span></span>
              <span className="muted small">{p.lastVisit ? `last ${niceDate(p.lastVisit)}` : "no visit yet"}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
