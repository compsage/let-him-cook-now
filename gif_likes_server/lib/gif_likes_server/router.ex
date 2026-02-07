defmodule GifLikesServer.Router do
  @moduledoc """
  HTTP Router - handles incoming HTTP requests.

  ## What is Plug?

  Plug is Elixir's HTTP middleware interface (like Express in Node.js).
  It defines a simple contract: every plug is a function that takes a
  "connection" (conn) and returns a modified connection.

  ```elixir
  def my_plug(conn, _opts) do
    conn
    |> put_resp_header("x-custom", "value")
    |> send_resp(200, "Hello!")
  end
  ```

  ## How This Router Works

  1. Request comes in: POST /user123/funny-cat.gif
  2. Plug.Router matches the path pattern: /:client_id/:gif_name
  3. Our handler extracts client_id="user123", gif_name="funny-cat.gif"
  4. We check: rate limit OK? GIF valid?
  5. If OK, toggle the like and return the result

  ## The Request Lifecycle

  ```
  Request → match → parse_body → dispatch → your_handler → Response
            ↓
          plug :match     (find matching route)
            ↓
          plug Plug.Parsers (parse JSON body if any)
            ↓
          plug :dispatch   (call the handler)
  ```

  ## Route Patterns

  ```elixir
  get "/items/:id"          # Matches GET /items/123, :id = "123"
  post "/:client/:gif"      # Matches POST /abc/xyz.gif
  match _ do ... end        # Catch-all for unmatched routes
  ```
  """

  use Plug.Router
  require Logger

  # =============================================================================
  # PLUG PIPELINE
  # =============================================================================
  # These plugs run in order for every request.
  # Think of them as middleware in Express.

  # Enable request logging
  plug Plug.Logger

  # Match the request to a route (but don't execute yet)
  plug :match

  # Parse JSON request bodies
  # This runs AFTER :match so we only parse for matched routes
  plug Plug.Parsers,
    parsers: [:json],
    pass: ["application/json"],
    json_decoder: Jason

  # Execute the matched route handler
  plug :dispatch

  # =============================================================================
  # ROUTES
  # =============================================================================

  @doc """
  Health check endpoint.
  Useful for load balancers and monitoring.

  GET /health
  Returns: {"status": "ok"}
  """
  get "/health" do
    json(conn, 200, %{status: "ok"})
  end

  @doc """
  Get all likes (for debugging).
  Shows all GIFs and their like counts.

  GET /
  Returns: [{"gif": "...", "count": N, "clients": [...]}]
  """
  get "/" do
    data =
      GifLikesServer.Store.all()
      |> Enum.map(fn {gif, likes} ->
        %{
          gif: gif,
          count: MapSet.size(likes),
          clients: MapSet.to_list(likes)
        }
      end)
      |> Enum.sort_by(& &1.gif)

    json(conn, 200, data)
  end

  @doc """
  Get server stats.

  GET /stats
  Returns store, rate limiter, and validator stats.
  """
  get "/stats" do
    stats = %{
      store: GifLikesServer.Store.stats(),
      rate_limiter: GifLikesServer.RateLimiter.stats(),
      gif_validator: GifLikesServer.GifValidator.stats()
    }
    json(conn, 200, stats)
  end

  @doc """
  Get info about a specific GIF.

  GET /gif/:gif_name
  Returns: {"gif": "...", "count": N, "clients": [...]}
  """
  get "/gif/:gif_name" do
    case GifLikesServer.Store.get(gif_name) do
      nil ->
        json(conn, 404, %{error: "GIF not found", gif: gif_name})

      likes ->
        json(conn, 200, %{
          gif: gif_name,
          count: MapSet.size(likes),
          clients: MapSet.to_list(likes)
        })
    end
  end

  @doc """
  Toggle a like for a GIF.

  POST /:client_id/:gif_name

  This is the main endpoint! It:
  1. Checks rate limit for client_id
  2. Validates gif_name exists in S3
  3. Toggles the like (add if not liked, remove if liked)
  4. Returns the result

  ## Example

  ```bash
  curl -X POST http://localhost:4000/user123/funny-cat.gif
  ```

  Returns:
  ```json
  {
    "gif": "funny-cat.gif",
    "client": "user123",
    "action": "added",
    "count": 42,
    "liked": true
  }
  ```

  ## Error Responses

  - 429 Too Many Requests - rate limited
  - 404 Not Found - GIF doesn't exist in S3
  """
  post "/:client_id/:gif_name" do
    # Step 1: Check rate limit
    # -------------------------
    # Each client can only make 20 requests per minute.
    # This prevents abuse (someone spamming likes).
    case GifLikesServer.RateLimiter.check_rate(client_id) do
      {:error, :rate_limited, retry_after} ->
        # Too many requests! Tell them to slow down.
        Logger.warning("Rate limited client: #{client_id}")

        conn
        |> put_resp_header("retry-after", to_string(div(retry_after, 1000)))
        |> json(429, %{
          error: "rate_limited",
          message: "Too many requests. Please wait.",
          retry_after_ms: retry_after
        })

      {:ok, remaining} ->
        # Rate limit OK, proceed to validate GIF
        handle_like_toggle(conn, client_id, gif_name, remaining)
    end
  end

  @doc """
  Check if a client has liked a GIF.

  GET /:client_id/:gif_name
  Returns: {"gif": "...", "client": "...", "liked": true/false}
  """
  get "/:client_id/:gif_name" do
    liked = GifLikesServer.Store.liked?(gif_name, client_id)

    case GifLikesServer.Store.get(gif_name) do
      nil ->
        json(conn, 200, %{gif: gif_name, client: client_id, liked: false, count: 0})

      likes ->
        json(conn, 200, %{
          gif: gif_name,
          client: client_id,
          liked: liked,
          count: MapSet.size(likes)
        })
    end
  end

  @doc """
  Catch-all for unmatched routes.
  Returns 404 Not Found.
  """
  match _ do
    json(conn, 404, %{error: "not_found", message: "Route not found"})
  end

  # =============================================================================
  # PRIVATE HELPERS
  # =============================================================================

  @doc false
  defp handle_like_toggle(conn, client_id, gif_name, remaining_requests) do
    # Step 2: Validate GIF name
    # --------------------------
    # Check if this GIF exists in our S3 bucket.
    # This prevents likes on non-existent GIFs.
    if GifLikesServer.GifValidator.valid?(gif_name) do
      # Step 3: Toggle the like
      # ------------------------
      # This adds the like if not present, removes it if present.
      action = GifLikesServer.Store.toggle_like(gif_name, client_id)
      likes = GifLikesServer.Store.get(gif_name)

      Logger.info("#{client_id} #{action} like on #{gif_name}")

      # Return the result with rate limit info
      conn
      |> put_resp_header("x-ratelimit-remaining", to_string(remaining_requests))
      |> json(200, %{
        gif: gif_name,
        client: client_id,
        action: action,
        count: MapSet.size(likes),
        liked: action == :added
      })
    else
      # GIF not found in S3
      Logger.warning("Invalid GIF requested: #{gif_name}")
      json(conn, 404, %{
        error: "gif_not_found",
        message: "This GIF does not exist",
        gif: gif_name
      })
    end
  end

  @doc """
  Helper to send JSON responses.

  ## How It Works

  ```elixir
  conn
  |> put_resp_content_type("application/json")  # Set header
  |> send_resp(200, Jason.encode!(data))        # Send response
  ```

  The `send_resp/3` function:
  - Sets the HTTP status code
  - Sets the response body
  - Sends the response to the client
  - Returns the conn (for Plug compatibility)
  """
  defp json(conn, status, data) do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(status, Jason.encode!(data))
  end
end
