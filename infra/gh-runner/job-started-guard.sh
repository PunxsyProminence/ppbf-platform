#!/usr/bin/env bash
# job-started-guard.sh -- the PPBF self-hosted runner refuses every job but its own.
#
# Runs as ACTIONS_RUNNER_HOOK_JOB_STARTED (the runner runs it as `bash -e`):
# after a job is assigned to this runner and before its steps.
#
# WHY (lane DBT; OD-2026-11-17-008; Jason's card answer (a) "Approve as
# designed", 2026-11-17). The repository is public and owned by a user account,
# so there are no runner groups and no "selected workflows" restriction. The
# runner is just-in-time (one job) and carries a per-launch label, but a job
# queued elsewhere that asks only for labels this runner also has (a job can
# wait in the queue for up to a day) would be handed it first. This guard is the
# last check: the job must be one of ours, from main, started by a dispatch or
# a schedule.
#
# A FAILING HOOK DOES NOT STOP THE JOB BY ITSELF. The runner queues the hook as
# an ordinary first step with condition always() (actions/runner
# JobExtension.cs), so a refused job's own `if: always()` / `if: failure()`
# steps, and actions' `pre:` scripts, would still run. So the guard SIGKILLs the
# runner's Worker (a graceful cancel would still run always() steps). It does so
# on EVERY exit except the explicit allow at the bottom, including an
# unexpected error: it fails closed. The job then ends failed, and the
# just-in-time runner, which only ever takes this one job, ends with it.
#
# Allowed only when ALL hold:
#   GITHUB_REPOSITORY  == PunxsyProminence/ppbf-platform
#   GITHUB_EVENT_NAME  in {workflow_dispatch, schedule}
#   GITHUB_REF         == refs/heads/main
#   GITHUB_WORKFLOW_REF == <repo>/.github/workflows/<file>@refs/heads/main
#   "<file>:<GITHUB_JOB>" is a line of allowed-jobs.txt
#
# The runner calls this script with NO arguments, and only then are the real
# allowlist, repository and Runner.Worker used. Arguments exist for the tests
# (allowlist path, expected repository, comma-separated process names to stop);
# with arguments, nothing is stopped unless a name is given, so no test can kill
# the machine's own runner. Nothing a workflow sets can reach them: the hook
# gets the Worker's own environment and GitHub's context, never workflow env.
set -u
# A run cancelled while this runs would send SIGINT to the hook; finish the decision first.
trap '' INT TERM

if [ "$#" -eq 0 ]; then
  ALLOWED_FILE=/opt/ppbf-runner/allowed-jobs.txt
  EXPECTED_REPO=PunxsyProminence/ppbf-platform
  STOP_PROCESSES=Runner.Worker
else
  ALLOWED_FILE="$1"
  EXPECTED_REPO="${2:-PunxsyProminence/ppbf-platform}"
  STOP_PROCESSES="${3:-}"
fi

# Values printed below come partly from whoever queued the job (a branch name,
# a workflow path). Keep only plain characters, so nothing printed can be read
# as a workflow command ("::...").
clean() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9._/@-' '?' | cut -c1-120
}

# SIGKILL every process whose name is in STOP_PROCESSES. Bash built-ins and
# /proc only: the base image may not have pkill. Every failure is tolerated, so
# one vanished process cannot end the scan under `bash -e`.
stop_runner() {
  [ -n "$STOP_PROCESSES" ] || return 0
  local name entry pid comm
  local IFS=','
  for name in $STOP_PROCESSES; do
    for entry in /proc/[0-9]*; do
      pid="${entry#/proc/}"
      [ "$pid" = "$$" ] && continue
      comm=""
      # Braces: the redirection's own error (a process gone mid-scan) is silenced too.
      { read -r comm < "$entry/comm"; } 2>/dev/null || continue
      if [ "$comm" = "$name" ]; then
        kill -KILL "$pid" 2>/dev/null || true
      fi
    done
  done
}

# Fail closed: from here on, any exit except the allow at the bottom stops the runner.
trap 'stop_runner' EXIT

refuse() {
  local message="ppbf-runner-guard: REFUSED ($1). This self-hosted runner runs only the PPBF database jobs listed in infra/gh-runner/allowed-jobs.txt, from main, on workflow_dispatch or schedule. Stopping the runner."
  echo "$message"
  echo "$message" >&2
  # The Worker dies before it can upload this step's log, so also write the
  # reason to the container's own console (PID 1 is run.sh, same user), where
  # the Container Apps execution log keeps it.
  { echo "$message" > /proc/1/fd/2; } 2>/dev/null || true
  exit 1
}

repo="${GITHUB_REPOSITORY:-}"
event="${GITHUB_EVENT_NAME:-}"
ref="${GITHUB_REF:-}"
workflow_ref="${GITHUB_WORKFLOW_REF:-}"
job="${GITHUB_JOB:-}"

[ -n "$repo" ] && [ -n "$event" ] && [ -n "$ref" ] && [ -n "$workflow_ref" ] && [ -n "$job" ] \
  || refuse "a required GITHUB_* variable is empty"

# No line breaks anywhere: grep matches line by line and would see two values.
case "$repo$event$ref$workflow_ref$job" in
  *$'\n'*|*$'\r'*) refuse "a GITHUB_* value contains a line break" ;;
esac

[ "$repo" = "$EXPECTED_REPO" ] || refuse "repository $(clean "$repo")"

case "$event" in
  workflow_dispatch|schedule) ;;
  *) refuse "event $(clean "$event")" ;;
esac

[ "$ref" = "refs/heads/main" ] || refuse "ref $(clean "$ref")"

prefix="$EXPECTED_REPO/.github/workflows/"
suffix="@refs/heads/main"
case "$workflow_ref" in
  "$prefix"*"$suffix") ;;
  *) refuse "workflow $(clean "$workflow_ref")" ;;
esac
file="${workflow_ref#"$prefix"}"
file="${file%"$suffix"}"

# A plain file name and a plain job id, checked as whole strings.
[[ "$file" =~ ^[A-Za-z0-9._-]+\.ya?ml$ ]] || refuse "workflow $(clean "$workflow_ref")"
[[ "$job" =~ ^[A-Za-z0-9_-]+$ ]] || refuse "job $(clean "$job")"

[ -r "$ALLOWED_FILE" ] || refuse "allowlist missing"
grep -Fxq -- "$file:$job" "$ALLOWED_FILE" || refuse "job $(clean "$file:$job") is not on the allowlist"

trap - EXIT
echo "ppbf-runner-guard: allowed $file:$job ($event on $ref)."
exit 0
