$trustPolicy = @"
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "lambda.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
"@

$trustPolicy | Out-File -FilePath "$PSScriptRoot/trust-policy.json" -Encoding ascii
Write-Host "Creating IAM Role..."
aws iam create-role --role-name InfraStudio-Agents-ExecutionRole --assume-role-policy-document file://$PSScriptRoot/trust-policy.json
Write-Host "Attaching AWSLambdaBasicExecutionRole policy..."
aws iam attach-role-policy --role-name InfraStudio-Agents-ExecutionRole --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
if (Test-Path "$PSScriptRoot/trust-policy.json") { Remove-Item "$PSScriptRoot/trust-policy.json" -Force }
Write-Host "IAM Role created successfully."
