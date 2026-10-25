# Retina AI on the public dataset "RFM messidor head - APTOS all (3662)"

**Research use only.** The model is not a medical device; these figures do not make it fit for clinical use.

## Data
- 3662 images from D:\datasets\APTOS2019\train_images; labels D:\datasets\APTOS2019\train.csv (columns "id_code", "diagnosis").
- Public dataset, not Sampada patients: shows how the model does on another camera and population, not on the Remidio FOP.
- Each image is resampled on its own (which images share a patient is not known), so intervals may be too narrow.

## Model
- ok1zjf/RFM (messidor head), commit b8c9322, model SHA-256 b23dcc9b2ecde8b562f61e1a046345a799327e0aa0ace36188ca8315ab0efde3
- grader 1.0.0, output softmax_applied

## Results

Eye images: **3662** (which images share a patient is not known). Referable DR = grade 2 (moderate NPDR) or worse.

| Measure | Value |
|---|---|
| Referable DR sensitivity | 98.2% (95% CI 97.5% to 98.8%), 1460 of 1487 found |
| Referable DR specificity | 60.9% (95% CI 58.8% to 63.0%), 1325 of 2175 |
| Referable DR PPV / NPV | 63.2% / 98.0% |
| AUROC, referable DR (score p2+p3+p4) | 0.963 (95% CI 0.957 to 0.968) |
| Quadratic weighted kappa | 0.603 (95% CI 0.582 to 0.623) |
| Macro-F1 (grades present) | 0.347 (95% CI 0.332 to 0.360) |
| Exact grade / within one grade | 46.8% (95% CI 45.2% to 48.5%) / 75.5% |

| Grade | Reference images | Recall (sensitivity) | Precision | Specificity | F1 |
|---|---|---|---|---|---|
| 0 No DR | 1805 | 54.7% (95% CI 52.5% to 57.1%) | 93.4% | 96.2% | 0.690 |
| 1 Mild NPDR | 370 | 1.6% (95% CI 0.5% to 3.0%) | 2.0% | 91.3% | 0.018 |
| 2 Moderate NPDR | 999 | 47.7% (95% CI 44.7% to 50.8%) | 38.0% | 70.7% | 0.423 |
| 3 Severe NPDR | 193 | 36.3% (95% CI 29.7% to 43.1%) | 17.3% | 90.3% | 0.234 |
| 4 Proliferative DR | 295 | 59.0% (95% CI 53.4% to 64.5%) | 26.8% | 85.9% | 0.369 |

Confusion matrix (rows = reference grade, columns = model grade):

| Reference \ Model | 0 | 1 | 2 | 3 | 4 |
|---|---|---|---|---|---|
| 0 No DR | 988 | 284 | 429 | 3 | 101 |
| 1 Mild NPDR | 47 | 6 | 272 | 14 | 31 |
| 2 Moderate NPDR | 20 | 4 | 477 | 254 | 244 |
| 3 Severe NPDR | 0 | 0 | 24 | 70 | 99 |
| 4 Proliferative DR | 3 | 0 | 54 | 64 | 174 |

## Cautions
- None beyond the general ones above.

## Reproducibility
- 95% intervals: percentile bootstrap, 2000 resamples of single images, seed 20261025.
- Run 2026-10-25T13:31:41.400Z with node dist/cli.js retina-eval-external.
