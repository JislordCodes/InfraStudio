# Set path to include AWS CLI
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

# Run build
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Error "Build failed"
    exit 1
}

# Zip the file. Compress-Archive puts index.js at the root of the zip.
if (Test-Path -Path dist.zip) {
    Remove-Item -Path dist.zip -Force
}
Compress-Archive -Path dist/index.js -DestinationPath dist.zip -Force

$functionName = "InfraStudio-Agents"
$accountId = (aws sts get-caller-identity | ConvertFrom-Json).Account
$roleArn = "arn:aws:iam::${accountId}:role/InfraStudio-Agents-ExecutionRole"
# Never fall back to credentials committed in source. Deployments must receive
# either an explicit local key or, preferably, a Secrets Manager secret id.
$qwenApiKey = $env:QWEN_API_KEY
$qwenSecretId = $env:QWEN_SECRET_ID
$gcpSaJson = if ($env:GCP_SERVICE_ACCOUNT_JSON) { 
    $env:GCP_SERVICE_ACCOUNT_JSON 
} elseif ($env:GOOGLE_APPLICATION_CREDENTIALS -and (Test-Path -Path $env:GOOGLE_APPLICATION_CREDENTIALS)) {
    Get-Content -Raw -Path $env:GOOGLE_APPLICATION_CREDENTIALS
} elseif ($env:GCP_SERVICE_ACCOUNT_FILE -and (Test-Path -Path $env:GCP_SERVICE_ACCOUNT_FILE)) {
    Get-Content -Raw -Path $env:GCP_SERVICE_ACCOUNT_FILE
} else {
    $null
}
$region = if ($env:AWS_REGION) { $env:AWS_REGION } else { "us-east-1" }

$envObj = @{
    Variables = @{}
}
if ($gcpSaJson) { $envObj.Variables["GCP_SERVICE_ACCOUNT_JSON"] = $gcpSaJson }
if ($qwenApiKey) { $envObj.Variables["QWEN_API_KEY"] = $qwenApiKey }
if ($qwenSecretId) { $envObj.Variables["QWEN_SECRET_ID"] = $qwenSecretId }
if ($env:QWEN_BASE_URL) { $envObj.Variables["QWEN_BASE_URL"] = $env:QWEN_BASE_URL }
if ($env:MCP_URL) { $envObj.Variables["MCP_URL"] = $env:MCP_URL }
if ($env:QWEN_BASE_URL) {
    $envObj.Variables["QWEN_BASE_URL"] = $env:QWEN_BASE_URL
}
if ($geminiApiKey) {
    $envObj.Variables["GEMINI_API_KEY"] = $geminiApiKey
}
$envJson = $envObj | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText("$PSScriptRoot/env.json", $envJson)

Write-Host "Checking if Lambda function exists in region $region..."
$exists = aws lambda get-function --function-name $functionName --region $region 2>&1

if ($exists -match "ResourceNotFoundException" -or $exists.GetType().Name -eq "ErrorRecord") {
    Write-Host "Creating new Lambda function $functionName..."
    aws lambda create-function `
        --function-name $functionName `
        --runtime nodejs20.x `
        --role $roleArn `
        --handler index.handler `
        --zip-file fileb://dist.zip `
        --environment file://env.json `
        --timeout 600 `
        --memory-size 1024 `
        --region $region
        
    Write-Host "Creating Function URL with CORS..."
    aws lambda create-function-url-config `
        --function-name $functionName `
        --auth-type NONE `
        --cors 'AllowOrigins="*",AllowMethods="*",AllowHeaders="*"' `
        --region $region
        
    Write-Host "Granting public access to Function URL..."
    aws lambda add-permission `
        --function-name $functionName `
        --statement-id FunctionURLAllowPublicAccess `
        --action lambda:InvokeFunctionUrl `
        --principal "*" `
        --function-url-auth-type NONE `
        --region $region

    aws lambda add-permission `
        --function-name $functionName `
        --statement-id FunctionURLAllowPublicInvokeFunction `
        --action lambda:InvokeFunction `
        --principal "*" `
        --invoked-via-function-url `
        --region $region
} else {
    Write-Host "Lambda function exists in region $region. Updating code and configuration..."
    aws lambda update-function-code `
        --function-name $functionName `
        --zip-file fileb://dist.zip `
        --region $region
        
    aws lambda update-function-configuration `
        --function-name $functionName `
        --environment file://env.json `
        --timeout 600 `
        --memory-size 1024 `
        --region $region
}
if (Test-Path env.json) { Remove-Item env.json -Force }

# Verify Function URL exists and output it
Write-Host "Retrieving Function URL..."
$urlConfig = aws lambda get-function-url-config --function-name $functionName --region $region 2>&1
if ($urlConfig -match "ResourceNotFoundException" -or $urlConfig.GetType().Name -eq "ErrorRecord") {
    Write-Host "Function URL not found, creating it now..."
    aws lambda create-function-url-config `
        --function-name $functionName `
        --auth-type NONE `
        --region $region
    
    aws lambda add-permission `
        --function-name $functionName `
        --statement-id FunctionURLAllowPublicAccess `
        --action lambda:InvokeFunctionUrl `
        --principal "*" `
        --function-url-auth-type NONE `
        --region $region
        
    aws lambda add-permission `
        --function-name $functionName `
        --statement-id FunctionURLAllowPublicInvokeFunction `
        --action lambda:InvokeFunction `
        --principal "*" `
        --region $region
        
    $urlConfig = aws lambda get-function-url-config --function-name $functionName --region $region
}

$functionUrl = ($urlConfig | ConvertFrom-Json).FunctionUrl
Write-Host "SUCCESS: Lambda deployed. Function URL: $functionUrl"
