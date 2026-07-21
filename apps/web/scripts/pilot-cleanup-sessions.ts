import { cleanupExpiredSessions } from '../src/server/pilot/auth'

async function main() {
  const retentionDaysArg = process.argv[2]
  const retentionDays = retentionDaysArg ? Number.parseInt(retentionDaysArg, 10) : undefined

  if (retentionDaysArg && (!Number.isFinite(retentionDays) || retentionDays! <= 0)) {
    throw new Error(`Invalid retention days argument: ${retentionDaysArg}`)
  }

  const { deletedCount } = await cleanupExpiredSessions(retentionDays)
  console.log(`Deleted ${deletedCount} expired/revoked session row(s).`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
