$serviceArn = "arn:aws:apprunner:us-east-1:906548968040:service/nfrastudio/ffdb1df9fda34cb6a576b5334c1408d9"
$serviceName = "nfrastudio"
$connectionArn = "arn:aws:apprunner:us-east-1:906548968040:connection/infrastudio/c177164cdb91403d825785cbb6354af0"

# Wait until not in OPERATION_IN_PROGRESS
Write-Host "Waiting for current operation to settle..."
while ($true) {
  $status = ((aws apprunner describe-service --service-arn $serviceArn --region us-east-1 | ConvertFrom-Json).Service.Status)
  Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Status: $status"
  if ($status -ne "OPERATION_IN_PROGRESS") { break }
  Start-Sleep -Seconds 10
}

Write-Host "Deleting service: $serviceName..."
aws apprunner delete-service --service-arn $serviceArn --region us-east-1 | Out-Null

Write-Host "Waiting for deletion..."
while ($true) {
  $services = (aws apprunner list-services --region us-east-1 | ConvertFrom-Json).ServiceSummaryList
  $found = $services | Where-Object { $_.ServiceName -eq $serviceName }
  if (-not $found) { Write-Host "Deleted! Recreating..."; break }
  Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Waiting for deletion..."
  Start-Sleep -Seconds 5
}

$sourceConfig = @"
{
  "CodeRepository": {
    "RepositoryUrl": "https://github.com/JislordCodes/InfraStudio",
    "SourceCodeVersion": { "Type": "BRANCH", "Value": "main" },
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
  "AuthenticationConfiguration": { "ConnectionArn": "$connectionArn" }
}
"@

$sourceConfig | Out-File -FilePath "$PSScriptRoot/src-final.json" -Encoding ascii
@'
{"Cpu":"2048","Memory":"4096"}
'@ | Out-File -FilePath "$PSScriptRoot/inst-final.json" -Encoding ascii

Write-Host "Creating $serviceName with fixed serve_mcp.py..."
aws apprunner create-service --service-name $serviceName `
  --source-configuration file://$PSScriptRoot/src-final.json `
  --instance-configuration file://$PSScriptRoot/inst-final.json `
  --region us-east-1

Remove-Item "$PSScriptRoot/src-final.json","$PSScriptRoot/inst-final.json" -ErrorAction SilentlyContinue
