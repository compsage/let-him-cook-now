defmodule GifLikesServer do
  @moduledoc """
  GIF Likes Server - A simple RESTful API for toggling likes on GIFs.

  ## Architecture Overview

  This server is organized into several modules, each with a single responsibility:

  ```
  GifLikesServer (this module)
       │
       ├── Application     - Starts and supervises all components
       │
       ├── Router          - HTTP endpoints (the "controller" layer)
       │
       ├── Store           - Likes data storage (ETS for speed, DETS for persistence)
       │
       ├── RateLimiter     - Prevents abuse (20 requests/minute per client)
       │
       └── GifValidator    - Ensures GIF names are valid (checks against S3)
  ```

  ## API Endpoint

  ```
  POST /:client_id/:gif_name  - Toggle a like for this client on this GIF

  Response:
  {
    "gif": "funny-cat.gif",
    "client": "user123",
    "action": "added" | "removed",
    "count": 42,
    "liked": true | false
  }
  ```

  ## Quick Start

  ```bash
  # Install dependencies
  mix deps.get

  # Run the server
  iex -S mix

  # Test it
  curl -X POST http://localhost:4000/user123/funny-cat.gif
  ```
  """

  @doc """
  Convenience function to check if a client has liked a GIF.
  Delegates to the Store module.
  """
  def liked?(gif_name, client_id) do
    GifLikesServer.Store.liked?(gif_name, client_id)
  end

  @doc """
  Get the current like count for a GIF.
  """
  def like_count(gif_name) do
    case GifLikesServer.Store.get(gif_name) do
      nil -> 0
      likes -> MapSet.size(likes)
    end
  end

  @doc """
  Get all likes data (for debugging).
  """
  def all_likes do
    GifLikesServer.Store.all()
  end
end
