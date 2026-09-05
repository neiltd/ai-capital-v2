# Briefing Backtest Report
**Generated:** 2026-09-05
**Predictions analyzed:** 44
**Scored calls (excluding informational holds/watches):** 935

> Methodology: each base-case action is scored against the actual price move
> over 7/30/90 day windows. Buy = correct if price ↑. Trim/Exit = correct if
> price ↓. Hold = correct if price within ±5%. Watch/Monitor = informational.

---

## Overall accuracy by window

| Window | Calls | Correct | Accuracy | Avg Return |
|---|---|---|---|---|
| 7d | 358 | 196 | 54.7% | +0.24% |
| 30d | 362 | 113 | 31.2% | +1.78% |
| 90d | 215 | 42 | 19.5% | -1.27% |

## By action type

| Action | 7d accuracy | 30d accuracy | 90d accuracy |
|---|---|---|---|
| buy | 42.9% | 85.7% | 100.0% |
| hold | 53.9% | 30.4% | 18.4% |
| trim | 76.5% | 25.0% | 23.5% |

## By conviction

| Conviction | 7d accuracy | 30d accuracy | 90d accuracy |
|---|---|---|---|
| high | 42.4% | 28.1% | 15.4% |
| medium | 57.0% | 33.7% | 22.6% |
| low | 58.6% | 13.8% | 11.5% |

## Calibration — do "high" calls outperform "medium"?

| Window | High % | Medium % | Low % | Calibrated? |
|---|---|---|---|---|
| 7d | 42.4% | 57.0% | 58.6% | ❌ No (inverted) |
| 30d | 28.1% | 33.7% | 13.8% | ❌ No (inverted) |
| 90d | 15.4% | 22.6% | 11.5% | ❌ No (inverted) |

## Top 10 best 90d returns

| Date | Ticker | Action | Conv. | Return | Correct? |
|---|---|---|---|---|---|
| 2026-05-28 | NET | hold | medium | +32.67% | ❌ |
| 2026-05-27 | NET | hold | low | +28.87% | ❌ |
| 2026-05-27 | NET | hold | low | +28.87% | ❌ |
| 2026-05-27 | NET | hold | medium | +28.87% | ❌ |
| 2026-05-27 | NOW | hold | medium | +28.15% | ❌ |
| 2026-05-27 | NOW | hold | medium | +28.15% | ❌ |
| 2026-05-27 | NOW | hold | medium | +28.15% | ❌ |
| 2026-06-06 | CRWD | hold | medium | +28.15% | ❌ |
| 2026-05-30 | NET | hold | medium | +27.46% | ❌ |
| 2026-05-30 | NET | hold | medium | +27.46% | ❌ |

## Top 10 worst 90d returns

| Date | Ticker | Action | Conv. | Return | Correct? |
|---|---|---|---|---|---|
| 2026-05-30 | APP | hold | medium | -49.01% | ❌ |
| 2026-05-30 | APP | hold | medium | -49.01% | ❌ |
| 2026-05-29 | APP | hold | medium | -48.64% | ❌ |
| 2026-06-03 | APP | hold | medium | -48.47% | ❌ |
| 2026-06-03 | APP | hold | medium | -48.47% | ❌ |
| 2026-06-02 | APP | hold | medium | -48.22% | ❌ |
| 2026-06-02 | APP | hold | medium | -48.22% | ❌ |
| 2026-06-01 | APP | hold | medium | -48.17% | ❌ |
| 2026-06-01 | APP | hold | medium | -48.17% | ❌ |
| 2026-06-01 | APP | hold | medium | -48.17% | ❌ |

## Interpretation hints

- Accuracy <50% means the signal is worse than a coin flip → distrust or invert
- Calibration ❌ means high-conviction calls did NOT outperform medium → adjust the model
- Top winners/losers help spot systematic biases (e.g. always wrong on a sector)
