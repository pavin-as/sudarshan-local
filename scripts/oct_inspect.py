"""Inspect a Topcon DICOM OCT Export Tool output folder (D-047, docs/OCT_PLAN.md Steps 1-2).

Prints technical facts only: object types, transfer syntax, frames, size, spacing, laterality, scan position data,
whether pixel data decodes. Identifiers are reported as present / empty and, for the patient ID, as a format
(digits -> 9); never their values. Preview PNGs go to --renders (keep it inside D:\\Sudarshan\\data\\oct, admin only);
a person looks at them on shichika. They are never sent anywhere.

  D:\\Sudarshan\\tools\\oct-venv\\Scripts\\python.exe -I scripts\\oct_inspect.py <export folder> --renders <folder>
"""
import argparse
import re
import sys
from pathlib import Path

import numpy as np
import pydicom
from PIL import Image
from pydicom.uid import UID

IDENT_TAGS = ["PatientName", "PatientID", "PatientBirthDate", "PatientSex", "OtherPatientIDs", "PatientAge",
              "InstitutionName", "ReferringPhysicianName", "OperatorsName", "PerformingPhysicianName",
              "AccessionNumber", "StudyDate", "StudyTime", "AcquisitionDateTime", "DeviceSerialNumber",
              "ImageComments", "StudyDescription"]   # free text can hold anything typed: reported as present only
INFO_TAGS = ["Modality", "Manufacturer", "ManufacturerModelName", "SoftwareVersions", "SeriesDescription",
             "ProtocolName", "ImageType", "ImageLaterality", "Laterality", "BurnedInAnnotation",
             "Rows", "Columns", "NumberOfFrames", "SamplesPerPixel", "PhotometricInterpretation", "BitsAllocated",
             "PixelSpacing", "SliceThickness"]


def id_format(v):
    s = str(v)
    m = re.match(r"^[A-Za-z]{1,4}", s)          # a short letter prefix such as SPD is not identifying
    prefix = m.group(0).upper() if m else ""
    return prefix + re.sub(r"[A-Za-z]", "A", re.sub(r"[0-9]", "9", s[len(prefix):]))


def suffix(name):
    m = re.search(r"(\.\d+\.\d+)\.dcm$", name)  # Topcon names end in .<object>.<n>.dcm
    return m.group(1) if m else name[-12:]


def find_seq(ds, keyword):
    """Does this keyword appear anywhere in the dataset (nested too)?"""
    found = []
    def walk(d):
        for el in d:
            if el.keyword == keyword:
                found.append(el)
            if el.VR == "SQ":
                for item in el.value:
                    walk(item)
    walk(ds)
    return found


def spacing(ds):
    out = {}
    if "PixelSpacing" in ds:
        out["top"] = [float(x) for x in ds.PixelSpacing]
    for grp in ("SharedFunctionalGroupsSequence", "PerFrameFunctionalGroupsSequence"):
        if grp in ds and len(ds[grp].value):
            item = ds[grp].value[0]
            if "PixelMeasuresSequence" in item:
                pm = item.PixelMeasuresSequence[0]
                out[grp.replace("FunctionalGroupsSequence", "")] = {
                    "PixelSpacing": [float(x) for x in pm.get("PixelSpacing", [])],
                    "SliceThickness": float(pm.SliceThickness) if "SliceThickness" in pm else None}
    return out


def to8(a):
    a = a.astype(np.float32)
    lo, hi = np.percentile(a, 0.5), np.percentile(a, 99.5)
    return (np.clip((a - lo) / max(hi - lo, 1e-6), 0, 1) * 255).astype(np.uint8)


def render(ds, arr, base, renders):
    renders.mkdir(parents=True, exist_ok=True)
    frames = int(ds.get("NumberOfFrames", 1) or 1)
    colour = int(ds.get("SamplesPerPixel", 1)) == 3
    saved = []
    if frames > 1 and not colour:
        for i in sorted({0, frames // 2, frames - 1}):
            p = renders / f"{base}_frame{i + 1:03d}of{frames}.png"
            Image.fromarray(to8(arr[i])).save(p); saved.append(p.name)
        if arr.ndim == 3:                             # projection across frames: a rough en face check
            p = renders / f"{base}_projection.png"
            Image.fromarray(to8(arr.mean(axis=1))).save(p); saved.append(p.name)
    else:
        img = arr[0] if frames > 1 else arr
        p = renders / f"{base}.png"
        Image.fromarray(img if colour else to8(img)).save(p); saved.append(p.name)
    return saved


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folder")
    ap.add_argument("--renders")
    a = ap.parse_args()
    files = sorted(Path(a.folder).rglob("*.dcm"))
    print(f"DICOM files: {len(files)}  total {sum(f.stat().st_size for f in files) / 1e6:.1f} MB")
    others = [f for f in Path(a.folder).rglob("*") if f.is_file() and f.suffix.lower() != ".dcm"]
    if others:
        print("other files: " + ", ".join(sorted({f.suffix.lower() or "(none)" for f in others})) + f" ({len(others)})")
    ids_seen = {}
    for f in files:
        ds = pydicom.dcmread(f)
        sop = UID(ds.SOPClassUID)
        ts = ds.file_meta.TransferSyntaxUID
        print(f"\n== object {suffix(f.name)}  {f.stat().st_size / 1e6:.1f} MB")
        print(f"   SOP class: {sop.name} ({sop})")
        print(f"   transfer syntax: {UID(ts).name} ({ts})")
        name = [w for w in str(ds.get("PatientName", "")).replace("^", " ").split() if len(w) > 2]
        for t in INFO_TAGS:
            if t in ds and ds[t].value not in (None, ""):
                v = ds[t].value
                v = list(v) if isinstance(v, pydicom.multival.MultiValue) else v
                if any(w.lower() in str(v).lower() for w in name):
                    v = "(hidden: contains the patient's name)"
                print(f"   {t}: {v}")
        sp = spacing(ds)
        print(f"   spacing (mm): {sp if sp else 'none found'}")
        pf = ds.get("PerFrameFunctionalGroupsSequence")
        if pf is not None:
            print(f"   per-frame groups: {len(pf)}")
        for kw in ("OphthalmicFrameLocationSequence", "ReferencedImageSequence", "SourceImageSequence",
                   "SegmentSequence", "ReferencedSeriesSequence", "DimensionIndexSequence"):
            n = find_seq(ds, kw)
            if n:
                print(f"   has {kw} (x{len(n)})")
        if "PixelData" in ds or "FloatPixelData" in ds or "DoubleFloatPixelData" in ds:
            try:
                arr = ds.pixel_array
                print(f"   pixels decode: yes  shape {arr.shape} {arr.dtype}  min {arr.min()} max {arr.max()} "
                      f"mean {arr.mean():.1f}  blank: {'YES' if arr.max() == arr.min() else 'no'}")
                if a.renders:
                    print("   preview: " + ", ".join(render(ds, arr, f"obj{suffix(f.name)}", Path(a.renders))))
            except Exception as e:                    # report, keep going
                print(f"   pixels decode: NO ({type(e).__name__}: {e})")
        else:
            print("   no pixel data")
        present = []
        for t in IDENT_TAGS:
            if t in ds and str(ds[t].value).strip():
                present.append(t)
                if t == "PatientID":
                    ids_seen.setdefault(id_format(ds[t].value), 0)
                    ids_seen[id_format(ds[t].value)] += 1
        print(f"   identifiers present: {', '.join(present) if present else 'none'}")
        hits = sorted({el.keyword or str(el.tag) for el in ds.iterall()
                       if el.VR in ("LO", "LT", "SH", "ST", "UT", "PN") and el.keyword != "PatientName"
                       and any(w.lower() in str(el.value).lower() for w in name)})
        if hits:
            print(f"   patient name also appears in: {', '.join(hits)}")
    print(f"\npatient ID format(s): {ids_seen if ids_seen else 'none'}")


if __name__ == "__main__":
    sys.exit(main())
