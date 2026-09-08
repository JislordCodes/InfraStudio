$serviceJson = @"
{
  "ServiceName": "ifc-bonsai-mcp",
  "SourceConfiguration": {
    "AuthenticationConfiguration": {
      "ConnectionArn": "arn:aws:apprunner:us-east-1:906548968040:connection/github-infrastudio/d93fc561039848cea5a138db0eb7be5c"
    },
    "AutoDeploymentsEnabled": true,
    "CodeRepository": {
      "RepositoryUrl": "https://github.com/JislordCodes/InfraStudio",
      "SourceCodeVersion": {
        "Type": "BRANCH",
        "Value": "main"
      },
      "SourceDirectory": "ifc-bonsai-mcp-main",
      "CodeConfiguration": {
        "ConfigurationSource": "API",
        "CodeConfigurationValues": {
          "Runtime": "DOCKER",
          "Port": "8000"
        }
      }
    }
  },
  "InstanceConfiguration": {
    "Cpu": "2 vCPU",
    "Memory": "4 GB"
  }
}
"@

$serviceJson | Out-File -FilePath "$PSScriptRoot/apprunner-service.json" -Encoding ascii
Write-Host "Creating App Runner service in us-east-1..."
aws apprunner create-service --cli-input-json file://$PSScriptRoot/apprunner-service.json --region us-east-1
if (Test-Path "$PSScriptRoot/apprunner-service.json") { Remove-Item "$PSScriptRoot/apprunner-service.json" -Force }
