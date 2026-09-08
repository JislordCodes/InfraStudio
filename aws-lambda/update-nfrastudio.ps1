$serviceArn = "arn:aws:apprunner:us-east-1:906548968040:service/nfrastudio/52bce92418bf4e029ca690af64a769fc"
$connectionArn = "arn:aws:apprunner:us-east-1:906548968040:connection/infrastudio/c177164cdb91403d825785cbb6354af0"

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

$sourceConfig | Out-File -FilePath "$PSScriptRoot/source-config-nfra.json" -Encoding ascii

Write-Host "Updating nfrastudio service with correct commands..."
$result = aws apprunner update-service `
  --service-arn $serviceArn `
  --source-configuration file://$PSScriptRoot/source-config-nfra.json `
  --region us-east-1

$result | Out-Host

if (Test-Path "$PSScriptRoot/source-config-nfra.json") { Remove-Item "$PSScriptRoot/source-config-nfra.json" -Force }
