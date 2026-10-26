"""Colour fundus photographs and OCT / OCTA views from one Topcon DICOM OCT Export Tool output folder (D-048 Step 3,
D-049 Step 4 of docs/OCT_PLAN.md).

Run by Sudarshan's Topcon import (server/src/services/topconImport.ts) in the isolated Python on shichika:
  D:\\Sudarshan\\tools\\oct-venv\\Scripts\\python.exe -I scripts\\topcon_photo.py <export folder> <out folder> [--oct <dir>]
For every colour Ophthalmic Photography object (OP, image type ...\\COLOR; the infrared OP is left out) it writes
  <out>\\photo<n>.jpg (quality 95), <out>\\photo<n>_thumb.jpg (400 px) and <out>\\photo<n>.dcm (the OP object as exported).
With --oct, for the exam's tomography (OPT) it also writes into <dir>, for Sudarshan's OCT viewer:
  b001.jpg ... every B-scan (quality 90), oct.json (geometry, scan lines on the colour photograph in its pixels, layer
  names, slabs), layers.bin (Topcon's layer heights, int16 rows x10, -1 where missing, shape in oct.json) and, for
  OCTA, slab<n>.png (the en face slabs with their definition).
It prints one JSON line on stdout with what Sudarshan stores: the patient ID (to link the Yarago patient by SPD number),
sex, eye, time, protocol, device, UIDs, sizes. It never prints the patient's name or birth date, and writes nothing
but the out folders (the caller removes them).
"""
import json
import shutil
import sys
from pathlib import Path

import numpy as np
import pydicom
from PIL import Image

OP_8BIT = "1.2.840.10008.5.1.4.1.1.77.1.5.1"
OPT = "1.2.840.10008.5.1.4.1.1.77.1.5.4"
OPTENF = "1.2.840.10008.5.1.4.1.1.77.1.5.7"
HEIGHT_MAP_SEG = "1.2.840.10008.5.1.4.1.1.66.8"
OPTBSV = "1.2.840.10008.5.1.4.1.1.77.1.5.8"


def field_of(protocol):
    """3D H/Macula/320/... -> MACULA; Disc -> DISC; anything else (Wide, ...) -> OTHER."""
    parts = str(protocol or "").split("/")
    fix = parts[1].strip().lower() if len(parts) > 1 else ""
    return {"macula": "MACULA", "disc": "DISC"}.get(fix, "OTHER" if fix else None)


def when(ds):
    """Acquisition time as ISO text in clinic time (DICOM times on the Maestro2 have no offset)."""
    dt = str(ds.get("AcquisitionDateTime", "") or "")
    if len(dt) < 12:
        d, t = str(ds.get("ContentDate", "") or ds.get("StudyDate", "")), str(ds.get("ContentTime", "") or ds.get("StudyTime", ""))
        dt = d + t
    if len(dt) < 12 or not dt[:12].isdigit():
        return None
    ss = dt[12:14] if len(dt) >= 14 and dt[12:14].isdigit() else "00"
    return f"{dt[0:4]}-{dt[4:6]}-{dt[6:8]}T{dt[8:10]}:{dt[10:12]}:{ss}+05:30"


def rgb(ds):
    a = ds.pixel_array                         # JPEG 2000 YBR_ICT / YBR_RCT come out as RGB (the decoder undoes the transform)
    if a.ndim == 2:
        a = np.stack([a] * 3, axis=-1)
    if a.dtype != np.uint8:
        a = (a.astype(np.float32) / max(float(a.max()), 1.0) * 255).astype(np.uint8)
    return a


def to8(a):
    a = a.astype(np.float32)
    lo, hi = np.percentile(a, 0.5), np.percentile(a, 99.8)
    return (np.clip((a - lo) / max(hi - lo, 1e-6), 0, 1) * 255).astype(np.uint8)


def frame_ref(g):
    """The B-scan frame (0-based) a height-map frame describes, from its source image reference."""
    src = g.DerivationImageSequence[0].SourceImageSequence[0]
    n = src.ReferencedFrameNumber
    return int(n[0] if isinstance(n, pydicom.multival.MultiValue) else n) - 1


def scan_line(g):
    """A B-scan's place on the photograph it refers to: [x1, y1, x2, y2, ...] in that photograph's pixels."""
    if "OphthalmicFrameLocationSequence" not in g:
        return None, None
    fl = g.OphthalmicFrameLocationSequence[0]
    c = [float(x) for x in fl.ReferenceCoordinates]          # DICOM: row, column pairs
    return [round(v, 1) for pair in zip(c[1::2], c[0::2]) for v in pair], str(fl.get("ReferencedSOPInstanceUID", ""))


def oct_views(objs, colour_sop, out):
    """B-scans, scan lines, layers and slabs of the exam's OPT for the viewer; None if the exam has no tomography."""
    opts = [ds for ds in objs if str(ds.SOPClassUID) == OPT and "PixelData" in ds]
    if not opts:
        return None
    opt = max(opts, key=lambda d: int(d.get("NumberOfFrames", 1) or 1))
    out.mkdir(parents=True, exist_ok=True)
    vol = opt.pixel_array
    if vol.ndim == 2:
        vol = vol[None]
    for i, frame in enumerate(vol):
        Image.fromarray(to8(frame)).save(out / f"b{i + 1:03d}.jpg", quality=90)
    lines, refs = [], set()
    for g in (opt.get("PerFrameFunctionalGroupsSequence") or []):
        line, ref = scan_line(g)
        lines.append(line); refs.add(ref)
    pm = opt.SharedFunctionalGroupsSequence[0].PixelMeasuresSequence[0] if "SharedFunctionalGroupsSequence" in opt else None
    spacing = {"axialMm": float(pm.PixelSpacing[0]), "lateralMm": float(pm.PixelSpacing[1]),
               "betweenMm": float(pm.SliceThickness) if "SliceThickness" in pm and pm.SliceThickness else None} if pm else None
    info = {"sopUid": str(opt.SOPInstanceUID), "studyUid": str(opt.StudyInstanceUID), "protocol": str(opt.get("ProtocolName", "")) or None,
            "series": str(opt.get("SeriesDescription", "")) or None, "frames": int(vol.shape[0]), "rows": int(vol.shape[1]),
            "cols": int(vol.shape[2]), "spacing": spacing, "scanLines": lines if any(lines) else None,
            "linesOnColourPhoto": bool(colour_sop) and refs == {colour_sop}, "layers": None, "slabs": [],
            "flow": any(str(ds.SOPClassUID) == OPTBSV for ds in objs)}
    # Topcon's layer surfaces (height map): per B-scan, per surface, the row of the surface in every column
    seg = next((ds for ds in objs if str(ds.SOPClassUID) == HEIGHT_MAP_SEG), None)
    if seg is not None:
        hm = seg.pixel_array.astype(np.float32)
        labels = {int(s.SegmentNumber): str(s.SegmentLabel) for s in seg.SegmentSequence}
        order = sorted(labels)
        grid = np.full((info["frames"], len(order), info["cols"]), -1, dtype=np.int16)
        for i, g in enumerate(seg.PerFrameFunctionalGroupsSequence):
            s = order.index(int(g.SegmentIdentificationSequence[0].ReferencedSegmentNumber))
            if hm.shape[1] == 1:                             # one row per (surface, B-scan): radial, line scans
                b = frame_ref(g)
                if 0 <= b < info["frames"]:
                    grid[b, s] = np.where(np.isfinite(hm[i, 0]), np.round(hm[i, 0] * 10), -1)
            else:                                            # a whole surface: row b of the grid is B-scan b
                rows = min(hm.shape[1], info["frames"])
                grid[:rows, s] = np.where(np.isfinite(hm[i, :rows]), np.round(hm[i, :rows] * 10), -1)
        grid.tofile(out / "layers.bin")
        info["layers"] = {"labels": [labels[k] for k in order], "shape": list(grid.shape), "scale": 10}
    for ds in sorted((d for d in objs if str(d.SOPClassUID) == OPTENF), key=lambda d: int(d.get("InstanceNumber", 0) or 0)):
        k = len(info["slabs"]) + 1
        Image.fromarray(to8(ds.pixel_array)).save(out / f"slab{k}.png")
        definition = str(ds.get("ImageComments", "") or "")
        info["slabs"].append({"file": f"slab{k}.png", "label": definition.split(",")[0].strip() or f"Slab {k}", "definition": definition,
                              "sizePx": [int(ds.Rows), int(ds.Columns)],
                              "spacingMm": [float(x) for x in ds.PixelSpacing] if "PixelSpacing" in ds else None})
    (out / "oct.json").write_text(json.dumps(info))
    lat = str(opt.get("ImageLaterality", "") or opt.get("Laterality", "")).upper()
    return {k: info[k] for k in ("sopUid", "studyUid", "protocol", "frames", "rows", "cols", "spacing", "flow")} | {
        "layers": info["layers"]["labels"] if info["layers"] else None, "slabs": [s["label"] for s in info["slabs"]],
        "linesOnColourPhoto": info["linesOnColourPhoto"], "patientId": str(opt.get("PatientID", "") or ""),
        "sex": str(opt.get("PatientSex", "") or "")[:1].upper() or None, "eye": {"R": "RE", "L": "LE"}.get(lat),
        "capturedAt": when(opt), "device": str(opt.get("ManufacturerModelName", "") or "") or None}


def main():
    src, out = Path(sys.argv[1]), Path(sys.argv[2])
    oct_dir = Path(sys.argv[sys.argv.index("--oct") + 1]) if "--oct" in sys.argv else None
    out.mkdir(parents=True, exist_ok=True)
    photos, other_op, other = [], 0, 0
    objs = []
    for f in sorted(src.rglob("*.dcm")):
        ds = pydicom.dcmread(f)
        objs.append(ds)
        if str(ds.SOPClassUID) != OP_8BIT:
            other += 1
            continue
        kind = [str(x).upper() for x in (ds.get("ImageType") or [])]
        if len(kind) < 4 or kind[3] != "COLOR":
            other_op += 1                      # the infrared photograph, or an OP Sudarshan does not show
            continue
        n = len(photos) + 1
        img = Image.fromarray(rgb(ds))
        img.save(out / f"photo{n}.jpg", quality=95, subsampling=0)
        thumb = img.copy()
        thumb.thumbnail((400, 400))
        thumb.save(out / f"photo{n}_thumb.jpg", quality=85)
        shutil.copyfile(f, out / f"photo{n}.dcm")
        lat = str(ds.get("ImageLaterality", "") or ds.get("Laterality", "")).upper()
        photos.append({
            "base": f"photo{n}",
            "patientId": str(ds.get("PatientID", "") or ""),
            "sex": str(ds.get("PatientSex", "") or "")[:1].upper() or None,
            "eye": {"R": "RE", "L": "LE"}.get(lat),
            "capturedAt": when(ds),
            "protocol": str(ds.get("ProtocolName", "") or "") or None,
            "field": field_of(ds.get("ProtocolName")),
            "device": str(ds.get("ManufacturerModelName", "") or "") or None,
            "studyUid": str(ds.get("StudyInstanceUID", "") or "") or None,
            "sopUid": str(ds.SOPInstanceUID),
            "width": int(img.width), "height": int(img.height),
            "pixelSpacingMm": [float(x) for x in ds.PixelSpacing] if "PixelSpacing" in ds else None,
        })
    octs = oct_views(objs, photos[0]["sopUid"] if photos else None, oct_dir) if oct_dir else None
    print(json.dumps({"photos": photos, "otherOp": other_op, "otherObjects": other, "oct": octs}))


if __name__ == "__main__":
    sys.exit(main())
