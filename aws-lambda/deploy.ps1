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
$roleArn = "arn:aws:iam::907161737469:role/InfraStudio-Agents-ExecutionRole"
$qwenApiKey = "sk-ws-H.IXPRPH.wpQo.MEYCIQDGaOFthnPMgvcqPxg5yin91LnkQFW9S2EdZDzlFjyiuwIhAO4M5pNSPn_H4ncna21SUgKCgO5vzUPKsUuuJNwaKvKv"

Write-Host "Checking if Lambda function exists..."
$exists = aws lambda get-function --function-name $functionName 2>&1

if ($exists -match "ResourceNotFoundException" -or $exists.GetType().Name -eq "ErrorRecord") {
    Write-Host "Creating new Lambda function $functionName..."
    aws lambda create-function `
        --function-name $functionName `
        --runtime nodejs20.x `
        --role $roleArn `
        --handler index.handler `
        --zip-file fileb://dist.zip `
        --environment "Variables={QWEN_API_KEY=$qwenApiKey}" `
        --timeout 600 `
        --memory-size 1024 `
        --region us-east-1
        
    Write-Host "Creating public Function URL..."
    aws lambda create-function-url-config `
        --function-name $functionName `
        --auth-type NONE `
        --region us-east-1
        
    Write-Host "Granting public access to Function URL..."
    aws lambda add-permission `
        --function-name $functionName `
        --statement-id FunctionURLAllowPublicAccess `
        --action lambda:InvokeFunctionUrl `
        --principal "*" `
        --function-url-auth-type NONE `
        --region us-east-1
} else {
    Write-Host "Lambda function exists. Updating code and configuration..."
    aws lambda update-function-code --function-name $functionName --zip-file fileb://dist.zip --region us-east-1
    Start-Sleep -Seconds 2 # Allow code update to propagate
    aws lambda update-function-configuration `
        --function-name $functionName `
        --environment "Variables={QWEN_API_KEY=$qwenApiKey}" `
        --timeout 600 `
        --memory-size 1024 `
        --region us-east-1
}

# Verify Function URL exists and output it
Write-Host "Retrieving Function URL..."
$urlConfig = aws lambda get-function-url-config --function-name $functionName --region us-east-1 2>&1
if ($urlConfig -match "ResourceNotFoundException" -or $urlConfig.GetType().Name -eq "ErrorRecord") {
    Write-Host "Function URL not found, creating it now..."
    aws lambda create-function-url-config `
        --function-name $functionName `
        --auth-type NONE `
        --region us-east-1
    aws lambda add-permission `
        --function-name $functionName `
        --statement-id FunctionURLAllowPublicAccess `
        --action lambda:InvokeFunctionUrl `
        --principal "*" `
        --function-url-auth-type NONE `
        --region us-east-1
    $urlConfig = aws lambda get-function-url-config --function-name $functionName --region us-east-1
}

$functionUrl = ($urlConfig | ConvertFrom-Json).FunctionUrl
Write-Host "SUCCESS: Lambda deployed. Function URL: $functionUrl"
