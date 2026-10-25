# Retina AI on the public dataset "Arko007 - APTOS untouched test (1100)"

**Research use only.** The model is not a medical device; these figures do not make it fit for clinical use.

## Data
- 1100 images from D:\datasets\APTOS2019\train_images; labels D:\datasets\APTOS2019\rfm_untouched_test_e.csv (columns "id_code", "diagnosis").
- Public dataset, not Sampada patients: shows how the model does on another camera and population, not on the Remidio FOP.
- Each image is resampled on its own (which images share a patient is not known), so intervals may be too narrow.

## Model
- Arko007/diabetic-retinopathy-v1, commit 05e5b0f, model SHA-256 cd4b10c3e5bb1043ac01098284a1136bb423a0eafe7a2445587e969d370f3ffc
- grader 1.0.0, output native_probabilities

## Results

Eye images: **1100** (which images share a patient is not known). Referable DR = grade 2 (moderate NPDR) or worse.

| Measure | Value |
|---|---|
| Referable DR sensitivity | 70.2% (95% CI 65.9% to 74.5%), 314 of 447 found |
| Referable DR specificity | 60.3% (95% CI 56.5% to 64.1%), 394 of 653 |
| Referable DR PPV / NPV | 54.8% / 74.8% |
| AUROC, referable DR (score p2+p3+p4) | 0.696 (95% CI 0.665 to 0.727) |
| Quadratic weighted kappa | 0.396 (95% CI 0.345 to 0.446) |
| Macro-F1 (grades present) | 0.257 (95% CI 0.229 to 0.287) |
| Exact grade / within one grade | 38.4% (95% CI 35.5% to 41.4%) / 58.9% |

| Grade | Reference images | Recall (sensitivity) | Precision | Specificity | F1 |
|---|---|---|---|---|---|
| 0 No DR | 542 | 55.0% (95% CI 50.7% to 59.2%) | 64.8% | 71.0% | 0.595 |
| 1 Mild NPDR | 111 | 2.7% (95% CI 0.0% to 6.1%) | 4.5% | 93.5% | 0.034 |
| 2 Moderate NPDR | 300 | 26.7% (95% CI 21.8% to 31.8%) | 24.8% | 69.6% | 0.257 |
| 3 Severe NPDR | 58 | 19.0% (95% CI 9.6% to 29.7%) | 17.7% | 95.1% | 0.183 |
| 4 Proliferative DR | 89 | 33.7% (95% CI 23.9% to 44.0%) | 16.0% | 84.4% | 0.217 |

Confusion matrix (rows = reference grade, columns = model grade):

| Reference \ Model | 0 | 1 | 2 | 3 | 4 |
|---|---|---|---|---|---|
| 0 No DR | 298 | 53 | 180 | 1 | 10 |
| 1 Mild NPDR | 40 | 3 | 41 | 2 | 25 |
| 2 Moderate NPDR | 82 | 9 | 80 | 36 | 93 |
| 3 Severe NPDR | 11 | 1 | 5 | 11 | 30 |
| 4 Proliferative DR | 29 | 1 | 17 | 12 | 30 |

## Cautions
- None beyond the general ones above.

## Reproducibility
- 95% intervals: percentile bootstrap, 2000 resamples of single images, seed 20261025.
- Run 2026-10-25T13:25:39.269Z with node dist/cli.js retina-eval-external.
