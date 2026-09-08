$serviceArn = "arn:aws:apprunner:us-east-1:906548968040:service/infrastudio-mcp/a49b73211ee947a2a074bde7c41bf20b"
$connectionArn = "arn:aws:apprunner:us-east-1:906548968040:connection/infrastudio/c177164cdb91403d825785cbb6354af0"

Write-Host "Waiting for current operation to complete..."
while ($true) {
  $desc = (aws apprunner describe-service --service-arn $serviceArn --region us-east-1 | ConvertFrom-Json)
  $status = $desc.Service.Status
  Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Status: $status"
  if ($status -ne "OPERATION_IN_PROGRESS") {
    break
  }
  Start-Sleep -Seconds 10
}

$sourceConfig = @"
{
  "CodeRepository": {
    "RepositoryUrl": "https://github.com/JislordCodes/InfraStudio",
    "SourceCodeVersion": {
      "Type": "BRANCH",
      "Value": "main"
    },
    "CodeConfiguration": {
      "ConfigurationSource": "REPOSITORY"
    },
    "SourceDirectory": "/"
  },
  "AutoDeploymentsEnabled": true,
  "AuthenticationConfiguration": {
    "ConnectionArn": "$connectionArn"
  }
}
"@

$sourceConfig | Out-File -FilePath "$PSScriptRoot/source-config-repo.json" -Encoding ascii

Write-Host "Applying repository configuration..."
aws apprunner update-service `
  --service-arn $serviceArn `
  --source-configuration file://$PSScriptRoot/source-config-repo.json `
  --region us-east-1

if (Test-Path "$PSScriptRoot/source-config-repo.json") { Remove-Item "$PSScriptRoot/source-config-repo.json" -Force }
