# Briefing Backtest Report
**Generated:** 2026-10-01
**Predictions analyzed:** 75
**Scored calls (excluding informational holds/watches):** 1377

> Methodology: each base-case action is scored against the actual price move
> over 7/30/90 day windows. Buy = correct if price ↑. Trim/Exit = correct if
> price ↓. Hold = correct if price within ±5%. Watch/Monitor = informational.

---

## Overall accuracy by window

| Window | Calls | Correct | Accuracy | Avg Return |
|---|---|---|---|---|
| 7d | 577 | 397 | 68.8% | +0.65% |
| 30d | 546 | 259 | 47.4% | +3.83% |
| 90d | 254 | 83 | 32.7% | +8.58% |

## By action type

| Action | 7d accuracy | 30d accuracy | 90d accuracy |
|---|---|---|---|
| buy | 70.6% | 95.7% | 100.0% |
| hold | 69.0% | 45.9% | 28.2% |
| trim | 60.0% | 23.1% | 33.3% |

## By conviction

| Conviction | 7d accuracy | 30d accuracy | 90d accuracy |
|---|---|---|---|
| high | 56.2% | 54.8% | 43.8% |
| medium | 68.3% | 47.9% | 29.2% |
| low | 80.5% | 38.5% | 26.3% |

## Calibration — do "high" calls outperform "medium"?

| Window | High % | Medium % | Low % | Calibrated? |
|---|---|---|---|---|
| 7d | 56.2% | 68.3% | 80.5% | ❌ No (inverted) |
| 30d | 54.8% | 47.9% | 38.5% | ✅ Yes |
| 90d | 43.8% | 29.2% | 26.3% | ✅ Yes |

## Top 10 best 90d returns

| Date | Ticker | Action | Conv. | Return | Correct? |
|---|---|---|---|---|---|
| 2026-06-26 | PLTR | buy | high | +78.79% | ✅ |
| 2026-06-28 | PLTR | hold | medium | +67.95% | ❌ |
| 2026-06-29 | PLTR | buy | high | +67.95% | ✅ |
| 2026-06-30 | PLTR | buy | medium | +63.93% | ✅ |
| 2026-06-25 | PLTR | hold | medium | +62.99% | ❌ |
| 2026-07-01 | PLTR | hold | medium | +60.69% | ❌ |
| 2026-06-25 | NET | hold | medium | +57.96% | ❌ |
| 2026-06-24 | PLTR | buy | medium | +56.89% | ✅ |
| 2026-06-24 | NET | hold | medium | +56.34% | ❌ |
| 2026-06-26 | NET | buy | high | +55.45% | ✅ |

## Top 10 worst 90d returns

| Date | Ticker | Action | Conv. | Return | Correct? |
|---|---|---|---|---|---|
| 2026-05-30 | APP | hold | medium | -49.01% | ❌ |
| 2026-05-29 | APP | hold | medium | -48.64% | ❌ |
| 2026-06-03 | APP | hold | medium | -48.47% | ❌ |
| 2026-06-02 | APP | hold | medium | -48.22% | ❌ |
| 2026-06-01 | APP | hold | medium | -48.17% | ❌ |
| 2026-05-31 | APP | hold | medium | -48.17% | ❌ |
| 2026-06-04 | APP | hold | medium | -45.39% | ❌ |
| 2026-05-28 | APP | hold | medium | -45.31% | ❌ |
| 2026-06-04 | ARM | hold | high | -42.98% | ❌ |
| 2026-05-29 | IONQ | trim | medium | -42.93% | ✅ |

## Interpretation hints

- Accuracy <50% means the signal is worse than a coin flip → distrust or invert
- Calibration ❌ means high-conviction calls did NOT outperform medium → adjust the model
- Top winners/losers help spot systematic biases (e.g. always wrong on a sector)
