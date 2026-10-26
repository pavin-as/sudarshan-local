"""De-identified copy of a Topcon DICOM OCT Export Tool output folder (docs/OCT_PLAN.md Steps 3-4b; COMPLIANCE).

  D:\\Sudarshan\\tools\\oct-venv\\Scripts\\python.exe -I scripts\\oct_deidentify.py <export folder> <new folder> <code>

The copy keeps the images, geometry and links between objects, but none of the identifiers:
- the patient's name and ID become <code>; birth date, sex, age and other IDs are emptied
- people, institution, device serial, station and accession number are emptied
- every date becomes 20000101 (times are kept: they order the scans of a visit)
- every instance / series / study / frame-of-reference UID gets a new UID (2.25...), the same new UID wherever the old
  one appears, so references between the objects still work; standard class and transfer syntax UIDs stay
- private (manufacturer) elements are removed
- free text (ImageComments) is kept only on en face slabs, where it holds the slab definition, and only if it does not
  hold the old name
The source folder is not changed. It prints counts only.
"""
import hashlib
import secrets
import sys
from pathlib import Path

import pydicom

EMPTY = ["PatientBirthDate", "PatientSex", "PatientAge", "OtherPatientIDs", "OtherPatientNames", "PatientAddress",
         "PatientTelephoneNumbers", "InstitutionName", "InstitutionAddress", "ReferringPhysicianName",
         "PerformingPhysicianName", "OperatorsName", "PhysiciansOfRecord", "AccessionNumber", "DeviceSerialNumber",
         "StationName", "StudyID", "PatientComments", "StudyDescription", "RequestingPhysician"]
KEEP_UID = {"TransferSyntaxUID", "ImplementationClassUID"}
OPTENF = "1.2.840.10008.5.1.4.1.1.77.1.5.7"


def main():
    src, dst, code = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
    salt = secrets.token_hex(16)                    # a new mapping each run: the copy cannot be traced back by UID
    new_uid = lambda u: "2.25." + str(int(hashlib.sha256((salt + u).encode()).hexdigest()[:30], 16))
    dst.mkdir(parents=True, exist_ok=True)
    n = changed_uids = 0
    for f in sorted(src.rglob("*.dcm")):
        ds = pydicom.dcmread(f)
        name = [w.lower() for w in str(ds.get("PatientName", "")).replace("^", " ").split() if len(w) > 2]
        is_enf = str(ds.SOPClassUID) == OPTENF
        ds.remove_private_tags()

        def walk(d):
            nonlocal changed_uids
            for el in list(d):
                if el.VR == "SQ":
                    for item in el.value:
                        walk(item)
                elif el.VR == "UI" and el.value and el.keyword not in KEEP_UID and not el.keyword.endswith("ClassUID") \
                        and not str(el.value).startswith("1.2.840.10008."):
                    el.value = new_uid(str(el.value)); changed_uids += 1
                elif el.VR == "DA" and el.value:
                    el.value = "20000101"
                elif el.VR == "DT" and el.value:
                    el.value = "20000101" + str(el.value)[8:]
                elif el.keyword in EMPTY:
                    el.value = ""
                elif el.keyword == "ImageComments" and (not is_enf or any(w in str(el.value).lower() for w in name)):
                    del d[el.tag]
        walk(ds)
        ds.PatientName, ds.PatientID = f"DEID^{code}", code
        ds.PatientIdentityRemoved = "YES"
        ds.DeidentificationMethod = "Sudarshan oct_deidentify: names, IDs, dates, UIDs, private"   # LO: 64 characters
        ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
        ds.save_as(dst / f"{code}_{n + 1:02d}.dcm", enforce_file_format=True)
        n += 1
    print(f"{n} objects de-identified into {dst} ({changed_uids} UIDs replaced)")


if __name__ == "__main__":
    sys.exit(main())
