# AI_EVALUATION.md - how the retina AI is measured, and the Phase 01 report

Research use only. Nothing here makes any model fit for clinical use (COMPLIANCE.md, D-040).
Decisions: D-040 (research grader), D-041 (Remidio photographs), D-042 (doctor's fundus report), D-043 (evaluation).

## 1. Phase 01 report: the existing model (Arko007/diabetic-retinopathy-v1)

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
| **External, public**: IDRiD official test split (103 images, grades 0-4) | IDRiD "B. Disease Grading" (IEEE DataPort, CC BY 4.0; downloaded by a person) | Tool ready: `cli retina-eval-external` (RUNBOOK 12). Caveat 1.2-3 applies. Messidor-2 and APTOS can be run the same way (each under its own terms) |
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

## 5. Results log

| Date | Model | Data | Result | Report |
|---|---|---|---|---|
| (to fill) | Arko007 cd4b10c3 | IDRiD test (103) | | `outputs/retina-eval/` |
