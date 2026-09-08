$env:AWS_ACCESS_KEY_ID = "AKIA5GEUHPJUBQOJVFM7"
$env:AWS_SECRET_ACCESS_KEY = "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"
$env:AWS_DEFAULT_REGION = "us-east-1"

$AMI_ID = "ami-0332d564d76dbd8d6"  # Amazon Linux 2023 x86_64
$INSTANCE_TYPE = "t3.xlarge"       # 4 vCPU, 16GB RAM for fast build & blender
$SG_ID = "sg-0c45d0cc6b6245ddb"    # infrastudio-mcp-sg
$SUBNET_ID = "subnet-00669530edc3aa131" # us-east-1a public subnet

# Terminate old instance
Write-Host "Terminating old instance..."
$oldInstances = (aws ec2 describe-instances --filters "Name=tag:Name,Values=infrastudio-mcp-engine" "Name=instance-state-name,Values=running,pending" --region us-east-1 | ConvertFrom-Json).Reservations.Instances
foreach ($inst in $oldInstances) {
  Write-Host "Terminating $($inst.InstanceId)..."
  aws ec2 terminate-instances --instance-ids $inst.InstanceId --region us-east-1 | Out-Null
}

$userData = @"
#!/bin/bash
set -ex
exec > >(tee /var/log/user-data.log|logger -t user-data -s 2>/dev/console) 2>&1

echo "=== InfraStudio 3D Engine Setup Starting ==="

# 1. Update and install Docker and Git
dnf update -y
dnf install -y docker git

# 2. Start and enable Docker service
systemctl start docker
systemctl enable docker

# 3. Clone the repo
mkdir -p /opt/infrastudio
cd /opt/infrastudio
git clone https://github.com/JislordCodes/InfraStudio.git repo
cd repo

# 4. Build the complete production Docker container
echo "=== Building Docker image (Blender 4.4.0 + Bonsai + MCP) ==="
docker build -t ifc-bonsai-mcp:latest -f ifc-bonsai-mcp-main/Dockerfile ifc-bonsai-mcp-main/

# 5. Run the MCP server container on port 8000
echo "=== Starting MCP Server container on port 8000 ==="
docker run -d \
  --name infrastudio-mcp \
  --restart always \
  -p 8000:8000 \
  -e PORT=8000 \
  -e HOST=0.0.0.0 \
  ifc-bonsai-mcp:latest

echo "=== Container started successfully ==="
"@

$userDataBytes = [System.Text.Encoding]::UTF8.GetBytes($userData)
$userDataBase64 = [System.Convert]::ToBase64String($userDataBytes)

$blockDevice = @"
[
  {
    "DeviceName": "/dev/xvda",
    "Ebs": {
      "VolumeSize": 50,
      "VolumeType": "gp3",
      "DeleteOnTermination": true
    }
  }
]
"@
$blockDevice | Out-File -FilePath "$PSScriptRoot/block-device.json" -Encoding ascii

Write-Host "Launching fresh EC2 instance ($INSTANCE_TYPE)..."
$runResult = aws ec2 run-instances `
  --image-id $AMI_ID `
  --instance-type $INSTANCE_TYPE `
  --iam-instance-profile Name=EC2SSMProfile `
  --security-group-ids $SG_ID `
  --subnet-id $SUBNET_ID `
  --user-data $userDataBase64 `
  --block-device-mappings file://$PSScriptRoot/block-device.json `
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=infrastudio-mcp-engine}]" `
  --region us-east-1 | ConvertFrom-Json

$instanceId = $runResult.Instances[0].InstanceId
Write-Host "Launched instance ID: $instanceId"

if (Test-Path "$PSScriptRoot/block-device.json") { Remove-Item "$PSScriptRoot/block-device.json" -Force }

Write-Host "Waiting for public IP assignment..."
Start-Sleep -Seconds 10
$instanceInfo = (aws ec2 describe-instances --instance-ids $instanceId --region us-east-1 | ConvertFrom-Json).Reservations[0].Instances[0]
$publicIp = $instanceInfo.PublicIpAddress

Write-Host "`n======================================================="
Write-Host "Instance ID: $instanceId"
Write-Host "Public IP: $publicIp"
Write-Host "MCP Endpoint: http://$publicIp`:8000/mcp"
Write-Host "Health check: http://$publicIp`:8000/"
Write-Host "=======================================================`n"
