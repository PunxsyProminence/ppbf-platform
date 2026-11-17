#!/usr/bin/env bash
# job-started-guard.sh -- the PPBF self-hosted runner refuses every job but its own.
#
# Runs as ACTIONS_RUNNER_HOOK_JOB_STARTED: after a job is assigned to this
# runner and BEFORE any of its steps. GitHub's docs: with a non-zero exit "the
# job will not run and will be marked as failed".
#
# WHY (lane DBT; OD-2026-11-17-008; Jason's card answer (a) "Approve as
# designed", 2026-11-17). The repository is public and owned by a user account,
# so there are no runner groups and no "selected workflows" restriction. The
# runner is just-in-time (one job) and carries a per-launch label, but it also
# carries GitHub's default labels; a job queued elsewhere that asks only for
# `self-hosted` could be handed this runner in the seconds before ours. This
# guard is the last check: the job must be one of ours, from main, started by
# a dispatch or a schedule.
#
# Allowed only when ALL hold:
#   GITHUB_REPOSITORY  == PunxsyProminence/ppbf-platform
#   GITHUB_EVENT_NAME  in {workflow_dispatch, schedule}
#   GITHUB_REF         == refs/heads/main
#   GITHUB_WORKFLOW_REF == <repo>/.github/workflows/<file>@refs/heads/main
#   "<file>:<GITHUB_JOB>" is a line of allowed-jobs.txt
#
# The runner calls this script with no arguments. The two optional arguments
# exist for the tests only: an allowlist path and an expected repository.
# Nothing a workflow sets can reach them.
set -u

ALLOWED_FILE="${1:-/opt/ppbf-runner/allowed-jobs.txt}"
EXPECTED_REPO="${2:-PunxsyProminence/ppbf-platform}"

# Values printed below come partly from whoever queued the job (a branch name,
# a workflow path). Keep only plain characters, so nothing printed can be read
# as a workflow command ("::...").
clean() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9._/@-' '?' | cut -c1-120
}

refuse() {
  echo "ppbf-runner-guard: REFUSED ($1). This self-hosted runner runs only the PPBF database jobs listed in infra/gh-runner/allowed-jobs.txt, from main, on workflow_dispatch or schedule."
  exit 1
}

repo="${GITHUB_REPOSITORY:-}"
event="${GITHUB_EVENT_NAME:-}"
ref="${GITHUB_REF:-}"
workflow_ref="${GITHUB_WORKFLOW_REF:-}"
job="${GITHUB_JOB:-}"

[ -n "$repo" ] && [ -n "$event" ] && [ -n "$ref" ] && [ -n "$workflow_ref" ] && [ -n "$job" ] \
  || refuse "a required GITHUB_* variable is empty"

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

# A plain file name only: no directories, nothing odd.
case "$file" in
  */*|'') refuse "workflow $(clean "$workflow_ref")" ;;
esac
printf '%s' "$file" | grep -Eq '^[A-Za-z0-9._-]+\.ya?ml$' || refuse "workflow $(clean "$workflow_ref")"
printf '%s' "$job" | grep -Eq '^[A-Za-z0-9_-]+$' || refuse "job $(clean "$job")"

[ -r "$ALLOWED_FILE" ] || refuse "allowlist missing"
grep -Fxq -- "$file:$job" "$ALLOWED_FILE" || refuse "job $(clean "$file:$job") is not on the allowlist"

echo "ppbf-runner-guard: allowed $file:$job ($event on $ref)."
exit 0
