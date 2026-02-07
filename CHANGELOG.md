# Changelog

All notable changes to the "Let Him Cook Now" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.6.12]

### Added

- **GIF likes/favorites** — Heart button appears on hover over the GIF; click to like. Likes are persisted per machine across sessions.
- **Optimized GIF playback** — GIF list is pre-loaded and shuffled using Fisher-Yates, then played sequentially. No more immediate repeats; the list reshuffles automatically when exhausted.

### Changed

- **UI polish** — Hover effects on the like button, improved GIF container sizing (`max-height: 100vh`), and new `.gif-wrapper` for better layout control.
- **Packaging cleanup** — Added `.vscodeignore` to exclude dev files from the published extension.
