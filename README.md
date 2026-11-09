# T3 Code for World of Warcraft

Watch and run your [T3 Code](https://t3.codes) agent threads without leaving the game. It's a native addon for World of Warcraft: Forever, built from Blizzard's own UI templates so it looks and plays like the rest of the interface, plus a small bridge that connects it to T3 Code.

> [!WARNING]
> **Early release, still experimental.** It's built for and tested on one setup: **Omarchy 4.5.0**, **T3 Code Nightly** (0.1.7-nightly) and **World of Warcraft: Forever** (1.60.x) under Proton. **macOS** with the native client is new and less tested (see [macOS](#macos)), and so is **Windows 11** (see [Windows](#windows)). Other setups may work but aren't supported yet. T3 Code Nightly's API changes often, so a T3 update can break things until this catches up. Expect rough edges, and please [report them](https://github.com/ryanrhughes/t3code-wow/issues).

## What it does

- **T3 Code window** (`/t3`): your threads grouped into Working, Open and Settled, filtered by project or machine. Read a thread, reply, queue follow-ups, stop a run, settle or reopen it, start new threads, answer the agent's questions and approve its requests.
- **Quest tracker**: what's running, what needs you and what just finished, right under your quests, with live timers.
- **Notices**: a toast, a sound and a chat line when a thread finishes or needs you. They wait until combat ends, and stay quiet in dungeons and raids if you like.
- **Full controller support**: the D-pad moves between controls, A selects, B goes back, LB/RB switch tabs, X reads aloud and holding Y dictates. Hold both triggers and press Back to open it from anywhere.
- **Voice**: dictate replies with Omarchy's dictation, and have replies read aloud by your desktop voice (on macOS, the system voice) or the game's.
- **Screenshots**: attach what's on your screen to a message so the agent can see your game.
- **Every machine**: threads from your other computers via T3 Connect, all in one list.
- **Usage**: your providers' plans and limits, the same as Omarchy's Agents panel shows.
- A minimap button and a game-menu entry, for opening it without a keyboard.

## Requirements

- **Omarchy 4.5.0** (Hyprland), **macOS** (see [macOS](#macos)) or **Windows 11** (see [Windows](#windows)). On Omarchy the bridge reads the game window with Hyprland's screen capture, and dictation and usage come from Omarchy's own tools.
- **T3 Code Nightly**, installed and running. Its `t3` command gives the bridge a login.
- **World of Warcraft: Forever**, installed with Battle.net: Omarchy's Battle.net (Proton), or the native Mac app.
- **Node.js 22** or newer.
- **Game sound on.** The addon learns about new updates through silent sounds; with sound off it falls back to slower polling.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/ryanrhughes/t3code-wow/main/install.sh | bash
```

It finds World of Warcraft: Forever in Omarchy's Battle.net, or wherever Battle.net installed it (for anything unusual, add `bash -s -- --wow "/path/to/World of Warcraft"`). It installs the addon into the game, gives the bridge a T3 Code session limited to reading and running threads, and starts the bridge as the `t3code-wow` user service.

Then it tells you what to do in the game and waits until the game checks in. The first time, **fully quit and restart World of Warcraft**: the game only finds new addon folders when it starts. After that, updates only need a `/reload`.

To install from a clone instead, run `./install.sh` in it.

### Update

Run the same install command again:

```bash
curl -fsSL https://raw.githubusercontent.com/ryanrhughes/t3code-wow/main/install.sh | bash
```

It downloads the latest version, replaces the installed copy and restarts the bridge, keeping your settings, T3 Code session and machines. Then type `/reload` in game; the installer tells you when an update needs a full game restart instead. To install a specific release, pipe to `T3CODE_WOW_REF=v0.2.0 bash` instead of `bash`. From a clone, `git pull` and run `./install.sh` again.

### macOS

The same install command works on a Mac with the native WoW: Forever client. Install Node.js 22 first (`brew install node`). The installer finds the game in `/Applications/World of Warcraft` or wherever Battle.net put it, and runs the bridge as a launch agent (`~/Library/LaunchAgents/t3code-wow.plist`) instead of a systemd service.

- **Screen Recording permission.** The bridge reads the strip with macOS's `screencapture`, so it needs Screen Recording. The first time it runs, macOS asks, or lists `node` switched off under System Settings > Privacy & Security > Screen & System Audio Recording. Turn it on, then restart the bridge with `launchctl kickstart -k gui/$(id -u)/t3code-wow`. If the link stays down, `t3code-wow status` names the exact `node` it needs. The permission belongs to that `node` binary, so other programs that run with it can record the screen too. After you upgrade Node, macOS asks again for the new one.
- **Display settings.** Run the game at the display's full resolution (its Retina resolution on a Retina display), fullscreen or windowed. A resolution the display stretches blurs the strip.
- **Speech** uses the system voice (`say`). **Dictation** isn't available on macOS yet, and the Usage tab shows what T3 Code reports.
- `~/.local/bin` isn't on a Mac's PATH by default. The installer says so; add it to your shell profile, or run `~/.local/bin/t3code-wow`.

### Windows

On Windows 11, install from PowerShell instead:

```powershell
irm https://raw.githubusercontent.com/ryanrhughes/t3code-wow/main/install.ps1 | iex
```

Run the same command again to update, then `/reload` in game. It works in the Windows PowerShell that comes with Windows; you only need Node.js 22 or newer and T3 Code Nightly.

- **Node.js.** Install it with `winget install OpenJS.NodeJS.LTS`, or with a version manager such as fnm (`fnm install --lts`). The installer records the Node it ran with, so the bridge starts even where a version manager hasn't set up PATH. After you upgrade Node, or remove the version you installed with, run the install command again.
- **Finding the game.** The installer finds WoW: Forever from Battle.net's records, on any drive. If it picks the wrong folder or none, pass it yourself: `& ([scriptblock]::Create((irm https://raw.githubusercontent.com/ryanrhughes/t3code-wow/main/install.ps1))) --wow-dir "D:\Games\World of Warcraft"`.
- **From a clone**, run `powershell -ExecutionPolicy Bypass -File .\install.ps1` in it (add `--wow-dir` the same way if you need it).
- **Display mode.** Run the game in Windowed or Windowed (Fullscreen). The bridge reads the strip off the screen, and exclusive Fullscreen shows it a black screen; `t3code-wow status` says so when that happens. Moving the window, other monitors and display scaling are fine.
- **The `t3code-wow` command** is `t3code-wow.cmd` in `%USERPROFILE%\.local\bin`, which the installer adds to your user PATH (pass `--no-path` to leave PATH alone). Open a new terminal to use it.
- **Starting at logon.** The bridge starts when you log in, from a startup entry named `t3code-wow` (under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`), not a scheduled task, so it needs no administrator rights. The entry starts a small supervisor that runs the bridge and starts it again if it stops; `t3code-wow restart` restarts both, and `t3code-wow status` shows whether they're running.
- **"Console Window Host" in Startup apps.** The entry runs `conhost.exe --headless node.exe ...\t3code-wow.js supervise`, so the bridge has no window and the game isn't interrupted by consoles. Because of that, Settings > Apps > Startup and Task Manager's Startup apps list it as "Console Window Host" from Microsoft. That's the bridge: switching it off stops it starting at logon (`t3code-wow restart` still starts it until you log out).
- **Security software.** Some security software flags a startup entry that runs `conhost.exe --headless`, because malware uses the same trick to hide a window. If yours warns about it, check that the entry runs `node.exe` with `t3code-wow.js supervise` from `%USERPROFILE%\.local\share\t3code-wow`, and allow it. If security software blocks the PowerShell script the bridge reads the game with, see [When something's wrong](#when-somethings-wrong).
- **T3 Code must be open.** On Windows, T3 Code only serves while its app is open. When it's closed, the game shows no local threads and `t3code-wow status` says to open T3 Code; machines you added with `t3code-wow env add` keep working.
- **Speech and dictation** aren't available on Windows yet.

### Uninstall

```bash
t3code-wow uninstall
```

This removes the addon and its update folders, its settings in the game, the bridge service (or launch agent, or Windows startup entry), the bridge's T3 Code sessions (here and on any machine you added) and its files. On Windows it also removes the `t3code-wow` command, and the PATH entry the installer added if nothing else is in that folder. On macOS, also turn `node` off under Screen & System Audio Recording: uninstalling can't do that for you.

## Using it

- `/t3` opens or closes the window. You can also use the minimap button, the game menu (Esc), or hold both triggers and press Back on a controller.
- `/t3 new` starts a thread, `/t3 usage` opens the usage tab, `/t3 settings` the settings.
- `/t3 unlock` lets you drag the tracker section somewhere else; Settings → Reset tracker puts it back under your quests.
- To see threads from another machine on your tailnet, run `t3code-wow env add <host>`. It finds the machine's T3 Code over Tailscale and creates a session for the bridge over SSH.

## Commands

```bash
t3code-wow status         # what the bridge sees: T3 Code, the game, the screen link, the addon
t3code-wow status --log   # the same, with recent log lines
t3code-wow env            # other machines shown in game (add <host> / remove <name>)
t3code-wow uninstall      # remove everything (see above)
```

## When something's wrong

1. Run `t3code-wow status --log` and check each line.
2. In game, run `/t3 selftest`. It checks each step between the game and T3 Code and says which one fails.
3. `/t3 report` fills the T3 Code message box with diagnostics and attaches a screenshot of your game. Send it to an agent, or copy the text into an issue.

On Windows, if `t3code-wow status --log` shows a capture helper error that names your security software or a blocked script, that software stopped the PowerShell script the bridge reads the game with (`bridge/src/capture-helper.ps1` in the install folder). It only reads the game window's position and the pixels in its corner. Allow that file in your security software, or ask whoever manages the PC to, then restart the bridge. If the error says the script "is not digitally signed" or that "running scripts is disabled on this system", the PC's script policy is set by its administrator (Group Policy), and only they can allow it.

If the tracker says live updates are paused, do a `/reload`: the game allows a fixed number of updates per session (1,200 by default), which normally lasts many hours.

## How it works

Addons can't open network connections or read files, so the addon and the bridge talk through what the game does allow:

| Direction | How |
| --- | --- |
| Game → bridge | A small strip of coloured squares in the top-left corner for about a second after you do something. The bridge reads it with a screen capture (`grim` on Hyprland, `screencapture` on macOS). |
| Bridge → game | Load-on-demand "slot" addons. The game reads a slot's Lua from disk when it loads, so the bridge writes a fresh snapshot there first. |
| "New data" signal | Large silent sound files the bridge fills or empties. The game re-reads big sounds every time it plays them, so the addon knows when to load the next slot. |

The bridge talks to T3 Code over the same WebSocket API its apps use. Details, measurements and design decisions are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

- **The strip is encrypted.** Streams and recordings show it, so every frame is encrypted and authenticated (ChaCha20 and HMAC-SHA-256) with a key only the bridge and your addon have. To anyone else it's noise, and the bridge ignores anything it can't authenticate.
- **Addon managers.** WowUp shows a single "T3 Code" entry. Leave the `T3Code_S###` folders alone: the addon needs them.
- **Nothing else.** The addon never sends anything to Blizzard. The bridge doesn't read game memory or press keys for you; it reads pixels and writes files in the addon folder.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue or pull request. Coding agents should start with [AGENTS.md](AGENTS.md).

## Credits

- [wow-ai](https://github.com/chelinho139/wow-ai) and [wow-forever-codex](https://github.com/0xinuarashi/wow-forever-codex) measured how the Forever client loads files, plays sounds and handles the gamepad. The strip-and-slot approach builds on their work.
- [Bellular](https://www.youtube.com/@BellularGaming) ([@BellularGaming](https://x.com/BellularGaming)) gave the idea of making this an in-game addon instead of a desktop overlay.

## License

[MIT](LICENSE). This is a fan project, not affiliated with or endorsed by Blizzard Entertainment. World of Warcraft is a trademark of Blizzard Entertainment. Use it at your own discretion.
