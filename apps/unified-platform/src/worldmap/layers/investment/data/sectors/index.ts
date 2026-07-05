export { semiconductorsSector }  from './semiconductors'
export { energySector }          from './energy'
export { shippingLogisticsSector } from './shipping'
export { aiInfrastructureSector } from './ai-infrastructure'
export { defenseSector }         from './defense'
export { oilBrentExposure, goldExposure } from './commodities'
export { banksSector }           from './banks'

import { semiconductorsSector }    from './semiconductors'
import { energySector }            from './energy'
import { shippingLogisticsSector } from './shipping'
import { aiInfrastructureSector }  from './ai-infrastructure'
import { defenseSector }           from './defense'
import { banksSector }             from './banks'

export const SECTOR_PROFILES = [
  semiconductorsSector,
  energySector,
  shippingLogisticsSector,
  aiInfrastructureSector,
  defenseSector,
  banksSector,
]

export function getSectorProfile(id: string) {
  return SECTOR_PROFILES.find(s => s.id === id)
}
