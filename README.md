<p align="center">
  <img src="docs/homepage.jpg" alt="A recording of the Tern homepage plays inside Claude Code, with the list of what changed beside it" width="100%">
</p>

<h1 align="center">claude-show-your-work</h1>

<p align="center">Claude Code can show you pictures and play videos in the terminal.</p>

<p align="center">
  <a href="#install"><img src="https://img.shields.io/badge/Claude_Code-plugin-D97757?logo=claude&logoColor=white" alt="Claude Code plugin"></a>
  <a href="#install"><img src="https://img.shields.io/badge/Ghostty-supported-3B82F6?logo=gnometerminal&logoColor=white" alt="Works in Ghostty"></a>
  <a href="#install"><img src="https://img.shields.io/badge/macOS-000000?logo=apple&logoColor=white" alt="macOS"></a>
  <a href="#windows"><img src="https://img.shields.io/badge/Windows_11-Rio-0078D4?logo=windows&logoColor=white" alt="Windows 11 in Rio"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/iamumeransari/claude-show-your-work?color=22C55E" alt="MIT license"></a>
</p>

claude-show-your-work is a Claude Code plugin that displays images and plays videos in the chat. Claude uses it to show what it has made, such as a web page, a design, a chart or a video, and to play recordings of your app while it tests it.

> **This fork** adds native Windows 11 support (no WSL), in the Rio terminal: see [Windows](#windows). It also turns automatic updates and usage stats off unless you turn them on. The original is [iamumeransari/claude-show-your-work](https://github.com/iamumeransari/claude-show-your-work).

## Install

Run these two commands in Claude Code:

```
/plugin marketplace add https://github.com/vascc124/claude-show-your-work.git
/plugin install show-your-work@vascc124
```

The plugin requires Claude Code 2.1.287 or later and a terminal that can draw pictures: Ghostty on macOS or Linux, or Rio set up as described under [Windows](#windows). Videos also require ffmpeg, which you can install with `brew install ffmpeg`, `winget install Gyan.FFmpeg` on Windows, or by asking Claude to install it.

## Usage

Claude shows visual work without being asked. You can also ask for it directly, for example:

- "Give me four directions for the homepage hero and show them side by side."
- "Build the sign-up form, test it, and show me the recording."
- "Fix the billing toggle and show me before and after."

### Design

<p align="center">
  <img src="docs/concepts.jpg" alt="Four landing page concepts for Tern shown in the chat" width="49%">
  <img src="docs/breakpoints.jpg" alt="The Tern homepage at desktop, tablet and phone sizes shown in the chat" width="49%">
</p>

Claude can show several design concepts side by side, and you choose one by replying. It can also show a finished page at desktop, tablet and phone widths in a single image.

### Testing

<p align="center"><img src="docs/qa-product.jpg" alt="A recording of a new-trip form being tested, with what changed and the checks beside it" width="100%"></p>

Claude can test a feature with Playwright, record the run, and play the recording in the chat. The changes it made are listed next to the video, and clicking a change jumps to that point. Each check is marked as passed or failed when the video reaches it.

For a bug fix, Claude records the same steps on the old and new versions. The Compare view plays both recordings side by side and keeps them in sync, even when one loads more slowly, with the check results for each version.

### Video

<p align="center">
  <img src="docs/persona.jpg" alt="A character sheet for an ad persona shown in the chat" width="49%">
  <img src="docs/reel.jpg" alt="A vertical video ad made from that persona plays, with the ad's structure listed next to it" width="49%">
</p>

Videos play in the chat with a list beside them, such as the sections of an ad. When Claude makes a new version, the earlier ones stay in the history so you can compare them.

Charts, slides, motion graphics and any other image or video file work the same way.

## Errors

If a file can't be shown, a note appears in its place with the reason: the file is missing, it isn't an image, the video is damaged or has no picture, ffmpeg isn't installed, or the terminal can't display images. The note has a button that copies a prompt for Claude to fix the problem.

## How it works

Claude Code mods let a plugin draw its own interface inside Claude Code, and Ghostty can display images in the terminal. Claude tells the plugin which file to show, and the plugin passes it to the terminal.

Videos are split into frames with ffmpeg. The plugin prepares a few seconds of frames at a time, so long videos use little memory or disk space.

The image or video goes to your screen and not to Claude, so displaying it uses no tokens.

## Terminals

The plugin works in Ghostty. iTerm2, Terminal.app and the VS Code terminal can't display these images, and the plugin tells you when that happens.

In tmux, add `set -g allow-passthrough on` to `~/.tmux.conf`. If the setting is off, the plugin shows you how to turn it on.

## Windows

On Windows 11 the plugin works in [Rio](https://rioterm.com) once Rio has two things. Windows Terminal, WezTerm and the VS Code terminal can't draw these images yet.

1. **Microsoft's newer ConPTY next to `rio.exe`.** Every Windows terminal talks to programs through ConPTY, and the copy built into Windows drops the escape codes that carry pictures. Microsoft publishes a newer one as the [`Microsoft.Windows.Console.ConPTY`](https://www.nuget.org/packages/Microsoft.Windows.Console.ConPTY) package, and Rio uses `conpty.dll` and `OpenConsole.exe` when they sit beside it.
2. **Two variables in Rio's config.** Claude Code turns pictures on by itself only in kitty and Ghostty, so `CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1` tells it Rio can draw them. Claude Code also marks each picture with a text color, which needs at least 256 colors, so `FORCE_COLOR=3` tells it Rio has full color. Setting them in Rio's config keeps them out of other terminals, where they would draw garbage.

The setup script does both. Run it once in an admin PowerShell:

```powershell
winget install raphamorim.rio
winget install Gyan.FFmpeg
git clone https://github.com/vascc124/claude-show-your-work
powershell -ExecutionPolicy Bypass -File .\claude-show-your-work\scripts\setup-rio-windows.ps1
```

It downloads the ConPTY package from nuget.org, checks it against a pinned hash and Microsoft's signature, copies the two files into Rio's folder, and adds the variables to `%LOCALAPPDATA%\rio\config.toml`. Then open Rio and run `claude`.

The plugin's file work uses the Unix tools that come with Git for Windows, which Claude Code on Windows already requires.

## FAQ

### Does it update itself?

Not in this fork, unless you set `SHOW_YOUR_WORK_AUTO_UPDATE=1`. Then, when Claude Code starts, it checks this fork on GitHub for a new version once a day and installs it.

### Does it collect any data?

Not in this fork, unless you set `SHOW_YOUR_WORK_TELEMETRY=1`. Then it sends anonymous usage counts, such as which versions are in use and how often images and videos are shown. It never sends files, file names, paths, prompts or anything you write, and it never records your IP address or location.

## Feedback

To report a bug or suggest a change, [open an issue](https://github.com/iamumeransari/claude-show-your-work/issues). For anything about Windows, open it [in this fork](https://github.com/vascc124/claude-show-your-work/issues).

<details>
<summary><b>For developers</b></summary>

The plugin gives Claude two tools, `show_image` and `show_video`. A basic call needs only a path. For a before and after, Claude also passes the old file and its results:

```jsonc
{
  "path": "qa/after.webm",          // the run on the fixed version
  "compare": "qa/before.webm",      // the same steps on the old version
  "title": "Pricing page",
  "url": "http://localhost:3000/pricing",
  "changes": [                      // what changed, and the second it shows up
    { "title": "Annual toggle sets prices", "at": 3.2 },
    { "title": "Plan buttons line up", "at": 5.4 }
  ],
  "summary": [                      // the test results, at most three lines
    { "label": "Billing: toggle works", "ok": true, "passed": 1, "total": 1 },
    { "label": "Layout: plans, buttons", "ok": true, "passed": 3, "total": 3 }
  ]
}
```

Videos become frames at up to 12 per second, 960 px wide, 900 frames at most. You can open any file yourself with `/img path/to/file.png`.

To work on the plugin, edit `hooks/register.tsx` and run `/reload-plugins`. Check it with `claude plugin validate .` and `claude plugin test .`.

</details>

## License

[MIT](LICENSE). Photography in the examples is from [Unsplash](https://unsplash.com), used under the Unsplash License.

<p align="center"><a href="#install"><img src="docs/end-card.jpg" alt="show-your-work, with the install commands" width="100%"></a></p>
