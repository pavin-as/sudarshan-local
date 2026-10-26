"""Synthetic stand-in for a Topcon DICOM OCT Export Tool output folder (tests only; no real patient).
  python -I make_topcon_export.py <out folder> <json options>
options: patientId, sex (M/F), eye (R/L), colour (true/false), sop (photograph instance UID), protocol,
         opt (true/false: a tomography), optSop (its instance UID), octa (true/false: en face slabs), when
Writes like the real export: an OP colour photograph (unless colour is false), an OP infrared one and, unless opt is false,
an OPT of 4 B-scans whose scan lines lie on the colour photograph, Topcon's layer surfaces as a height-map SEG and, for
OCTA, four en face slabs.
"""
import json
import sys
from pathlib import Path

import numpy as np
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

OP, OPT, OPTENF, HMSEG = ("1.2.840.10008.5.1.4.1.1.77.1.5.1", "1.2.840.10008.5.1.4.1.1.77.1.5.4",
                          "1.2.840.10008.5.1.4.1.1.77.1.5.7", "1.2.840.10008.5.1.4.1.1.66.8")
FRAMES, ROWS, COLS = 4, 64, 32
LAYERS = ["ILM", "RNFL/GCL", "IPL/INL", "IS/OS", "OS/RPE", "BM"]
SLABS = ["Superficial, ILM+0.0, IPL/INL+15.6", "Deep, IPL/INL+15.6, IPL/INL+70.2", "Choriocapillaris, BM+0.0, BM+20.8",
         "Outer Retina (PAR), IPL/INL+70.2, BM+0.0"]


def base(sop_class, uid, o, study):
    ds = Dataset()
    ds.file_meta = FileMetaDataset()
    ds.file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds.file_meta.MediaStorageSOPClassUID = sop_class
    ds.file_meta.MediaStorageSOPInstanceUID = uid
    ds.SOPClassUID, ds.SOPInstanceUID, ds.StudyInstanceUID = sop_class, uid, study
    ds.PatientName, ds.PatientID, ds.PatientSex, ds.PatientBirthDate = "ZZ^TEST TOPCON", o["patientId"], o.get("sex", "M"), "19700101"
    ds.Manufacturer, ds.ManufacturerModelName = "Topcon", "Maestro2"
    ds.ProtocolName = o.get("protocol", "3D H/Macula/320/320/6x6mm/Angio")
    ds.ImageLaterality = o.get("eye", "R")
    ds.AcquisitionDateTime = o.get("when", "20261026110147.123")
    ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
    ds.BitsAllocated = ds.BitsStored = 8
    ds.HighBit, ds.PixelRepresentation = 7, 0
    return ds


def main():
    out = Path(sys.argv[1])
    o = json.loads(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(7)
    study = o.get("study", "1.2.826.0.1.3680043.10.999.1")
    stem = "2.16.840.1.114517.10.1.1.4.99"
    colour_sop = o.get("sop") or generate_uid()
    for kind, sop, shape, name in ((["ORIGINAL", "PRIMARY", "", "COLOR"], colour_sop, (120, 160, 3), ".2.1"),
                                   (["ORIGINAL", "PRIMARY", "", "IR"], generate_uid(), (48, 64, 3), ".2.2")):
        if name == ".2.1" and not o.get("colour", True):
            continue
        ds = base(OP, sop, o, study)
        ds.Modality, ds.ImageType = "OP", kind
        ds.SamplesPerPixel, ds.PhotometricInterpretation, ds.PlanarConfiguration = 3, "RGB", 0
        ds.PixelSpacing = [0.006868132, 0.006868132]
        ds.Rows, ds.Columns = shape[0], shape[1]
        ds.PixelData = rng.integers(0, 255, shape, dtype=np.uint8).tobytes()
        ds.save_as(out / f"{stem}{name}.dcm", enforce_file_format=True)
    if not o.get("opt", True):
        return
    # the tomography: 4 B-scans, each a horizontal line on the colour photograph
    opt_sop = o.get("optSop") or generate_uid()
    ds = base(OPT, opt_sop, o, study)
    ds.Modality, ds.ImageType, ds.SeriesDescription, ds.NumberOfFrames = "OPT", ["ORIGINAL", "PRIMARY"], "OCT 3D H Macula", FRAMES
    ds.Rows, ds.Columns = ROWS, COLS
    vol = rng.integers(0, 60, (FRAMES, ROWS, COLS), dtype=np.uint8)
    vol[:, 20:40, :] += 120                                   # a bright "retina" between rows 20 and 40
    ds.PixelData = vol.tobytes()
    pm = Dataset(); pm.PixelSpacing = [0.0026, 0.01875]; pm.SliceThickness = 0.01875
    shared = Dataset(); shared.PixelMeasuresSequence = [pm]
    ds.SharedFunctionalGroupsSequence = [shared]
    per = []
    for i in range(FRAMES):
        fl = Dataset()
        fl.ReferencedSOPClassUID, fl.ReferencedSOPInstanceUID = OP, colour_sop
        fl.ReferenceCoordinates = [30.0 + i * 20, 20.0, 30.0 + i * 20, 140.0]      # row, column pairs
        fl.OphthalmicImageOrientation = "LINEAR"
        g = Dataset(); g.OphthalmicFrameLocationSequence = [fl]
        per.append(g)
    ds.PerFrameFunctionalGroupsSequence = per
    ds.save_as(out / f"{stem}.1.1.dcm", enforce_file_format=True)
    # Topcon's layer surfaces: one height map per surface, row b = B-scan b
    seg = base(HMSEG, generate_uid(), o, study)
    seg.Modality, seg.SeriesDescription, seg.NumberOfFrames = "SEG", "Retinal Layer(s) Segmentation", len(LAYERS)
    seg.BitsAllocated, seg.Rows, seg.Columns = 32, FRAMES, COLS
    del seg.BitsStored, seg.HighBit, seg.PixelRepresentation
    seg.SegmentSequence = []
    for k, label in enumerate(LAYERS):
        s = Dataset(); s.SegmentNumber, s.SegmentLabel = k + 1, label
        seg.SegmentSequence.append(s)
    seg.PerFrameFunctionalGroupsSequence = []
    for k in range(len(LAYERS)):
        si = Dataset(); si.ReferencedSegmentNumber = k + 1
        g = Dataset(); g.SegmentIdentificationSequence = [si]
        seg.PerFrameFunctionalGroupsSequence.append(g)
    heights = np.stack([np.full((FRAMES, COLS), 20.0 + k * 4, dtype=np.float32) for k in range(len(LAYERS))])
    heights[0, :, 0] = np.nan                                  # one missing point
    seg.FloatPixelData = heights.tobytes()
    seg.save_as(out / f"{stem}.7.1.dcm", enforce_file_format=True)
    if o.get("octa", True):
        for k, comment in enumerate(SLABS):
            e = base(OPTENF, generate_uid(), o, study)
            e.Modality, e.InstanceNumber, e.ImageComments = "OPTENF", k + 1, comment
            e.Rows, e.Columns = COLS, COLS
            e.PixelSpacing = [0.01875, 0.01875]
            e.PixelData = rng.integers(0, 255, (COLS, COLS), dtype=np.uint8).tobytes()
            e.save_as(out / f"{stem}.6.{k + 3}.dcm", enforce_file_format=True)


if __name__ == "__main__":
    sys.exit(main())
