# PPBF self-hosted GitHub Actions runner, for one Azure Container Apps job
# execution per database job (lane DBT; OD-2026-11-17-008; design
# DBT_DESIGN_A.md, approved by Jason's card answers of 2026-11-17).
#
# Built IN AZURE by .github/workflows/build-runner-image.yml (az acr build),
# which Overwatch dispatches. Never put a secret in this image: the only
# credential a container ever holds is its single-use JIT configuration.
#
# Container Apps cannot run Docker, so no job that builds images may use this
# runner (the official image's docker CLI is present but has no daemon).

# The official runner image, pinned by version AND digest. No default: a build
# that does not name its base fails here instead of taking whatever is newest.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ARG RUNNER_VERSION
ARG IMAGE_TAG
ARG RUNNER_REGION=eastus

USER root

# Fail a piped RUN step if any part of the pipe fails (curl | gpg below).
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Azure CLI (azure/login and every `az` step need it), from Microsoft's signed
# apt repository. zstd so actions/cache uses the same compression as GitHub's
# runners; xz-utils and gzip for tool archives. No compiler: the monorepo's
# install scripts use prebuilt binaries (function review, 2026-11-17). Node
# itself comes from actions/setup-node, as on GitHub's own runners.
RUN apt-get update -y \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg lsb-release xz-utils gzip zstd \
 && install -d -m 0755 /etc/apt/keyrings \
 && curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor -o /etc/apt/keyrings/microsoft.gpg \
 && chmod go+r /etc/apt/keyrings/microsoft.gpg \
 && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/azure-cli/ $(lsb_release -cs) main" \
      > /etc/apt/sources.list.d/azure-cli.list \
 && apt-get update -y \
 && apt-get install -y --no-install-recommends azure-cli \
 && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh job-started-guard.sh write-setup-info.sh allowed-jobs.txt /opt/ppbf-runner/
RUN chmod 0755 /opt/ppbf-runner/entrypoint.sh /opt/ppbf-runner/job-started-guard.sh /opt/ppbf-runner/write-setup-info.sh \
 && chmod 0644 /opt/ppbf-runner/allowed-jobs.txt \
 && /opt/ppbf-runner/write-setup-info.sh "$IMAGE_TAG" "$RUNNER_VERSION" "$RUNNER_REGION" > /home/runner/.setup_info \
 && chown runner /home/runner/.setup_info

# Runs before every job's first step and refuses anything but our own jobs
# (entrypoint.sh forces it again at start, in case the job's settings blank it).
ENV ACTIONS_RUNNER_HOOK_JOB_STARTED=/opt/ppbf-runner/job-started-guard.sh
# The base image prints the runner's own trace (including each job message,
# secrets masked) to stdout, which Container Apps keeps in Log Analytics. Off:
# the job log on GitHub is the record. Set it to 1 on an execution to debug.
ENV ACTIONS_RUNNER_PRINT_LOG_TO_STDOUT=0
ENV LANG=C.UTF-8

USER runner
WORKDIR /home/runner
ENTRYPOINT ["/opt/ppbf-runner/entrypoint.sh"]
