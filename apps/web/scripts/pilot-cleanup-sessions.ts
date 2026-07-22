import { cleanupExpiredSessions } from '../src/server/pilot/auth'
import { parseRetentionDays } from '../src/server/pilot/sessionPolicy'

async function main() {
  const retentionDaysArg = process.argv[2]
  const retentionDays = retentionDaysArg === undefined ? undefined : parseRetentionDays(retentionDaysArg)

  const { deletedCount } = await cleanupExpiredSessions(retentionDays)
  console.log(`Deleted ${deletedCount} expired/revoked session row(s).`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
