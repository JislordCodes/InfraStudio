$buildSpec = @"
version: 0.2

phases:
  pre_build:
    commands:
      - echo Logging in to Amazon ECR...
      - aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 906548968040.dkr.ecr.us-east-1.amazonaws.com
      - REPOSITORY_URI=906548968040.dkr.ecr.us-east-1.amazonaws.com/ifc-bonsai-mcp
      - IMAGE_TAG=latest
  build:
    commands:
      - echo Build started on `date`
      - echo Building the Docker image...
      - cd ifc-bonsai-mcp-main
      - docker build -t `$REPOSITORY_URI:`$IMAGE_TAG .
  post_build:
    commands:
      - echo Build completed on `date`
      - echo Pushing the Docker image to Amazon ECR...
      - docker push `$REPOSITORY_URI:`$IMAGE_TAG
      - echo Push complete!
"@

$projectConfig = @{
  name = "ifc-bonsai-mcp-builder"
  description = "Cloud builder for ifc-bonsai-mcp Docker container"
  source = @{
    type = "GITHUB"
    location = "https://github.com/JislordCodes/InfraStudio.git"
    gitCloneDepth = 1
    buildspec = $buildSpec
  }
  artifacts = @{
    type = "NO_ARTIFACTS"
  }
  environment = @{
    type = "LINUX_CONTAINER"
    image = "aws/codebuild/standard:7.0"
    computeType = "BUILD_GENERAL1_MEDIUM"
    privilegedMode = $true
  }
  serviceRole = "arn:aws:iam::906548968040:role/CodeBuild-ifc-bonsai-mcp-Role"
}

$projectJson = $projectConfig | ConvertTo-Json -Depth 10
$projectJson | Out-File -FilePath "$PSScriptRoot/codebuild-project.json" -Encoding ascii

Write-Host "Creating CodeBuild Project..."
aws codebuild create-project --cli-input-json file://$PSScriptRoot/codebuild-project.json --region us-east-1
if (Test-Path "$PSScriptRoot/codebuild-project.json") { Remove-Item "$PSScriptRoot/codebuild-project.json" -Force }

Write-Host "Triggering cloud build in AWS CodeBuild..."
aws codebuild start-build --project-name ifc-bonsai-mcp-builder --region us-east-1
