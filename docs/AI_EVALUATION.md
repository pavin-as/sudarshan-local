# AI_EVALUATION.md - how the retina AI is measured, and the Phase 01 report

Research use only. Nothing here makes any model fit for clinical use (COMPLIANCE.md, D-040).
Decisions: D-040 (research grader), D-041 (Remidio photographs), D-042 (doctor's fundus report), D-043 (evaluation),
D-044 (Arko007 unreliable; RFM installed), D-045 (screening first).

## 0. Objective (Pavin, 25 Oct 2026; D-045)

Sampada's retinal AI is for **diabetic retinopathy screening and referral**: does this eye need an ophthalmologist, or can
the patient continue routine screening? Five-class grading is recorded for research but is secondary.
1. **Primary outcome: referable DR** = moderate NPDR or worse (grade 2-4).
2. **High sensitivity first**, above all no missed severe NPDR or PDR.
3. Specificity measured to know the unnecessary referrals.
4. Referral cut-offs chosen on **validation** data only, never tuned on a frozen test set.
5. Three outcomes: **refer**, **uncertain** (a person decides) and **routine**; ungradable or uncertain images are never
   cleared automatically.
6. Exact grade kept as a research measure.
7. On Sampada photographs: sensitivity, specificity, NPV, false negatives and referral rate.
8. **The DR outcome never clears a patient by itself**: suspected macular oedema, symptoms and image quality are referral
   reasons a person weighs.
9. Research mode until screening performance is validated on Sampada data and deployment permissions are in place.

Screening method (`cli retina-eval-screening`, `services/evalScreening.ts`): referral score = p2+p3+p4; refer cut-off =
highest that refers >= 95% of validation referable eyes; clear cut-off = highest that refers >= 99%; between them =
uncertain. Screening sensitivity = referable eyes not cleared; specificity = non-referable eyes cleared; referral rate =
refer + uncertain. Cut-offs are frozen before the test images are scored.

## 1. Phase 01 report: the existing model (Arko007/diabetic-retinopathy-v1)

> **Status (Pavin, 25 Oct 2026): unreliable for clinical decision-making.** Kept available for research and as the
> comparison baseline only. Its predictions are never used for patient advice, screening decisions or anything automated
> towards patients; the Retina AI page says so above every result (APTOS result, section 5).

Written 25 Oct 2026 for Pavin's implementation plan (`sampada_retinal_ai_implementation_plan.md`, Phase 01).

### 1.1 What the model is (recorded, with the file in hand)

| | |
|---|---|
| Source | Hugging Face `Arko007/diabetic-retinopathy-v1`, repo commit `05e5b0f`, weights uploaded 14 Sep 2025; Apache 2.0 |
| File | `best_model.h5`, 4,774,524,728 bytes, SHA-256 `cd4b10c3e5bb1043ac01098284a1136bb423a0eafe7a2445587e969d370f3ffc` (pinned; `model_guard.py` refuses anything else) |
| Architecture | custom CNN with residual blocks, 397,876,997 parameters, input 384 x 384 RGB, output 5 classes (ICDR 0-4), final Dense with softmax |
| Format | Keras 3 `.h5`; only standard layers (no Lambda or custom code), checked without loading on 21 Sep and again by the guard on every start |
| Preprocessing | RGB, resize to 384 x 384 (`cv2.INTER_LINEAR`), scale 1/255; no crop, no CLAHE, no normalisation (as the author wrote) |
| Output | native probabilities (softmax in the model; Sudarshan never applies it again; checked by probing at every start) |
| Runtime | TensorFlow 2.21 / Keras 3.15 on CPU (8 of 28 cores), about 0.4-0.6 s per image, Docker container on shichika, 127.0.0.1:7860 |
| Training data (model card) | IDRiD only, "413 training images" |

### 1.2 Can the original benchmark be reproduced? **No.**

The plan's acceptance allows "a written report that explains why reproduction is impossible". The reasons:

1. **There is no original benchmark.** The model card reports no accuracy, sensitivity, specificity, AUROC or kappa, and
   no evaluation of any kind. There is nothing to reproduce or compare against.
2. **No dataset definition is published.** The card says IDRiD and 413 training images, but gives no split files,
   no validation set, and no list of images. 413 is exactly the size of IDRiD's official training split for disease
   grading (516 images: 413 training, 103 test), which suggests the 103 official test images were not used for
   training. **That cannot be verified.**
3. **Checkpoint selection is unknown.** The file is called `best_model.h5`, so a checkpoint was chosen on some
   validation measure. If that was IDRiD's test split, any IDRiD-test result would be optimistic (test data used for
   model selection). Not knowable from what is published.
4. **No training code or hyper-parameters** are published, so leakage between splits (duplicates, crops of the same
   image, both eyes of a patient on both sides) cannot be checked.
5. **The model's behaviour is a warning sign.** 398 million parameters fitted to 413 images is a recipe for
   overfitting; on synthetic test patterns it returns saturated scores (100.00% for one grade on one pattern, grade 2
   with 40% on a plain orange disc on 25 Oct). Its scores must be read as "which grade won", never as confidence.

Conclusion: the model has **no evidence of performance**. Everything about it must be measured here, on held-out data,
before it is trusted for anything; Sudarshan already treats it so (research banner, "AI-generated - verify", grades
never in clinical records, blinded doctor grades).

### 1.3 What can be measured instead

| Check | Data | Status |
|---|---|---|
| **External, public**: APTOS 2019 train (3,662 images, India, grades 0-4; Kaggle, competition rules) | Not in the model's training data (model card: IDRiD only) | **Done 25 Oct: weak** (section 5). IDRiD test (103) would need an IEEE DataPort subscription; Messidor-2 can be run the same way |
| **Local, the one that matters**: Sampada's Remidio FOP photographs against the doctor's blinded grade | Doctor's fundus reports in Sudarshan (D-042) | Harness ready (Retina AI > Evaluation). On 25 Oct: 2 photographs, 0 reports. Needs reported photographs |

### 1.4 The plan's Phase 01 interface items, already in Sudarshan

| Plan item | Where |
|---|---|
| Image preview before inference | Grade a photograph (preview from the file); Remidio photographs shown full size |
| Predicted category and every class score | All five scores and raw outputs, highlighted grade |
| Calibrated or not | Labelled "native probabilities"; the page says the score shows which grade won, not how sure the model is |
| Model name, version, checkpoint, evaluation date | Model, commit, SHA-256, grader version on every result; evaluation date in each report |
| Image type, size, channels, preprocessing checks | Grader: type, size (40 MB), decodable, at least 64 x 64, RGB conversion; JPEG/PNG bytes checked for Remidio downloads |
| Unreadable / low quality warnings | Unreadable photographs recorded as "not graded" with the reason; Remidio's own quality flag (SUFFICIENT / INSUFFICIENT) shown on every photograph |
| CSV export without identifiers | Evaluation > Download CSV: codes (P001-RE-01), month, no names, MRDs or dates |

## 2. How the evaluation works (D-043)

- **Reference** = the doctor's DR grade of that eye in the Sudarshan fundus report (D-042). "Blinded" = given before
  that doctor was shown the AI grade of the photograph (from `app.dr_grading_views`); sets use blinded grades only
  unless chosen otherwise.
- **Evaluation set** = which photographs, with their reference grade copied in when the set is made. A draft can be
  discarded; a **frozen** set never changes and is never removed (database trigger). Report figures from frozen sets
  only. Every model is measured on the same frozen set.
- **Metrics** (per model, `services/evaluation.ts`): confusion matrix, per-grade recall / precision / specificity /
  F1, macro-F1 (grades present), quadratic weighted kappa, exact and within-one agreement, referable DR (grade 2 or
  worse) sensitivity / specificity / PPV / NPV, AUROC for referable DR from the score p2+p3+p4.
- **95% intervals**: percentile bootstrap, 2000 resamples of **whole patients** (a patient's two eyes are not
  independent), seed 20261025: the same set always gives the same figures.
- **Cautions** printed with every result: fewer than 100 images, fewer than 30 referable eyes, grades with no
  reference images, ungradable references left out.
- **De-identification**: the CSV carries set codes, eye, field, quality, photo month, grades and scores; the key from
  code to patient stays in `app.eval_set_items` (administrators). AI grades in a CSV are logged as shown to the
  exporter.

## 3. How much data is needed

At about 60 FOP exams a month, a few referable eyes arrive each month. **Sensitivity needs about 100 referable eyes**
before its interval is useful (with 30 the 95% interval is roughly +/- 15 percentage points). Ways to get there sooner:
photograph known DR patients (Patients > Diabetic retinopathy, 1,805 patients) on the FOP at their visits, and have
every FOP session reported in Sudarshan. The March 2026 Remidio batch (652 doctor-graded photographs, mostly no DR) can
add specificity data if Pavin decides to import it.

## 4. Next steps (Pavin's plan, re-ordered 25 Oct)

1. Done: this harness and report. Run the IDRiD test check (RUNBOOK 12) and add the result below.
2. RFM (MIT code, DINOv3-licensed weights, trained DR heads) as a second grader, after the decision on loading its
   PyTorch `.pt` weights safely (`weights_only=True`, pinned checksum, conversion in an isolated container).
3. A Sampada-specific head on frozen RFM features once a few hundred blinded, reported eyes exist (patient-level
   split; GPU outside clinic hours; consent and ethics advice first).
4. RETFound (CC BY-NC, research only) and RetSAM (PolyForm Noncommercial, research and teaching overlays) later.

## 4b. RFM (Phase 2, D-044): what is installed and on what terms

**Installed 25 Oct 2026** as a second research grader in its own container `sampada-rfm` (`graders/rfm/` in this
repository; image `sampada-rfm:1.0.0`; 127.0.0.1:7861 only; CPU, 8 cores, 4 GB, read-only, no capabilities; weights
read-only from `D:\models\rfm\weights`, outside git). Arko007's container, Sudarshan and its screens are unchanged; RFM
grades nothing in Sudarshan yet (console benchmarks only).

| Item | Version / checksum |
|---|---|
| Method source (read, not run) | github.com/ok1zjf/RFM @ `b8c9322863b5e2d79df964e524d74ad53d1d1b7a` (8 Oct 2026, the only commit); preprint doi 10.64898/2026.10.02.26362554 |
| Backbone `rfm-1.3.pt` | 257,551,717 bytes, SHA-256 `fdb51814aeea26463c39b1cd254e473eb6005f52abb1dff92bb83010039bf2f3`; official Google Drive link in the README; DINOv3 ViT-B/16 continued-pretrained (LeJEPA) on 4.3M fundus photographs of the North East London Diabetic Eye Screening Programme; truncated to blocks 0-8. The authors publish no checksum, so integrity rests on the official link plus this recorded value |
| APTOS head | `released/aptos_rfm/checkpoints/best.pt`, SHA-256 `3e913fbf...addaa2a5`, epoch 121, validation AUROC 0.944; trained on APTOS split `t` (2,048), chosen on `v` (514), tested on `e` (1,100) |
| Messidor-2 head | SHA-256 `950279ef...06fc36`, epoch 155, validation AUROC 0.896; trained and chosen on Messidor-2 only |
| IDRiD head | SHA-256 `5fa29ab9...6c7191`, epoch 70, validation AUROC 0.896; trained on IDRiD |
| Runtime | python 3.11, torch 2.5.1 (CPU), torchvision 0.20.1, timm 1.0.24, pillow 11.1.0 (PyPI build: libjpeg-turbo, so not bit-identical to the paper's IJG build); about 0.2 s per photograph |

**Safe loading (checked before installing):** every file's pickle was parsed with `pickletools` (nothing executed): each
imports only `collections.OrderedDict`, `torch.FloatStorage` and `torch._utils._rebuild_tensor_v2`, so
`torch.load(weights_only=True)` loads them and no unsafe deserialisation is needed (RFM's own loader uses
`weights_only=False`; we do not). The grader refuses to start unless each file matches its pinned SHA-256 and passes the
same opcode check. No RFM repository code runs: the model is rebuilt from the published method on stock timm.

**Preprocessing and model (as RFM's code, re-implemented):** RGB; short side to 512 (Lanczos), centre square crop for the
APTOS/IDRiD heads (aspect kept for the Messidor-2 head); JPEG quality 95 round trip; resize 336 bicubic; centre crop 336;
normalise with RFM's fundus statistics (mean 0.4271/0.2472/0.1366, std 0.2610/0.1619/0.0927); timm
`vit_base_patch16_dinov3.lvd1689m` with RFM weights; features = block-8 CLS token + mean of patch tokens (1,536); head =
LayerNorm + Linear(5); softmax. Grades 0-4 (ICDR), as Arko007.

**Licences, each part separately (25 Oct 2026; not legal advice; Pavin to confirm with a lawyer before any use beyond research):**

| Part | Licence found | Research | Internal clinical evaluation (silent, no effect on care) | Commercial / clinical deployment |
|---|---|---|---|---|
| RFM code (used only as the description of the method) | MIT, (c) 2026 Jiri Fajtl | Yes | Yes | Yes, with the MIT notice |
| Backbone weights `rfm-1.3.pt` | DINOv3 License (Meta, 14 Aug 2025), as the README states | Yes | Appears permitted: the text has no medical restriction | Not prohibited by the text, **but**: indemnity to Meta, Meta may change the terms, California law, no reverse engineering, trade controls, "Built with DINOv3" notice required, copy of the licence with any distribution. **Open question for the authors:** the weights were trained on NHS screening photographs; whether NHS data-sharing terms limit use of the weights is not stated |
| Classifier heads (`released/*/best.pt`) | **None stated** (README's licence section covers code and backbone only) | Reasonable for a research benchmark | Same, while silent | **Not established: needs the author's written permission.** The heads were also trained on APTOS (Kaggle competition rules), IDRiD (CC BY 4.0) and Messidor-2 (its own licence; Messidor terms have restricted commercial use) |
| DINOv3 License itself | Grants use, copy, modify, distribute; no user or revenue threshold; prohibits ITAR/military/nuclear/espionage/weapons uses and sanctioned parties; "AS IS", no liability; termination on breach or on suing Meta for IP | Yes | Yes | Allowed in principle, with the obligations above |

Conclusion: **research benchmarking is covered; no clinical or commercial use until Pavin (with legal advice) has the
heads' permission from the author, a view on the NHS-data question, and accepts the DINOv3 terms.**

**Sampada's stated use (Pavin, 25 Oct 2026): non-commercial research only, at most assisting the doctor and comparing
the doctor's and the AI's results; no commercial use of any model.** This is within the research use the licences allow.
To stay research-grade the AI result is shown to a doctor only after that doctor's own report (silent mode, D-045), so
the comparison stays unbiased. Writing to the RFM author about the heads remains advisable before any publication. A head trained by
Sampada on its own photographs (step 3) would avoid the heads question, though not the backbone's.

## 5. Results log

| Date | Model | Data | Result | Report |
|---|---|---|---|---|
| 25 Oct 2026 | Arko007 cd4b10c3 | APTOS 2019 train, 3,662 images (India, several clinic cameras; 1,487 referable). Not seen in training (model card: IDRiD only) | Referable DR sensitivity **70.4%** (95% CI 68.0-72.7), specificity **63.1%** (61.1-65.1), PPV 56.6%, NPV 75.7%; AUROC **0.703** (0.686-0.721); weighted kappa **0.437** (0.410-0.462); macro-F1 0.286; exact grade 41.2%. Proliferative DR called "No DR" in 75 of 295 eyes (25%); 563 of 1,805 normal eyes (31%) called moderate NPDR; mild NPDR recall 4% | `outputs/retina-eval/APTOS_2019_train-2026-10-25.md` |
| (not run) | Arko007 cd4b10c3 | IDRiD test (103) | IEEE DataPort now needs a subscription (free only to IEEE Society members); not pursued | |
| 25 Oct 2026 | RFM APTOS head (f1a558fc) | APTOS split `e`, 1,100 images **never used by the head** (trained on `t`, chosen on `v`) | Reproduces RFM's published figure exactly: macro one-vs-rest AUROC **0.946** (0.935-0.957), as published. Referable DR (argmax) sensitivity 89.5%, specificity 95.1%, AUROC 0.984, kappa 0.883 | `RFM_aptos_head_-_APTOS_untouched_test_1100_-...md` |
| 25 Oct 2026 | Arko007 | the same 1,100 | sensitivity 70.2%, specificity 60.3%, AUROC 0.696, kappa 0.396 | `Arko007_-_APTOS_untouched_test_1100_-...md` |
| 25 Oct 2026 | RFM Messidor-2 head (b23dcc9b) | all 3,662 APTOS (head never saw APTOS: cross-dataset) | sensitivity 98.2%, specificity 60.9%, AUROC 0.963, kappa 0.603 (argmax) | `RFM_messidor_head_-_APTOS_all_3662_-...md` |
| 25 Oct 2026 | RFM APTOS head | all 3,662 | **Contaminated** (2,562 of these trained or chose the head): 92.4% / 96.2%, AUROC 0.990; reference only, not evidence | `..._CONTAMINATED_-...md` |

**Paired comparison on the 1,100 untouched images** (`compare-APTOS_untouched_test_1100_...md`): RFM APTOS head minus
Arko007: sensitivity **+19.2 points** (95% CI 14.5 to 24.2), specificity **+34.8** (30.8 to 38.7), AUROC +0.288, kappa
+0.487. Referable eyes graded 0-1: severe NPDR 12 of 58 (Arko007) vs 1 of 58 (RFM); PDR 30 of 89 (29 called "No DR") vs
10 of 89 (none called "No DR"). Missed by both 17; only by Arko007 116; only by RFM 30.

**Screening, three outcomes** (cut-offs chosen on APTOS `v`, 514 images; applied once to `e`, 1,100;
`screening-APTOS_screening_v-to-e-...md`):

| Test (1,100 images, 447 referable) | Arko007 | RFM APTOS head | RFM Messidor-2 head |
|---|---|---|---|
| Cut-offs refer / clear (p2+p3+p4) | 7e-6 / 0 | 0.2559 / 0.0385 | 0.8117 / 0.1568 |
| Sensitivity (referable not cleared) | 100% only by referring every eye | **99.1%** (98.2-99.8) | **99.6%** (98.9-100) |
| Severe NPDR / PDR cleared | 0 / 0 | 0 / **1** | 0 / 0 |
| Specificity | 0% | **84.8%** (82.0-87.6) | 34.2% (30.5-37.8) |
| NPV | n/a | 99.3% | 99.1% |
| Referral rate (refer + uncertain) | 100% | 49.3% | 79.5% |
| Refer / uncertain / routine | 931 / 169 / 0 | 471 / 71 / 558 | 547 / 328 / 225 |

Two outcomes at the 95% refer cut-off only: Arko007 92.2% sensitivity / 20.5% specificity (12 PDR missed); RFM APTOS
95.7% / 93.4% (5 PDR missed); RFM Messidor-2 95.3% / 81.5% (1 severe, 3 PDR missed): **a single cut-off misses PDR; the
uncertain band is needed.** Full operating table (90 / 95 / 97.5 / 99% targets) in the report. Validation targets held on
test (99.0% chosen, 99.1% and 99.6% achieved).

**Reading and recommendation (25 Oct 2026):**
- **Arko007 cannot screen**: to miss no referable eye it has to refer everyone; it stays a research baseline only (D-044).
- **RFM is the candidate.** The APTOS head is the strongest, but APTOS is its own source (same cameras and clinics as its
  training images), so its 84.8% specificity is an optimistic estimate of how it will do on a new camera. The Messidor-2
  head, tested on a camera and population it never saw, kept **99.6% sensitivity with no severe or PDR eye cleared**, at
  the cost of specificity: that is the honest picture of what a camera change does.
- **Recommended for validation on Sampada photographs:** the RFM backbone with **both heads graded side by side in silent
  mode**, three outcomes, starting cut-offs **APTOS head refer 0.2559 / clear 0.0385** and **Messidor-2 head refer 0.8117 /
  clear 0.1568** (99% validation sensitivity), plus ungradable (Remidio INSUFFICIENT or doctor "cannot be graded") always
  uncertain. These APTOS cut-offs are a starting point only: the Remidio FOP will shift the scores, so **cut-offs must be
  re-chosen on a Sampada validation set and confirmed once on a frozen, untouched Sampada test set**, patients kept
  together. Proposed acceptance before any wider use (for Pavin and Dr. Sameera to agree): referable sensitivity >= 95%
  with the lower 95% bound >= 90%, **no severe NPDR or PDR eye cleared**, NPV >= 98%, specificity and referral rate
  reported; DR result never clears a patient on its own.
- One APTOS PDR eye cleared by the APTOS head (`eaa0dfbd5024`) and the 10 severe/PDR eyes it graded 0-1 are listed in
  the reports for a doctor to look at (public images).

**Reading (25 Oct):** on a large external set from a similar population the existing model is weak: about 3 in 10
referable eyes missed and 1 in 3 non-referable eyes flagged; established DR screening systems are expected to reach well
above 85% sensitivity at good specificity. Not comparable one-to-one with published figures of other models (different
splits and measures), but enough to decide: **the existing model must not be relied on, even as a second look, and is to
be replaced as the default as soon as another model does better on the same frozen sets** (step 2, RFM). Caveats: APTOS is
not the Remidio FOP; its images are resampled one by one (patients unknown), so the intervals may be a little narrow;
the model's plain resize (no cropping of black borders) is as its author specified.
