#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-ca-esq-clio-mcp}"
BRANCH="${BRANCH:-esq/main}"
REPO_URL="${REPO_URL:-https://github.com/ESQ-LS/clio-mcp.git}"

command -v az >/dev/null || { echo "Azure CLI is required." >&2; exit 1; }
command -v git >/dev/null || { echo "git is required." >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required." >&2; exit 1; }

az account show --output none
az extension add --name containerapp --upgrade --yes >/dev/null

APP_JSON="$(az containerapp list --query "[?name=='${APP_NAME}'].{name:name,rg:resourceGroup}" -o json)"
COUNT="$(jq 'length' <<<"$APP_JSON")"
if [[ "$COUNT" != "1" ]]; then
  echo "Expected exactly one Container App named ${APP_NAME}; found ${COUNT}. No changes made." >&2
  exit 1
fi

RG="$(jq -r '.[0].rg' <<<"$APP_JSON")"
DETAILS="$(az containerapp show --name "$APP_NAME" --resource-group "$RG" -o json)"
CONTAINER_COUNT="$(jq '.properties.template.containers | length' <<<"$DETAILS")"
if [[ "$CONTAINER_COUNT" != "1" ]]; then
  echo "Expected exactly one application container; found ${CONTAINER_COUNT}. No changes made." >&2
  exit 1
fi

CURRENT_IMAGE="$(jq -r '.properties.template.containers[0].image' <<<"$DETAILS")"
MAX_REPLICAS="$(jq -r '.properties.template.scale.maxReplicas // 1' <<<"$DETAILS")"
REGISTRY_HOST="${CURRENT_IMAGE%%/*}"
if [[ "$REGISTRY_HOST" != *.azurecr.io ]]; then
  echo "Current image is not hosted in Azure Container Registry: ${CURRENT_IMAGE}. No changes made." >&2
  exit 1
fi

ACR_NAME="${REGISTRY_HOST%.azurecr.io}"
IMAGE_REPOSITORY="${CURRENT_IMAGE#*/}"
IMAGE_REPOSITORY="${IMAGE_REPOSITORY%@*}"
if [[ "$IMAGE_REPOSITORY" == *:* ]]; then
  IMAGE_REPOSITORY="${IMAGE_REPOSITORY%:*}"
fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$WORKDIR/clio-mcp"
cd "$WORKDIR/clio-mcp"
SOURCE_SHA="$(git rev-parse HEAD)"
TAG="esq-${SOURCE_SHA:0:12}"
NEW_IMAGE="${REGISTRY_HOST}/${IMAGE_REPOSITORY}:${TAG}"

echo "Subscription : $(az account show --query name -o tsv)"
echo "Container App: ${APP_NAME}"
echo "Resource group: ${RG}"
echo "Current image : ${CURRENT_IMAGE}"
echo "New image     : ${NEW_IMAGE}"
echo "Max replicas  : ${MAX_REPLICAS}"
if [[ "$MAX_REPLICAS" =~ ^[0-9]+$ ]] && (( MAX_REPLICAS > 1 )); then
  echo "WARNING: maxReplicas=${MAX_REPLICAS}. OAuth tokens are still stored on replica-local encrypted storage; this deployment does not change scaling settings." >&2
fi

az acr show --name "$ACR_NAME" --output none
az acr build \
  --registry "$ACR_NAME" \
  --image "${IMAGE_REPOSITORY}:${TAG}" \
  --file Dockerfile \
  .

# Image build must succeed before production is touched.
az containerapp update \
  --name "$APP_NAME" \
  --resource-group "$RG" \
  --image "$NEW_IMAGE" \
  --output none

DEPLOYED_IMAGE="$(az containerapp show --name "$APP_NAME" --resource-group "$RG" --query 'properties.template.containers[0].image' -o tsv)"
if [[ "$DEPLOYED_IMAGE" != "$NEW_IMAGE" ]]; then
  echo "Deployment verification failed: expected ${NEW_IMAGE}, got ${DEPLOYED_IMAGE}." >&2
  exit 1
fi

FQDN="$(az containerapp show --name "$APP_NAME" --resource-group "$RG" --query 'properties.configuration.ingress.fqdn' -o tsv)"
if [[ -z "$FQDN" ]]; then
  echo "Container App has no ingress FQDN; image deployed but health check cannot run." >&2
  exit 1
fi

curl --fail --silent --show-error --retry 10 --retry-delay 3 "https://${FQDN}/health"
echo
az containerapp show \
  --name "$APP_NAME" \
  --resource-group "$RG" \
  --query '{latestRevision:properties.latestRevisionName,image:properties.template.containers[0].image,fqdn:properties.configuration.ingress.fqdn,maxReplicas:properties.template.scale.maxReplicas}' \
  -o json
