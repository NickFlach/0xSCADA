import { Command } from "commander";
import { getApiClient } from "../api.js";

// Configuration keys for completion
const CONFIG_KEYS = ["apiUrl", "timeout", "colorOutput", "jsonOutput"];

// Asset types for completion
const ASSET_TYPES = ["PLC", "HMI", "Sensor", "Controller", "Gateway", "RTU", "DCS", "SCADA"];

// Generate bash completion script
function generateBashCompletion(): string {
  return `# bash completion for 0xscada

_0xscada_completions() {
    local cur prev words cword
    _init_completion || return

    local commands="status sites assets events blockchain dev config watch shell completion"
    local sites_cmds="list get create"
    local assets_cmds="list get create"
    local events_cmds="list anchor stats create"
    local blockchain_cmds="info status"
    local dev_cmds="start seed check"
    local config_cmds="show set get keys paths"
    local watch_cmds="events assets tags"
    local completion_cmds="bash zsh fish powershell"
    local config_keys="${CONFIG_KEYS.join(" ")}"
    local asset_types="${ASSET_TYPES.join(" ")}"

    # Global options
    local global_opts="--json --no-color --version --help"

    case "\${words[1]}" in
        status)
            COMPREPLY=( $(compgen -W "--json --no-color --help" -- "$cur") )
            return
            ;;
        sites)
            case "\${words[2]}" in
                list)
                    COMPREPLY=( $(compgen -W "--json --no-color --help" -- "$cur") )
                    return
                    ;;
                get)
                    if [[ $cword -eq 3 ]]; then
                        local sites=$(_0xscada_get_site_ids 2>/dev/null)
                        COMPREPLY=( $(compgen -W "$sites --json --no-color --with-assets --help" -- "$cur") )
                    else
                        COMPREPLY=( $(compgen -W "--json --no-color --with-assets --help" -- "$cur") )
                    fi
                    return
                    ;;
                create)
                    case "$prev" in
                        --name|--location|--owner)
                            return
                            ;;
                    esac
                    COMPREPLY=( $(compgen -W "--name --location --owner --json --no-color --help" -- "$cur") )
                    return
                    ;;
                *)
                    COMPREPLY=( $(compgen -W "$sites_cmds" -- "$cur") )
                    return
                    ;;
            esac
            ;;
        assets)
            case "\${words[2]}" in
                list)
                    case "$prev" in
                        --site)
                            local sites=$(_0xscada_get_site_ids 2>/dev/null)
                            COMPREPLY=( $(compgen -W "$sites" -- "$cur") )
                            return
                            ;;
                        --type)
                            COMPREPLY=( $(compgen -W "$asset_types" -- "$cur") )
                            return
                            ;;
                    esac
                    COMPREPLY=( $(compgen -W "--site --type --critical --json --no-color --help" -- "$cur") )
                    return
                    ;;
                get)
                    if [[ $cword -eq 3 ]]; then
                        local assets=$(_0xscada_get_asset_ids 2>/dev/null)
                        COMPREPLY=( $(compgen -W "$assets --json --no-color --help" -- "$cur") )
                    else
                        COMPREPLY=( $(compgen -W "--json --no-color --help" -- "$cur") )
                    fi
                    return
                    ;;
                create)
                    case "$prev" in
                        --site)
                            local sites=$(_0xscada_get_site_ids 2>/dev/null)
                            COMPREPLY=( $(compgen -W "$sites" -- "$cur") )
                            return
                            ;;
                        --type)
                            COMPREPLY=( $(compgen -W "$asset_types" -- "$cur") )
                            return
                            ;;
                        --name)
                            return
                            ;;
                    esac
                    COMPREPLY=( $(compgen -W "--site --name --type --critical --json --no-color --help" -- "$cur") )
                    return
                    ;;
                *)
                    COMPREPLY=( $(compgen -W "$assets_cmds" -- "$cur") )
                    return
                    ;;
            esac
            ;;
        events)
            case "\${words[2]}" in
                list)
                    case "$prev" in
                        --page|--limit|--type)
                            return
                            ;;
                        --asset)
                            local assets=$(_0xscada_get_asset_ids 2>/dev/null)
                            COMPREPLY=( $(compgen -W "$assets" -- "$cur") )
                            return
                            ;;
                    esac
                    COMPREPLY=( $(compgen -W "--page --limit --type --asset --anchored --pending --json --no-color --help" -- "$cur") )
                    return
                    ;;
                anchor|stats)
                    COMPREPLY=( $(compgen -W "--json --no-color --help" -- "$cur") )
                    return
                    ;;
                create)
                    case "$prev" in
                        --asset)
                            local assets=$(_0xscada_get_asset_ids 2>/dev/null)
                            COMPREPLY=( $(compgen -W "$assets" -- "$cur") )
                            return
                            ;;
                        --type|--payload|--details|--recorded-by)
                            return
                            ;;
                    esac
                    COMPREPLY=( $(compgen -W "--asset --type --payload --details --recorded-by --json --no-color --help" -- "$cur") )
                    return
                    ;;
                *)
                    COMPREPLY=( $(compgen -W "$events_cmds" -- "$cur") )
                    return
                    ;;
            esac
            ;;
        blockchain)
            case "\${words[2]}" in
                info|status)
                    COMPREPLY=( $(compgen -W "--json --no-color --help" -- "$cur") )
                    return
                    ;;
                *)
                    COMPREPLY=( $(compgen -W "$blockchain_cmds" -- "$cur") )
                    return
                    ;;
            esac
            ;;
        dev)
            case "\${words[2]}" in
                start)
                    case "$prev" in
                        --port)
                            COMPREPLY=( $(compgen -W "3000 5000 8080" -- "$cur") )
                            return
                            ;;
                    esac
                    COMPREPLY=( $(compgen -W "--no-blockchain --port --json --no-color --help" -- "$cur") )
                    return
                    ;;
                seed)
                    COMPREPLY=( $(compgen -W "--force --json --no-color --help" -- "$cur") )
                    return
                    ;;
                check)
                    COMPREPLY=( $(compgen -W "--json --no-color --help" -- "$cur") )
                    return
                    ;;
                *)
                    COMPREPLY=( $(compgen -W "$dev_cmds" -- "$cur") )
                    return
                    ;;
            esac
            ;;
        config)
            case "\${words[2]}" in
                show|keys|paths)
                    COMPREPLY=( $(compgen -W "--json --no-color --help" -- "$cur") )
                    return
                    ;;
                set)
                    if [[ $cword -eq 3 ]]; then
                        COMPREPLY=( $(compgen -W "$config_keys" -- "$cur") )
                    else
                        COMPREPLY=( $(compgen -W "--json --no-color --help" -- "$cur") )
                    fi
                    return
                    ;;
                get)
                    if [[ $cword -eq 3 ]]; then
                        COMPREPLY=( $(compgen -W "$config_keys" -- "$cur") )
                    else
                        COMPREPLY=( $(compgen -W "--json --no-color --help" -- "$cur") )
                    fi
                    return
                    ;;
                *)
                    COMPREPLY=( $(compgen -W "$config_cmds" -- "$cur") )
                    return
                    ;;
            esac
            ;;
        watch)
            case "\${words[2]}" in
                events)
                    case "$prev" in
                        --site)
                            local sites=$(_0xscada_get_site_ids 2>/dev/null)
                            COMPREPLY=( $(compgen -W "$sites" -- "$cur") )
                            return
                            ;;
                        --type)
                            return
                            ;;
                    esac
                    COMPREPLY=( $(compgen -W "--site --type --json --no-color --help" -- "$cur") )
                    return
                    ;;
                assets)
                    case "$prev" in
                        --site)
                            local sites=$(_0xscada_get_site_ids 2>/dev/null)
                            COMPREPLY=( $(compgen -W "$sites" -- "$cur") )
                            return
                            ;;
                    esac
                    COMPREPLY=( $(compgen -W "--site --json --no-color --help" -- "$cur") )
                    return
                    ;;
                tags)
                    COMPREPLY=( $(compgen -W "--json --no-color --help" -- "$cur") )
                    return
                    ;;
                *)
                    COMPREPLY=( $(compgen -W "$watch_cmds" -- "$cur") )
                    return
                    ;;
            esac
            ;;
        shell)
            COMPREPLY=( $(compgen -W "--json --no-color --help" -- "$cur") )
            return
            ;;
        completion)
            COMPREPLY=( $(compgen -W "$completion_cmds" -- "$cur") )
            return
            ;;
    esac

    if [[ $cword -eq 1 ]]; then
        COMPREPLY=( $(compgen -W "$commands $global_opts" -- "$cur") )
    fi
}

# Dynamic completion helper: fetch site IDs from API
_0xscada_get_site_ids() {
    0xscada sites list --json 2>/dev/null | grep -o '"id":"[^"]*"' | cut -d'"' -f4 | head -20
}

# Dynamic completion helper: fetch asset IDs from API
_0xscada_get_asset_ids() {
    0xscada assets list --json 2>/dev/null | grep -o '"id":"[^"]*"' | cut -d'"' -f4 | head -20
}

complete -F _0xscada_completions 0xscada
`;
}

// Generate zsh completion script
function generateZshCompletion(): string {
  return `#compdef 0xscada

# zsh completion for 0xscada

_0xscada() {
    local -a commands
    local -a config_keys
    local -a asset_types

    commands=(
        'status:Show system health (database, blockchain, services)'
        'sites:Manage registered sites'
        'assets:Manage registered assets'
        'events:Manage and view event anchors'
        'blockchain:Blockchain status and information'
        'dev:Development environment commands'
        'config:Manage CLI configuration'
        'watch:Watch real-time updates'
        'shell:Start interactive shell mode'
        'completion:Generate shell completion scripts'
    )

    config_keys=(${CONFIG_KEYS.map(k => `'${k}'`).join(" ")})
    asset_types=(${ASSET_TYPES.map(t => `'${t}'`).join(" ")})

    _arguments -C \\
        '--json[Output as JSON]' \\
        '--no-color[Disable colorized output]' \\
        '-v[Output the version number]' \\
        '--version[Output the version number]' \\
        '-h[Display help]' \\
        '--help[Display help]' \\
        '1: :->command' \\
        '*:: :->args'

    case $state in
        command)
            _describe -t commands 'command' commands
            ;;
        args)
            case $words[1] in
                status)
                    _arguments \\
                        '--json[Output as JSON]' \\
                        '--no-color[Disable colorized output]' \\
                        '--help[Display help]'
                    ;;
                sites)
                    local -a sites_cmds
                    sites_cmds=(
                        'list:List all registered sites'
                        'get:Get details of a specific site'
                        'create:Create a new site'
                    )
                    case $words[2] in
                        list)
                            _arguments \\
                                '--json[Output as JSON]' \\
                                '--no-color[Disable colorized output]' \\
                                '--help[Display help]'
                            ;;
                        get)
                            _arguments \\
                                '1: :->site_id' \\
                                '--json[Output as JSON]' \\
                                '--no-color[Disable colorized output]' \\
                                '--with-assets[Include assets for this site]' \\
                                '--help[Display help]'
                            if [[ $state == site_id ]]; then
                                local sites
                                sites=(\${(f)"$(0xscada sites list --json 2>/dev/null | grep -o '"id":"[^"]*"' | cut -d'"' -f4)"})
                                _describe -t sites 'site' sites
                            fi
                            ;;
                        create)
                            _arguments \\
                                '--name[Site name]:name:' \\
                                '--location[Site location]:location:' \\
                                '--owner[Site owner address]:owner:' \\
                                '--json[Output as JSON]' \\
                                '--no-color[Disable colorized output]' \\
                                '--help[Display help]'
                            ;;
                        *)
                            _describe -t commands 'sites command' sites_cmds
                            ;;
                    esac
                    ;;
                completion)
                    local -a completion_cmds
                    completion_cmds=(
                        'bash:Generate bash completion script'
                        'zsh:Generate zsh completion script'
                        'fish:Generate fish completion script'
                        'powershell:Generate PowerShell completion script'
                    )
                    _describe -t commands 'completion shell' completion_cmds
                    ;;
            esac
            ;;
    esac
}

_0xscada "$@"
`;
}

// Generate fish completion script
function generateFishCompletion(): string {
  return `# fish completion for 0xscada

# Disable file completion by default
complete -c 0xscada -f

# Helper functions for dynamic completion
function __0xscada_get_site_ids
    0xscada sites list --json 2>/dev/null | string match -r '"id":"[^"]*"' | string replace -r '"id":"([^"]*)"' '$1'
end

function __0xscada_get_asset_ids
    0xscada assets list --json 2>/dev/null | string match -r '"id":"[^"]*"' | string replace -r '"id":"([^"]*)"' '$1'
end

# Main commands
complete -c 0xscada -n "__fish_use_subcommand" -a status -d "Show system health"
complete -c 0xscada -n "__fish_use_subcommand" -a sites -d "Manage registered sites"
complete -c 0xscada -n "__fish_use_subcommand" -a assets -d "Manage registered assets"
complete -c 0xscada -n "__fish_use_subcommand" -a events -d "Manage and view event anchors"
complete -c 0xscada -n "__fish_use_subcommand" -a blockchain -d "Blockchain status and information"
complete -c 0xscada -n "__fish_use_subcommand" -a dev -d "Development environment commands"
complete -c 0xscada -n "__fish_use_subcommand" -a config -d "Manage CLI configuration"
complete -c 0xscada -n "__fish_use_subcommand" -a watch -d "Watch real-time updates"
complete -c 0xscada -n "__fish_use_subcommand" -a shell -d "Start interactive shell mode"
complete -c 0xscada -n "__fish_use_subcommand" -a completion -d "Generate shell completion scripts"

# Global options
complete -c 0xscada -l json -d "Output as JSON"
complete -c 0xscada -l no-color -d "Disable colorized output"
complete -c 0xscada -s v -l version -d "Output the version number"
complete -c 0xscada -s h -l help -d "Display help"

# sites subcommands
complete -c 0xscada -n "__fish_seen_subcommand_from sites; and not __fish_seen_subcommand_from list get create" -a list -d "List all registered sites"
complete -c 0xscada -n "__fish_seen_subcommand_from sites; and not __fish_seen_subcommand_from list get create" -a get -d "Get details of a specific site"
complete -c 0xscada -n "__fish_seen_subcommand_from sites; and not __fish_seen_subcommand_from list get create" -a create -d "Create a new site"

# sites get options with dynamic site ID completion
complete -c 0xscada -n "__fish_seen_subcommand_from sites; and __fish_seen_subcommand_from get" -a "(__0xscada_get_site_ids)" -d "Site ID"

# completion subcommands
complete -c 0xscada -n "__fish_seen_subcommand_from completion" -a bash -d "Generate bash completion script"
complete -c 0xscada -n "__fish_seen_subcommand_from completion" -a zsh -d "Generate zsh completion script"
complete -c 0xscada -n "__fish_seen_subcommand_from completion" -a fish -d "Generate fish completion script"
complete -c 0xscada -n "__fish_seen_subcommand_from completion" -a powershell -d "Generate PowerShell completion script"
`;
}

// Generate PowerShell completion script
function generatePowerShellCompletion(): string {
  return `# PowerShell completion for 0xscada

$script:COMMANDS = @('status', 'sites', 'assets', 'events', 'blockchain', 'dev', 'config', 'watch', 'shell', 'completion')
$script:SITES_CMDS = @('list', 'get', 'create')
$script:COMPLETION_CMDS = @('bash', 'zsh', 'fish', 'powershell')
$script:CONFIG_KEYS = @(${CONFIG_KEYS.map(k => `'${k}'`).join(", ")})

function Get-0xSCADASiteIds {
    try {
        $output = 0xscada sites list --json 2>$null | ConvertFrom-Json
        return $output | ForEach-Object { $_.id }
    } catch {
        return @()
    }
}

Register-ArgumentCompleter -Native -CommandName 0xscada -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)

    $words = $commandAst.CommandElements | ForEach-Object { $_.Extent.Text }
    $wordCount = $words.Count

    function New-CompletionResult {
        param([string]$CompletionText, [string]$ToolTip)
        [System.Management.Automation.CompletionResult]::new(
            $CompletionText,
            $CompletionText,
            'ParameterValue',
            $ToolTip
        )
    }

    $globalOpts = @(
        @{Text='--json'; Tip='Output as JSON'},
        @{Text='--no-color'; Tip='Disable colorized output'},
        @{Text='--version'; Tip='Output the version number'},
        @{Text='--help'; Tip='Display help'}
    )

    if ($wordCount -eq 1 -or ($wordCount -eq 2 -and $wordToComplete -ne '')) {
        $script:COMMANDS | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
            New-CompletionResult $_ "0xscada command: $_"
        }
        $globalOpts | Where-Object { $_.Text -like "$wordToComplete*" } | ForEach-Object {
            New-CompletionResult $_.Text $_.Tip
        }
        return
    }

    $mainCmd = $words[1]

    switch ($mainCmd) {
        'completion' {
            $script:COMPLETION_CMDS | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
                New-CompletionResult $_ "Generate $_ completion script"
            }
        }
        'sites' {
            if ($wordCount -eq 2 -or ($wordCount -eq 3 -and $wordToComplete -ne '')) {
                $script:SITES_CMDS | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
                    New-CompletionResult $_ "sites subcommand: $_"
                }
            } else {
                $subCmd = $words[2]
                switch ($subCmd) {
                    'get' {
                        if ($wordCount -eq 3 -or ($wordCount -eq 4 -and $wordToComplete -ne '' -and $wordToComplete -notlike '--*')) {
                            Get-0xSCADASiteIds | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
                                New-CompletionResult $_ "Site ID: $_"
                            }
                        }
                        @('--json', '--no-color', '--with-assets', '--help') | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
                            New-CompletionResult $_ "get option"
                        }
                    }
                }
            }
        }
    }
}
`;
}

// Export for dynamic completion helpers
export async function getSiteIds(): Promise<string[]> {
  try {
    const api = getApiClient();
    const response = await api.getSites();
    if (response.success && response.data) {
      return response.data.map((site) => site.id);
    }
  } catch {
    // Silently fail for completion helpers
  }
  return [];
}

export async function getAssetIds(): Promise<string[]> {
  try {
    const api = getApiClient();
    const response = await api.getAssets();
    if (response.success && response.data) {
      return response.data.map((asset) => asset.id);
    }
  } catch {
    // Silently fail for completion helpers
  }
  return [];
}

export function registerCompletionCommand(program: Command): void {
  const completion = program
    .command("completion")
    .description("Generate shell completion scripts");

  // Bash completion
  completion
    .command("bash")
    .description("Generate bash completion script")
    .action(() => {
      console.log(generateBashCompletion());
    });

  // Zsh completion
  completion
    .command("zsh")
    .description("Generate zsh completion script")
    .action(() => {
      console.log(generateZshCompletion());
    });

  // Fish completion
  completion
    .command("fish")
    .description("Generate fish completion script")
    .action(() => {
      console.log(generateFishCompletion());
    });

  // PowerShell completion
  completion
    .command("powershell")
    .description("Generate PowerShell completion script")
    .action(() => {
      console.log(generatePowerShellCompletion());
    });

  // Default action when no shell specified
  completion.action(() => {
    console.log(`Usage: 0xscada completion <shell>

Generate shell completion scripts for 0xscada CLI.

Shells:
  bash        Generate bash completion script
  zsh         Generate zsh completion script
  fish        Generate fish completion script
  powershell  Generate PowerShell completion script

Installation:

  Bash:
    0xscada completion bash > /etc/bash_completion.d/0xscada
    # Or for user-level:
    0xscada completion bash >> ~/.bashrc

  Zsh:
    0xscada completion zsh > "\${fpath[1]}/_0xscada"
    # Or add to your .zshrc:
    0xscada completion zsh > ~/.zsh/completion/_0xscada

  Fish:
    0xscada completion fish > ~/.config/fish/completions/0xscada.fish

  PowerShell:
    0xscada completion powershell >> $PROFILE

After installation, restart your shell or source the completion file.
`);
  });
}
