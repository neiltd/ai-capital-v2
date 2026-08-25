# Briefing Backtest Report
**Generated:** 2026-08-25
**Predictions analyzed:** 44
**Scored calls (excluding informational holds/watches):** 758

> Methodology: each base-case action is scored against the actual price move
> over 7/30/90 day windows. Buy = correct if price ↑. Trim/Exit = correct if
> price ↓. Hold = correct if price within ±5%. Watch/Monitor = informational.

---

## Overall accuracy by window

| Window | Calls | Correct | Accuracy | Avg Return |
|---|---|---|---|---|
| 7d | 358 | 196 | 54.7% | +0.24% |
| 30d | 362 | 113 | 31.2% | +1.78% |
| 90d | 38 | 6 | 15.8% | -4.00% |

## By action type

| Action | 7d accuracy | 30d accuracy | 90d accuracy |
|---|---|---|---|
| buy | 42.9% | 85.7% | n/a |
| hold | 53.9% | 30.4% | 11.4% |
| trim | 76.5% | 25.0% | 66.7% |

## By conviction

| Conviction | 7d accuracy | 30d accuracy | 90d accuracy |
|---|---|---|---|
| high | 42.4% | 28.1% | 0.0% |
| medium | 57.0% | 33.7% | 24.0% |
| low | 58.6% | 13.8% | 0.0% |

## Calibration — do "high" calls outperform "medium"?

| Window | High % | Medium % | Low % | Calibrated? |
|---|---|---|---|---|
| 7d | 42.4% | 57.0% | 58.6% | ❌ No (inverted) |
| 30d | 28.1% | 33.7% | 13.8% | ❌ No (inverted) |
| 90d | 0.0% | 24.0% | 0.0% | ❌ No (inverted) |

## Top 10 best 90d returns

| Date | Ticker | Action | Conv. | Return | Correct? |
|---|---|---|---|---|---|
| 2026-05-27 | NET | hold | low | +28.87% | ❌ |
| 2026-05-27 | NET | hold | low | +28.87% | ❌ |
| 2026-05-27 | NET | hold | medium | +28.87% | ❌ |
| 2026-05-27 | NOW | hold | medium | +28.15% | ❌ |
| 2026-05-27 | NOW | hold | medium | +28.15% | ❌ |
| 2026-05-27 | NOW | hold | medium | +28.15% | ❌ |
| 2026-05-27 | V | hold | medium | +17.35% | ❌ |
| 2026-05-27 | V | hold | medium | +17.35% | ❌ |
| 2026-05-27 | V | hold | medium | +17.35% | ❌ |
| 2026-05-27 | LLY | hold | medium | +17.28% | ❌ |

## Top 10 worst 90d returns

| Date | Ticker | Action | Conv. | Return | Correct? |
|---|---|---|---|---|---|
| 2026-05-27 | APP | hold | medium | -41.94% | ❌ |
| 2026-05-27 | APP | hold | medium | -41.94% | ❌ |
| 2026-05-27 | APP | hold | medium | -41.94% | ❌ |
| 2026-05-27 | IONQ | hold | low | -35.46% | ❌ |
| 2026-05-27 | IONQ | hold | low | -35.46% | ❌ |
| 2026-05-27 | IONQ | hold | low | -35.46% | ❌ |
| 2026-05-27 | RGTI | trim | medium | -34.69% | ✅ |
| 2026-05-27 | RGTI | trim | medium | -34.69% | ✅ |
| 2026-05-27 | RGTI | hold | low | -34.69% | ❌ |
| 2026-05-27 | QBTS | hold | low | -32.85% | ❌ |

## Interpretation hints

- Accuracy <50% means the signal is worse than a coin flip → distrust or invert
- Calibration ❌ means high-conviction calls did NOT outperform medium → adjust the model
- Top winners/losers help spot systematic biases (e.g. always wrong on a sector)
