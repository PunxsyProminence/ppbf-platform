#!/bin/bash -p
# entrypoint.sh -- start the runner for exactly one just-in-time job, then exit.
#
# The launch step (a later PR) asks GitHub for a JIT runner configuration and
# starts one Container Apps job execution with it in JIT_CONFIG. A JIT runner
# "perform[s] at most one job before being automatically removed" (GitHub), so
# the container ends with that job. No registration token, PAT or App key is
# ever given to this container; the JIT configuration is single-use.
#
# Nothing here can be redirected by an environment variable set on the job:
# - the guard and runner paths are fixed (the tests run a copy with them rewritten);
# - `bash -p` does not read BASH_ENV or ENV for this script, and both are
#   unset before the runner starts, so the hook's bash does not read them either;
# - exported bash functions are dropped before the runner starts (below);
# - the hook settings are forced, because the runner reads them from its
#   environment and an empty or different value would drop the guard.
set -euo pipefail

readonly GUARD=/opt/ppbf-runner/job-started-guard.sh
readonly RUNNER_HOME=/home/runner

unset BASH_ENV ENV
if [ ! -x "$GUARD" ]; then
  echo "ppbf-runner: the job-started guard is missing or not executable; refusing to start." >&2
  exit 65
fi
export ACTIONS_RUNNER_HOOK_JOB_STARTED="$GUARD"
unset ACTIONS_RUNNER_HOOK_JOB_COMPLETED ACTIONS_RUNNER_CONTAINER_HOOKS

if [ -z "${JIT_CONFIG:-}" ]; then
  echo "ppbf-runner: JIT_CONFIG is empty. This image only runs one just-in-time job; refusing to start." >&2
  exit 64
fi

config="$JIT_CONFIG"
unset JIT_CONFIG

# Exported bash functions (BASH_FUNC_name%%=...) are not imported by this
# `bash -p` but would be by every child bash, including run.sh and the hook,
# where a function named kill, trap or grep would switch the guard off. Drop
# them all before the runner starts.
drop=()
while IFS= read -r -d '' kv; do
  case "$kv" in
    BASH_FUNC_*) drop+=(-u "${kv%%=*}") ;;
  esac
done < <(env -0)

cd "$RUNNER_HOME"
exec env "${drop[@]}" ./run.sh --jitconfig "$config"
