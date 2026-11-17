#!/usr/bin/env bash
# entrypoint.sh -- start the runner for exactly one just-in-time job, then exit.
#
# The launch step (a later PR) asks GitHub for a JIT runner configuration and
# starts one Container Apps job execution with it in JIT_CONFIG. A JIT runner
# "perform[s] at most one job before being automatically removed" (GitHub), so
# the container ends with that job. No registration token, PAT or App key is
# ever given to this container; the JIT configuration is single-use.
#
# The hook settings are forced HERE, not only in the image: the runner reads
# them from the process environment, and an empty or different value set on
# the Container Apps job (template or execution) would silently drop the guard.
#
# PPBF_RUNNER_HOME and PPBF_GUARD_PATH exist for the tests only (defaults: the
# official actions-runner image's /home/runner, and the guard installed by the
# Dockerfile). They are read before any job exists, so no workflow can set them.
set -euo pipefail

guard="${PPBF_GUARD_PATH:-/opt/ppbf-runner/job-started-guard.sh}"
if [ ! -x "$guard" ]; then
  echo "ppbf-runner: the job-started guard is missing or not executable; refusing to start." >&2
  exit 65
fi
export ACTIONS_RUNNER_HOOK_JOB_STARTED="$guard"
unset ACTIONS_RUNNER_HOOK_JOB_COMPLETED ACTIONS_RUNNER_CONTAINER_HOOKS

if [ -z "${JIT_CONFIG:-}" ]; then
  echo "ppbf-runner: JIT_CONFIG is empty. This image only runs one just-in-time job; refusing to start." >&2
  exit 64
fi

config="$JIT_CONFIG"
unset JIT_CONFIG

cd "${PPBF_RUNNER_HOME:-/home/runner}"
exec ./run.sh --jitconfig "$config"
