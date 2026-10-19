import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type Meta } from "../api";
import { useAuth } from "../auth";
import { dayLabel } from "../format";
import { Dialog, ErrorNotice, useToast } from "./ui";
import { PatientPicker, type PickedPatient } from "./PatientPicker";
import { DateStrip, SlotPicker } from "./SlotPicker";

export const COMMON_TAGS = ["VIP", "BNI", "Wheelchair", "Kids", "Urgent", "SVV advised"];

export function useMeta() {
  return useQuery({ queryKey: ["meta"], staleTime: 5 * 60_000, queryFn: () => api<Meta>("/meta") });
}
export function listOf(meta: Meta | undefined, key: string): string[] {
  const v = meta?.lists?.[key];
  return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
}

export interface BookPreset { date: string; slotTime?: string | null; patient?: PickedPatient; source?: "booking" | "direct_call" | "followup" | "cancel_list"; sourceRef?: string; remarks?: string }

export function BookDialog({ preset, onClose, onBooked }: { preset: BookPreset; onClose: () => void; onBooked?: (id: number) => void }) {
  const meta = useMeta();
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [patient, setPatient] = useState<PickedPatient | null>(preset.patient ?? null);
  const [newPatient, setNewPatient] = useState(false);
  const [np, setNp] = useState({ name: "", phone: "", age: "", gender: "" });
  const [date, setDate] = useState(preset.date);
  const [slot, setSlot] = useState<string | null>(preset.slotTime ?? null);
  const [doctorId, setDoctorId] = useState<number | null>(null);
  const [f, setF] = useState({ appointmentType: "", patientType: "", planOfAction: "", urgency: "", familyGroup: "", remarks: preset.remarks ?? "" });
  const [tags, setTags] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [override, setOverride] = useState("");
  const [busy, setBusy] = useState(false);

  const types = listOf(meta.data, "Appointment Type List");
  const ptypes = listOf(meta.data, "Patient Type");
  const refused = error instanceof ApiError && error.code === "booking_refused";
  const freeSlots: string[] = refused ? (error as ApiError).details?.freeSlots ?? [] : [];
  const canOverride = can("settings.manage") && refused && ((error as ApiError).details?.problems ?? []).some((p: string) => /full|already booked for/.test(p));

  const submit = async () => {
    setError(null);
    if (!patient && !(newPatient && np.name.trim())) { setError(new Error("Choose a patient from Yarago, or enter a new patient's name")); return; }
    setBusy(true);
    try {
      const body: any = {
        date, slotTime: slot, doctorId, ...Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.trim() || null])),
        tags, source: preset.source, sourceRef: preset.sourceRef,
        ...(patient ? { patientId: patient.patientId } : {
          patientName: np.name.trim(), phone: np.phone.trim() || null, ageYears: np.age ? Number(np.age) : null, gender: np.gender || null,
        }),
        ...(override.trim() ? { override: { reason: override.trim() } } : {}),
      };
      const r = await api("/appointments", { body });
      toast(`Booked ${r.appointment.patientName} for ${dayLabel(date)}${slot ? ` at ${slot}` : " (waitlist)"}`);
      for (const w of r.warnings ?? []) toast(w, "warn");
      await qc.invalidateQueries();
      onBooked?.(r.appointment.id);
      onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  return (
    <Dialog title="Book appointment" onClose={onClose}
      foot={<>
        <button onClick={onClose}>Cancel</button>
        <button className="btn-primary" onClick={() => void submit()} disabled={busy}>{busy ? "Booking…" : slot ? `Book ${dayLabel(date)} ${slot}` : "Add to waitlist"}</button>
      </>}>
      <section className="stack">
        <h3>Patient</h3>
        {patient ? (
          <div className="chosen">
            <div className="grow"><b>{patient.name}</b> <span className="muted">{patient.mrd} · {[patient.ageYears != null && `${patient.ageYears} y`, patient.sex, patient.mobile].filter(Boolean).join(", ")}</span></div>
            <button className="btn-small" onClick={() => setPatient(null)}>Change</button>
          </div>
        ) : newPatient ? (
          <div className="fields">
            <label className="field wide"><span>Name</span><input value={np.name} onChange={(e) => setNp({ ...np, name: e.target.value })} autoFocus /></label>
            <label className="field"><span>Phone</span><input value={np.phone} inputMode="tel" onChange={(e) => setNp({ ...np, phone: e.target.value })} /></label>
            <label className="field"><span>Age</span><input value={np.age} inputMode="numeric" onChange={(e) => setNp({ ...np, age: e.target.value.replace(/\D/g, "") })} /></label>
            <label className="field"><span>Gender</span>
              <select value={np.gender} onChange={(e) => setNp({ ...np, gender: e.target.value })}><option value="" /><option>Female</option><option>Male</option><option>Other</option></select></label>
            <div className="wide"><button className="btn-quiet" onClick={() => setNewPatient(false)}>Search Yarago instead</button></div>
          </div>
        ) : (
          <>
            <PatientPicker onPick={setPatient} autoFocus />
            <div><button className="btn-quiet" onClick={() => setNewPatient(true)}>New patient, not in Yarago yet</button></div>
          </>
        )}
      </section>

      <section className="stack">
        <div className="row"><h3 className="grow">When</h3>
          <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: "0.4rem" }}><span>Doctor</span>
            <select value={doctorId ?? ""} onChange={(e) => setDoctorId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">Any</option>
              {(meta.data?.doctors ?? []).filter((d) => d.isActive).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select></label>
        </div>
        <DateStrip value={date} onChange={(d) => { setDate(d); setSlot(null); }} />
        <SlotPicker date={date} value={slot} onChange={setSlot} doctorId={doctorId} />
      </section>

      <section className="fields">
        <label className="field"><span>Visit type</span>
          <input list="appt-types" value={f.appointmentType} onChange={(e) => setF({ ...f, appointmentType: e.target.value })} />
          <datalist id="appt-types">{types.map((t) => <option key={t} value={t} />)}</datalist></label>
        <label className="field"><span>Patient type</span>
          <input list="patient-types" value={f.patientType} placeholder={patient ? "Old" : "New"} onChange={(e) => setF({ ...f, patientType: e.target.value })} />
          <datalist id="patient-types">{ptypes.map((t) => <option key={t} value={t} />)}</datalist></label>
        <label className="field"><span>Plan of action</span>
          <input list="plans" value={f.planOfAction} onChange={(e) => setF({ ...f, planOfAction: e.target.value })} />
          <datalist id="plans">{(meta.data?.plansOfAction ?? []).map((p) => <option key={p.name} value={p.name} />)}</datalist></label>
        <label className="field"><span>Urgency</span>
          <select value={f.urgency} onChange={(e) => setF({ ...f, urgency: e.target.value })}><option value="">Routine</option><option>Urgent</option><option>Emergency</option></select></label>
        <label className="field"><span>Family group</span><input value={f.familyGroup} placeholder="same word for family members" onChange={(e) => setF({ ...f, familyGroup: e.target.value })} /></label>
        <div className="field wide"><span style={{ fontWeight: 700, color: "var(--ink)" }}>Special cases</span>
          <div className="row">{COMMON_TAGS.map((t) => (
            <label key={t} className="check"><input type="checkbox" checked={tags.includes(t)} onChange={(e) => setTags(e.target.checked ? [...tags, t] : tags.filter((x) => x !== t))} />{t}</label>
          ))}</div></div>
        <label className="field wide"><span>Remarks</span><textarea value={f.remarks} onChange={(e) => setF({ ...f, remarks: e.target.value })} /></label>
      </section>

      {error && <ErrorNotice error={error} />}
      {freeSlots.length > 0 && (
        <div className="row small"><span className="muted">Free nearby:</span>
          {freeSlots.map((t) => <button key={t} className="btn-small" onClick={() => { setSlot(t); setError(null); }}>{t}</button>)}</div>
      )}
      {canOverride && (
        <label className="field"><span>Book anyway (manager): reason</span>
          <input value={override} onChange={(e) => setOverride(e.target.value)} placeholder="e.g. urgent RD, doctor agreed" /></label>
      )}
    </Dialog>
  );
}
