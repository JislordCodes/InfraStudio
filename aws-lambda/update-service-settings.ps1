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
    "ConnectionArn": "arn:aws:apprunner:us-east-1:906548968040:connection/infrastudio/c177164cdb91403d825785cbb6354af0"
  }
}
"@

$sourceConfig | Out-File -FilePath "$PSScriptRoot/source-config.json" -Encoding ascii

Write-Host "Updating App Runner service configuration to python serve_mcp.py..."
aws apprunner update-service `
  --service-arn $serviceArn `
  --source-configuration file://$PSScriptRoot/source-config.json `
  --region us-east-1

if (Test-Path "$PSScriptRoot/source-config.json") { Remove-Item "$PSScriptRoot/source-config.json" -Force }
