const vscode = require('vscode');
const https = require('https');
const fs = require('fs');
const path = require('path');

let gifViewProvider = null;

function activate(context) {
    console.log('🔥🔥🔥 You can cook now 🔥🔥🔥');

    // Initialize context key for music playing state
    vscode.commands.executeCommand('setContext', 'funnyCookingGifs.musicPlaying', false);

    // Create and register the webview view provider
    gifViewProvider = new GifViewProvider(context);

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
    const ensureViewReady = () => {
        if (gifViewProvider && gifViewProvider.hasActiveView()) {
            return true;
        }
        vscode.window.showErrorMessage('Extension not ready. Try reopening the panel.');
        return false;
    };

    // Command to get next GIF
    const nextCommand = vscode.commands.registerCommand('funny-cooking-gifs.nextGif', async () => {
        if (gifViewProvider) {
            await gifViewProvider.updateGif();
        }
    });

    // Command to toggle music playback
    const musicCommand = vscode.commands.registerCommand('funny-cooking-gifs.toggleMusic', () => {
        if (!ensureViewReady()) {
            return;
        }
        gifViewProvider.postMessage({ command: 'toggleMusic' });
    });

    // Command to stop music
    const stopMusicCommand = vscode.commands.registerCommand('funny-cooking-gifs.stopMusic', () => {
        if (!ensureViewReady()) {
            return;
        }
        gifViewProvider.postMessage({ command: 'stopMusic' });
    });

    // Command to refresh GIF cache
    const refreshGifListCommand = vscode.commands.registerCommand('funny-cooking-gifs.refreshGifList', async () => {
        if (!ensureViewReady()) {
            return;
        }
        try {
            await gifViewProvider.refreshGifList();
        } catch (error) {
            console.error('Failed to refresh GIF list:', error);
            vscode.window.showErrorMessage('Failed to refresh GIF list. Check logs for details.');
        }
    });

    context.subscriptions.push(nextCommand, refreshGifListCommand, musicCommand, stopMusicCommand);
}

class GifViewProvider {
    constructor(context) {
        this._extensionUri = context.extensionUri;
        this._view = null;
        this._autoRefreshInterval = null;
        this._isFetchingGif = false;
        this._gifCache = [];
        this._gifCacheConfig = null;
        this._gifListLoadPromise = null;
        this._gifListLoadSignature = null;
        this._shuffledGifList = [];
        this._gifIndex = 0;
        this._musicCache = [];
        this._musicCacheConfig = null;
        this._musicListLoadPromise = null;
        this._musicListLoadSignature = null;
        this._likedGifs = new Set();
        this._likesSaveTimer = null;
        this._likesDirty = false;
        this._likesSavePromise = Promise.resolve();
        this._likesFilePath = path.join(
            context.globalStorageUri.fsPath,
            `${vscode.env.machineId}_likes.txt`
        );
    }

    async _loadLikes() {
        try {
            const dir = path.dirname(this._likesFilePath);
            await fs.promises.mkdir(dir, { recursive: true });
            const data = await fs.promises.readFile(this._likesFilePath, 'utf8');
            this._likedGifs = new Set(
                data.split('\n').map(line => line.trim()).filter(Boolean)
            );
        } catch (error) {
            if (error && error.code !== 'ENOENT') {
                console.error('Error loading likes:', error);
            }
            this._likedGifs = this._likedGifs || new Set();
        }
    }

    async _saveLikesImmediate() {
        const dir = path.dirname(this._likesFilePath);
        await fs.promises.mkdir(dir, { recursive: true });
        await fs.promises.writeFile(this._likesFilePath, [...this._likedGifs].join('\n'), 'utf8');
    }

    _scheduleSaveLikes() {
        this._likesDirty = true;
        if (this._likesSaveTimer) {
            return;
        }
        this._likesSaveTimer = setTimeout(() => {
            this._likesSaveTimer = null;
            if (!this._likesDirty) {
                return;
            }
            this._likesDirty = false;
            this._likesSavePromise = this._likesSavePromise
                .then(() => this._saveLikesImmediate())
                .catch(error => {
                    console.error('Error saving likes:', error);
                });
        }, 250);
    }

    async flushLikes() {
        if (this._likesSaveTimer) {
            clearTimeout(this._likesSaveTimer);
            this._likesSaveTimer = null;
        }
        if (this._likesDirty) {
            this._likesDirty = false;
            try {
                await this._saveLikesImmediate();
            } catch (error) {
                console.error('Error saving likes:', error);
            }
        } else {
            await this._likesSavePromise.catch(() => {});
        }
    }

    async toggleLike(gifId) {
        if (this._likedGifs.has(gifId)) {
            this._likedGifs.delete(gifId);
        } else {
            this._likedGifs.add(gifId);
        }
        this._scheduleSaveLikes();
        return this._likedGifs.has(gifId);
    }

    isLiked(gifId) {
        return this._likedGifs.has(gifId);
    }

    shuffleArray(array) {
        const shuffled = [...array];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
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
                    case 'getRandomMusic':
                        try {
                            console.log('Fetching random music...');
                            const config = vscode.workspace.getConfiguration('funnyCookingGifs');
                            const s3Bucket = config.get('s3Bucket', 'let-them-cook-now');
                            const s3Region = config.get('s3Region', 'us-east-1');
                            const s3MusicPrefix = config.get('s3MusicPrefix', 'songs/');

                            const musicData = await this.fetchRandomMusicFromS3(s3Bucket, s3Region, s3MusicPrefix);

                            if (musicData) {
                                console.log('Sending musicLoaded:', musicData.title);
                                webviewView.webview.postMessage({
                                    command: 'musicLoaded',
                                    musicUrl: musicData.url,
                                    title: musicData.title
                                });
                            } else {
                                console.log('No music files found');
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
                    case 'toggleLike':
                        const liked = await this.toggleLike(message.gifId);
                        this._view.webview.postMessage({ command: 'likeUpdated', gifId: message.gifId, isLiked: liked });
                        break;
                    case 'musicStarted':
                        // Update context when music actually starts playing
                        console.log('Music started, setting context to true');
                        vscode.commands.executeCommand('setContext', 'funnyCookingGifs.musicPlaying', true);
                        break;
                    case 'musicStopped':
                        // Update context when music stops
                        console.log('Music stopped, setting context to false');
                        vscode.commands.executeCommand('setContext', 'funnyCookingGifs.musicPlaying', false);
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

        webviewView.onDidDispose(() => {
            this.clearAutoRefresh();
            this.flushLikes().catch(error => {
                console.error('Failed to flush likes:', error);
            });
            this._view = null;
        });

        // Initial load - set HTML once
        const config = vscode.workspace.getConfiguration('funnyCookingGifs');
        const displayDuration = config.get('displayDuration', 90);
        const autoPlay = config.get('autoPlay', true);
        const panelTitle = config.get('commandTitle', '🔥🔥🔥');
        const s3Bucket = config.get('s3Bucket', 'let-them-cook-now');
        const s3Region = config.get('s3Region', 'us-east-1');
        const s3Prefix = config.get('s3Prefix', 'gifs/');

        this._view.webview.html = this.getWebviewContent(panelTitle, displayDuration, autoPlay);

        this._loadLikes().catch(error => {
            console.error('Failed to load likes:', error);
        });

        this.loadGifList({ bucket: s3Bucket, region: s3Region, prefix: s3Prefix }).catch(error => {
            console.error('Failed to preload GIF list:', error);
        });

        // Then load first GIF
        this.updateGif();
        this.setupAutoRefresh(true);
    }

    async updateGif() {
        if (!this._view || this._isFetchingGif) {
            return;
        }

        this._isFetchingGif = true;

        const config = vscode.workspace.getConfiguration('funnyCookingGifs');
        const s3Bucket = config.get('s3Bucket', 'let-them-cook-now');
        const s3Region = config.get('s3Region', 'us-east-1');
        const s3Prefix = config.get('s3Prefix', 'gifs/');
        const displayDuration = config.get('displayDuration', 90);
        const autoPlay = config.get('autoPlay', true);

        try {
            await this.loadGifList({ bucket: s3Bucket, region: s3Region, prefix: s3Prefix });
            const gifKey = this.getNextGifKey();
            const gifData = gifKey ? this.fetchGifFromS3(s3Bucket, s3Region, gifKey) : null;

            if (gifData) {
                // Send message to update GIF instead of replacing HTML
                this._view.webview.postMessage({
                    command: 'updateGif',
                    gifUrl: gifData.images.original.url,
                    gifId: gifData.id,
                    title: gifData.title || 'Cooking GIF',
                    displayDuration: displayDuration,
                    autoPlay: autoPlay,
                    isLiked: this.isLiked(gifData.id)
                });
            } else {
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
        } finally {
            this._isFetchingGif = false;
        }
    }

    getGifConfig() {
        const config = vscode.workspace.getConfiguration('funnyCookingGifs');
        return {
            bucket: config.get('s3Bucket', 'let-them-cook-now'),
            region: config.get('s3Region', 'us-east-1'),
            prefix: config.get('s3Prefix', 'gifs/')
        };
    }

    getMusicConfig() {
        const config = vscode.workspace.getConfiguration('funnyCookingGifs');
        return {
            bucket: config.get('s3Bucket', 'let-them-cook-now'),
            region: config.get('s3Region', 'us-east-1'),
            prefix: config.get('s3MusicPrefix', 'songs/')
        };
    }

    async loadGifList({ bucket, region, prefix, force = false } = {}) {
        if (!bucket || !region || !prefix) {
            const defaults = this.getGifConfig();
            bucket = bucket || defaults.bucket;
            region = region || defaults.region;
            prefix = prefix || defaults.prefix;
        }

        const signature = `${bucket}|${region}|${prefix}`;

        if (signature !== this._gifCacheConfig) {
            this._gifCache = [];
            this._shuffledGifList = [];
            this._gifIndex = 0;
        }

        if (this._gifListLoadPromise && this._gifListLoadSignature !== signature) {
            this._gifListLoadPromise = null;
            this._gifListLoadSignature = null;
        }

        if (!force && this._gifCache.length > 0) {
            return this._gifCache;
        }

        if (!force && this._gifListLoadPromise) {
            return this._gifListLoadPromise;
        }

        const loader = (async () => {
            const gifKeys = await this.collectS3Keys(bucket, region, prefix, ['.gif']);
            this._gifCache = gifKeys;
            this._gifCacheConfig = signature;
            this._shuffledGifList = this.shuffleArray(gifKeys);
            this._gifIndex = 0;
            console.log(`gif list loaded: ${gifKeys.length}`);
            return gifKeys;
        })();

        if (force) {
            return loader;
        }

        this._gifListLoadSignature = signature;
        this._gifListLoadPromise = loader;
        try {
            return await loader;
        } finally {
            if (this._gifListLoadPromise === loader) {
                this._gifListLoadPromise = null;
                this._gifListLoadSignature = null;
            }
        }
    }

    async refreshGifList() {
        const { bucket, region, prefix } = this.getGifConfig();
        await this.loadGifList({ bucket, region, prefix, force: true });
        if (this._view) {
            await this.updateGif();
        }
    }

    async loadMusicList({ bucket, region, prefix, force = false } = {}) {
        if (!bucket || !region || !prefix) {
            const defaults = this.getMusicConfig();
            bucket = bucket || defaults.bucket;
            region = region || defaults.region;
            prefix = prefix || defaults.prefix;
        }

        const signature = `${bucket}|${region}|${prefix}`;

        if (signature !== this._musicCacheConfig) {
            this._musicCache = [];
        }

        if (this._musicListLoadPromise && this._musicListLoadSignature !== signature) {
            this._musicListLoadPromise = null;
            this._musicListLoadSignature = null;
        }

        if (!force && this._musicCache.length > 0) {
            return this._musicCache;
        }

        if (!force && this._musicListLoadPromise) {
            return this._musicListLoadPromise;
        }

        const loader = (async () => {
            const musicKeys = await this.collectS3Keys(bucket, region, prefix, ['.mp3']);
            this._musicCache = musicKeys;
            this._musicCacheConfig = signature;
            console.log(`music list loaded: ${musicKeys.length}`);
            return musicKeys;
        })();

        if (force) {
            return loader;
        }

        this._musicListLoadSignature = signature;
        this._musicListLoadPromise = loader;
        try {
            return await loader;
        } finally {
            if (this._musicListLoadPromise === loader) {
                this._musicListLoadPromise = null;
                this._musicListLoadSignature = null;
            }
        }
    }

    getNextGifKey() {
        if (!this._shuffledGifList || this._shuffledGifList.length === 0) {
            return null;
        }

        const gifKey = this._shuffledGifList[this._gifIndex];
        this._gifIndex++;

        if (this._gifIndex >= this._shuffledGifList.length) {
            this._shuffledGifList = this.shuffleArray(this._gifCache);
            this._gifIndex = 0;
        }

        return gifKey;
    }

    fetchGifFromS3(bucket, region, gifKey) {
        const fileUrl = `https://${bucket}.s3.${region}.amazonaws.com/${encodeURIComponent(gifKey).replace(/%2F/g, '/')}`;

        return {
            id: gifKey,
            title: gifKey.split('/').pop().replace('.gif', ''),
            images: {
                original: {
                    url: fileUrl
                }
            }
        };
    }

    async fetchRandomMusicFromS3(bucket, region, prefix) {
        const musicKeys = await this.loadMusicList({ bucket, region, prefix });
        if (!musicKeys || musicKeys.length === 0) {
            return null;
        }
        const randomKey = musicKeys[Math.floor(Math.random() * musicKeys.length)];
        const fileUrl = `https://${bucket}.s3.${region}.amazonaws.com/${encodeURIComponent(randomKey).replace(/%2F/g, '/')}`;
        return {
            url: fileUrl,
            title: randomKey.split('/').pop().replace('.mp3', '')
        };
    }

    async collectS3Keys(bucket, region, prefix, fileExtensions) {
        const collectedKeys = [];
        let continuationToken = null;

        do {
            const { keys, isTruncated, nextContinuationToken } = await this.listS3Page(bucket, region, prefix, continuationToken);

            const filteredKeys = keys.filter(key => {
                const lowerKey = key.toLowerCase();
                return fileExtensions.some(ext => lowerKey.endsWith(ext.toLowerCase())) && key !== prefix;
            });

            collectedKeys.push(...filteredKeys);

            if (!isTruncated || !nextContinuationToken) {
                break;
            }

            continuationToken = nextContinuationToken;
        } while (continuationToken);

        return collectedKeys;
    }

    listS3Page(bucket, region, prefix, continuationToken = null) {
        return new Promise((resolve, reject) => {
            const queryParts = [
                'list-type=2',
                `prefix=${encodeURIComponent(prefix)}`
            ];

            if (continuationToken) {
                queryParts.push(`continuation-token=${encodeURIComponent(continuationToken)}`);
            }

            const url = `https://${bucket}.s3.${region}.amazonaws.com/?${queryParts.join('&')}`;

            https.get(url, (res) => {
                const chunks = [];

                res.on('data', (chunk) => {
                    chunks.push(chunk);
                });

                res.on('end', () => {
                    const data = Buffer.concat(chunks).toString('utf8');
                    if (res.statusCode !== 200) {
                        const snippet = data ? ` Response: ${data.substring(0, 200)}...` : '';
                        reject(new Error(`S3 request failed with status ${res.statusCode}.${snippet}`));
                        return;
                    }

                    try {
                        const keyMatches = data.match(/<Key>([^<]+)<\/Key>/g) || [];
                        const keys = keyMatches.map(match => match.replace(/<\/?Key>/g, ''));
                        const isTruncated = /<IsTruncated>true<\/IsTruncated>/.test(data);
                        const nextTokenMatch = data.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);

                        resolve({
                            keys,
                            isTruncated,
                            nextContinuationToken: nextTokenMatch ? nextTokenMatch[1] : null
                        });
                    } catch (err) {
                        reject(err);
                    }
                });
            }).on('error', (err) => {
                reject(err);
            });
        });
    }

    setupAutoRefresh(forceStart = false) {
        this.clearAutoRefresh();

        const config = vscode.workspace.getConfiguration('funnyCookingGifs');
        const displayDuration = config.get('displayDuration', 90);
        const autoPlay = config.get('autoPlay', true);

        if (autoPlay && this._view && (forceStart || this._view.visible)) {
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
        // Read the HTML template file
        const htmlPath = path.join(__dirname, 'webview.html');
        let html = fs.readFileSync(htmlPath, 'utf8');

        // Replace template placeholders
        html = html.replace(/\{\{panelTitle\}\}/g, panelTitle);
        html = html.replace(/\{\{displayDuration\}\}/g, displayDuration.toString());
        html = html.replace(/\{\{countdownBar\}\}/g,
            autoPlay ? `<div class="countdown-bar" id="countdownBar"></div>` : ''
        );

        return html;
    }

    postMessage(message) {
        if (this._view) {
            this._view.webview.postMessage(message);
            return true;
        }
        return false;
    }

    hasActiveView() {
        return !!this._view;
    }
}

function deactivate() {
    if (gifViewProvider) {
        gifViewProvider.clearAutoRefresh();
        gifViewProvider.flushLikes().catch(error => {
            console.error('Failed to flush likes during deactivate:', error);
        });
    }
}

module.exports = {
    activate,
    deactivate
}
