# Retina AI comparison: APTOS untouched test (1100) Arko007 vs RFM APTOS head

**Research use only.** Public images, not Sampada patients and not the Remidio FOP.

Images compared: **1100** (in rfm_untouched_test_e.csv and graded by every model); each image is resampled on its own (patients unknown). Referable DR = grade 2 or worse; AUROC from p2+p3+p4.

## Headline figures (95% intervals)

| Measure | Arko007 | RFM (APTOS head) |
|---|---|---|
| Referable DR sensitivity | 70.2% (65.9% to 74.5%), 314/447 | 89.5% (86.8% to 92.2%), 400/447 |
| Referable DR specificity | 60.3% (56.5% to 64.1%), 394/653 | 95.1% (93.4% to 96.6%), 621/653 |
| PPV / NPV | 54.8% / 74.8% | 92.6% / 93.0% |
| AUROC, referable | 0.696 (0.665 to 0.727) | 0.984 (0.978 to 0.989) |
| Weighted kappa | 0.396 (0.345 to 0.446) | 0.883 (0.861 to 0.903) |
| Macro-F1 | 0.257 | 0.673 |
| Exact grade | 38.4% | 83.4% |
| Recall, grade 0 No DR (542) | 55.0% (50.7% to 59.2%) | 98.3% (97.2% to 99.3%) |
| Recall, grade 1 Mild NPDR (111) | 2.7% (0.0% to 6.1%) | 65.8% (56.7% to 74.3%) |
| Recall, grade 2 Moderate NPDR (300) | 26.7% (21.8% to 31.8%) | 83.3% (79.4% to 87.2%) |
| Recall, grade 3 Severe NPDR (58) | 19.0% (9.6% to 29.7%) | 36.2% (24.1% to 48.6%) |
| Recall, grade 4 Proliferative DR (89) | 33.7% (23.9% to 44.0%) | 44.9% (34.4% to 54.7%) |

## Paired differences against Arko007 (95% intervals; an interval not containing 0 is a real difference on these images)

| Model | Sensitivity | Specificity | AUROC | Kappa |
|---|---|---|---|---|
| RFM (APTOS head) | +19.2 pts (14.5 pts to 24.2 pts) | +34.8 pts (30.8 pts to 38.7 pts) | +0.288 (0.257 to 0.319) | +0.487 (0.435 to 0.541) |

## False negatives (referable eye graded 0 or 1)

| Reference grade | Eyes | Arko007 missed | RFM (APTOS head) missed | Arko007: called No DR | RFM (APTOS head): called No DR |
|---|---|---|---|---|---|
| 2 Moderate NPDR | 300 | 91 (30.3%) | 36 (12.0%) | 82 | 5 |
| 3 Severe NPDR | 58 | 12 (20.7%) | 1 (1.7%) | 11 | 0 |
| 4 Proliferative DR | 89 | 30 (33.7%) | 10 (11.2%) | 29 | 0 |

Missed by both: 17; only by Arko007: 116; only by RFM (APTOS head): 30.

Severe or proliferative eyes missed by RFM (APTOS head) (image ids, for review): 3ee4841936ef, 753b14c27c83, 7a6e384a0846, 7e0598cc88a0, 8bed09514c3b, a32b5ce3d48a, b37aae3c8fe1, d48178e4a49b, eaa0dfbd5024, ed246ae1ed08, fce93caa4758.

## Confusion matrices (rows = reference grade, columns = model grade)

**Arko007**

| Reference \ Model | 0 | 1 | 2 | 3 | 4 |
|---|---|---|---|---|---|
| 0 No DR | 298 | 53 | 180 | 1 | 10 |
| 1 Mild NPDR | 40 | 3 | 41 | 2 | 25 |
| 2 Moderate NPDR | 82 | 9 | 80 | 36 | 93 |
| 3 Severe NPDR | 11 | 1 | 5 | 11 | 30 |
| 4 Proliferative DR | 29 | 1 | 17 | 12 | 30 |

**RFM (APTOS head)**

| Reference \ Model | 0 | 1 | 2 | 3 | 4 |
|---|---|---|---|---|---|
| 0 No DR | 533 | 8 | 1 | 0 | 0 |
| 1 Mild NPDR | 7 | 73 | 29 | 0 | 2 |
| 2 Moderate NPDR | 5 | 31 | 250 | 10 | 4 |
| 3 Severe NPDR | 0 | 1 | 24 | 21 | 12 |
| 4 Proliferative DR | 0 | 10 | 30 | 9 | 40 |

## Reproducibility
- Runs: Arko007 = D:\Sudarshan\app\outputs\retina-eval\Arko007_-_APTOS_untouched_test_1100_-2026-10-25.csv; RFM (APTOS head) = D:\Sudarshan\app\outputs\retina-eval\RFM_aptos_head_-_APTOS_untouched_test_1100_-2026-10-25.csv.
- Labels: D:\datasets\APTOS2019\rfm_untouched_test_e.csv. Intervals: percentile bootstrap, 2000 resamples of single images, seed 20261025; differences paired on the same resamples.
- Made 2026-10-25T13:26:13.360Z with node dist/cli.js retina-eval-compare.
