# let-me-cook 🔥🔥🔥

A VS Code extension that displays cooking GIFs with background music right in your editor. Perfect for taking a break while coding!

## Features

- Display random cooking GIFs
- Background music player with volume controls
- Like your favorite GIFs to save them
- Auto-play mode that cycles through GIFs automatically
- Configurable display duration
- Keyboard shortcuts for quick navigation
- Beautiful, animated UI with hover controls

## Usage

### Opening the Extension

Find "🔥🔥🔥" in the Activity Bar sidebar to open the GIF viewer.

### Controls

- **❤ Like Button** (top right) - Save your favorite GIFs
- **⏭ Skip Button** (bottom right, shows on hover) - Next GIF
- **▶/♪ Music Button** (bottom left, shows on hover) - Play/pause music
- **+ / - Buttons** (bottom left, shows when playing) - Volume controls

### Keyboard Shortcuts

When the GIF viewer is open:
- `Space` or `Enter` - Show next random GIF

## Configuration

Open VS Code Settings and search for "let-me-cook" to customize:

- **Display Duration** - How long to show each GIF in seconds (default: 5)
- **Auto Play** - Automatically cycle through GIFs (default: true)

Example settings:

```json
{
  "funnyCookingGifs.displayDuration": 90,
  "funnyCookingGifs.autoPlay": true
}
```

## Requirements

- VS Code 1.60.0 or higher

## Known Issues

- Like button functionality is currently not working properly

## Release Notes

### 1.4.0

Major feature update:
- Added background music player with play/pause
- Added volume controls (+/- buttons)
- Added like button to save favorite GIFs
- Music persists across GIF changes
- Improved UI with hover-to-reveal bottom controls
- Fixed countdown timer bugs
- Renamed to "let-me-cook"

### 1.0.0

Initial release
- Random cooking GIF display
- Auto-play mode
- Beautiful animated UI

---

**Enjoy!** 🔥🔥🔥
