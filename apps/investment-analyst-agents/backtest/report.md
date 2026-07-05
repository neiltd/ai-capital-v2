# Briefing Backtest Report
**Generated:** 2026-07-05
**Predictions analyzed:** 43
**Scored calls (excluding informational holds/watches):** 521

> Methodology: each base-case action is scored against the actual price move
> over 7/30/90 day windows. Buy = correct if price ↑. Trim/Exit = correct if
> price ↓. Hold = correct if price within ±5%. Watch/Monitor = informational.

---

## Overall accuracy by window

| Window | Calls | Correct | Accuracy | Avg Return |
|---|---|---|---|---|
| 7d | 313 | 165 | 52.7% | -0.16% |
| 30d | 208 | 54 | 26.0% | -2.16% |

## By action type

| Action | 7d accuracy | 30d accuracy |
|---|---|---|
| buy | 60.0% | 100.0% |
| hold | 51.2% | 25.3% |
| trim | 76.5% | 25.0% |

## By conviction

| Conviction | 7d accuracy | 30d accuracy |
|---|---|---|
| high | 37.0% | 30.0% |
| medium | 55.8% | 27.1% |
| low | 57.1% | 12.0% |

## Calibration — do "high" calls outperform "medium"?

| Window | High % | Medium % | Low % | Calibrated? |
|---|---|---|---|---|
| 7d | 37.0% | 55.8% | 57.1% | ❌ No (inverted) |
| 30d | 30.0% | 27.1% | 12.0% | ✅ Yes |

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
| 2026-06-05 | NVO | hold | low | +15.27% | ❌ |
| 2026-06-04 | AOT.BK | hold | low | +14.22% | ❌ |

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
