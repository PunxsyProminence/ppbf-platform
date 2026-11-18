# PPBF self-hosted runner image (Azure Container Apps jobs)

**Why it exists.** GitHub runs some jobs on AWS machines, and the production Postgres firewall admits only Azure addresses. On 2026-11-17, lane DBT's count since 2026-11-03 was:
- 10 of 10 database jobs on AWS runners timed out;
- no job on an Azure runner did.

Jason chose short-lived self-hosted runners inside Azure for the database jobs (OD-2026-11-17-008). He approved this design and its security model on 2026-11-17, and added staging dispatches of the shared workflows.

This folder holds the runner image, its Azure settings and the script that creates the Azure resources. The launch action and the workflow switch come in the next PR.

| File | Role |
|---|---|
| `azure-runner.conf` | The one place for the resource names, the image **digest**, cpu and memory. Read by `resources.sh` and by every launch; neither runs it as code. |
| `resources.sh` | Creates the identity, vault and Container Apps job (`create`), then the vault role for the workflows' Azure login (`grant`); `check` is read-only. **Overwatch runs it.** A dry run by default. |

## What is in the image

| File | Role |
|---|---|
| `Dockerfile` | The official `ghcr.io/actions/actions-runner` image, pinned by version and digest, plus the Azure CLI and build tools. No secret, ever. Runner trace to stdout is off. |
| `entrypoint.sh` | Forces the guard hook on (and other hooks off), then runs the runner once with the single-use just-in-time (JIT) configuration in `JIT_CONFIG`. The container then ends. |
| `job-started-guard.sh` | `ACTIONS_RUNNER_HOOK_JOB_STARTED`. Refuses every job except those in `allowed-jobs.txt`, from `main`, started by `workflow_dispatch` or `schedule`, in this repository. **On every exit except an allow (refusal or unexpected error), it SIGKILLs the runner's Worker.** A failing hook alone does not stop the job: the runner queues the hook as an `always()` step, so the job's own `if: always()` steps would still run. |
| `allowed-jobs.txt` | The 19 jobs that reach Postgres and build no images. Baked in, so a workflow cannot widen it. |
| `write-setup-info.sh` | Writes the runner's `.setup_info`, so "Set up job" and the database preflight print `Cloud: Azure`, the region and the image tag. |

## Security model

Approved by Jason on 2026-11-17, card (a). The repository is public and owned by a user account, so there are no runner groups and no way to restrict runners by workflow. These layers stand in for them:

1. **Only trusted workflows launch a runner.** Launching needs the Azure OIDC login and a Key Vault read, which a fork never gets.
2. **No idle runner exists.** Each runner is JIT and does at most one job.
3. **Each launch has an unguessable label.** PR-2 must register the runner with that label only and read the labels back.
4. **The guard hook stops the runner** before any of a foreign job's steps.
5. **Fork-PR approval is required for all outside contributors.** Overwatch set this on 2026-11-17.
6. **Nothing persists.** There are no volumes, the container is fresh for each job, and its only credential is its consumed JIT configuration.

The GitHub App key that creates JIT configurations has "Administration: write", so it is repository-admin-equivalent. It lives only in the dedicated Key Vault, and only Jason enters or rotates it.

## Upkeep (Overwatch)

**Build:**
- Dispatch `build-runner-image` from `main`. It takes an optional actions/runner version; empty means the latest release.
- The summary prints the tag `ppbf-gh-runner:<version>-<commit>`, the image digest and the base digest.
- There is no schedule, because every `az` write is Overwatch's to run.
- Rebuild when actions/runner releases, about monthly. Self-hosted runners must stay current, and a JIT runner cannot update itself mid-job.

**Roll:**
- Change `IMAGE` in `azure-runner.conf` to the new **image digest**, `ppbf-gh-runner@sha256:…`, never a tag (a PR). A tag can be overwritten by anything that can push to the registry.
- Then re-run `resources.sh create --apply`, which re-applies the job definition; `resources.sh check` reports DIFFERS until then.
- The job's own managed identity holds AcrPull only, and on the job its lifecycle is None: only the image pull can use it, never a job step.

## Azure resources (`resources.sh`, once)

1. **Overwatch:** `bash infra/gh-runner/resources.sh create --subscription <id> --secret-writer <account Jason names>`. Read the dry run, then add `--apply`.
   - It creates the identity (AcrPull on the registry only), the vault `kv-ppbf-gh-runner` (RBAC, purge protection) and the Manual job `caj-ppbf-gh-runner` (retry 0, image by digest, no secrets, volumes or ingress).
   - It gives the named account Key Vault Secrets Officer on that vault only, because an RBAC vault lets nobody write a secret without a data-plane role.
2. **Jason:** create the GitHub App under his account: repository permission Administration: write, Metadata: read, no webhook. Install it on `ppbf-platform` only. Generate a private key and paste it into vault `kv-ppbf-gh-runner` as secret `github-app-private-key`.
3. **Overwatch:** `resources.sh grant --subscription <id> --oidc-app-id <client id of the workflows' Azure login>`, dry run then `--apply`. It gives Key Vault Secrets User on that ONE secret, and refuses until the secret exists. Then set repository variables `PPBF_RUNNER_APP_ID` and `PPBF_RUNNER_INSTALLATION_ID`, and run `resources.sh check`.

**Safety:**
- `--apply` first checks that `--subscription` is the signed-in `az` subscription, and changes nothing otherwise.
- No ID or account is committed; each one is an argument.
- Writes need an MFA-backed `az` login. The tenant's policy "Multi Factor Authentication Enforcement - Write" refuses others with `RequestDisallowedByAzure`. After any failure, sign in again and re-run: every step is safe to repeat.

**Changing the allowlist:**
- A new database workflow needs a line in `allowed-jobs.txt` and a rebuild.
- `ghRunnerImage.test.ts` fails until the list and the workflows agree.
- Allowed jobs must not call reusable workflows: the guard sees the caller's file name.

**Never add Docker-in-Docker, privileged mode, a volume or a secret to this image.**

**First image build:** this is the first time `az acr build` (ACR Tasks) runs on this subscription in a while. Some subscription types refuse ACR Tasks, so whether it is allowed here is UNVERIFIED until this build runs.

**First real run (pilot):**
- Use more than 1 vCPU, for example 2 vCPU / 4 GiB. Container Apps gives 8 GiB of disk above 1 vCPU and 4 GiB at or below it, and `npm ci` needs about 1.2 GB plus caches.
- Check `sudo -n true` works in the container. backup.yml installs its PostgreSQL client with sudo, and whether Container Apps allows it is UNVERIFIED.
- In the GitHub job log, "Set up runner" shows `ppbf-runner-guard: allowed …`.
- "Set up job" shows the runner's provisioner info (`Cloud: Azure`).
- **Negative control:**
  - Dispatch an allowed workflow from a non-main branch, with an `if: always()` marker step. PR-2's pilot must route that one dispatch to the runner on purpose; normal routing keeps non-main runs on GitHub's runners.
  - The control passes only if all three hold, so a job that never reached the runner cannot pass it:
    - the jobs API shows that job's `runner_name` is the launched PPBF runner;
    - its conclusion is failure;
    - the marker never prints.
  - The REFUSED line is in the **Container Apps execution log**, not the GitHub job log: the Worker is killed before it uploads the step log. This assumes PID 1 is `run.sh`; confirm it at the pilot.
  - The execution itself may show "Succeeded": the listener reports the job failed, exits 0, and run.sh exits with it.

## Notes for PR-2 and PR-3

- **Labels:** register each JIT runner with its per-launch label only, then read the runner back and check its labels.
- **Execution settings:** `replicaRetryLimit` 0. More than 1 vCPU.
- **`JIT_CONFIG` exposure:** on the execution, `JIT_CONFIG` is readable by Azure readers until it is used. Whoever takes it can take that job. Start the execution only when the job is ready to be picked up.
- **Non-main dispatches stay on GitHub's runners.** Route to this runner only when `github.ref == 'refs/heads/main'`, because the guard refuses anything else. Today some dispatches run from other branches.
