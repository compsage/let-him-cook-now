const vscode = require('vscode');

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
        this._likedGifs = this.loadLikedGifs();
    }

    loadLikedGifs() {
        const fs = require('fs');
        const path = require('path');
        const likedGifsPath = path.join(this._context.globalStorageUri.fsPath, 'liked-gifs.json');

        try {
            // Ensure directory exists
            const dir = path.dirname(likedGifsPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            if (fs.existsSync(likedGifsPath)) {
                const data = fs.readFileSync(likedGifsPath, 'utf8');
                return JSON.parse(data);
            }
        } catch (error) {
            console.error('Error loading liked GIFs:', error);
        }
        return {};
    }

    saveLikedGifs() {
        const fs = require('fs');
        const path = require('path');
        const likedGifsPath = path.join(this._context.globalStorageUri.fsPath, 'liked-gifs.json');

        try {
            const dir = path.dirname(likedGifsPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(likedGifsPath, JSON.stringify(this._likedGifs, null, 2), 'utf8');
        } catch (error) {
            console.error('Error saving liked GIFs:', error);
        }
    }

    toggleLike(gifId, gifUrl, gifTitle) {
        if (this._likedGifs[gifId]) {
            delete this._likedGifs[gifId];
        } else {
            this._likedGifs[gifId] = {
                url: gifUrl,
                title: gifTitle,
                likedAt: new Date().toISOString()
            };
        }
        this.saveLikedGifs();
        return !!this._likedGifs[gifId];
    }

    isLiked(gifId) {
        return !!this._likedGifs[gifId];
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
                    case 'toggleLike':
                        if (this._currentGifData) {
                            const isLiked = this.toggleLike(
                                this._currentGifData.id,
                                this._currentGifData.images.original.url,
                                this._currentGifData.title || 'Funny Cooking GIF'
                            );
                            // Send updated like status back to webview
                            webviewView.webview.postMessage({
                                command: 'likeStatusUpdated',
                                isLiked: isLiked
                            });
                        }
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
                const isLiked = this.isLiked(gifData.id);

                // Send message to update GIF instead of replacing HTML
                this._view.webview.postMessage({
                    command: 'updateGif',
                    gifUrl: gifData.images.original.url,
                    gifId: gifData.id,
                    title: gifData.title || 'Cooking GIF',
                    isLiked: isLiked,
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

    async fetchRandomGifFromS3(bucket, region, prefix) {
        const https = require('https');

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

                        // Extract keys and filter for GIF files
                        const gifKeys = keyMatches
                            .map(match => match.replace(/<\/?Key>/g, ''))
                            .filter(key => key.toLowerCase().endsWith('.gif') && key !== prefix);

                        if (gifKeys.length === 0) {
                            resolve(null);
                            return;
                        }

                        // Pick a random GIF
                        const randomKey = gifKeys[Math.floor(Math.random() * gifKeys.length)];
                        const gifUrl = `https://${bucket}.s3.${region}.amazonaws.com/${encodeURIComponent(randomKey).replace(/%2F/g, '/')}`;

                        // Create a GIF data object similar to Giphy format
                        resolve({
                            id: randomKey,
                            title: randomKey.split('/').pop().replace('.gif', ''),
                            images: {
                                original: {
                                    url: gifUrl
                                }
                            }
                        });
                    } catch (e) {
                        reject(e);
                    }
                });
            }).on('error', (err) => {
                reject(err);
            });
        });
    }

    async fetchRandomMusicFromS3(bucket, region, prefix) {
        const https = require('https');

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

                        // Extract keys and filter for MP3 files
                        const musicKeys = keyMatches
                            .map(match => match.replace(/<\/?Key>/g, ''))
                            .filter(key => key.toLowerCase().endsWith('.mp3') && key !== prefix);

                        if (musicKeys.length === 0) {
                            resolve(null);
                            return;
                        }

                        // Pick a random music file
                        const randomKey = musicKeys[Math.floor(Math.random() * musicKeys.length)];
                        const musicUrl = `https://${bucket}.s3.${region}.amazonaws.com/${encodeURIComponent(randomKey).replace(/%2F/g, '/')}`;

                        // Return music URL
                        resolve({
                            url: musicUrl,
                            title: randomKey.split('/').pop().replace('.mp3', '')
                        });
                    } catch (e) {
                        reject(e);
                    }
                });
            }).on('error', (err) => {
                reject(err);
            });
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

                .like-btn {
                    top: 8px;
                    right: 8px;
                }

                .like-btn.liked {
                    color: #ff4757;
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
                    <button class="button-base like-btn" id="likeBtn" onclick="toggleLike()" title="Like GIF">❤</button>
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
                const likeBtn = document.getElementById('likeBtn');
                const countdownBar = document.getElementById('countdownBar');
                let isPlaying = false;
                let currentGifId = null;

                function getNewGif() {
                    // Show loading state
                    loadingIndicator.style.display = 'flex';
                    gifImage.style.display = 'none';
                    vscode.postMessage({ command: 'getNewGif' });
                }

                function toggleLike() {
                    vscode.postMessage({ command: 'toggleLike' });
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

                        // Update like button
                        if (message.isLiked) {
                            likeBtn.classList.add('liked');
                            likeBtn.title = 'Unlike GIF';
                        } else {
                            likeBtn.classList.remove('liked');
                            likeBtn.title = 'Like GIF';
                        }

                        // Restart countdown animation if autoplay is enabled
                        if (message.autoPlay && message.displayDuration) {
                            restartCountdown(message.displayDuration);
                        }
                    }

                    if (message.command === 'gifError') {
                        loadingIndicator.innerHTML = '<p>😕 ' + message.error + '</p>';
                        gifImage.style.display = 'none';
                    }

                    if (message.command === 'likeStatusUpdated') {
                        if (message.isLiked) {
                            likeBtn.classList.add('liked');
                            likeBtn.title = 'Unlike GIF';
                        } else {
                            likeBtn.classList.remove('liked');
                            likeBtn.title = 'Like GIF';
                        }
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

    getLoadingHTML() {
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    background-color: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    height: 100vh;
                    margin: 0;
                    padding: 20px;
                }
                .loading-container {
                    text-align: center;
                }
                .loading-spinner {
                    border: 3px solid rgba(255, 255, 255, 0.1);
                    border-top: 3px solid var(--vscode-button-background);
                    border-radius: 50%;
                    width: 40px;
                    height: 40px;
                    animation: spin 1s linear infinite;
                    margin: 0 auto 15px;
                }
                @keyframes spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
                p {
                    font-size: 12px;
                }
            </style>
        </head>
        <body>
            <div class="loading-container">
                <div class="loading-spinner"></div>
                <p>Loading GIF from S3... 🔥</p>
            </div>
        </body>
        </html>`;
    }

    getErrorHTML(message) {
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    background-color: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    height: 100vh;
                    text-align: center;
                    padding: 20px;
                }
                .error-container {
                    max-width: 300px;
                }
                .emoji {
                    font-size: 36px;
                    margin-bottom: 15px;
                }
                h2 {
                    font-size: 16px;
                }
                p {
                    font-size: 12px;
                }
            </style>
        </head>
        <body>
            <div class="error-container">
                <div class="emoji">😕</div>
                <h2>Oops!</h2>
                <p>${message}</p>
            </div>
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
