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

$sourceConfig | Out-File -FilePath "$PSScriptRoot/source-config-api.json" -Encoding ascii

Write-Host "Updating service to explicit API configuration..."
aws apprunner update-service `
  --service-arn $serviceArn `
  --source-configuration file://$PSScriptRoot/source-config-api.json `
  --region us-east-1

if (Test-Path "$PSScriptRoot/source-config-api.json") { Remove-Item "$PSScriptRoot/source-config-api.json" -Force }
