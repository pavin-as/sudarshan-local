# OCT_PLAN.md - Topcon Maestro2: fundus photographs, OCT and OCTA in Sudarshan

Written 25 Oct 2026 from Pavin's notes (`SAMPADA_TOPCON_OCT_AI_AGENT_HANDOFF.md`), the Topcon manual (DICOM OCT Export Tool
User Instructions Rev F, tool v3.0.0.39) and read-only checks on shichika. This file replaces the notes. Status: **accepted
(D-047, 25 Oct): the tool runs on shichika.** Research use only: nothing here diagnoses, clears or treats a patient.

## 1. Goal
1. **Maestro2 fundus photographs into the existing Retina AI** (D-040 to D-046), the same way as Remidio photographs:
   kept on shichika, linked to the Yarago patient, reported by doctors on Fundus reports, graded silently by the research
   models, measured against the doctors' blinded grades.
2. **Structural OCT and OCTA as research data:** export them from Topcon's own format (`.fda`) to standard DICOM with
   Topcon's official tool, check that the exported data is correct, and then try OCT AI on it.
3. Clinical work on the Maestro2 and in IMAGEnet 6 does not change. ImageNet stays the clinical store for OCT.

## 2. Machines

| Machine | Address | Role in this plan |
|---|---|---|
| ImageNet PC (Windows 11 Pro), connected to the Maestro2 | 192.168.0.152 | Source of `.fda` files only, read through a read-only share. Nothing installed, nothing written. |
| **shichika** (Sudarshan + Yarago server; RTX 4070 12 GB, 32 GB RAM) | 192.168.0.49 | Runs the export tool, keeps the copies, runs Sudarshan's import and the AI. |
| QNAP | - | Sudarshan's nightly backup (already set up); the exported photographs and DICOM go into it. |
| Raspberry Pi NAS `nasadmin` (OpenMediaVault) | 192.168.0.107 | **Optional, later:** de-identified research sets only, once its encryption and backup are checked. It did not answer on 25 Oct. Not on the critical path. |

ImageNet PC facts (`imagenet-discover.ps1`, 26 Oct 09:20). The PC is named **OCT_PC** and runs Windows 11 Pro. It also has
10.1.1.2, probably the link to the Maestro2. SQL Server `MSSQLSERVER` holds the IMAGEnet database and is backed up by
"SQL Backup Master".

Each exam is a numbered pair: `<number>.fda` + `<number>.fds`. File names hold no patient names.

| Store | Size | Dates | Notes |
|---|---|---|---|
| `D:\IMAGEnet6\Data` (live) | 9,374 `.fda` (64 GB) + 9,387 `.fds` (most of the 700 GB) | 2021-04 to today | new exams arrive here, flat, by number; also `.jpg`, `.tmp` |
| `E:\Jukebox` (archive) | 10,382 `.fda`, 762 GB | 2021-03 to 2026-09 | 180 volume folders; synced to a QNAP by Qsync |
| `F:\Jukebox` | 3,298 `.fda`, 274 GB | 2025-06 to 2026-09 | 64 volume folders; a backup copy or a second archive? (ask Topcon) |

**Risk found:** three shares give **Everyone Full** access:
- `D` (all of D:\);
- `IMAGEnet6` (D:\IMAGEnet6);
- `Users` (C:\Users).

On D:\ and the Jukebox folders, NTFS gives Authenticated Users Modify.

**Firewall, checked 26 Oct:** Windows Firewall is off for the Public and Private profiles (the networks are Public).
**Kaspersky** is the firewall:
- it blocks file sharing (445/139/135) from the LAN, which limits the shares above for now;
- but SQL Server (1433) and Remote Desktop (3389) answer from the LAN.

If Kaspersky's rules change, any account that can sign in to OCT_PC could change or delete clinical OCT files.

Also: Qsync is a sync, not a backup, unless the QNAP keeps snapshots. No backup of the live `D:\IMAGEnet6` store was seen.

Pavin should ask Topcon which shares IMAGEnet viewing stations really need before anything is changed. Sudarshan never
uses these shares: it uses only its own read-only `SudarshanOCT$`.

shichika facts (25 Oct): Windows 11 Pro 64-bit; about 8 of 32 GB of RAM free during the day (MySQL, two Tomcats,
PostgreSQL, Metabase, four Docker containers); GPU 1.3 of 12 GB in use; free space D: 218 GB, F: 1.38 TB. The export tool
needs the **.NET 10 Desktop Runtime x64**, which is not installed: only .NET 6 and 8 are there.

## 3. Licences: three different things

| Licence | Tied to | What it gives | State |
|---|---|---|---|
| Maestro2 / IMAGEnet **OCT** | the Maestro2 / ImageNet PC | capturing and viewing structural OCT | have it |
| Maestro2 / IMAGEnet **OCTA** | the Maestro2 / ImageNet PC | capturing and viewing OCTA | bought; OCTA works now; Topcon to set the licence in a few days |
| **DICOM OCT Export Tool** tier key (`DicomOCTExport.exe.license`) | the **Hardware ID of the PC that runs the tool** (shown when the tool runs with no arguments) | which layers and OCTA figures the *exported DICOM* holds | none yet = "US" tier |

The export tool's tiers (manual section 6):
- **US (no key):** layers ILM, RNFL/GCL, IPL/INL, OS/RPE, BM. No OCTA vessel density.
- **OUS (key):** adds GCL/IPL, IS/OS and choroid (CSI). Adds OCTA vessel density.
- **Research (key):** adds INL/OPL and ELM as well (10 boundaries). Adds vessel density.
- **FAZ metrics exist only for the Triton**, never for the Maestro2: Sampada would measure FAZ itself.
- The manual gates only the metrics and the extra layers. OCTA flow data (`-octa`) and en face slabs (`-enfaceSlabs`)
  should export without a key. Step 1 checks this.

The device's OCTA licence does not license the export tool, and the export tool's key is not tied to the Maestro2.

## 4. Where the export tool runs: shichika (49) - decided 25 Oct (D-047)
The tool's key follows whichever PC runs the tool, so licensing does not force it onto the ImageNet PC. Topcon issues the
key for the Hardware ID it is given.

| | shichika (49) - recommended | ImageNet PC (152) |
|---|---|---|
| Clinical risk | none to the Maestro2; ImageNet untouched | .NET 10 and an unsigned tool on the PC that drives the Maestro2; the tool's default is `CPUCores=128` |
| Topcon service | not their PC | third-party software on their validated PC may affect support (ask Topcon) |
| Where the data has to end up | already there (Sudarshan, AI, backup) | DICOM would still have to be moved to shichika |
| Patient data left behind | in shichika's restricted folders only | temp files, logs and DICOM on 152 as well |
| Network | copies `.fda` files (tens of MB each) over the LAN | none |

**Fallback**, only if Topcon will issue the key for the ImageNet PC alone: put the tool in a portable folder there (with
Topcon service's agreement for .NET 10), cap it to 2 CPU cores, run it only after clinic hours, write its output straight
to shichika, and leave nothing behind on 152.

## 5. Rules (binding, with COMPLIANCE.md)
- ImageNet and the Maestro2: read only. Never move, rename, change or delete an `.fda` file or ImageNet's database. Use a
  read-only share account; no write share and no automatic sync from 152.
- Work only from copies, each with its SHA-256 recorded before conversion. Every conversion writes to a **new, empty
  output folder**: the tool's `CleanupPrviouslyRanOutputs=true` wipes earlier output in its target.
- The tool's temp folder (default `c:\Temp`) and log folder (default relative `../../log`) may hold patient names: point
  them at admin-only folders and empty them after each run.
- Patient-identifiable OCT data, DICOM headers, screenshots and logs never go to GitHub, cloud services or cloud models.
  Reports and chat show counts and tag names, not names or IDs.
- A pseudonymous folder name is not de-identification: the DICOM headers (and any burned-in text) must be cleaned too. Only
  de-identified copies leave shichika (Pi NAS, CSV, research sets).
- Third-party code and model weights: read the code and licences first, pin versions and checksums, load weights safely
  (`weights_only=True` or safetensors), own container on 127.0.0.1, as with RFM (D-044).
- GPU and other heavy work runs after clinic hours, with limits. It stops if Yarago or Sudarshan slow down.
- Research only: AI output goes only to the Retina AI page (D-046), never to reports, the patient record or messages.

## 6. Steps

### Step 0 - Prepare (now; the ImageNet PC can be off)
1. ~~Pavin agrees: run the tool on shichika (section 4).~~ Done 25 Oct (D-047).
2. ~~Install the .NET 10 Desktop Runtime x64 on shichika.~~ Done 25 Oct: 10.0.13 through winget (Microsoft's installer,
   hash checked). No reboot. Yarago, PostgreSQL and the Sudarshan services kept running.
3. ~~Copy the tool to `D:\Sudarshan\tools\topcon\DicomOctExport-3.0.0.39\`.~~ Done 25 Oct (RUNBOOK 13).
   - Config: temp and log folders as in section 5, `NoPrompt=true`, `CPUCores=4`. Topcon's original is kept beside it.
   - The zip's SHA-256 is `22E50BF6FD2D4BCEAA5ADEC4FE2DFC39778C7CBB3C4123F71798234945B01E21`.
   - Pavin still to confirm that the zip came from Topcon.
4. ~~Get shichika's Hardware ID.~~ Done 25 Oct: **`410689457`**, access level US.
   - The tool prints it on every run that has an input, as `parser access level: US, id: ...`. A run with no arguments
     prints only the usage text, despite what the manual says.
   - The ID was the same on three runs.
5. Optional: Pavin asks Topcon for a **Research** (or OUS) key for that Hardware ID, along with the section 7 questions.
   The tool needs no key to be used (US tier, free with the download). The key only adds 5 more layers and OCTA vessel
   density (manual section 6). The best time
   to ask is when Topcon comes to set the OCTA licence.
6. ~~Make the folders.~~ Done 25 Oct: `D:\Sudarshan\data\oct\incoming` (copied `.fda`), `...\dicom` (exports) and
   `...\work` (tool temp and logs). Access is Administrators, SYSTEM and `shichika\Admin` only.

### Step 1 - First export (when the ImageNet PC is on)
1. ~~Pavin, on the ImageNet PC: run `scripts\imagenet-discover.ps1`, then `scripts\imagenet-share-readonly.ps1`. Then store
   the password on shichika with `cmdkey` (RUNBOOK 13).~~ Done 26 Oct: the read-only share
   `\\192.168.0.152\SudarshanOCT$` is `D:\IMAGEnet6`.
   - It opens from shichika and lists 19,622 files in 1 s.
   - `sudarshan_ro` is refused on `D`, `IMAGEnet6` and `Users`.
   - Kaspersky packet rule on OCT_PC: allow inbound TCP 445 from 192.168.0.49 only, at the top of the list.
   - A Windows Firewall rule for the same was also added; it is inactive while Windows Firewall is off.
   - No write test was done, on purpose: the share's permission is Read for `sudarshan_ro` only.
   - First share the live store (the `D:\IMAGEnet6` data subfolder): new exams arrive there.
   - The Jukebox archive, which holds past years, gets a second share later, if Step 4 needs it
     (`-DataFolder E:\Jukebox -Share 'SudarshanJukebox$'`).
2. Pavin chooses and approves three studies: one structural 3D Macula, one OCTA, and (if separate) a fundus photograph only.
   File names are numbers, so the easiest way to pick them is by time. For example, scan a staff volunteer, then Claude
   takes the newest files.
3. Copy each one to `incoming\`: the `.fda` **and** its `.fds` with the same number. Record each file's size and SHA-256.
4. Run the tool with `-norun` (a plan only), then with `-allDcm`, each study into a new output folder. Record the command,
   time taken, the files produced and the log (kept in `work\`).
5. Check the output with pydicom. Report only the tags, the numbers and whether the pixel data opens:
   - which objects were made (OP photograph, OPT B-scans, OCTA flow `x.3.1`, en face slabs `x.6.y`, segmentation `x.7.y`,
     FDA stub `x.100.1`);
   - how the patient ID is written (the SPD number?);
   - for each object: SOP class UID, transfer syntax, single- or multi-frame, and where the pixel spacing is (top level or
     the per-frame functional groups);
   - the data that places each B-scan or slab on the fundus photograph (for example the ophthalmic frame location and
     referenced image sequences).

   These answer the viewer questions in Step 4b.
6. Render a few images and compare them on screen with the same study in ImageNet.

**Gate 1:** for each study type, real images open in a viewer that is not Topcon's, and the list of what was and was not
exported is written down.

**Step 1 results, 26 Oct (two of today's real exams, approved by Pavin; copies in `incoming\exam01`, `incoming\exam03`):**
- **Copies:** SHA-256 checked against the originals, and still unchanged after the export. The exam label to IMAGEnet
  number map is kept only in `work\exam_map.txt`.
- **Export:**
  - `-allDcm` took 3 s for the radial exam and 15 s for the OCTA exam.
  - Every object reports "created successfully", but **the tool's exit code is -1 even on success**. Judge a run by its
    output, not its exit code.
  - The `.fds` was beside the `.fda`; an export without it was not tried.
- **Compression:** the output is **JPEG 2000**: lossless for the B-scans, flow volume and slabs, standard for the
  photographs. It is not JPEG baseline as the manual says. Decoding needs OpenJPEG: pydicom + pylibjpeg-openjpeg in
  `D:\Sudarshan\tools\oct-venv`. Pillow alone fails on the B-scans.
- **Patient ID** is the SPD number (format `SPD99999`) in every object, so exports can be linked to Yarago.
- **Identifiers** (name, birth date, sex, study date and time, device serial) are in every object. De-identification must
  remove them. The en face slabs' `ImageComments` holds only the slab definition.
- **What came out:**

| Exam | Protocol | Objects (all decode) |
|---|---|---|
| exam01 | `Radial/Macula/1024/12/6mm` | OPT 12 B-scans 1024×885 (5.86 × 2.6 µm); OP colour 2576×1958 (6.87 µm); OP infrared 640×480; height-map SEG (6 surfaces × 12 B-scans); FDA stub |
| exam03 | `3D H/Macula/320/320/6x6mm/Angio` | OPT 320 B-scans 320×885 (18.75 × 2.6 µm, 18.75 µm apart); OPTBSV flow volume 320×885×320; binary flow SEG; 4 en face slabs 320×320 (18.75 µm); OP colour and infrared; height-map SEG (6 surfaces); FDA stub |

- **Slabs (exam03):**
  - Superficial: ILM+0 to IPL/INL+15.6;
  - Deep: IPL/INL+15.6 to +70.2;
  - Outer Retina: IPL/INL+70.2 to BM;
  - Choriocapillaris: BM+0 to +20.8.

  OCTA exports work before the OCTA licence is set.
- **Layer surfaces at the US tier:** ILM, RNFL/GCL, IPL/INL, **IS/OS**, OS/RPE, BM. That is 6, one more than the manual's US
  list.
- **Numeric checks (exam03):**
  - the surfaces lie in order from top to bottom;
  - the brightest depth rows (357-361) sit at OS/RPE-BM;
  - the retina between ILM and BM is brighter than outside it;
  - the ILM is deeper at the centre (a foveal pit), so the B-scans are not flipped and the scan is centred.
- **Scan position:** every B-scan has an `OphthalmicFrameLocationSequence`. Frame 1 is a line on the colour photograph
  897 px long, which is 6.16 mm at 6.87 µm per pixel, matching the 6 mm scan. So scan lines can be drawn on the fundus
  photograph.
- **Still to do for Gate 1:**
  - Pavin compares the previews in `D:\Sudarshan\data\oct\work\renders\` with the same exams in IMAGEnet. Claude does not
    view patient images (COMPLIANCE).
  - Optionally, one plain (non-angio) 3D Macula exam. exam03 already contains a structural 3D volume.

### Step 2 - Check the exported data
For each study:
- modality, SOP class and series layout;
- B-scan count and order;
- eye, orientation and volume size;
- pixel spacing and slice spacing, in sensible units (missing values are flagged, never guessed);
- which segmentation layers are present;
- what the OCTA flow and slab data hold;
- the fundus photograph's size, field of view and quality.

If two exports of the same study share an identifier, check it stays the same, without showing who it belongs to.

**Gate 2:** at least one structural OCT has the correct anatomy, B-scan count and order, orientation and geometry.
Thickness is measured only once the geometry has passed. OCTA passes or fails separately.

**When the OCTA licence is set,** export one new OCTA study and compare it with one taken before. **When the export key
arrives,** export again and check that the extra layers and the vessel density appear.

### Step 3 - Maestro2 fundus photographs into Retina AI (build; after Gate 1 for the photograph)
**Built and tested on 26 Oct (D-048), not deployed.**
- On the test database: 12 checks in `test/topcon.test.ts`, with the Remidio, Fundus reports and Retina AI tests
  unchanged.
- In the browser: the System panel, Photographs and Fundus reports at desktop and phone width.
- With the real pieces: one peek against the real share, tool and converter (exam 40742: Radial Macula, right eye, one
  colour photograph; nothing kept).
- To deploy: RUNBOOK 13.

The plan as written before the build:
- Migration: `app.fundus_photos.source` allows `'topcon'`, plus the Topcon fields (study and SOP UIDs, device, scan
  protocol, eye, field). The Remidio-only columns stay empty for Topcon rows.
- An import job on shichika (switch off / peek / on, like D-041):
  - list new `.fda` files on the read-only share outside clinic peaks, copy them, check the checksum and export;
  - store the OP photograph in `RETINA_PHOTO_DIR`;
  - link it to the patient by SPD number (anything else is kept unlinked, as with Remidio).
- The rest is already built (D-042, D-046): the photographs appear on Fundus reports and the patient page, and are graded
  silently by Arko007 and both RFM heads.
- **Measured per camera:** separate Maestro2 evaluation sets and cut-offs. Remidio figures do not carry over (D-044,
  D-045).

### Step 4 - OCT and OCTA storage (after Gate 2)
- Measure the real size of each study in Step 1, then decide what to keep. ImageNet already keeps the `.fda` files, so
  shichika may keep only the DICOM needed and re-copy the rest when needed.
- The folder layout and backup follow from those measurements:
  - identifiable: `D:` or `F:` on shichika, with the QNAP backup;
  - de-identified research sets: kept separately, with a checksum manifest and a record of what was done to each file.
- A simple viewer (B-scans and en face slabs) on the patient page is optional: doctors already use ImageNet.

**Step 4 built on 26 Oct (D-049), not deployed.** The import also keeps each exam's OCT / OCTA (export `-dcm -segDcm
-enfaceSlabs` from the `.fda` alone), and Sudarshan's own OCT viewer opens from fundus report sessions and the patient
page.
- Safeguards for IMAGEnet's past exams: the backfill window, past sessions kept off "To report", and Jukebox archives read
  with their subfolders.
- Checked:
  - 18 checks in `test/topcon.test.ts`;
  - a real OCTA peek (exam 40745: 320 B-scans, 6 layers, 4 slabs, 15 s);
  - a browser check of the viewer on synthetic data, at desktop and phone width.
- Storage: about 83 MB per OCTA exam, 9 MB per radial exam. The full history needs a place decided first (D-049).

### Step 4b - Optional: evaluate Orthanc and OHIF (after Gate 2; evaluation only, not approval to install)
**Done on 26 Oct, on de-identified copies of the two Step 1 exams** (`scripts/oct_deidentify.py`; checked: no original
identifier or UID left, all references inside the copies still resolve). Orthanc 26.9.1 ran on 127.0.0.1:8042 with its
DICOMweb and OHIF plugins, using 495 MB of memory.
- **Storage:** all 16 objects were stored and returned byte for byte, with every frame.
- **Decoding:** it previews and transcodes the B-scans, photographs and binary flow mask. It **cannot** decode the OCTA
  flow volume or the en face slabs (JPEG 2000 lossless: no preview, transcoding to uncompressed fails with HTTP 500). It
  can serve them only as stored.
- **Layers:** it cannot serve Topcon's height-map layers as frames.
- **OHIF** lists every series of the OCTA study and opens the B-scan stack ("1/320", window/level, orientation). It has no
  scan lines on the photograph and no layer lines. How its slabs and B-scans look is for Pavin to judge: open
  `http://127.0.0.1:8042/ohif/` on shichika while the container runs.
- **Result: Option C without Orthanc for now** (D-049). Look again if ImageNet can send DICOM to a receiver (Topcon
  question 5).

The plan as written before the evaluation:
Pavin's idea, added 26 Oct.

**Question:** should exported DICOM be kept in an Orthanc DICOM server and viewed with OHIF inside Sudarshan, instead of
plain folders and a viewer of Sudarshan's own?

**Options:**

| | Storage | Viewer | For | Against |
|---|---|---|---|---|
| A | folders (Step 4) | Sudarshan's own | simplest; already planned | no DICOM receiver, no DICOMweb, everything by hand |
| B | Orthanc | OHIF | quick generic viewing: B-scan stack, slabs, fundus photograph, zoom, contrast, side-by-side | as far as known, no ophthalmic mode: no scan position on the fundus photograph, no height-map segmentation or AI overlays without substantial custom work |
| C | Orthanc | small OCT viewer in Sudarshan | standard store, DICOMweb, possible receiver for ImageNet; the viewer shows what ImageNet cannot (AI, fundus reports, history) | the viewer must be built |

**Leaning (26 Oct): C, decided only after the real export has been tested.**
- OHIF stays possible as an extra generic viewer.
- Orthanc's biggest gain would be receiving DICOM sent by ImageNet or the Maestro2 (C-STORE). That would replace copying
  `.fda` files, and depends on Topcon's answer to question 5.

**Points to check on the real export:**
- Orthanc stores any valid DICOM uploaded through its REST API. Its network receiver may need "unknown SOP classes
  accepted" for OPTBSV, OPTENF and height-map SEG.
- OHIF: whether it uses the per-frame pixel spacing (B-scan aspect ratio and µm measurements), decodes Topcon's JPEG
  transfer syntax, and shows OPT, OPTENF and OP correctly.
- Missing features and the custom work each would need.

**Deployment, if tested:**
- Docker on shichika, bound to 127.0.0.1 with a memory limit. The index can live in PostgreSQL 16 or SQLite.
- About 200-500 MB of RAM for Orthanc. Disk is roughly double unless Orthanc becomes the only store.
- Sudarshan's server stands in front: its logins, `need()` permissions and audit log. Orthanc is never opened to the LAN or
  the internet.
- Orthanc's storage goes into the QNAP backup.
- Licences: Orthanc core GPLv3, plugins (DICOMweb, PostgreSQL) AGPLv3, OHIF MIT. Fine for internal use; Sampada does not
  distribute them.

**Test (outside clinic hours):**
1. A test Orthanc with no kept data receives one de-identified copied study.
2. Check every object and frame against the files: counts and checksums of the pixel data.
3. Connect a test OHIF through DICOMweb. Try B-scan scrolling, OCTA slabs, the fundus photograph, measurements and
   side-by-side comparison.
4. Compare with ImageNet for the same study. Record what works, what fails and the custom work needed.
5. Remove the test containers and their data.

**Decision then:** Pavin chooses A, B or C (a new D-number). No production change before that.

### Step 5 - OCT AI research (after Gate 2 and a de-identified set)
1. **Pavin and Dr. Sameera choose the question first** (as D-045 did for DR). Suggestions:
   - fluid detection (intraretinal fluid, subretinal fluid, PED) for the injection team;
   - DME in diabetic patients, alongside the fundus photograph.
2. Baseline with no third-party model: Topcon's own segmentation from the export. Build thickness maps from it and
   compare them with ImageNet's printout. This also checks the geometry.
3. Then candidate models, one at a time, each under section 5's rules:
   - the Yale OCT layer model (check first that the repository, the weights and their licence really exist);
   - a pretrained retinal nnU-Net (a real checkpoint, not just the framework);
   - a fluid model, if that is the question chosen.

   Each is compared with Topcon's segmentation **and** with corrections by a doctor (agreement with ImageNet is not
   ground truth). Boundary error is given in µm only when the geometry has passed.
4. OCTA: vessel density from Topcon once the export key arrives. FAZ measured by Sampada on the superficial slab.
5. Later and separate: OCT foundation models, disease classification, and showing anything to clinicians.

### Step 6 - OCTA vascular analysis and FFA-like maps (separate research module; after Steps 1-5)
Pavin's idea, added 25 Oct.

**Question:** can the Maestro2's OCTA, structural OCT and fundus photograph, taken together, show the vascular problems
that are normally looked for with fluorescein angiography (FFA), without dye? Research only: no measurement or map from
this step is used for a clinical decision until it has been independently validated.

**Tools to evaluate, in order.** Each one needs the section 5 checks first: repository, licence, last commit, dependencies,
whether it runs offline, and whether it reads Maestro2 slabs at their real scale.

| # | Tool | For | Check first |
|---|---|---|---|
| 1 | OCTAVA (github.com/GUntracht/OCTAVA) | vessel density, FAZ, vessel length, branching | whether it needs MATLAB or only the free MATLAB Runtime |
| 2 | OpenOCTAAnalyzer (PyPI) | quantitative OCTA measurements | that the package and its source really exist and are maintained |
| 3 | OCTA-graph-extraction (github.com/KreitnerL/OCTA-graph-extraction) | vessel network graph and branching | GPU needs and model weights (section 5 rules) |
| 4 | OCTolyzer (github.com/jaburke166/OCTolyzer) | retinal and choroidal measurements | it was built for other devices: whether it accepts Maestro2 data at all |

**Steps:**
1. **Input:** OCTA studies already exported and checked in Steps 1-2. These are copies taken from ImageNet read-only; nothing
   is read from ImageNet directly.
2. **Check the slabs:** superficial and deep en face slabs, their scale in mm per pixel, scan size (3×3, 4.5×4.5, 6×6 mm)
   and the layer boundaries that define them. Gate 2's rules apply: no measurement on unverified geometry.
3. **Measure with OCTAVA first:** vessel density, FAZ area, vessel length and branching, with fixed and recorded settings.
   Repeat on the same scans to show that the figures are reproducible.
4. **Compare with references:**
   - vessel density: compare with Topcon's own figures, which need the export key (OUS or Research), and with ImageNet's
     screen if it shows them;
   - FAZ: Topcon gives no FAZ figure for the Maestro2, so compare with a doctor's FAZ tracing on the same slab;
   - list every difference and its likely cause (artefact, segmentation, scale).
5. **Line up the images:** place the OCTA vessel maps, structural OCT findings (fluid, thickening) and the fundus photograph
   from the same visit on one view. The export's position data shows where each scan lies on the fundus photograph.
6. **Store:**
   - identifiable work stays in `D:\Sudarshan\data\oct\` (section 5);
   - de-identified images, measurements and outputs go to a research set with a checksum manifest;
   - they may go to the Pi NAS (192.168.0.107) only after its encryption, access and backup checks pass.

**Limits, stated up front:**
- Maestro2 OCTA covers at most 6×6 mm (macula or disc). FFA covers a much wider field, so peripheral non-perfusion and
  neovascularisation elsewhere cannot be judged from these scans.
- OCTA shows blood flow, not dye. Leakage, staining, pooling and filling times cannot be reconstructed from OCT or OCTA alone.
- Projection and motion artefacts, and poor segmentation, change vessel density and FAZ. Each must be flagged per scan.

**Longer term: synthetic FFA.**
- **Aim:** test whether combined OCT, OCTA and fundus data can predict capillary non-perfusion, neovascularisation,
  microvascular abnormalities and likely leakage sites.
- **What it needs:** pairs of real FFA and Maestro2 studies of the same eye on the same day, a doctor's labels on the
  FFA, and patients kept together in every split (D-044).
- **Sampada has no FFA (Pavin, 25 Oct),** so pairs cannot be made in the clinic. The realistic route has three parts:
  1. **First, FFA-like maps from OCTA**, which need no pairs: capillary non-perfusion, FAZ enlargement, NVD/NVE within the
     scan, and microaneurysm-like loops, drawn on the fundus photograph. These are measured, not imitated, and a doctor
     can check them against the OCTA itself.
  2. **Then, if wanted, published synthetic-FFA models** (fundus photograph to FFA image, trained on small public paired
     sets), run only as a look-alike picture, labelled "synthetic, not an angiogram". Without real FFA there is no way to
     check them on Sampada eyes: such models can invent or hide leakage. They are never shown for clinical use.
  3. **Validation pairs from outside:** patients that Sampada refers for FFA elsewhere could bring back their FFA images
     (with consent), giving a small paired set over time. Ethics committee approval is needed if results are to be
     published.

**Done when:**
- Maestro2 OCTA slabs are analysed with OCTAVA, and repeat measurements of vessel density and FAZ agree.
- The figures have been compared with Topcon (vessel density) and with a doctor's tracings (FAZ).
- Vessel maps are overlaid on the fundus photograph and OCT.
- A written list of limits, artefacts and clinically important differences exists.

### Steps 7-10 - What Sudarshan adds beyond IMAGEnet (added 26 Oct; Pavin: "add A-D to the plan ... start with item 1")
IMAGEnet shows more about a single scan (thickness maps, normative data, its own analyses). Sudarshan's value is putting
the scans beside the EMR and using them for decisions and research.
- **Step 7 (A) - Thickness linked to treatment. Built 26 Oct (D-050); the IMAGEnet check is next (RUNBOOK 13).** First
  real scans: an OCTA cube had CST 258 µm (ILM-BM), with normal sector pattern and nasal thicker than temporal; a radial
  scan had 394 µm.
  - Sudarshan computes central subfield thickness (CST) and the 9 ETDRS sectors from Topcon's layer lines (ILM to BM, and
    ILM to OS/RPE), for every macula 3D and radial scan.
  - **Gate:** checked against IMAGEnet's CST on as many scans as Pavin gives. The values are typed into a check sheet on
    shichika; only the agreement is reported.
  - Then an **"injection response" chart** on the patient page: CST per eye, vision and injection dates from Yarago on one
    timeline. It is labelled "not checked against IMAGEnet" until the gate passes.
- **Step 8 (B) - OCT in the clinic's workflows**, after Step 7's gate:
  - the latest CST and its change on the doctor summary (D-026), with date and source;
  - follow-up board flags (injection team, D-038): CST rising since the last visit, or no OCT for months while on
    injections;
  - an OCT-based macular oedema *suggestion* on the fundus report form, which the doctor confirms (AI never writes the
    record).
- **Step 9 (C) - AI research, silent; extends Step 5.** Each item follows D-044 and D-045 (licences, safe loading, Sampada
  validation sets):
  - fluid detection (IRF, SRF, PED) on B-scans;
  - DME screening combining the photograph (RFM) with OCT (CST and fluid);
  - RNFL and GCL thickness for glaucoma suspects;
  - OCTA vessel density and FAZ computed by Sudarshan (Topcon gives no FAZ for the Maestro2);
  - non-perfusion maps (Step 6).
- **Step 10 (D) - Clinic and research insight** (aggregates in Metabase):
  - outcomes by treatment (CST and vision after loading doses, by drug);
  - care gaps (overdue OCT);
  - de-identified cohorts for audits and papers.

## 7. Questions for Topcon (with the OCTA licence visit)
1. Can the export tool's Research (or OUS) key be issued for shichika's Hardware ID? Is it free? Can it be re-issued if
   shichika's hardware changes?
2. Do OCTA scans captured before the OCTA licence was set export the same as later ones?
3. Where does IMAGEnet 6 keep the `.fda` files? Is a read-only share of that folder supported?
4. Does reading the share during clinic hours slow IMAGEnet down?
5. Can IMAGEnet or the Maestro2 send DICOM (fundus photograph and OCT) to a DICOM receiver (C-STORE destination) on
   shichika, for example Orthanc (Step 4b)? Which SOP classes and transfer syntaxes does it send? That would replace file
   copying later.
6. What does the patient ID field hold, and can the Maestro2 take a worklist from Yarago?

## 8. Questions for Pavin and the clinic
1. ~~Run the tool on shichika?~~ Yes (D-047).
2. Fundus photographs first (Step 3), then OCT research (Step 5)?
3. What ID staff type on the Maestro2: the SPD number?
4. Which three studies to use in Step 1. Real patient files need Pavin's approval; a staff volunteer's scan is easier.
5. Clinical question for OCT AI (Step 5.1).
6. For Step 6 (no FFA at Sampada): can patients referred out for FFA bring back their images, with consent, to build a
   small paired validation set?

## 9. Records kept
- This file: the plan; ticked as steps finish.
- STATUS.md: one line per step.
- DECISIONS.md: P-7, then D-047.
- RUNBOOK.md: the export procedure, with no patient data.
- An OCT section in AI_EVALUATION.md, for the test matrix and model results.
- Real `.fda`, `.dcm` files, screenshots, logs and ID mappings are never committed.
