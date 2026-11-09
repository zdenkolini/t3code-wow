# Install or update T3 Code for World of Warcraft on Windows.
#
#   irm https://raw.githubusercontent.com/ryanrhughes/t3code-wow/main/install.ps1 | iex
#
# Run the same command again to update. From a clone:
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
# Options: --wow-dir "D:\Games\World of Warcraft" --slots N --no-service --no-path
# To pass options to the one-liner:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/ryanrhughes/t3code-wow/main/install.ps1))) --wow-dir "D:\Games\World of Warcraft"
#
# Copies the bridge and addon to ~\.local\share\t3code-wow, then runs `t3code-wow install`,
# which puts a t3code-wow command on your PATH, installs the addon into the game, gives the
# bridge a T3 Code session, starts it at logon and walks you through the first launch.
# Works in Windows PowerShell 5.1 and PowerShell 7, with nothing else to install but Node.

# Its output isn't captured, so node keeps the terminal; it sets $script:InstallExit.
function Install-T3CodeWow([string[]]$Arguments, [string]$Checkout) {
	$script:InstallExit = 0
	# Cmdlets that must stop the install say -ErrorAction Stop themselves: a global 'Stop'
	# would make Windows PowerShell 5.1 abort on node's stderr whenever output is redirected.
	$ProgressPreference = 'SilentlyContinue'
	$repo = 'ryanrhughes/t3code-wow'
	$ref = if ($env:T3CODE_WOW_REF) { $env:T3CODE_WOW_REF } else { 'main' }
	$dataHome = if ($env:XDG_DATA_HOME) { $env:XDG_DATA_HOME } else { Join-Path $HOME '.local\share' }
	$dest = Join-Path $dataHome 't3code-wow'

	if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
		Write-Host 'T3 Code for World of Warcraft needs Node.js 22 or newer: winget install OpenJS.NodeJS.LTS (or with fnm: fnm install --lts), then open a new terminal and run this again.' -ForegroundColor Red
		$script:InstallExit = 1; return
	}
	$major = [int](& node -p "process.versions.node.split('.')[0]")
	if ($major -lt 22) {
		Write-Host "T3 Code for World of Warcraft needs Node.js 22 or newer; found $(& node --version)." -ForegroundColor Red
		$script:InstallExit = 1; return
	}

	# Install from this checkout, or download the latest version.
	$tmp = $null
	try {
		$src = $Checkout
		if (-not $src) {
			$tmp = Join-Path ([IO.Path]::GetTempPath()) ("t3code-wow-" + [Guid]::NewGuid().ToString('N'))
			New-Item -ItemType Directory -Path $tmp -ErrorAction Stop | Out-Null
			$url = if ($env:T3CODE_WOW_ZIP) { $env:T3CODE_WOW_ZIP } else { "https://codeload.github.com/$repo/zip/$ref" }
			Write-Host "Downloading T3 Code for World of Warcraft ($ref)..."
			# Windows PowerShell 5.1 may not offer TLS 1.2 unless asked, and GitHub requires it.
			[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
			$zip = Join-Path $tmp 'source.zip'
			try {
				Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -ErrorAction Stop
				Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $tmp 'x') -ErrorAction Stop
			} catch {
				Write-Host "Couldn't download $url ($($_.Exception.Message))." -ForegroundColor Red
				$script:InstallExit = 1; return
			}
			# The archive holds one folder, named after the repository and version.
			$src = (Get-ChildItem -LiteralPath (Join-Path $tmp 'x') -Directory | Select-Object -First 1).FullName
			if (-not $src -or -not (Test-Path -LiteralPath (Join-Path $src 'bridge'))) {
				Write-Host "The download from $url doesn't contain the bridge." -ForegroundColor Red
				$script:InstallExit = 1; return
			}
		}

		# Stop a running bridge before replacing its files; the install below starts it again.
		& node (Join-Path $src 'bridge\bin\t3code-wow.js') stop
		if ($LASTEXITCODE -ne 0) { Write-Host "Couldn't stop the running bridge (see above), so nothing was replaced." -ForegroundColor Red; $script:InstallExit = 1; return }

		# Copy the new files next to the old ones, then swap each folder by renaming, so a
		# file that can't be replaced leaves the old folder in place rather than half of one.
		$replaced = $false
		try {
			New-Item -ItemType Directory -Force -Path $dest -ErrorAction Stop | Out-Null
			foreach ($part in 'bridge', 'addon') {
				foreach ($side in "$part.new", "$part.old") {
					$p = Join-Path $dest $side
					if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction Stop }
				}
				Copy-Item -LiteralPath (Join-Path $src $part) -Destination (Join-Path $dest "$part.new") -Recurse -ErrorAction Stop
			}
			# Both folders change together: the bridge and the addon it syncs must match.
			$moved = @(); $placed = @()
			try {
				foreach ($part in 'bridge', 'addon') {
					$old = Join-Path $dest $part
					if (Test-Path -LiteralPath $old) { Rename-Item -LiteralPath $old -NewName "$part.old" -ErrorAction Stop; $moved += $part }
				}
				foreach ($part in 'bridge', 'addon') {
					Rename-Item -LiteralPath (Join-Path $dest "$part.new") -NewName $part -ErrorAction Stop; $placed += $part
				}
			} catch {
				foreach ($part in $placed) { Remove-Item -LiteralPath (Join-Path $dest $part) -Recurse -Force -ErrorAction SilentlyContinue }
				foreach ($part in $moved) { Rename-Item -LiteralPath (Join-Path $dest "$part.old") -NewName $part -ErrorAction SilentlyContinue }
				throw
			}
			foreach ($part in 'bridge', 'addon') { Remove-Item -LiteralPath (Join-Path $dest "$part.old") -Recurse -Force -ErrorAction SilentlyContinue }
			$replaced = $true
		} catch {
			foreach ($part in 'bridge', 'addon') { Remove-Item -LiteralPath (Join-Path $dest "$part.new") -Recurse -Force -ErrorAction SilentlyContinue }
			Write-Host "Couldn't replace the installed files in $dest ($($_.Exception.Message)). Close any program that has files open there, then run the install command again." -ForegroundColor Red
		}
	} finally {
		if ($tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
	}

	$cli = Join-Path $dest 'bridge\bin\t3code-wow.js'
	$code = 1
	$pass = @()
	if ($replaced) {
		# Windows PowerShell 5.1 passes "D:\Some Folder\" to programs so that the closing quote
		# reads as escaped; a trailing backslash means nothing in a folder name, so drop it.
		$pass = @(foreach ($a in @($Arguments)) { if ($null -eq $a) { continue }; if ($a -match '\s' -and $a -match '\\$') { $a.TrimEnd('\') } else { $a } })
		& node $cli install @pass
		$code = $LASTEXITCODE
	}

	# If the files couldn't be replaced, install stopped early, or it was told not to touch
	# the startup entry, start the bridge stopped above again. The entry's name and key are
	# the ones bridge/src/service-windows.js registers.
	$run = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 't3code-wow' -ErrorAction SilentlyContinue
	if ($run -and (Test-Path -LiteralPath $cli) -and ($code -ne 0 -or $pass -contains '--no-service')) {
		& node $cli restart
	}
	$script:InstallExit = $code
}

# Run as this file (`-File .\install.ps1`): install the clone it's in, or download if it
# isn't in one, and exit with install's status. Run as a script block (`irm ... | iex`):
# download, and don't exit, which would close the terminal or script that ran it. Inside
# `iex`, $MyInvocation describes the caller, so check that the file is this installer.
$self = $MyInvocation.MyCommand
if ($self.CommandType -eq 'ExternalScript' -and $self.ScriptContents -match 'function Install-T3CodeWow') {
	$here = Split-Path -Parent $self.Path
	$checkout = if ((Test-Path (Join-Path $here 'bridge')) -and (Test-Path (Join-Path $here 'addon'))) { $here } else { $null }
	Install-T3CodeWow $args $checkout
	exit $script:InstallExit
} else {
	Install-T3CodeWow $args $null
	$global:LASTEXITCODE = $script:InstallExit
}
