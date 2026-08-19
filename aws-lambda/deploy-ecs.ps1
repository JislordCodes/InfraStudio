#!/usr/bin/env pwsh
# deploy-ecs.ps1 — Builds image via CodeBuild, deploys ECS Express Mode
# Credentials are read from environment: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY

$ACCOUNT = "906548968040"
$REGION  = "us-east-1"
$ECR_URI = "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/ifc-bonsai-mcp"
$IMAGE   = "$ECR_URI`:latest"
$CLUSTER = "infrastudio"
$SERVICE = "mcp-server"
$VPC     = "vpc-04c73d3d4c28cab8b"
$SUBNET1 = "subnet-00669530edc3aa131"  # us-east-1a
$SUBNET2 = "subnet-070c7d37fcb535c71"  # us-east-1b
$SG      = "sg-07b6d6161a02355f3"

# ── Step 1: Ensure ECR repo has a Dockerfile-based image via CodeBuild ─────────
Write-Host "`n=== STEP 1: Check if CodeBuild project exists ===" -ForegroundColor Cyan

$cbProject = aws codebuild batch-get-projects --names infrastudio-mcp-build 2>&1
if ($cbProject -match '"projects": \[\]') {
    Write-Host "Creating CodeBuild project..." -ForegroundColor Yellow

    # CodeBuild needs an IAM role — check/create it
    $roleArn = ""
    try {
        $roleArn = (aws iam get-role --role-name CodeBuildECRRole | ConvertFrom-Json).Role.Arn
        Write-Host "Reusing existing CodeBuildECRRole: $roleArn"
    } catch {
        Write-Host "Creating IAM role CodeBuildECRRole..."
        $trustPolicy = '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"codebuild.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
        $trustPolicy | Out-File -FilePath "$PSScriptRoot/trust.json" -Encoding ascii
        $roleArn = (aws iam create-role --role-name CodeBuildECRRole --assume-role-policy-document file://$PSScriptRoot/trust.json | ConvertFrom-Json).Role.Arn
        aws iam attach-role-policy --role-name CodeBuildECRRole --policy-arn arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryPowerUser | Out-Null
        aws iam attach-role-policy --role-name CodeBuildECRRole --policy-arn arn:aws:iam::aws:policy/CloudWatchLogsFullAccess | Out-Null
        Remove-Item "$PSScriptRoot/trust.json" -ErrorAction SilentlyContinue
        Write-Host "Waiting 10s for IAM role propagation..."
        Start-Sleep -Seconds 10
    }

    # buildspec inline — builds from ifc-bonsai-mcp-main/Dockerfile
    $buildspec = @"
{
    "name": "infrastudio-mcp-build",
    "source": {
        "type": "GITHUB",
        "location": "https://github.com/JislordCodes/InfraStudio.git",
        "buildspec": "buildspec.yml"
    },
    "artifacts": {"type": "NO_ARTIFACTS"},
    "environment": {
        "type": "LINUX_CONTAINER",
        "image": "aws/codebuild/standard:7.0",
        "computeType": "BUILD_GENERAL1_LARGE",
        "privilegedMode": true,
        "environmentVariables": [
            {"name": "AWS_DEFAULT_REGION", "value": "$REGION"},
            {"name": "ECR_URI", "value": "$ECR_URI"}
        ]
    },
    "serviceRole": "$roleArn"
}
"@
    $buildspec | Out-File -FilePath "$PSScriptRoot/cbproject.json" -Encoding ascii
    aws codebuild create-project --cli-input-json file://$PSScriptRoot/cbproject.json | Out-Null
    Remove-Item "$PSScriptRoot/cbproject.json" -ErrorAction SilentlyContinue
    Write-Host "CodeBuild project created." -ForegroundColor Green
} else {
    Write-Host "CodeBuild project already exists." -ForegroundColor Green
}

# ── Step 2: Create buildspec.yml in repo (if not present) ──────────────────────
Write-Host "`n=== STEP 2: Ensure buildspec.yml is in repo ===" -ForegroundColor Cyan
$buildspecPath = "$PSScriptRoot/../buildspec.yml"
if (-not (Test-Path $buildspecPath)) {
    Write-Host "Creating buildspec.yml..."
@"
version: 0.2
phases:
  pre_build:
    commands:
      - aws ecr get-login-password --region `$AWS_DEFAULT_REGION | docker login --username AWS --password-stdin `$ECR_URI
  build:
    commands:
      - docker build -t `$ECR_URI`:latest -f ifc-bonsai-mcp-main/Dockerfile .
  post_build:
    commands:
      - docker push `$ECR_URI`:latest
      - echo Build completed
"@ | Out-File -FilePath $buildspecPath -Encoding ascii
    Push-Location "$PSScriptRoot/.."
    git add buildspec.yml
    git commit -m "ci: add buildspec.yml for CodeBuild ECR image push"
    git push origin main
    Pop-Location
    Write-Host "buildspec.yml committed and pushed." -ForegroundColor Green
} else {
    Write-Host "buildspec.yml already exists." -ForegroundColor Green
}

# ── Step 3: Trigger CodeBuild ───────────────────────────────────────────────────
Write-Host "`n=== STEP 3: Triggering CodeBuild image build ===" -ForegroundColor Cyan
$buildId = (aws codebuild start-build --project-name infrastudio-mcp-build | ConvertFrom-Json).build.id
Write-Host "Build started: $buildId"
Write-Host "Waiting for build to complete (can take 5-15 min)..."

$buildStatus = "IN_PROGRESS"
$elapsed = 0
while ($buildStatus -eq "IN_PROGRESS") {
    Start-Sleep -Seconds 30
    $elapsed += 30
    $buildStatus = (aws codebuild batch-get-builds --ids $buildId | ConvertFrom-Json).builds[0].buildStatus
    Write-Host "[${elapsed}s] Build status: $buildStatus"
}

if ($buildStatus -ne "SUCCEEDED") {
    Write-Host "❌ Build FAILED with status: $buildStatus" -ForegroundColor Red
    Write-Host "Check CodeBuild logs in the AWS Console." -ForegroundColor Yellow
    exit 1
}
Write-Host "✅ Image built and pushed to ECR: $IMAGE" -ForegroundColor Green

# ── Step 4: Create ECS cluster ─────────────────────────────────────────────────
Write-Host "`n=== STEP 4: Creating ECS cluster ===" -ForegroundColor Cyan
$clusterArn = (aws ecs create-cluster --cluster-name $CLUSTER --capacity-providers FARGATE | ConvertFrom-Json).cluster.clusterArn
Write-Host "Cluster: $clusterArn" -ForegroundColor Green

# ── Step 5: Create IAM role for ECS task execution ─────────────────────────────
Write-Host "`n=== STEP 5: ECS Task Execution Role ===" -ForegroundColor Cyan
try {
    $execRoleArn = (aws iam get-role --role-name ecsTaskExecutionRole | ConvertFrom-Json).Role.Arn
    Write-Host "Reusing ecsTaskExecutionRole: $execRoleArn"
} catch {
    $trust = '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
    $trust | Out-File "$PSScriptRoot/ecs-trust.json" -Encoding ascii
    $execRoleArn = (aws iam create-role --role-name ecsTaskExecutionRole --assume-role-policy-document file://$PSScriptRoot/ecs-trust.json | ConvertFrom-Json).Role.Arn
    aws iam attach-role-policy --role-name ecsTaskExecutionRole --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy | Out-Null
    aws iam attach-role-policy --role-name ecsTaskExecutionRole --policy-arn arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly | Out-Null
    Remove-Item "$PSScriptRoot/ecs-trust.json" -ErrorAction SilentlyContinue
    Write-Host "Created ecsTaskExecutionRole: $execRoleArn"
    Start-Sleep -Seconds 10
}

# ── Step 6: Register task definition ───────────────────────────────────────────
Write-Host "`n=== STEP 6: Registering ECS task definition ===" -ForegroundColor Cyan

# Create CloudWatch log group first
aws logs create-log-group --log-group-name /ecs/infrastudio-mcp 2>&1 | Out-Null

$taskDef = @"
{
    "family": "infrastudio-mcp",
    "networkMode": "awsvpc",
    "requiresCompatibilities": ["FARGATE"],
    "cpu": "2048",
    "memory": "4096",
    "executionRoleArn": "$execRoleArn",
    "containerDefinitions": [
        {
            "name": "mcp",
            "image": "$IMAGE",
            "portMappings": [{"containerPort": 8000, "protocol": "tcp"}],
            "essential": true,
            "environment": [{"name": "PORT", "value": "8000"}],
            "logConfiguration": {
                "logDriver": "awslogs",
                "options": {
                    "awslogs-group": "/ecs/infrastudio-mcp",
                    "awslogs-region": "$REGION",
                    "awslogs-stream-prefix": "ecs"
                }
            }
        }
    ]
}
"@
$taskDef | Out-File "$PSScriptRoot/taskdef.json" -Encoding ascii
$taskDefArn = (aws ecs register-task-definition --cli-input-json file://$PSScriptRoot/taskdef.json | ConvertFrom-Json).taskDefinition.taskDefinitionArn
Remove-Item "$PSScriptRoot/taskdef.json" -ErrorAction SilentlyContinue
Write-Host "Task definition: $taskDefArn" -ForegroundColor Green

# ── Step 7: Create ECS Express Mode service ────────────────────────────────────
Write-Host "`n=== STEP 7: Creating ECS Express Mode service ===" -ForegroundColor Cyan

$networkConfig = @"
{
    "awsvpcConfiguration": {
        "subnets": ["$SUBNET1", "$SUBNET2"],
        "securityGroups": ["$SG"],
        "assignPublicIp": "ENABLED"
    }
}
"@
$networkConfig | Out-File "$PSScriptRoot/network.json" -Encoding ascii

$svcResult = aws ecs create-service `
    --cluster $CLUSTER `
    --service-name $SERVICE `
    --task-definition infrastudio-mcp `
    --desired-count 1 `
    --launch-type FARGATE `
    --network-configuration file://$PSScriptRoot/network.json `
    --region $REGION | ConvertFrom-Json

Remove-Item "$PSScriptRoot/network.json" -ErrorAction SilentlyContinue

Write-Host "Service created: $($svcResult.service.serviceArn)" -ForegroundColor Green

# ── Step 8: Wait for task to run and get public IP ─────────────────────────────
Write-Host "`n=== STEP 8: Waiting for task to start and get public IP ===" -ForegroundColor Cyan
Start-Sleep -Seconds 20

$elapsed = 0
while ($true) {
    $tasks = aws ecs list-tasks --cluster $CLUSTER --service-name $SERVICE | ConvertFrom-Json
    if ($tasks.taskArns.Count -gt 0) {
        $taskDetail = (aws ecs describe-tasks --cluster $CLUSTER --tasks $tasks.taskArns[0] | ConvertFrom-Json).tasks[0]
        $taskStatus = $taskDetail.lastStatus
        Write-Host "[${elapsed}s] Task status: $taskStatus"
        if ($taskStatus -eq "RUNNING") {
            $eniId = ($taskDetail.attachments[0].details | Where-Object { $_.name -eq "networkInterfaceId" }).value
            $publicIp = (aws ec2 describe-network-interfaces --network-interface-ids $eniId | ConvertFrom-Json).NetworkInterfaces[0].Association.PublicIp
            Write-Host "`n========================================" -ForegroundColor Green
            Write-Host "✅ MCP SERVER IS RUNNING!" -ForegroundColor Green
            Write-Host "Public IP: $publicIp" -ForegroundColor Green
            Write-Host "MCP URL: http://$publicIp`:8000/mcp" -ForegroundColor Green
            Write-Host "========================================`n" -ForegroundColor Green
            break
        }
    } else {
        Write-Host "[${elapsed}s] Waiting for task to start..."
    }
    if ($elapsed -ge 300) { Write-Host "Timed out waiting for task." -ForegroundColor Red; break }
    Start-Sleep -Seconds 15
    $elapsed += 15
}
