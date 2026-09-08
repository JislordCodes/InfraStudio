$serviceArn = "arn:aws:apprunner:us-east-1:906548968040:service/nfrastudio/52bce92418bf4e029ca690af64a769fc"
$serviceName = "nfrastudio"
$connectionArn = "arn:aws:apprunner:us-east-1:906548968040:connection/infrastudio/c177164cdb91403d825785cbb6354af0"

Write-Host "Deleting failed service: $serviceName..."
aws apprunner delete-service --service-arn $serviceArn --region us-east-1 | Out-Null

Write-Host "Waiting for service deletion..."
while ($true) {
  $services = (aws apprunner list-services --region us-east-1 | ConvertFrom-Json).ServiceSummaryList
  $found = $services | Where-Object { $_.ServiceName -eq $serviceName }
  if (-not $found) {
    Write-Host "Deleted successfully! Slot is open."
    break
  }
  Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Waiting for deletion..."
  Start-Sleep -Seconds 5
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
      "ConfigurationSource": "API",
      "CodeConfigurationValues": {
        "Runtime": "PYTHON_311",
        "BuildCommand": "python3 -m pip install --no-cache-dir -e ./ifc-bonsai-mcp-main sentence-transformers chromadb fastapi uvicorn sse-starlette starlette mcp",
        "StartCommand": "python3 serve_mcp.py",
        "Port": "8000"
      }
    },
    "SourceDirectory": "/"
  },
  "AutoDeploymentsEnabled": true,
  "AuthenticationConfiguration": {
    "ConnectionArn": "$connectionArn"
  }
}
"@

$sourceConfig | Out-File -FilePath "$PSScriptRoot/create-nfra.json" -Encoding ascii

$instanceConfig = @"
{
  "Cpu": "2048",
  "Memory": "4096"
}
"@
$instanceConfig | Out-File -FilePath "$PSScriptRoot/instance-nfra.json" -Encoding ascii

Write-Host "Creating fresh service: $serviceName..."
$result = aws apprunner create-service `
  --service-name $serviceName `
  --source-configuration file://$PSScriptRoot/create-nfra.json `
  --instance-configuration file://$PSScriptRoot/instance-nfra.json `
  --region us-east-1

$result | Out-Host

if (Test-Path "$PSScriptRoot/create-nfra.json") { Remove-Item "$PSScriptRoot/create-nfra.json" -Force }
if (Test-Path "$PSScriptRoot/instance-nfra.json") { Remove-Item "$PSScriptRoot/instance-nfra.json" -Force }
