#!/usr/bin/env bash
# Creates the Azure side of the PPBF self-hosted runner (lane DBT, OD-2026-11-17-008).
#
# OVERWATCH RUNS THIS. Never a lane, never a workflow. By default it is a DRY RUN: it prints
# every command (and the job body) and calls nothing. Add --apply to run them.
#
#   resources.sh create --subscription <id> --secret-writer <UPN or object id> [--apply]
#       R2 identity id-ppbf-gh-runner: AcrPull on the registry and nothing else. On the job its
#          lifecycle is None, so only the image pull can use it, never a job step.
#       R3 vault kv-ppbf-gh-runner: RBAC, purge protection. Key Vault Secrets Officer on this vault
#          for --secret-writer only, so that person can paste the GitHub App key (an RBAC vault
#          lets nobody write a secret without a data-plane role, the subscription owner included).
#       R1 job caj-ppbf-gh-runner: Manual trigger, retry 0, parallelism 1, image by DIGEST,
#          no secrets, no volumes, no ingress.
#   THEN Jason creates the GitHub App (Administration: write, Metadata: read, no webhook), installs
#       it on ppbf-platform only, and pastes its private key into the vault as the secret named
#       KEY_VAULT_SECRET_NAME. Overwatch sets repository variables PPBF_RUNNER_APP_ID and
#       PPBF_RUNNER_INSTALLATION_ID.
#   resources.sh grant --subscription <id> --oidc-app-id <client id of the workflows' Azure login> [--apply]
#       R4: Key Vault Secrets User for that app on the ONE secret. Refuses until the secret exists.
#   resources.sh check [--oidc-app-id <id>]
#       Read-only: what exists, the job's image against azure-runner.conf, and who holds which role.
#
# --apply first checks that --subscription equals the signed-in `az account show` subscription and
# refuses otherwise, before any other az call. IDs and accounts are arguments, never committed.
# Writes need an MFA-backed az login (the tenant's policy "Multi Factor Authentication Enforcement -
# Write" refuses others with RequestDisallowedByAzure). After any failure, sign in again and re-run:
# every step is safe to repeat (PUTs, role assignments that already exist, a vault that exists).
# All names and the image digest come from azure-runner.conf, which the launch script reads too.
set -euo pipefail
export MSYS_NO_PATHCONV=1   # Git Bash on Windows would rewrite /subscriptions/... arguments.

usage() { sed -n '2,29p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

HERE="$(cd "$(dirname "$0")" && pwd)"
CONF="${PPBF_RUNNER_CONF:-$HERE/azure-runner.conf}"
declare -A C=()
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"
  case "$line" in '' | '#'*) continue ;; esac
  if [[ ! "$line" =~ ^([A-Z][A-Z0-9_]*)=([A-Za-z0-9._:/@-]+)$ ]]; then
    echo "resources.sh: azure-runner.conf has a line that is not KEY=value with a plain value." >&2
    exit 2
  fi
  [ -z "${C[${BASH_REMATCH[1]}]+set}" ] || { echo "resources.sh: azure-runner.conf sets ${BASH_REMATCH[1]} twice." >&2; exit 2; }
  C[${BASH_REMATCH[1]}]="${BASH_REMATCH[2]}"
done < "$CONF"
for k in RESOURCE_GROUP LOCATION ENVIRONMENT_NAME WORKLOAD_PROFILE JOB_NAME IDENTITY_NAME REGISTRY_NAME \
         REGISTRY_SERVER IMAGE CONTAINER_NAME CPU MEMORY REPLICA_TIMEOUT_SECONDS KEY_VAULT_NAME KEY_VAULT_SECRET_NAME; do
  [ -n "${C[$k]:-}" ] || { echo "resources.sh: azure-runner.conf is missing $k." >&2; exit 2; }
done
[[ "${C[IMAGE]}" =~ ^"${C[REGISTRY_SERVER]}"/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]] \
  || { echo "resources.sh: IMAGE must be in REGISTRY_SERVER and pinned by digest." >&2; exit 2; }
[[ "${C[CPU]}" =~ ^[0-9]+(\.[0-9]+)?$ && "${C[MEMORY]}" =~ ^[0-9]+(\.[0-9]+)?Gi$ && "${C[REPLICA_TIMEOUT_SECONDS]}" =~ ^[0-9]+$ ]] \
  || { echo "resources.sh: CPU, MEMORY or REPLICA_TIMEOUT_SECONDS is malformed." >&2; exit 2; }

PHASE="${1:-}"
[ $# -gt 0 ] && shift
APPLY=0
WRITER=''
OIDC_APP=''
SUBSCRIPTION=''
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --secret-writer) WRITER="${2:-}"; shift ;;
    --oidc-app-id) OIDC_APP="${2:-}"; shift ;;
    --subscription) SUBSCRIPTION="${2:-}"; shift ;;
    *) usage ;;
  esac
  shift
done
[ -z "$WRITER" ] || [[ "$WRITER" =~ ^[A-Za-z0-9._%+@][A-Za-z0-9._%+@-]{2,253}$ ]] || { echo "resources.sh: --secret-writer is malformed." >&2; exit 2; }
[ -z "$OIDC_APP" ] || [[ "$OIDC_APP" =~ ^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$ ]] || { echo "resources.sh: --oidc-app-id must be a GUID." >&2; exit 2; }
[ -z "$SUBSCRIPTION" ] || [[ "$SUBSCRIPTION" =~ ^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$ ]] || { echo "resources.sh: --subscription must be a GUID." >&2; exit 2; }

RG="${C[RESOURCE_GROUP]}"
KV="${C[KEY_VAULT_NAME]}"
SECRET="${C[KEY_VAULT_SECRET_NAME]}"
JOB="${C[JOB_NAME]}"

exec 3>&1
show() { { printf '+'; printf ' %q' "$@"; printf '\n'; } >&3; }
# run: a change. Printed always, executed only with --apply.
run() { show "$@"; if [ "$APPLY" = 1 ]; then "$@"; fi; }
# get: a read whose value the next commands use. In a dry run it returns the placeholder instead.
get() {
  local placeholder="$1"; shift
  show "$@"
  if [ "$APPLY" = 1 ]; then "$@" | tr -d '\r'; else printf '%s' "$placeholder"; fi
}
arm_id() { [[ "$1" =~ ^(/subscriptions/[A-Za-z0-9._()/-]+|[<][a-z-]+[>])$ ]] || { echo "resources.sh: unexpected $2 from az." >&2; exit 4; }; }
guid() { [[ "$1" =~ ^([0-9a-fA-F-]{36}|[<][a-z-]+[>])$ ]] || { echo "resources.sh: unexpected $2 from az." >&2; exit 4; }; }
# The first az call of any --apply: a stray or wrong login stops here, before any write.
confirm_subscription() {
  [ -n "$SUBSCRIPTION" ] || { echo "resources.sh $PHASE needs --subscription <id>." >&2; exit 2; }
  echo "Target subscription: $SUBSCRIPTION"
  [ "$APPLY" = 1 ] || return 0
  local current
  current="$(az account show --query id -o tsv 2>/dev/null | tr -d '\r')" || current=''
  if [ "$current" != "$SUBSCRIPTION" ]; then
    echo "resources.sh: REFUSED --apply: az is not signed in to subscription $SUBSCRIPTION. Nothing was changed." >&2
    exit 6
  fi
}

create() {
  [ -n "$WRITER" ] || { echo "resources.sh create needs --secret-writer <the account that will paste the key>." >&2; exit 2; }
  local sub="$SUBSCRIPTION" id_res id_principal acr_id kv_id writer_id env_id state i

  run az identity create --resource-group "$RG" --name "${C[IDENTITY_NAME]}" --location "${C[LOCATION]}" -o none
  id_res="$(get '<identity-id>' az identity show --resource-group "$RG" --name "${C[IDENTITY_NAME]}" --query id -o tsv)"; arm_id "$id_res" 'identity id'
  id_principal="$(get '<identity-principal-id>' az identity show --resource-group "$RG" --name "${C[IDENTITY_NAME]}" --query principalId -o tsv)"; guid "$id_principal" 'identity principal id'
  acr_id="$(get '<registry-id>' az acr show --name "${C[REGISTRY_NAME]}" --query id -o tsv)"; arm_id "$acr_id" 'registry id'
  run az role assignment create --assignee-object-id "$id_principal" --assignee-principal-type ServicePrincipal \
    --role AcrPull --scope "$acr_id" -o none

  if [ "$APPLY" = 1 ] && az keyvault show --name "$KV" -o none 2>/dev/null; then
    echo "Vault $KV exists; not re-created."
  else
    run az keyvault create --resource-group "$RG" --name "$KV" --location "${C[LOCATION]}" \
      --enable-rbac-authorization true --enable-purge-protection true --retention-days 90 -o none
  fi
  kv_id="$(get '<vault-id>' az keyvault show --name "$KV" --query id -o tsv)"; arm_id "$kv_id" 'vault id'
  writer_id="$(get '<secret-writer-object-id>' az ad user show --id "$WRITER" --query id -o tsv)"; guid "$writer_id" 'secret-writer object id'
  run az role assignment create --assignee-object-id "$writer_id" --assignee-principal-type User \
    --role "Key Vault Secrets Officer" --scope "$kv_id" -o none

  env_id="$(get '<environment-id>' az containerapp env show --resource-group "$RG" --name "${C[ENVIRONMENT_NAME]}" --query id -o tsv)"; arm_id "$env_id" 'environment id'
  BODY="$(mktemp)"
  trap 'rm -f "$BODY"' EXIT
  cat > "$BODY" <<JSON
{
  "location": "${C[LOCATION]}",
  "identity": { "type": "UserAssigned", "userAssignedIdentities": { "$id_res": {} } },
  "properties": {
    "environmentId": "$env_id",
    "workloadProfileName": "${C[WORKLOAD_PROFILE]}",
    "configuration": {
      "triggerType": "Manual",
      "replicaTimeout": ${C[REPLICA_TIMEOUT_SECONDS]},
      "replicaRetryLimit": 0,
      "manualTriggerConfig": { "parallelism": 1, "replicaCompletionCount": 1 },
      "registries": [ { "server": "${C[REGISTRY_SERVER]}", "identity": "$id_res" } ],
      "identitySettings": [ { "identity": "$id_res", "lifecycle": "None" } ]
    },
    "template": {
      "containers": [ {
        "name": "${C[CONTAINER_NAME]}",
        "image": "${C[IMAGE]}",
        "resources": { "cpu": ${C[CPU]}, "memory": "${C[MEMORY]}" }
      } ]
    }
  }
}
JSON
  echo "Job body:"
  cat "$BODY"
  # az on Windows is a Windows python.exe, which cannot open /tmp/...: hand it C:/... there.
  local body_arg="$BODY"
  if command -v cygpath >/dev/null 2>&1; then body_arg="$(cygpath -m "$BODY")"; fi
  run az rest --method put \
    --url "https://management.azure.com/subscriptions/$sub/resourceGroups/$RG/providers/Microsoft.App/jobs/$JOB?api-version=2025-07-01" \
    --body "@$body_arg" -o none
  if [ "$APPLY" = 1 ]; then
    for i in $(seq 1 30); do
      state="$(az containerapp job show --resource-group "$RG" --name "$JOB" --query properties.provisioningState -o tsv | tr -d '\r')"
      echo "Job $JOB: $state"
      case "$state" in Succeeded) break ;; Failed | Canceled) exit 5 ;; esac
      [ "$i" -lt 30 ] || { echo "resources.sh: job still not provisioned; check it with: resources.sh check" >&2; exit 5; }
      sleep 10
    done
  fi
  echo "Next: Jason creates the GitHub App and pastes its key into $KV as '$SECRET'; then: resources.sh grant --oidc-app-id <id>."
}

grant() {
  [ -n "$OIDC_APP" ] || { echo "resources.sh grant needs --oidc-app-id <client id of the workflows' Azure login>." >&2; exit 2; }
  local kv_id present sp_id
  kv_id="$(get '<vault-id>' az keyvault show --name "$KV" --query id -o tsv)"; arm_id "$kv_id" 'vault id'
  # Management plane: needs no Key Vault data role, and never returns the value.
  present="$(get "$SECRET" az rest --method get --url "https://management.azure.com$kv_id/secrets/$SECRET?api-version=2023-07-01" --query name -o tsv 2>/dev/null)" || present=''
  [ "$present" = "$SECRET" ] || { echo "resources.sh: secret '$SECRET' is not in $KV yet. Jason pastes the GitHub App key first." >&2; exit 3; }
  sp_id="$(get '<oidc-service-principal-id>' az ad sp show --id "$OIDC_APP" --query id -o tsv)"; guid "$sp_id" 'service principal id'
  run az role assignment create --assignee-object-id "$sp_id" --assignee-principal-type ServicePrincipal \
    --role "Key Vault Secrets User" --scope "$kv_id/secrets/$SECRET" -o none
}

check() {
  local image kv_id id_principal
  echo "== job $JOB"
  az containerapp job show --resource-group "$RG" --name "$JOB" --query "{state:properties.provisioningState,trigger:properties.configuration.triggerType,retries:properties.configuration.replicaRetryLimit,timeout:properties.configuration.replicaTimeout,parallelism:properties.configuration.manualTriggerConfig.parallelism,secrets:properties.configuration.secrets,identitySettings:properties.configuration.identitySettings,registries:properties.configuration.registries,resources:properties.template.containers[0].resources,volumes:properties.template.volumes}" -o json
  image="$(az containerapp job show --resource-group "$RG" --name "$JOB" --query 'properties.template.containers[0].image' -o tsv | tr -d '\r')"
  if [ "$image" = "${C[IMAGE]}" ]; then echo "image: matches azure-runner.conf"; else echo "image: DIFFERS from azure-runner.conf ($image)"; fi
  echo "== identity ${C[IDENTITY_NAME]} (expected: AcrPull on the registry, nothing else)"
  id_principal="$(az identity show --resource-group "$RG" --name "${C[IDENTITY_NAME]}" --query principalId -o tsv | tr -d '\r')"
  az role assignment list --assignee "$id_principal" --all --query "[].{role:roleDefinitionName,scope:scope}" -o table
  echo "== vault $KV"
  az keyvault show --name "$KV" --query "{rbac:properties.enableRbacAuthorization,purgeProtection:properties.enablePurgeProtection,publicNetwork:properties.publicNetworkAccess}" -o json
  kv_id="$(az keyvault show --name "$KV" --query id -o tsv | tr -d '\r')"
  az role assignment list --scope "$kv_id" --query "[].{who:principalName,type:principalType,role:roleDefinitionName,scope:scope}" -o table
  az role assignment list --scope "$kv_id/secrets/$SECRET" --query "[].{who:principalName,type:principalType,role:roleDefinitionName,scope:scope}" -o table 2>/dev/null \
    || echo "(secret '$SECRET' not created yet)"
  echo "== roles on resource group $RG and above (each can read an execution's JIT config before the runner uses it)"
  az role assignment list --resource-group "$RG" --include-inherited --query "[].{who:principalName,type:principalType,role:roleDefinitionName,scope:scope}" -o table
  if [ -n "$OIDC_APP" ]; then
    echo "== roles of $OIDC_APP (the launch starts, reads and stops job executions; Contributor on the group or above covers it)"
    az role assignment list --assignee "$OIDC_APP" --all --query "[].{role:roleDefinitionName,scope:scope}" -o table
    echo "== federated subjects of $OIDC_APP (each subject listed can read the App key once grant has run)"
    az ad app federated-credential list --id "$OIDC_APP" --query "[].subject" -o tsv
  fi
}

case "$PHASE" in
  create | grant)
    [ "$PHASE" = grant ] || [ -n "$WRITER" ] || { echo "resources.sh create needs --secret-writer <the account that will paste the key>." >&2; exit 2; }
    [ "$PHASE" = create ] || [ -n "$OIDC_APP" ] || { echo "resources.sh grant needs --oidc-app-id <client id of the workflows' Azure login>." >&2; exit 2; }
    [ "$APPLY" = 1 ] || echo "DRY RUN: nothing is called. Add --apply to run these."
    confirm_subscription
    "$PHASE" ;;
  check) check ;;
  *) usage ;;
esac
