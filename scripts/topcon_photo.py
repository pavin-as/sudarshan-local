"""Colour fundus photographs from one Topcon DICOM OCT Export Tool output folder (D-048, docs/OCT_PLAN.md Step 3).

Run by Sudarshan's Topcon import (server/src/services/topconImport.ts) in the isolated Python on shichika:
  D:\\Sudarshan\\tools\\oct-venv\\Scripts\\python.exe -I scripts\\topcon_photo.py <export folder> <out folder>
For every colour Ophthalmic Photography object (OP, image type ...\\COLOR; the infrared OP is left out) it writes
  <out>\\photo<n>.jpg (quality 95), <out>\\photo<n>_thumb.jpg (400 px) and <out>\\photo<n>.dcm (the OP object as exported)
and prints one JSON line on stdout with what Sudarshan stores: the patient ID (to link the Yarago patient by SPD number),
sex, eye, time, protocol, device, UIDs and size. It never prints the patient's name or birth date, and writes nothing
but the out folder (the caller removes it).
"""
import json
import shutil
import sys
from pathlib import Path

import numpy as np
import pydicom
from PIL import Image

OP_8BIT = "1.2.840.10008.5.1.4.1.1.77.1.5.1"


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


def main():
    src, out = Path(sys.argv[1]), Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    photos, other_op, other = [], 0, 0
    for f in sorted(src.rglob("*.dcm")):
        ds = pydicom.dcmread(f)
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
    print(json.dumps({"photos": photos, "otherOp": other_op, "otherObjects": other}))


if __name__ == "__main__":
    sys.exit(main())
