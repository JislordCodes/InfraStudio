$trustPolicy = @"
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "codebuild.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
"@

$trustPolicy | Out-File -FilePath "$PSScriptRoot/codebuild-trust.json" -Encoding ascii
Write-Host "Creating CodeBuild IAM Role..."
aws iam create-role --role-name CodeBuild-ifc-bonsai-mcp-Role --assume-role-policy-document file://$PSScriptRoot/codebuild-trust.json

$ecrPolicy = @"
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "ecr:PutImage",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "*"
    }
  ]
}
"@
$ecrPolicy | Out-File -FilePath "$PSScriptRoot/codebuild-policy.json" -Encoding ascii
Write-Host "Attaching inline policy to CodeBuild Role..."
aws iam put-role-policy --role-name CodeBuild-ifc-bonsai-mcp-Role --policy-name CodeBuildECRPolicy --policy-document file://$PSScriptRoot/codebuild-policy.json

if (Test-Path "$PSScriptRoot/codebuild-trust.json") { Remove-Item "$PSScriptRoot/codebuild-trust.json" -Force }
if (Test-Path "$PSScriptRoot/codebuild-policy.json") { Remove-Item "$PSScriptRoot/codebuild-policy.json" -Force }
Write-Host "CodeBuild IAM Role ready."
