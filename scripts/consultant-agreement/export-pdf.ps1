<#
  Exports the Consultant Agreement master to PDF twice through Microsoft Word: once as written,
  and once with every fill-in placeholder removed. The document is opened read-only and closed
  without saving. Run through `npm run agreement:build`, which passes absolute paths.
#>
param(
  [Parameter(Mandatory = $true)] [string]$Source,
  [Parameter(Mandatory = $true)] [string]$WithPlaceholders,
  [Parameter(Mandatory = $true)] [string]$Blank,
  # Placeholders separated by '|', e.g. '[FULL NAME]|[EMAIL ADDRESS]'
  [Parameter(Mandatory = $true)] [string]$Placeholders
)

$ErrorActionPreference = 'Stop'
$wdExportFormatPDF = 17
$wdFindStop = 0
$wdReplaceAll = 2
$wdDoNotSaveChanges = 0

$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
  $doc = $word.Documents.Open($Source, $false, $true)
  try {
    $doc.ExportAsFixedFormat($WithPlaceholders, $wdExportFormatPDF)
    foreach ($placeholder in $Placeholders.Split('|')) {
      $find = $doc.Content.Find
      $find.ClearFormatting()
      $find.Replacement.ClearFormatting()
      # FindText, MatchCase, MatchWholeWord, MatchWildcards, MatchSoundsLike, MatchAllWordForms,
      # Forward, Wrap, Format, ReplaceWith, Replace
      [void]$find.Execute($placeholder, $true, $false, $false, $false, $false, $true, $wdFindStop, $false, '', $wdReplaceAll)
    }
    $doc.ExportAsFixedFormat($Blank, $wdExportFormatPDF)
  }
  finally {
    $doc.Close($wdDoNotSaveChanges)
  }
}
finally {
  $word.Quit()
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word)
}
