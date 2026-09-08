$serviceArn = "arn:aws:apprunner:us-east-1:906548968040:service/infrastudio/4f6f023927b346779b61895b26599fef"

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
        "BuildCommand": "pip install uv && cd ifc-bonsai-mcp-main && uv pip install --system -e .",
        "StartCommand": "cd ifc-bonsai-mcp-main && python docker/serve_sse.py",
        "Port": "8000"
      }
    },
    "SourceDirectory": "/"
  },
  "AutoDeploymentsEnabled": true,
  "AuthenticationConfiguration": {
    "ConnectionArn": "arn:aws:apprunner:us-east-1:906548968040:connection/github-infrastudio/d93fc561039848cea5a138db0eb7be5c"
  }
}
"@

$sourceConfig | Out-File -FilePath "$PSScriptRoot/source-config.json" -Encoding ascii

Write-Host "Updating App Runner service source configuration..."
aws apprunner update-service `
  --service-arn $serviceArn `
  --source-configuration file://$PSScriptRoot/source-config.json `
  --region us-east-1

if (Test-Path "$PSScriptRoot/source-config.json") { Remove-Item "$PSScriptRoot/source-config.json" -Force }
