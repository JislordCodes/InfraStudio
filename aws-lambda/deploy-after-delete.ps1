$serviceName = "infrastudio-mcp"
$connectionArn = "arn:aws:apprunner:us-east-1:906548968040:connection/infrastudio/c177164cdb91403d825785cbb6354af0"

Write-Host "Waiting for old service slot to be deleted..."
while ($true) {
  $services = (aws apprunner list-services --region us-east-1 | ConvertFrom-Json).ServiceSummaryList
  $foundFailed = $services | Where-Object { $_.ServiceName -eq "infrastudio" }
  if (-not $foundFailed) {
    Write-Host "Old service deleted! Slot is now available."
    break
  }
  Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Waiting for deletion of $($foundFailed.ServiceName) (Status: $($foundFailed.Status))..."
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
      "ConfigurationSource": "API",
      "CodeConfigurationValues": {
        "Runtime": "PYTHON_311",
        "BuildCommand": "pip install --no-cache-dir uv && cd ifc-bonsai-mcp-main && uv pip install --system -e . && uv pip install --system sentence-transformers chromadb fastapi uvicorn sse-starlette starlette mcp",
        "StartCommand": "python serve_mcp.py",
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

$sourceConfig | Out-File -FilePath "$PSScriptRoot/create-config.json" -Encoding ascii

$instanceConfig = @"
{
  "Cpu": "2048",
  "Memory": "4096"
}
"@
$instanceConfig | Out-File -FilePath "$PSScriptRoot/instance-config.json" -Encoding ascii

Write-Host "Creating fresh, properly configured App Runner service: $serviceName..."
$result = aws apprunner create-service `
  --service-name $serviceName `
  --source-configuration file://$PSScriptRoot/create-config.json `
  --instance-configuration file://$PSScriptRoot/instance-config.json `
  --region us-east-1

$result | Out-Host

if (Test-Path "$PSScriptRoot/create-config.json") { Remove-Item "$PSScriptRoot/create-config.json" -Force }
if (Test-Path "$PSScriptRoot/instance-config.json") { Remove-Item "$PSScriptRoot/instance-config.json" -Force }
