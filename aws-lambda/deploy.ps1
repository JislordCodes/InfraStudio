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
$defaultSaJson = '{"type":"service_account","project_id":"gemini-app-sa-495716","private_key_id":"ace08f296bbbaccff93a81a904968667f7be9631","private_key":"-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDloN+aWsBY5yyM\nC91ttnFqwO+AidVSYL/uOoY6qJYUi//xssIEVqaRd5FEokN9jwii5g/J5J/KBf9R\ntswL2SZ7AAFH05FzzqkR+LSAAoAXHGpSO4yl5Rs5yTiEjUz8ULqg+c020bHCR9+3\nKohvLCwmyLOjLqG2eeXEuOJ56+IIKil4dBHj+7GrRVpw77YOuyXvliXr0+Phytkj\nDO7AoRLjOjDFea7rXY9qVgScwa2wUhR/rl7euurcMgKSCEXcPE9+dQ5VhzAW9CQg\nWVqCVLEH+Ab1mPTP7U9sYYFdxUNTWb41H4vu+Y1wHDz7g1l7vWqHnLEldl8lDOWg\n8qgud9EnAgMBAAECggEAYm8XWyYK7TFP5crSRU0fikkhgeLT+Kezrs4Uq0GIcE9h\nTH058T0p0xLDyX2bW8/8PkRLwVqJasMuYxtulaek+LYUVnNplxCgZi1MRtGLkhyi\nsRSI4rZ2+Mr6uMuPlFuQ3R+oKhcy0ZsY2f5YFPwFAy0m4E1FkiDn72/n2abVsnR8\nftXboBaAWTU0edGjs858TZ7ShLU1yPqRzoJpHwKkAhyUgqgY+hNElTuPxQbl111M\nE59NfPWOzLNx5yp2sg94glbGprNUDhfknTLRw0gIWACF4UTzo/8cYy4jv7BWk+r1\n+4X4YyJU+LW/L1Z5ze3l8BRfrj8X9r530i+w0NNR5QKBgQD3uvxy45lWZbtRfqX2\nh2k4dAY2S7APGfHT+z/vttzpjvq/sEOEhtFpZOkAitZ3C0qvevAGYQUare/DdlRm\ntk/u1Zj6l3uRXcd5cknnWOVYUDxnaiG0sbHpdOKqiLV/rV9XRCwYTCEslOPXuWGe\nOsztRMDVcGzRJVFeBkY6rlBxowKBgQDtSzG3KLbzzFDqpJEvUgK3hb+xaQDNla0Q\nUUYlEKX3nStSBDTxfRbsv+RjgO8Z4iiJe46Zn9J5V2mvJP50H1jjQrrDHaYLxuvJ\n9R6i1SWYDtEpWXCsD1E26qo4NGZJ9D+9TxeHU74oB+WDsEIwSj3JZCJzKMDokstI\n1PKJ6uVCrQKBgQCo1YYh4t3pVRIR24fOecELWX+2V2UZFayLtWuAuxbaErjwFXge\nhSeJdd2aogTCQy7WY6ncHxk0cqC6jRW+nrfhZS+Kcd0kWE6PhYW6pwo/YweXz2xD\nUuuW2TN12BAigQ0+U1beBFyDnsGdj1lpVle9ySLHFIUFETLgKtSIP67RkwKBgQDs\nauGCecclyafIz+NywQPB8zjUuig5q+l8e20mmpqwxF+X3GcfPqDrihgzZw9Ru3jl\n2TtvJcPeb0/1VydJbL3z1tUadtyrmSns0hIO68wD3qdXyiuu0af5zf1/9/z9q6Mh\nqr5nbvDjE1MBTEf1stIyZ1jHYZApZ6+vxbJL5MM8FQKBgF6Os32Comibng+KFJhs\nNZnBtgT544k9mR8azZrPYbcOyBx9WtBteJl/oAjBs8tZ2CTjSEdZoblMcV/DfLGO\nhnJkhGKgAS57GBQ3QS+7OIGASvcroNZALk3I6nEhErQS2vO1ECU1YhYOFebjXcO4\n3NFyL+H5+BO0VqtGfHFv8WNb\n-----END PRIVATE KEY-----\n","client_email":"gemini-app-sa@gemini-app-sa-495716.iam.gserviceaccount.com","client_id":"105281269608440211871","token_uri":"https://oauth2.googleapis.com/token"}'
$gcpSaJson = $env:GCP_SERVICE_ACCOUNT_JSON
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
