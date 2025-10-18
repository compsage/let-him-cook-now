const vscode = require('vscode');
const https = require('https');

let gifViewProvider = null;

function activate(context) {
    console.log('🔥🔥🔥 You can cook now 🔥🔥🔥');

    // Create and register the webview view provider
    gifViewProvider = new GifViewProvider(context.extensionUri, context);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'funnyCookingGifs.gifView',
            gifViewProvider,
            {
                webviewOptions: {
                    retainContextWhenHidden: true
                }
            }
        )
    );

    // Command to get next GIF
    let nextCommand = vscode.commands.registerCommand('funny-cooking-gifs.nextGif', async function () {
        if (gifViewProvider) {
            await gifViewProvider.updateGif();
        }
    });

    context.subscriptions.push(nextCommand);
}

class GifViewProvider {
    constructor(extensionUri, context) {
        this._extensionUri = extensionUri;
        this._context = context;
        this._view = null;
        this._autoRefreshInterval = null;
        this._currentGifData = null;
    }

    resolveWebviewView(webviewView, context, _token) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        // Handle messages from webview
        webviewView.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'getNewGif':
                        await this.updateGif();
                        break;
                    case 'openGiphy':
                        vscode.env.openExternal(vscode.Uri.parse(message.url));
                        break;
                    case 'getRandomMusic':
                        try {
                            const config = vscode.workspace.getConfiguration('funnyCookingGifs');
                            const s3Bucket = config.get('s3Bucket', 'let-them-cook-now');
                            const s3Region = config.get('s3Region', 'us-east-1');
                            const s3MusicPrefix = config.get('s3MusicPrefix', 'songs/');

                            const musicData = await this.fetchRandomMusicFromS3(s3Bucket, s3Region, s3MusicPrefix);

                            if (musicData) {
                                webviewView.webview.postMessage({
                                    command: 'musicLoaded',
                                    musicUrl: musicData.url,
                                    title: musicData.title
                                });
                            } else {
                                webviewView.webview.postMessage({
                                    command: 'musicError',
                                    error: 'No music files found'
                                });
                            }
                        } catch (error) {
                            console.error('Error fetching music:', error);
                            webviewView.webview.postMessage({
                                command: 'musicError',
                                error: 'Failed to load music'
                            });
                        }
                        break;
                }
            }
        );

        // Handle when the view becomes visible
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this.setupAutoRefresh();
            } else {
                this.clearAutoRefresh();
            }
        });

        // Initial load - set HTML once
        const config = vscode.workspace.getConfiguration('funnyCookingGifs');
        const displayDuration = config.get('displayDuration', 5);
        const autoPlay = config.get('autoPlay', true);
        const panelTitle = config.get('commandTitle', '🔥🔥🔥');

        this._view.webview.html = this.getWebviewContent(panelTitle, displayDuration, autoPlay);

        // Then load first GIF
        this.updateGif();
        this.setupAutoRefresh();
    }

    async updateGif() {
        if (!this._view) return;

        const config = vscode.workspace.getConfiguration('funnyCookingGifs');
        const s3Bucket = config.get('s3Bucket', 'let-them-cook-now');
        const s3Region = config.get('s3Region', 'us-east-1');
        const s3Prefix = config.get('s3Prefix', 'gifs/');
        const displayDuration = config.get('displayDuration', 5);
        const autoPlay = config.get('autoPlay', true);

        try {
            // Fetch a random GIF from S3
            const gifData = await this.fetchRandomGifFromS3(s3Bucket, s3Region, s3Prefix);

            if (gifData) {
                this._currentGifData = gifData;

                // Send message to update GIF instead of replacing HTML
                this._view.webview.postMessage({
                    command: 'updateGif',
                    gifUrl: gifData.images.original.url,
                    gifId: gifData.id,
                    title: gifData.title || 'Cooking GIF',
                    displayDuration: displayDuration,
                    autoPlay: autoPlay
                });
            } else {
                this._currentGifData = null;
                this._view.webview.postMessage({
                    command: 'gifError',
                    error: 'No GIFs found in S3 bucket.'
                });
            }
        } catch (error) {
            console.error('Error fetching GIF:', error);
            this._view.webview.postMessage({
                command: 'gifError',
                error: 'Failed to load GIF from S3. Check bucket configuration and connection.'
            });
        }
    }

    async fetchRandomFileFromS3(bucket, region, prefix, fileExtensions, formatResponse = null) {
        return new Promise((resolve, reject) => {
            // List objects in S3 bucket using XML API
            const url = `https://${bucket}.s3.${region}.amazonaws.com/?list-type=2&prefix=${encodeURIComponent(prefix)}`;

            https.get(url, (res) => {
                let data = '';

                res.on('data', (chunk) => {
                    data += chunk;
                });

                res.on('end', () => {
                    try {
                        // Parse XML response to get list of files
                        const keyMatches = data.match(/<Key>([^<]+)<\/Key>/g);

                        if (!keyMatches || keyMatches.length === 0) {
                            resolve(null);
                            return;
                        }

                        // Extract keys and filter for specified file extensions
                        const fileKeys = keyMatches
                            .map(match => match.replace(/<\/?Key>/g, ''))
                            .filter(key => {
                                const lowerKey = key.toLowerCase();
                                return fileExtensions.some(ext => lowerKey.endsWith(ext.toLowerCase())) && key !== prefix;
                            });

                        if (fileKeys.length === 0) {
                            resolve(null);
                            return;
                        }

                        // Pick a random file
                        const randomKey = fileKeys[Math.floor(Math.random() * fileKeys.length)];
                        const fileUrl = `https://${bucket}.s3.${region}.amazonaws.com/${encodeURIComponent(randomKey).replace(/%2F/g, '/')}`;

                        // Use custom formatter if provided, otherwise return basic data
                        if (formatResponse) {
                            resolve(formatResponse(randomKey, fileUrl));
                        } else {
                            resolve({
                                url: fileUrl,
                                key: randomKey,
                                title: randomKey.split('/').pop()
                            });
                        }
                    } catch (e) {
                        reject(e);
                    }
                });
            }).on('error', (err) => {
                reject(err);
            });
        });
    }

    async fetchRandomGifFromS3(bucket, region, prefix) {
        return this.fetchRandomFileFromS3(bucket, region, prefix, ['.gif'], (randomKey, fileUrl) => {
            // Create a GIF data object similar to Giphy format
            return {
                id: randomKey,
                title: randomKey.split('/').pop().replace('.gif', ''),
                images: {
                    original: {
                        url: fileUrl
                    }
                }
            };
        });
    }

    async fetchRandomMusicFromS3(bucket, region, prefix) {
        return this.fetchRandomFileFromS3(bucket, region, prefix, ['.mp3'], (randomKey, fileUrl) => {
            // Return music URL
            return {
                url: fileUrl,
                title: randomKey.split('/').pop().replace('.mp3', '')
            };
        });
    }

    setupAutoRefresh() {
        this.clearAutoRefresh();

        const config = vscode.workspace.getConfiguration('funnyCookingGifs');
        const displayDuration = config.get('displayDuration', 5);
        const autoPlay = config.get('autoPlay', true);

        if (autoPlay && this._view && this._view.visible) {
            const intervalMs = displayDuration * 1000;
            this._autoRefreshInterval = setInterval(() => {
                this.updateGif();
            }, intervalMs);
        }
    }

    clearAutoRefresh() {
        if (this._autoRefreshInterval) {
            clearInterval(this._autoRefreshInterval);
            this._autoRefreshInterval = null;
        }
    }

    getWebviewContent(panelTitle, displayDuration, autoPlay) {

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${panelTitle}</title>
            <style>
                * {
                    margin: 0;
                    padding: 0;
                    box-sizing: border-box;
                }

                body {
                    font-family: var(--vscode-font-family);
                    background-color: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                    padding: 0;
                    margin: 0;
                    overflow: hidden;
                }

                .container {
                    width: 100%;
                    height: 100%;
                }

                .gif-container {
                    position: relative;
                    background: var(--vscode-editor-background);
                    overflow: hidden;
                }

                .gif-container img {
                    width: 100%;
                    height: auto;
                    display: block;
                }

                .countdown-bar {
                    position: absolute;
                    top: 0;
                    left: 0;
                    height: 2px;
                    background: linear-gradient(90deg, #FF6B6B, #FFD93D);
                    animation: countdown ${displayDuration}s linear;
                    width: 100%;
                    z-index: 10;
                }

                @keyframes countdown {
                    from { width: 100%; }
                    to { width: 0%; }
                }

                .button-base {
                    position: absolute;
                    background: rgba(0, 0, 0, 0.6);
                    color: white;
                    border: none;
                    width: 32px;
                    height: 32px;
                    border-radius: 50%;
                    cursor: pointer;
                    font-size: 16px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    transition: all 0.2s;
                    z-index: 20;
                    backdrop-filter: blur(4px);
                }

                .button-base:hover {
                    background: rgba(0, 0, 0, 0.8);
                    transform: scale(1.1);
                }

                .button-base:active {
                    transform: scale(0.95);
                }

                .skip-btn {
                    bottom: 8px;
                    right: 8px;
                    opacity: 0;
                    transition: opacity 0.3s;
                }

                .gif-container:hover .skip-btn {
                    opacity: 1;
                }

                .music-controls {
                    position: absolute;
                    bottom: 8px;
                    left: 8px;
                    display: flex;
                    gap: 8px;
                    z-index: 20;
                    opacity: 0;
                    transition: opacity 0.3s;
                }

                .gif-container:hover .music-controls {
                    opacity: 1;
                }

                .music-btn {
                    background: rgba(0, 0, 0, 0.6);
                    color: white;
                    border: none;
                    width: 32px;
                    height: 32px;
                    border-radius: 50%;
                    cursor: pointer;
                    font-size: 14px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    transition: all 0.2s;
                    backdrop-filter: blur(4px);
                }

                .music-btn:hover {
                    background: rgba(0, 0, 0, 0.8);
                    transform: scale(1.1);
                }

                .music-btn:active {
                    transform: scale(0.95);
                }

                .volume-controls {
                    display: none;
                    gap: 8px;
                }

                .volume-controls.visible {
                    display: flex;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="gif-container">
                    ${autoPlay ? `<div class="countdown-bar" id="countdownBar"></div>` : ''}
                    <button class="button-base skip-btn" onclick="getNewGif()" title="Next GIF">⏭</button>
                    <div class="music-controls">
                        <button class="music-btn" id="playBtn" onclick="playMusic()" title="Play Music">▶</button>
                        <div class="volume-controls" id="volumeControls">
                            <button class="music-btn" onclick="decreaseVolume()" title="Volume Down">-</button>
                            <button class="music-btn" onclick="increaseVolume()" title="Volume Up">+</button>
                        </div>
                    </div>
                    <audio id="audioPlayer" style="display: none;"></audio>
                    <img id="gifImage" src="" alt="Loading..." style="display: none;">
                    <div id="loadingIndicator" style="display: flex; justify-content: center; align-items: center; min-height: 200px; color: var(--vscode-editor-foreground);">
                        <p>Loading GIF... 🔥</p>
                    </div>
                </div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                const audioPlayer = document.getElementById('audioPlayer');
                const playBtn = document.getElementById('playBtn');
                const volumeControls = document.getElementById('volumeControls');
                const gifImage = document.getElementById('gifImage');
                const loadingIndicator = document.getElementById('loadingIndicator');
                const countdownBar = document.getElementById('countdownBar');
                let isPlaying = false;
                let currentGifId = null;

                function getNewGif() {
                    // Show loading state
                    loadingIndicator.style.display = 'flex';
                    gifImage.style.display = 'none';
                    vscode.postMessage({ command: 'getNewGif' });
                }

                function playMusic() {
                    if (isPlaying) {
                        // Pause music
                        audioPlayer.pause();
                        isPlaying = false;
                        playBtn.textContent = '▶';
                        playBtn.title = 'Play Music';
                        volumeControls.classList.remove('visible');
                    } else {
                        // Always fetch a new random song when play is clicked
                        vscode.postMessage({ command: 'getRandomMusic' });
                    }
                }

                function increaseVolume() {
                    if (audioPlayer.volume < 1.0) {
                        audioPlayer.volume = Math.min(1.0, audioPlayer.volume + 0.1);
                    }
                }

                function decreaseVolume() {
                    if (audioPlayer.volume > 0) {
                        audioPlayer.volume = Math.max(0, audioPlayer.volume - 0.1);
                    }
                }

                function restartCountdown(duration) {
                    if (countdownBar && duration) {
                        // Force restart animation with new duration
                        countdownBar.style.animation = 'none';
                        // Force reflow to ensure animation restarts
                        countdownBar.offsetHeight;
                        countdownBar.style.animation = \`countdown \${duration}s linear\`;
                    }
                }

                // Listen for messages from the extension
                window.addEventListener('message', event => {
                    const message = event.data;

                    if (message.command === 'updateGif') {
                        // Update GIF
                        currentGifId = message.gifId;
                        gifImage.src = message.gifUrl;
                        gifImage.alt = message.title;
                        gifImage.style.display = 'block';
                        loadingIndicator.style.display = 'none';

                        // Restart countdown animation if autoplay is enabled
                        if (message.autoPlay && message.displayDuration) {
                            restartCountdown(message.displayDuration);
                        }
                    }

                    if (message.command === 'gifError') {
                        loadingIndicator.innerHTML = '<p>😕 ' + message.error + '</p>';
                        gifImage.style.display = 'none';
                    }

                    if (message.command === 'musicLoaded') {
                        audioPlayer.src = message.musicUrl;
                        audioPlayer.volume = 0.5; // Start at 50% volume
                        audioPlayer.play().then(() => {
                            isPlaying = true;
                            playBtn.textContent = '♪';
                            playBtn.title = 'Playing: ' + message.title;
                            volumeControls.classList.add('visible');
                        }).catch(err => {
                            console.error('Error playing audio:', err);
                        });

                        // Play next random song when current one ends
                        audioPlayer.onended = () => {
                            vscode.postMessage({ command: 'getRandomMusic' });
                        };
                    }

                    if (message.command === 'musicError') {
                        console.error('Music error:', message.error);
                        isPlaying = false;
                    }
                });

                // Keyboard shortcut
                document.addEventListener('keydown', (e) => {
                    if (e.key === ' ' || e.key === 'Enter') {
                        e.preventDefault();
                        getNewGif();
                    }
                });
            </script>
        </body>
        </html>`;
    }
}

function deactivate() {
    if (gifViewProvider) {
        gifViewProvider.clearAutoRefresh();
    }
}

module.exports = {
    activate,
    deactivate
}
