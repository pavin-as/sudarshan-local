"""Synthetic stand-in for a Topcon DICOM OCT Export Tool output folder (tests only; no real patient).
  python -I make_topcon_export.py <out folder> <json options>
options: patientId, sex (M/F), eye (R/L), colour (true/false), sop (instance UID), protocol
Writes an OP colour photograph (unless colour is false), an OP infrared one and a small OPT, like the real export.
"""
import json
import sys
from pathlib import Path

import numpy as np
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

OP, OPT = "1.2.840.10008.5.1.4.1.1.77.1.5.1", "1.2.840.10008.5.1.4.1.1.77.1.5.4"


def obj(sop_class, uid, o, kind, shape, frames=1):
    ds = Dataset()
    ds.file_meta = FileMetaDataset()
    ds.file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds.file_meta.MediaStorageSOPClassUID = sop_class
    ds.file_meta.MediaStorageSOPInstanceUID = uid
    ds.SOPClassUID, ds.SOPInstanceUID = sop_class, uid
    ds.StudyInstanceUID = o.get("study", "1.2.826.0.1.3680043.10.999.1")
    ds.PatientName, ds.PatientID, ds.PatientSex, ds.PatientBirthDate = "ZZ^TEST TOPCON", o["patientId"], o.get("sex", "M"), "19700101"
    ds.Manufacturer, ds.ManufacturerModelName = "Topcon", "Maestro2"
    ds.ProtocolName = o.get("protocol", "3D H/Macula/320/320/6x6mm/Angio")
    ds.ImageLaterality = o.get("eye", "R")
    ds.AcquisitionDateTime = o.get("when", "20261026110147.123")
    ds.Modality = "OP" if sop_class == OP else "OPT"
    ds.ImageType = kind
    ds.Rows, ds.Columns = shape[0], shape[1]
    ds.BitsAllocated = ds.BitsStored = 8
    ds.HighBit, ds.PixelRepresentation = 7, 0
    rng = np.random.default_rng(7)
    if len(shape) == 3:
        ds.SamplesPerPixel, ds.PhotometricInterpretation, ds.PlanarConfiguration = 3, "RGB", 0
        ds.PixelSpacing = [0.006868132, 0.006868132]
    else:
        ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
    if frames > 1:
        ds.NumberOfFrames = frames
        a = rng.integers(0, 255, (frames, *shape), dtype=np.uint8)
    else:
        a = rng.integers(0, 255, shape, dtype=np.uint8)
    ds.PixelData = a.tobytes()
    return ds


def main():
    out = Path(sys.argv[1])
    o = json.loads(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    base = "2.16.840.1.114517.10.1.1.4.99"
    if o.get("colour", True):
        obj(OP, o.get("sop") or generate_uid(), o, ["ORIGINAL", "PRIMARY", "", "COLOR"], (120, 160, 3)).save_as(out / f"{base}.2.1.dcm", enforce_file_format=True)
    obj(OP, generate_uid(), o, ["ORIGINAL", "PRIMARY", "", "IR"], (48, 64, 3)).save_as(out / f"{base}.2.2.dcm", enforce_file_format=True)
    obj(OPT, generate_uid(), o, ["ORIGINAL", "PRIMARY"], (32, 16), frames=4).save_as(out / f"{base}.1.1.dcm", enforce_file_format=True)


if __name__ == "__main__":
    sys.exit(main())
