export { AirportSchema }                      from './airport'
export { PortSchema, PortTypeSchema }         from './port'
export { SubmarineCableSchema }               from './cable'
export { PowerPlantSchema, PlantTypeSchema }  from './powerplant'
export { CountryUtilitySchema, EnergyMixSchema } from './utility'
export { GdpCompositionSchema }               from './gdp'
export { FoodSecuritySchema }                 from './foodsecurity'
export { AiAdoptionSchema }                   from './aiadoption'
export { DatacenterSchema }                   from './datacenter'
export { RailHubSchema, RailHubTypeSchema }   from './railhub'
export { CompanyProfileSchema }               from './company'
export {
  CoordSchema, SourceRefSchema, ConfidenceSchema,
  AttributionSchema, ISO3Schema, PctSchema, YearSchema,
  StrategicImportanceSchema, RiskLevelSchema,
  assertSumsTo100,
} from './_shared'

export type { Airport }         from './airport'
export type { Port, PortType }  from './port'
export type { SubmarineCable }  from './cable'
export type { PowerPlant }      from './powerplant'
export type { CountryUtility }  from './utility'
export type { GdpComposition }  from './gdp'
export type { FoodSecurity }    from './foodsecurity'
export type { AiAdoption }      from './aiadoption'
export type { Datacenter }      from './datacenter'
export type { RailHub }         from './railhub'
export type { CompanyProfile }  from './company'
export type { Coord, SourceRef, Confidence, Attribution, StrategicImportance } from './_shared'

import { z } from 'zod'
import { AirportSchema }        from './airport'
import { PortSchema }           from './port'
import { SubmarineCableSchema } from './cable'
import { PowerPlantSchema }     from './powerplant'
import { CountryUtilitySchema } from './utility'
import { GdpCompositionSchema } from './gdp'
import { FoodSecuritySchema }   from './foodsecurity'
import { AiAdoptionSchema }     from './aiadoption'
import { DatacenterSchema }     from './datacenter'
import { RailHubSchema }        from './railhub'
import { CompanyProfileSchema } from './company'

export type EntityType =
  | 'airport' | 'port' | 'cable' | 'powerplant' | 'utility'
  | 'gdp' | 'foodsecurity' | 'aiadoption' | 'datacenter' | 'railhub'
  | 'company'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const SCHEMA_MAP: Record<EntityType, z.ZodType<any>> = {
  airport:     AirportSchema,
  port:        PortSchema,
  cable:       SubmarineCableSchema,
  powerplant:  PowerPlantSchema,
  utility:     CountryUtilitySchema,
  gdp:         GdpCompositionSchema,
  foodsecurity: FoodSecuritySchema,
  aiadoption:  AiAdoptionSchema,
  datacenter:  DatacenterSchema,
  railhub:     RailHubSchema,
  company:     CompanyProfileSchema,
}
