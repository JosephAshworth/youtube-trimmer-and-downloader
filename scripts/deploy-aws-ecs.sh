#!/usr/bin/env bash
set -euo pipefail

required_cmds=(aws docker jq)
for cmd in "${required_cmds[@]}"; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
done

required_vars=(
  AWS_REGION
  AWS_ACCOUNT_ID
  ECR_REPOSITORY
  ECS_CLUSTER
  ECS_SERVICE
  ECS_TASK_FAMILY
)
for name in "${required_vars[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required env var: $name" >&2
    exit 1
  fi
done

CONTAINER_NAME="${CONTAINER_NAME:-youtube-trimmer}"
IMAGE_TAG="${IMAGE_TAG:-$(date +%Y%m%d-%H%M%S)}"
ECR_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPOSITORY}"
IMAGE_URI="${ECR_URI}:${IMAGE_TAG}"

echo "Checking ECR repository: ${ECR_REPOSITORY}"
if ! aws ecr describe-repositories \
  --region "${AWS_REGION}" \
  --repository-names "${ECR_REPOSITORY}" >/dev/null 2>&1; then
  echo "ECR repository does not exist, creating it..."
  aws ecr create-repository \
    --region "${AWS_REGION}" \
    --repository-name "${ECR_REPOSITORY}" >/dev/null
fi

echo "Logging in to ECR..."
aws ecr get-login-password --region "${AWS_REGION}" \
  | docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

echo "Building image: ${IMAGE_URI}"
docker build -t "${IMAGE_URI}" .

echo "Pushing image: ${IMAGE_URI}"
docker push "${IMAGE_URI}"

echo "Fetching current task definition: ${ECS_TASK_FAMILY}"
current_td_json="$(aws ecs describe-task-definition \
  --region "${AWS_REGION}" \
  --task-definition "${ECS_TASK_FAMILY}")"

echo "Preparing new task definition revision..."
new_td_payload="$(echo "${current_td_json}" | jq \
  --arg image "${IMAGE_URI}" \
  --arg cname "${CONTAINER_NAME}" \
  '
  .taskDefinition
  | {
      family,
      taskRoleArn,
      executionRoleArn,
      networkMode,
      volumes,
      placementConstraints,
      requiresCompatibilities,
      cpu,
      memory,
      runtimePlatform,
      ephemeralStorage,
      proxyConfiguration,
      inferenceAccelerators,
      pidMode,
      ipcMode,
      containerDefinitions
    }
  | with_entries(select(.value != null))
  | .containerDefinitions |= map(
      if .name == $cname
      then .image = $image
      else .
      end
    )
  ')"

new_td_arn="$(aws ecs register-task-definition \
  --region "${AWS_REGION}" \
  --cli-input-json "${new_td_payload}" \
  | jq -r '.taskDefinition.taskDefinitionArn')"

echo "Registered task definition: ${new_td_arn}"
echo "Updating ECS service: ${ECS_CLUSTER}/${ECS_SERVICE}"

aws ecs update-service \
  --region "${AWS_REGION}" \
  --cluster "${ECS_CLUSTER}" \
  --service "${ECS_SERVICE}" \
  --task-definition "${new_td_arn}" \
  --force-new-deployment >/dev/null

echo "Waiting for service to become stable..."
aws ecs wait services-stable \
  --region "${AWS_REGION}" \
  --cluster "${ECS_CLUSTER}" \
  --services "${ECS_SERVICE}"

echo "Deployment complete."
echo "Image: ${IMAGE_URI}"
echo "Task definition: ${new_td_arn}"
