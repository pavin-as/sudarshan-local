"""Orthanc evaluation checks (docs/OCT_PLAN.md Step 4b) on de-identified Topcon exports. Prints counts and yes/no only.
  python -I check_orthanc.py <folder of .dcm> [<folder> ...]      (Orthanc at http://127.0.0.1:8042, no login)
"""
import hashlib
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

import pydicom

BASE = "http://127.0.0.1:8042"


def call(path, data=None, accept=None, method=None):
    req = urllib.request.Request(BASE + path, data=data, method=method or ("POST" if data else "GET"))
    if accept:
        req.add_header("Accept", accept)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, r.read(), r.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers.get("Content-Type", "")


def main():
    results = []
    for folder in sys.argv[1:]:
        for f in sorted(Path(folder).glob("*.dcm")):
            raw = f.read_bytes()
            ds = pydicom.dcmread(f, stop_before_pixels=True)
            kind = f"{ds.Modality} {str(ds.get('SeriesDescription', ''))[:40]}"
            frames = int(ds.get("NumberOfFrames", 1) or 1)
            st, body, _ = call("/instances", raw)
            r = {"object": kind, "frames": frames, "ts": ds.file_meta.TransferSyntaxUID.name, "upload": st}
            if st == 200:
                oid = json.loads(body)["ID"]
                st2, back, _ = call(f"/instances/{oid}/file")
                r["same bytes back"] = st2 == 200 and hashlib.sha256(back).digest() == hashlib.sha256(raw).digest()
                st3, fl, _ = call(f"/instances/{oid}/frames")
                r["frames seen"] = len(json.loads(fl)) if st3 == 200 else f"HTTP {st3}"
                st4, png, ct = call(f"/instances/{oid}/frames/0/preview")
                r["preview"] = "yes" if st4 == 200 and ct.startswith("image/") else f"no (HTTP {st4})"
                # DICOMweb, as OHIF asks: one frame in the stored syntax, and transcoded to uncompressed
                study, series, sop = str(ds.StudyInstanceUID), str(ds.SeriesInstanceUID), str(ds.SOPInstanceUID)
                p = f"/dicom-web/studies/{study}/series/{series}/instances/{sop}/frames/1"
                s5, _, _ = call(p, accept='multipart/related; type="application/octet-stream"; transfer-syntax=*')
                s6, _, _ = call(p, accept='multipart/related; type="application/octet-stream"')
                r["dicomweb frame (as stored / uncompressed)"] = f"{s5} / {s6}"
            results.append(r)
    st, body, _ = call("/dicom-web/studies")
    studies = json.loads(body) if st == 200 else []
    print(f"DICOMweb studies: {len(studies)}")
    for s in studies:
        uid = s["0020000D"]["Value"][0]
        _, ser, _ = call(f"/dicom-web/studies/{uid}/series")
        _, meta, _ = call(f"/dicom-web/studies/{uid}/metadata")
        m = json.loads(meta)
        shared = sum(1 for x in m if "52009229" in x)                 # shared functional groups (pixel spacing)
        perframe = sum(1 for x in m if "52009230" in x)               # per-frame groups (scan positions)
        print(f"  study: {len(json.loads(ser))} series, {len(m)} instances in metadata, shared groups in {shared}, per-frame groups in {perframe}")
    for r in results:
        print("  " + " | ".join(f"{k}: {v}" for k, v in r.items()))
    st, body, _ = call("/statistics")
    if st == 200:
        s = json.loads(body)
        print(f"Orthanc statistics: {s['CountInstances']} instances, {int(s['TotalDiskSizeMB'])} MB on disk")


if __name__ == "__main__":
    sys.exit(main())
