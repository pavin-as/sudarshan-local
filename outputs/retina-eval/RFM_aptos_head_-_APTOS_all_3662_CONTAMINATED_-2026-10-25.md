# Retina AI on the public dataset "RFM aptos head - APTOS all (3662, CONTAMINATED)"

**Research use only.** The model is not a medical device; these figures do not make it fit for clinical use.

## Data
- 3662 images from D:\datasets\APTOS2019\train_images; labels D:\datasets\APTOS2019\train.csv (columns "id_code", "diagnosis").
- Public dataset, not Sampada patients: shows how the model does on another camera and population, not on the Remidio FOP.
- Each image is resampled on its own (which images share a patient is not known), so intervals may be too narrow.

## Model
- ok1zjf/RFM (aptos head), commit b8c9322, model SHA-256 f1a558fc09dbc07452bdd3570f4aa6af84f2bc2550c794cb88ff419c1efaaefb
- grader 1.0.0, output softmax_applied

## Results

Eye images: **3662** (which images share a patient is not known). Referable DR = grade 2 (moderate NPDR) or worse.

| Measure | Value |
|---|---|
| Referable DR sensitivity | 92.4% (95% CI 91.0% to 93.7%), 1374 of 1487 found |
| Referable DR specificity | 96.2% (95% CI 95.4% to 97.0%), 2092 of 2175 |
| Referable DR PPV / NPV | 94.3% / 94.9% |
| AUROC, referable DR (score p2+p3+p4) | 0.990 (95% CI 0.988 to 0.992) |
| Quadratic weighted kappa | 0.915 (95% CI 0.906 to 0.925) |
| Macro-F1 (grades present) | 0.763 (95% CI 0.742 to 0.782) |
| Exact grade / within one grade | 87.5% (95% CI 86.4% to 88.5%) / 96.3% |

| Grade | Reference images | Recall (sensitivity) | Precision | Specificity | F1 |
|---|---|---|---|---|---|
| 0 No DR | 1805 | 98.9% (95% CI 98.4% to 99.4%) | 98.1% | 98.1% | 0.985 |
| 1 Mild NPDR | 370 | 71.6% (95% CI 67.0% to 76.4%) | 69.0% | 96.4% | 0.703 |
| 2 Moderate NPDR | 999 | 88.2% (95% CI 86.0% to 90.1%) | 79.4% | 91.4% | 0.836 |
| 3 Severe NPDR | 193 | 53.4% (95% CI 46.5% to 60.2%) | 72.5% | 98.9% | 0.615 |
| 4 Proliferative DR | 295 | 57.3% (95% CI 51.5% to 62.9%) | 82.0% | 98.9% | 0.675 |

Confusion matrix (rows = reference grade, columns = model grade):

| Reference \ Model | 0 | 1 | 2 | 3 | 4 |
|---|---|---|---|---|---|
| 0 No DR | 1786 | 17 | 2 | 0 | 0 |
| 1 Mild NPDR | 24 | 265 | 79 | 0 | 2 |
| 2 Moderate NPDR | 11 | 78 | 881 | 16 | 13 |
| 3 Severe NPDR | 0 | 3 | 65 | 103 | 22 |
| 4 Proliferative DR | 0 | 21 | 82 | 23 | 169 |

## Cautions
- None beyond the general ones above.

## Reproducibility
- 95% intervals: percentile bootstrap, 2000 resamples of single images, seed 20261025.
- Run 2026-10-25T13:44:51.818Z with node dist/cli.js retina-eval-external.
