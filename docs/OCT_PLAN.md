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
1. Pavin: tell Claude the share's path (`\\192.168.0.152\...`) and set up a read-only account for it.
2. Pavin chooses and approves three studies: one structural 3D Macula, one OCTA, and (if separate) a fundus photograph only.
3. Copy each one to `incoming\` and record its size and SHA-256.
4. Run the tool with `-norun` (a plan only), then with `-allDcm`, each study into a new output folder. Record the command,
   time taken, the files produced and the log (kept in `work\`).
5. Check the output with pydicom. Report only the tags, the numbers and whether the pixel data opens:
   - which objects were made (OP photograph, OPT B-scans, OCTA flow `x.3.1`, en face slabs `x.6.y`, segmentation `x.7.y`,
     FDA stub `x.100.1`);
   - how the patient ID is written (the SPD number?).
6. Render a few images and compare them on screen with the same study in ImageNet.

**Gate 1:** for each study type, real images open in a viewer that is not Topcon's, and the list of what was and was not
exported is written down.

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

## 7. Questions for Topcon (with the OCTA licence visit)
1. Can the export tool's Research (or OUS) key be issued for shichika's Hardware ID? Is it free? Can it be re-issued if
   shichika's hardware changes?
2. Do OCTA scans captured before the OCTA licence was set export the same as later ones?
3. Where does IMAGEnet 6 keep the `.fda` files? Is a read-only share of that folder supported?
4. Does reading the share during clinic hours slow IMAGEnet down?
5. Can IMAGEnet or the Maestro2 send DICOM (fundus photograph and OCT) to a DICOM receiver on shichika? That would replace
   file copying later.
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
