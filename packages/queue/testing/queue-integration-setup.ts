import { beforeAll } from 'vitest'
import { requireIsolation } from '../src/isolation.js'

/**
 * Setup for QUEUE INTEGRATION tests.
 *
 * Any test that constructs a Queue, Worker, FlowProducer, scheduler, watchdog
 * or persistence client MUST load this file first. It proves — before any of
 * those exist — that the database, Redis, filesystem and notification
 * destinations are all isolated, and refuses the whole run otherwise.
 *
 * WHY A SETUP FILE AND NOT A CONVENTION. The previous guard was an exported
 * helper that exactly one file imported: its own test. Nothing else called it,
 * so a queue test written tomorrow doing `new Queue('daily-pipeline')` would
 * have connected straight to production and the 228 parked incident jobs. A
 * guarantee enforced by convention is not enforced.
 */
beforeAll(async () => {
  const d = await requireIsolation()
  if (!d.notificationsDisabled) {
    throw new Error('[queue-integration] notifications are not disabled — refusing to run')
  }
  // eslint-disable-next-line no-console
  console.log(`[queue-integration] isolated: redis=${d.redisAddresses.join(',')} db=${d.pipelineRunsDb} root=${d.root}`)
})
