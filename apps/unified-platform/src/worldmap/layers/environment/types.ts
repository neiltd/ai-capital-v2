export interface CountryEnvironmentProfile {
  countryId: string

  // Water
  waterStressScore?: number          // 0–5 (Aqueduct scale)
  freshwaterWithdrawalPct?: number   // % of available freshwater withdrawn annually
  accessToCleanWaterPct?: number     // % of population

  // Food security
  foodSecurityScore?: number         // 0–100 (Global Food Security Index)
  calorieAvailabilityPerCapita?: number

  // Climate vulnerability
  climateVulnerabilityScore?: number // 0–10 (ND-GAIN index derivative)
  naturalDisasterRiskScore?: number  // 0–10

  // Emissions
  co2PerCapitaTonnes?: number
  totalCo2Mt?: number

  lastUpdated?: string
}
