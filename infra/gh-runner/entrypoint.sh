#!/usr/bin/env bash
# entrypoint.sh -- start the runner for exactly one just-in-time job, then exit.
#
# The launch step (a later PR) asks GitHub for a JIT runner configuration and
# starts one Container Apps job execution with it in JIT_CONFIG. A JIT runner
# "perform[s] at most one job before being automatically removed" (GitHub), so
# the container ends with that job. No registration token, PAT or App key is
# ever given to this container; the JIT configuration is single-use.
#
# PPBF_RUNNER_HOME exists for the tests only (default /home/runner, where the
# official actions-runner image installs the runner). It is read before any
# job exists, so no workflow can set it.
set -euo pipefail

if [ -z "${JIT_CONFIG:-}" ]; then
  echo "ppbf-runner: JIT_CONFIG is empty. This image only runs one just-in-time job; refusing to start." >&2
  exit 64
fi

config="$JIT_CONFIG"
unset JIT_CONFIG

cd "${PPBF_RUNNER_HOME:-/home/runner}"
exec ./run.sh --jitconfig "$config"
