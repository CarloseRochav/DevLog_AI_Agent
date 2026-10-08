# Stream one DevLog chat turn with curl -N.
# Requires AGENT_API_KEY. Example:
#   ./scripts/chat.ps1 -Message "Where is sp_ProcessBatch called?"

param(
  [Parameter(Mandatory = $true)]
  [string] $Message,
  [string] $ConversationId = [guid]::NewGuid().ToString(),
  [string] $BaseUrl = "http://127.0.0.1:3000"
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($env:AGENT_API_KEY)) {
  throw "AGENT_API_KEY is required."
}

Write-Host "conversationId: $ConversationId"

$body = @{
  conversationId = $ConversationId
  message        = $Message
} | ConvertTo-Json -Compress

$base = $BaseUrl.TrimEnd("/")
$body | & curl.exe -N -sS -X POST "$base/chat" `
  -H "x-api-key: $env:AGENT_API_KEY" `
  -H "content-type: application/json" `
  -H "accept: text/event-stream" `
  --data-binary "@-"

exit $LASTEXITCODE
