# Briefing Backtest Report
**Generated:** 2026-07-08
**Predictions analyzed:** 44
**Scored calls (excluding informational holds/watches):** 548

> Methodology: each base-case action is scored against the actual price move
> over 7/30/90 day windows. Buy = correct if price ↑. Trim/Exit = correct if
> price ↓. Hold = correct if price within ±5%. Watch/Monitor = informational.

---

## Overall accuracy by window

| Window | Calls | Correct | Accuracy | Avg Return |
|---|---|---|---|---|
| 7d | 330 | 175 | 53.0% | +0.10% |
| 30d | 218 | 54 | 24.8% | -1.75% |

## By action type

| Action | 7d accuracy | 30d accuracy |
|---|---|---|
| buy | 60.0% | 100.0% |
| hold | 51.6% | 24.0% |
| trim | 76.5% | 25.0% |

## By conviction

| Conviction | 7d accuracy | 30d accuracy |
|---|---|---|
| high | 37.0% | 28.8% |
| medium | 56.0% | 25.9% |
| low | 57.1% | 11.1% |

## Calibration — do "high" calls outperform "medium"?

| Window | High % | Medium % | Low % | Calibrated? |
|---|---|---|---|---|
| 7d | 37.0% | 56.0% | 57.1% | ❌ No (inverted) |
| 30d | 28.8% | 25.9% | 11.1% | ✅ Yes |

## Top 10 best 30d returns

| Date | Ticker | Action | Conv. | Return | Correct? |
|---|---|---|---|---|---|
| 2026-06-04 | NVO | trim | medium | +20.07% | ❌ |
| 2026-06-03 | NVO | trim | medium | +17.50% | ❌ |
| 2026-06-03 | NVO | trim | medium | +17.50% | ❌ |
| 2026-06-02 | AOT.BK | hold | low | +17.19% | ❌ |
| 2026-06-02 | AOT.BK | hold | low | +17.19% | ❌ |
| 2026-06-01 | AOT.BK | hold | low | +16.29% | ❌ |
| 2026-06-01 | AOT.BK | hold | low | +16.29% | ❌ |
| 2026-06-01 | AOT.BK | hold | low | +16.29% | ❌ |
| 2026-06-08 | CRWD | hold | medium | +16.01% | ❌ |
| 2026-06-05 | NVO | hold | low | +15.27% | ❌ |

## Top 10 worst 30d returns

| Date | Ticker | Action | Conv. | Return | Correct? |
|---|---|---|---|---|---|
| 2026-05-29 | RGTI | hold | low | -32.08% | ❌ |
| 2026-05-29 | IONQ | trim | medium | -29.70% | ✅ |
| 2026-05-30 | PLTR | hold | high | -27.86% | ❌ |
| 2026-05-30 | PLTR | hold | high | -27.86% | ❌ |
| 2026-05-27 | RGTI | trim | medium | -26.55% | ✅ |
| 2026-05-27 | RGTI | trim | medium | -26.55% | ✅ |
| 2026-05-27 | RGTI | hold | low | -26.55% | ❌ |
| 2026-05-31 | PLTR | hold | high | -26.09% | ❌ |
| 2026-05-31 | PLTR | hold | high | -26.09% | ❌ |
| 2026-05-28 | RGTI | hold | low | -25.43% | ❌ |

## Interpretation hints

- Accuracy <50% means the signal is worse than a coin flip → distrust or invert
- Calibration ❌ means high-conviction calls did NOT outperform medium → adjust the model
- Top winners/losers help spot systematic biases (e.g. always wrong on a sector)
