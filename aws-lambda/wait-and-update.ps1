$serviceArn = "arn:aws:apprunner:us-east-1:906548968040:service/nfrastudio/52bce92418bf4e029ca690af64a769fc"

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
    "ConnectionArn": "arn:aws:apprunner:us-east-1:906548968040:connection/infrastudio/c177164cdb91403d825785cbb6354af0"
  }
}
"@

$sourceConfig | Out-File -FilePath "$PSScriptRoot/source-config-repo.json" -Encoding ascii

Write-Host "Waiting for service to exit OPERATION_IN_PROGRESS..."
while ($true) {
  $desc = (aws apprunner describe-service --service-arn $serviceArn --region us-east-1 | ConvertFrom-Json)
  $status = $desc.Service.Status
  Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Status: $status"
  if ($status -ne "OPERATION_IN_PROGRESS") {
    break
  }
  Start-Sleep -Seconds 10
}

Write-Host "Updating service to use repository apprunner.yaml configuration..."
aws apprunner update-service `
  --service-arn $serviceArn `
  --source-configuration file://$PSScriptRoot/source-config-repo.json `
  --region us-east-1

if (Test-Path "$PSScriptRoot/source-config-repo.json") { Remove-Item "$PSScriptRoot/source-config-repo.json" -Force }
