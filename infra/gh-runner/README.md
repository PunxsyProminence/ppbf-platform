# PPBF self-hosted runner image (Azure Container Apps jobs)

**Why it exists.** GitHub runs some jobs on AWS machines, and the production Postgres firewall admits only Azure addresses. On 2026-11-17 the lane DBT logs showed, since 2026-11-03:
- 10 of 10 database jobs on AWS runners timed out;
- no job on an Azure runner did.

Jason chose short-lived self-hosted runners inside Azure for the database jobs (OD-2026-11-17-008). He approved this design and its security model on 2026-11-17, and added staging dispatches of the shared workflows.

This folder is the runner image only. The pieces that use it come in a later PR: the launch action, the `resources.sh` that creates the Azure resources, and the workflow switch.

## What is in the image

| File | Role |
|---|---|
| `Dockerfile` | The official `ghcr.io/actions/actions-runner` image, pinned by version and digest, plus the Azure CLI and build tools. No secret, ever. |
| `entrypoint.sh` | Starts the runner once with the single-use just-in-time (JIT) configuration in `JIT_CONFIG`, then the container ends. |
| `job-started-guard.sh` | `ACTIONS_RUNNER_HOOK_JOB_STARTED`: before any step, refuses every job but those in `allowed-jobs.txt`, from `main`, started by `workflow_dispatch` or `schedule`, in this repository. |
| `allowed-jobs.txt` | The 19 jobs that reach Postgres and build no images. Baked in, so a workflow cannot widen it. |
| `write-setup-info.sh` | Writes the runner's `.setup_info`, so "Set up job" and the database preflight print `Cloud: Azure`, the region and the image tag. |

## Security model

Approved by Jason on 2026-11-17, card (a). The repository is public and owned by a user account, so there are no runner groups and no workflow restriction on runners. These layers stand in for them:

1. **Only trusted workflows launch a runner.** Launching needs the Azure OIDC login and a Key Vault read, which a fork never gets.
2. **No idle runner exists.** Each runner is JIT and does at most one job.
3. **Each launch gets an unguessable label.**
4. **The guard hook runs before any step.**
5. **Fork-PR approval is required for all outside contributors.** This was set by Overwatch on 2026-11-17.
6. **Nothing persists.** There are no volumes, the container is fresh for each job, and it holds no credential but its consumed JIT configuration.

The GitHub App key that creates JIT configurations has "Administration: write", which is repository-admin-equivalent. It lives only in the dedicated Key Vault, and only Jason enters or rotates it.

## Upkeep (Overwatch)

**Build:**
- Dispatch `build-runner-image` from `main`.
- The input is optional: an actions/runner version. Empty means the latest release.
- The summary prints the new tag, `ppbf-gh-runner:<version>-<commit>`, and both digests.
- There is no schedule, because every `az` write is Overwatch's to run.
- Rebuild when actions/runner releases, about monthly. Self-hosted runners must stay current, and a JIT runner cannot update itself mid-job.

**Roll:** point the Container Apps job at the new tag.

**Changing the allowlist:** a new database workflow needs a line in `allowed-jobs.txt` and a rebuild. `ghRunnerImage.test.ts` fails until the list and the workflows agree.

**Never add Docker-in-Docker, privileged mode, a volume or a secret to this image.**

**First real run (pilot), check the job's Container Apps console log:**
- the runner's own log lines carry no JIT configuration;
- the guard prints `ppbf-runner-guard: allowed …`.
