# Screening evaluation: APTOS screening v-to-e

**Research use only.** Outcome: referable DR (moderate NPDR or worse) - does the eye need an ophthalmologist? Five-class grading is secondary.
The DR outcome alone never clears a patient: suspected macular oedema, symptoms and image quality need a person.

Validation: rfm_validation_v.csv (514 images, used ONLY to choose cut-offs). Test: rfm_untouched_test_e.csv (1100 images, untouched: cut-offs applied once). No image is in both.
Referral score = p2+p3+p4. Refer cut-off: highest that refers >= 95.0% of validation referable eyes; clear cut-off: highest that refers >= 99.0%. REFER >= refer cut-off; UNCERTAIN between (a person decides, never cleared); ROUTINE below the clear cut-off. Images are resampled one by one (patients unknown).

## Three-outcome screening on the TEST images (cut-offs from validation)

| Measure | Arko007 | RFM APTOS head | RFM Messidor-2 head |
|---|---|---|---|
| Cut-offs (refer / clear) | 7.00e-6 / 0.00e+0 | 0.2559 / 0.0385 | 0.8117 / 0.1568 |
| **Sensitivity (referable not cleared)** | **100.0%** (100.0% to 100.0%) | **99.1%** (98.2% to 99.8%) | **99.6%** (98.9% to 100.0%) |
| Severe NPDR cleared (missed) | 0 of 58 | 0 of 58 | 0 of 58 |
| Proliferative DR cleared (missed) | 0 of 89 | 1 of 89 | 0 of 89 |
| Moderate NPDR cleared (missed) | 0 of 300 | 3 of 300 | 2 of 300 |
| Specificity (non-referable cleared) | 0.0% (0.0% to 0.0%) | 84.8% (82.0% to 87.6%) | 34.2% (30.5% to 37.8%) |
| NPV (cleared eyes truly non-referable) | n/a | 99.3% (98.5% to 99.8%) | 99.1% (97.8% to 100.0%) |
| Referral rate (refer + uncertain) | 100.0% (100.0% to 100.0%) | 49.3% (46.5% to 52.4%) | 79.5% (77.2% to 81.9%) |
| Refer / uncertain / routine | 931 / 169 / 0 | 471 / 71 / 558 | 547 / 328 / 225 |
| Validation check: sensitivity / specificity | 100.0% / 0.0% | 99.0% / 86.3% | 99.0% / 34.6% |

## Two-outcome screening at the refer cut-off only (no uncertain band), TEST images

| Measure | Arko007 | RFM APTOS head | RFM Messidor-2 head |
|---|---|---|---|
| Sensitivity | 92.2% (89.6% to 94.6%) | 95.7% (93.8% to 97.5%) | 95.3% (93.3% to 97.1%) |
| Specificity | 20.5% (17.4% to 23.8%) | 93.4% (91.4% to 95.2%) | 81.5% (78.4% to 84.3%) |
| NPV | 79.3% (73.1% to 85.5%) | 97.0% (95.6% to 98.2%) | 96.2% (94.5% to 97.7%) |
| Referral rate | 84.6% (82.5% to 86.7%) | 42.8% (39.9% to 45.6%) | 49.7% (46.7% to 52.6%) |
| Severe / PDR missed | 1 / 12 | 0 / 5 | 1 / 3 |

## Operating points (cut-off chosen on validation for each target, then test)

| Model | Target sensitivity (validation) | Cut-off | Test sensitivity | Severe / PDR missed | Test specificity | Test NPV | Test referral rate |
|---|---|---|---|---|---|---|---|
| Arko007 | 90.0% | 1.67e-4 | 86.6% | 4 / 19 | 27.3% | 74.8% | 78.4% |
| Arko007 | 95.0% | 7.00e-6 | 92.2% | 1 / 12 | 20.5% | 79.3% | 84.6% |
| Arko007 | 97.5% | 1.00e-6 | 95.3% | 0 / 8 | 15.0% | 82.4% | 89.2% |
| Arko007 | 99.0% | 0.00e+0 | 100.0% | 0 / 0 | 0.0% | n/a | 100.0% |
| RFM APTOS head | 90.0% | 0.5383 | 89.5% | 1 / 10 | 95.1% | 93.0% | 39.3% |
| RFM APTOS head | 95.0% | 0.2559 | 95.7% | 0 / 5 | 93.4% | 97.0% | 42.8% |
| RFM APTOS head | 97.5% | 0.1216 | 97.5% | 0 / 4 | 89.9% | 98.2% | 45.6% |
| RFM APTOS head | 99.0% | 0.0385 | 99.1% | 0 / 1 | 84.8% | 99.3% | 49.3% |
| RFM Messidor-2 head | 90.0% | 0.9048 | 91.3% | 1 / 5 | 88.1% | 93.6% | 44.2% |
| RFM Messidor-2 head | 95.0% | 0.8117 | 95.3% | 1 / 3 | 81.5% | 96.2% | 49.7% |
| RFM Messidor-2 head | 97.5% | 0.5644 | 98.2% | 0 / 1 | 69.4% | 98.3% | 58.1% |
| RFM Messidor-2 head | 99.0% | 0.1568 | 99.6% | 0 / 0 | 34.2% | 99.1% | 79.5% |

## Severe NPDR and PDR eyes cleared on test (image ids, for review)

- Arko007: none
- RFM APTOS head: eaa0dfbd5024
- RFM Messidor-2 head: none

## Reproducibility
- Runs: Arko007 = D:\Sudarshan\app\outputs\retina-eval\APTOS_2019_train-2026-10-25.csv; RFM APTOS head = D:\Sudarshan\app\outputs\retina-eval\RFM_aptos_head_-_APTOS_all_3662_CONTAMINATED_-2026-10-25.csv; RFM Messidor-2 head = D:\Sudarshan\app\outputs\retina-eval\RFM_messidor_head_-_APTOS_all_3662_-2026-10-25.csv.
- Intervals: percentile bootstrap, 2000 resamples of single images, seed 20261025; cut-offs held fixed.
- Made 2026-10-25T13:46:44.089Z with node dist/cli.js retina-eval-screening.
