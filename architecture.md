# Let Him Cook Now - Architecture Diagram

```mermaid
graph TB
    subgraph "VS Code IDE"
        User[User]

        subgraph "Extension Host (Node.js)"
            Activate[Activate Function]
            Commands[Command Handlers]
            Provider[GifViewProvider]
            Config[Configuration Manager]

            Activate --> Provider
            Activate --> Commands
            Commands --> Provider
            Config --> Provider
        end

        subgraph "Webview (Browser Context)"
            HTML[webview.html]
            UI[UI Components]
            Audio[Audio Player]
            EventHandler[Message Handler]

            HTML --> UI
            HTML --> Audio
            HTML --> EventHandler
        end

        User -->|Clicks Commands| Commands
        User -->|Interacts with UI| UI
        Provider <-->|postMessage| EventHandler
    end

    subgraph "External Services"
        S3[AWS S3 Bucket]
        GIFs[(GIF Files)]
        Music[(Music Files)]

        S3 --> GIFs
        S3 --> Music
    end

    Provider -->|HTTPS Request| S3
    S3 -->|Media URLs| Provider
    Provider -->|updateGif/musicLoaded| EventHandler
    EventHandler -->|Display| UI
    EventHandler -->|Play| Audio
    EventHandler -->|getNewGif/getRandomMusic| Provider

    style User fill:#e1f5ff
    style Provider fill:#ffe1e1
    style S3 fill:#e1ffe1
    style UI fill:#fff4e1
```

## Component Descriptions

### Extension Host (Node.js)
- **Activate Function**: Initializes extension and registers commands
- **Command Handlers**: Handles VS Code commands (next, toggle music, stop, refresh)
- **GifViewProvider**: Core logic for GIF/music management and S3 integration
- **Configuration Manager**: Reads workspace settings for S3 bucket configuration

### Webview (Browser Context)
- **webview.html**: Main UI template with HTML/CSS/JavaScript
- **UI Components**: GIF display, buttons, countdown progress bar
- **Audio Player**: HTML5 audio element for music playback
- **Message Handler**: Bidirectional communication bridge with extension host

### External Services
- **AWS S3 Bucket**: Cloud storage hosting GIF and music files
- Public bucket serving media content via HTTPS

## Data Flow

1. **User Action** → VS Code Command
2. **Command** → GifViewProvider method
3. **Provider** → S3 HTTPS Request
4. **S3** → Returns media file list/URLs
5. **Provider** → Sends message to Webview
6. **Webview** → Displays GIF or plays music
7. **Webview** → Sends state updates back to Extension
