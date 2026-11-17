#!/usr/bin/env bash
# write-setup-info.sh <image> <runner-version> <region>  -- prints the runner's .setup_info.
#
# The runner prints this file under "Set up job" (actions/runner HostContext,
# WellKnownConfigFile.SetupInfo: <runner root>/.setup_info, a JSON array of
# {group, detail}). GitHub's own runners use the "Runner Image Provisioner"
# group to say "Cloud:" and "Region:"; the database preflight
# (scripts/db-reachability-probe.mjs) reads the same lines. So every job log,
# and the preflight's success line, says which runner a job ran on.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: write-setup-info.sh <image> <runner-version> <region>" >&2
  exit 2
fi
for value in "$@"; do
  # Plain characters only, so nothing needs escaping inside the JSON string.
  if ! printf '%s' "$value" | grep -Eq '^[A-Za-z0-9._:@+/-]+$'; then
    echo "write-setup-info.sh: refusing a value with characters outside [A-Za-z0-9._:@+/-]" >&2
    exit 2
  fi
done

printf '[{"group":"Runner Image Provisioner","detail":"PPBF self-hosted runner (Azure Container Apps job)\\nImage: %s\\nRunner: %s\\nRegion: %s\\nCloud: Azure"}]\n' "$1" "$2" "$3"
