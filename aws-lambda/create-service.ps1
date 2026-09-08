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
      "CodeConfiguration": {
        "ConfigurationSource": "REPOSITORY"
      }
    }
  },
  "InstanceConfiguration": {
    "Cpu": "2 vCPU",
    "Memory": "4 GB"
  }
}
"@

$serviceJson | Out-File -FilePath "$PSScriptRoot/service-config.json" -Encoding ascii
Write-Host "Creating App Runner service from GitHub repo..."
aws apprunner create-service --cli-input-json file://$PSScriptRoot/service-config.json --region us-east-1
if (Test-Path "$PSScriptRoot/service-config.json") { Remove-Item "$PSScriptRoot/service-config.json" -Force }
