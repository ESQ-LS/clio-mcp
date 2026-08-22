[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$ClientId = '290e361b-ed51-435f-8ab9-a3fd3cab428b',
    [string]$Organization = 'ESQ-LS',
    [string]$Repository = 'clio-mcp',
    [string]$Branch = 'esq/main',
    [string]$CredentialName = 'github-esq-clio-mcp-esq-main',
    [switch]$Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    throw 'Azure CLI (az) is required.'
}

try {
    $account = az account show --only-show-errors --output json | ConvertFrom-Json
} catch {
    throw 'Run az login first with an account that can manage the target Entra app registration.'
}

$subject = "repo:${Organization}/${Repository}:ref:refs/heads/${Branch}"
$parameters = @{
    name = $CredentialName
    issuer = 'https://token.actions.githubusercontent.com'
    subject = $subject
    description = "GitHub Actions OIDC for ${Organization}/${Repository} branch ${Branch}"
    audiences = @('api://AzureADTokenExchange')
} | ConvertTo-Json -Depth 5 -Compress

Write-Host "Tenant: $($account.tenantId)"
Write-Host "Client ID: $ClientId"
Write-Host "Federated credential: $CredentialName"
Write-Host "Subject: $subject"
Write-Host ''

$existingJson = az ad app federated-credential list --id $ClientId --only-show-errors --output json
if ($LASTEXITCODE -ne 0) {
    throw 'Unable to read federated credentials for the Entra app. Confirm the ClientId and your directory permissions.'
}
$existing = @($existingJson | ConvertFrom-Json)
$match = @($existing | Where-Object { $_.name -eq $CredentialName -or $_.subject -eq $subject })

if ($match.Count -gt 0) {
    Write-Host 'Matching federated credential already exists. No change required.'
    $match | Select-Object name, issuer, subject, audiences | Format-List
    exit 0
}

if (-not $Apply) {
    Write-Host 'PREVIEW ONLY - no Entra changes were made.'
    Write-Host 'Re-run with -Apply to create the federated identity credential.'
    exit 0
}

if ($PSCmdlet.ShouldProcess("Entra app $ClientId", "Create federated credential $CredentialName")) {
    az ad app federated-credential create `
        --id $ClientId `
        --parameters $parameters `
        --only-show-errors `
        --output json | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to create the federated identity credential.'
    }
}

Write-Host 'Federated identity credential created successfully.'
Write-Host 'The GitHub Actions deploy workflow can now authenticate with Azure OIDC for esq/main.'
