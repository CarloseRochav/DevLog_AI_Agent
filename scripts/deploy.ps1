# Build the chat server image and deploy it to Azure Container Apps.
# Reads .env locally. Secrets are passed to Container Apps and are not printed.
# Usage: pwsh -File scripts/deploy.ps1
#        pwsh -File scripts/deploy.ps1 -ImageTag yyyyMMddHHmmss

param(
  [string] $ImageTag
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false
Set-StrictMode -Version Latest

# pnpm prints a checkmark. The Windows Azure CLI streamer uses cp1252
# unless Python is told to write UTF-8.
$env:PYTHONIOENCODING = "utf-8"
$env:PYTHONUTF8 = "1"

$ResourceGroup = "rg-ernes-102010-6283"
$Location = "eastus2"
$RegistryName = "crdevlogagent"
$WorkspaceName = "log-devlog-agent"
$EnvironmentName = "cae-devlog-agent"
$AppName = "ca-devlog-agent"
$Root = Split-Path $PSScriptRoot -Parent

# az.cmd forwards %* through cmd.exe, which splits on ';' and '&'.
# Storage connection strings contain ';', so secret calls go to python.exe.
$AzPython = "C:\Program Files\Microsoft SDKs\Azure\CLI2\python.exe"

# Simple function on purpose. An advanced function treats -o as -OutVariable.
function Invoke-Az {
  if (Test-Path -LiteralPath $AzPython) {
    & $AzPython -IBm azure.cli @args
  } else {
    & az @args
  }
  if ($LASTEXITCODE -ne 0) {
    throw "Azure CLI failed: $($args[0]) $($args[1])"
  }
}

function Read-DotEnv {
  param([string] $Path)
  if (-not (Test-Path $Path)) {
    throw ".env is missing. Copy .env.example and fill in the values."
  }
  $map = @{}
  foreach ($line in Get-Content -Path $Path) {
    if ($line -match '^\s*#' -or $line -match '^\s*$') {
      continue
    }
    $split = $line.IndexOf("=")
    if ($split -lt 1) {
      continue
    }
    $key = $line.Substring(0, $split).Trim()
    $value = $line.Substring($split + 1).Trim()
    if (
      $value.Length -ge 2 -and
      $value.StartsWith('"') -and
      $value.EndsWith('"')
    ) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $map[$key] = $value
  }
  return $map
}

function Require-Value {
  param($Map, [string] $Key, [int] $MinLength = 1)
  if (-not $Map.ContainsKey($Key) -or [string]::IsNullOrWhiteSpace($Map[$Key])) {
    throw "$Key is missing from .env."
  }
  $value = $Map[$Key]
  if ($value.StartsWith("<") -and $value.EndsWith(">")) {
    throw "$Key is still a placeholder in .env."
  }
  if ($value.Length -lt $MinLength) {
    throw "$Key is too short."
  }
  return $value
}

function Ensure-Provider {
  param([string] $Name)
  $state = az provider show --namespace $Name --query registrationState -o tsv
  if ($LASTEXITCODE -ne 0) {
    throw "Could not read provider $Name."
  }
  if ($state -eq "Registered") {
    return
  }
  Write-Host "Registering $Name"
  Invoke-Az provider register --namespace $Name --wait -o none
}

Set-Location $Root
$envFile = Join-Path $Root ".env"
$config = Read-DotEnv $envFile

$openAiKey = Require-Value $config "AZURE_OPENAI_API_KEY"
$searchKey = Require-Value $config "AZURE_SEARCH_API_KEY"
$storageConnection = Require-Value $config "AZURE_STORAGE_CONNECTION_STRING"
$agentKey = Require-Value $config "AGENT_API_KEY" 32
$openAiEndpoint = Require-Value $config "AZURE_OPENAI_ENDPOINT"
$openAiVersion = Require-Value $config "AZURE_OPENAI_API_VERSION"
$chatDeployment = Require-Value $config "AZURE_OPENAI_CHAT_DEPLOYMENT"
$embeddingDeployment = Require-Value $config "AZURE_OPENAI_EMBEDDING_DEPLOYMENT"
$embeddingDimensions = Require-Value $config "EMBEDDING_DIMENSIONS"
$searchEndpoint = Require-Value $config "AZURE_SEARCH_ENDPOINT"
$searchIndex = Require-Value $config "AZURE_SEARCH_INDEX"
$storageContainer = Require-Value $config "AZURE_STORAGE_CONTAINER"
$logLevel = if ($config.ContainsKey("LOG_LEVEL") -and $config["LOG_LEVEL"]) { $config["LOG_LEVEL"] } else { "info" }
$temperature = if ($config.ContainsKey("CHAT_TEMPERATURE") -and $config["CHAT_TEMPERATURE"]) { $config["CHAT_TEMPERATURE"] } else { "0.2" }
$corsOrigin = if ($config.ContainsKey("CORS_ORIGIN") -and $config["CORS_ORIGIN"]) { $config["CORS_ORIGIN"] } else { "<FRONTEND_ORIGIN_PLACEHOLDER>" }
$historyMax = if ($config.ContainsKey("HISTORY_MAX_MESSAGES") -and $config["HISTORY_MAX_MESSAGES"]) { $config["HISTORY_MAX_MESSAGES"] } else { "20" }

foreach ($provider in @(
    "Microsoft.ContainerRegistry",
    "Microsoft.OperationalInsights",
    "Microsoft.App"
  )) {
  Ensure-Provider $provider
}

Write-Host "Registry $RegistryName"
az acr show --name $RegistryName --resource-group $ResourceGroup -o none 2>$null
if ($LASTEXITCODE -ne 0) {
  Invoke-Az acr create `
    --name $RegistryName `
    --resource-group $ResourceGroup `
    --location $Location `
    --sku Basic `
    --admin-enabled true `
    -o none
}
Invoke-Az acr update --name $RegistryName --admin-enabled true -o none

if ([string]::IsNullOrWhiteSpace($ImageTag)) {
  $tag = (Get-Date).ToUniversalTime().ToString("yyyyMMddHHmmss")
  $image = "$RegistryName.azurecr.io/devlog-agent:$tag"
  Write-Host "Building $image"
  Invoke-Az acr build `
    --registry $RegistryName `
    --resource-group $ResourceGroup `
    --image "devlog-agent:$tag" `
    --timeout 1800 `
    --file Dockerfile `
    .
} else {
  if ($ImageTag -notmatch '^\d{14}$') {
    throw "ImageTag must be a 14-digit UTC timestamp."
  }
  $tag = $ImageTag
  $image = "$RegistryName.azurecr.io/devlog-agent:$tag"
  Write-Host "Using existing image $image"
}

$credentialJson = az acr credential show --name $RegistryName -o json
if ($LASTEXITCODE -ne 0) {
  throw "Could not read registry credentials."
}
$credential = $credentialJson | ConvertFrom-Json
$registryUsername = [string] $credential.username
$registryPassword = [string] $credential.passwords[0].value
$credentialJson = $null
$credential = $null

Write-Host "Log Analytics $WorkspaceName"
az monitor log-analytics workspace show `
  --resource-group $ResourceGroup `
  --workspace-name $WorkspaceName `
  -o none 2>$null
if ($LASTEXITCODE -ne 0) {
  Invoke-Az monitor log-analytics workspace create `
    --resource-group $ResourceGroup `
    --workspace-name $WorkspaceName `
    --location $Location `
    -o none
}
$workspaceId = az monitor log-analytics workspace show `
  --resource-group $ResourceGroup `
  --workspace-name $WorkspaceName `
  --query customerId `
  -o tsv
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($workspaceId)) {
  throw "Could not read the Log Analytics customer id."
}
$workspaceKey = az monitor log-analytics workspace get-shared-keys `
  --resource-group $ResourceGroup `
  --workspace-name $WorkspaceName `
  --query primarySharedKey `
  -o tsv
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($workspaceKey)) {
  throw "Could not read the Log Analytics workspace key."
}

Write-Host "Environment $EnvironmentName"
az containerapp env show `
  --name $EnvironmentName `
  --resource-group $ResourceGroup `
  -o none 2>$null
if ($LASTEXITCODE -ne 0) {
  Invoke-Az containerapp env create `
    --name $EnvironmentName `
    --resource-group $ResourceGroup `
    --location $Location `
    --logs-destination log-analytics `
    --logs-workspace-id $workspaceId `
    --logs-workspace-key $workspaceKey `
    -o none
}
$workspaceKey = $null

$secretArgs = @(
  "acr-password=$registryPassword",
  "azure-openai-api-key=$openAiKey",
  "azure-search-api-key=$searchKey",
  "azure-storage-connection-string=$storageConnection",
  "agent-api-key=$agentKey"
)
$envArgs = @(
  "NODE_ENV=production",
  "LOG_LEVEL=$logLevel",
  "PORT=3000",
  "AZURE_OPENAI_ENDPOINT=$openAiEndpoint",
  "AZURE_OPENAI_API_VERSION=$openAiVersion",
  "AZURE_OPENAI_CHAT_DEPLOYMENT=$chatDeployment",
  "AZURE_OPENAI_EMBEDDING_DEPLOYMENT=$embeddingDeployment",
  "EMBEDDING_DIMENSIONS=$embeddingDimensions",
  "CHAT_TEMPERATURE=$temperature",
  "AZURE_SEARCH_ENDPOINT=$searchEndpoint",
  "AZURE_SEARCH_INDEX=$searchIndex",
  "AZURE_STORAGE_CONTAINER=$storageContainer",
  "CORS_ORIGIN=$corsOrigin",
  "HISTORY_MAX_MESSAGES=$historyMax",
  "AZURE_OPENAI_API_KEY=secretref:azure-openai-api-key",
  "AZURE_SEARCH_API_KEY=secretref:azure-search-api-key",
  "AZURE_STORAGE_CONNECTION_STRING=secretref:azure-storage-connection-string",
  "AGENT_API_KEY=secretref:agent-api-key"
)

az containerapp show --name $AppName --resource-group $ResourceGroup -o none 2>$null
$appExists = $LASTEXITCODE -eq 0
if ($appExists) {
  Write-Host "Updating $AppName"
  Invoke-Az containerapp secret set `
    --name $AppName `
    --resource-group $ResourceGroup `
    --secrets @secretArgs `
    -o none
  Invoke-Az containerapp update `
    --name $AppName `
    --resource-group $ResourceGroup `
    --image $image `
    --cpu 0.5 `
    --memory 1.0Gi `
    --min-replicas 0 `
    --max-replicas 1 `
    --set-env-vars @envArgs `
    --query properties.configuration.ingress.fqdn `
    -o tsv
} else {
  Write-Host "Creating $AppName"
  Invoke-Az containerapp create `
    --name $AppName `
    --resource-group $ResourceGroup `
    --environment $EnvironmentName `
    --image $image `
    --registry-server "$RegistryName.azurecr.io" `
    --registry-username $registryUsername `
    --registry-password "secretref:acr-password" `
    --secrets @secretArgs `
    --env-vars @envArgs `
    --ingress external `
    --target-port 3000 `
    --transport http `
    --cpu 0.5 `
    --memory 1.0Gi `
    --min-replicas 0 `
    --max-replicas 1 `
    --query properties.configuration.ingress.fqdn `
    -o tsv
}
$registryPassword = $null

$fqdn = az containerapp show `
  --name $AppName `
  --resource-group $ResourceGroup `
  --query properties.configuration.ingress.fqdn `
  -o tsv
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($fqdn)) {
  throw "The container app has no public host name."
}

$healthUrl = "https://$fqdn/health"
Write-Host "Waiting for $healthUrl"
$healthy = $false
for ($attempt = 1; $attempt -le 36; $attempt++) {
  try {
    $response = Invoke-WebRequest -Uri $healthUrl -TimeoutSec 30
    Write-Host "health $($response.StatusCode) $($response.Content)"
    if ($response.StatusCode -eq 200) {
      $healthy = $true
      break
    }
  } catch {
    $status = $null
    if ($null -ne $_.Exception.Response) {
      $status = [int] $_.Exception.Response.StatusCode
    }
    Write-Host "health wait $attempt status=$status"
  }
  Start-Sleep -Seconds 10
}

if (-not $healthy) {
  Write-Host "Recent console logs:"
  az containerapp logs show `
    --name $AppName `
    --resource-group $ResourceGroup `
    --tail 80 `
    --type console
  throw "GET /health did not return 200."
}

Write-Host "image: $image"
Write-Host "url: https://$fqdn"
