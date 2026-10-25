# Retina AI on the public dataset "RFM aptos head - APTOS untouched test (1100)"

**Research use only.** The model is not a medical device; these figures do not make it fit for clinical use.

## Data
- 1100 images from D:\datasets\APTOS2019\train_images; labels D:\datasets\APTOS2019\rfm_untouched_test_e.csv (columns "id_code", "diagnosis").
- Public dataset, not Sampada patients: shows how the model does on another camera and population, not on the Remidio FOP.
- Each image is resampled on its own (which images share a patient is not known), so intervals may be too narrow.

## Model
- ok1zjf/RFM (aptos head), commit b8c9322, model SHA-256 f1a558fc09dbc07452bdd3570f4aa6af84f2bc2550c794cb88ff419c1efaaefb
- grader 1.0.0, output softmax_applied

## Results

Eye images: **1100** (which images share a patient is not known). Referable DR = grade 2 (moderate NPDR) or worse.

| Measure | Value |
|---|---|
| Referable DR sensitivity | 89.5% (95% CI 86.8% to 92.2%), 400 of 447 found |
| Referable DR specificity | 95.1% (95% CI 93.4% to 96.6%), 621 of 653 |
| Referable DR PPV / NPV | 92.6% / 93.0% |
| AUROC, referable DR (score p2+p3+p4) | 0.984 (95% CI 0.978 to 0.989) |
| Quadratic weighted kappa | 0.883 (95% CI 0.861 to 0.903) |
| Macro-F1 (grades present) | 0.673 (95% CI 0.633 to 0.711) |
| Exact grade / within one grade | 83.4% (95% CI 81.2% to 85.4%) / 95.2% |

| Grade | Reference images | Recall (sensitivity) | Precision | Specificity | F1 |
|---|---|---|---|---|---|
| 0 No DR | 542 | 98.3% (95% CI 97.2% to 99.3%) | 97.8% | 97.8% | 0.981 |
| 1 Mild NPDR | 111 | 65.8% (95% CI 56.7% to 74.3%) | 59.3% | 94.9% | 0.624 |
| 2 Moderate NPDR | 300 | 83.3% (95% CI 79.4% to 87.2%) | 74.9% | 89.5% | 0.789 |
| 3 Severe NPDR | 58 | 36.2% (95% CI 24.1% to 48.6%) | 52.5% | 98.2% | 0.429 |
| 4 Proliferative DR | 89 | 44.9% (95% CI 34.4% to 54.7%) | 69.0% | 98.2% | 0.544 |

Confusion matrix (rows = reference grade, columns = model grade):

| Reference \ Model | 0 | 1 | 2 | 3 | 4 |
|---|---|---|---|---|---|
| 0 No DR | 533 | 8 | 1 | 0 | 0 |
| 1 Mild NPDR | 7 | 73 | 29 | 0 | 2 |
| 2 Moderate NPDR | 5 | 31 | 250 | 10 | 4 |
| 3 Severe NPDR | 0 | 1 | 24 | 21 | 12 |
| 4 Proliferative DR | 0 | 10 | 30 | 9 | 40 |

## Cautions
- None beyond the general ones above.

## Reproducibility
- 95% intervals: percentile bootstrap, 2000 resamples of single images, seed 20261025.
- Run 2026-10-25T13:16:02.141Z with node dist/cli.js retina-eval-external.
